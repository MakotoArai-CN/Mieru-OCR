/**
 * 扩展 options 的「诊断分析」UI 逻辑（Chrome 与 Firefox 共用）。
 *
 * 通过依赖注入解耦存储/确认框差异：调用方传入 buildCurrentReport / getAiConfig /
 * setAiConfig / confirm。UI 元素 id 在两份 options.html 中一致，故按 id 绑定。
 */

import { analyzeReport, type AnalysisResult, type Finding } from '@core/diag-analyzer';
import { analyzeWithAI, normalizeAiConfig, AI_DEFAULTS, type AiConfig, type AiProvider } from '@core/diag-ai';
import type { DiagnosticReport } from '@core/diagnostics';

export interface DiagAnalysisDeps {
  /** 用当前采集数据构造报告（复用 options 的 buildReport contributors）。 */
  buildCurrentReport: () => Promise<DiagnosticReport>;
  getAiConfig: () => Promise<Partial<AiConfig> | null>;
  setAiConfig: (c: AiConfig) => Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
  toast: (msg: string, type: 'success' | 'error') => void;
}

let lastReport: DiagnosticReport | null = null;
let lastAnalysis: AnalysisResult | null = null;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

const SEV_COLOR: Record<Finding['severity'], string> = {
  critical: '#ef4444', warning: '#f59e0b', info: '#71717a',
};
const SEV_LABEL: Record<Finding['severity'], string> = {
  critical: '严重', warning: '警告', info: '提示',
};

