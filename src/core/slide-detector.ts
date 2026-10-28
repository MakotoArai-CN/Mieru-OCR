/**
 * 滑块缺口检测（slide-match）——纯算法，无 DOM 依赖。
 *
 * 移植自 test/experiments/slide-detection-test.html（已自测过的实现），
 * 对齐 ddddocr 的 slide_match 策略：
 *   1. target（滑块小图）若含真实 alpha 通道，先按 alpha 裁出紧致包围盒（has_alpha 路径）；
 *   2. 灰度化 → Canny 边缘 → 在背景边缘图上滑动 target 边缘图做归一化互相关（TM_CCOEFF_NORMED）；
 *   3. 边缘像素过少时回退到灰度 NCC，避免空边缘导致的无效匹配。
 *
 * 这些函数都是纯函数：输入 ImageData 风格的 { data, width, height }，不触碰 canvas/DOM，
 * 因此可在 content script、offscreen、worker 任意环境运行。
 */

export interface ImageLike {
  /** RGBA，长度 = width*height*4（同 ImageData.data） */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

export interface EdgeImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlideMatchOptions {
  lowT?: number;
  highT?: number;
  sigma?: number;
  downsample?: number;
  minEdgePixels?: number;
}

export interface SlideMatchResult {
  /** 缺口在背景图中的左上角 x（已补偿 alpha 裁剪偏移与 downsample） */
  x: number;
  y: number;
  /** 归一化互相关得分（-1..1，越接近 1 越可信） */
  score: number;
  /**
   * 与最佳位置不重叠的次优峰得分。真实网站背景常有重复纹理（条纹、logo 平铺、
   * 规则图形），此时"最高分"未必是缺口。score 与 secondScore 的差距（margin）
   * 才是可置信度的关键指标。
   */
  secondScore: number;
  /** score - secondScore。差距小说明存在竞争峰，应降级到多算法融合。 */
  margin: number;
  /**
   * 拼图块与该位置背景内容的逐像素相关性（-1..1）。与边缘无关的独立校验：
   * 正确缺口≈1，错位通常 <0.5；NaN 表示拼图块没有 alpha 通道（无法校验）。
   */
  contentScore: number;
  method: 'edge' | 'edge+alpha' | 'grayscale-fallback' | 'content-search';
  targetEdgeCount: number;
  elapsed: number;
  downsample: number;
}

/** RGBA ImageData -> 灰度 Float32 (0-255)，按 alpha 合成到白底（与 image-processor 灰度口径一致）。 */
export function toGray(imgData: ImageLike): GrayImage {
  const { data, width, height } = imgData;
  const out = new Float32Array(width * height);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    const r = data[i] * a + 255 * (1 - a);
    const g = data[i + 1] * a + 255 * (1 - a);
    const b = data[i + 2] * a + 255 * (1 - a);
    out[i / 4] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return { data: out, width, height };
}

function gaussianKernel1D(sigma: number, size: number): Float32Array {
  const k = new Float32Array(size);
  const half = (size - 1) / 2;
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - half;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

export function gaussianBlur(gray: GrayImage, sigma = 1.4): GrayImage {
  const { data, width: w, height: h } = gray;
  const size = Math.max(3, (Math.ceil(sigma * 3) * 2) + 1);
  const kernel = gaussianKernel1D(sigma, size);
  const half = (size - 1) >> 1;

  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = 0; i < size; i++) {
        let xi = x + i - half;
        if (xi < 0) xi = 0;
        else if (xi >= w) xi = w - 1;
        s += data[y * w + xi] * kernel[i];
      }
      tmp[y * w + x] = s;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = 0; i < size; i++) {
        let yi = y + i - half;
        if (yi < 0) yi = 0;
        else if (yi >= h) yi = h - 1;
        s += tmp[yi * w + x] * kernel[i];
      }
      out[y * w + x] = s;
    }
  }
  return { data: out, width: w, height: h };
}

interface Gradient {
  mag: Float32Array;
  angle: Float32Array;
  width: number;
  height: number;
}

