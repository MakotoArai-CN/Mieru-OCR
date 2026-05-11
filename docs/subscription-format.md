# 订阅规则包格式

Mieru-OCR 支持订阅远程规则包，类似 AdGuard 订阅过滤器。订阅 URL 应返回如下格式的 JSON。

## 完整字段

```json
{
  "name": "订阅包名称（必填）",
  "description": "订阅说明（可选）",
  "version": "1.0.0（必填）",
  "author": "作者（可选）",
  "updatedAt": 1735689600000,

  "siteRules": {
    "<key>": {
      "hostname": "example.com",
      "selector": "img.captcha",
      "inputSelector": "input[name='captcha']",
      "submitSelector": "button[type='submit']",
      "agreementSelectors": ["#agree"],
      "fullUrl": "https://...",
      "urlPattern": "https://..."
    }
  },

  "calculateRules": [
    {
      "pattern": "*.example.com",
      "matchType": "wildcard | regex",
      "outputMode": "result | equation",
      "enabled": true
    }
  ],

  "includeKeywords":      ["captcha", "verify"],
  "excludePatterns":      ["qrcode"],
  "agreementKeywords":    ["agree"],
  "inputExcludeKeywords": ["sms"],
  "agreementSelectors":   ["#agree"],
  "siteBlacklist":        ["banned.com"]
}
```

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 订阅包名称 |
| `version` | string | 是 | 版本号 |
| `description` | string | 否 | 描述 |
| `author` | string | 否 | 作者 |
| `updatedAt` | number | 否 | 更新时间戳 |
| `siteRules` | object | 否 | 站点规则字典：key → 规则对象 |
| `calculateRules` | array | 否 | 四则运算规则数组 |
| `includeKeywords` | string[] | 否 | 触发识别的关键词（追加到自定义触发词） |
| `excludePatterns` | string[] | 否 | 排除关键词（追加到自定义排除词） |
| `agreementKeywords` | string[] | 否 | 协议关键词（追加） |
| `inputExcludeKeywords` | string[] | 否 | 输入框排除关键词（追加） |
| `agreementSelectors` | string[] | 否 | 协议选择器（追加） |
| `siteBlacklist` | string[] | 否 | 站点黑名单（追加） |

## 合并策略

- **关键词类（`includeKeywords` / `excludePatterns` / `agreementKeywords` / `inputExcludeKeywords` / `agreementSelectors` / `siteBlacklist`）**：与用户已有列表合并，去重后追加
- **`siteRules`**：直接写入，key 冲突时覆盖
- **`calculateRules`**：按 `pattern` + `matchType` 去重后追加

## 删除订阅

删除订阅时会自动移除该订阅引入的所有规则（基于缓存的规则包内容做差量删除）。

## 自动更新

可设置自动更新间隔（小时）。脚本启动时会检查所有订阅，超过间隔的会自动拉取最新版本。

## 示例

参见 [subscription-example.json](./subscription-example.json)。

## 提供订阅

1. 编写一份符合上述格式的 JSON 文件
2. 上传到任何支持公网访问的位置（GitHub Raw、GitHub Pages、Gist、个人服务器等）
3. 分享 URL 给其他用户，他们在 **设置 → 订阅规则 → 添加订阅** 中添加即可
