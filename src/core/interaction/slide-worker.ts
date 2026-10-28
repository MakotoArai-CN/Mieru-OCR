import { slideMatch, type ImageLike } from '../slide-detector';

self.onmessage = (event: MessageEvent<{ id: number; target: ImageLike; background: ImageLike }>) => {
  const { id, target, background } = event.data;
  try {
    self.postMessage({ id, result: slideMatch(target, background) });
  } catch (error) {
    self.postMessage({ id, error: (error as Error).message });
  }
};
