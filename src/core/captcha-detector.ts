import { CONSTANTS } from './config';
import type { CaptchaElementInfo, InputElementInfo } from './types';

export interface DetectedCaptcha {
  id: string;
  type: 'image' | 'canvas' | 'svg';
  element: Element;
  rect: DOMRect;
  confidence: number;
  inputElement: HTMLInputElement | null;
  src?: string;
  elementInfo: CaptchaElementInfo;
}

export class CaptchaDetector {
  private detectedCaptchas: DetectedCaptcha[] = [];
  private processedElements = new WeakMap<Element, string>();
  captureForOCR: any;

  scan(): DetectedCaptcha[] {
    this.detectedCaptchas = [];
    this.scanImages();
    this.scanCanvas();
    this.scanSvg();
    return this.detectedCaptchas;
  }

  private scanImages(): void {
    document.querySelectorAll('img').forEach((img, index) => {
      if (this.isLikelyCaptcha(img)) {
        const rect = img.getBoundingClientRect();
        this.detectedCaptchas.push({
          id: `captcha-${index}`,
          type: 'image',
          element: img,
          src: img.src,
          rect,
          confidence: this.calculateConfidence(img),
          inputElement: this.findRelatedInput(img),
          elementInfo: this.extractCaptchaInfo(img),
        });
      }
    });
  }

  private scanCanvas(): void {
    document.querySelectorAll('canvas').forEach((canvas, index) => {
      if (this.isLikelyCanvasCaptcha(canvas)) {
        const rect = canvas.getBoundingClientRect();
        this.detectedCaptchas.push({
          id: `captcha-canvas-${index}`,
          type: 'canvas',
          element: canvas,
          rect,
          confidence: this.calculateConfidence(canvas),
          inputElement: this.findRelatedInput(canvas),
          elementInfo: this.extractCaptchaInfo(canvas),
        });
      }
    });
  }

  private scanSvg(): void {
    document.querySelectorAll('svg').forEach((svg, index) => {
      if (this.isLikelySvgCaptcha(svg)) {
        const rect = svg.getBoundingClientRect();
        this.detectedCaptchas.push({
          id: `captcha-svg-${index}`,
          type: 'svg',
          element: svg,
          rect,
          confidence: this.calculateConfidence(svg),
          inputElement: this.findRelatedInput(svg),
          elementInfo: this.extractCaptchaInfo(svg),
        });
      }
    });
  }

