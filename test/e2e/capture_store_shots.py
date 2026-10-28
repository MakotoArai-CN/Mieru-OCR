#!/usr/bin/env python3
"""生成商店上架用截图（Chrome / Edge / Firefox 通用）。

用法：
    bun run build:extension
    pip install playwright && playwright install chromium
    python test/e2e/capture_store_shots.py

输出到 docs/store/screenshots/：
    options-general.png   1280x800  基本设置
    options-models.png    1280x800  模型管理
    options-mobile.png    420x780   移动端布局
    popup.png             320x460   弹窗
    login-demo.png        1280x800  登录页自动填充验证码
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extension_smoke import (  # noqa: E402
    build_pages,
    free_port,
    launch_extension,
    serve,
    wait_stable_value,
)

from playwright.sync_api import sync_playwright  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs" / "store" / "screenshots"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    port_a, port_b = free_port(), free_port()
    origin_a = f"http://127.0.0.1:{port_a}"
    build_pages(f"http://127.0.0.1:{port_b}")
    serve(port_a)
    serve(port_b)

    with sync_playwright() as playwright:
        context, worker = launch_extension(playwright, tempfile.mkdtemp(prefix="shots-"))
        options_url = worker.evaluate("() => chrome.runtime.getURL('options.html')")
        popup_url = worker.evaluate("() => chrome.runtime.getURL('popup.html')")

        # 桌面端设置页：基本设置 / 模型管理
        page = context.new_page()
        page.set_viewport_size({"width": 1280, "height": 800})
        page.goto(options_url, wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUT / "options-general.png"))

        page.click('[data-section="models"]')
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / "options-models.png"))

        # 移动端布局
        page.set_viewport_size({"width": 420, "height": 780})
        page.click('[data-section="general"]')
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "options-mobile.png"))
        page.close()

        # 弹窗
        popup = context.new_page()
        popup.set_viewport_size({"width": 360, "height": 520})
        popup.goto(popup_url, wait_until="domcontentloaded")
        popup.wait_for_timeout(1000)
        popup.screenshot(path=str(OUT / "popup.png"))
        popup.close()

        # 登录页：等自动填充完成后截图
        demo = context.new_page()
        demo.set_viewport_size({"width": 1280, "height": 800})
        demo.goto(f"{origin_a}/login", wait_until="domcontentloaded")
        demo.bring_to_front()
        wait_stable_value(demo, "#captcha", 60)
        demo.wait_for_timeout(400)
        demo.screenshot(path=str(OUT / "login-demo.png"))
        demo.close()

        context.close()

    for shot in sorted(OUT.glob("*.png")):
        print(f"{shot.name}: {shot.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
