<div align="center">

<img src="./icons/icon128.png" width="100" height="100" alt="logo">

<h1>DDDDOCR WEBJS</h1>

<a href="https://www.typescriptlang.org/" target="_blank"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="typescript">
</a>
<a href="https://github.com/microsoft/onnxruntime-web" target="_blank"><img src="https://img.shields.io/badge/onnxruntime--web-blue?style=for-the-badge" alt="onnxruntime-web"></a>
<a href="https://github.com/sml2h3/ddddocr" target="_blank"><img src="https://img.shields.io/badge/ddddocr-blue?style=for-the-badge" alt="ddddocr"></a>

</div>

使用 [ddddocr](https://github.com/sml2h3/ddddocr) 模型开发的浏览器验证码识别助手，使用 ONNX Runtime Web 在浏览器中识别验证码，支持油猴脚本，浏览器扩展。完全离线，不需要任何云服务以及后端服务的验证码识别，保护您的隐私安全。

> 由于浏览器的限制以及扩展的限制，模型文件和字符集全部存储与浏览器IndexedDB中，考虑到会占用大量存储，不建议关闭站点白名单使用。如果有需要，建议使用浏览器扩展版本。
>
> ~~脚本建议使用场景：单个站点频繁输入验证码/单个站点频繁测试~~
>
> 截止2026-01-28，浏览器扩展版本已经通过edge浏览器应用商店的审核，现在已经可以通过应用商店安装：[https://microsoftedge.microsoft.com/addons/detail/lbdjhikpmfggijmddllmekoepdkhfanl](https://microsoftedge.microsoft.com/addons/detail/lbdjhikpmfggijmddllmekoepdkhfanl)
> Chrome应用商店由于注册账号需要支付5美刀，本项目也是非盈利项目，所以没有上架，Chrome浏览器只能通过开发者模式安装浏览器扩展。
> 
> 截止2026年2月9日，正式支持火狐浏览器，火狐浏览器支持v140+版本

## ✨ 特性

- 🚀 浏览器内运行，无需后端
- 💾 自动缓存模型到 IndexedDB
- 🌐 支持多个 GitHub 镜像站
- 📦 支持离线模式
- 🎨 支持油猴，脚本猫等浏览器扩展
- 🎯 支持浏览器扩展

## 📦 安装

### 怎么选安装方式

Chrome系的浏览器直接使用扩展。

| 类型       | 安装方式            | 传送门                                                                                     | 描述                                                  |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 浏览器扩展 | Edge应用商店        | [Edge](https://microsoftedge.microsoft.com/addons/detail/lbdjhikpmfggijmddllmekoepdkhfanl) | Edge浏览器浏览器扩展                                  |
| 浏览器扩展 | FireFox应用商店        | [FireFox](https://addons.mozilla.org/addon/dddd-ocr-extension) | FireFox/WaterFox/Zen浏览器浏览器扩展（内核大于140都可以安装使用）                                  |
| 油猴脚本   | Chrome/Edge/Firefox | [ScriptCat](https://scriptcat.org/zh-CN/script-show-page/4781)                             | 支持油猴/脚本猫等浏览器扩展，只要支持浏览器扩展就能用 |
| 浏览器扩展 | 仓库安装            | [Github](https://github.com/MakotoArai-CN/ddddocr-webjs/releases/latest)                   | 直接下载压缩包文件，解压后安装浏览器扩展              |

### 在线安装

#### Userscript

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)、[Violentmonkey](https://violentmonkey.github.io/)或者[ScriptCat](https://www.scriptcat.org/) 等油猴插件
2. 安装脚本: 在[Greasy Fork](https://greasyfork.org/)脚本市场、[ScriptCat](https://www.scriptcat.org/)脚本市场中搜索 "DDDD OCR WEBJS" 安装
3. 等待脚本加载完毕，打开设置页设置白名单（必须）
4. 浏览器扩展版本目前还没有上架，请等待后续更新

#### EXTENSION

1. Edge Browser 用户打开链接: [https://microsoftedge.microsoft.com/addons/detail/lbdjhikpmfggijmddllmekoepdkhfanl](https://microsoftedge.microsoft.com/addons/detail/lbdjhikpmfggijmddllmekoepdkhfanl)
2. 点击安装按钮，等待安装完成
3. 安装完毕回打开扩展设置页，根据需要对扩展进行设置

> Google Chrome / Firefox 用户暂时不支持在线安装，请自行下载扩展包安装

### 编译安装

#### Userscript

1. 下载模型文件:
   - [common.onnx](https://github.com/MakotoArai-CN/ddddocr-webjs/releases/latest/download/common.onnx)
   - [charsets.json](https://github.com/MakotoArai-CN/ddddocr-webjs/releases/latest/download//charsets.json)
2. 放到你能找到的目录，后续导 入到脚本中（需要开启扩展的 **允许访问文件URL** ）
3. `git clone https://github.com/MakotoArai-CN/ddddocr-webjs.git && cd ddddocr-webjs`，构建: `bun run install && bun run build`
4. 安装 `dist\userscript\ddddocr-web.user.js`，浏览器扩展开启开发者模式后，选择目录`dist\extension`即可安装
5. 等待脚本加载完毕，打开设置页设置白名单（必须）

> 1.1.3版本开始添加量化模型，模型体积减少约48%，可以在最新版本的Release中下载

#### EXTENSION

1. 拉取仓库源代码编译

```bash
  git clone https://github.com/MakotoArai-CN/ddddocr-webjs.git
  cd ddddocr-webjs

  bun run install
  bun run build
```

1. 打开浏览器扩展页面，开启开发者模式，选择目录`dist\extension`(FireFox选择`dist\firefox`)，等待安装完成
2. 安装完毕回打开扩展设置页，根据需要对扩展进行设置

## 🛠️ 开发

```bash
# 安装依赖
bun install

# 开发模式
bun run dev

# 构建脚本
bun run build

# 构建全部
bun run build:all
```

## 📖 使用

### Userscript

1. 访问任意网页
2. 右上角出现 "DDDD OCR" 面板
3. 点击扩展，找到 "DDDD OCR" 面板的**打开设置**，配置脚本白名单
4. 等待模型加载完毕（首次加载需要下载模型，可能需要几分钟）

### EXTENSION

1. 访问任意网页的的登录页
2. 如果扩展没有识别到验证码和验证码输入框，请扩展窗口
3. 点击选择验证码或者验证码输入框，根据提示进行选择，选择完毕会自动识别

## 注意事项

- 默认使用白名单模式，在线下载模型，模型下载可能比较慢，请耐心等待
- 目前项目没有经过充分测试，不保证兼容性
- 项目使用AI辅助开发（其实都是AI干了🤐）部分功能可能无效或者没做，也不保证其安全性，有能力的可以自行检查，重新编译。
- 项目对vue/react/angular等前端框架的支持还没有经过严谨测试（因为我也找不到测试环境），请等待后续新版本更新支持
- 考虑到编译含有三方库，因此编译后的脚本默认清理了注释，并开启优化，压缩等，如需调试，请注释terser后编译

## 量化模型跑分

> 该成绩来自 https://github.com/MakotoArai-CN/ddddocr-webjs/tree/main/benchmark.ts

```bash
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🏆 TOP 10 MODELS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Rank Model                               Score  CharAcc  ExactAcc   AvgMs   P95Ms    Load    Size
  ─────────────────────────────────────────────────────────────────────────────────────────────────
  #1 common_q8_accuracy_opt.onnx          93.7    91.3%     80.0%     6.5     7.6    90ms   27.6M
  #2 common_q8_asymmetric.onnx            92.9    90.8%     79.5%     6.7     7.5    89ms   27.6M
  #3 common_q8_balanced.onnx              92.8    91.0%     80.0%     6.5     7.4    94ms   27.6M
  #4 common_q8_qoperator.onnx             92.8    91.0%     80.0%     6.3     7.1   100ms   27.6M
  #5 common_q8_accuracy.onnx              92.6    91.3%     80.0%     6.8     7.9    95ms   27.6M
  #6 common_q8_mixed_precision.onnx       92.4    91.3%     80.0%     6.5     7.3   101ms   27.6M
  #7 common_q8_pertensor.onnx             92.4    91.1%     80.5%     6.5     7.4   101ms   27.5M
  #8 common_q8_static_minmax.onnx         92.3    91.3%     80.0%     6.5     7.6   102ms   27.6M
  #9 common_q8_static_entropy.onnx        91.9    91.3%     80.0%     6.8     7.8   100ms   27.6M
  #10common_q8_conservative.onnx          91.8    91.3%     80.0%     6.6     8.0   101ms   27.6M
  ─────────────────────────────────────────────────────────────────────────────────────────────────

  📊 详细分析
    最高字符准确:  common_q8_full_qdq.onnx (96.4%)
    最高完全匹配:  common_q8_full_qdq.onnx (87.0%)
    推理最快:      common_q8_static_full_entropy.onnx (5.8ms avg)
    体积最小:      common_q4_nbits_b128.onnx (23.8M)
    综合最佳:      common_q8_accuracy_opt.onnx (score: 93.7)


  📋 剩余模型
  #11 common_q4_nbits.onnx             score= 91.6 charAcc= 91.4% avgMs=  10.7
  #12 common_q8_static_full_entropy.onnx score= 91.5 charAcc= 90.7% avgMs=   5.8
  #13 common_q8_static_percentile.onnx score= 91.2 charAcc= 91.3% avgMs=   6.5
  #14 common_q4_nbits_opt.onnx         score= 90.7 charAcc= 91.4% avgMs=  11.3
  #15 common_q4_nbits_b128.onnx        score= 89.6 charAcc= 89.7% avgMs=  10.9
  #16 common_fp16_opt.onnx             score= 88.3 charAcc= 90.8% avgMs=   7.6
  #17 common_fp16_mixed.onnx           score= 88.2 charAcc= 90.8% avgMs=   7.4
  #18 common_fp16.onnx                 score= 87.1 charAcc= 90.8% avgMs=   7.6
  #19 common_opt_extended.onnx         score= 84.8 charAcc= 90.8% avgMs=   7.3
  #20 common_opt_device.onnx           score= 84.3 charAcc= 90.8% avgMs=   7.2
  #21 common_opt_basic.onnx            score= 83.7 charAcc= 90.8% avgMs=   7.4
  #22 common_q4_nbits_asym.onnx        score= 81.8 charAcc= 91.4% avgMs=  11.7
  #23 common.onnx                      score= 79.9 charAcc= 90.8% avgMs=   7.2
  #24 common_q8_speed_opt.onnx         score= 76.5 charAcc= 96.4% avgMs=  33.6
  #25 common_q8_speed.onnx             score= 76.3 charAcc= 96.4% avgMs=  33.6
  #26 common_q8_full_qdq.onnx          score= 75.0 charAcc= 96.4% avgMs=  33.7
  #27 common_q8_aggressive.onnx        score= 74.7 charAcc= 95.9% avgMs=  33.6
```

## Todolist

- [x] 新增浏览器扩展
- [x] 添加更多设置选项
- [x] 适配vue/react等前端框架
- [x] 修正脚本执行顺序，实现模块化
- [x] 适配动态生成的弹窗中的验证码
- [x] 适配火狐浏览器扩展
- [x] 对DDDDOCR模型进行量化，减少模型体积
- [ ] 排查修复潜在的安全漏洞
- [x] 新增支持自定义排除元素关键字
- [x] 优化浏览器扩展UI设计

## 📝 许可

本项目沿用原项目 [ddddocr](https://github.com/sml2h3/ddddocr) 的许可证[MIT License](./LICENSE)

## 更新日志

- V1.1.4
- 添加量化模型，模型体积减少约48%，量化项目还有待优化，暂时不开源，模型可以在models文件夹中下载
- 针对浏览器扩展版本新增网站黑名单，不需要识别的网站不会再触发识别
- 新增规则自定义（高级功能），除非你知道你在干什么，否则内置的规则够用了
- 修复任意网站非验证码触发识别的bug

- V1.1.3
  - 修复验证码存在连续字符时会被过滤的bug
  - 优化验证码元素组件识别逻辑
  - 优化浏览器扩展UI，美化样式
  - 优化移动端浏览器扩展UI

- V1.1.2
  - 修复部分站点登录弹窗无法识别验证码的bug
  - 修复部分站点验证码输入框错误识别的bug
  - 修复调试模式没有日志的bug
  - 新增元素猜测功能，选择验证码元素后，程序会尝试猜测验证码输入框元素，反之亦然
  - 新增用户协议自动勾选用户协议/隐私协议功能
  - 新增识别统计功能
  - 完善保存的网站规则，支持单个域名多个路由规则
  - 优化油猴脚本UI布局，删除emoji
  - 优化输入框识别逻辑，增强识别率

- V1.1.1
  - 修复单页面多个验证码只能识别一个的bug
  - 新增四则运算验证码识别后自动计算结果的支持
  - 新增打字机效果开启/关闭支持
  - 新增浏览器通知开关（后续版本可能简化或删除）
  - 尝试修复vue/react等前端框架的兼容性问题(beta)

- V1.1.0
  - 重构部分核心，使项目兼容浏览器扩展
  - 优化自定义选择器，（可能）支持更多的的验证码场景识别
  - 新增浏览器扩展版本，目前只对Chrome系列支持，火狐家族暂时不支持

- V1.0.2-beta
  - 修复首次加载没有等待验证码加载完毕就开始识别的bug
  - 修改wasm CDN为[cdnjs.cloudflare.com](https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.17.0/ort.min.js)，提高兼容性
  - 优化代码逻辑，提高可读性

- V1.0.1
  - 修复在任何站点都加载模型的bug
  - 修复程序逻辑，优先加载操作菜单
  - 新增离线上传模型功能
  - 新增更多类别验证码识别支持

- V1.0.0
  - 初版发布
  - 支持ONNX Runtime Web在浏览器中识别验证码

## 📄 鸣谢

- [ddddocr](https://github.com/sml2h3/ddddocr) - 原项目
- [ddddocr-js](https://github.com/J3n5en/ddddocr-js) - JavaScript移植原版项目
- [onnxruntime-web](https://github.com/microsoft/onnxruntime-web) - 模型推理
- [ICON-ICONS](https://icon-icons.com/zh) - 项目图标出处

## 常见问题

### Q：为什么识别不准确？

A：识别准确率是由模型决定的，如需定制，请自行使用DDDDOCR模型训练项目训练专属模型

### Q：为什么识别速度很慢？

A：这很有可能是浏览器的问题，Chrome系浏览器建议使用浏览器扩展，火狐系浏览器不会存在这个问题

### Q：这样的验证码可以识别吗？

A：详见第一条QA

### Q:能不能识别并计算四则运算验证码？

A：可以的，但是需要设置

### Q:是否支持拖拽，点选验证码？

A：本项目目前只支持纯文字验证码识别，拖拽，点选后期可能会考虑支持，但是我由于上班，维护项目的时间并不多，所有可能遥遥无期。

## 小声喵喵

使用AI开发很好，很快，但是实际上，提示词写了又写，代码写了又回滚写了又回滚。基本上要写很久才会有让我满意的代码产出，毕竟AI的代码产出不是很稳定，可能这一次很好，下一次就不好。反正肯定是要跟AI斗智斗勇，如果直接使用，那么项目基本上会乱七八糟的。

我是干运维的，我也比较懒，这个项目是出于方便运维使用而开发的小玩具，最早的版本其实是油猴脚本都是自己在用。后来发现还是有很多人需要就改造了，最开始没考虑啥安全性什么的，但是用的人多了，这方面后续会跟进。大家有啥意见或者建议可以在项目中提交issue或者PR，我看到会处理。

如果觉得这个项目不错，可以给我点个star，鼓励一下，你的star就是我更新的动力🤗

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=MakotoArai-CN/ddddocr-webjs&type=date&legend=top-left)](https://www.star-history.com/#MakotoArai-CN/ddddocr-webjs&type=date&legend=top-left)
