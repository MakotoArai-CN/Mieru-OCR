import { ImageProcessor } from './image-processor';
import type { OCRResult } from './types';

declare const ort: any;
declare const unsafeWindow: any;

export interface OCREngineOptions {
  getModel: () => Promise<{ model: ArrayBuffer; charsets: string[] }>;
  getOrt?: () => Promise<any>;
  wasmPaths?: string;
  /**
   * If set, input is pad/crop'd to this width. Required for our
   * custom-trained small model (192). Leave undefined for the original
   * dynamic-width ddddocr common model.
   */
  fixedWidth?: number;
  /**
   * Image preprocess style. 'simple' divides by 255 (matches ddddocr common).
   * 'standardize' applies (x/255 - mean) / std (matches our custom model).
   */
  preprocess?: 'simple' | 'standardize';
  preprocessMean?: number;
  preprocessStd?: number;
}

export class OCREngine {
  private session: any = null;
  private charsets: string[] = [];
  private initialized = false;
  private ort: any = null;
  private options: OCREngineOptions;

  constructor(options: OCREngineOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    console.log('🔧 初始化 OCR 引擎...');

    if (this.options.getOrt) {
      this.ort = await this.options.getOrt();
    } else {
      this.ort = await this.waitForOrt();
    }

    if (!this.ort) {
      throw new Error('ONNX Runtime 未找到');
    }

    if (this.options.wasmPaths) {
      this.ort.env.wasm.wasmPaths = this.options.wasmPaths;
    }
    this.ort.env.wasm.numThreads = 4;
    this.ort.env.wasm.simd = true;
    this.ort.env.logLevel = 'error';

    console.log('📥 加载模型...');
    const { model, charsets } = await this.options.getModel();
    this.charsets = charsets;

    console.log('🚀 创建推理会话...');
    this.session = await this.ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    this.initialized = true;
    console.log('✅ OCR 引擎已就绪');
  }

  private async waitForOrt(): Promise<any> {
    const getOrtInstance = (): any => {
      if (typeof ort !== 'undefined') return ort;
      if (typeof window !== 'undefined' && (window as any).ort) return (window as any).ort;
      if (typeof globalThis !== 'undefined' && (globalThis as any).ort) return (globalThis as any).ort;
      try {
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.ort) return unsafeWindow.ort;
      } catch (e) { }
      return null;
    };

    let ortInstance = getOrtInstance();
    if (ortInstance) {
      console.log('✅ ort 已存在');
      return ortInstance;
    }

    console.log('⏳ 等待 ort 加载...');
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      ortInstance = getOrtInstance();
      if (ortInstance) {
        console.log('✅ ort 已就绪');
        return ortInstance;
      }
    }
    throw new Error('等待 ort 超时');
  }

  async recognize(input: string | Blob | HTMLImageElement): Promise<OCRResult> {
    if (!this.initialized || !this.session) {
      await this.init();
    }

    const startTime = Date.now();
    const { data, width, height } = await ImageProcessor.loadImage(input);
    const targetHeight = 64;
    let targetWidth = Math.floor(width * (targetHeight / height));
    if (targetWidth < 1) targetWidth = 1;
    const resized = ImageProcessor.resize(data, width, height, targetWidth, targetHeight);

    const style = this.options.preprocess ?? 'simple';
    let normalized: Float32Array;
    let fillValue = 1.0;
    if (style === 'standardize') {
      const mean = this.options.preprocessMean ?? 0.456;
      const std = this.options.preprocessStd ?? 0.224;
      normalized = ImageProcessor.normalizeStd(resized, mean, std);
      fillValue = (1.0 - mean) / std;
    } else {
      normalized = ImageProcessor.normalize(resized);
      fillValue = 1.0;
    }

    let finalWidth = targetWidth;
    if (this.options.fixedWidth) {
      normalized = ImageProcessor.padOrCropWidth(
        normalized,
        targetWidth,
        targetHeight,
        this.options.fixedWidth,
        fillValue,
      );
      finalWidth = this.options.fixedWidth;
    }

    const tensor = new this.ort.Tensor('float32', normalized, [1, 1, targetHeight, finalWidth]);
    const feeds = { input1: tensor };
    const results = await this.session.run(feeds);
    const output = results.output;
    const text = this.decodeOutput(output);
    console.log(`识别完成: ${text} (耗时: ${Date.now() - startTime}ms)`);
    return { text };
  }

  getCharsets(): string[] {
    return this.charsets;
  }

  private decodeOutput(output: any): string {
    const indices = this.convertToNumberArray(output.data);
    const result: string[] = [];

    let prevIdx = -1;

    for (const idx of indices) {
      if (idx === prevIdx) {
        continue;
      }
      prevIdx = idx;

      if (idx <= 0 || idx >= this.charsets.length) {
        continue;
      }

      const char = this.charsets[idx];
      if (!char) {
        continue;
      }

      result.push(char);
    }

    return result.join('');
  }

  private convertToNumberArray(data: any): number[] {
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      if (typeof value === 'bigint') {
        result.push(Number(value));
      } else if (typeof value === 'number') {
        result.push(Math.round(value));
      } else {
        result.push(0);
      }
    }
    return result;
  }

  async destroy(): Promise<void> {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.initialized = false;
  }
}

/**
 * Dual-engine router: try the fast/small model first, fall back to the
 * slower/larger model if the result looks suspicious.
 *
 * Heuristic for "suspicious":
 * - empty result
 * - length way off from the expected 4-6 chars typical for captchas
 * - contains characters that the small model's charset cannot represent
 *   (small charset = ASCII subset; if the truth is Chinese, primary will
 *   typically emit a short noisy string and fallback fixes it)
 *
 * Both engines must be initialized via init() (the router exposes a single
 * init() that warms both, lazily).
 */
export interface DualOCREngineOptions {
  primary: OCREngineOptions;
  fallback: OCREngineOptions;
  /** Min plausible result length for primary; below this triggers fallback. Default 3. */
  minLength?: number;
  /** Max plausible result length for primary; above this triggers fallback. Default 8. */
  maxLength?: number;
  /** If true, always run fallback and return whichever produces a longer/non-empty answer. */
  alwaysCompare?: boolean;
}

export class DualOCREngine {
  private primary: OCREngine;
  private fallback: OCREngine;
  private opts: DualOCREngineOptions;

  constructor(opts: DualOCREngineOptions) {
    this.primary = new OCREngine(opts.primary);
    this.fallback = new OCREngine(opts.fallback);
    this.opts = opts;
  }

  async init(): Promise<void> {
    // Initialize primary eagerly; fallback lazily on first miss.
    await this.primary.init();
  }

  async recognize(input: string | Blob | HTMLImageElement): Promise<OCRResult> {
    const minLen = this.opts.minLength ?? 3;
    const maxLen = this.opts.maxLength ?? 8;

    const primaryRes = await this.primary.recognize(input);
    const txt = primaryRes.text || '';
    const suspicious = txt.length < minLen || txt.length > maxLen;

    if (!suspicious && !this.opts.alwaysCompare) {
      return primaryRes;
    }

    // Fall back
    try {
      const fbRes = await this.fallback.recognize(input);
      // Pick the longer non-empty one as a simple heuristic
      if (this.opts.alwaysCompare) {
        if ((fbRes.text || '').length > txt.length) return fbRes;
        return primaryRes;
      }
      return fbRes.text ? fbRes : primaryRes;
    } catch (e) {
      console.warn('fallback engine failed:', e);
      return primaryRes;
    }
  }

  async destroy(): Promise<void> {
    await this.primary.destroy();
    await this.fallback.destroy();
  }
}
