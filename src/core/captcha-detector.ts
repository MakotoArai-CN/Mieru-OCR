import { CONSTANTS, Logger } from './config';
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

export interface GuessedElement {
  element: Element;
  type: 'captcha' | 'input' | 'agreement';
  confidence: number;
  selector: string;
  clickTarget?: HTMLElement;
}

export class CaptchaDetector {
  private detectedCaptchas: DetectedCaptcha[] = [];
  private processedElements = new WeakMap<Element, string>();
  private checkedAgreements = new WeakSet<HTMLInputElement>();
  captureForOCR: any;

  scan(): DetectedCaptcha[] {
    this.detectedCaptchas = [];
    Logger.time('CaptchaDetector.scan');
    this.scanImages();
    this.scanCanvas();
    this.scanSvg();
    Logger.timeEnd('CaptchaDetector.scan');
    Logger.debug('扫描结果:', this.detectedCaptchas.length, '个验证码');
    return this.detectedCaptchas;
  }

  private scanImages(): void {
    document.querySelectorAll('img').forEach((img, index) => {
      if (this.isLikelyCaptcha(img)) {
        const rect = img.getBoundingClientRect();
        const captcha: DetectedCaptcha = {
          id: `captcha-${index}`,
          type: 'image',
          element: img,
          src: img.src,
          rect,
          confidence: this.calculateConfidence(img),
          inputElement: this.findRelatedInput(img),
          elementInfo: this.extractCaptchaInfo(img),
        };
        this.detectedCaptchas.push(captcha);
        Logger.debug('检测到图片验证码:', captcha.elementInfo);
      }
    });
  }

  private scanCanvas(): void {
    document.querySelectorAll('canvas').forEach((canvas, index) => {
      if (this.isLikelyCanvasCaptcha(canvas)) {
        const rect = canvas.getBoundingClientRect();
        const captcha: DetectedCaptcha = {
          id: `captcha-canvas-${index}`,
          type: 'canvas',
          element: canvas,
          rect,
          confidence: this.calculateConfidence(canvas),
          inputElement: this.findRelatedInput(canvas),
          elementInfo: this.extractCaptchaInfo(canvas),
        };
        this.detectedCaptchas.push(captcha);
        Logger.debug('检测到Canvas验证码:', captcha.elementInfo);
      }
    });
  }

