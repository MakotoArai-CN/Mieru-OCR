/**
 * Diagnostics module — opt-in log buffer + sanitized report builder.
 *
 * Goals:
 *   1. When debug/diagnostic mode is on, capture the last N Logger entries
 *      across all extension contexts (SW, content, popup, options, offscreen,
 *      userscript) so a user can attach them to a bug report.
 *   2. Stay 100% local: nothing is uploaded automatically. The user clicks
 *      "导出诊断报告" in Options and gets a JSON file they can review.
 *   3. Sanitize obvious PII: URLs, custom CSS selectors, subscription sources,
 *      site stats keyed by hostname — replace with length+hash so we can spot
 *      "the user has 3 entries" without learning what they are.
 *
 * Storage layout:
 *   chrome.storage.local["ddddocr_diag_log_<ctx>"] = LogEntry[]
 *   per-context bucket avoids read-modify-write races. buildReport() merges.
 *
 * NOT for: telemetry, crash reporting, automatic upload — none of that.
 */

const MAX_ENTRIES = 200;
const MAX_MSG_LEN = 300;
const FLUSH_DEBOUNCE_MS = 1000;
const BUFFER_KEY_PREFIX = 'ddddocr_diag_log_';
const KNOWN_CONTEXTS = ['sw', 'content', 'subframe', 'options', 'popup', 'offscreen', 'userscript'] as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DiagContext = (typeof KNOWN_CONTEXTS)[number] | 'unknown';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  ctx: DiagContext;
  msg: string;
}

let buffer: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let cachedCtx: DiagContext | null = null;
let enabled = false;

// ---------------- context detection ----------------

function detectContext(): DiagContext {
  if (cachedCtx) return cachedCtx;
  try {
    // ServiceWorkerGlobalScope check — only true in MV3 service worker
    if (typeof self !== 'undefined' && (self as any).ServiceWorkerGlobalScope
      && self instanceof (self as any).ServiceWorkerGlobalScope) {
      return cachedCtx = 'sw';
    }
  } catch { /* fall through */ }
  if (typeof window !== 'undefined') {
    const href = (typeof location !== 'undefined' && location.href) || '';
    if (href.includes('options')) return cachedCtx = 'options';
    if (href.includes('popup')) return cachedCtx = 'popup';
    if (href.includes('offscreen')) return cachedCtx = 'offscreen';
    if (typeof (globalThis as any).GM_getValue === 'function') return cachedCtx = 'userscript';
    // content script：区分顶层 vs 子框架，独立 200 条 buffer 防止互相覆盖
    try {
      if (window.top !== window) return cachedCtx = 'subframe';
    } catch { return cachedCtx = 'subframe'; }
    return cachedCtx = 'content';
  }
  return cachedCtx = 'unknown';
}

// ---------------- storage adapter ----------------

interface AsyncKV {
  get: (k: string) => Promise<any>;
  set: (k: string, v: any) => Promise<void>;
}

let cachedStorage: AsyncKV | null | undefined;
function getStorage(): AsyncKV | null {
  if (cachedStorage !== undefined) return cachedStorage;
  try {
    const c = (globalThis as any).browser;
    if (c?.storage?.local) {
      cachedStorage = {
        get: (k) => c.storage.local.get(k).then((r: any) => r[k]),
        set: (k, v) => c.storage.local.set({ [k]: v }),
      };
      return cachedStorage;
    }
  } catch { /* fall through */ }
  try {
    const b = (globalThis as any).chrome;
    if (b?.storage?.local) {
      cachedStorage = {
        get: (k) => b.storage.local.get(k).then((r: any) => r[k]),
        set: (k, v) => b.storage.local.set({ [k]: v }),
      };
      return cachedStorage;
    }
  } catch { /* fall through */ }
  const gmGet = (globalThis as any).GM_getValue;
  const gmSet = (globalThis as any).GM_setValue;
  if (typeof gmGet === 'function' && typeof gmSet === 'function') {
    cachedStorage = {
      get: async (k) => gmGet(k),
      set: async (k, v) => gmSet(k, v),
    };
    return cachedStorage;
  }
  cachedStorage = null;
  return null;
}

// ---------------- helpers ----------------

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function safeStringify(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`;
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
      return val;
    });
  } catch {
    return '[unserializable]';
  }
}

// ---------------- public API ----------------

export function setDiagnosticsEnabled(v: boolean): void {
  enabled = v;
}

export function isDiagnosticsEnabled(): boolean {
  return enabled;
}

/** Append one log entry. Wrapped in try/catch so a bad arg never crashes the caller. */
export function pushEntry(level: LogLevel, args: unknown[]): void {
  if (!enabled) return;
  try {
    const msg = truncate(args.map(safeStringify).join(' '), MAX_MSG_LEN);
    buffer.push({ ts: Date.now(), level, ctx: detectContext(), msg });
    while (buffer.length > MAX_ENTRIES) buffer.shift();
    scheduleFlush();
  } catch { /* never let logging itself crash */ }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  const storage = getStorage();
  if (!storage) return;
  try {
    await storage.set(BUFFER_KEY_PREFIX + detectContext(), buffer.slice());
  } catch { /* silent — diagnostics must never throw to its caller */ }
}

/** Read all per-context buckets, dedupe, sort. Includes current in-memory buffer. */
export async function readAllLogs(): Promise<LogEntry[]> {
  const storage = getStorage();
  const collected: LogEntry[] = [];
  if (storage) {
    for (const ctx of KNOWN_CONTEXTS) {
      try {
        const arr = await storage.get(BUFFER_KEY_PREFIX + ctx);
        if (Array.isArray(arr)) collected.push(...arr);
      } catch { /* skip */ }
    }
  }
  collected.push(...buffer);
  const seen = new Set<string>();
  const unique = collected.filter((e) => {
    const k = `${e.ts}|${e.ctx}|${e.level}|${e.msg}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => a.ts - b.ts);
  return unique;
}

