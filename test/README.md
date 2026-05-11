# Mieru-OCR 订阅功能测试服务

独立于扩展构建流程的一个本地小服务，专门用来回归测试订阅规则包能否被正确拉取、合并、回滚。**不属于扩展产物**，不会被 `bun run build:*` 打包。

## 包含

| 文件 | 作用 |
|------|------|
| `server.ts` | 基于 Bun 的极简 HTTP 服务器，端口 `8765`（可改），CORS 全开 |
| `subscription.json` | 测试用规则包，覆盖 8 类规则（触发关键词 / 排除 / 协议 / 输入排除 / 协议选择器 / 黑名单 / 站点规则 / 计算规则） |
| `index.html` | 配套测试页：展示订阅 URL、回归清单、每类规则的可视化测试用例（包含订阅前后预期差异） |

## 启动

```bash
# 默认端口 8765
bun test-subscription-service/server.ts

# 自定义端口
bun test-subscription-service/server.ts 9000
# 或
PORT=9000 bun test-subscription-service/server.ts
```

启动后控制台会打印可访问 URL（本机 / 局域网）。

## 使用流程

1. 启动本服务（见上）。
2. 浏览器打开 `http://localhost:8765/` —— 测试页会显示订阅 URL。
3. 复制 `http://localhost:8765/subscription.json`，粘贴到 **扩展设置 → 订阅规则 → 添加订阅**。
4. 保存后扩展会立刻拉取并合并规则。回到测试页，**回归清单**与每个测试卡片下方的实时状态会显示当前命中情况。
5. 测试完成后，到扩展订阅列表里删除本订阅 —— 扩展会自动回滚由本订阅引入的所有规则。

## 端点

| 路径 | 说明 |
|------|------|
| `GET /` | 测试页 |
| `GET /index.html` | 测试页 |
| `GET /subscription.json` | 订阅 JSON（`application/json; charset=utf-8`，CORS `*`，no-cache） |

## 测试矩阵

| 规则类别 | JSON 字段 | 测试方式 |
|---------|----------|---------|
| ① 触发关键词 | `includeKeywords` | 页面有 `class="subtestcap-image"` 图片，订阅前不识别，订阅后识别并自动回填 |
| ② 排除模式 | `excludePatterns` | 页面有 `class="captcha-image subtest-ignore"` 图片，订阅后被屏蔽 |
| ③ 协议关键词 | `agreementKeywords` | 复选框附近文本含「订阅测试协议」，订阅 + 自动勾选协议后被勾选 |
| ④ 输入排除 | `inputExcludeKeywords` | `placeholder="subtest-special-code ..."` 的输入框，订阅后不应被回填 |
| ⑤ 协议选择器 | `agreementSelectors` | `#sub-test-agreement` 与 `.sub-test-agreement-by-class input`，订阅后被勾选 |
| ⑥ 站点规则 | `siteRules` | 在 `localhost` / `127.0.0.1` 域上命中 `#sub-test-site-rule-captcha` |
| ⑦ 站点黑名单 | `siteBlacklist` | 写入扩展黑名单，需到「扩展设置 → 黑名单」目视核对 |
| ⑧ 计算规则 | `calculateRules` | 写入扩展计算规则，需到「扩展设置 → 计算规则」目视核对 |

## 注意

- 本服务**不会**被任何 `bun run build:*` 命令包含到扩展产物里，是纯开发/测试工具。
- `subscription.json` 里大部分关键词都加了 `subtest` 前缀，目的是不与真实网站的规则发生碰撞；测试完请**务必删除订阅**让扩展回滚这些规则。
- 如果要测「自动更新」逻辑，把订阅的 `updateInterval` 设短一些（例如 1 小时），然后修改 `subscription.json` 中的 `version` 或 `updatedAt` 字段。
