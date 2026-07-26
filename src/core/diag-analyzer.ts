/**
 * 诊断报告启发式分析器（离线，无 DOM 依赖）。
 *
 * 吃 `DiagnosticReport`（v1 或 v2），产出结构化的 `AnalysisResult`：汇总 + 按已知失败
 * 模式匹配出的 `findings`（含修复建议）+ 供 UI 画直方图的 `charts`。
 *
 * 纯函数：扩展 options 与独立分析工具都 import 本模块。不联网、不改状态。
 */

import type { DiagnosticReport, DiagEvent, LogEntry, DiagSummary } from './diagnostics';
import { computeSummary } from './diagnostics';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** 稳定代号，便于去重/文档引用 */
  code: string;
  title: string;
  detail: string;
  /** 证据（次数/样本），非必填 */
  evidence?: string;
  recommendation: string;
}

export interface AnalysisResult {
  schema: string;
  summary: DiagSummary;
  findings: Finding[];
  charts: {
    failReasons: Array<{ label: string; value: number }>;
    kindSuccess: Array<{ kind: string; ok: number; fail: number; rate: number }>;
  };
  meta: {
    generatedAt?: string;
    app?: { name?: string; version?: string; target?: string };
    hasEvents: boolean;
  };
}

/** 把所有日志文本拼成一个小写 blob，便于子串检测已知错误。 */
function logBlob(logs: LogEntry[]): string {
  return logs.map((l) => l.msg).join('\n').toLowerCase();
}

function countFail(events: DiagEvent[], kind: DiagEvent['kind'], reason: string): number {
  return events.filter((e) => e.kind === kind && e.ok === false && (e.data?.reason as string) === reason).length;
}

/**
 * 主入口：分析报告。所有判定都从 events / summary / logs 推断，尽量给可执行建议。
 */
