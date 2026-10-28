import { OCREngine } from '@core/ocr-engine';
import { DetectionEngine } from '@core/detection-engine';
import { EnginePool } from '@core/engine-pool';
import { BUILTIN_MODEL_ID, getBundledModel, getModelData, getDetModelData } from './model-store';

interface ModelEngineOptions {
  getOrt: () => Promise<any>;
  getURL: (path: string) => string;
  getActiveModelId: () => Promise<string>;
  ensureDetectionModel?: () => Promise<void>;
}

/** 传给任务回调的附加信息：命中「自定义模型初始化失败 → 回退内置模型」时非空。 */
export interface OCRUseContext {
  fallbackFrom?: string;
}

export function createModelEngines(options: ModelEngineOptions) {
  async function buildOCR(id: string): Promise<OCREngine> {
    const def = getBundledModel(id);
    const engine = new OCREngine({
      getOrt: options.getOrt,
      wasmPaths: options.getURL('/'),
      numThreads: 1,
      fixedWidth: def?.fixedWidth,
      preprocess: def?.preprocess,
      preprocessMean: def?.preprocessMean,
      preprocessStd: def?.preprocessStd,
      getModel: async () => {
        if (def) {
          const [model, charsets] = await Promise.all([
            fetch(options.getURL(def.modelFile)), fetch(options.getURL(def.charsetsFile)),
          ]);
          if (!model.ok || !charsets.ok) throw new Error('Bundled model could not be loaded');
          return { model: await model.arrayBuffer(), charsets: await charsets.json() };
        }
        const data = await getModelData(id);
        if (!data) throw new Error(`Model ${id} not found`);
        return { model: data.modelBlob, charsets: data.charsets };
      },
    });
    await engine.init();
    return engine;
  }

  const ocr = new EnginePool(buildOCR);
  const detection = new EnginePool(async () => {
    const engine = new DetectionEngine({
      getOrt: options.getOrt,
      wasmPaths: options.getURL('/'),
      numThreads: 1,
      getModel: async () => {
        let model = await getDetModelData();
        if (!model && options.ensureDetectionModel) {
          await options.ensureDetectionModel();
          model = await getDetModelData();
        }
        if (!model) throw new Error('DET_NOT_PROVISIONED');
        return { model };
      },
    });
    await engine.init();
    return engine;
  }, 1);

  return {
    async useOCR<T>(task: (engine: OCREngine, modelId: string, ctx: OCRUseContext) => Promise<T>): Promise<T> {
      const id = await options.getActiveModelId().catch(() => BUILTIN_MODEL_ID);
      let started = false;
      const ctx: OCRUseContext = {};
      try {
        return await ocr.use(id, engine => {
          started = true;
          return task(engine, id, ctx);
        });
      } catch (error) {
        if (started || id === BUILTIN_MODEL_ID) throw error;
        // 回退本身是合理的兜底，但必须让调用链知道「结果不是用户选中的模型给的」，
        // 否则自定义模型损坏时会静默返回通用模型的错误识别文本。
        console.warn('Model initialization failed; using builtin model:', error);
        ctx.fallbackFrom = id;
        return ocr.use(BUILTIN_MODEL_ID, engine => task(engine, BUILTIN_MODEL_ID, ctx));
      }
    },
    useDetection<T>(task: (engine: DetectionEngine) => Promise<T>): Promise<T> {
      return detection.use('det', task);
    },
    invalidateOCR: (id?: string) => ocr.invalidate(id),
    invalidateDetection: () => detection.invalidate(),
    async smokeTest(id: string): Promise<void> {
      const engine = await buildOCR(id);
      await engine.destroy();
    },
  };
}