  private scanSvg(): void {
    document.querySelectorAll('svg').forEach((svg, index) => {
      if (this.isLikelySvgCaptcha(svg)) {
        const rect = svg.getBoundingClientRect();
        const captcha: DetectedCaptcha = {
          id: `captcha-svg-${index}`,
          type: 'svg',
          element: svg,
          rect,
          confidence: this.calculateConfidence(svg),
          inputElement: this.findRelatedInput(svg),
          elementInfo: this.extractCaptchaInfo(svg),
        };
        this.detectedCaptchas.push(captcha);
        Logger.debug('检测到SVG验证码:', captcha.elementInfo);
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
    if (!this.isCaptchaSize(rect.width, rect.height)) {
      return false;
    }
    if (!this.isVisible(img)) {
      return false;
    }
    if (this.isExcludedImage(img)) {
      return false;
    }
    if (this.matchesKeywords(img)) return true;
    if (this.srcContainsKeywords(img.src)) return true;
    if (this.parentContainsKeywords(img)) return true;
    if (this.hasNearbyInput(img)) return true;
    return false;
  }

  private isExcludedImage(img: HTMLImageElement): boolean {
    const src = img.src.toLowerCase();
    const alt = (img.alt || '').toLowerCase();
    const className = (img.className?.toString?.() || '').toLowerCase();
    const excludePatterns = [
      'avatar', 'logo', 'icon', 'banner', 'ad', 'sponsor',
      'background', 'bg', 'profile', 'user', 'photo',
      'emoji', 'emoticon', 'sticker', 'gif',
      'loading', 'spinner', 'placeholder',
    ];
    const combined = src + alt + className;
    return excludePatterns.some(pattern => combined.includes(pattern));
  }

  public isLikelyCanvasCaptcha(canvas: HTMLCanvasElement): boolean {
    const rect = canvas.getBoundingClientRect();
    if (!this.isCaptchaSize(rect.width, rect.height)) {
      return false;
    }
    if (!this.isVisible(canvas)) {
      return false;
    }
    if (this.matchesKeywords(canvas)) return true;
    if (this.parentContainsKeywords(canvas)) return true;
    if (this.hasNearbyInput(canvas)) return true;
    return false;
  }

  private isLikelySvgCaptcha(svg: SVGElement): boolean {
    const width = svg.clientWidth || parseInt(svg.getAttribute('width') || '0');
    const height = svg.clientHeight || parseInt(svg.getAttribute('height') || '0');
    if (!this.isCaptchaSize(width, height)) {
      return false;
    }
    if (!this.isVisible(svg)) {
      return false;
    }
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

  private isFrameworkCheckbox(checkbox: HTMLInputElement): boolean {
    const classNames = [
      'el-checkbox__original',
      'ant-checkbox-input',
      'ivu-checkbox-input',
      'van-checkbox__input',
      'weui-check',
      'mdui-checkbox-input',
      'mdc-checkbox__native-control',
    ];
    for (const cls of classNames) {
      if (checkbox.classList.contains(cls)) return true;
    }
    const containerSelectors = [
      '.el-checkbox',
      '.ant-checkbox',
      '.ant-checkbox-wrapper',
      '.ivu-checkbox',
      '.ivu-checkbox-wrapper',
      '.van-checkbox',
      '.weui-check__label',
      '.mdui-checkbox',
      '.mdc-checkbox',
    ];
    for (const sel of containerSelectors) {
      if (checkbox.closest(sel)) return true;
    }
    return false;
  }

  private isCheckboxFunctional(checkbox: HTMLInputElement): boolean {
    if (checkbox.disabled) return false;
    if (this.isFrameworkCheckbox(checkbox)) {
      const containers = [
        checkbox.closest('.el-checkbox'),
        checkbox.closest('.ant-checkbox-wrapper'),
        checkbox.closest('.ivu-checkbox-wrapper'),
        checkbox.closest('.van-checkbox'),
        checkbox.closest('label'),
      ];
      for (const container of containers) {
        if (container) {
          const style = window.getComputedStyle(container as Element);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true;
          }
        }
      }
      let parent: HTMLElement | null = checkbox.parentElement;
      let depth = 0;
      while (parent && depth < 5) {
        const style = window.getComputedStyle(parent);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        parent = parent.parentElement;
        depth++;
      }
      return true;
    }
    const style = window.getComputedStyle(checkbox);
    if (style.display === 'none') return false;
    let parent: HTMLElement | null = checkbox.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') {
        return false;
      }
      parent = parent.parentElement;
      depth++;
    }
    return true;
  }

  private findClickableTarget(checkbox: HTMLInputElement): HTMLElement | null {
    const elCheckbox = checkbox.closest('.el-checkbox');
    if (elCheckbox) {
      const inner = elCheckbox.querySelector('.el-checkbox__inner');
      if (inner) return inner as HTMLElement;
      return elCheckbox as HTMLElement;
    }
    const antWrapper = checkbox.closest('.ant-checkbox-wrapper');
    if (antWrapper) {
      const inner = antWrapper.querySelector('.ant-checkbox-inner');
      if (inner) return inner as HTMLElement;
      return antWrapper as HTMLElement;
    }
    const ivuWrapper = checkbox.closest('.ivu-checkbox-wrapper');
    if (ivuWrapper) {
      const inner = ivuWrapper.querySelector('.ivu-checkbox-inner');
      if (inner) return inner as HTMLElement;
      return ivuWrapper as HTMLElement;
    }
    const vanCheckbox = checkbox.closest('.van-checkbox');
    if (vanCheckbox) {
      const icon = vanCheckbox.querySelector('.van-checkbox__icon');
      if (icon) return icon as HTMLElement;
      return vanCheckbox as HTMLElement;
    }
    const label = checkbox.closest('label');
    if (label) return label;
    return null;
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

  private findClosestInputInContainer(
    container: Element,
    captchaRect: DOMRect,
    maxDistance: number = Infinity
  ): HTMLInputElement | null {
    const inputs = container.querySelectorAll('input[type="text"], input:not([type])');

    let closest: HTMLInputElement | null = null;
    let closestDistance = Infinity;
    let closestHasKeyword = false;

    for (const input of inputs) {
      const htmlInput = input as HTMLInputElement;
      if (!this.isValidCaptchaInput(htmlInput)) continue;

      const inputRect = input.getBoundingClientRect();
      const distance = this.calculateDistance(captchaRect, inputRect);

      // 超出最大距离限制，跳过
      if (distance > maxDistance) continue;

      const hasKeyword = this.isCaptchaInputByName(htmlInput);

      // 优先选择：1. 距离更近 2. 距离相近时优先有关键字的
      if (
        distance < closestDistance ||
        (Math.abs(distance - closestDistance) < 20 && hasKeyword && !closestHasKeyword)
      ) {
        closestDistance = distance;
        closest = htmlInput;
        closestHasKeyword = hasKeyword;
      }
    }

    return closest;
  }

  findRelatedInput(element: Element): HTMLInputElement | null {
    const captchaRect = element.getBoundingClientRect();

    // 策略1: 在直接父容器中查找最近的输入框（不要求关键字）
    const parent = element.parentElement;
    if (parent) {
      const input = this.findClosestInputInContainer(parent, captchaRect);
      if (input) return input;
    }

    // 策略2: 向上遍历2-3层，基于距离查找
    let ancestor = parent?.parentElement;
    let depth = 0;
    while (ancestor && depth < 3) {
      const input = this.findClosestInputInContainer(ancestor, captchaRect, 150);
      if (input) return input;
      ancestor = ancestor.parentElement;
      depth++;
    }

    // 策略3: 全局查找，使用位置关系（原逻辑）
    const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
    for (const input of inputs) {
      if (!this.isValidCaptchaInput(input as HTMLInputElement)) continue;

      const inputRect = input.getBoundingClientRect();

      // 检查右侧
      if (
        inputRect.left > captchaRect.right &&
        inputRect.left - captchaRect.right < 150 &&
        Math.abs(inputRect.top - captchaRect.top) < 50
      ) {
        return input as HTMLInputElement;
      }

      // 检查下方
      if (
        inputRect.top > captchaRect.bottom &&
        inputRect.top - captchaRect.bottom < 100 &&
        Math.abs(inputRect.left - captchaRect.left) < 100
      ) {
        return input as HTMLInputElement;
      }
    }

    return null;
  }

  private findCaptchaInput(container: Element): HTMLInputElement | null {
    const inputs = container.querySelectorAll('input[type="text"], input:not([type])');
    for (const input of inputs) {
      const htmlInput = input as HTMLInputElement;
      if (this.isValidCaptchaInput(htmlInput) && this.isCaptchaInputByName(htmlInput)) {
        return htmlInput;
      }
    }
    return null;
  }

  private isValidCaptchaInput(input: HTMLInputElement): boolean {
    const type = (input.type || 'text').toLowerCase();
    if (CONSTANTS.EXCLUDED_INPUT_TYPES.includes(type)) {
      return false;
    }
    const name = (input.name || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    for (const excluded of CONSTANTS.EXCLUDED_INPUT_NAMES) {
      if (name === excluded || id === excluded) {
        return false;
      }
    }
    if (!this.isVisible(input)) {
      return false;
    }
    return true;
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

  guessRelatedCaptcha(inputElement: HTMLInputElement): GuessedElement[] {
    const guessed: GuessedElement[] = [];
    const inputRect = inputElement.getBoundingClientRect();
    Logger.debug('开始猜测关联的验证码元素, 输入框位置:', inputRect);
    const candidates: { element: Element; distance: number; type: 'image' | 'canvas' | 'svg' }[] = [];
    document.querySelectorAll('img').forEach(img => {
      if (!this.isVisible(img)) return;
      const rect = img.getBoundingClientRect();
      if (!this.isCaptchaSize(rect.width, rect.height)) return;
      if (this.isExcludedImage(img)) return;
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: img, distance, type: 'image' });
    });
    document.querySelectorAll('canvas').forEach(canvas => {
      if (!this.isVisible(canvas)) return;
      const rect = canvas.getBoundingClientRect();
      if (!this.isCaptchaSize(rect.width, rect.height)) return;
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: canvas, distance, type: 'canvas' });
    });
    document.querySelectorAll('svg').forEach(svg => {
      if (!this.isVisible(svg)) return;
      const width = svg.clientWidth || parseInt(svg.getAttribute('width') || '0');
      const height = svg.clientHeight || parseInt(svg.getAttribute('height') || '0');
      if (!this.isCaptchaSize(width, height)) return;
      const rect = svg.getBoundingClientRect();
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: svg, distance, type: 'svg' });
    });
    candidates.sort((a, b) => a.distance - b.distance);
    const topCandidates = candidates.slice(0, 3);
    for (const candidate of topCandidates) {
      const confidence = Math.max(0, 100 - Math.floor(candidate.distance / 5));
      guessed.push({
        element: candidate.element,
        type: 'captcha',
        confidence,
        selector: this.generateSelector(candidate.element),
      });
    }
    Logger.debug('猜测的验证码元素:', guessed);
    return guessed;
  }

  guessRelatedInput(captchaElement: Element): GuessedElement[] {
    const guessed: GuessedElement[] = [];
    const captchaRect = captchaElement.getBoundingClientRect();
    Logger.debug('开始猜测关联的输入框, 验证码位置:', captchaRect);
    const candidates: { element: HTMLInputElement; distance: number; hasKeyword: boolean }[] = [];
    document.querySelectorAll('input').forEach(input => {
      const htmlInput = input as HTMLInputElement;
      if (!this.isValidCaptchaInput(htmlInput)) return;
      if (!this.isVisible(htmlInput)) return;
      const rect = htmlInput.getBoundingClientRect();
      const distance = this.calculateDistance(captchaRect, rect);
      const hasKeyword = this.isCaptchaInputByName(htmlInput);
      candidates.push({ element: htmlInput, distance, hasKeyword });
    });
    candidates.sort((a, b) => {
      if (a.hasKeyword && !b.hasKeyword) return -1;
      if (!a.hasKeyword && b.hasKeyword) return 1;
      return a.distance - b.distance;
    });
    const topCandidates = candidates.slice(0, 3);
    for (const candidate of topCandidates) {
      let confidence = Math.max(0, 100 - Math.floor(candidate.distance / 5));
      if (candidate.hasKeyword) confidence = Math.min(100, confidence + 20);
      guessed.push({
        element: candidate.element,
        type: 'input',
        confidence,
        selector: this.generateSelector(candidate.element),
      });
    }
    Logger.debug('猜测的输入框元素:', guessed);
    return guessed;
  }

  guessAgreementCheckboxes(): GuessedElement[] {
    const guessed: GuessedElement[] = [];
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
      const htmlCheckbox = checkbox as HTMLInputElement;
      if (!this.isCheckboxFunctional(htmlCheckbox)) return;
      if (this.checkedAgreements.has(htmlCheckbox)) return;
      const textSources: string[] = [];
      textSources.push(htmlCheckbox.name || '');
      textSources.push(htmlCheckbox.id || '');
      textSources.push(htmlCheckbox.className || '');
      textSources.push(htmlCheckbox.getAttribute('data-type') || '');
      textSources.push(htmlCheckbox.getAttribute('data-name') || '');
      textSources.push(htmlCheckbox.getAttribute('aria-label') || '');
      textSources.push(htmlCheckbox.getAttribute('data-v-inspector') || '');
      const labelById = htmlCheckbox.id ? document.querySelector(`label[for="${htmlCheckbox.id}"]`) : null;
      if (labelById) {
        textSources.push(labelById.textContent || '');
        textSources.push((labelById as HTMLElement).className || '');
      }
      const wrapperLabel = htmlCheckbox.closest('label');
      if (wrapperLabel) {
        textSources.push(wrapperLabel.textContent || '');
        textSources.push(wrapperLabel.className || '');
      }
      const frameworkContainers = [
        htmlCheckbox.closest('.el-checkbox'),
        htmlCheckbox.closest('.ant-checkbox-wrapper'),
        htmlCheckbox.closest('.ivu-checkbox-wrapper'),
        htmlCheckbox.closest('.van-checkbox'),
        htmlCheckbox.closest('[class*="checkbox"]'),
      ];
      for (const container of frameworkContainers) {
        if (container) {
          textSources.push(container.textContent || '');
          textSources.push((container as HTMLElement).className || '');
        }
      }
      let parent: HTMLElement | null = htmlCheckbox.parentElement;
      let depth = 0;
      while (parent && depth < 6) {
        const tagName = parent.tagName.toLowerCase();
        textSources.push(parent.className || '');
        textSources.push(parent.id || '');
        if (['label', 'div', 'span', 'p', 'li', 'td'].includes(tagName)) {
          const children = parent.children;
          for (let i = 0; i < children.length; i++) {
            const child = children[i] as HTMLElement;
            if (child.tagName !== 'INPUT' && child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE') {
              textSources.push(child.textContent || '');
              textSources.push(child.className || '');
            }
          }
        }
        if (tagName === 'form' || tagName === 'body') break;
        const parentClass = parent.className?.toLowerCase() || '';
        if (parentClass.includes('form-item') || parentClass.includes('formitem')) {
          textSources.push(parent.textContent || '');
          break;
        }
        parent = parent.parentElement;
        depth++;
      }
      const formItem = htmlCheckbox.closest('.el-form-item, .ant-form-item, .ivu-form-item, [class*="form-item"], [class*="formitem"]');
      if (formItem) {
        textSources.push(formItem.textContent || '');
        textSources.push((formItem as HTMLElement).className || '');
      }
      const combinedText = textSources.join(' ').toLowerCase();
      const hasKeyword = CONSTANTS.AGREEMENT_KEYWORDS.some(keyword => combinedText.includes(keyword));
      if (hasKeyword) {
        const clickTarget = this.findClickableTarget(htmlCheckbox);
        guessed.push({
          element: htmlCheckbox,
          type: 'agreement',
          confidence: 80,
          selector: this.generateSelector(htmlCheckbox),
          clickTarget: clickTarget || undefined,
        });
      }
    });
    Logger.debug('猜测的协议复选框:', guessed);
    return guessed;
  }

  findAgreementsBySelectors(selectors: string[]): GuessedElement[] {
    const found: GuessedElement[] = [];
    for (const selector of selectors) {
      if (!selector.trim()) continue;
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el instanceof HTMLInputElement && el.type === 'checkbox') {
            if (!this.checkedAgreements.has(el)) {
              const clickTarget = this.findClickableTarget(el);
              found.push({
                element: el,
                type: 'agreement',
                confidence: 100,
                selector: selector,
                clickTarget: clickTarget || undefined,
              });
            }
          }
        });
      } catch (e) {
        Logger.warn('无效的协议选择器:', selector, e);
      }
    }
    return found;
  }

  markAgreementChecked(checkbox: HTMLInputElement): void {
    this.checkedAgreements.add(checkbox);
  }

  private calculateDistance(rect1: DOMRect, rect2: DOMRect): number {
    const centerX1 = rect1.left + rect1.width / 2;
    const centerY1 = rect1.top + rect1.height / 2;
    const centerX2 = rect2.left + rect2.width / 2;
    const centerY2 = rect2.top + rect2.height / 2;
    return Math.sqrt(Math.pow(centerX2 - centerX1, 2) + Math.pow(centerY2 - centerY1, 2));
  }

  generateSelector(element: Element): string {
    if ((element as HTMLElement).id) {
      return '#' + (element as HTMLElement).id;
    }
    const className = (element as HTMLElement).className;
    if (className) {
      const classes = className.toString().trim().split(/\s+/).filter(c => c && !c.includes(':'));
      if (classes.length > 0) {
        const selector = element.tagName.toLowerCase() + '.' + classes.join('.');
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }
    }
    const path: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.body && path.length < 5) {
      let sel = current.tagName.toLowerCase();
      if ((current as HTMLElement).id) {
        path.unshift('#' + (current as HTMLElement).id);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
        if (siblings.length > 1) {
          sel += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      path.unshift(sel);
      current = current.parentElement;
    }
    return path.join(' > ');
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
      } catch { }
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

  highlightGuessed(element: Element): void {
    (element as HTMLElement).setAttribute('data-captcha-guessed', 'true');
  }

  unhighlightGuessed(element: Element): void {
    (element as HTMLElement).removeAttribute('data-captcha-guessed');
  }

  unhighlightAllGuessed(): void {
    document.querySelectorAll('[data-captcha-guessed]').forEach(el => {
      el.removeAttribute('data-captcha-guessed');
    });
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