import type { ImageLike, SlideMatchResult } from '@core/slide-detector';
import { api } from '../platform';

export function imageLikeToDataURL(image: ImageLike): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cannot create 2D context');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return canvas.toDataURL();
}

export async function matchSlider(target: ImageLike, background: ImageLike): Promise<SlideMatchResult> {
  const response = await api.runtime.sendMessage({
    action: 'matchSlider', targetData: imageLikeToDataURL(target), backgroundData: imageLikeToDataURL(background),
  });
  if (!response?.success) throw new Error(response?.error || 'Slider matching failed');
  return response.result;
}
