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
  method: 'edge' | 'edge+alpha' | 'grayscale-fallback';
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

  // 模板均值与零均值平方和
  let tSum = 0;
  const N = tw * th;
  for (let i = 0; i < N; i++) tSum += T[i];
  const tMean = tSum / N;
  let tSqSum = 0;
  const Tn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    Tn[i] = T[i] - tMean;
    tSqSum += Tn[i] * Tn[i];
  }
  const tNorm = Math.sqrt(tSqSum);

  let bestScore = -Infinity, bestX = 0, bestY = 0;

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      let iSum = 0;
      for (let dy = 0; dy < th; dy++) {
        const rowOff = (y + dy) * iw + x;
        for (let dx = 0; dx < tw; dx++) {
          iSum += I[rowOff + dx];
        }
      }
      const iMean = iSum / N;

      let num = 0, iSqSum = 0;
      for (let dy = 0; dy < th; dy++) {
        const rowOff = (y + dy) * iw + x;
        const tRowOff = dy * tw;
        for (let dx = 0; dx < tw; dx++) {
          const v = I[rowOff + dx] - iMean;
          num += v * Tn[tRowOff + dx];
          iSqSum += v * v;
        }
      }
      const denom = Math.sqrt(iSqSum) * tNorm;
      const score = denom > 1e-9 ? num / denom : 0;
      if (score > bestScore) {
        bestScore = score; bestX = x; bestY = y;
      }
    }
  }
  return { x: bestX, y: bestY, score: bestScore, width: rw, height: rh };
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
  if (tEdgeCount < minEdgePixels) {
    // 边缘太少 -> 灰度匹配兜底
    method = 'grayscale-fallback';
    m = matchTemplate(bgGray, targetGray);
  } else {
    method = box ? 'edge+alpha' : 'edge';
    m = matchTemplate(toFloatEdge(bgEdge), toFloatEdge(tEdge));
  }

  const t1 = now();
  return {
    x: m.x * downsample - cropOffset.x,
    y: m.y * downsample - cropOffset.y,
    score: m.score,
    method,
    targetEdgeCount: tEdgeCount,
    elapsed: t1 - t0,
    downsample,
  };
}

/**
 * 单图缺口检测（无独立滑块小图时的兜底）：在背景图上按列扫描边缘能量，
 * 找出最可能是缺口的横坐标。精度低于 slideMatch，仅在拿不到 piece 时使用。
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
  let bestX = marginX, best = -1;
  for (let x = Math.max(marginX, 2); x < w - 2; x++) {
    if (colEnergy[x] > best) { best = colEnergy[x]; bestX = x; }
  }
  return { x: bestX, score: best };
}