function sobel(blurred: GrayImage): Gradient {
  const { data, width: w, height: h } = blurred;
  const mag = new Float32Array(w * h);
  const angle = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = data[(y - 1) * w + (x - 1)];
      const t = data[(y - 1) * w + x];
      const tr = data[(y - 1) * w + (x + 1)];
      const l = data[y * w + (x - 1)];
      const r = data[y * w + (x + 1)];
      const bl = data[(y + 1) * w + (x - 1)];
      const b = data[(y + 1) * w + x];
      const br = data[(y + 1) * w + (x + 1)];
      const dx = -tl - 2 * l - bl + tr + 2 * r + br;
      const dy = -tl - 2 * t - tr + bl + 2 * b + br;
      const idx = y * w + x;
      mag[idx] = Math.sqrt(dx * dx + dy * dy);
      angle[idx] = Math.atan2(dy, dx);
    }
  }
  return { mag, angle, width: w, height: h };
}

function nonMaxSuppression({ mag, angle, width: w, height: h }: Gradient): GrayImage {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      let a = angle[idx] * 180 / Math.PI;
      if (a < 0) a += 180;
      let n1: number, n2: number;
      if ((a >= 0 && a < 22.5) || (a >= 157.5 && a <= 180)) {
        n1 = mag[idx - 1]; n2 = mag[idx + 1];
      } else if (a >= 22.5 && a < 67.5) {
        n1 = mag[(y + 1) * w + (x - 1)]; n2 = mag[(y - 1) * w + (x + 1)];
      } else if (a >= 67.5 && a < 112.5) {
        n1 = mag[(y - 1) * w + x]; n2 = mag[(y + 1) * w + x];
      } else {
        n1 = mag[(y - 1) * w + (x - 1)]; n2 = mag[(y + 1) * w + (x + 1)];
      }
      out[idx] = (mag[idx] >= n1 && mag[idx] >= n2) ? mag[idx] : 0;
    }
  }
  return { data: out, width: w, height: h };
}

function hysteresis(suppressed: GrayImage, lowT: number, highT: number): EdgeImage {
  const { data, width: w, height: h } = suppressed;
  const out = new Uint8ClampedArray(w * h);
  const STRONG = 255, WEAK = 75;
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] >= highT) { out[i] = STRONG; stack.push(i); }
    else if (data[i] >= lowT) { out[i] = WEAK; }
  }
  while (stack.length) {
    const idx = stack.pop()!;
    const y = (idx / w) | 0, x = idx % w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (out[ni] === WEAK) {
          out[ni] = STRONG;
          stack.push(ni);
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) if (out[i] === WEAK) out[i] = 0;
  return { data: out, width: w, height: h };
}

/** 完整 Canny 流程 */
export function canny(gray: GrayImage, lowT = 50, highT = 150, sigma = 1.4): EdgeImage {
  const blurred = gaussianBlur(gray, sigma);
  const grad = sobel(blurred);
  const sup = nonMaxSuppression(grad);
  return hysteresis(sup, lowT, highT);
}

export interface MatchResult {
  x: number;
  y: number;
  score: number;
  /** 与最佳位置不重叠（相距 ≥ 模板 0.8 宽 / 0.5 高）的次优峰；没有时为 -Infinity */
  secondScore: number;
  width: number;
  height: number;
}

