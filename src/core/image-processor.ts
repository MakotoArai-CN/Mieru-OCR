export class ImageProcessor {
  static extractImageFromElement(img: HTMLImageElement): { data: Uint8ClampedArray; width: number; height: number } {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const grayData = this.toGrayscale(imageData.data);
    return {
      data: grayData,
      width: canvas.width,
      height: canvas.height
    };
  }

  static async loadImage(input: string | Blob | HTMLImageElement): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
    if (typeof document === 'undefined') {
      return this.loadImageInServiceWorker(input);
    }

    if (input instanceof HTMLImageElement) {
      return this.extractImageFromElement(input);
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';

    if (typeof input === 'string') {
      img.src = input;
    } else {
      img.src = URL.createObjectURL(input);
    }

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片加载失败'));
      setTimeout(() => reject(new Error('图片加载超时')), 10000);
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const grayData = this.toGrayscale(imageData.data);

    if (typeof input !== 'string') {
      URL.revokeObjectURL(img.src);
    }

    return {
      data: grayData,
      width: img.width,
      height: img.height
    };
  }

  private static async loadImageInServiceWorker(input: string | Blob | HTMLImageElement): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
    let blob: Blob;

    if (typeof input === 'string') {
      if (input.startsWith('data:')) {
        const response = await fetch(input);
        blob = await response.blob();
      } else {
        const response = await fetch(input);
        blob = await response.blob();
      }
    } else if (input instanceof Blob) {
      blob = input;
    } else {
      throw new Error('Service Worker 环境不支持 HTMLImageElement');
    }

    const imageBitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imageBitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const grayData = this.toGrayscale(imageData.data);
    imageBitmap.close();

    return {
      data: grayData,
      width: canvas.width,
      height: canvas.height
    };
  }

  private static toGrayscale(data: Uint8ClampedArray): Uint8ClampedArray {
    const gray = new Uint8ClampedArray(data.length / 4);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const alpha = a / 255;
      const rr = r * alpha + 255 * (1 - alpha);
      const gg = g * alpha + 255 * (1 - alpha);
      const bb = b * alpha + 255 * (1 - alpha);
      gray[i / 4] = Math.round(0.2126 * rr + 0.7152 * gg + 0.0722 * bb);
    }
    return gray;
  }

  static resize(data: Uint8ClampedArray, width: number, height: number, newWidth: number, newHeight: number): Uint8ClampedArray {
    const result = new Uint8ClampedArray(newWidth * newHeight);
    const xRatio = width / newWidth;
    const yRatio = height / newHeight;

    for (let y = 0; y < newHeight; y++) {
      for (let x = 0; x < newWidth; x++) {
        const px = x * xRatio;
        const py = y * yRatio;
        const x1 = Math.floor(px);
        const x2 = Math.min(x1 + 1, width - 1);
        const y1 = Math.floor(py);
        const y2 = Math.min(y1 + 1, height - 1);
        const fx = px - x1;
        const fy = py - y1;
        const v1 = data[y1 * width + x1];
        const v2 = data[y1 * width + x2];
        const v3 = data[y2 * width + x1];
        const v4 = data[y2 * width + x2];
        const val = v1 * (1 - fx) * (1 - fy) + v2 * fx * (1 - fy) + v3 * (1 - fx) * fy + v4 * fx * fy;
        result[y * newWidth + x] = Math.round(val);
      }
    }
    return result;
  }

  static normalize(data: Uint8ClampedArray): Float32Array {
    const normalized = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      normalized[i] = data[i] / 255.0;
    }
    return normalized;
  }
}