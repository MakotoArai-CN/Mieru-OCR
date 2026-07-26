/**
 * Mieru-OCR 诊断报告独立分析工具（离线）。
 *
 * 拖入 / 选择一个 Mieru-diag JSON 报告 → 本地启发式分析 → 可选 AI 深度分析。
 * 用相对路径 import 核心模块，便于 `bun build` 独立打包（对齐 test/playground 约定）。
 * AI 配置存 localStorage；apiKey 可空（本地 OpenAI 兼容端点）。
 */

import { analyzeReport, type AnalysisResult, type Finding } from '../../src/core/diag-analyzer';
import { analyzeWithAI, normalizeAiConfig, AI_DEFAULTS, type AiConfig, type AiProvider } from '../../src/core/diag-ai';
import type { DiagnosticReport } from '../../src/core/diagnostics';

const $ = (id: string) => document.getElementById(id);
const AI_KEY = 'mieru_diag_ai_config';

let lastReport: DiagnosticReport | null = null;
let lastAnalysis: AnalysisResult | null = null;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

const SEV_COLOR: Record<Finding['severity'], string> = { critical: '#ef4444', warning: '#f59e0b', info: '#71717a' };
const SEV_LABEL: Record<Finding['severity'], string> = { critical: '严重', warning: '警告', info: '提示' };

function renderAnalysis(result: AnalysisResult): string {
  const s = result.summary;
  const kindRows = result.charts.kindSuccess.map((k) =>
    `<div class="metric"><div class="v">${k.rate}%</div><div class="k">${esc(k.kind)}（${k.ok}/${k.ok + k.fail}）</div></div>`
  ).join('');
  const reasons = result.charts.failReasons.slice(0, 10).map((r) =>
    `<span class="chip">${esc(r.label)} ×${r.value}</span>`
  ).join('');
  const findings = result.findings.length
    ? result.findings.map((f) => `
        <div class="finding" style="border-left-color:${SEV_COLOR[f.severity]}">
          <div class="ftitle"><span style="color:${SEV_COLOR[f.severity]};font-size:12px">[${SEV_LABEL[f.severity]}]</span> ${esc(f.title)}</div>
          <div class="fdetail">${esc(f.detail)}</div>
          ${f.evidence ? `<div class="fev">${esc(f.evidence)}</div>` : ''}
          <div class="frec">💡 ${esc(f.recommendation)}</div>
        </div>`).join('')
    : '<div class="hint">未发现已知失败模式。若确有问题，请在扩展里开启调试模式复现后再导出报告。</div>';
  return `
    <div class="metrics">
      <div class="metric"><div class="v">${s.totalEvents}</div><div class="k">结构化事件</div></div>
      <div class="metric"><div class="v">${s.totalLogs}</div><div class="k">日志条数</div></div>
      ${kindRows}
    </div>
    ${reasons ? `<div class="reasons">失败原因：${reasons}</div>` : ''}
    ${findings}
    <div class="hint" style="margin-top:8px">报告 schema：${esc(result.schema)}${result.meta.hasEvents ? '' : '（无结构化事件，信息有限）'}
      ${result.meta.app ? ` · ${esc((result.meta.app as any).name)} ${esc((result.meta.app as any).version)}` : ''}</div>
  `;
}

function analyze(report: DiagnosticReport): void {
  const box = $('result');
  if (!box) return;
  try {
    lastReport = report;
    lastAnalysis = analyzeReport(report);
    box.innerHTML = renderAnalysis(lastAnalysis);
    $('ai-section')!.style.display = 'block';
  } catch (e) {
    box.innerHTML = `<div class="hint err">分析失败：${esc((e as Error).message)}</div>`;
  }
}

function loadFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      analyze(JSON.parse(String(reader.result)) as DiagnosticReport);
    } catch {
      $('result')!.innerHTML = '<div class="hint err">不是有效的报告 JSON。</div>';
    }
  };
  reader.readAsText(file);
}

// ---- AI 配置持久化 ----
function getStoredAi(): Partial<AiConfig> | null {
  try { return JSON.parse(localStorage.getItem(AI_KEY) || 'null'); } catch { return null; }
}
function readAiForm(): AiConfig {
  return normalizeAiConfig({
    provider: (($('ai-provider') as HTMLSelectElement).value === 'openai' ? 'openai' : 'anthropic') as AiProvider,
    baseUrl: ($('ai-baseurl') as HTMLInputElement).value,
    apiKey: ($('ai-apikey') as HTMLInputElement).value,
    model: ($('ai-model') as HTMLInputElement).value,
  });
}
function applyPlaceholders(p: AiProvider): void {
  ($('ai-baseurl') as HTMLInputElement).placeholder = AI_DEFAULTS[p].baseUrl;
  ($('ai-model') as HTMLInputElement).placeholder = AI_DEFAULTS[p].model;
}

function initUI(): void {
  const drop = $('drop')!;
  const fileInput = $('file') as HTMLInputElement;
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) loadFile(f); });

  // AI 表单初始化
  const stored = getStoredAi();
  const cfg = normalizeAiConfig(stored);
  ($('ai-provider') as HTMLSelectElement).value = cfg.provider;
  applyPlaceholders(cfg.provider);
  if (stored) {
    if (stored.baseUrl) ($('ai-baseurl') as HTMLInputElement).value = stored.baseUrl;
    if (stored.apiKey) ($('ai-apikey') as HTMLInputElement).value = stored.apiKey;
    if (stored.model) ($('ai-model') as HTMLInputElement).value = stored.model;
  }
  $('ai-provider')!.addEventListener('change', (e) => applyPlaceholders(((e.target as HTMLSelectElement).value === 'openai' ? 'openai' : 'anthropic') as AiProvider));

  $('btn-ai')!.addEventListener('click', () => { void runAi(); });
}

async function runAi(): Promise<void> {
  const box = $('ai-result')!;
  if (!lastReport || !lastAnalysis) { box.innerHTML = '<div class="hint err">请先加载并分析一个报告。</div>'; return; }
  const cfg = readAiForm();
  localStorage.setItem(AI_KEY, JSON.stringify(cfg));
  if (!confirm(`将把已脱敏的诊断报告发送到：\n${cfg.baseUrl}\n（协议：${cfg.provider}，模型：${cfg.model}）\n确定继续？`)) return;
  box.innerHTML = '<div class="hint">AI 分析中，请稍候…</div>';
  try {
    const text = await analyzeWithAI(lastReport, lastAnalysis, cfg);
    box.innerHTML = `<pre class="ai-out">${esc(text)}</pre>`;
  } catch (e) {
    box.innerHTML = `<div class="hint err">AI 分析失败：${esc((e as Error).message)}</div>`;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();