  private extractCaptchaInfo(element: Element): CaptchaElementInfo {
    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName.toLowerCase(),
      id: (element as HTMLElement).id || null,
      className: (element as HTMLElement).className?.toString?.() || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      src: (element as HTMLImageElement).src,
    };
  }

  extractInputInfo(input: HTMLInputElement): InputElementInfo {
    return {
      tagName: input.tagName.toLowerCase(),
      id: input.id || null,
      name: input.name || null,
      className: input.className || '',
      placeholder: input.placeholder || null,
      type: input.type || 'text',
    };
  }

  private isLikelyCaptcha(img: HTMLImageElement): boolean {
    const rect = img.getBoundingClientRect();
    if (!this.isCaptchaSize(rect.width, rect.height)) return false;
    if (!this.isVisible(img)) return false;
    if (this.matchesKeywords(img)) return true;
    if (this.srcContainsKeywords(img.src)) return true;
    if (this.parentContainsKeywords(img)) return true;
    if (this.hasNearbyInput(img)) return true;
    return false;
  }

  public isLikelyCanvasCaptcha(canvas: HTMLCanvasElement): boolean {
    const rect = canvas.getBoundingClientRect();
    if (!this.isCaptchaSize(rect.width, rect.height)) return false;
    if (!this.isVisible(canvas)) return false;
    if (this.matchesKeywords(canvas)) return true;
    if (this.parentContainsKeywords(canvas)) return true;
    if (this.hasNearbyInput(canvas)) return true;
    return false;
  }

  private isLikelySvgCaptcha(svg: SVGElement): boolean {
    const width = svg.clientWidth || parseInt(svg.getAttribute('width') || '0');
    const height = svg.clientHeight || parseInt(svg.getAttribute('height') || '0');
    if (!this.isCaptchaSize(width, height)) return false;
    if (!this.isVisible(svg)) return false;
    if (this.matchesKeywords(svg)) return true;
    if (this.parentContainsKeywords(svg)) return true;
    if (this.hasNearbyInput(svg)) return true;
    return false;
  }

  private isCaptchaSize(width: number, height: number): boolean {
    return (
      width >= CONSTANTS.MIN_CAPTCHA_WIDTH &&
      width <= CONSTANTS.MAX_CAPTCHA_WIDTH &&
      height >= CONSTANTS.MIN_CAPTCHA_HEIGHT &&
      height <= CONSTANTS.MAX_CAPTCHA_HEIGHT
    );
  }

  private isVisible(element: Element): boolean {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  private matchesKeywords(element: Element): boolean {
    const className = ((element as any).className?.toString?.() || '').toLowerCase();
    const id = ((element as any).id || '').toLowerCase();
    return CONSTANTS.CAPTCHA_KEYWORDS.some(
      keyword => className.includes(keyword) || id.includes(keyword)
    );
  }

  private srcContainsKeywords(src: string): boolean {
    if (!src) return false;
    const lowerSrc = src.toLowerCase();
    return CONSTANTS.CAPTCHA_KEYWORDS.some(keyword => lowerSrc.includes(keyword));
  }

  private parentContainsKeywords(element: Element): boolean {
    let parent = element.parentElement;
    let depth = 0;
    while (parent && depth < 3) {
      if (this.matchesKeywords(parent)) return true;
      parent = parent.parentElement;
      depth++;
    }
    return false;
  }

  private hasNearbyInput(element: Element): boolean {
    return this.findRelatedInput(element) !== null;
  }

  findRelatedInput(element: Element): HTMLInputElement | null {
    let parent = element.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      const input = this.findCaptchaInput(parent);
      if (input) return input;
      parent = parent.parentElement;
      depth++;
    }
    const rect = element.getBoundingClientRect();
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (const input of inputs) {
      const inputRect = input.getBoundingClientRect();
      if (
        inputRect.left > rect.right &&
        inputRect.left - rect.right < 150 &&
        Math.abs(inputRect.top - rect.top) < 50
      ) {
        return input as HTMLInputElement;
      }
      if (
        inputRect.top > rect.bottom &&
        inputRect.top - rect.bottom < 100 &&
        Math.abs(inputRect.left - rect.left) < 100
      ) {
        return input as HTMLInputElement;
      }
    }
    return null;
  }

  private findCaptchaInput(container: Element): HTMLInputElement | null {
    const inputs = container.querySelectorAll('input[type="text"], input:not([type])');
    for (const input of inputs) {
      if (this.isCaptchaInputByName(input as HTMLInputElement)) {
        return input as HTMLInputElement;
      }
    }
    return null;
  }

  private isCaptchaInputByName(input: HTMLInputElement): boolean {
    const text = (input.name + input.id + input.className + input.placeholder).toLowerCase();
    return CONSTANTS.INPUT_KEYWORDS.some(keyword => text.includes(keyword));
  }

  private calculateConfidence(element: Element): number {
    let score = 0;
    if (this.matchesKeywords(element)) score += 30;
    if ((element as HTMLImageElement).src && this.srcContainsKeywords((element as HTMLImageElement).src)) score += 20;
    if (this.parentContainsKeywords(element)) score += 15;
    if (this.findRelatedInput(element)) score += 25;
    const rect = element.getBoundingClientRect();
    if (this.isCaptchaSize(rect.width, rect.height)) score += 10;
    return Math.min(score, 100);
  }

  async captureImage(captcha: DetectedCaptcha): Promise<string> {
    switch (captcha.type) {
      case 'image':
        return this.captureImgElement(captcha.element as HTMLImageElement);
      case 'canvas':
        return this.captureCanvasElement(captcha.element as HTMLCanvasElement);
      case 'svg':
        return this.captureSvgElement(captcha.element as SVGElement);
    }
  }

  async captureBuffer(captcha: DetectedCaptcha): Promise<ArrayBuffer> {
    const blob = await this.captureBlob(captcha);
    return await blob.arrayBuffer();
  }

  async captureBlob(captcha: DetectedCaptcha): Promise<Blob> {
    switch (captcha.type) {
      case 'image':
        return this.captureImgAsBlob(captcha.element as HTMLImageElement);
      case 'canvas':
        return this.captureCanvasAsBlob(captcha.element as HTMLCanvasElement);
      case 'svg':
        return this.captureSvgAsBlob(captcha.element as SVGElement);
    }
  }

  private async captureImgElement(img: HTMLImageElement): Promise<string> {
    await this.waitForImageLoad(img);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);
    try {
      return canvas.toDataURL('image/png');
    } catch {
      if (img.src.startsWith('data:')) return img.src;
      throw new Error('无法捕获跨域图片');
    }
  }

  private async captureImgAsBlob(img: HTMLImageElement): Promise<Blob> {
    await this.waitForImageLoad(img);
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
      try {
        const resp = await fetch(img.src, { credentials: 'include' });
        if (resp.ok) {
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('image/')) {
            return await resp.blob();
          }
        }
      } catch {}
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('图片转换失败'));
      }, 'image/png');
    });
  }

  private async waitForImageLoad(img: HTMLImageElement): Promise<void> {
    if (img.complete && img.naturalWidth > 0) return;
    if (img.src?.startsWith('data:') && img.naturalWidth > 0) return;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('图片加载超时')), 5000);
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('图片加载失败'));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });
  }

  private captureCanvasElement(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/png');
  }

  private captureCanvasAsBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas转换失败'));
      }, 'image/png');
    });
  }

  private async captureSvgElement(svg: SVGElement): Promise<string> {
    const blob = await this.captureSvgAsBlob(svg);
    return await this.blobToDataURL(blob);
  }

  private async captureSvgAsBlob(svg: SVGElement): Promise<Blob> {
    const clonedSvg = svg.cloneNode(true) as SVGElement;
    const rect = svg.getBoundingClientRect();
    clonedSvg.setAttribute('width', String(rect.width));
    clonedSvg.setAttribute('height', String(rect.height));
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(clonedSvg);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('SVG转换失败'));
        el.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error('SVG转换失败'));
        }, 'image/png');
      });
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取失败'));
      reader.readAsDataURL(blob);
    });
  }

  highlight(captcha: DetectedCaptcha): void {
    const el = captcha.element as HTMLElement;
    el.setAttribute('data-captcha-highlight', 'true');
  }

  unhighlight(captcha: DetectedCaptcha): void {
    const el = captcha.element as HTMLElement;
    el.removeAttribute('data-captcha-highlight');
  }

  getDetectedCaptchas(): DetectedCaptcha[] {
    return this.detectedCaptchas;
  }

  getMostLikelyCaptcha(): DetectedCaptcha | null {
    if (this.detectedCaptchas.length === 0) return null;
    return this.detectedCaptchas.reduce((best, current) =>
      current.confidence > best.confidence ? current : best
    );
  }

  hasElementChanged(element: Element): boolean {
    const currentHash = this.getElementHash(element);
    const previousHash = this.processedElements.get(element);
    if (!previousHash) return true;
    return currentHash !== previousHash;
  }

  markElementProcessed(element: Element): void {
    const hash = this.getElementHash(element);
    this.processedElements.set(element, hash);
  }

  private getElementHash(element: Element): string {
    if (element instanceof HTMLImageElement) {
      return element.src + '_' + element.naturalWidth + '_' + element.naturalHeight;
    } else if (element instanceof HTMLCanvasElement) {
      try {
        return element.toDataURL();
      } catch {
        return 'canvas_' + Date.now();
      }
    } else if (element instanceof SVGElement) {
      return element.outerHTML;
    } else if (element instanceof HTMLElement && element.style.backgroundImage) {
      return element.style.backgroundImage;
    }
    return '';
  }
}