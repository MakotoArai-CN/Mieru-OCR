#!/usr/bin/env python3
"""
Mieru-OCR Firefox MV3 端到端测试（真 Firefox + 未打包扩展）。

Playwright 的 Firefox 不支持加载扩展，所以这里用 Selenium + geckodriver 安装
临时扩展（temporary add-on），复用 `extension_smoke.py` 里的迷你后端与测试页。

覆盖：
  * MV3 背景页（background.scripts 经典脚本 + ort.min.js）能正常启动并跑 OCR
  * 真实登录页：自动填充验证码、自动勾选协议、不污染其它输入
  * 失败换图重试直到登录成功
  * 站点规则驱动的拼图滑块自动拖拽（通过扩展 options 页写入 siteRules）

前置：
  1. `bun run build:firefox`
  2. `pip install selenium`
  3. geckodriver（可用环境变量 MIERU_GECKODRIVER 指定，或放在 PATH）
     下载：https://github.com/mozilla/geckodriver/releases
  4. 一个 Firefox 可执行文件（MIERU_FIREFOX，默认取 Playwright 缓存里的 firefox）

用法：
  python test/e2e/firefox_smoke.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extension_smoke import (  # noqa: E402
    ALPHABET,
    DIST,
    STATE,
    build_pages,
    captcha_truth,
    free_port,
    serve,
)

from selenium import webdriver  # noqa: E402
from selenium.webdriver.common.by import By  # noqa: E402
from selenium.webdriver.firefox.options import Options  # noqa: E402
from selenium.webdriver.firefox.service import Service  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
FIREFOX_DIST = REPO / "dist" / "firefox"


def ffs_repo() -> Path:
    return Path(__file__).resolve().parents[2]


def find_firefox() -> str:
    env = os.environ.get("MIERU_FIREFOX")
    if env and Path(env).exists():
        return env
    root = Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
    candidates = sorted(root.glob("firefox-*/firefox/firefox.exe"), reverse=True)
    if candidates:
        return str(candidates[0])
    raise RuntimeError("找不到 Firefox：请设置 MIERU_FIREFOX 指向 firefox.exe")


def find_geckodriver() -> str:
    env = os.environ.get("MIERU_GECKODRIVER")
    if env and Path(env).exists():
        return env
    for candidate in (
        Path(os.environ.get("TEMP", "")) / "gecko" / "geckodriver.exe",
        REPO / "node_modules" / ".bin" / "geckodriver.exe",
    ):
        if candidate.exists():
            return str(candidate)
    raise RuntimeError("找不到 geckodriver：请设置 MIERU_GECKODRIVER 或放到 PATH")


def wait_value(driver, selector: str, timeout: float, settle: float = 1.0) -> str:
    """等待输入框被填充且稳定（自动填充是逐字符写入的）。"""
    deadline = time.time() + timeout
    last, since = None, 0.0
    while time.time() < deadline:
        try:
            value = driver.find_element(By.CSS_SELECTOR, selector).get_attribute("value") or ""
        except Exception:  # noqa: BLE001
            value = ""
        if value.strip():
            if value == last:
                if since and time.time() - since >= settle:
                    return value
            else:
                last, since = value, time.time()
        else:
            last, since = None, 0.0
        time.sleep(0.15)
    raise AssertionError(f"{selector} 未在 {timeout}s 内被填充（最后值={last!r}）")


def extension_uuid(driver) -> str:
    profile = driver.capabilities.get("moz:profile")
    assert profile, "拿不到 Firefox profile 路径"
    prefs = Path(profile) / "prefs.js"
    text = prefs.read_text(encoding="utf-8", errors="ignore")
    match = re.search(r'extensions\.webextensions\.uuids",\s*"(.*?)"\);', text)
    assert match, "prefs.js 里找不到扩展 UUID"
    mapping = json.loads(match.group(1).replace('\\"', '"'))
    assert "Mieru-OCR@makotoarai" in mapping, f"UUID 映射里没有本扩展: {mapping}"
    return mapping["Mieru-OCR@makotoarai"]



def install_det_model(driver, origin_a: str) -> None:
    """Firefox 下用 WebDriver 给 <input type=file> 塞 20MB 文件后，页面读 arrayBuffer 会挂起
    （Marionette 的 file 注入限制）。这里改成从测试后端拉模型字节，按产品同样的结构
    写入 IndexedDB + storage.local，等价于「已上传」状态。"""
    driver.get(f"moz-extension://{extension_uuid(driver)}/options.html")
    time.sleep(0.8)
    driver.set_script_timeout(60)
    result = driver.execute_async_script(
        """
        const origin = arguments[0];
        const done = arguments[arguments.length - 1];
        fetch(origin + '/__model').then((r) => r.arrayBuffer()).then((buf) => new Promise((resolve, reject) => {
            const req = indexedDB.open('DdddOCRExtensionModels');
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('models')) db.createObjectStore('models', { keyPath: 'id' });
            };
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction(['models'], 'readwrite');
                const complete = new Promise((res, rej) => {
                    tx.oncomplete = () => res(true);
                    tx.onerror = () => rej(tx.error);
                    tx.onabort = () => rej(tx.error);
                });
                tx.objectStore('models').put({ id: '__det__', modelBlob: buf, charsets: [] });
                complete.then(() => resolve({ size: buf.byteLength }));
            };
            req.onerror = () => reject(req.error);
        })).then((info) => browser.storage.local.set({
            detModelMeta: { source: 'uploaded', name: 'common_det.onnx', size: info.size, savedAt: Date.now() },
        }).then(() => done('ok'))).catch((e) => done('err:' + (e && e.message || e)));
        """,
        origin_a,
    )
    assert result == "ok", f"检测模型写入失败: {result}"


def set_site_rule(driver, uuid: str, origin_a: str, rule: dict) -> None:
    """通过扩展 options 页写入 siteRules（MV3 里 background 无法从页面直接访问）。"""
    driver.get(f"moz-extension://{uuid}/options.html")
    time.sleep(1.0)
    channel = driver.execute_script("return typeof browser !== 'undefined' ? 'browser' : (typeof chrome !== 'undefined' ? 'chrome' : 'none')")
    assert channel != "none", "扩展页里拿不到 browser/chrome API"
    result = driver.execute_async_script(
        """
        const done = arguments[arguments.length - 1];
        const url = arguments[0], rule = arguments[1];
        const api = typeof browser !== 'undefined' ? browser : chrome;
        api.storage.local.get('siteRules').then((data) => {
            const rules = data.siteRules || {};
            rules[url] = rule;
            return api.storage.local.set({ siteRules: rules });
        }).then(() => done('ok')).catch((e) => done('err: ' + (e && e.message || e)));
        """,
        f"{origin_a}{rule.pop('_path')}",
        rule,
    )
    assert result == "ok", f"写入站点规则失败: {result}"


RESULTS: list[tuple[str, bool, str]] = []


def run_case(name: str, func) -> None:
    started = time.time()
    try:
        detail = func() or ""
        RESULTS.append((name, True, f"{detail} ({time.time() - started:.1f}s)"))
        print(f"[PASS] {name}: {detail}")
    except Exception as exc:  # noqa: BLE001
        RESULTS.append((name, False, str(exc)))
        print(f"[FAIL] {name}: {exc}")
        traceback.print_exc()


def main() -> int:
    if not (FIREFOX_DIST / "manifest.json").exists():
        print("缺少 dist/firefox，请先运行 bun run build:firefox", file=sys.stderr)
        return 2
    manifest = json.loads((FIREFOX_DIST / "manifest.json").read_text(encoding="utf-8"))
    assert manifest.get("manifest_version") == 3, "这个脚本测的是 MV3 构建"

    port_a, port_b = free_port(), free_port()
    origin_a, origin_b = f"http://127.0.0.1:{port_a}", f"http://127.0.0.1:{port_b}"
    build_pages(origin_b)
    serve(port_a)
    serve(port_b)
    print(f"[setup] app={origin_a} image={origin_b}")

    options = Options()
    options.binary_location = find_firefox()
    options.set_preference("xpinstall.signatures.required", False)
    options.set_preference("extensions.autoDisableScopes", 0)
    options.set_preference("extensions.installDistroAddons", False)
    options.set_preference("devtools.console.stdout.content", True)
    service = Service(executable_path=find_geckodriver(), log_output=os.path.join(os.environ.get("TEMP", ""), "geckodriver.log"))
    driver = webdriver.Firefox(service=service, options=options)
    print(f"[setup] Firefox {driver.capabilities.get('browserVersion')}")
    try:
        driver.install_addon(str(FIREFOX_DIST), temporary=True)
        print("[setup] 扩展已安装（temporary add-on）")
        time.sleep(1.5)
        uuid = extension_uuid(driver)
        print(f"[setup] extension uuid={uuid}")

        def case_login():
            driver.get(f"{origin_a}/login?redirect=%2Fdashboard")
            time.sleep(1.2)
            account = driver.find_element(By.ID, "account").get_attribute("value")
            password = driver.find_element(By.ID, "password").get_attribute("value")
            assert account == "demo.user@example.com", f"账号被改写: {account!r}"
            assert password == "P@ssw0rd", f"密码被改写: {password!r}"
            assert driver.find_element(By.ID, "sms-code").get_attribute("value") == "", "短信验证码被误填"
            assert driver.find_element(By.ID, "site-search").get_attribute("value") == "", "搜索框被误填"
            assert driver.find_element(By.ID, "agree").is_selected(), "协议未自动勾选"
            assert not driver.find_element(By.ID, "remember").is_selected(), "免登录被误勾"

            hits = []
            for attempt in range(1, 7):
                value = wait_value(driver, "#captcha", 90)
                truth = captcha_truth(int(driver.execute_script("return window.__state.id")))
                hit = value.strip().upper() == truth.upper()
                hits.append("hit" if hit else f"miss({value}!={truth})")
                driver.find_element(By.ID, "submit-login").click()
                time.sleep(1.0)
                if driver.execute_script("return window.__state.success"):
                    return f"第 {attempt} 次登录成功；识别={hits}"
            raise AssertionError(f"6 次内未登录成功: {hits}")

        run_case("login: MV3 背景页 OCR + 登录链路", case_login)

        def case_slider():
            set_site_rule(driver, uuid, origin_a, {
                "_path": "/slider",
                "hostname": "127.0.0.1",
                "selector": "#slider-box",
                "subType": "slider",
                "dragProfile": "fast",
                "fullUrl": f"{origin_a}/slider",
                "enabled": True,
                "createdAt": int(time.time() * 1000),
                "updatedAt": int(time.time() * 1000),
            })
            rows = []
            for query, label in (
                ("", "圆形"),
                ("?variant=jigsaw", "凹弧"),
                ("?variant=blur", "模糊"),
                ("?variant=scrambled", "背景重排"),
                ("?late=1", "拼图晚加载"),
            ):
                driver.get(f"{origin_a}/slider{query}")
                deadline = time.time() + 30
                result = None
                while time.time() < deadline:
                    result = driver.execute_script(
                        "return window.__state && window.__state.result ? "
                        "{ result: window.__state.result, gap: window.__state.gap, "
                        "  dragX: window.__state.dragX, truth: window.__state.gapX } : null"
                    )
                    if result:
                        break
                    time.sleep(0.3)
                assert result, f"{label}：30s 内没有触发拖拽"
                assert result["result"] == "success", f"{label} 落点失败: {result}"
                rows.append(f"{label} 偏差 {result['gap']}px")
            return "；".join(rows)
        run_case("slider: MV3 背景页 Worker 匹配 + 真实拖拽（含变体）", case_slider)

        def case_clickselect():
            # 1) 安装检测模型（见 install_det_model 注释）
            install_det_model(driver, origin_a)

            # 2) 站点规则
            set_site_rule(driver, uuid, origin_a, {
                "_path": "/click",
                "hostname": "127.0.0.1",
                "selector": "#click-box",
                "subType": "click-select",
                "fullUrl": f"{origin_a}/click",
                "enabled": True,
                "createdAt": int(time.time() * 1000),
                "updatedAt": int(time.time() * 1000),
            })

            # 3) 页面
            driver.get(f"{origin_a}/click")
            deadline = time.time() + 60
            state = None
            while time.time() < deadline:
                state = driver.execute_script(
                    "return window.__state && window.__state.result ? "
                    "{ result: window.__state.result, expected: window.__state.expected, "
                    "  detail: window.__state.detail } : null"
                )
                if state:
                    break
                time.sleep(0.3)
            assert state, "60s 内没有完成点选"
            assert state["result"] == "success", f"点选顺序错误: {state}"
            return f"题序 {''.join(state['expected'])} 全部点中"

        run_case("clickselect: 文字点选按题序自动点击", case_clickselect)

    finally:
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass

    print("\n===== 汇总 =====")
    failed = [name for name, ok, _ in RESULTS if not ok]
    for name, ok, detail in RESULTS:
        print(f"{'PASS' if ok else 'FAIL'}  {name}  —  {detail}")
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
