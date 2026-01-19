import { ImageProcessor } from './image-processor';
import type { OCRResult } from './types';

declare const ort: any;
declare const unsafeWindow: any;

export interface OCREngineOptions {
  getModel: () => Promise<{ model: ArrayBuffer; charsets: string[] }>;
  getOrt?: () => Promise<any>;
  wasmPaths?: string;
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
      } catch (e) {}
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
    const targetWidth = Math.floor(width * (targetHeight / height));
    const resized = ImageProcessor.resize(data, width, height, targetWidth, targetHeight);
    const normalized = ImageProcessor.normalize(resized);
    const tensor = new this.ort.Tensor('float32', normalized, [1, 1, targetHeight, targetWidth]);
    const feeds = { input1: tensor };
    const results = await this.session.run(feeds);
    const output = results.output;
    const text = this.decodeOutput(output);
    console.log(`✅ 识别完成: ${text} (耗时: ${Date.now() - startTime}ms)`);
    return { text };
  }

  private decodeOutput(output: any): string {
    const indices = this.convertToNumberArray(output.data);
    const result: string[] = [];
    let lastChar = '';
    for (const idx of indices) {
      if (idx <= 0 || idx >= this.charsets.length) continue;
      const char = this.charsets[idx];
      if (!char || char === lastChar) continue;
      result.push(char);
      lastChar = char;
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