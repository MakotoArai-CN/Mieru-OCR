#!/usr/bin/env python3
"""
Mieru-OCR 真实业务场景 e2e（真 Chromium + 未打包扩展 + 迷你后端）。

与「画个 canvas 填个 input」的冒烟测试不同，这里模拟的是一套电商/后台风格的真实登录链路：

  * 页面：Header + 搜索框 + 登录卡片 + 营销 banner + logo/头像/二维码装饰图 + 隐藏验证码图，
    验证码输入框在 .ant-form-item / .ant-input-group 这类框架壳里，另有短信验证码、
    手机号/邮箱、密码等干扰输入框。
  * 验证码：由后端用 captcha（Pillow）库现生成（随机字体 + 干扰线 + 噪点 + 扭曲），
    以 PNG 下发；真值只存在服务端（页面拿不到），校验**不区分大小写**（真实站点的常见约定）。
  * 链路：自动勾选协议 → 自动识别并填充 → 用户点登录 → 后端校验 → 失败则换一张新验证码
    （img.src 变化）→ 扩展需重新识别填充 → 直到登录成功。这条「失败换图重试」是真实业务里
    最容易踩坏的路径。
  * 附加场景：SPA 整块重渲染后继续工作（规则 + isConnected 清理）、跨域图床（无 CORS 头）、
    懒加载组件的站点规则重试、iframe 内嵌登录框的右键识别、设置热更新、模型降级提示、
    导入配置不误删订阅。

运行前提：
  1. `bun run build:extension`
  2. `pip install playwright && playwright install chromium`（本地/发版前回归，不进 CI）

用法：
  python test/e2e/extension_smoke.py              # 全部
  python test/e2e/extension_smoke.py login        # 只跑名字含 login 的用例
"""

from __future__ import annotations

import base64
import json
import os
import random
import socket
import sys
import secrets
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

REPO = Path(__file__).resolve().parents[2]
DIST = REPO / "dist" / "extension"

ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
# 真实验证码生成：captcha（Pillow）库 + 常见无衬线字体
_IMAGE_CAPTCHA = None
FONT_CANDIDATES = [
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "arial.ttf",
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "calibri.ttf",
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
]
PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

STATE: dict = {
    "pool": {},       # id -> {"code": str, "png": bytes}，后端用 captcha 库生成
    "next": 0,        # 下一个验证码 id
    "cross": None,    # 跨域图床样张（懒生成）
    "logins": [],     # 每次登录尝试的 [{id, captcha, ok}]
    "sliders": {},    # token -> 真值 gapX
    "slider_tries": 0,
    "slider_token": 0,
}

