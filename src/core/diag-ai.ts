/**
 * 诊断报告的可选「AI 深度分析」客户端（无框架依赖，浏览器 fetch）。
 *
 * 需求：用户可自定义 baseURL / apiKey / model；默认支持 OpenAI 与 Anthropic(Claude) 两种
 * 协议；apiKey 可为空（本地 OpenAI 兼容端点如 Ollama / LM Studio 不需要 key）。
 *
 * 只在用户显式配置并点击「AI 深度分析」时调用——这是整套诊断里唯一会外发数据的动作，
 * 发送的是已脱敏的报告。调用方须在 UI 明确告知。
 */

import type { DiagnosticReport } from './diagnostics';
import type { AnalysisResult } from './diag-analyzer';

export type AiProvider = 'openai' | 'anthropic';

export interface AiConfig {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const AI_DEFAULTS: Record<AiProvider, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
  openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini' },
};

/** 归一化配置：补默认值、去尾斜杠、trim。 */
export function normalizeAiConfig(partial?: Partial<AiConfig> | null): AiConfig {
  const provider: AiProvider = partial?.provider === 'openai' ? 'openai' : 'anthropic';
  const d = AI_DEFAULTS[provider];
  return {
    provider,
    baseUrl: ((partial?.baseUrl || '').trim() || d.baseUrl).replace(/\/+$/, ''),
    apiKey: (partial?.apiKey || '').trim(),
    model: (partial?.model || '').trim() || d.model,
  };
}

const SYSTEM_PROMPT = `你是 Mieru-OCR 浏览器验证码识别扩展的诊断专家。

背景（1.2.3 架构）：
- OCR/图片/计算类验证码自动识别；滑块拖拽与文字点选改为「订阅/站点规则驱动」（不再盲扫），命中带 subType 的规则+autoSolveOnRule 才求解。
- 滑块求解：多算法缺口检测融合（模板匹配NCC/列边缘/亮度），常见失败原因 reason：tainted-canvas(跨域canvas不可读)、no-background/no-handle(selector选到内部canvas而非容器)、low-confidence/distance-too-small。
- 文字点选需要 YOLOX 检测模型(common_det.onnx)，1.2.3 起不内置：优先级=本地上传 > 订阅detModel(url+sha256下载) > 仓库镜像下载。未就绪会报 DET_NOT_PROVISIONED。
- 订阅规则：URL 默认按 origin+path 匹配(抗随机参数)，可选 matchQuery 白名单。

输入是一份「已脱敏」的诊断报告 JSON（含 summary 汇总、heuristicFindings 启发式发现、events 结构化事件、部分 warn/error 日志）。URL/选择器/规则键已被 hash，不含明文 PII。

请用简洁的中文 Markdown 输出：
1. **根因判断**：最可能的 1-3 个根本原因，按可能性排序，引用数据中的证据。
2. **修复步骤**：分「普通用户」与「订阅/规则作者」两类给可执行步骤。
3. **还需采集**：若信息不足，指出还应开启什么/复现什么再采集。

严禁臆造数据中不存在的信息；无法判断时明说。`;

interface AnalyzePayload {
  schema: string;
  app?: unknown;
  env?: unknown;
  summary?: unknown;
  heuristicFindings: unknown;
  events: unknown[];
  logs: unknown[];
}

function buildPayload(report: DiagnosticReport, analysis: AnalysisResult): AnalyzePayload {
  return {
    schema: report.schema,
    app: report.app,
    env: report.env,
    summary: analysis.summary,
    heuristicFindings: analysis.findings,
    events: (report.events || []).slice(-120),
    // 只带 warn/error 日志，控制体积
    logs: (report.logs || []).filter((l) => l.level === 'warn' || l.level === 'error').slice(-80),
  };
}

export interface AnalyzeAiOptions {
  maxTokens?: number;
  signal?: AbortSignal;
}

/** 用配置的 AI 端点分析报告，返回 Markdown 文本。失败抛错（含端点错误信息）。 */
export async function analyzeWithAI(
  report: DiagnosticReport,
  analysis: AnalysisResult,
  config: Partial<AiConfig>,
  opts: AnalyzeAiOptions = {},
): Promise<string> {
  const cfg = normalizeAiConfig(config);
  const user = '这是待分析的 Mieru-OCR 诊断报告（已脱敏）：\n```json\n'
    + JSON.stringify(buildPayload(report, analysis)) + '\n```';
  const maxTokens = opts.maxTokens ?? 1500;
  return cfg.provider === 'anthropic'
    ? callAnthropic(cfg, user, maxTokens, opts.signal)
    : callOpenAI(cfg, user, maxTokens, opts.signal);
}

function errMsg(name: string, status: number, data: any): string {
  const m = data?.error?.message || data?.message || (typeof data === 'string' ? data.slice(0, 200) : '');
  return `${name} 请求失败 (HTTP ${status})${m ? '：' + m : ''}`;
}

async function callAnthropic(cfg: AiConfig, user: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    // 浏览器直连 Anthropic API 需要显式放行 CORS
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
  const resp = await fetch(`${cfg.baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(errMsg('Anthropic', resp.status, data));
  const text = Array.isArray(data?.content)
    ? data.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
    : '';
  if (!text.trim()) throw new Error('Anthropic 返回空内容');
  return text;
}

async function callOpenAI(cfg: AiConfig, user: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;
  const resp = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(errMsg('OpenAI', resp.status, data));
  const text = data?.choices?.[0]?.message?.content ?? '';
  if (typeof text !== 'string' || !text.trim()) throw new Error('OpenAI 返回空内容');
  return text;
}
