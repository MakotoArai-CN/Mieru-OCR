# 远程规则编写指南

面向想为 Mieru-OCR 编写订阅规则（尤其是 **滑块拖拽 / 文字点选**）的开发者。规则包的字段定义见 [subscription-format.md](./subscription-format.md)，本文讲「怎么写对、怎么测」。

## 为什么滑块/点选必须写规则（1.2.3 起）

1.2.2 及更早版本靠关键词 + 结构启发式**盲扫**页面找滑块/点选，误判率高，且会在毫不相关的拖拽控件上触发自动操作。1.2.3 起**取消盲扫**：滑块与文字点选只有命中精确的站点规则（来自订阅或用户手动保存）才会求解。OCR / 图片 / 计算类验证码不受影响，仍自动识别。

所以：要让某站点的滑块/点选自动求解，必须为它写一条带 `subType` 的规则，精确描述 **URL + 容器选择器**。

## 第一步：确定 URL 作用域

规则用 `urlPattern`（或 `fullUrl`）+ `urlMatch` 圈定生效的页面。

- **默认 `origin-path`**：忽略全部 query/hash。验证码页 URL 常带随机 token（`?t=170…`、`?_=…`、`?nonce=…`），用默认模式即可无视它们。
- 一个验证码用在多个子路径 → 用 `urlMatch: "prefix"`。
- 整站都用同一套验证码 → 用 `urlMatch: "hostname"`（最宽松）。
- 个别参数会切换到不同页面（如 `?lang=ja` vs `?lang=en`）→ 加 `matchQuery: ["lang"]` 只校验这几个参数。

> 经验：先用 `origin-path` 收窄到具体页面，命中不了再放宽到 `prefix`/`hostname`。越窄越不会误触发。

## 第二步：选对「容器」选择器

`selector` 必须指向**包含 canvas/img 的外层容器**，不是内部 canvas 本身：

- ✅ `.geetest_box`、`.nc-container`、`.verify-wrapper`
- ❌ `.geetest_canvas_bg`、容器里的 `canvas`（求解器需要从容器重建背景图/小图/手柄）

挑选择器的要点：
- 优先用稳定的 `id` / 语义化 class；避免框架生成的哈希类名（`.css-1ab2c3`）。
- 用 `:nth-of-type` 等结构选择器时确认它在目标页稳定。
- 可以用扩展的「手动选择」功能（设置/popup → 选验证码）现场框选，自动生成选择器，再粘进订阅。

## 第三步：写 `subType` 与时机

```json
{
  "hostname": "demo.com",
  "urlPattern": "https://demo.com/verify",
  "urlMatch": "origin-path",
  "subType": "slider",
  "selector": ".geetest_box",
  "solveDelayMs": 800,
  "retryMs": 2500,
  "maxWaitMs": 15000,
  "dragProfile": "cautious"
}
```

- `subType`：`slider`（滑块拖拽）或 `click-select`（文字点选）。
- **扫描时机**（应对懒加载 / 入场动画）：
  - `solveDelayMs`：命中后等多少毫秒再首次求解。验证码常在弹窗动画后才就绪，给 600–1000ms 较稳。
  - `retryMs`：未成功时每隔多少毫秒重试（验证码刷新/首帧没加载完时有用）。
  - `maxWaitMs`：超过则停止重试，避免反复触发站点风控。
- `dragProfile`（仅滑块）：`fast` / `normal` / `cautious`。风控严的站点用 `cautious`（更慢、更拟人、过冲回拉幅度更大）。

## 第四步：文字点选的检测模型

文字点选除 OCR 外还需要一个 YOLOX 检测模型定位字符框，1.2.3 起不内置。订阅可以指定它：

```json
"detModel": {
  "url": "https://your-host/common_det.onnx",
  "sha256": "<sha256 hex>",
  "version": "1.5.1",
  "name": "common_det"
}
```

- `url` 必须能直链下载（GitHub Raw / Release / 自有 CDN）。
- **务必填 `sha256`**：直链下载有供应链风险，扩展会在下载后校验，不匹配即拒绝。计算方式：
  - Linux/macOS：`sha256sum common_det.onnx`
  - PowerShell：`Get-FileHash common_det.onnx -Algorithm SHA256`
- 不指定 `detModel` 时，扩展会在用户开启自动下载的前提下，从仓库镜像拉取默认 `common_det.onnx`。
- 用户也可以在「设置 → 文字点选模型」自行上传模型并设为优先，此时以用户本地模型为准。

## 第五步：本地自测

仓库带了一个测试场 `test/playground/`，含滑块 / 点选样例，可用来验证规则：

1. 构建并加载扩展：`bun run build:extension`，浏览器加载 `dist/extension/`。
2. 打开 playground 页面（或目标站点）。
3. 把你的规则做成一份订阅 JSON，托管或用本地文件服务器（`bun x serve` 等），在 **设置 → 订阅规则** 添加。
4. 刷新目标页，开启扩展的「调试模式」看控制台日志：
   - `匹配URL规则` / `应用站点规则（交互式）` → 规则命中。
   - `缺口候选: …` / `拖拽轨迹点数=…` → 滑块求解在跑。
   - `点选检测模型未就绪` → 检测模型没下下来，检查 `detModel.url` / sha256 / 自动下载开关。
5. 也可直接在订阅里临时把 `solveDelayMs` 调大观察时机是否合适。

## 发布与分享

1. 规则 JSON 托管到公网（GitHub Raw / Pages / Gist / 自有服务器）。
2. 如附带检测模型，模型也要可直链下载，并在 `detModel` 填 `url` + `sha256`。
3. 分享订阅 URL，用户在 **设置 → 订阅规则 → 添加订阅** 添加。

## 排查清单

| 现象 | 可能原因 |
|------|----------|
| 规则没命中 | URL 模式太严（试试 `prefix`/`hostname`）；`hostname` 没填或填错 |
| 命中但不求解 | 设置里「命中规则自动求解」(`autoSolveOnRule`) 被关；`selector` 没匹配到容器 |
| 滑块拖了但没过 | `selector` 选到了内部 canvas 而非容器；背景图跨域不可读（tainted）；试试调 `dragProfile: "cautious"` |
| 点选不动 | 检测模型未就绪（看日志/`detModel`）；prompt 文案解析不到目标字 |
| 反复触发、像被风控 | 调大 `maxWaitMs` 收敛重试；失败会自动指数退避，连续失败的规则冷却会被拉长 |
