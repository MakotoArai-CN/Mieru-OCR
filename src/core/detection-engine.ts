import type { ImageLike } from './slide-detector';

declare const ort: any;
declare const unsafeWindow: any;

/** 一个检测框（原图坐标系，左上角 + 宽高）。 */
export interface DetectionBox {
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface DetectionEngineOptions {
  /** 返回 det 模型的 ArrayBuffer（与 OCREngine.getModel 同构，但不含 charsets）。 */
  getModel: () => Promise<{ model: ArrayBuffer }>;
  getOrt?: () => Promise<any>;
  wasmPaths?: string;
  /**
   * WASM 线程数。缺省时**不改动** `ort.env.wasm.numThreads`，沿用当前 realm 已有配置——
   * 这点很关键：扩展的 offscreen / Firefox 背景页里 OCR 引擎已把它设为 1（无跨源隔离、
   * 无 SharedArrayBuffer），检测引擎若强行设 4 会让会话创建失败或退化。需要多线程的
   * 环境（如同源 playground）可显式传入。
   */
  numThreads?: number;
  /** YOLOX 输入边长，固定 416。 */
  inputSize?: number;
  /** 置信度阈值，ddddocr 原生默认 0.1。 */
  scoreThreshold?: number;
  /** NMS IoU 阈值，ddddocr 原生默认 0.45。 */
  nmsIou?: number;
}

interface GridCell {
  gx: number;
  gy: number;
  stride: number;
}

/**
 * ddddocr 原生目标检测模型（common_det.onnx，YOLOX 风格）的 onnxruntime-web 移植。
 *
 * 预处理（与 ddddocr `get_bbox`/`preproc` 完全对齐）：
 * - 等比缩放 + 右/下方向灰色 (114,114,114) 填充到 416×416；
 * - 通道顺序 **BGR**（ddddocr 用 cv2.imdecode 读图，默认 BGR，且 det 路径不做 RGB→BGR 转换）；
 * - 像素 **不归一化**，保持 0-255 的 float32（模型内部自带归一化层）；
 * - 张量布局 (1,3,416,416) CHW。
 *
 * 后处理（`demo_postprocess` + `multiclass_nms`）：
 * - strides [8,16,32] 网格解码：cx=(x+gx)*s, cy=(y+gy)*s, w=exp(w)*s, h=exp(h)*s；
 * - score = obj * max(cls)（单类时即 obj）；阈值 0.1；
 * - cxcywh→xyxy，按缩放比 r 还原到原图，NMS IoU 0.45，clamp 到原图边界。
 */
export class DetectionEngine {
  private session: any = null;
  private ort: any = null;
  private initialized = false;
  private options: DetectionEngineOptions;
  private readonly inputSize: number;
  private readonly scoreThreshold: number;
  private readonly nmsIou: number;
  private grid: GridCell[] | null = null;

  constructor(options: DetectionEngineOptions) {
    this.options = options;
    this.inputSize = options.inputSize ?? 416;
    this.scoreThreshold = options.scoreThreshold ?? 0.1;
    this.nmsIou = options.nmsIou ?? 0.45;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    console.log('🔧 初始化目标检测引擎...');

    this.ort = this.options.getOrt ? await this.options.getOrt() : await this.waitForOrt();
    if (!this.ort) throw new Error('ONNX Runtime 未找到');

    if (this.options.wasmPaths) {
      this.ort.env.wasm.wasmPaths = this.options.wasmPaths;
    }
    // 仅在显式给定时设置线程数；否则保留 realm 现有值（见 numThreads 选项注释）。
    if (this.options.numThreads != null) {
      this.ort.env.wasm.numThreads = this.options.numThreads;
    }
    this.ort.env.wasm.simd = true;
    this.ort.env.logLevel = 'error';

    const { model } = await this.options.getModel();
    console.log('🚀 创建检测推理会话...');
    this.session = await this.ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    this.initialized = true;
    console.log('✅ 目标检测引擎已就绪');
  }

  isReady(): boolean {
    return this.initialized && !!this.session;
  }

  private async waitForOrt(): Promise<any> {
    const getOrtInstance = (): any => {
      if (typeof ort !== 'undefined') return ort;
      if (typeof window !== 'undefined' && (window as any).ort) return (window as any).ort;
      if (typeof globalThis !== 'undefined' && (globalThis as any).ort) return (globalThis as any).ort;
      try {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.ort) return unsafeWindow.ort;
      } catch (e) { /* ignore */ }
      return null;
    };

