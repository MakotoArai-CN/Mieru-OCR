import { CaptchaDetector } from '../../src/core/captcha-detector';
import { AutoFill } from '../../src/core/auto-fill';
import { OCREngine } from '../../src/core/ocr-engine';

const results: string[] = [];
function check(value: unknown, name: string): asserts value {
  if (!value) throw new Error(name);
  results.push(name);
}

async function run() {
  const form = document.querySelector('form')!;
  const canvas = document.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  ctx.font = '32px Arial';
  ctx.fillText('1234', 8, 35);

  const detector = new CaptchaDetector();
  const initial = detector.scan();
  const first = initial.find(captcha => captcha.element === canvas);
  check(first, 'Initial scan finds the captcha');
  let queries = 0;
  const original = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((...args: Parameters<typeof original>) => {
    queries++;
    return original(...args);
  }) as typeof document.querySelectorAll;
  try {
    for (let i = 0; i < 5; i++) detector.scanCached();
    check(queries === 0, 'Cached scans avoid full-document queries');
    const newCanvas = canvas.cloneNode() as HTMLCanvasElement;
    newCanvas.id = 'captcha-second';
    form.appendChild(newCanvas);
    detector.invalidateScan(newCanvas);
    const changed = detector.scanCached();
    check(changed.some(captcha => captcha.element === newCanvas), 'Local scan discovers a newly inserted captcha');
    check(changed.find(captcha => captcha.element === canvas)?.id === first.id, 'Element IDs remain stable across local scans');
    check(queries === 0, 'Local scan avoids full-document queries');
    newCanvas.remove();
    check(!detector.scanCached().some(captcha => captcha.element === newCanvas), 'Removed elements leave the scan cache');
  } finally {
    document.querySelectorAll = original;
  }

  const input = document.querySelector<HTMLInputElement>('#captcha-input')!;
  const name = document.querySelector<HTMLInputElement>('#name')!;
  name.focus();
  const changes: string[] = [];
  input.addEventListener('input', () => changes.push(input.value));
  await new AutoFill().fill(input, '1234', { typewriterEffect: false, preserveFocus: true });
  check(input.value === '1234' && changes.includes('1234'), 'Autofill dispatches input changes');
  check(document.activeElement === name, 'Autofill preserves the active input');

  const ort = (globalThis as any).ort;
  ort.env.wasm.wasmPaths = '/runtime/';
  ort.env.wasm.numThreads = 1;
  const engine = new OCREngine({
    getOrt: async () => ort,
    getModel: async () => ({
      model: await (await fetch('/runtime/common.onnx')).arrayBuffer(),
      charsets: await (await fetch('/runtime/charsets.json')).json(),
    }),
  });
  const recognized = await engine.recognize(canvas.toDataURL());
  check(recognized.text === '1234', 'Production WASM runtime recognizes 1234');
  await engine.destroy();

  const worker = new Worker('/runtime/slider-worker.js');
  try {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const response: any = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker timeout')), 10000);
      worker.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
      worker.postMessage({ id: 1, target: image, background: image });
    });
    check(response.result?.x === 0 && response.result?.y === 0, 'Production worker returns matching coordinates');
  } finally {
    worker.terminate();
  }
  (globalThis as any).regression = { passed: true, results };
  document.querySelector('pre')!.textContent = results.join('\n');
}

run().catch(error => {
  (globalThis as any).regression = { passed: false, results, error: String(error) };
  document.querySelector('pre')!.textContent = results.join('\n') + '\nFAIL: ' + error;
  console.error(error);
});