function renderAnalysis(result: AnalysisResult): string {
  const s = result.summary;
  const kindRows = result.charts.kindSuccess.map((k) =>
    `<div class="metric"><div class="v">${k.rate}%</div><div class="k">${esc(k.kind)}（${k.ok}/${k.ok + k.fail}）</div></div>`
  ).join('');
  const reasons = result.charts.failReasons.slice(0, 8).map((r) =>
    `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:999px;background:var(--bg-tertiary,#eef);font-size:12px;">${esc(r.label)} ×${r.value}</span>`
  ).join('');

  const findings = result.findings.length
    ? result.findings.map((f) => `
        <div style="border-left:3px solid ${SEV_COLOR[f.severity]};padding:8px 12px;margin:8px 0;background:var(--bg-secondary,#f8fbff);border-radius:0 8px 8px 0;">
          <div style="font-weight:600;">
            <span style="color:${SEV_COLOR[f.severity]};font-size:12px;">[${SEV_LABEL[f.severity]}]</span>
            ${esc(f.title)}
          </div>
          <div style="font-size:13px;color:var(--text-secondary,#52525b);margin:4px 0;">${esc(f.detail)}</div>
          ${f.evidence ? `<div style="font-size:12px;color:var(--text-muted,#a1a1aa);font-family:ui-monospace,monospace;">${esc(f.evidence)}</div>` : ''}
          <div style="font-size:13px;margin-top:4px;">💡 ${esc(f.recommendation)}</div>
        </div>`).join('')
    : '<div class="hint">未发现已知失败模式。若确有问题，请开启调试模式复现后再分析。</div>';

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:10px;">
      <div class="metric"><div class="v">${s.totalEvents}</div><div class="k">结构化事件</div></div>
      <div class="metric"><div class="v">${s.totalLogs}</div><div class="k">日志条数</div></div>
      ${kindRows}
    </div>
    ${reasons ? `<div style="margin-bottom:10px;">失败原因：${reasons}</div>` : ''}
    <div>${findings}</div>
    <div class="hint" style="margin-top:8px;">报告 schema：${esc(result.schema)}${result.meta.hasEvents ? '' : '（无结构化事件，信息有限）'}</div>
  `;
}

async function doLocalAnalysis(report: DiagnosticReport, deps: DiagAnalysisDeps): Promise<void> {
  const box = document.getElementById('diag-analysis-result');
  if (!box) return;
  try {
    lastReport = report;
    lastAnalysis = analyzeReport(report);
    box.innerHTML = renderAnalysis(lastAnalysis);
  } catch (e) {
    box.innerHTML = `<div class="hint" style="color:var(--error,#ef4444);">分析失败：${esc((e as Error).message)}</div>`;
    deps.toast('分析失败：' + (e as Error).message, 'error');
  }
}

function readAiForm(): AiConfig {
  const provider = ((document.getElementById('diag-ai-provider') as HTMLSelectElement)?.value === 'openai' ? 'openai' : 'anthropic') as AiProvider;
  return normalizeAiConfig({
    provider,
    baseUrl: (document.getElementById('diag-ai-baseurl') as HTMLInputElement)?.value || '',
    apiKey: (document.getElementById('diag-ai-apikey') as HTMLInputElement)?.value || '',
    model: (document.getElementById('diag-ai-model') as HTMLInputElement)?.value || '',
  });
}

function applyProviderPlaceholders(provider: AiProvider): void {
  const d = AI_DEFAULTS[provider];
  const base = document.getElementById('diag-ai-baseurl') as HTMLInputElement | null;
  const model = document.getElementById('diag-ai-model') as HTMLInputElement | null;
  if (base) base.placeholder = d.baseUrl;
  if (model) model.placeholder = d.model;
}

export function initDiagAnalysisUI(deps: DiagAnalysisDeps): void {
  // 载入已存 AI 配置到表单
  void (async () => {
    const cfg = normalizeAiConfig(await deps.getAiConfig());
    const provSel = document.getElementById('diag-ai-provider') as HTMLSelectElement | null;
    if (provSel) provSel.value = cfg.provider;
    applyProviderPlaceholders(cfg.provider);
    // 只有用户存过才回填（避免把默认值写进输入框，让 placeholder 生效）
    const stored = await deps.getAiConfig();
    if (stored) {
      const base = document.getElementById('diag-ai-baseurl') as HTMLInputElement | null;
      const key = document.getElementById('diag-ai-apikey') as HTMLInputElement | null;
      const model = document.getElementById('diag-ai-model') as HTMLInputElement | null;
      if (base && stored.baseUrl) base.value = stored.baseUrl;
      if (key && stored.apiKey) key.value = stored.apiKey;
      if (model && stored.model) model.value = stored.model;
    }
  })();

  document.getElementById('diag-ai-provider')?.addEventListener('change', (e) => {
    applyProviderPlaceholders(((e.target as HTMLSelectElement).value === 'openai' ? 'openai' : 'anthropic') as AiProvider);
  });

  document.getElementById('btn-diag-analyze')?.addEventListener('click', () => {
    void (async () => {
      const box = document.getElementById('diag-analysis-result');
      if (box) box.innerHTML = '<div class="hint">分析中…</div>';
      const report = await deps.buildCurrentReport();
      await doLocalAnalysis(report, deps);
    })();
  });

  document.getElementById('diag-import-file')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        try {
          const report = JSON.parse(String(reader.result)) as DiagnosticReport;
          await doLocalAnalysis(report, deps);
        } catch (err) {
          deps.toast('导入失败：不是有效的报告 JSON', 'error');
        }
      })();
    };
    reader.readAsText(file);
    (e.target as HTMLInputElement).value = '';
  });

  document.getElementById('btn-diag-ai')?.addEventListener('click', () => {
    void (async () => {
      const box = document.getElementById('diag-ai-result');
      if (!box) return;
      const cfg = readAiForm();
      await deps.setAiConfig(cfg);
      // 没先做本地分析则先构造当前报告
      if (!lastReport || !lastAnalysis) {
        lastReport = await deps.buildCurrentReport();
        lastAnalysis = analyzeReport(lastReport);
        const lb = document.getElementById('diag-analysis-result');
        if (lb) lb.innerHTML = renderAnalysis(lastAnalysis);
      }
      const ok = await deps.confirm(`将把已脱敏的诊断报告发送到：\n${cfg.baseUrl}\n（协议：${cfg.provider}，模型：${cfg.model}）\n确定继续？`);
      if (!ok) return;
      box.innerHTML = '<div class="hint">AI 分析中，请稍候…</div>';
      try {
        const text = await analyzeWithAI(lastReport!, lastAnalysis!, cfg);
        box.innerHTML = `<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;line-height:1.6;background:var(--bg-secondary,#f8fbff);padding:12px;border-radius:8px;margin:0;">${esc(text)}</pre>`;
      } catch (e) {
        box.innerHTML = `<div class="hint" style="color:var(--error,#ef4444);">AI 分析失败：${esc((e as Error).message)}</div>`;
      }
    })();
  });
}
