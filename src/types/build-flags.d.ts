/**
 * 构建期注入的全局常量。
 *
 * 由三个 vite 配置的 `define` 提供；content script 还会经 esbuild 二次编译
 * （见 vite.config.*.ts 的 bundleContentScript），那道编译**不继承** vite 的
 * define，必须单独注入——漏掉会在运行时抛 ReferenceError 且构建无警告。
 */
declare const __FIREFOX__: boolean;