/** TM_CCOEFF_NORMED 模板匹配（与 OpenCV cv2.matchTemplate 同语义），返回最佳匹配点。 */
export function matchTemplate(image: GrayImage, template: GrayImage): MatchResult {
  const { data: I, width: iw, height: ih } = image;
  const { data: T, width: tw, height: th } = template;
  const rw = iw - tw + 1;
  const rh = ih - th + 1;
  if (rw < 1 || rh < 1) {
    throw new Error(`Template (${tw}x${th}) larger than image (${iw}x${ih})`);
  }

  // Integral images make each candidate's mean and variance constant-time.
  const pitch = iw + 1;
  const sums = new Float64Array(pitch * (ih + 1));
  const squares = new Float64Array(sums.length);
  for (let y = 0; y < ih; y++) {
    let rowSum = 0, rowSquare = 0;
    for (let x = 0; x < iw; x++) {
      const value = I[y * iw + x];
      rowSum += value;
      rowSquare += value * value;
      const offset = (y + 1) * pitch + x + 1;
      sums[offset] = sums[offset - pitch] + rowSum;
      squares[offset] = squares[offset - pitch] + rowSquare;
    }
  }

  let tSum = 0;
  let tSquare = 0;
  const N = tw * th;
  const offsets = new Int32Array(N);
  const weights = new Float64Array(N);
  let active = 0;
  for (let i = 0; i < N; i++) {
    tSum += T[i];
    tSquare += T[i] * T[i];
    // Canny templates are sparse; zero pixels contribute nothing to the dot product.
    if (T[i] !== 0) {
      offsets[active] = Math.floor(i / tw) * iw + i % tw;
      weights[active++] = T[i];
    }
  }
  const tMean = tSum / N;
  const tNorm = Math.sqrt(Math.max(0, tSquare - tSum * tMean));

  let bestScore = -Infinity, bestX = 0, bestY = 0;
  // 次优峰：与当前最优位置"不重叠"的最高分，用来判断匹配是否唯一。
  let secondScore = -Infinity;
  const sepX = Math.max(1, Math.round(tw * 0.8));
  const sepY = Math.max(1, Math.round(th * 0.5));
  const isSeparate = (x: number, y: number, refX: number, refY: number): boolean =>
    Math.abs(x - refX) >= sepX || Math.abs(y - refY) >= sepY;

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const tl = y * pitch + x, tr = tl + tw;
      const bl = (y + th) * pitch + x, br = bl + tw;
      const iSum = sums[br] - sums[bl] - sums[tr] + sums[tl];
      const iSquare = squares[br] - squares[bl] - squares[tr] + squares[tl];
      const iSqSum = Math.max(0, iSquare - iSum * iSum / N);
      let dot = 0;
      const base = y * iw + x;
      for (let i = 0; i < active; i++) dot += I[base + offsets[i]] * weights[i];
      const num = dot - iSum * tMean;
      const denom = Math.sqrt(iSqSum) * tNorm;
      const score = denom > 1e-9 ? num / denom : 0;
      if (score > bestScore) {
        // 旧最优只有在远离新最优时才算独立峰（否则只是同一个峰的邻域）。
        if (bestScore > secondScore && isSeparate(bestX, bestY, x, y)) secondScore = bestScore;
        bestScore = score; bestX = x; bestY = y;
      } else if (score > secondScore && isSeparate(x, y, bestX, bestY)) {
        secondScore = score;
      }
    }
  }
  return { x: bestX, y: bestY, score: bestScore, secondScore, width: rw, height: rh };
}

/** 找到 alpha 通道的非透明像素紧致包围盒（用于 has_alpha 滑块块的自动裁剪）。
 *  返回 null 表示没有有意义的 alpha（全不透明或全透明）。*/
export function alphaBBox(imgData: ImageLike, alphaThresh = 16): BBox | null {
  const { data, width, height } = imgData;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  let transparentCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a <= alphaThresh) { transparentCount++; continue; }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  // 几乎没有透明像素 -> 不是 alpha 块；几乎全透明 -> 无效
  const total = width * height;
  if (transparentCount < total * 0.02 || transparentCount > total * 0.98 || maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 从灰度图裁剪子矩形 */
export function cropGray(gray: GrayImage, box: BBox): GrayImage {
  const { data, width: w } = gray;
  const out = new Float32Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      out[y * box.w + x] = data[(box.y + y) * w + (box.x + x)];
    }
  }
  return { data: out, width: box.w, height: box.h };
}

function toFloatEdge(edge: EdgeImage): GrayImage {
  const out = new Float32Array(edge.data.length);
  for (let i = 0; i < edge.data.length; i++) out[i] = edge.data[i];
  return { data: out, width: edge.width, height: edge.height };
}

/**
 * 掩膜内容相关性：只比较拼图块 alpha 覆盖到的像素，返回 -1..1 的灰度 NCC。
 *
 * 边缘/NCC 模板匹配只看局部边缘，遇到重复纹理背景（条纹、平铺 logo、规则图形）会出现
 * 得分不低的"竞争峰"，把缺口定到错误位置。而拼图块与缺口是**同一块内容**，逐像素
 * 相关性只在真实位置接近 1，错位时趋近 0 甚至为负——这是一个与边缘无关的独立校验。
 *
 * @param x,y 拼图块**左上角**在背景图中的坐标（不是 alpha 裁剪后的坐标）
 */
