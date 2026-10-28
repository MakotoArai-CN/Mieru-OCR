# Firefox for Android 验收清单

manifest 已声明 `browser_specific_settings.gecko_android.strict_min_version = 142.0`。
Fenix 不渲染 `action` popup，扩展在 Android 上会：

1. `runtime.getPlatformInfo()` 返回 `os === 'android'`；
2. 调用 `action.setPopup({ popup: '' })` 清空 popup；
3. 点击工具栏图标时触发 `action.onClicked` → 打开设置页（`options_ui.open_in_tab`）。

> 目前**只有桌面端自动化证据**（Windows Firefox 148 + Selenium）。以下清单需在真机执行一次。

## 1. 安装与启动

- [ ] 通过 `about:addons` → 从文件安装 XPI（或 AMO 测试渠道）
- [ ] 扩展出现在 Fenix 的「扩展」菜单中，图标正常（48/96px）
- [ ] 首次安装不会崩溃；后台页面（`background.scripts`）能启动

## 2. 图标与设置入口

- [ ] 点击扩展图标直接打开设置页（不应出现空白 popup）
- [ ] 设置页在竖屏下可正常滚动，保存按钮固定在右下角、不被底部导航遮挡
- [ ] 语言切换（中/日/英）后布局不错位

## 3. 识别（图片验证码）

- [ ] 打开任意带图片验证码的页面，2s 内自动填充
- [ ] 横屏/竖屏旋转后仍能识别
- [ ] 弱网/离线时：内置模型仍可识别（不依赖网络）

## 4. 滑块（若站点有规则）

- [ ] 站点规则命中后拖拽生效，落点误差 ≤ 8px
- [ ] 触屏拖拽时页面不误触发滚动/缩放

## 5. 内存与电量

- [ ] 首次识别后进程内存增量可接受（模型 ~29MB，WASM 堆另计）
- [ ] 后台空闲 10 分钟后不被系统杀死到无法唤醒（Fenix 可能回收，重新打开页面应自动恢复）

## 6. 已知限制（需在商店描述中说明）

- Android 上**没有弹窗**：站点规则的选择需要桌面端完成，或手动在设置页填写选择器
- 部分站点对 `isTrusted=false` 的合成事件有风控，滑块/点选可能被拒
- `contextMenus`、`commands` 在 Android 上不可用

## 记录

| 日期 | 设备 / Fenix 版本 | 结果 | 备注 |
|---|---|---|---|
| — | — | 待测 | — |