export function analyzeReport(report: DiagnosticReport): AnalysisResult {
  const events: DiagEvent[] = Array.isArray(report.events) ? report.events : [];
  const logs: LogEntry[] = Array.isArray(report.logs) ? report.logs : [];
  const summary: DiagSummary = report.summary || computeSummary(events, logs);
  const blob = logBlob(logs);
  const findings: Finding[] = [];
  const push = (f: Finding) => findings.push(f);

  // ---- 滑块相关 ----
  const tainted = countFail(events, 'slider', 'tainted-canvas');
  if (tainted > 0) {
    push({
      severity: 'critical', code: 'slider-tainted',
      title: '滑块背景图跨域不可读（tainted canvas）',
      detail: `有 ${tainted} 次滑块求解因背景 canvas 被跨域污染而无法读取像素、无法做缺口检测。`,
      evidence: `slider reason=tainted-canvas ×${tainted}`,
      recommendation: '该站点的验证码 canvas 跨域受限，浏览器禁止读取其像素。滑块辅助在此类站点通常无法工作；只能等站点侧允许 CORS，或改用其它验证方式。',
    });
  }
  const noBg = countFail(events, 'slider', 'no-background');
  const noHandle = countFail(events, 'slider', 'no-handle');
  if (noBg + noHandle > 0) {
    push({
      severity: 'warning', code: 'slider-selector',
      title: '滑块规则 selector 可能选错（找不到背景图/手柄）',
      detail: `no-background ×${noBg}、no-handle ×${noHandle}。求解器在容器内没找到背景图或拖拽手柄。`,
      recommendation: '规则 selector 应指向「包含 canvas/img 的容器」，而非内部 canvas 本身。用扩展的手动选择功能重选容器，或检查订阅规则的 selector。',
    });
  }
  const lowConf = countFail(events, 'slider', 'low-confidence');
  const smallDist = countFail(events, 'slider', 'distance-too-small');
  if (lowConf + smallDist > 0) {
    push({
      severity: 'warning', code: 'slider-low-conf',
      title: '缺口检测置信度低 / 距离过小',
      detail: `low-confidence ×${lowConf}、distance-too-small ×${smallDist}。多算法融合未能可靠定位缺口。`,
      recommendation: '确认背景图/滑块小图选择正确；若站点风控严可给规则设 dragProfile:"cautious"；必要时人工核对缺口位置。',
    });
  }

  // ---- 文字点选 / 检测模型 ----
  const detNotReadyEvt = events.filter((e) => e.kind === 'det-model' && (e.data?.ready === false || e.ok === false)).length;
  const clickDetOff = events.filter((e) => e.kind === 'click' && e.data?.detReady === false).length;
  if (detNotReadyEvt + clickDetOff > 0 || blob.includes('det_not_provisioned') || blob.includes('检测模型未就绪')) {
    push({
      severity: 'critical', code: 'det-not-ready',
      title: '文字点选检测模型未就绪',
      detail: `det 未就绪事件 ×${detNotReadyEvt}、点选因缺模型跳过 ×${clickDetOff}。检测模型（common_det.onnx）不再内置，需按需提供。`,
      recommendation: '到「设置 → 文字点选模型」上传本地模型或点「下载默认模型」；若走订阅，检查订阅 detModel 的 url/sha256 是否正确、且「自动下载」已开启。',
    });
  }
  const shaFail = events.filter((e) => e.kind === 'det-model' && (e.data?.reason as string || '').includes('sha256')).length
    || (blob.includes('sha256') && blob.includes('校验失败') ? 1 : 0);
  if (shaFail > 0) {
    push({
      severity: 'critical', code: 'det-sha256',
      title: '检测模型 sha256 校验失败',
      detail: '下载的检测模型哈希与订阅声明不一致，已拒绝加载（防篡改）。',
      recommendation: '联系订阅作者核对 detModel.sha256 与实际文件；或改用「下载默认模型」/本地上传。',
    });
  }

  // ---- OCR / 模型加载 ----
  if (blob.includes('falling back to builtin') || blob.includes('回退') && blob.includes('内置')) {
    push({
      severity: 'info', code: 'model-fallback',
      title: '上传/自定义模型加载失败，已回退内置模型',
      detail: '活动模型无法构建 ORT 会话，识别改用内置 common 模型。',
      recommendation: '检查上传的 .onnx 与 charsets 是否配套、是否为有效 ONNX；用「上传新模型」的冒烟测试确认。',
    });
  }
  if ((blob.includes('ort') && blob.includes('wasm') && (blob.includes('fail') || blob.includes('error') || blob.includes('失败')))
    || blob.includes('未加载或全局 ort')) {
    push({
      severity: 'critical', code: 'ort-load',
      title: 'ONNX Runtime / WASM 加载失败',
      detail: 'ORT 运行时或其 WASM 资源未能加载，OCR/检测都会不可用。',
      recommendation: '检查扩展内 wasm 资源是否完整、网络/CDN 是否可达；userscript 场景确认 @require 的 ort CDN 正常。',
    });
  }

  const rec = summary.byKind['recognize'];
  if (rec && rec.total >= 5 && rec.fail / rec.total > 0.4) {
    push({
      severity: 'warning', code: 'ocr-fail-rate',
      title: `OCR 识别失败率偏高（${Math.round((rec.fail / rec.total) * 100)}%）`,
      detail: `recognize 事件 ${rec.total} 次，失败 ${rec.fail} 次。`,
      recommendation: '确认该站点验证码类型与模型匹配；必要时换用针对性模型或调整 selector/inputSelector。',
    });
  }

  // ---- 上下文错误率 ----
  for (const [ctx, c] of Object.entries(summary.contexts)) {
    if (c.errors >= 5) {
      push({
        severity: 'warning', code: `ctx-errors-${ctx}`,
        title: `「${ctx}」上下文错误较多（${c.errors} 条）`,
        detail: `该上下文累计 ${c.errors} 条 error 级日志/事件。`,
        recommendation: '结合下方日志时间线定位反复出现的 error；若集中在 offscreen/sw，多为模型/WASM 或消息通道问题。',
      });
    }
  }

  // ---- 报告本身的可用性提示 ----
  if (events.length === 0) {
    push({
      severity: 'info', code: 'no-events',
      title: '报告不含结构化事件',
      detail: '这是 v1 报告，或采集时未开启调试模式。可分析的信息有限。',
      recommendation: '开启「调试模式」后复现问题再导出报告，会带上结构化事件与汇总，便于定位。',
    });
  }

  // severity 排序：critical > warning > info
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const charts = {
    failReasons: Object.entries(summary.failReasons)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    kindSuccess: Object.entries(summary.byKind).map(([kind, k]) => ({
      kind, ok: k.ok, fail: k.fail,
      rate: k.total ? Math.round((k.ok / k.total) * 100) : 0,
    })),
  };

  return {
    schema: report.schema || 'unknown',
    summary,
    findings,
    charts,
    meta: {
      generatedAt: report.generatedAt,
      app: report.app,
      hasEvents: events.length > 0,
    },
  };
}
