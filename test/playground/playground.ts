/**
 * 交互式验证码标准测试台。
 * 直接 import 项目真实模块（CaptchaDetector / slide-detector / slider-solver），
 * 对生产同款结构的验证码做检测/求解回归。用相对路径 import，便于 `bun build` 独立打包。
 */
import { CaptchaDetector } from '../../src/core/captcha-detector';
import { slideMatch, type ImageLike } from '../../src/core/slide-detector';
import { solveSlider, elementToImageData } from '../../src/core/interaction/slider-solver';
import { OCREngine } from '../../src/core/ocr-engine';
import { DetectionEngine } from '../../src/core/detection-engine';
import { labelBoxesWithEngines, solveClickSelect } from '../../src/core/interaction/click-select-solver';
import { detectTurnstile, assistCloudflare } from '../../src/core/interaction/cloudflare';

// ────────────────────────── 小工具 ──────────────────────────
function $(id: string): HTMLElement { return document.getElementById(id)!; }
function logTo(boxId: string, msg: string, cls = ''): void {
  const box = $(boxId);
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = msg + '\n';
  box.appendChild(span);
  box.scrollTop = box.scrollHeight;
}
function setMetrics(boxId: string, items: { k: string; v: string }[]): void {
  $(boxId).innerHTML = items.map((i) => `<div class="metric"><div class="v">${i.v}</div><div class="k">${i.k}</div></div>`).join('');
}

// ────────────── GeeTest 同款拼图生成（移植自 slide-detection-test.html，已自测）──────────────
const BG_W = 320, BG_H = 160, TPL = 60;

function puzzlePath(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const r = w * 0.18;
  const cx = w / 2, cy = h / 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(cx - r, 0);
  ctx.arc(cx, 0, r, Math.PI, 0, true);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, cy - r);
  ctx.arc(w, cy, r, Math.PI * 1.5, Math.PI * 0.5, true);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
}

interface PuzzleTruth { gapX: number; gapY: number; }