# 真实感验证码：与 test/index.html 的 createCaptchaDataUrl 同款（彩色/旋转/噪点/渐变底）
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静音
        pass

    # ── 工具 ──────────────────────────────────────────────────────────────
    def _respond(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, payload: dict):
        self._respond(code, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    # ── 路由 ──────────────────────────────────────────────────────────────
    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/login":
            body = self._read_json()
            entry = STATE["pool"].get(int(body.get("id", -1))) if body.get("id") is not None else None
            guess = str(body.get("captcha", ""))
            # 真实站点常见约定：验证码不区分大小写
            ok = bool(entry) and guess.strip().upper() == entry["code"].upper()
            STATE["logins"].append({"id": body.get("id"), "captcha": guess, "ok": ok})
            if ok:
                self._json(200, {"ok": True})
            else:
                self._json(200, {"ok": False, "reason": "captcha", "nextId": self._issue()})
            return
        if path == "/api/slider/new":
            body = self._read_json()
            STATE["slider_token"] += 1
            token = f"s{STATE['slider_token']}"
            STATE["sliders"][token] = float(body.get("x", 0))
            self._json(200, {"token": token})
            return
        if path == "/api/click/verify":
            body = self._read_json()
            entry = CLICK_POOL.get(int(body.get("id", 0)))
            if not entry:
                self._json(404, {"ok": False, "error": "unknown id"})
                return
            clicked = []
            for click in body.get("clicks", []):
                cx, cy = float(click.get("x", -1)), float(click.get("y", -1))
                nearest = None
                best = 45.0
                for pos in entry["positions"]:
                    dist = ((pos["x"] - cx) ** 2 + (pos["y"] - cy) ** 2) ** 0.5
                    if dist < best:
                        best = dist
                        nearest = pos["char"]
                clicked.append(nearest or "?")
            self._json(200, {
                "ok": clicked == entry["order"],
                "clicked": clicked,
                "expected": entry["order"],
            })
            return
        if path == "/api/slider/verify":
            body = self._read_json()
            truth = STATE["sliders"].get(str(body.get("token")))
            if truth is None:
                self._json(404, {"ok": False, "error": "unknown token"})
                return
            STATE["slider_tries"] += 1
            gap = abs(float(body.get("x", -1)) - truth)
            # 真实滑块一般有 3~8px 容差
            ok = gap <= 6
            self._json(200, {"ok": ok, "truth": truth, "gap": round(gap, 1)})
            return
        self._respond(404, b"not found", "text/plain")

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        if path == "/api/captcha":
            self._json(200, {"id": self._issue()})
            return
        if path == "/api/click":
            item = make_click_captcha()
            self._json(200, {"id": item["id"], "prompt": item["prompt"]})
            return
        if path == "/api/click.png":
            cid = int((query.get("id") or ["0"])[0])
            entry = CLICK_POOL.get(cid)
            if not entry:
                self._respond(404, b"no click captcha", "text/plain")
                return
            self._respond(200, entry["png"], "image/png")
            return
        if path == "/api/captcha.png":
            idx = int((query.get("id") or ["0"])[0])
            entry = STATE["pool"].get(idx)
            if not entry:
                self._respond(404, b"no captcha", "text/plain")
                return
            self._respond(200, entry["png"], "image/png")
            return
        if path in ("/captcha.png", "/img/captcha.png"):
            # 跨域图床样张：懒生成，故意不带 Access-Control-Allow-Origin
            self._respond(200, ensure_cross_image()["png"], "image/png")
            return
        if path == "/__model":
            model = REPO / "public" / "common_det.onnx"
            if not model.exists():
                self._respond(404, b"no model", "text/plain")
                return
            self._respond(200, model.read_bytes(), "application/octet-stream")
            return
        if path.startswith("/assets/"):
            # logo / banner / avatar / 二维码等装饰图：1x1 灰点即可，只用来制造干扰噪声
            self._respond(200, PIXEL_PNG, "image/png")
            return
        page = PAGES.get("/login" if path == "/" else path)
        if page is None:
            self._respond(404, b"not found", "text/plain")
            return
        self._respond(200, page.encode("utf-8"), "text/html; charset=utf-8")

    @staticmethod
    def _issue() -> int:
        # 每次请求都由后端用真实验证码库现生成一张，页面端永远拿不到答案。
        STATE["next"] += 1
        cid = STATE["next"]
        STATE["pool"][cid] = make_captcha()
        return cid


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


# ── 页面 ────────────────────────────────────────────────────────────────────

LOGIN_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>星屿商城 · 账号登录</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  header { display: flex; align-items: center; gap: 24px; padding: 14px 32px; background: #fff;
           box-shadow: 0 1px 0 rgba(0,0,0,.06); }
  nav a { margin-right: 18px; color: #646a73; text-decoration: none; font-size: 14px; }
  .search { margin-left: auto; display: flex; gap: 8px; }
  .search input { width: 220px; padding: 8px 12px; border: 1px solid #dcdfe6; border-radius: 6px; }
  main { display: flex; gap: 48px; justify-content: center; align-items: flex-start; padding: 48px 32px; }
  .promo { display: flex; flex-direction: column; gap: 16px; }
  .login-card { width: 420px; background: #fff; border-radius: 12px; padding: 28px 28px 20px;
                box-shadow: 0 8px 30px rgba(31,35,41,.08); }
  h1 { margin: 0 0 20px; font-size: 22px; }
  .ant-form-item { margin-bottom: 16px; }
  .ant-form-item > label { display: block; font-size: 13px; color: #646a73; margin-bottom: 6px; }
  .ant-input, .ant-input-group input { width: 100%; padding: 9px 12px; font-size: 14px;
                border: 1px solid #dcdfe6; border-radius: 6px; }
  .ant-input-group { display: flex; gap: 10px; align-items: center; }
  .ant-input-group input { flex: 1; }
  .captcha-image { border-radius: 4px; cursor: pointer; }
  .link-btn { background: none; border: 0; color: #3370ff; cursor: pointer; font-size: 13px; padding: 0; }
  .agree, .remember { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #646a73;
                      margin: 10px 0; }
  button[type=submit] { width: 100%; margin-top: 8px; padding: 11px; border: 0; border-radius: 6px;
                        background: #3370ff; color: #fff; font-size: 15px; cursor: pointer; }
  #msg { min-height: 20px; font-size: 13px; margin: 10px 0 0; }
  #msg[data-state=error] { color: #f54a45; }
  #msg[data-state=success] { color: #34c724; }
  .logout-decor { position: fixed; right: 24px; bottom: 24px; display: flex; gap: 12px; align-items: end; }
  #hidden-captcha { display: none; }
</style>
</head>
<body>
<header>
  <img src="/assets/logo.png" class="logo" width="132" height="32" alt="星屿商城">
  <nav><a href="#">首页</a><a href="#">产品中心</a><a href="#">解决方案</a><a href="#">帮助文档</a></nav>
  <div class="search"><input id="site-search" name="q" placeholder="搜索产品 / 文档"><button>搜索</button></div>
</header>
<main>
  <aside class="promo">
    <img src="/assets/banner.png" class="banner" width="420" height="120" alt="双十一活动">
    <img src="/assets/avatar.png" class="avatar" width="48" height="48" alt="用户头像">
  </aside>
  <section class="login-card">
    <h1>账号登录</h1>
    <form id="login-form" novalidate autocomplete="off">
      <div class="ant-form-item">
        <label for="account">手机号 / 邮箱</label>
        <input id="account" class="ant-input" name="account" value="demo.user@example.com" autocomplete="username">
      </div>
      <div class="ant-form-item">
        <label for="password">密码</label>
        <input id="password" class="ant-input" type="password" name="password" value="P@ssw0rd">
      </div>
      <div class="ant-form-item">
        <label for="captcha">验证码</label>
        <div class="ant-input-group">
          <input id="captcha" class="ant-input" name="captcha" maxlength="6" autocomplete="off" placeholder="请输入验证码">
          <img id="captcha-img" class="captcha-image shadow-lg rounded" width="120" height="45" alt="captcha">
          <button type="button" id="refresh-captcha" class="link-btn">换一张</button>
        </div>
        <div style="font-size:12px;color:#8f959e;margin-top:4px">验证码不区分大小写</div>
      </div>
      <div class="ant-form-item">
        <label for="sms-code">短信验证码（可选）</label>
        <div class="ant-input-group">
          <input id="sms-code" class="ant-input" name="smsCode" placeholder="短信验证码">
          <button type="button" class="link-btn">获取验证码</button>
        </div>
      </div>
      <label class="agree"><input type="checkbox" id="agree"> 我已阅读并同意《用户协议》与《隐私政策》</label>
      <label class="remember"><input type="checkbox" id="remember"> 7 天内免登录</label>
      <button type="submit" id="submit-login">登录</button>
      <p id="msg" role="status"></p>
      <button type="button" id="rerender" class="link-btn">模拟会话过期（整块重渲染表单）</button>
    </form>
  </section>
</main>
<img id="hidden-captcha" class="captcha-image" src="/api/captcha.png?id=0" alt="captcha">
<img src="/assets/qrcode.png" class="qrcode icon" width="120" height="120" alt="扫码下载 App">
<div class="logout-decor"><img src="/assets/avatar.png" class="icon" width="24" height="24" alt="客服"></div>

<script>
const state = { id: null, attempts: 0, last: null, rerenders: 0, success: false };
window.__state = state;

function bindForm() {
  const form = document.getElementById('login-form');
  const input = document.getElementById('captcha');
  const img = document.getElementById('captcha-img');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.attempts += 1;
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.id, captcha: input.value }),
    });
    const data = await resp.json();
    state.last = data;
    const msg = document.getElementById('msg');
    if (data.ok) {
      state.success = true;
      msg.textContent = '登录成功，正在进入工作台…';
      msg.dataset.state = 'success';
    } else {
      msg.textContent = '验证码错误，请重试（已自动更换）';
      msg.dataset.state = 'error';
      input.value = '';
      state.id = data.nextId;
      img.src = '/api/captcha.png?id=' + data.nextId + '&t=' + Date.now();
    }
  });
  document.getElementById('refresh-captcha')?.addEventListener('click', refreshCaptcha);
  document.getElementById('rerender')?.addEventListener('click', () => {
    // 模拟 SPA 会话过期：整块替换表单 DOM（新节点、旧引用全部失效）
    state.rerenders += 1;
    const card = form.closest('.login-card');
    const clone = card.cloneNode(true);
    clone.querySelector('#msg').textContent = '';
    clone.querySelector('#msg').dataset.state = '';
    card.replaceWith(clone);
    bindForm();
    refreshCaptcha();
  });
}

async function refreshCaptcha() {
  const resp = await fetch('/api/captcha');
  const data = await resp.json();
  state.id = data.id;
  document.getElementById('captcha-img').src = '/api/captcha.png?id=' + data.id + '&t=' + Date.now();
}

bindForm();
refreshCaptcha();
</script>
</body></html>
"""

FRAME_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>客服登录</title>
<style>body{font-family:sans-serif;margin:16px}</style></head>
<body>
<p>合作方登录框（iframe）</p>
<form><label>验证码 <input id="inner-input" name="captcha"></label>
<img id="inner-img" class="captcha-image" width="120" height="45"></form>
<script>
  // 验证码由后端按需生成：先取 id，再加载图片
  fetch('/api/captcha').then((r) => r.json()).then((data) => {
    document.getElementById('inner-img').src = '/api/captcha.png?id=' + data.id;
  });
</script>
</body></html>
"""

RULE_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>懒加载组件</title>
<style>body{font-family:sans-serif;margin:24px} canvas{border:1px solid #ddd}</style>
</head><body>
<p>该验证码组件在弹窗打开后才渲染（模拟懒加载）</p>
<p><input id="late-input" name="q1"></p>
<button id="rerender" type="button">模拟会话过期（重渲染组件）</button>
<script>
  const state = { id: null, mounts: 0 };
  window.__state = state;
  async function mountCaptcha() {
    const resp = await fetch('/api/captcha');
    state.id = (await resp.json()).id;
    state.mounts += 1;
    document.getElementById('late-cap')?.remove();
    const img = document.createElement('img');
    img.id = 'late-cap';
    img.className = 'lazy-widget';
    img.width = 120;
    img.height = 45;
    img.src = '/api/captcha.png?id=' + state.id + '&t=' + Date.now();
    document.body.appendChild(img);
  }
  window.__mountCaptcha = mountCaptcha;
  setTimeout(mountCaptcha, 3000);
  document.getElementById('rerender').addEventListener('click', mountCaptcha);
</script>
</body></html>
"""

CROSS_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>跨域图床</title></head>
<body style="font-family:sans-serif;margin:24px">
<p>验证码图片来自独立图床（无 CORS 头）</p>
<img id="captcha-img" class="captcha-image" src="%ORIGIN_B%/captcha.png" width="120" height="45" alt="captcha">
<p><input id="captcha" name="captcha" placeholder="请输入验证码"></p>
</body></html>
"""

SLIDER_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>安全验证</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif; display: flex;
         justify-content: center; padding-top: 60px; background: #f7f8fa; }
  .verify-card { background: #fff; padding: 20px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.08); }
  .verify-slider { position: relative; width: 300px; user-select: none; }
  #slider-bg { display: block; border-radius: 6px; }
  #slider-piece { position: absolute; left: 0; top: 0; pointer-events: none; }
  .slider-bar { position: relative; height: 40px; margin-top: 14px; background: #eef1f6;
                border-radius: 6px; overflow: hidden; }
  .slider-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 40px; background: #cfe3ff; }
  .slider-btn { position: absolute; left: 0; top: 0; width: 40px; height: 40px; display: flex;
                align-items: center; justify-content: center; background: #3370ff; color: #fff;
                border-radius: 6px; cursor: grab; font-size: 18px; }
  #slider-msg { font-size: 13px; color: #646a73; margin: 10px 0; }
  #slider-reset { font-size: 12px; color: #3370ff; background: none; border: 0; cursor: pointer; padding: 0; }
</style>
</head><body>
<div class="verify-card">
  <div id="slider-box" class="verify-slider">
    <img id="slider-bg" width="300" height="150" alt="puzzle background">
    <img id="slider-piece" width="50" height="50" alt="puzzle piece">
    <div class="slider-bar">
      <div class="slider-fill" id="slider-fill"></div>
      <div id="slider-handle" class="slider-btn" draggable="false">➜</div>
    </div>
  </div>
  <p id="slider-msg">向右拖动滑块，让拼图对齐缺口</p>
  <button id="slider-reset" type="button">重新加载验证码</button>
</div>
<script>
  // 极验风格拼图滑块。?variant=jigsaw|blur|scrambled 切换拼图形态，
  // ?late=1 让拼图块的 src 晚 1.5s 才设置（回归"图片未加载完就取像素"的问题）。
  const W = 300, H = 150, S = 50, MAX = W - S;
  const params = new URLSearchParams(location.search);
  const variant = params.get('variant') || 'circle';
  // 背景重排场景用异形（带凹弧）而不是圆形：圆形轮廓和背景里的圆斑容易混淆，
  // 真实站点的拼图也多为异形。
  const shapeKind = (variant === 'jigsaw' || variant === 'scrambled') ? 'jigsaw' : 'circle';
  const latePiece = params.get('late') === '1';
  const state = { token: null, gapX: 0, dragX: 0, dragging: false, drags: 0, result: null, gap: null };
  window.__state = state;
  const bgImg = document.getElementById('slider-bg');
  const pieceImg = document.getElementById('slider-piece');
  const handle = document.getElementById('slider-handle');
  const fill = document.getElementById('slider-fill');
  const msg = document.getElementById('slider-msg');

  function shapePath(ctx, x, y, s) {
    ctx.beginPath();
    if (shapeKind === 'jigsaw') {
      // 方形 + 顶边一个凹进去的半圆（非圆形、带曲线轮廓）
      const r = s * 0.18;
      ctx.moveTo(x, y);
      ctx.lineTo(x + s / 2 - r, y);
      ctx.arc(x + s / 2, y, r, Math.PI, 0, false);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x + s, y + s);
      ctx.lineTo(x, y + s);
      ctx.closePath();
    } else {
      ctx.arc(x + s / 2, y + s / 2, s / 2 - 2, 0, Math.PI * 2);
    }
  }

  function paintBackground(seedRandom) {
    const bg = document.createElement('canvas');
    bg.width = W; bg.height = H;
    const b = bg.getContext('2d');
    const grad = b.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#0b1a33');
    grad.addColorStop(0.55, '#1f4e79');
    grad.addColorStop(1, '#7fb3d5');
    b.fillStyle = grad;
    b.fillRect(0, 0, W, H);
    for (let i = 0; i < 120; i++) {
      b.fillStyle = `hsla(${Math.floor(Math.random() * 360)}, ${60 + Math.random() * 35}%, ${25 + Math.random() * 55}%, ${0.65 + Math.random() * 0.3})`;
      const x = Math.random() * W;
      const y = Math.random() * H;
      const w = 6 + Math.random() * 42;
      const h = 6 + Math.random() * 36;
      if (Math.random() < 0.5) {
        b.fillRect(x, y, w, h);
      } else {
        b.beginPath();
        b.ellipse(x, y, w / 2, h / 2, Math.random() * 3.14, 0, Math.PI * 2);
        b.fill();
      }
    }
    for (let i = 0; i < 1200; i++) {
      b.fillStyle = `rgba(255,255,255,${Math.random() * 0.14})`;
      b.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    return bg;
  }

  function buildPuzzle() {
    const bg = paintBackground();
    const b = bg.getContext('2d');
    const gapX = 70 + Math.floor(Math.random() * (W - S - 120));
    const gapY = 15 + Math.floor(Math.random() * (H - S - 30));

    // 拼图块：从背景（或另一张图，模拟"背景被重排"）裁剪，按形状做 alpha 蒙版
    const source = variant === 'scrambled' ? paintBackground() : bg;
    const piece = document.createElement('canvas');
    piece.width = S; piece.height = S;
    const p = piece.getContext('2d');
    p.save();
    shapePath(p, 0, 0, S);
    p.clip();
    p.drawImage(source, gapX, gapY, S, S, 0, 0, S, S);
    p.restore();
    if (variant === 'blur') {
      const blurred = document.createElement('canvas');
      blurred.width = S; blurred.height = S;
      const bc = blurred.getContext('2d');
      bc.filter = 'blur(1.5px)';
      bc.drawImage(piece, 0, 0);
      var output = blurred;
    } else {
      var output = piece;
    }
    const mask = document.createElement('canvas');
    mask.width = S; mask.height = S;
    shapePath(mask.getContext('2d'), 0, 0, S);
    mask.getContext('2d').fill();

    const fin = document.createElement('canvas');
    fin.width = S; fin.height = S;
    const fc = fin.getContext('2d');
    fc.drawImage(output, 0, 0);
    fc.globalCompositeOperation = 'destination-in';
    fc.drawImage(mask, 0, 0);
    fc.globalCompositeOperation = 'source-over';
    fc.lineWidth = 3;
    fc.strokeStyle = 'rgba(255,255,255,.92)';
    shapePath(fc, 0, 0, S);
    fc.stroke();

    // 背景缺口：同形状描边
    b.save();
    b.lineWidth = 3;
    b.strokeStyle = 'rgba(255,255,255,.95)';
    b.shadowColor = 'rgba(0,0,0,.5)';
    b.shadowBlur = 6;
    shapePath(b, gapX, gapY, S);
    b.stroke();
    b.restore();

    bgImg.src = bg.toDataURL('image/png');
    const pieceSrc = fin.toDataURL('image/png');
    if (latePiece) {
      pieceImg.removeAttribute('src');
      window.setTimeout(() => { pieceImg.src = pieceSrc; }, 1500);
    } else {
      pieceImg.src = pieceSrc;
    }
    pieceImg.style.top = gapY + 'px';
    pieceImg.style.left = '0px';
    handle.style.left = '0px';
    fill.style.width = '40px';
    state.gapX = gapX; state.dragX = 0; state.drags = 0; state.result = null; state.gap = null;
    msg.textContent = '向右拖动滑块，让拼图对齐缺口';
    register();
  }

  async function register() {
    const resp = await fetch('/api/slider/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: state.gapX }),
    });
    state.token = (await resp.json()).token;
  }

  let startX = 0, startLeft = 0;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    state.dragging = true;
    state.drags += 1;
    startX = event.clientX;
    startLeft = state.dragX;
    try { handle.setPointerCapture(event.pointerId); } catch (e) { /* 合成事件可能没有真实 pointer */ }
  });
  function onMove(event) {
    if (!state.dragging) return;
    state.dragX = Math.max(0, Math.min(MAX, startLeft + (event.clientX - startX)));
    pieceImg.style.left = state.dragX + 'px';
    handle.style.left = state.dragX + 'px';
    fill.style.width = (state.dragX + 40) + 'px';
  }
  async function onUp() {
    if (!state.dragging) return;
    state.dragging = false;
    const resp = await fetch('/api/slider/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token, x: state.dragX }),
    });
    const data = await resp.json();
    state.result = data.ok ? 'success' : 'fail';
    state.gap = data.gap;
    msg.textContent = data.ok ? '验证通过' : `验证失败（偏差 ${data.gap}px）`;
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.getElementById('slider-reset').addEventListener('click', buildPuzzle);
  buildPuzzle();
