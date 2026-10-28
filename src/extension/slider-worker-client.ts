import type { ImageLike, SlideMatchResult } from '@core/slide-detector';
import { decodeDataURLToImage } from '@core/interaction/click-select-solver';
import { api } from './platform';

let worker: Worker | null = null;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const jobs = new Map<number, { resolve: (result: SlideMatchResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function stop(error?: Error): void {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  for (const job of jobs.values()) {
    clearTimeout(job.timer);
    job.reject(error || new Error('Slider worker stopped'));
  }
  jobs.clear();
}

function match(target: ImageLike, background: ImageLike): Promise<SlideMatchResult> {
  clearTimeout(idleTimer);
  if (!worker) {
    worker = new Worker(api.runtime.getURL('slider-worker.js'));
    worker.onerror = event => stop(new Error(event.message || 'Slider worker failed'));
    worker.onmessage = event => {
      const job = jobs.get(event.data.id);
      if (!job) return;
      clearTimeout(job.timer);
      jobs.delete(event.data.id);
      if (event.data.error) job.reject(new Error(event.data.error));
      else job.resolve(event.data.result);
      if (jobs.size === 0) idleTimer = setTimeout(() => stop(), 30000);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => stop(new Error('Slider matching timed out')), 30000);
    jobs.set(id, { resolve, reject, timer });
    try {
      worker!.postMessage({ id, target, background }, [target.data.buffer as ArrayBuffer, background.data.buffer as ArrayBuffer]);
    } catch (error) {
      stop(error as Error);
    }
  });
}

export async function matchSliderImages(targetData: string, backgroundData: string): Promise<SlideMatchResult> {
  const [target, background] = await Promise.all([decodeDataURLToImage(targetData), decodeDataURLToImage(backgroundData)]);
  return match(target, background);
}
