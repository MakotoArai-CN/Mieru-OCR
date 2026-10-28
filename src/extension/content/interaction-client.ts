import type { ImageLike, SlideMatchResult } from '@core/slide-detector';
import { api } from '../platform';

export function imageLikeToDataURL(image: ImageLike): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cannot create 2D context');
  // 用 canvas 自己的 createImageData 再拷贝：Firefox 的内容脚本隔离环境里，
  // `new ImageData(...)` 造出的对象在 putImageData 时会被安全检查拒绝。
  const pixels = ctx.createImageData(image.width, image.height);
  // 逐元素拷贝而不是 TypedArray.set：Firefox 内容脚本沙箱里 image.data 与 canvas
  // 属于不同 compartment，set() 会抛 "Permission denied to access object"。
  for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = image.data[i];
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL();
}

export async function matchSlider(target: ImageLike, background: ImageLike): Promise<SlideMatchResult> {
  const response = await api.runtime.sendMessage({
    action: 'matchSlider', targetData: imageLikeToDataURL(target), backgroundData: imageLikeToDataURL(background),
  });
  if (!response?.success) throw new Error(response?.error || 'Slider matching failed');
  return response.result;
}