</script>
</body></html>
"""

PAGES: dict[str, str] = {}


CLICK_CHARS = "春夏秋冬天地人山水火木金土"
_CLICK_ID = 0
CLICK_POOL: dict = {}


def make_click_captcha() -> dict:
    """生成一张文字点选验证码：4 个汉字随机散落，答案（点击顺序）只存在服务端。"""
    from PIL import Image, ImageDraw, ImageFont

    w, h = 300, 150
    img = Image.new("RGB", (w, h), (244, 247, 252))
    draw = ImageDraw.Draw(img)
    # 干扰线 + 噪点（低频，避免把字糊掉）
    for _ in range(6):
        draw.line(
            [(random.randint(0, w), random.randint(0, h)), (random.randint(0, w), random.randint(0, h))],
            fill=(200 + random.randint(0, 40), 205 + random.randint(0, 35), 215 + random.randint(0, 30)),
            width=1,
        )
    for _ in range(300):
        draw.point((random.randint(0, w), random.randint(0, h)), fill=(190, 196, 210))

    chars = random.sample(CLICK_CHARS, 4)
    font_path = next((f for f in (Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "msyh.ttc",
                                   Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "simhei.ttf",
                                   Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")) if f.exists()), None)
    assert font_path, "缺少中文字体（msyh.ttc / simhei.ttf）"
    font = ImageFont.truetype(str(font_path), 34)

    positions = []
    for i, ch in enumerate(chars):
        x = 18 + i * 70 + random.randint(-8, 8)
        y = 45 + random.randint(-18, 18)
        color = (random.randint(20, 70), random.randint(20, 70), random.randint(90, 160))
        draw.text((x, y), ch, font=font, fill=color)
        positions.append({"char": ch, "x": x + 17, "y": y + 20})

    import io

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    global _CLICK_ID
    _CLICK_ID += 1
    cid = _CLICK_ID
    CLICK_POOL[cid] = {"order": chars, "positions": positions, "png": buf.getvalue()}
    return {"id": cid, "prompt": "".join(chars), "png": buf.getvalue()}


CLICK_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>安全验证</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif; display: flex;
         justify-content: center; padding-top: 60px; background: #f7f8fa; }
  .click-card { background: #fff; padding: 20px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.08); }
  #click-prompt { font-size: 14px; color: #1f2329; margin: 0 0 12px; }
  #click-img { display: block; border-radius: 6px; cursor: pointer; }
  #click-msg { font-size: 13px; color: #646a73; margin: 10px 0 0; min-height: 18px; }
</style></head><body>
<div id="click-box" class="click-card">
  <p id="click-prompt">请依次点击：</p>
  <img id="click-img" width="300" height="150" alt="click captcha">
  <p id="click-msg"></p>
</div>
<script>
  const state = { id: null, result: null, clicks: [], expected: [], detail: null };
  window.__state = state;
  (async () => {
    const resp = await fetch('/api/click');
    const data = await resp.json();
    state.id = data.id;
    state.expected = data.prompt.split('');
    document.getElementById('click-prompt').textContent = '请依次点击：' + state.expected.join(' ');
    const img = document.getElementById('click-img');
    img.src = '/api/click.png?id=' + data.id;
    img.addEventListener('click', async (event) => {
      if (state.result !== null) return;
      const rect = img.getBoundingClientRect();
      const x = Math.round((event.clientX - rect.left) * (img.naturalWidth / rect.width));
      const y = Math.round((event.clientY - rect.top) * (img.naturalHeight / rect.height));
      state.clicks.push({ x, y });
      if (state.clicks.length < state.expected.length) return;
      const res = await fetch('/api/click/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.id, clicks: state.clicks }),
      });
      const verdict = await res.json();
      state.detail = verdict;
      state.result = verdict.ok ? 'success' : 'fail';
      document.getElementById('click-msg').textContent = verdict.ok
        ? '验证通过'
        : `失败：点击 ${verdict.clicked.join('')}，期望 ${verdict.expected.join('')}`;
    });
  })();
</script>
</body></html>
"""