/** 渲染拼图到页面的 gtBg / gtSlice 画布，返回真值缺口位置。 */
function renderPuzzle(): PuzzleTruth {
  const gapX = 90 + Math.floor(Math.random() * (BG_W - TPL - 110));
  const gapY = Math.floor((BG_H - TPL) / 2 + (Math.random() - 0.5) * 30);

  const bg = $('gtBg') as HTMLCanvasElement;
  bg.width = BG_W; bg.height = BG_H;
  const bctx = bg.getContext('2d')!;
  const grad = bctx.createLinearGradient(0, 0, BG_W, BG_H);
  grad.addColorStop(0, '#43cea2'); grad.addColorStop(1, '#185a9d');
  bctx.fillStyle = grad;
  bctx.fillRect(0, 0, BG_W, BG_H);
  for (let i = 0; i < 80; i++) {
    bctx.fillStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.25})`;
    bctx.beginPath();
    bctx.arc(Math.random() * BG_W, Math.random() * BG_H, 3 + Math.random() * 16, 0, Math.PI * 2);
    bctx.fill();
  }
  for (let i = 0; i < 6; i++) {
    bctx.strokeStyle = `rgba(0,0,0,${0.1 + Math.random() * 0.2})`;
    bctx.lineWidth = 1;
    bctx.beginPath();
    bctx.moveTo(Math.random() * BG_W, 0);
    bctx.lineTo(Math.random() * BG_W, BG_H);
    bctx.stroke();
  }

  // 滑块小图：60×160 透明画布，拼图块贴在内部 (0, gapY)
  const slice = $('gtSlice') as HTMLCanvasElement;
  slice.width = TPL; slice.height = BG_H;
  const sctx = slice.getContext('2d')!;
  sctx.clearRect(0, 0, TPL, BG_H);
  sctx.save();
  sctx.translate(0, gapY);
  puzzlePath(sctx, TPL, TPL);
  sctx.clip();
  sctx.drawImage(bg, gapX, gapY, TPL, TPL, 0, 0, TPL, TPL);
  sctx.restore();

  // 背景挖暗缺口
  bctx.save();
  bctx.translate(gapX, gapY);
  puzzlePath(bctx, TPL, TPL);
  bctx.fillStyle = 'rgba(0,0,0,0.5)';
  bctx.fill();
  bctx.strokeStyle = 'rgba(0,0,0,0.85)';
  bctx.lineWidth = 2;
  bctx.stroke();
  bctx.restore();

  // 复位滑块 DOM
  slice.style.left = '0px';
  $('gtBtn').style.left = '0px';
  $('gtFill').style.width = '0px';
  truth = { gapX, gapY };
  return truth;
}

let truth: PuzzleTruth = { gapX: 0, gapY: 0 };

// ────────────── 真实可拖拽滑块行为（响应真人 & 合成事件）──────────────
function installSliderBehavior(): void {
  const btn = $('gtBtn');
  const slice = $('gtSlice');
  const fill = $('gtFill');
  const track = btn.parentElement!;
  const maxX = track.clientWidth - btn.offsetWidth; // 可移动范围
  let dragging = false;
  let startX = 0;
  let curLeft = 0;

  const onDown = (clientX: number) => { dragging = true; startX = clientX - curLeft; btn.classList.add('active'); };
  const onMove = (clientX: number) => {
    if (!dragging) return;
    curLeft = Math.max(0, Math.min(maxX, clientX - startX));
    btn.style.left = curLeft + 'px';
    fill.style.width = curLeft + 'px';
    slice.style.left = curLeft + 'px';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    btn.classList.remove('active');
    const err = Math.abs(curLeft - truth.gapX);
    const ok = err <= 6;
    logTo('sliderLog', `释放：滑块落点=${curLeft.toFixed(1)}px 缺口真值=${truth.gapX}px 误差=${err.toFixed(1)}px → ${ok ? '✓ 通过' : '✗ 失败'}`, ok ? 'ok' : 'err');
  };

  // pointer + mouse 双监听（与 pointer.ts 的派发对齐）
  btn.addEventListener('pointerdown', (e) => onDown((e as PointerEvent).clientX));
  btn.addEventListener('mousedown', (e) => onDown((e as MouseEvent).clientX));
  document.addEventListener('pointermove', (e) => onMove((e as PointerEvent).clientX));
  document.addEventListener('mousemove', (e) => onMove((e as MouseEvent).clientX));
  document.addEventListener('pointerup', onUp);
  document.addEventListener('mouseup', onUp);
}

// ────────────── 按钮逻辑 ──────────────
const detector = new CaptchaDetector();

function doDetect(): void {
  const captchas = detector.scan();
  logTo('sliderLog', `--- 检测 ---`, 'dim');
  logTo('sliderLog', `CaptchaDetector.scan() 返回 ${captchas.length} 个候选`);
  const slider = captchas.find((c) => c.subType === 'slider');
  if (!slider) {
    logTo('sliderLog', '未识别出 slider 子类型（检查 SLIDER_KEYWORDS 是否命中 geetest_slider）', 'warn');
    return;
  }
  logTo('sliderLog', `命中 slider：id=${slider.id} confidence=${slider.confidence}`, 'ok');
  logTo('sliderLog', `  背景图: ${slider.innerCanvas?.tagName.toLowerCase()} ${(slider.innerCanvas as HTMLCanvasElement)?.width}×${(slider.innerCanvas as HTMLCanvasElement)?.height}`);
  logTo('sliderLog', `  滑块小图: ${slider.sliderPiece ? `${(slider.sliderPiece as HTMLCanvasElement).width}×${(slider.sliderPiece as HTMLCanvasElement).height}` : '未找到'}`, slider.sliderPiece ? '' : 'warn');
  logTo('sliderLog', `  拖拽手柄: ${slider.sliderHandle ? slider.sliderHandle.className || slider.sliderHandle.tagName : '未找到'}`, slider.sliderHandle ? '' : 'warn');
}

async function doSolve(): Promise<void> {
  renderPuzzle();
  await new Promise((r) => setTimeout(r, 100)); // 等 DOM 复位
  const captchas = detector.scan();
  const slider = captchas.find((c) => c.subType === 'slider');
  if (!slider) { logTo('sliderLog', '未检测到 slider，无法求解', 'err'); return; }
  logTo('sliderLog', `--- 自动求解 (真值缺口 x=${truth.gapX}px) ---`, 'dim');
  const res = await solveSlider(slider, { onLog: (m) => logTo('sliderLog', '  ' + m, 'dim') });
  if (res.success) {
    const err = Math.abs(res.gapX - truth.gapX);
    logTo('sliderLog', `求解完成：检测缺口=${res.gapX.toFixed(1)}px 真值=${truth.gapX}px 误差=${err.toFixed(1)}px score=${res.score.toFixed(3)}`, err <= 8 ? 'ok' : 'warn');
  } else {
    logTo('sliderLog', `求解未执行：${res.reason}`, 'err');
  }
}

/** 自测 N 次：纯检测准确率（slideMatch 检出 x vs 真值），不含拖拽。 */
function doSelftest(n = 30): void {
  logTo('sliderLog', `--- 自测 ${n} 次（缺口检测准确率）---`, 'dim');
  let okCount = 0;
  let totalErr = 0;
  let totalMs = 0;
  for (let i = 0; i < n; i++) {
    const t = renderPuzzle();
    const bg = elementToImageData($('gtBg') as HTMLCanvasElement);
    const piece = elementToImageData($('gtSlice') as HTMLCanvasElement);
    if (!bg || !piece) { logTo('sliderLog', '画布不可读，跳过', 'err'); continue; }
    const m = slideMatch(piece as ImageLike, bg as ImageLike);
    const err = Math.abs(m.x - t.gapX);
    totalErr += err;
    totalMs += m.elapsed;
    if (err <= 6) okCount++;
  }
  const acc = (okCount / n * 100).toFixed(1);
  setMetrics('sliderMetrics', [
    { k: '成功率 (误差≤6px)', v: acc + '%' },
    { k: '平均误差', v: (totalErr / n).toFixed(1) + 'px' },
    { k: '平均耗时', v: (totalMs / n).toFixed(0) + 'ms' },
    { k: '样本数', v: String(n) },
  ]);
  logTo('sliderLog', `自测完成：成功率 ${acc}%，平均误差 ${(totalErr / n).toFixed(1)}px，平均 ${(totalMs / n).toFixed(0)}ms`, okCount === n ? 'ok' : 'warn');
  renderPuzzle(); // 留一个干净的初始态
}

// ────────────────────────── 文字点选（②）──────────────────────────
// 用项目真实的 DetectionEngine(common_det) + OCREngine(common) + solveClickSelect，
// 在 canvas 上渲染「乱序字 + 题面顺序」的点选验证码，端到端跑检测→OCR→匹配→点击，
// 按合成点击落点核对是否点中正确字符，给出端到端通过率。

const CS_POOL = '天地人和山水风云日月星辰花鸟鱼虫春夏秋冬东南西北中上下左右大小多少';
const CS_K = 6;     // 画布上铺多少个字
const CS_PICK = 3;  // 题面要求依次点击几个字

interface CsTruth { char: string; cx: number; cy: number; r: number; }
let csTruth: CsTruth[] = [];
let csOrder: string[] = [];

let ocrEngine: OCREngine | null = null;
let detEngine: DetectionEngine | null = null;

/** 懒加载两套引擎（真实 ort-web + 仓库内的 common.onnx / common_det.onnx）。 */
async function getEngines(): Promise<{ ocr: OCREngine; det: DetectionEngine }> {
  const ort = (window as any).ort;
  if (!ort) throw new Error('window.ort 未加载（检查 ort.min.js 是否成功引入）');
  // localhost 非 cross-origin isolated，必须单线程，否则 wasm 多线程会失败。
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';
  const WASM = '/node_modules/onnxruntime-web/dist/';

  if (!ocrEngine) {
    logTo('csLog', '初始化 OCR 引擎 (common.onnx)…', 'dim');
    ocrEngine = new OCREngine({
      getModel: async () => ({
        model: await (await fetch('/public/common.onnx')).arrayBuffer(),
        charsets: await (await fetch('/public/charsets.json')).json(),
      }),
      getOrt: async () => ort,
      wasmPaths: WASM,
    });
    await ocrEngine.init();
  }
  if (!detEngine) {
    logTo('csLog', '初始化检测引擎 (common_det.onnx)…', 'dim');
    detEngine = new DetectionEngine({
      getModel: async () => ({ model: await (await fetch('/public/common_det.onnx')).arrayBuffer() }),
      getOrt: async () => ort,
      wasmPaths: WASM,
      numThreads: 1,
    });
    await detEngine.init();
  }
  return { ocr: ocrEngine, det: detEngine };
}

function clearMarkers(): void {
  $('csWrap').querySelectorAll('.cs-marker').forEach((m) => m.remove());
}
function drawMarker(x: number, y: number, label: string, ok: boolean): void {
  const d = document.createElement('div');
  d.className = 'cs-marker';
  d.textContent = label;
  d.style.left = x + 'px';
  d.style.top = y + 'px';
  if (!ok) d.style.background = 'rgba(245,158,11,.9)';
  $('csWrap').appendChild(d);
}

/** 渲染点选验证码到 csCanvas，记录真值字符位置 + 题面顺序。 */
function renderClickSelect(): void {
  const canvas = $('csCanvas') as HTMLCanvasElement;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#eef3f8'); grad.addColorStop(1, '#dde6f0');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(120,140,170,${0.04 + Math.random() * 0.10})`;
    ctx.beginPath();
    ctx.arc(Math.random() * W, Math.random() * H, 4 + Math.random() * 14, 0, Math.PI * 2);
    ctx.fill();
  }

  const pool = Array.from(CS_POOL);
  const chosen: string[] = [];
  while (chosen.length < CS_K) {
    const c = pool[Math.floor(Math.random() * pool.length)];
    if (!chosen.includes(c)) chosen.push(c);
  }

  const cols = 3, rows = 2, cellW = W / cols, cellH = H / rows, font = 38;
  csTruth = [];
  chosen.forEach((ch, idx) => {
    const col = idx % cols, row = Math.floor(idx / cols);
    const cx = cellW * col + cellW / 2 + (Math.random() - 0.5) * cellW * 0.4;
    const cy = cellH * row + cellH / 2 + (Math.random() - 0.5) * cellH * 0.4;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((Math.random() - 0.5) * 0.4);
    ctx.font = `bold ${font}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = `hsl(${Math.floor(Math.random() * 360)},70%,26%)`;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    csTruth.push({ char: ch, cx, cy, r: font * 0.7 });
  });

  const shuffled = chosen.slice().sort(() => Math.random() - 0.5);
  csOrder = shuffled.slice(0, CS_PICK);
  $('csPrompt').textContent = csOrder.join(' ');
  clearMarkers();
}

function doDetectCS(): void {
  const captchas = detector.scan();
  logTo('csLog', '--- 检测 ---', 'dim');
  const cs = captchas.find((c) => c.subType === 'click-select');
  if (!cs) {
    logTo('csLog', '未识别出 click-select（检查 point-captcha 是否命中 CLICK_SELECT_KEYWORDS）', 'warn');
    return;
  }
  logTo('csLog', `命中 click-select：id=${cs.id} confidence=${cs.confidence}`, 'ok');
  const ic = cs.innerCanvas as HTMLCanvasElement;
  logTo('csLog', `  主图: ${ic?.tagName.toLowerCase()} ${ic?.width}×${ic?.height}`);
  logTo('csLog', `  题面顺序(truth): ${csOrder.join(' ')}`);
}

/** 单次端到端求解，返回命中统计。 */
async function doSolveCS(): Promise<{ ok: boolean; correct: number; total: number; reason?: string }> {
  clearMarkers();
  const total = csOrder.length;
  const captchas = detector.scan();
  const cs = captchas.find((c) => c.subType === 'click-select');
  if (!cs) { logTo('csLog', '未检测到 click-select，无法求解', 'err'); return { ok: false, correct: 0, total, reason: 'no-detect' }; }

  let engines: { ocr: OCREngine; det: DetectionEngine };
  try {
    engines = await getEngines();
  } catch (e) {
    logTo('csLog', '引擎初始化失败: ' + (e as Error).message, 'err');
    return { ok: false, correct: 0, total, reason: 'engine-init' };
  }

  const canvas = $('csCanvas') as HTMLCanvasElement;
  const clicks: { x: number; y: number }[] = [];
  const onClick = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    clicks.push({ x: e.clientX - r.left, y: e.clientY - r.top });
  };
  canvas.addEventListener('click', onClick);

  logTo('csLog', `--- 自动求解 (题面 ${csOrder.join(' ')}) ---`, 'dim');
  const res = await solveClickSelect(cs, {
    promptOrder: csOrder.slice(),
    labelBoxes: (img) => labelBoxesWithEngines(img, engines.det, engines.ocr),
    clickGap: [120, 220],
    onLog: (m) => logTo('csLog', '  ' + m, 'dim'),
  });
  canvas.removeEventListener('click', onClick);

  if (!res.success) {
    logTo('csLog', `求解未成功：${res.reason}（检测标注串：${res.detected ?? '—'}）`, 'warn');
    return { ok: false, correct: 0, total, reason: res.reason };
  }

  let correct = 0;
  csOrder.forEach((expected, i) => {
    const c = clicks[i];
    if (!c) return;
    const hit = csTruth.find((t) => Math.abs(c.x - t.cx) <= t.r && Math.abs(c.y - t.cy) <= t.r);
    const good = !!hit && hit.char === expected;
    if (good) correct++;
    drawMarker(c.x, c.y, String(i + 1), good);
    logTo('csLog', `  第${i + 1}击 期望「${expected}」落点(${c.x.toFixed(0)},${c.y.toFixed(0)}) → 命中「${hit?.char ?? '空白'}」 ${good ? '✓' : '✗'}`, good ? 'ok' : 'err');
  });
  const ok = correct === total && clicks.length === total;
  logTo('csLog', `端到端：点击 ${clicks.length}/${total}，命中正确 ${correct}/${total} → ${ok ? '✓ 通过' : '✗ 失败'}`, ok ? 'ok' : 'err');
  return { ok, correct, total };
}

/** 自测 N 次端到端通过率。 */
async function doSelftestCS(n = 10): Promise<void> {
  logTo('csLog', `--- 自测 ${n} 次（端到端通过率）---`, 'dim');
  let pass = 0, totalCorrect = 0, totalChars = 0;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    renderClickSelect();
    await new Promise((r) => setTimeout(r, 50));
    const r = await doSolveCS();
    if (r.ok) pass++;
    totalCorrect += r.correct;
    totalChars += r.total;
  }
  const ms = Date.now() - t0;
  setMetrics('csMetrics', [
    { k: '端到端通过率', v: (pass / n * 100).toFixed(0) + '%' },
    { k: '单字命中率', v: (totalChars ? totalCorrect / totalChars * 100 : 0).toFixed(0) + '%' },
    { k: '平均耗时', v: (ms / n).toFixed(0) + 'ms' },
    { k: '样本数', v: String(n) },
  ]);
  logTo('csLog', `自测完成：通过 ${pass}/${n}，单字命中 ${totalCorrect}/${totalChars}`, pass === n ? 'ok' : 'warn');
  renderClickSelect();
}

// ────────────────────────── CF 人机验证（③）──────────────────────────
// 用项目真实的 detectTurnstile / assistCloudflare，验证检测命中 + 跨域边界 + 顶层降级辅助。
// 诚实：合成点击过不了 CF（isTrusted + 网络/行为指纹），右侧 mock 演示行为层为何拒绝。

function doDetectCF(): void {
  const widgets = detectTurnstile();
  logTo('cfLog', '--- 检测 Turnstile ---', 'dim');
  logTo('cfLog', `detectTurnstile() 命中 ${widgets.length} 个部件`, widgets.length ? 'ok' : 'warn');
  widgets.forEach((w, i) => {
    logTo('cfLog', `  ${i + 1}. kind=${w.kind}${w.sitekey ? ` sitekey=${w.sitekey}` : ''} ${Math.round(w.rect.width)}×${Math.round(w.rect.height)}`);
  });
  const iframe = widgets.find((w) => w.kind === 'iframe');
  if (iframe) {
    let canReach = false;
    try { canReach = !!(iframe.element as HTMLIFrameElement).contentDocument; } catch { canReach = false; }
    logTo('cfLog', `  跨域边界：顶层能否读取 iframe.contentDocument = ${canReach ? '能（异常/同源）' : '不能（符合预期，CF 跨域隔离）'}`, canReach ? 'warn' : 'ok');
  } else {
    logTo('cfLog', '  （未见 CF iframe：测试 sitekey 脚本可能未加载，但 .cf-turnstile 容器仍被命中）', 'dim');
  }
}

async function doAssistCF(): Promise<void> {
  logTo('cfLog', '--- 辅助（顶层滚动 + 高亮）---', 'dim');
  const res = await assistCloudflare({ onLog: (m) => logTo('cfLog', '  ' + m, 'dim') });
  logTo('cfLog', `结果: mode=${res.mode} success=${res.success}${res.widgets != null ? ` widgets=${res.widgets}` : ''}`, res.success ? 'ok' : 'warn');
  logTo('cfLog', '注：辅助 ≠ 绕过。合成点击 isTrusted=false + CF 网络/行为指纹，客户端无法自动通过（见右侧评分 mock）。', 'warn');
}

// ────────────── 初始化 ──────────────
function main(): void {
  renderPuzzle();
  installSliderBehavior();
  $('sliderRegen').addEventListener('click', () => { renderPuzzle(); logTo('sliderLog', `已重新生成，缺口真值 x=${truth.gapX}px`, 'dim'); });
  $('sliderDetect').addEventListener('click', doDetect);
  $('sliderSolve').addEventListener('click', () => { void doSolve(); });
  $('sliderSelftest').addEventListener('click', () => doSelftest(30));
  logTo('sliderLog', 'Ready. 「检测」验证 CaptchaDetector 命中；「自动求解」跑 slideMatch+拖拽；「自测」测缺口检测准确率。', 'ok');

  // 文字点选
  renderClickSelect();
  $('csRegen').addEventListener('click', () => { renderClickSelect(); logTo('csLog', `已重新生成，题面=${csOrder.join(' ')}`, 'dim'); });
  $('csDetect').addEventListener('click', doDetectCS);
  $('csSolve').addEventListener('click', () => { void doSolveCS(); });
  $('csSelftest').addEventListener('click', () => { void doSelftestCS(10); });
  logTo('csLog', 'Ready. 「检测」验证命中；「自动求解」跑 common_det+OCR+点击；「自测」测端到端通过率。首次求解会初始化模型（约 30s）。', 'ok');

  // CF 人机验证
  $('cfDetect').addEventListener('click', doDetectCF);
  $('cfAssist').addEventListener('click', () => { void doAssistCF(); });
  logTo('cfLog', 'Ready. 「检测」验证 detectTurnstile 命中 + 跨域边界；「辅助」跑顶层滚动+高亮降级。右侧 mock 可点「机器人模式 / 辅助点击」对比评分。', 'ok');
}

main();