export function maskedContentScore(bg: ImageLike, piece: ImageLike, x: number, y: number): number {
  const { width: pw, height: ph, data: P } = piece;
  const { width: bw, height: bh, data: B } = bg;
  let n = 0, sumP = 0, sumI = 0, sumW = 0;
  let sPP = 0, sII = 0, sPI = 0;
  for (let py = 0; py < ph; py++) {
    const by = y + py;
    if (by < 0 || by >= bh) continue;
    for (let px = 0; px < pw; px++) {
      const pi = (py * pw + px) * 4;
      const alpha = P[pi + 3];
      if (alpha < 128) continue;
      const bx = x + px;
      if (bx < 0 || bx >= bw) continue;
      const bi = (by * bw + bx) * 4;
      const pv = 0.299 * P[pi] + 0.587 * P[pi + 1] + 0.114 * P[pi + 2];
      const iv = 0.299 * B[bi] + 0.587 * B[bi + 1] + 0.114 * B[bi + 2];
      const w = alpha / 255;
      sumP += pv * w;
      sumI += iv * w;
      sPP += pv * pv * w;
      sII += iv * iv * w;
      sPI += pv * iv * w;
      sumW += w;
      n++;
    }
  }
  if (n < 32 || sumW < 1e-6) return Number.NaN;
  const meanP = sumP / sumW;
  const meanI = sumI / sumW;
  const varP = Math.max(0, sPP / sumW - meanP * meanP);
  const varI = Math.max(0, sII / sumW - meanI * meanI);
  const cov = sPI / sumW - meanP * meanI;
  const den = Math.sqrt(varP * varI);
  return den > 1e-9 ? cov / den : 0;
}

/** 在 ±radius 像素内按内容相关性微调位置，修正边缘匹配 1~3px 的系统偏差。 */
function refineByContent(
  bg: ImageLike,
  piece: ImageLike,
  x: number,
  y: number,
  radius: number,
): { x: number; y: number; score: number } {
  let best = { x, y, score: maskedContentScore(bg, piece, x, y) };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const score = maskedContentScore(bg, piece, x + dx, y + dy);
      if (score > best.score) best = { x: x + dx, y: y + dy, score };
    }
  }
  return best;
}

/**
 * 内容直搜兜底：当边缘/灰度两条路径都校验不过时，直接按「拼图块内容」在背景上
 * 做掩膜相关性扫描。为了控制成本采用"粗扫（步长 2 + 隔点采样）→ 局部精修"，
 * 整图扫描约几十毫秒，只在可疑匹配时触发，不影响常规路径。
 */
function searchByContent(bg: ImageLike, piece: ImageLike): { x: number; y: number; score: number } {
  const { width: pw, height: ph } = piece;
  const { width: bw, height: bh } = bg;
  const maxX = bw - pw;
  const maxY = bh - ph;
  if (maxX < 0 || maxY < 0) return { x: 0, y: 0, score: Number.NaN };

  // 与校验同一个函数，避免两套归一化口径不一致（曾经因此拿到错误的次优解）。
  // 步长 2：任意真实位置都在网格点 1px 内，相关性仍然接近峰值；再局部逐像素精修。
  let best = { x: 0, y: 0, score: -2 };
  const step = 2;
  for (let y = 0; y <= maxY; y += step) {
    for (let x = 0; x <= maxX; x += step) {
      const score = maskedContentScore(bg, piece, x, y);
      if (score > best.score) best = { x, y, score };
    }
  }
  // 精修：粗扫最优附近 ±step，逐像素
  const refined = { ...best };

  for (let dy = -step; dy <= step; dy++) {
    for (let dx = -step; dx <= step; dx++) {
      const x = best.x + dx;
      const y = best.y + dy;
      if (x < 0 || y < 0 || x > maxX || y > maxY) continue;
      const score = maskedContentScore(bg, piece, x, y);
      if (score > refined.score) { refined.x = x; refined.y = y; refined.score = score; }
    }
  }

  return refined;
}

function downsampleGray(gray: GrayImage, factor: number): GrayImage {
  const { data, width: w, height: h } = gray;
  const nw = Math.floor(w / factor), nh = Math.floor(h / factor);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0, c = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          s += data[(y * factor + dy) * w + (x * factor + dx)];
          c++;
        }
      }
      out[y * nw + x] = s / c;
    }
  }
  return { data: out, width: nw, height: nh };
}

function countNonZero(arr: Uint8ClampedArray | Float32Array): number {
  let n = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] !== 0) n++;
  return n;
}

