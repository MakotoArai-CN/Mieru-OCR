# 隐私政策 / Privacy Policy

最后更新：2026-10-29

## 中文

Mieru-OCR（以下简称"本扩展"）是一个完全离线的验证码识别工具。

**我们不收集任何数据。** 具体而言：

1. **页面内容**：扩展只在本地读取页面中的验证码图片像素用于识别，识别结果直接写入当前页面的输入框，不会发送到任何服务器。
2. **截图与识别结果**：不上传、不存储、不用于训练。诊断日志（如开启）仅保存在浏览器本地存储中，由用户自行导出。
3. **浏览记录**：不记录访问过的网址。站点规则、订阅列表只保存在浏览器本地存储（`chrome.storage.local` / `browser.storage.local`）。
4. **模型文件**：内置模型随扩展打包，无需联网。若用户主动上传自定义模型、或开启"自动下载检测模型"，扩展会从用户配置的地址（默认是本项目 GitHub 仓库镜像）下载模型文件；该请求只包含模型文件本身，不携带页面数据。
5. **订阅规则**：若用户添加订阅，扩展会定期请求订阅 URL 以更新规则；请求不携带任何页面内容或用户标识。

本扩展不使用分析统计、广告、崩溃上报或任何第三方追踪服务。

如有疑问，请通过项目主页提交 Issue：
https://github.com/MakotoArai-CN/Mieru-OCR

## English

Mieru-OCR ("the extension") is a fully offline CAPTCHA recognition tool.

**We do not collect any data.** Specifically:

1. **Page content** — CAPTCHA images are read locally for recognition only; the result is written into the page's input field and never sent to any server.
2. **Screenshots and results** — never uploaded, stored, or used for training. Optional diagnostics stay in local browser storage and are exported only by the user.
3. **Browsing history** — not recorded. Site rules and subscriptions live in local extension storage (`chrome.storage.local` / `browser.storage.local`).
4. **Model files** — the built-in model ships with the extension. If you upload a custom model, or enable automatic download of the detection model, the extension fetches the model file from the configured URL (by default this project's GitHub mirror). That request contains no page data.
5. **Subscriptions** — if you add a subscription, the extension periodically fetches that URL to update rules. The request carries no page content or user identifier.

The extension contains no analytics, ads, crash reporting, or third-party tracking.

Contact: https://github.com/MakotoArai-CN/Mieru-OCR/issues
