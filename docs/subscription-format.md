# 订阅规则包格式

Mieru-OCR 支持订阅远程规则包，类似 AdGuard 订阅过滤器。订阅 URL 应返回如下格式的 JSON。

> **1.2.3 起的重要变化**
> - **滑块拖拽 / 文字点选不再盲扫**：仅当命中带 `subType` 的站点规则（来自订阅或手动保存）时才求解。请用 `siteRules` 精确描述目标站点的 URL + 选择器。
> - **文字点选检测模型不再随扩展内置**：由订阅 `detModel` 指定下载、或用户在设置里上传、或从仓库镜像下载。
> - **URL 匹配默认忽略随机 query 参数**（`origin + pathname`），见下文 `urlMatch` / `matchQuery`。

编写规则的实操指南见 [rule-authoring.md](./rule-authoring.md)。

## 完整字段

```json
{
  "name": "订阅包名称（必填）",
  "description": "订阅说明（可选）",
  "version": "1.0.0（必填）",
  "author": "作者（可选）",
  "updatedAt": 1735689600000,

  "detModel": {
    "url": "https://.../common_det.onnx",
    "sha256": "可选，下载后校验",
    "version": "1.5.1",
    "name": "显示名"
  },

  "siteRules": {
    "<key>": {
      "hostname": "example.com",
      "selector": ".captcha-container 或 img.captcha",
      "inputSelector": "input[name='captcha']",
      "submitSelector": "button[type='submit']",
      "agreementSelectors": ["#agree"],

      "urlPattern": "https://example.com/login",
      "fullUrl": "https://example.com/login",
      "urlMatch": "origin-path | prefix | exact | hostname",
      "matchQuery": ["lang", "step"],

      "subType": "slider | click-select",
      "solveDelayMs": 800,
      "retryMs": 2500,
      "maxWaitMs": 15000,
      "dragProfile": "fast | normal | cautious",

      "frameSelector": "iframe#captcha"
    }
  },

  "calculateRules": [
    { "pattern": "*.example.com", "matchType": "wildcard | regex", "outputMode": "result | equation", "enabled": true }
  ],

  "includeKeywords":      ["captcha", "verify"],
  "excludePatterns":      ["qrcode"],
  "agreementKeywords":    ["agree"],
  "inputExcludeKeywords": ["sms"],
  "agreementSelectors":   ["#agree"],
  "siteBlacklist":        ["banned.com"]
}
```

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 订阅包名称 |
| `version` | string | 是 | 版本号 |
| `description` | string | 否 | 描述 |
| `author` | string | 否 | 作者 |
| `updatedAt` | number | 否 | 更新时间戳 |
| `detModel` | object | 否 | 文字点选检测模型（见下） |
| `siteRules` | object | 否 | 站点规则字典：key → 规则对象 |
| `calculateRules` | array | 否 | 四则运算规则数组 |
| `includeKeywords` | string[] | 否 | 触发识别的关键词（追加到自定义触发词） |
| `excludePatterns` | string[] | 否 | 排除关键词（追加） |
| `agreementKeywords` | string[] | 否 | 协议关键词（追加） |
| `inputExcludeKeywords` | string[] | 否 | 输入框排除关键词（追加） |
| `agreementSelectors` | string[] | 否 | 协议选择器（追加） |
| `siteBlacklist` | string[] | 否 | 站点黑名单（追加） |

## `siteRules` 规则对象字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `hostname` | string | 建议 | 规则所属域名（hostname 兜底匹配用）。缺省时回退为 key |
| `selector` | string | 是 | 验证码元素 / 容器的 CSS 选择器。**滑块/点选请选「容器」**（含 canvas/img 的外层），不要选内部 canvas |
| `inputSelector` | string | 否 | 结果填入的输入框选择器（OCR 类用） |
| `submitSelector` | string | 否 | 自动提交按钮选择器 |
| `agreementSelectors` | string[] | 否 | 协议复选框选择器 |
| `urlPattern` | string | 否 | URL（用于 `origin-path` / `prefix` 匹配） |
| `fullUrl` | string | 否 | URL（与 `urlPattern` 等价，历史字段；二者择一） |
| `urlMatch` | string | 否 | 匹配模式，见下表。缺省时由 `fullUrl`/`urlPattern` 推断 |
| `matchQuery` | string[] | 否 | 必须参与匹配的 query 参数名白名单（仅比对这些，其余随机参数忽略） |
| `subType` | string | 否 | `slider`=滑块拖拽；`click-select`=文字点选；缺省=文本/图片 OCR |
| `solveDelayMs` | number | 否 | 命中后延迟多少毫秒再首次求解（应对懒加载/入场动画）。缺省 500 |
| `retryMs` | number | 否 | 未成功时的重试间隔（毫秒）。0/缺省=不重试 |
| `maxWaitMs` | number | 否 | 从命中到放弃的最长等待（毫秒）；设了 `retryMs` 而没写则默认 30000 |
| `dragProfile` | string | 否 | 滑块拖拽档位：`fast` / `normal`(默认) / `cautious`。越谨慎越拟人、越慢 |
| `frameSelector` | string | 否 | 目标在子 iframe 内时，顶层定位该 iframe 的选择器（需开启「深度扫描」） |

