# Mieru-OCR 订阅功能测试服务

独立于扩展构建流程的一个本地小服务，专门用来回归测试订阅规则包能否被正确拉取、合并、回滚。**不属于扩展产物**，不会被 `bun run build:*` 打包。

## 包含

| 文件 | 作用 |
|------|------|
| `server.ts` | 基于 Bun 的极简 HTTP 服务器，端口 `8765`（可改），CORS 全开 |
| `subscription.json` | 测试用规则包：OCR 关键词类 + **滑块/点选 siteRules** + **detModel 本地直链** |
| `index.html` | 配套测试页：展示订阅 URL、回归清单、每类规则的可视化测试用例（包含订阅前后预期差异） |
| `playground/` | 交互验证码标准测试台（GeeTest 同款滑块 + 文字点选 + CF mock） |
| `fixtures/common_det.onnx` | 本地点选检测模型（订阅 `detModel.url` / playground 加载） |
| `interaction-selftest.ts` | 无浏览器自测：订阅字段 + 滑块缺口 + det/OCR 识别 |

## 启动

```bash
# 默认端口 8765
bun test/server.ts
# 或
bun run test:subscription-server

# 自定义端口
bun test/server.ts 9000
# 或
PORT=9000 bun test/server.ts
```

启动后控制台会打印可访问 URL（本机 / 局域网）。

### 准备 det 模型（文字点选）

1.2.3 起 `common_det.onnx` 不再放在 `public/`。本地测试文件在：

```bash
# 若 test/fixtures/common_det.onnx 不存在，从已有产物拷贝：
mkdir -p test/fixtures
cp dist/userscript/common_det.onnx test/fixtures/common_det.onnx
# 该 .onnx 已被 .gitignore，不要提交进仓库
```

订阅包 `detModel.url` 指向 `http://localhost:8765/fixtures/common_det.onnx`。

### 无浏览器识别自测

```bash
bun run test:interaction
# 可选：bun test/interaction-selftest.ts --slider-n 40 --click-n 10
```

覆盖：订阅字段校验（slider/click-select/detModel）→ 滑块缺口 slideMatch → det+OCR 点选标注。

## 使用流程

### A. OCR 关键词订阅回归

1. 启动本服务（见上）。
2. 浏览器打开 `http://localhost:8765/` —— 测试页会显示订阅 URL。
3. 复制 `http://localhost:8765/subscription.json`，粘贴到 **扩展设置 → 订阅规则 → 添加订阅**。
4. 保存后扩展会立刻拉取并合并规则。回到测试页，**回归清单**与每个测试卡片下方的实时状态会显示当前命中情况。
5. 测试完成后，到扩展订阅列表里删除本订阅 —— 扩展会自动回滚由本订阅引入的所有规则。

### B. 滑块 / 点选（规则驱动）

1.2.3 起交互式验证码**只走站点规则**，不再盲扫。测试包已内置 playground 规则：

| key | subType | selector | 匹配 URL |
|-----|---------|----------|----------|
| `slider@localhost-playground` | slider | `#gtSlider` | `http://localhost:8765/playground/` prefix |
| `slider@localhost-playground-pop` | slider | `.my-verify-box` | 同上 |
| `click@localhost-playground` | click-select | `#csContainer` | 同上 |

步骤：

1. `bun run build:extension`，加载 `dist/extension/`。
2. `bun run build:playground`（改过 playground 源码时）。
3. `bun run test:subscription-server`。
4. 扩展 **设置 → 订阅规则** 添加 `http://localhost:8765/subscription.json`。
5. 打开 `http://localhost:8765/playground/`。
6. 确认 **命中规则自动求解**（`autoSolveOnRule`）开启；打开调试模式看控制台：
   - `匹配URL规则` / `应用站点规则（交互式）` → 规则命中
   - `缺口候选` / `拖拽轨迹` → 滑块在跑
   - `点选检测模型未就绪` → 检查 `detModel` / fixtures 是否可访问
7. 也可不装扩展，直接在 playground 点「检测 / 自动求解 / 自测」调用核心模块。

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
| ⑥ 站点规则 (OCR) | `siteRules` | 在 `localhost` / `127.0.0.1` 域上命中 `#sub-test-site-rule-captcha` |
| ⑦ 站点黑名单 | `siteBlacklist` | 写入扩展黑名单，需到「扩展设置 → 黑名单」目视核对 |
| ⑧ 计算规则 | `calculateRules` | 写入扩展计算规则，需到「扩展设置 → 计算规则」目视核对 |
| ⑨ 滑块规则 | `siteRules` + `subType:slider` | playground `#gtSlider` / `.my-verify-box` 自动求解 |
| ⑩ 点选规则 | `siteRules` + `subType:click-select` + `detModel` | playground `#csContainer`；模型从 `/fixtures/common_det.onnx` 拉取 |

## 注意

- 本服务**不会**被任何 `bun run build:*` 命令包含到扩展产物里，是纯开发/测试工具。
- `subscription.json` 里大部分关键词都加了 `subtest` 前缀，目的是不与真实网站的规则发生碰撞；测试完请**务必删除订阅**让扩展回滚这些规则。
- 如果要测「自动更新」逻辑，把订阅的 `updateInterval` 设短一些（例如 1 小时），然后修改 `subscription.json` 中的 `version` 或 `updatedAt` 字段。

## 扩展端到端测试：真实业务场景（真浏览器 + 真扩展 + 迷你后端）