function now(): number {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/**
 * 顶层入口：滑块小图 + 背景图 → 缺口位置。
 * 见文件头注释的三步策略。返回的 x 即缺口在背景图坐标系下的左上角横坐标。
 */
export function slideMatch(
  targetImgData: ImageLike,
  bgImgData: ImageLike,
  opts: SlideMatchOptions = {},
): SlideMatchResult {
  const { lowT = 50, highT = 150, sigma = 1.4, downsample = 1, minEdgePixels = 12 } = opts;
  const t0 = now();

  // has_alpha 自动裁剪
  let cropOffset = { x: 0, y: 0 };
  const box = alphaBBox(targetImgData);
  let targetGray = toGray(targetImgData);
  let bgGray = toGray(bgImgData);
  if (box) {
    cropOffset = { x: box.x, y: box.y };
    targetGray = cropGray(targetGray, box);
  }

  if (downsample > 1) {
    targetGray = downsampleGray(targetGray, downsample);
    bgGray = downsampleGray(bgGray, downsample);
  }

  const tEdge = canny(targetGray, lowT, highT, sigma);
  const bgEdge = canny(bgGray, lowT, highT, sigma);

  const tEdgeCount = countNonZero(tEdge.data);

  let m: MatchResult;
  let method: SlideMatchResult['method'];
  const runEdge = (): MatchResult => matchTemplate(toFloatEdge(bgEdge), toFloatEdge(tEdge));
  const runGray = (): MatchResult => matchTemplate(bgGray, targetGray);
  if (tEdgeCount < minEdgePixels) {
    // 边缘太少 -> 灰度匹配兜底
    method = 'grayscale-fallback';
    m = runGray();
  } else {
    method = box ? 'edge+alpha' : 'edge';
    m = runEdge();
  }

  // native/downsample 坐标 -> 背景图原始坐标（拼图块 bbox 左上角）
  const toBgCoords = (mx: number, my: number) => ({
    x: Math.round(mx * downsample - cropOffset.x),
    y: Math.round(my * downsample - cropOffset.y),
  });

  // maskedContentScore 吃的是「拼图块图像左上角」，而 position 是 alpha 裁剪后的
  // bbox 左上角，两者相差 cropOffset —— 这里统一换算，避免校验/精修整体偏移。
  const contentAt = (p: { x: number; y: number }): number =>
    maskedContentScore(bgImgData, targetImgData, p.x - cropOffset.x, p.y - cropOffset.y);

  let position = toBgCoords(m.x, m.y);
  let contentScore = contentAt(position);

  // 内容校验失败：说明这个"高分"位置其实不是同一块内容（重复纹理的竞争峰）。
  // 用另一条匹配路径（edge ↔ gray）复算，只有内容相关性显著更高才换。
  if (Number.isFinite(contentScore) && contentScore < 0.25) {
    const alt = method === 'grayscale-fallback' ? runEdge() : runGray();
    const altPosition = toBgCoords(alt.x, alt.y);
    const altContent = contentAt(altPosition);
    if (altContent >= 0.85 && altContent > contentScore + 0.5) {
      m = alt;
      position = altPosition;
      contentScore = altContent;
      method = method === 'grayscale-fallback' ? (box ? 'edge+alpha' : 'edge') : 'grayscale-fallback';
    }
  }

  // 两条路径都校验不过：直接按拼图块内容在背景上扫一遍。
  // 这是最可靠但最贵的兜底，只在"可疑匹配"时触发。
  if (Number.isFinite(contentScore) && contentScore < 0.4) {
    const searched = searchByContent(bgImgData, targetImgData);

    if (searched.score >= 0.8 && searched.score > contentScore) {
      position = { x: searched.x + cropOffset.x, y: searched.y + cropOffset.y };
      contentScore = searched.score;
      method = 'content-search';
    }
  }

  // 内容有一定相关性时做小范围微调，消掉边缘匹配的 1~3px 量化误差。
  if (contentScore >= 0.2) {
    const refined = refineByContent(
      bgImgData,
      targetImgData,
      position.x - cropOffset.x,
      position.y - cropOffset.y,
      3,
    );
    if (refined.score > contentScore + 1e-6) {
      position = { x: refined.x + cropOffset.x, y: refined.y + cropOffset.y };
      contentScore = refined.score;
    }
  }

  const t1 = now();
  const second = Number.isFinite(m.secondScore) ? m.secondScore : 0;
  return {
    x: position.x,
    y: position.y,
    score: m.score,
    secondScore: second,
    margin: m.score - second,
    contentScore,
    method,
    targetEdgeCount: tEdgeCount,
    elapsed: t1 - t0,
    downsample,
  };
}

/**
 * 单图缺口检测（无独立滑块小图时的兜底）：在背景图上按列扫描边缘能量，
 * 找出最可能是缺口的横坐标。精度低于 slideMatch，仅在拿不到 piece 时使用。
 * score 归一化到 0..1（峰值列能量相对区间均值的突出度），供多算法融合加权。
 */
export function detectGapByColumnEdges(bgImgData: ImageLike, marginX = 0): { x: number; score: number } {
  const gray = toGray(bgImgData);
  const edge = canny(gray);
  const { data, width: w, height: h } = edge;
  const colEnergy = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += data[y * w + x];
    colEnergy[x] = s;
  }
  // 跳过最左侧 marginX（滑块初始位置通常带强边缘），取能量最高的列作为缺口左缘
  let bestX = marginX, best = -1, total = 0, span = 0;
  for (let x = Math.max(marginX, 2); x < w - 2; x++) {
    total += colEnergy[x];
    span++;
    if (colEnergy[x] > best) { best = colEnergy[x]; bestX = x; }
  }
  const mean = span > 0 ? total / span : 0;
  const score = mean > 1e-6 ? Math.max(0, Math.min(1, best / (mean * 6))) : 0;
  return { x: bestX, score };
}

