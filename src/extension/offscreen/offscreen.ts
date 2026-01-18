import { OCREngine } from '@core/ocr-engine';

let ocrEngine: OCREngine | null = null;

function configureOrt(ort: any): void {
  const cfg = (globalThis as any).ortConfig || {};
  const base: string = cfg.base || chrome.runtime.getURL('/');

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = base;

  ort.env.logLevel = 'error';
}

function getOrtGlobal(): any {
  return (globalThis as any).ort;
}

async function getOCREngine(): Promise<OCREngine> {
  if (ocrEngine) return ocrEngine;

  const ort = getOrtGlobal();
  if (!ort) {
    throw new Error('ort.min.js 未加载或全局 ort 不存在');
  }

  configureOrt(ort);

  ocrEngine = new OCREngine({
    getModel: async () => {
      const [modelRes, charsetsRes] = await Promise.all([
        fetch(chrome.runtime.getURL('common.onnx')),
        fetch(chrome.runtime.getURL('charsets.json'))
      ]);
      return {
        model: await modelRes.arrayBuffer(),
        charsets: await charsetsRes.json()
      };
    },
    getOrt: async () => ort,
    wasmPaths: chrome.runtime.getURL('/'),
  });

  await ocrEngine.init();
  return ocrEngine;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'offscreen:recognize') {
    handleRecognize(message, sendResponse);
    return true;
  }
  return false;
});

async function handleRecognize(message: any, sendResponse: (response: any) => void) {
  try {
    const engine = await getOCREngine();

    if (message.imageData) {
      const result = await engine.recognize(message.imageData);
      sendResponse({ success: true, text: result.text });
      return;
    }

    sendResponse({ success: false, error: '缺少图像数据' });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

console.log('✅ Offscreen OCR 初始化完成');