`e2e/extension_smoke.py` 用 Python Playwright 拉起带 `dist/extension` 未打包扩展的真实
Chromium，并起一个迷你后端（验证码真值、登录校验、换图接口都在服务端），场景复刻
电商/后台登录链路，而不是「画个 canvas 填个 input」：

**登录页**（`/login`）
- Header + 顶部搜索框 + 登录卡片 + 营销 banner + logo/头像/二维码装饰图 + 隐藏验证码图；
- 验证码输入框包在 `.ant-form-item` / `.ant-input-group` 里（模拟 Ant Design 结构），
  另有手机号/邮箱（预填）、密码（预填）、短信验证码（空）等干扰输入；
- 验证码由页面按 `test/index.html` 同款算法生成（渐变底 + 干扰线 + 噪点 + 彩色旋转字形），
  由后端以 PNG 下发；后端保存真值，校验**不区分大小写**（真实站点常见约定）；
- 用户协议自动勾选、「7 天免登录」不得被勾、其他输入框不得被填充；
- 提交后：错误 → 后端换一张新验证码（`img.src` 变化）→ 扩展需重新识别填充 → 再次提交。

| 用例 | 验证点 |
|------|--------|
| `login` | 真实登录链路：先**故意填错**触发「拒绝 → 换图 → 重新识别」，再识别正确后登录成功；同时校验干扰输入未被填充、协议已勾选 |
| `slider` | 极验风格拼图滑块：背景挖圆形缺口 + 从背景裁出的拼图块，扩展用 pointer 事件真实拖拽，后端按 ±6px 容差校验落点 |
| `spa` | 验证码组件整个节点重建（旧引用失效）后，站点规则仍能命中新节点并继续识别 |
| `crossorigin` | 跨域且无 CORS 头的图床 → 后台 `fetchImageData` 代抓 → 仍能识别填充 |
| `rule` | 懒加载 3s 后才渲染的组件 + 站点规则（`solveDelayMs/retryMs/maxWaitMs`）重试生效 |
| `iframe` | 内嵌合作方登录框：按 frameId 定向的右键识别由子框架应答并出结果 toast |
| `settings` | 改设置不刷新页面立即生效（关闭 autoFill 不再填充，恢复后继续填充） |
| `model` | `activeModelId` 指向不存在的模型 → 回退内置模型并提示用户 |
| `import` | 导入非法/合法配置都不会清空订阅与模型注册表 |
| `layout` | 设置页保存按钮 `position: fixed` 在右下角：滚动前后位置不变、高级设置同样固定 |

```bash
bun run build:extension                      # 必须先构建
pip install playwright && playwright install chromium
python test/e2e/extension_smoke.py           # 全部用例
python test/e2e/extension_smoke.py login     # 只跑名字含 login 的用例
```

如果想验证用例本身有效，可以临时撤掉某个修复再跑对应用例：

- 把 `content.ts` 的 `chrome.runtime.onMessage.addListener(handleMessage)` 挪回子框架门控之后
  → `iframe` 报 `Receiving end does not exist`；
- 去掉 content 的 `chrome.storage.onChanged` 监听 → `settings` 报「关闭 autoFill 后仍被填充」；
- 恢复导入前的 `storage.local.clear()` → `import` 报「合法导入把订阅清掉了」。

> 脚本依赖 Python + 本地 Chromium，不进 CI；发版前本地跑一遍即可。每次运行会打印
> 登录尝试次数与验证码命中情况（不区分大小写），可作为模型回归的粗粒度指标。

## Firefox 端到端测试（MV3 + 真 Firefox）

`e2e/firefox_smoke.py` 用 **Selenium + geckodriver** 启动真实 Firefox，通过
`install_addon(..., temporary=True)` 装入 `dist/firefox`（MV3），复用同一套迷你后端与测试页。
Playwright 的 Firefox 不支持加载扩展，所以这里单独走 geckodriver。

| 用例 | 验证点 |
|------|--------|
| `login` | MV3 事件页启动 → `ort.min.js` + `background.js`(经典 IIFE) 加载模型 → OCR 填充 → 登录成功；干扰输入不被改写、协议自动勾选 |
| `slider` | 通过扩展 options 页写入 `siteRules` → 拼图滑块由背景页 Worker 匹配 + 真实拖拽，后端按 ±6px 校验 |

```bash
bun run build:firefox
pip install selenium
# geckodriver: https://github.com/mozilla/geckodriver/releases
set MIERU_GECKODRIVER=C:\path\to\geckodriver.exe
set MIERU_FIREFOX=C:\path\to\firefox.exe        # 可选，默认用 Playwright 缓存的 Firefox
python test/e2e/firefox_smoke.py
```

同时建议跑一遍 Mozilla 官方校验（manifest/权限/API 规范）：

```bash
npx web-ext lint --source-dir dist/firefox
```

MV3 迁移要点（本项目已按此实现）：

- Firefox 不支持 `background.service_worker`，MV3 用 `background.scripts` 事件页；脚本按顺序执行且必须是**经典脚本**，所以背景页用 esbuild 打成单个 IIFE，并由 manifest 先加载 `ort.min.js`（设置 `window.ort`）。
- `action` 取代 `browser_action`；`<all_urls>` 移到 `host_permissions`；CSP 改成 `{ "extension_pages": ... }` 对象；`web_accessible_resources` 不再需要（内容脚本不加载任何扩展资源），减少模型文件对所有站点的暴露。
- `browser_specific_settings.gecko.data_collection_permissions` 是 AMO 的硬性要求（Firefox 140+ 桌面 / 142+ Android），配合 `strict_min_version: 142.0` 可消除 web-ext lint 的 Android 版本告警。