export async function clearLogs(): Promise<void> {
  buffer = [];
  const storage = getStorage();
  if (!storage) return;
  for (const ctx of KNOWN_CONTEXTS) {
    try { await storage.set(BUFFER_KEY_PREFIX + ctx, []); } catch { /* skip */ }
  }
}

// ---------------- sanitization ----------------

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Replace any PII-bearing field with a length+hash placeholder so we can still
 *  compare "is it present? does it match?" without learning the value. */
function redactString(s: string): string {
  return `[${s.length} chars · ${hashString(s)}]`;
}

function sanitizeSettings(s: any): any {
  if (!s || typeof s !== 'object') return s;
  const clone: any = { ...s };
  for (const arrKey of ['whitelist', 'siteBlacklist', 'agreementSelectors',
    'customIncludeKeywords', 'customExcludePatterns', 'customAgreementKeywords',
    'customInputExcludeKeywords', 'disabledCaptchaKeywords', 'disabledExcludePatterns',
    'disabledAgreementKeywords', 'disabledInputExcludeKeywords']) {
    if (Array.isArray(clone[arrKey])) {
      clone[arrKey] = clone[arrKey].map((v: string) => redactString(String(v)));
    }
  }
  for (const strKey of ['captchaSelector', 'inputSelector', 'submitSelector', 'agreementSelector', 'localModelPath', 'localCharsetsPath']) {
    if (typeof clone[strKey] === 'string' && clone[strKey]) {
      clone[strKey] = redactString(clone[strKey]);
    }
  }
  if (Array.isArray(clone.calculateRules)) {
    clone.calculateRules = clone.calculateRules.map(() => '[redacted-rule]');
  }
  return clone;
}

function sanitizeStats(stats: any): { total: number; sites: number; recent: unknown[] } {
  if (!stats || typeof stats !== 'object') return { total: 0, sites: 0, recent: [] };
  const sites = (stats.sites && typeof stats.sites === 'object') ? stats.sites : {};
  const recent = Object.entries(sites)
    .map(([host, v]: [string, any]) => ({
      host: hashString(host),
      count: v?.count || 0,
      avgMs: v?.count ? Math.round((v.totalTime || 0) / v.count) : 0,
      lastTime: v?.lastTime || 0,
    }))
    .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
    .slice(0, 20);
  return { total: stats.total || 0, sites: Object.keys(sites).length, recent };
}

// ---------------- report builder ----------------

export type ReportTarget = 'chrome-extension' | 'firefox-extension' | 'userscript' | 'unknown';

export interface ReportOptions {
  includeLogs: boolean;
  includeEnv: boolean;
  includeSettings: boolean;
  includeStats: boolean;
}

export interface DiagnosticReport {
  schema: 'Mieru-diag-v1';
  generatedAt: string;
  app: { name: string; version: string; target: ReportTarget };
  env?: {
    userAgent: string;
    platform: string;
    language: string;
    screen: { width: number; height: number };
    online: boolean;
  };
  settings?: unknown;
  activeModel?: { id: string; size?: number; charsetsLength?: number; source?: string };
  stats?: unknown;
  logs?: LogEntry[];
  counts: {
    logs: number;
    truncatedLogs: boolean;
  };
}

export interface ReportContributors {
  appName: string;
  appVersion: string;
  target: ReportTarget;
  getSettings?: () => Promise<any>;
  getActiveModel?: () => Promise<{ id: string; size?: number; charsetsLength?: number; source?: string } | null>;
  getStats?: () => Promise<any>;
}

export async function buildReport(opts: ReportOptions, c: ReportContributors): Promise<DiagnosticReport> {
  const report: DiagnosticReport = {
    schema: 'Mieru-diag-v1',
    generatedAt: new Date().toISOString(),
    app: { name: c.appName, version: c.appVersion, target: c.target },
    counts: { logs: 0, truncatedLogs: false },
  };

  if (opts.includeEnv) {
    const nav: any = (typeof navigator !== 'undefined') ? navigator : {};
    const scr: any = (typeof screen !== 'undefined') ? screen : { width: 0, height: 0 };
    report.env = {
      userAgent: nav.userAgent || '',
      platform: nav.platform || nav.userAgentData?.platform || '',
      language: nav.language || '',
      screen: { width: scr.width || 0, height: scr.height || 0 },
      online: !!nav.onLine,
    };
  }

  if (opts.includeSettings && c.getSettings) {
    try { report.settings = sanitizeSettings(await c.getSettings()); }
    catch (e) { report.settings = { _error: String(e) }; }
  }

  if (opts.includeSettings && c.getActiveModel) {
    try {
      const m = await c.getActiveModel();
      if (m) report.activeModel = m;
    } catch (e) {
      report.activeModel = { id: '_error: ' + String(e) };
    }
  }

  if (opts.includeStats && c.getStats) {
    try { report.stats = sanitizeStats(await c.getStats()); }
    catch (e) { report.stats = { _error: String(e) }; }
  }

  if (opts.includeLogs) {
    const logs = await readAllLogs();
    report.counts.logs = logs.length;
    report.counts.truncatedLogs = logs.length >= MAX_ENTRIES * KNOWN_CONTEXTS.length;
    report.logs = logs;
  }

  return report;
}

// ---------------- file download (window-only) ----------------

export function downloadReport(report: DiagnosticReport, filename?: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('downloadReport requires a window context with Blob URL support');
  }
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `Mieru-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { document.body.removeChild(a); } catch { /* removed already */ }
    URL.revokeObjectURL(url);
  }, 200);
}
