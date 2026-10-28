# 上架材料（Chrome / Edge / Firefox）

> 这些是**代码之外**的商店材料，改代码不影响它们；提交审核时按需复制。

## 一、基础信息

| 项 | 值 |
|---|---|
| 名称 | Mieru-OCR |
| 版本 | 见仓库根目录 `version` 文件 |
| 分类 | 效率工具 / 开发者工具（Chrome）、隐私与安全（Firefox 可选） |
| 语言 | 简体中文、日本語、English（`_locales`） |
| 隐私政策 | `docs/store/privacy-policy.md`（需发布成可公开访问的 URL） |
| 主页 | https://github.com/MakotoArai-CN/Mieru-OCR |

## 二、简介文案

**短描述（≤132 字符，Chrome/Edge）**

> 离线识别图片验证码，自动填充；支持滑块拼图与文字点选，全本地推理，不上传任何页面数据。

**详细描述（长版）**

```
Mieru-OCR 是完全离线的验证码识别扩展。

· 图片验证码：本地 ONNX 模型识别，自动填入页面输入框
· 滑块拼图：识别缺口并按拟人轨迹拖拽（站点规则驱动）
· 文字点选：检测文字位置，按题面顺序点击
· 跨域图片：后台代抓像素，CORS 图床也能识别
· 框架兼容：React / Vue / Angular 受控输入均可写入

所有识别都在本机完成，不上传截图、不收集浏览记录。
模型文件随扩展打包，无需联网即可使用（自定义模型 / 检测模型按需下载）。
```

## 三、权限用途说明（提交审核时逐条填写）

| 权限 | 用途 |
|---|---|
| `host_permissions: <all_urls>` | 验证码可能出现在任意站点，需要在页面内检测元素、读取图片像素并写入输入框；不用于追踪浏览行为 |
| `activeTab` | 用户主动操作（右键识别）时访问当前标签页 |
| `storage` | 保存用户设置、站点规则与订阅列表（本地） |
| `scripting` | 在用户点击识别时向当前页面补注入内容脚本（安装后打开的旧标签页） |
| `offscreen`（Chrome） | 在隐藏文档中运行 ONNX WASM 推理，避免阻塞页面 |
| `alarms` | 定时刷新订阅规则（默认 30 分钟） |
| `contextMenus` | 右键菜单「识别此图片」 |

**数据收集**：无。`browser_specific_settings.gecko.data_collection_permissions.required = ["none"]` 已在 manifest 中声明。

## 四、截图

`docs/store/screenshots/`：

| 文件 | 尺寸 | 内容 |
|---|---|---|
| `options-general.png` | 1280×800 | 设置页（基本设置） |
| `options-models.png` | 1280×800 | 模型管理（内置 / 自定义 / 检测模型） |
| `options-mobile.png` | 420×780 | 移动端布局（保存按钮固定在右下角） |
| `popup.png` | 360×520 | 弹窗（状态、当前站点、快捷操作） |
| `login-demo.png` | 1280×800 | 测试页：登录表单已自动填入验证码 |

重新生成：`python test/e2e/capture_store_shots.py`（需要 `bun run build:extension`）。

## 五、Firefox for Android

manifest 已声明 `gecko_android`（142+）。Fenix 不渲染 `action` popup，扩展在 Android 上会清空 popup，
点击图标直接打开**设置页**；识别与拖拽由内容脚本执行。

上架前请在真机跑一遍 `docs/store/firefox-android-qa.md` 的清单——目前只有桌面端自动化证据。

## 六、需要人工确认的项

- Chrome Web Store 的「隐私权做法」表单（无数据收集，需与 privacy-policy 一致）
- Edge Add-ons 的权限说明（与本表一致）
- AMO 审核可能要求说明 `ort.min.js`（微软 ONNX Runtime，MIT）与 `common.onnx`（ddddocr 模型，MIT）的来源
- 商店截图建议替换为真实站点使用场景（当前 login-demo 用的是测试页）