    let instance = getOrtInstance();
    if (instance) return instance;

    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      instance = getOrtInstance();
      if (instance) return instance;
    }
    throw new Error('等待 ort 超时');
  }

  /**
   * 检测图中所有目标框。输入是 RGBA 像素（如 canvas getImageData），返回原图坐标系的框。
   * 按置信度降序排序。
   */
  async detect(image: ImageLike): Promise<DetectionBox[]> {
    if (!this.initialized || !this.session) {
      await this.init();
    }

    const S = this.inputSize;
    const { data, width: srcW, height: srcH } = image;
    const r = Math.min(S / srcH, S / srcW);
    const newW = Math.max(1, Math.round(srcW * r));
    const newH = Math.max(1, Math.round(srcH * r));

    // CHW，预填 114（灰色 letterbox 填充）；缩放区域随后覆盖。
    const plane = S * S;
    const chw = new Float32Array(3 * plane);
    chw.fill(114);
    const planeB = 0;
    const planeG = plane;
    const planeR = 2 * plane;

    const xRatio = srcW / newW;
    const yRatio = srcH / newH;
    for (let y = 0; y < newH; y++) {
      const py = y * yRatio;
      const y1 = Math.floor(py);
      const y2 = Math.min(y1 + 1, srcH - 1);
      const fy = py - y1;
      for (let x = 0; x < newW; x++) {
        const px = x * xRatio;
        const x1 = Math.floor(px);
        const x2 = Math.min(x1 + 1, srcW - 1);
        const fx = px - x1;
        const wa = (1 - fx) * (1 - fy);
        const wb = fx * (1 - fy);
        const wc = (1 - fx) * fy;
        const wd = fx * fy;
        const i11 = (y1 * srcW + x1) * 4;
        const i12 = (y1 * srcW + x2) * 4;
        const i21 = (y2 * srcW + x1) * 4;
        const i22 = (y2 * srcW + x2) * 4;
        const R = data[i11] * wa + data[i12] * wb + data[i21] * wc + data[i22] * wd;
        const G = data[i11 + 1] * wa + data[i12 + 1] * wb + data[i21 + 1] * wc + data[i22 + 1] * wd;
        const B = data[i11 + 2] * wa + data[i12 + 2] * wb + data[i21 + 2] * wc + data[i22 + 2] * wd;
        const off = y * S + x;
        chw[planeB + off] = B;
        chw[planeG + off] = G;
        chw[planeR + off] = R;
      }
    }

    const inputName = this.session.inputNames?.[0] ?? 'images';
    const tensor = new this.ort.Tensor('float32', chw, [1, 3, S, S]);
    const results = await this.session.run({ [inputName]: tensor });
    const outName = this.session.outputNames?.[0] ?? Object.keys(results)[0];
    const out = results[outName];

    return this.decode(out, r, srcW, srcH);
  }

  /** 解码 YOLOX 原始输出 → 原图坐标系的框（已 NMS）。 */
  private decode(output: any, ratio: number, srcW: number, srcH: number): DetectionBox[] {
    const dims: number[] = output.dims || output.shape;
    const numAnchors = dims[1];
    const step = dims[2];
    const data: Float32Array = output.data;

    const grid = this.getGrid(numAnchors);

    const boxes: DetectionBox[] = [];
    for (let a = 0; a < numAnchors; a++) {
      const off = a * step;
      const obj = data[off + 4];
      let cls = 1;
      const numClasses = step - 5;
      if (numClasses >= 1) {
        cls = data[off + 5];
        for (let c = 1; c < numClasses; c++) {
          const v = data[off + 5 + c];
          if (v > cls) cls = v;
        }
      }
      const score = obj * cls;
      if (score < this.scoreThreshold) continue;

      const cell = grid[a];
      const cx = (data[off] + cell.gx) * cell.stride;
      const cy = (data[off + 1] + cell.gy) * cell.stride;
      const bw = Math.exp(data[off + 2]) * cell.stride;
      const bh = Math.exp(data[off + 3]) * cell.stride;

      // cxcywh → xyxy，再按 ratio 还原到原图
      let x1 = (cx - bw / 2) / ratio;
      let y1 = (cy - bh / 2) / ratio;
      let x2 = (cx + bw / 2) / ratio;
      let y2 = (cy + bh / 2) / ratio;
      x1 = Math.max(0, Math.min(x1, srcW));
      y1 = Math.max(0, Math.min(y1, srcH));
      x2 = Math.max(0, Math.min(x2, srcW));
      y2 = Math.max(0, Math.min(y2, srcH));
      if (x2 <= x1 || y2 <= y1) continue;

      boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, conf: score });
    }

    return this.nms(boxes);
  }

  /** 生成 / 缓存 strides [8,16,32] 的网格（anchor 顺序与 ddddocr demo_postprocess 一致）。 */
  private getGrid(expectedAnchors: number): GridCell[] {
    if (this.grid && this.grid.length === expectedAnchors) return this.grid;
    const S = this.inputSize;
    const strides = [8, 16, 32];
    const grid: GridCell[] = [];
    for (const stride of strides) {
      const hsize = Math.floor(S / stride);
      const wsize = Math.floor(S / stride);
      for (let gy = 0; gy < hsize; gy++) {
        for (let gx = 0; gx < wsize; gx++) {
          grid.push({ gx, gy, stride });
        }
      }
    }
    this.grid = grid;
    return grid;
  }

  /** 标准贪心 NMS（IoU 阈值 this.nmsIou）。 */
  private nms(boxes: DetectionBox[]): DetectionBox[] {
    boxes.sort((a, b) => b.conf - a.conf);
    const keep: DetectionBox[] = [];
    const suppressed = new Array(boxes.length).fill(false);
    for (let i = 0; i < boxes.length; i++) {
      if (suppressed[i]) continue;
      const a = boxes[i];
      keep.push(a);
      for (let j = i + 1; j < boxes.length; j++) {
        if (suppressed[j]) continue;
        if (this.iou(a, boxes[j]) > this.nmsIou) suppressed[j] = true;
      }
    }
    return keep;
  }

  private iou(a: DetectionBox, b: DetectionBox): number {
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;
    const bx2 = b.x + b.w;
    const by2 = b.y + b.h;
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const union = a.w * a.h + b.w * b.h - inter;
    return union <= 0 ? 0 : inter / union;
  }

  async destroy(): Promise<void> {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.initialized = false;
  }
}
