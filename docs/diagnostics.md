# 诊断与智能分析

Mieru-OCR 的诊断系统帮助定位「验证码没识别 / 滑块没拖 / 点选没点」这类问题。它**默认不采集、纯本地、脱敏**，只有你主动开启调试模式并导出时才产出一份 JSON 报告。

## 采集（开启调试模式）

设置 → 高级 → 调试 → 打开「调试模式」。开启后，扩展会在各上下文（内容脚本 / 后台 / offscreen / 弹窗 / 设置页）记录：

- **运行日志**：最多每上下文 200 条文本日志。
- **结构化事件**（1.2.3 起）：最多每上下文 300 条，比日志更易机器分析。事件类型：
  - `recognize` — OCR 识别（成功/耗时/结果长度）
  - `slider` — 滑块求解（成功/缺口分数/距离/方法/dragProfile/失败原因）
  - `click` — 文字点选（成功/检测模型是否就绪/失败原因）
  - `rule-match` — 命中站点/订阅规则（规则键 hash / urlMatch 模式 / subType）
  - `det-model` — 检测模型 provisioning（就绪/来源/原因）
  - `error` — 异常（位置/消息）

复现问题后，在同一面板点「导出诊断报告 (.json)」得到 `Mieru-diag-*.json`（schema `Mieru-diag-v2`）。

## 报告结构（v2）

```jsonc
{
  "schema": "Mieru-diag-v2",
  "generatedAt": "...",
  "app": { "name", "version", "target" },
  "env": { "userAgent", "platform", "language", "screen", "online" },
  "settings": { /* 已脱敏：URL/选择器/关键词等替换为 [长度·hash] */ },
  "activeModel": { "id", "size", "charsetsLength", "source" },
  "stats": { "total", "sites", "recent": [ /* host 已 hash */ ] },
  "logs": [ { "ts", "level", "ctx", "msg" } ],
  "events": [ { "ts", "ctx", "kind", "ok", "ms", "data" } ],
  "summary": {
    "byKind": { "slider": { "total", "ok", "fail", "avgMs" }, ... },
    "failReasons": { "tainted-canvas": 3, ... },
    "contexts": { "content": { "logs", "events", "errors" }, ... }
  }
}
```

## 分析器

有两处可以分析报告：

### 1. 扩展内（设置 → 高级 → 诊断分析）
- **分析当前数据**：直接分析你本机刚采集的数据。
- **导入报告分析**：分析别人发来的 `Mieru-diag-*.json`。
- 输出：可能根因 + 修复建议（启发式），例如「检测模型未就绪」「滑块 selector 选到了内部 canvas 而非容器」「背景图跨域不可读」等。

### 2. 独立工具（`tools/analyzer/`）
纯静态 HTML，可 GitHub Pages 托管，任何人（含订阅作者）都能用来分析他人发来的报告，与扩展解耦。

构建：
```bash
bun run build:analyzer   # 生成 tools/analyzer/analyzer.bundle.js
```
然后浏览器打开 `tools/analyzer/index.html`，把报告 JSON 拖进去即可。

## AI 深度分析（可选）

启发式分析之外，可选「AI 深度分析」——把**已脱敏**的报告发给你配置的大模型端点，得到自然语言的根因与修复步骤。

- **协议**：默认支持 **Anthropic (Claude)** 与 **OpenAI 兼容** 两种。
- **baseURL**：可自定义。默认 `https://api.anthropic.com`（Anthropic）/ `https://api.openai.com`（OpenAI）。
- **API Key**：**可留空**——用于本地 OpenAI 兼容端点（如 Ollama、LM Studio、各类网关）。留空时不发送鉴权头。
- **模型**：可自定义。默认 `claude-sonnet-4-6`（Anthropic）/ `gpt-4o-mini`（OpenAI）。

配置存于本地（扩展存 `chrome.storage.local`，独立工具存 `localStorage`）。

> 直连 Anthropic API 时会带 `anthropic-dangerous-direct-browser-access: true` 头以通过浏览器 CORS；用第三方网关/代理请确保其兼容对应协议路径（`/v1/messages` 或 `/v1/chat/completions`）。

## 隐私

- 采集只在**调试模式**下发生，全程**本地**，不自动上传。
- 报告中的 URL / 选择器 / 规则键 / 站点名等**已脱敏**（替换为 `[长度·hash]` 占位，可比较「是否存在/是否相同」但看不到明文）。
- **AI 深度分析是唯一会外发数据的动作**：仅在你填好端点并点击按钮、并二次确认后，才把已脱敏报告发送到**你自己配置的** baseURL。请确认你信任该端点。
- 导出报告前也请自行检查内容，再决定是否附到 Issue。
