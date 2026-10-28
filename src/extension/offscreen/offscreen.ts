import { labelBoxesWithEngines, decodeDataURLToImage } from '@core/interaction/click-select-solver';
import { BUILTIN_MODEL_ID } from '../model-store';
import { createModelEngines } from '../model-engines';
import { matchSliderImages } from '../slider-worker-client';

const engines = createModelEngines({
  getURL: path => chrome.runtime.getURL(path),
  getOrt: async () => {
    const ort = (globalThis as any).ort;
    if (!ort) throw new Error('ort.min.js 未加载或全局 ort 不存在');
    ort.env.wasm.proxy = false;
    return ort;
  },
  getActiveModelId: async () => {
    const response = await chrome.runtime.sendMessage({ action: 'getActiveModelId' });
    return response?.success && response.modelId ? response.modelId : BUILTIN_MODEL_ID;
  },
});

chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: any) => {
  if (message?.action === 'offscreen:ping') {
    sendResponse({ ready: true });
    return false;
  }
  if (!['offscreen:recognize', 'offscreen:detect-text', 'offscreen:match-slider', 'offscreen:invalidate-model',
    'offscreen:invalidate-det-model', 'offscreen:smoke-test'].includes(message?.action)) return false;
  handleMessage(message).then(sendResponse, error => sendResponse({ success: false, error: error.message }));
  return true;
});

async function handleMessage(message: any): Promise<any> {
  if (message.action === 'offscreen:match-slider') {
    return { success: true, result: await matchSliderImages(message.targetData, message.backgroundData) };
  }
  if (message.action === 'offscreen:invalidate-model') {
    await engines.invalidateOCR(message.modelId);
    return { success: true };
  }
  if (message.action === 'offscreen:invalidate-det-model') {
    await engines.invalidateDetection();
    return { success: true };
  }
  if (message.action === 'offscreen:smoke-test') {
    if (!message.modelId) throw new Error('missing modelId');
    await engines.smokeTest(message.modelId);
    return { success: true };
  }
  if (!message.imageData) throw new Error('缺少图像数据');
  if (message.action === 'offscreen:recognize') {
    return engines.useOCR(async (engine, modelId, ctx) => {
      const start = Date.now();
      const result = await engine.recognize(message.imageData);
      return {
        success: true,
        text: result.text,
        elapsed: Date.now() - start,
        modelId,
        // 非空表示自定义模型加载失败、本次结果来自内置模型——UI 需要能提示用户。
        fallbackFrom: ctx.fallbackFrom,
      };
    });
  }
  const start = Date.now();
  const image = await decodeDataURLToImage(message.imageData);
  const boxes = await engines.useDetection(det =>
    engines.useOCR(ocr => labelBoxesWithEngines(image, det, ocr)));
  return { success: true, boxes, elapsed: Date.now() - start };
}

console.log('Offscreen OCR 初始化完成（多模型支持）');