### `urlMatch` 匹配模式

| 模式 | 含义 |
|------|------|
| `origin-path` | **默认**。忽略全部 query/hash，按 `origin + pathname` 完全一致匹配。抗随机参数（`?t=168...`、`?nonce=...`） |
| `prefix` | 对归一化后的 `origin + pathname` 做前缀匹配（一个规则覆盖 `/login`、`/login/step2` 等） |
| `exact` | 含 query 的字面完全一致（旧 `fullUrl` 行为，仅在确实需要区分参数时用） |
| `hostname` | 仅按域名匹配（最宽松，整站生效） |

- 缺省推断：有 `fullUrl` → `origin-path`；有 `urlPattern` → `prefix`；都没有 → `hostname`。
- **随机参数处理**：默认（`origin-path`/`prefix`）已忽略全部 query。若**某些**参数必须区分（如 `?lang=ja` 与 `?lang=en` 是不同页面），用 `matchQuery: ["lang"]` 单独声明——只有这些参数会被比对，其余随机参数仍忽略。**注意：被比对的参数必须同时出现在规则的 URL 里**（即 `matchQuery` 比较的是「规则 URL 中该参数的值」与「当前页该参数的值」是否相等），所以要把目标值写进 `fullUrl`/`urlPattern`，例如 `"fullUrl": "https://site.com/login?lang=ja"` + `"urlMatch": "origin-path"` + `"matchQuery": ["lang"]`。

示例：URL `https://site.com/login?token=abc123&lang=ja`
- 规则 `{ "urlPattern": "https://site.com/login", "urlMatch": "origin-path" }` → **命中**（token 随机也无所谓）
- 规则 `{ "fullUrl": "https://site.com/login?lang=ja", "urlMatch": "origin-path", "matchQuery": ["lang"] }` → 仅当当前页 `lang=ja` 时命中；`lang=en` 不命中。

### `detModel` 检测模型字段

文字点选需要一个 YOLOX 检测模型（ddddocr `common_det.onnx`）定位字符框。**1.2.3 起不内置**，按以下优先级提供：

1. 用户在「设置 → 文字点选模型」上传本地模型，并把偏好设为「优先本地」时——用本地。
2. 否则用订阅的 `detModel`（按 `version` 变化判断是否重新下载）。
3. 否则若开启自动下载——从仓库镜像下载默认模型。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | ONNX 模型直链（http/https）。建议放 GitHub Raw / Release / 自有 CDN |
| `sha256` | string | 否（强烈建议） | 模型文件 sha256（hex）。下载后校验，不匹配则拒绝。**直链下载有供应链风险，建议务必填写** |
| `version` | string | 否 | 版本号；变化时才重新下载，避免每次都拉取 |
| `name` | string | 否 | 显示名 |

> 计算 sha256：`sha256sum common_det.onnx`（Linux/macOS）或 `Get-FileHash common_det.onnx -Algorithm SHA256`（PowerShell）。

## 合并策略

- **关键词类**（`includeKeywords` / `excludePatterns` / `agreementKeywords` / `inputExcludeKeywords` / `agreementSelectors` / `siteBlacklist`）：与用户已有列表合并，去重后追加。
- **`siteRules`**：直接写入，key 冲突时覆盖。
- **`calculateRules`**：按 `pattern` + `matchType` 去重后追加。
- **`detModel`**：随订阅缓存；首次需要文字点选时按优先级惰性下载、校验、缓存到 IndexedDB（不会在订阅时立即下载）。

## 删除订阅

删除订阅会移除该订阅引入的所有规则（基于缓存的规则包做差量删除）。若当前生效的检测模型来自该订阅，也会一并清除（用户上传的本地模型不受影响）。

## 自动更新

可设置自动更新间隔（小时）。启动时检查所有订阅，超过间隔的自动拉取最新版本。检测模型在 `detModel.version` 变化时于下次使用时重新下载。

## 提供订阅

1. 按上述格式编写 JSON 文件，托管到任意公网位置（GitHub Raw / Pages / Gist / 自有服务器）。
2. 如需附带文字点选模型，把 `common_det.onnx` 也托管到可直链下载处，并在 `detModel` 填写 `url` 与 `sha256`。
3. 把订阅 URL 分享给用户，他们在 **设置 → 订阅规则 → 添加订阅** 中添加即可。

完整示例见 [subscription-example.json](./subscription-example.json)。规则编写指南见 [rule-authoring.md](./rule-authoring.md)。