def build_pages(origin_b: str) -> None:
    PAGES["/login"] = LOGIN_PAGE
    PAGES["/crossorigin"] = CROSS_PAGE.replace("%ORIGIN_B%", origin_b)
    PAGES["/slider"] = SLIDER_PAGE
    PAGES["/rule"] = RULE_PAGE
    PAGES["/click"] = CLICK_PAGE
    PAGES["/frame"] = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>合作方嵌入</title></head>
<body style="font-family:sans-serif;margin:24px">
<p>顶层页面</p>
<iframe id="partner-frame" src="/inner" width="460" height="200"></iframe>
</body></html>"""
    PAGES["/inner"] = FRAME_PAGE


# ── Playwright helpers ─────────────────────────────────────────────────────


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def serve(port: int) -> QuietServer:
    server = QuietServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def find_chromium() -> str | None:
    root = Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
    if not root.exists():
        return None
    candidates = sorted(root.glob("chromium-*/chrome-win64/chrome.exe"), key=lambda p: p.parent.parent.name, reverse=True)
    return str(candidates[0]) if candidates else None


def wait_for_extension(context, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if context.service_workers:
            return context.service_workers[0]
        time.sleep(0.25)
    raise RuntimeError("扩展 service worker 未启动（扩展可能未加载）")


def launch_extension(playwright, user_data: str):
    args = [f"--disable-extensions-except={DIST}", f"--load-extension={DIST}"]
    attempts = [{"headless": False}, {"headless": True, "channel": "chromium"}, {"headless": True}]
    executable = find_chromium()
    if executable:
        attempts.insert(0, {"headless": True, "executable_path": executable})
        attempts.append({"headless": False, "executable_path": executable})
    errors = []
    for kwargs in attempts:
        try:
            context = playwright.chromium.launch_persistent_context(
                user_data, args=args, viewport={"width": 1360, "height": 900}, **kwargs
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{kwargs}: {exc}")
            continue
        try:
            worker = wait_for_extension(context)
            print(f"[setup] 扩展已加载，SW={worker.url.split('/')[2]}，模式={kwargs}")
            return context, worker
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{kwargs}: {exc}")
            try:
                context.close()
            except Exception:  # noqa: BLE001
                pass
    raise RuntimeError("无法以任何模式加载扩展:\n" + "\n".join(errors))


def sw_eval(worker, expression: str, arg=None):
    return worker.evaluate(expression, arg) if arg is not None else worker.evaluate(expression)


def patch_settings(worker, patch: dict) -> dict:
    return sw_eval(
        worker,
        """async ([patch]) => {
            const current = (await chrome.storage.local.get('settings')).settings || {};
            const next = { ...current, ...patch };
            await chrome.storage.local.set({ settings: next });
            return next;
        }""",
        [patch],
    )


def wait_stable_value(page, selector: str, timeout: float, settle: float = 0.9) -> str:
    """等待输入框被填好并稳定（自动填充有打字机效果，逐字符写入）。"""
    deadline = time.time() + timeout
    last, since = None, 0.0
    while time.time() < deadline:
        try:
            value = page.eval_on_selector(selector, "el => el.value")
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
        time.sleep(0.12)
    raise AssertionError(f"{selector} 在 {timeout}s 内未被填充（最后值={last!r}）")


def console_collector(page, sink: list[str]):
    page.on("console", lambda m: sink.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda err: sink.append(f"pageerror: {err}"))


def make_captcha(code: str | None = None) -> dict:
    """用成熟的 captcha 库（Pillow）生成真实风格验证码，页面端只拿图片、拿不到答案。"""
    global _IMAGE_CAPTCHA
    if _IMAGE_CAPTCHA is None:
        from captcha.image import ImageCaptcha

        fonts = [str(f) for f in (FONT_CANDIDATES) if f.exists()]
        _IMAGE_CAPTCHA = ImageCaptcha(width=120, height=45, fonts=fonts) if fonts else ImageCaptcha(width=120, height=45)
    if code is None:
        code = "".join(secrets.choice(ALPHABET) for _ in range(4))
    data = _IMAGE_CAPTCHA.generate(code)
    return {"code": code, "png": data.getvalue()}


def ensure_cross_image() -> dict:
    """跨域图床样张：第一次请求时生成，之后复用。"""
    if STATE["cross"] is None:
        STATE["cross"] = make_captcha()
    return STATE["cross"]


def captcha_truth(cid: int) -> str:
    return STATE["pool"][cid]["code"]


def find_tab_id(worker, url_prefix: str):
    return sw_eval(
        worker,
        """async ([prefix]) => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find((t) => (t.url || '').startsWith(prefix));
            return tab ? tab.id : null;
        }""",
        [url_prefix],
    )


def list_frames(worker, tab_id: int):
    return sw_eval(
        worker,
        """async ([tabId]) => {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId, allFrames: true }, func: () => location.pathname,
                });
                return results.map((r) => ({ frameId: r.frameId, path: r.result }));
            } catch (error) {
                return [{ error: String(error && error.message || error) }];
            }
        }""",
        [tab_id],
    )


def send_to_frame(worker, tab_id: int, message: dict, frame_id: int):
    return sw_eval(
        worker,
        """async ([tabId, message, frameId]) => {
            try {
                const response = await chrome.tabs.sendMessage(tabId, message, { frameId });
                return { ok: true, response };
            } catch (error) {
                return { ok: false, error: String(error && error.message || error) };
            }
        }""",
        [tab_id, message, frame_id],
    )


# ── 用例 ───────────────────────────────────────────────────────────────────

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
    if not (DIST / "manifest.json").exists():
        print("缺少 dist/extension，请先运行 bun run build:extension", file=sys.stderr)
        return 2

    port_a, port_b = free_port(), free_port()
    origin_a, origin_b = f"http://127.0.0.1:{port_a}", f"http://127.0.0.1:{port_b}"
    build_pages(origin_b)
    serve(port_a)
    serve(port_b)
    print(f"[setup] app={origin_a} image={origin_b}")

    from playwright.sync_api import sync_playwright

    only = sys.argv[1] if len(sys.argv) > 1 else ""
    matches = lambda name: (not only) or (only in name)  # noqa: E731

    with sync_playwright() as playwright:
        # 偶发：Chromium 首次启动 / 扩展注册慢导致 SW 未就绪，整体重试一次
        context = worker = None
        for launch_attempt in range(2):
            try:
                context, worker = launch_extension(playwright, tempfile.mkdtemp(prefix="mieru-e2e-"))
                break
            except Exception as exc:  # noqa: BLE001
                if launch_attempt == 1:
                    raise
                print(f"[setup] 启动失败，2s 后重试一次: {exc}")
                time.sleep(2)
        extension_id = worker.url.split("/")[2]
        # onInstalled 会异步打开 options 页，可能打断 prep 页的导航；等它出现再关掉
        time.sleep(1.0)
        for existing in list(context.pages):
            if existing.url.startswith("chrome-extension://"):
                existing.close()

        cross_truth = ensure_cross_image()["code"]
        print(f"[setup] 验证码由 captcha 库按需生成；跨域样张真值={cross_truth}")

        # 1) 真实登录链路：识别 → 填错 → 换图 → 重识别 → 直到成功
        if matches("login"):
            def case_login():
                page = context.new_page()
                logs: list[str] = []
                console_collector(page, logs)
                page.bring_to_front()
                page.goto(f"{origin_a}/login?redirect=%2Fdashboard", wait_until="domcontentloaded")
                page.wait_for_timeout(1200)

                # 干扰项：预填的账号/密码不能被改写，短信框/搜索框必须为空
                account = page.eval_on_selector("#account", "el => el.value")
                password = page.eval_on_selector("#password", "el => el.value")
                sms = page.eval_on_selector("#sms-code", "el => el.value")
                search = page.eval_on_selector("#site-search", "el => el.value")
                assert account == "demo.user@example.com", f"账号被改写: {account!r}"
                assert password == "P@ssw0rd", f"密码被改写: {password!r}"
                assert sms == "", f"短信验证码框被误填: {sms!r}"
                assert search == "", f"顶部搜索框被误填: {search!r}"

                # 协议必须被自动勾选，但「7 天免登录」不能被勾
                assert page.is_checked("#agree"), "用户协议未被自动勾选"
                assert not page.is_checked("#remember"), "「7 天内免登录」被误勾选"

                accuracy: list[str] = []

                # 第一阶段（确定性）：先故意填错一次，验证「服务端拒绝 → 换图 → 扩展重新识别」
                first_value = wait_stable_value(page, "#captcha", 60)
                truth0 = captcha_truth(int(page.evaluate("() => window.__state.id")))
                accuracy.append("hit" if first_value.strip().upper() == truth0.upper() else f"miss({first_value}!={truth0})")
                page.fill("#captcha", "0000")  # 模拟识别失败
                page.click("#submit-login")
                page.wait_for_timeout(700)
                assert not page.evaluate("() => window.__state.success"), "错误验证码竟然登录成功"
                msg_state = page.eval_on_selector("#msg", "el => el.dataset.state")
                assert msg_state == "error", f"失败后页面状态异常: {msg_state!r}"
                refilled = wait_stable_value(page, "#captcha", 60)
                assert refilled != "0000" and refilled.strip(), "换图后没有被重新识别填充"

                # 第二阶段：识别正确的验证码后登录成功（允许 OCR 偶发错误时再试）
                for attempt in range(2, 7):
                    value = wait_stable_value(page, "#captcha", 60)
                    truth = captcha_truth(int(page.evaluate("() => window.__state.id")))
                    accuracy.append("hit" if value.strip().upper() == truth.upper() else f"miss({value}!={truth})")
                    page.click("#submit-login")
                    page.wait_for_timeout(900)
                    if page.evaluate("() => window.__state.success"):
                        agree_after = page.is_checked("#agree")
                        page.close()
                        return (
                            f"换图重试后第 {attempt} 次提交成功；识别 {accuracy}；"
                            f"干扰项未被填充、协议已勾选（{agree_after}）"
                        )
                page.close()
                raise AssertionError(f"6 次内未登录成功，识别记录={accuracy}")

            run_case("login: 真实登录链路（识别→失败换图→重试→成功）", case_login)

        # 1.5) 滑块拖拽：极验风格拼图，真实 pointer 拖拽 + 后端校验落点
        if matches("slider"):
            def case_slider():
                url = f"{origin_a}/slider"
                sw_eval(
                    worker,
                    """async ([origin]) => {
                        const url = origin + '/slider';
                        const rules = (await chrome.storage.local.get('siteRules')).siteRules || {};
                        rules[url] = {
                            hostname: new URL(url).hostname,
                            selector: '#slider-box',
                            subType: 'slider',
                            dragProfile: 'fast',
                            fullUrl: url,
                            enabled: true,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                        };
                        await chrome.storage.local.set({ siteRules: rules });
                        return true;
                    }""",
                    [origin_a],
                )
                attempts = []
                for attempt in range(1, 4):
                    page = context.new_page()
                    logs: list[str] = []
                    console_collector(page, logs)
                    page.bring_to_front()
                    page.goto(url, wait_until="domcontentloaded")
                    try:
                        page.wait_for_function(
                            "() => window.__state && window.__state.result !== null",
                            timeout=25000,
                        )
                    except Exception:
                        # 偶发：SW/offscreen 正忙于加载模型时首个 matchSlider 会被推迟，
                        # 重新开一页即可（每页都是独立的一次规则求解）。
                        info = page.evaluate(
                            "() => ({ drags: window.__state.drags, dragX: window.__state.dragX, "
                            "gapX: window.__state.gapX, token: window.__state.token })"
                        )
                        page.close()
                        attempts.append({"timeout": True, **info})
                        continue
                    info = page.evaluate(
                        "() => ({ result: window.__state.result, gap: window.__state.gap, "
                        "drags: window.__state.drags, dragX: window.__state.dragX, "
                        "truth: window.__state.gapX })"
                    )
                    attempts.append(info)
                    page.close()
                    if info["result"] == "success":
                        return (
                            f"第 {attempt} 次拖拽通过；drags={info['drags']}，落点 {info['dragX']}px "
                            f"（真值 {info['truth']}px，偏差 {info['gap']}px）"
                        )
                raise AssertionError(f"3 次拖拽均未通过: {attempts}")

            run_case("slider: 拼图滑块真实拖拽（后端校验落点）", case_slider)

        # 1.6) 滑块变体：异形 / 模糊 / 背景重排 / 拼图晚加载
        if matches("variants"):
            def case_slider_variants():
                url = f"{origin_a}/slider"
                sw_eval(
                    worker,
                    """async ([origin]) => {
                        const url = origin + '/slider';
                        const rules = (await chrome.storage.local.get('siteRules')).siteRules || {};
                        rules[url] = {
                            hostname: new URL(url).hostname,
                            selector: '#slider-box',
                            subType: 'slider',
                            dragProfile: 'fast',
                            fullUrl: url,
                            enabled: true,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                        };
                        await chrome.storage.local.set({ siteRules: rules });
                        return true;
                    }""",
                    [origin_a],
                )
                rows = []
                for query, label in (
                    ("variant=jigsaw", "凹弧拼图"),
                    ("variant=blur", "模糊拼图"),
                    ("variant=scrambled", "背景重排"),
                    ("late=1", "拼图晚加载"),
                ):
                    page = context.new_page()
                    page.bring_to_front()
                    page.goto(f"{url}?{query}", wait_until="domcontentloaded")
                    try:
                        page.wait_for_function(
                            "() => window.__state && window.__state.result !== null",
                            timeout=30000,
                        )
                    except Exception:
                        info = page.evaluate(
                            "() => ({ drags: window.__state.drags, dragX: window.__state.dragX, "
                            "truth: window.__state.gapX, token: window.__state.token })"
                        )
                        page.close()
                        raise AssertionError(f"{label} 在 30s 内未触发拖拽: {info}")
                    info = page.evaluate(
                        "() => ({ result: window.__state.result, gap: window.__state.gap, "
                        "dragX: window.__state.dragX, truth: window.__state.gapX })"
                    )
                    page.close()
                    assert info["result"] == "success", f"{label} 落点失败: {info}"
                    rows.append(f"{label} 偏差 {info['gap']}px")
                return "；".join(rows)

            run_case("variants: 异形/模糊/错拼/晚加载滑块", case_slider_variants)

        # 2) 组件重渲染：旧节点失效后，规则必须重新命中新节点
        if matches("spa"):
            def case_spa():
                url = f"{origin_a}/rule"
                sw_eval(
                    worker,
                    """async ([origin]) => {
                        const url = origin + '/rule';
                        const rules = (await chrome.storage.local.get('siteRules')).siteRules || {};
                        // 故意让规则里的 URL 带随机 query，页面实际地址不带 —— 验证 origin-path 匹配
                        rules[url] = {
                            hostname: new URL(url).hostname,
                            selector: '#late-cap',
                            inputSelector: '#late-input',
                            fullUrl: url + '?t=1700000000',
                            enabled: true,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                        };
                        await chrome.storage.local.set({ siteRules: rules });
                        return true;
                    }""",
                    [origin_a],
                )
                page = context.new_page()
                logs: list[str] = []
                console_collector(page, logs)
                page.bring_to_front()
                page.goto(url, wait_until="domcontentloaded")
                first = wait_stable_value(page, "#late-input", 60)
                truth1 = captcha_truth(int(page.evaluate("() => window.__state.id")))

                # 换一张图 + 整个 <img> 节点重建（旧引用彻底失效）
                page.eval_on_selector("#late-input", "el => { el.value = ''; }")
                page.click("#rerender")
                second = wait_stable_value(page, "#late-input", 60)
                truth2 = captcha_truth(int(page.evaluate("() => window.__state.id")))
                mounts = page.evaluate("() => window.__state.mounts")
                page.close()
                # 该用例验证「旧节点失效后规则能否重新命中」，命中真值不是重点（单张图有误读率）
                assert first.strip() and second.strip(), "重建前后都有未填充的情况"
                assert mounts >= 2, f"组件没有真正重建: mounts={mounts}"
                hit1 = first.strip().upper() == truth1.upper()
                hit2 = second.strip().upper() == truth2.upper()
                return (
                    f"首轮={first!r}（{truth1}，{'命中' if hit1 else '误读'}）→ "
                    f"组件重建 {mounts} 次后={second!r}（{truth2}，{'命中' if hit2 else '误读'}）"
                )

            run_case("spa: 验证码组件重建后规则仍生效", case_spa)

        # 3) 跨域图床（无 CORS 头）
        if matches("crossorigin"):
            def case_crossorigin():
                page = context.new_page()
                logs: list[str] = []
                console_collector(page, logs)
                page.bring_to_front()
                page.goto(f"{origin_a}/crossorigin", wait_until="domcontentloaded")
                value = wait_stable_value(page, "#captcha", 90)
                joined = "\n".join(logs)
                assert "改为后台抓取图片" in joined, "没有走后台代抓分支（canvas 可能未被污染）"
                # 跨域用例验证的是「代抓链路」；单张图仍有 ~8% 的模型误读率，
                # 因此只断言流程跑通 + 有结果，命中情况写进报告。
                assert value.strip(), "跨域图没有被识别填充"
                hit = value.strip().upper() == cross_truth.upper()
                page.close()
                return f"跨域图识别={value!r}（真值 {cross_truth}，{'命中' if hit else '误读'}），经 fetchImageData 兜底"

            run_case("crossorigin: 跨域图床仍能识别并填充", case_crossorigin)

        # 4) 懒加载组件 + 站点规则重试
        if matches("rule"):
            def case_rule():
                url = f"{origin_a}/rule"
                sw_eval(
                    worker,
                    """async ([origin]) => {
                        const url = origin + '/rule';
                        const rules = (await chrome.storage.local.get('siteRules')).siteRules || {};
                        rules[url] = {
                            hostname: new URL(url).hostname, selector: '#late-cap',
                            inputSelector: '#late-input', fullUrl: url, enabled: true,
                            solveDelayMs: 200, retryMs: 800, maxWaitMs: 20000,
                            createdAt: Date.now(), updatedAt: Date.now(),
                        };
                        await chrome.storage.local.set({ siteRules: rules });
                        return true;
                    }""",
                    [origin_a],
                )
                page = context.new_page()
                logs: list[str] = []
                console_collector(page, logs)
                page.bring_to_front()
                page.goto(url, wait_until="domcontentloaded")
                value = wait_stable_value(page, "#late-input", 60)
                truth = captcha_truth(int(page.evaluate("() => window.__state.id")))
                page.close()
                # 该元素没有任何 captcha 关键词，只有规则能命中 —— 填充本身就证明规则生效
                assert value.strip(), "规则未生效（没有填充）"
                hit = value.strip().upper() == truth.upper()
                return f"懒加载 3s 后规则生效，填充={value!r}（真值 {truth}，{'命中' if hit else '误读'}）"

            run_case("rule: 懒加载验证码组件 + 规则重试", case_rule)

        # 5) iframe 内嵌登录框的右键识别
        if matches("iframe"):
            def case_iframe():
                page = context.new_page()
                logs: list[str] = []
                console_collector(page, logs)
                page.bring_to_front()
                page.goto(f"{origin_a}/frame", wait_until="domcontentloaded")
                page.wait_for_timeout(1500)
                tab_id = find_tab_id(worker, f"{origin_a}/frame")
                assert tab_id, "找不到测试标签页"
                frames = list_frames(worker, tab_id)
                inner = next((f for f in frames if isinstance(f, dict) and f.get("path") == "/inner"), None)
                assert inner, f"没有 /inner 子框架: {frames}"
                frame = next((f for f in page.frames if f != page.main_frame), None)
                assert frame is not None
                inner_src = frame.eval_on_selector("#inner-img", "el => el.src")
                message = {"action": "recognizeImageBySrc", "srcUrl": inner_src}
                top = send_to_frame(worker, tab_id, message, 0)
                assert top["ok"], f"顶层应答失败: {top}"
                result = send_to_frame(worker, tab_id, message, inner["frameId"])
                assert result["ok"], f"子框架未应答: {result}"
                assert result["response"] and result["response"].get("success"), f"子框架识别失败: {result}"
                try:
                    frame.wait_for_selector("#Mieru-ctx-toast", timeout=8000)
                except Exception:
                    # 噪声排查：toast 可能落在顶层，也可能被剪贴板权限卡住
                    diag = {
                        "in_iframe": frame.evaluate("() => !!document.getElementById('Mieru-ctx-toast')"),
                        "in_top": page.evaluate("() => !!document.getElementById('Mieru-ctx-toast')"),
                        "iframe_body": frame.evaluate("() => document.body.innerHTML.length"),
                        "focused": page.evaluate("() => document.hasFocus()"),
                    }
                    print(f"       [diag] {diag}")
                    print("       [diag] console:\n" + "\n".join(logs[-12:]))
                    raise
                page.close()
                return f"frameId={inner['frameId']} 应答 text={result['response'].get('text')!r}，iframe 内出 toast"

            run_case("iframe: 内嵌登录框右键识别", case_iframe)

        # 6) 设置热更新
        if matches("settings"):
            def case_hot():
                page = context.new_page()
                console_collector(page, [])
                page.bring_to_front()
                page.goto(f"{origin_a}/login", wait_until="domcontentloaded")
                try:
                    first = wait_stable_value(page, "#captcha", 90)
                    patch_settings(worker, {"autoFill": False})
                    page.wait_for_timeout(1200)
                    page.eval_on_selector("#captcha", "el => { el.value = ''; }")
                    page.click("#refresh-captcha")
                    page.wait_for_timeout(9000)
                    after_off = page.eval_on_selector("#captcha", "el => el.value")
                    assert after_off == "", f"关闭 autoFill 后仍被填充: {after_off!r}"
                    patch_settings(worker, {"autoFill": True})
                    page.wait_for_timeout(1200)
                    page.click("#refresh-captcha")
                    resumed = wait_stable_value(page, "#captcha", 60)
                    return f"首轮={first!r}；关闭后保持空；恢复后={resumed!r}"
                finally:
                    patch_settings(worker, {"autoFill": True})
                    page.close()

            run_case("settings: 设置热更新（无需刷新页面）", case_hot)

        # 7) 模型降级提示
        if matches("model"):
            def case_model():
                sw_eval(worker, "async () => { await chrome.storage.local.set({ activeModelId: 'm_missing_model' }); return true; }")
                try:
                    page = context.new_page()
                    console_collector(page, [])
                    page.bring_to_front()
                    page.goto(f"{origin_a}/login", wait_until="domcontentloaded")
                    value = wait_stable_value(page, "#captcha", 90)
                    page.wait_for_selector("[data-mieru-toast]", timeout=15000)
                    toast = page.eval_on_selector("[data-mieru-toast]", "el => el.textContent || ''")
                    assert "回退" in toast, f"回退提示异常: {toast!r}"
                    page.close()
                    return f"回退后仍填充={value!r}，提示={toast.strip()[:36]}…"
                finally:
                    sw_eval(worker, "async () => { await chrome.storage.local.set({ activeModelId: '__builtin__' }); return true; }")

            run_case("model: 自定义模型缺失时回退并提示", case_model)

        # 8.5) 文字点选：检测模型 + OCR 标字 + 按题序点击
        if matches("clickselect"):
            def case_clickselect():
                url = f"{origin_a}/click"
                # 1) 上传检测模型（用仓库里的 common_det.onnx，不依赖联网）
                opts_page = context.new_page()
                opts_page.goto(f"chrome-extension://{extension_id}/options.html", wait_until="domcontentloaded")
                opts_page.wait_for_timeout(600)
                opts_page.click('[data-section="models"]')
                opts_page.wait_for_selector("#btn-upload-det-model", state="visible")
                opts_page.set_input_files("#det-model-file", str(REPO / "public" / "common_det.onnx"))
                opts_page.click("#btn-upload-det-model")
                status = ""
                for _ in range(60):
                    opts_page.wait_for_timeout(300)
                    status = opts_page.eval_on_selector("#det-model-status", "el => el.textContent || ''")
                    if "common_det" in status:
                        break
                opts_page.close()
                assert "失败" not in status, f"检测模型上传失败: {status}"

                # 2) 站点规则：点选容器
                sw_eval(
                    worker,
                    """async ([origin]) => {
                        const url = origin + '/click';
                        const rules = (await chrome.storage.local.get('siteRules')).siteRules || {};
                        rules[url] = {
                            hostname: new URL(url).hostname,
                            selector: '#click-box',
                            subType: 'click-select',
                            fullUrl: url,
                            enabled: true,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                        };
                        await chrome.storage.local.set({ siteRules: rules });
                        return true;
                    }""",
                    [origin_a],
                )

                # 3) 打开页面，等扩展按题序点击
                page = context.new_page()
                logs: list[str] = []
                console_collector(page, logs)
                page.bring_to_front()
                page.goto(url, wait_until="domcontentloaded")
                try:
                    page.wait_for_function(
                        "() => window.__state && window.__state.result !== null",
                        timeout=45000,
                    )
                except Exception:
                    info = page.evaluate(
                        "() => ({ clicks: window.__state.clicks, expected: window.__state.expected, "
                        "  detail: window.__state.detail })"
                    )
                    print("       [diag] " + json.dumps(info, ensure_ascii=False))
                    print("       [diag] console:\n" + "\n".join(logs[-12:]))
                    page.close()
                    raise
                info = page.evaluate(
                    "() => ({ result: window.__state.result, detail: window.__state.detail, "
                    "  expected: window.__state.expected })"
                )
                page.close()
                assert info["result"] == "success", f"点选顺序错误: {info}"
                return f"题序 {''.join(info['expected'])} 全部点中"
            run_case("clickselect: 文字点选按题序自动点击", case_clickselect)


        # 8) 导入配置不误删订阅
        if matches("import"):
            def case_import():
                options = context.new_page()
                options.goto(f"chrome-extension://{extension_id}/options.html", wait_until="domcontentloaded")
                options.wait_for_timeout(400)
                sw_eval(
                    worker,
                    """async () => {
                        const current = (await chrome.storage.local.get('settings')).settings || {};
                        await chrome.storage.local.set({
                            settings: { ...current, autoSubmit: false },
                            subscriptions: [{ id: 'sub_e2e', url: 'https://example.com/r.json', name: 'e2e',
                                             enabled: true, updateInterval: 0, lastUpdated: 0,
                                             lastStatus: 'never', createdAt: 1 }],
                        });
                        return true;
                    }""",
                )
                tmp = Path(tempfile.mkdtemp(prefix="mieru-import-"))
                rules_file = tmp / "rules.json"
                rules_file.write_text(json.dumps([{"hostname": "example.com", "selector": "#x"}]), encoding="utf-8")
                config_file = tmp / "config.json"
                config_file.write_text(json.dumps({"settings": {"autoSubmit": True}, "siteRules": {}}), encoding="utf-8")

                options.click('[data-section="advanced"]')
                options.wait_for_timeout(200)
                with options.expect_file_chooser() as chooser:
                    options.click("#btn-import-config")
                chooser.value.set_files(str(rules_file))
                options.wait_for_timeout(800)
                toast = options.eval_on_selector("#toast-message", "el => el.textContent || ''")
                subs = sw_eval(worker, "async () => (await chrome.storage.local.get('subscriptions')).subscriptions || []")
                assert subs and subs[0]["id"] == "sub_e2e", "非法导入把订阅清掉了"
                assert "配置文件" in toast or "导入失败" in toast, f"非法导入未报错: {toast!r}"

                with options.expect_file_chooser() as chooser2:
                    options.click("#btn-import-config")
                chooser2.value.set_files(str(config_file))
                options.wait_for_timeout(800)
                settings = sw_eval(worker, "async () => (await chrome.storage.local.get('settings')).settings || {}")
                subs = sw_eval(worker, "async () => (await chrome.storage.local.get('subscriptions')).subscriptions || []")
                assert settings.get("autoSubmit") is True, "合法配置未写入"
                assert subs and subs[0]["id"] == "sub_e2e", "合法导入把订阅清掉了"
                options.close()
                return "非法载荷被拒、合法导入成功，订阅均保留"

            run_case("import: 导入配置不误删订阅/模型注册表", case_import)

        # 9) 设置页保存按钮固定在右下角，不随页面滚动
        if matches("layout"):
            def case_layout():
                page = context.new_page()
                page.set_viewport_size({"width": 960, "height": 520})
                page.goto(f"chrome-extension://{extension_id}/options.html", wait_until="domcontentloaded")
                page.wait_for_selector("#btn-save-general", state="visible")

                def snapshot():
                    return page.evaluate(
                        """() => {
                            const btn = document.getElementById('btn-save-general');
                            const rect = btn.getBoundingClientRect();
                            return {
                                position: getComputedStyle(btn.closest('.action-bar')).position,
                                top: rect.top, right: rect.right, bottom: rect.bottom,
                                vw: window.innerWidth, vh: window.innerHeight,
                                scrollable: document.documentElement.scrollHeight > window.innerHeight + 40,
                            };
                        }"""
                    )

                before = snapshot()
                assert before["position"] == "fixed", f"保存栏没有固定定位: {before['position']}"
                assert before["scrollable"], "页面没有可滚动内容，用例无法验证固定效果"

                page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
                page.wait_for_timeout(300)
                after = snapshot()
                assert abs(after["top"] - before["top"]) < 1, f"滚动后按钮位置改变: {before} → {after}"
                assert abs(after["right"] - before["right"]) < 1, f"滚动后按钮横向位置改变: {before} → {after}"
                assert after["right"] > after["vw"] - 120, f"按钮不在右下角（右）: {after}"
                assert after["bottom"] > after["vh"] - 120, f"按钮不在右下角（下）: {after}"

                page.click('.nav-item[data-section="advanced"]')
                page.wait_for_timeout(300)
                adv = page.evaluate(
                    """() => {
                        const btn = document.getElementById('btn-save-advanced');
                        const rect = btn.getBoundingClientRect();
                        return {
                            position: getComputedStyle(btn.closest('.action-bar')).position,
                            right: rect.right, bottom: rect.bottom,
                            vw: window.innerWidth, vh: window.innerHeight,
                        };
                    }"""
                )
                assert adv["position"] == "fixed", f"高级设置的保存栏没有固定定位: {adv['position']}"
                assert adv["right"] > adv["vw"] - 120 and adv["bottom"] > adv["vh"] - 120, f"高级保存按钮不在右下角: {adv}"
                page.close()
                return (
                    f"滚动前后位置不变（right={after['right']:.0f}, bottom={after['bottom']:.0f}），"
                    f"高级设置同样固定"
                )

            run_case("layout: 保存按钮固定在右下角不随滚动", case_layout)

        context.close()

    print("\n===== 汇总 =====")
    failed = [name for name, ok, _ in RESULTS if not ok]
    for name, ok, detail in RESULTS:
        print(f"{'PASS' if ok else 'FAIL'}  {name}  —  {detail}")
    if STATE["logins"]:
        hits = sum(1 for item in STATE["logins"] if item["ok"])
        print(f"\n登录尝试 {len(STATE['logins'])} 次，验证码命中 {hits} 次（不区分大小写）")
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