/**
 * 单图缺口检测（亮度梯度法）：与 detectGapByColumnEdges 的 Canny 边缘能量互补——
 * 看「列平均亮度的横向突变」，缺口边界处亮度梯度大。作为多算法融合的第三路。
 * score 同样归一化到 0..1。
 */
export function detectGapByBrightness(bgImgData: ImageLike, marginX = 0): { x: number; score: number } {
  const gray = toGray(bgImgData);
  const { data, width: w, height: h } = gray;
  const colMean = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += data[y * w + x];
    colMean[x] = s / Math.max(1, h);
  }
  const grad = new Float32Array(w);
  for (let x = 1; x < w; x++) grad[x] = Math.abs(colMean[x] - colMean[x - 1]);
  let bestX = marginX, best = -1, total = 0, span = 0;
  for (let x = Math.max(marginX, 2); x < w - 2; x++) {
    const e = grad[x - 1] + grad[x] + grad[x + 1]; // 3 列窗口聚合，抗单列噪声
    total += e;
    span++;
    if (e > best) { best = e; bestX = x; }
  }
  const mean = span > 0 ? total / span : 0;
  const score = mean > 1e-6 ? Math.max(0, Math.min(1, best / (mean * 6))) : 0;
  return { x: bestX, score };
}

export interface GapCandidate {
  /** 缺口横坐标（背景图 native px） */
  x: number;
  /** 该方法的归一化置信度 0..1 */
  conf: number;
  method: string;
  /** 方法权重（模板匹配最高） */
  weight?: number;
}

export interface FusedGap {
  x: number;
  /** 聚合置信度（簇内加权和） */
  conf: number;
  method: string;
  /** 落在容差内、彼此印证的候选数 */
  agree: number;
}

/**
 * 多算法缺口融合：把各方法的候选按横坐标聚类，取「加权置信度之和」最高的簇，
 * 返回簇内加权平均横坐标。多个方法在邻近 x 互相印证时综合置信度更高（投票），
 * 单算法的偶发误判被其余方法稀释。
 */
export function fuseGapCandidates(cands: GapCandidate[], tolerance = 8): FusedGap | null {
  const valid = cands.filter((c) => Number.isFinite(c.x) && c.x >= 0);
  if (valid.length === 0) return null;
  let best: FusedGap | null = null;
  for (const anchor of valid) {
    let wx = 0, wsum = 0, agree = 0;
    const methods: string[] = [];
    for (const c of valid) {
      if (Math.abs(c.x - anchor.x) <= tolerance) {
        const wgt = (c.weight ?? 1) * Math.max(0.05, c.conf);
        wx += c.x * wgt;
        wsum += wgt;
        agree++;
        methods.push(c.method);
      }
    }
    const cx = wsum > 0 ? wx / wsum : anchor.x;
    if (!best || wsum > best.conf) {
      best = { x: cx, conf: wsum, method: methods.join('+'), agree };
    }
  }
  return best;
}

