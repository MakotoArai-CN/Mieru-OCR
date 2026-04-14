import { OCREngine } from '@core/ocr-engine';
import { AutoFill } from '@core/auto-fill';
import { CONSTANTS, Logger } from '@core/config';
import { Calculator } from '@core/calculator';
import { CaptchaDetector, type DetectedCaptcha, type GuessedElement } from '@core/captcha-detector';
import { EventEmitter, type OCREvents, type OCRConfig, type SiteRule } from '@core/types';
import { initLocale, setLocale, t } from '@core/i18n';
import type { Locale } from '@core/i18n';
import { loadModel, clearModelCache } from './model-loader';
import { setupWASMCache, clearWASMCache } from './wasm-cache';
import { SettingsUI } from './settings-ui';
import { LoadingIndicator } from './loading-indicator';
import { Dialog } from './dialog';
import {
  getConfig,
  saveConfig,
  getSiteRules,
  saveSiteRule,
  deleteSiteRule,
  statsManager,
  isWhitelisted,
  shouldExecuteScript
} from './storage';

function isMobileDevice(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (window.innerWidth <= 768);
}

class DdddOCR {
  private engine: OCREngine;

  constructor() {
    this.engine = new OCREngine({
      getModel: loadModel,
      wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/',
    });
  }

  async init(): Promise<void> {
    await setupWASMCache();
    await this.engine.init();
  }

  async recognize(input: string | Blob | HTMLImageElement) {
    return this.engine.recognize(input);
  }
}

class AutoDetector {
  private ocr: DdddOCR;
  private detector: CaptchaDetector;
  private observer: MutationObserver | null = null;
  private enabled = false;
  private checkInterval: number | null = null;
  private eventEmitter: EventEmitter<OCREvents> | null = null;
  private autoFill = new AutoFill();
  private initialScanDone = false;
  private initialScanTimer: number | null = null;
  private processingElements = new WeakSet<Element>();
  private processedElements = new WeakMap<Element, string>();
  private customCaptchaElement: Element | null = null;
  private customInputElement: HTMLInputElement | null = null;

  constructor(ocr: DdddOCR, eventEmitter?: EventEmitter<OCREvents>) {
    this.ocr = ocr;
    this.detector = new CaptchaDetector();
    this.eventEmitter = eventEmitter || null;
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    Logger.info('启动验证码自动检测');

    this.applyStoredSiteRule();
    this.scheduleInitialDetect();

    this.observer = new MutationObserver((mutations) => {
      let shouldCheckAgreements = false;
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            this.checkElement(node);
            if (node.matches('input[type="checkbox"]') || node.querySelector('input[type="checkbox"]')) {
              shouldCheckAgreements = true;
            }
          }
        });
        if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (target instanceof HTMLElement) {
            if (target instanceof HTMLImageElement) {
              if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src') {
                this.recheckImage(target);
              }
            } else if (target instanceof HTMLCanvasElement) {
              this.recheckCanvas(target);
            } else if (mutation.attributeName === 'style' && target.style.backgroundImage) {
              this.recheckDiv(target);
            }
          }
        }
        if (mutation.type === 'childList' && mutation.target instanceof SVGElement) {
          this.recheckSVG(mutation.target as SVGElement);
        }
      }
      if (shouldCheckAgreements) {
        setTimeout(() => this.checkAgreementBoxes(), 300);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-src', 'srcset', 'style', 'href'],
      characterData: true,
    });

    this.startIntervalCheck();
    this.checkAgreementBoxes();
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    Logger.info('停止验证码自动检测');
    this.observer?.disconnect();
    this.observer = null;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.initialScanTimer) {
      clearTimeout(this.initialScanTimer);
      this.initialScanTimer = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private applyStoredSiteRule(): void {
    const rules = getSiteRules();
    const currentUrl = window.location.href;
    const currentHostname = window.location.hostname;

    let matchedRule: (SiteRule & { hostname: string }) | null = null;
    for (const key of Object.keys(rules)) {
      const rule = rules[key];
      if (!rule.enabled) continue;
      if (rule.fullUrl && currentUrl === rule.fullUrl) {
        matchedRule = rule;
        break;
      }
      if (rule.urlPattern && currentUrl.startsWith(rule.urlPattern)) {
        matchedRule = rule;
        break;
      }
      if (rule.hostname === currentHostname && !rule.fullUrl && !rule.urlPattern) {
        matchedRule = rule;
      }
    }

    if (matchedRule) {
      const element = document.querySelector(matchedRule.selector);
      if (element) {
        this.customCaptchaElement = element;
        if (matchedRule.inputSelector) {
          this.customInputElement = document.querySelector(matchedRule.inputSelector) as HTMLInputElement;
        }
        Logger.info('应用站点规则:', matchedRule.selector);
      }
    }
  }

  private checkAgreementBoxes(): void {
    const config = getConfig();
    if (!config.autoCheckAgreement) return;

    let selectors: string[] = [];
    if (config.agreementSelectors && config.agreementSelectors.length > 0) {
      selectors = config.agreementSelectors;
    }

    const agreements = this.detector.guessAgreementCheckboxes();
    for (const agreement of agreements) {
      const checkbox = agreement.element as HTMLInputElement;
      if (checkbox.checked) continue;
      const clickTarget = agreement.clickTarget;
      if (clickTarget) {
        clickTarget.click();
        Logger.info('点击协议复选框容器');
      } else {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.dispatchEvent(new Event('input', { bubbles: true }));
        Logger.info('直接勾选协议复选框');
      }
      this.detector.markAgreementChecked(checkbox);
    }

    for (const selector of selectors) {
      if (!selector.trim()) continue;
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el instanceof HTMLInputElement && el.type === 'checkbox' && !el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            Logger.info('通过选择器勾选协议:', selector);
          }
        });
      } catch (e) {
        Logger.warn('无效的协议选择器:', selector);
      }
    }
  }

  private scheduleInitialDetect(): void {
    if (this.initialScanDone) return;
    this.detectExistingCaptchas(false);
    this.initialScanTimer = window.setTimeout(() => {
      if (!this.initialScanDone) {
        this.detectExistingCaptchas(true);
      }
    }, 3000);
  }

  private startIntervalCheck(): void {
    this.checkInterval = window.setInterval(() => {
      const captchas = this.detector.scan();
      if (!captchas || captchas.length === 0) return;
      for (const c of captchas) {
        if (this.hasElementChanged(c.element)) {
          this.processDetectedCaptcha(c);
          break;
        }
      }
    }, CONSTANTS.AUTO_DETECT_INTERVAL);
  }

  private detectExistingCaptchas(triggerRecognize: boolean): void {
    Logger.debug('检测页面已存在的验证码');
    document.querySelectorAll('img').forEach((img) => this.checkImage(img as HTMLImageElement, triggerRecognize));
    document.querySelectorAll('canvas').forEach((canvas) => this.checkCanvas(canvas as HTMLCanvasElement, triggerRecognize));
    document.querySelectorAll('svg').forEach((svg) => this.checkSVG(svg as SVGElement, triggerRecognize));
    document.querySelectorAll('div[style*="background"]').forEach((div) => this.checkDiv(div as HTMLDivElement, triggerRecognize));
    if (triggerRecognize) {
      this.initialScanDone = true;
    }
  }

  private checkElement(element: HTMLElement): void {
    if (element instanceof HTMLImageElement) this.checkImage(element, true);
    if (element instanceof HTMLCanvasElement) this.checkCanvas(element, true);
    if (element instanceof SVGElement) this.checkSVG(element, true);
    if (element.style.backgroundImage) this.checkDiv(element, true);
    element.querySelectorAll('img').forEach((img) => this.checkImage(img as HTMLImageElement, true));
    element.querySelectorAll('canvas').forEach((canvas) => this.checkCanvas(canvas as HTMLCanvasElement, true));
    element.querySelectorAll('svg').forEach((svg) => this.checkSVG(svg as SVGElement, true));
  }

  private async waitForImageLoad(img: HTMLImageElement, timeout = 5000): Promise<boolean> {
    if (img.complete && img.naturalWidth > 0) return true;
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeout);
      const onLoad = () => {
        cleanup();
        resolve(true);
      };
      const onError = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      if (img.complete && img.naturalWidth > 0) {
        cleanup();
        resolve(true);
      }
    });
  }

  private async recheckImage(img: HTMLImageElement): Promise<void> {
    const loaded = await this.waitForImageLoad(img);
    if (!loaded) return;
    await this.checkImage(img, true);
  }

  private async recheckCanvas(canvas: HTMLCanvasElement): Promise<void> {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await this.checkCanvas(canvas, true);
  }

  private async recheckSVG(svg: SVGElement): Promise<void> {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await this.checkSVG(svg, true);
  }

  private async recheckDiv(div: HTMLElement): Promise<void> {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await this.checkDiv(div, true);
  }

  private async checkImage(img: HTMLImageElement, triggerRecognize: boolean): Promise<void> {
    const config = getConfig();
    if (config.captchaSelector) {
      if (!img.matches(config.captchaSelector)) return;
    } else {
      if (!this.isCaptchaImage(img)) return;
    }
    if (!this.hasElementChanged(img)) return;
    if (this.processingElements.has(img)) return;
    this.eventEmitter?.emit('detect:found', { element: img, type: 'img' });
    if (!triggerRecognize) return;
    const input = this.findNearbyInput(img);
    if (!input) return;
    if (input.value.trim()) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const loaded = await this.waitForImageLoad(img);
    if (!loaded || !img.naturalWidth) return;
    await this.recognizeAndFill(img, input);
  }

  private async checkCanvas(canvas: HTMLCanvasElement, triggerRecognize: boolean): Promise<void> {
    const config = getConfig();
    if (config.captchaSelector) {
      if (!canvas.matches(config.captchaSelector)) return;
    } else {
      if (!this.isCaptchaCanvas(canvas)) return;
    }
    if (!this.hasElementChanged(canvas)) return;
    if (this.processingElements.has(canvas)) return;
    this.eventEmitter?.emit('detect:found', { element: canvas, type: 'canvas' });
    if (!triggerRecognize) return;
    const input = this.findNearbyInput(canvas);
    if (!input) return;
    await new Promise(resolve => requestAnimationFrame(resolve));
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Canvas转换失败'));
      }, 'image/png');
    });
    await this.recognizeAndFillBlob(canvas, blob, input);
  }

  private async checkSVG(svg: SVGElement, triggerRecognize: boolean): Promise<void> {
    const config = getConfig();
    if (config.captchaSelector) {
      if (!svg.matches(config.captchaSelector)) return;
    } else {
      if (!this.isCaptchaSVG(svg)) return;
    }
    if (!this.hasElementChanged(svg)) return;
    if (this.processingElements.has(svg)) return;
    this.eventEmitter?.emit('detect:found', { element: svg, type: 'svg' });
    if (!triggerRecognize) return;
    const input = this.findNearbyInput(svg);
    if (!input) return;
    const blob = await this.svgToBlob(svg);
    await this.recognizeAndFillBlob(svg, blob, input);
  }

  private async checkDiv(div: HTMLElement, triggerRecognize: boolean): Promise<void> {
    const config = getConfig();
    if (config.captchaSelector) {
      if (!div.matches(config.captchaSelector)) return;
    } else {
      if (!this.isCaptchaDiv(div)) return;
    }
    const bgImage = div.style.backgroundImage;
    if (!bgImage) return;
    if (!this.hasElementChanged(div)) return;
    if (this.processingElements.has(div)) return;
    this.eventEmitter?.emit('detect:found', { element: div, type: 'div' });
    if (!triggerRecognize) return;
    const input = this.findNearbyInput(div);
    if (!input) return;
    const urlMatch = bgImage.match(/url\(['"]?(.+?)['"]?\)/);
    if (!urlMatch) return;
    const imageUrl = urlMatch[1];
    const startTime = Date.now();
    let resultText = '';
    if (imageUrl.startsWith('data:')) {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const result = await this.ocr.recognize(blob);
      resultText = result.text;
    } else {
      const result = await this.ocr.recognize(imageUrl);
      resultText = result.text;
    }
    const elapsed = Date.now() - startTime;
    const processedText = this.processResult(resultText);
    await this.fillInput(input, processedText);
    this.markElementProcessed(div);
    statsManager.record(window.location.hostname, elapsed);
  }

  private async svgToBlob(svg: SVGElement): Promise<Blob> {
    const svgData = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      setTimeout(reject, 5000);
    });
    const canvas = document.createElement('canvas');
    canvas.width = svg.clientWidth || 150;
    canvas.height = svg.clientHeight || 50;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('SVG转换失败'));
      }, 'image/png');
    });
  }

  private async recognizeAndFill(element: Element, input: HTMLInputElement): Promise<void> {
    if (this.processingElements.has(element)) return;
    this.processingElements.add(element);
    const startTime = Date.now();
    Logger.time('recognizeAndFill');
    try {
      this.eventEmitter?.emit('recognize:start', { element });
      const result = await this.ocr.recognize(element as HTMLImageElement);
      const processedText = this.processResult(result.text);
      this.eventEmitter?.emit('recognize:complete', { element, result: { text: processedText } });
      await this.fillInput(input, processedText);
      this.markElementProcessed(element);
      const elapsed = Date.now() - startTime;
      statsManager.record(window.location.hostname, elapsed);
      Logger.timeEnd('recognizeAndFill');
      Logger.info('识别完成:', processedText);
    } catch (error) {
      Logger.error('识别失败:', error);
      this.eventEmitter?.emit('recognize:error', { element, error: error as Error });
    } finally {
      this.processingElements.delete(element);
    }
  }

  private async recognizeAndFillBlob(element: Element, blob: Blob, input: HTMLInputElement): Promise<void> {
    if (this.processingElements.has(element)) return;
    this.processingElements.add(element);
    const startTime = Date.now();
    try {
      this.eventEmitter?.emit('recognize:start', { element });
      const result = await this.ocr.recognize(blob);
      const processedText = this.processResult(result.text);
      this.eventEmitter?.emit('recognize:complete', { element, result: { text: processedText } });
      await this.fillInput(input, processedText);
      this.markElementProcessed(element);
      const elapsed = Date.now() - startTime;
      statsManager.record(window.location.hostname, elapsed);
      Logger.info('识别完成:', processedText);
    } catch (error) {
      Logger.error('识别失败:', error);
      this.eventEmitter?.emit('recognize:error', { element, error: error as Error });
    } finally {
      this.processingElements.delete(element);
    }
  }

  private processResult(text: string): string {
    const config = getConfig();
    if (config.autoCalculate) {
      return Calculator.processResult(
        text, {
        autoCalculate: true,
        outputMode: config.calculateOutputMode,
        rules: config.calculateRules || [],
      },
        window.location.hostname
      );
    }
    return text;
  }

  private async fillInput(input: HTMLInputElement, text: string): Promise<void> {
    const config = getConfig();
    await this.autoFill.fill(input, text, {
      simulate: true,
      autoSubmit: config.autoSubmit ?? false,
      typewriterEffect: config.typewriterEffect,
    });
    if (config.enableNotification && typeof GM_notification !== 'undefined') {
      GM_notification({
        title: t('us.captchaFilled'),
        text: t('us.captchaFilledResult', text),
        timeout: 3000,
      });
    }
  }

  private processDetectedCaptcha(captcha: DetectedCaptcha): void {
    const input = captcha.inputElement || this.detector.findRelatedInput(captcha.element);
    if (!input) return;
    if (captcha.type === 'image') {
      this.recognizeAndFill(captcha.element, input);
    } else if (captcha.type === 'canvas') {
      const canvas = captcha.element as HTMLCanvasElement;
      canvas.toBlob((blob) => {
        if (blob) {
          this.recognizeAndFillBlob(canvas, blob, input);
        }
      }, 'image/png');
    }
  }

  private isCaptchaImage(img: HTMLImageElement): boolean {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width < CONSTANTS.MIN_CAPTCHA_WIDTH || height < CONSTANTS.MIN_CAPTCHA_HEIGHT) return false;
    if (width > CONSTANTS.MAX_CAPTCHA_WIDTH || height > CONSTANTS.MAX_CAPTCHA_HEIGHT) return false;
    const text = (img.src + img.className + img.id + img.alt + (img.getAttribute('data-src') || '')).toLowerCase();
    if (CONSTANTS.EXCLUDE_PATTERNS.some(pattern => text.includes(pattern))) return false;
    return CONSTANTS.CAPTCHA_KEYWORDS.some((keyword) => text.includes(keyword));
  }

  private isCaptchaCanvas(canvas: HTMLCanvasElement): boolean {
    const width = canvas.width;
    const height = canvas.height;
    if (width < CONSTANTS.MIN_CAPTCHA_WIDTH || height < CONSTANTS.MIN_CAPTCHA_HEIGHT) return false;
    if (width > CONSTANTS.MAX_CAPTCHA_WIDTH || height > CONSTANTS.MAX_CAPTCHA_HEIGHT) return false;
    const text = (canvas.className + canvas.id + (canvas.getAttribute('data-type') || '')).toLowerCase();
    if (CONSTANTS.EXCLUDE_PATTERNS.some(pattern => text.includes(pattern))) return false;
    return CONSTANTS.CAPTCHA_KEYWORDS.some((keyword) => text.includes(keyword));
  }

  private isCaptchaSVG(svg: SVGElement): boolean {
    const width = svg.clientWidth || parseInt(svg.getAttribute('width') || '0');
    const height = svg.clientHeight || parseInt(svg.getAttribute('height') || '0');
    if (width < CONSTANTS.MIN_CAPTCHA_WIDTH || height < CONSTANTS.MIN_CAPTCHA_HEIGHT) return false;
    if (width > CONSTANTS.MAX_CAPTCHA_WIDTH || height > CONSTANTS.MAX_CAPTCHA_HEIGHT) return false;
    const text = ((svg.className?.baseVal || '') + (svg.id || '')).toLowerCase();
    if (CONSTANTS.CAPTCHA_KEYWORDS.some((keyword) => text.includes(keyword))) return true;
    let parent = svg.parentElement;
    let depth = 0;
    while (parent && depth < 3) {
      const parentText = ((parent.className?.toString?.() || '') + (parent.id || '')).toLowerCase();
      if (CONSTANTS.CAPTCHA_KEYWORDS.some((keyword) => parentText.includes(keyword))) return true;
      parent = parent.parentElement;
      depth++;
    }
    const input = this.findNearbyInput(svg);
    if (!input) return false;
    const inputText = (input.name + input.id + input.className + input.placeholder).toLowerCase();
    return CONSTANTS.INPUT_KEYWORDS.some(keyword => inputText.includes(keyword));
  }

  private isCaptchaDiv(div: HTMLElement): boolean {
    const width = div.clientWidth;
    const height = div.clientHeight;
    if (width < CONSTANTS.MIN_CAPTCHA_WIDTH || height < CONSTANTS.MIN_CAPTCHA_HEIGHT) return false;
    if (width > CONSTANTS.MAX_CAPTCHA_WIDTH || height > CONSTANTS.MAX_CAPTCHA_HEIGHT) return false;
    const text = (div.className + div.id).toLowerCase();
    return CONSTANTS.CAPTCHA_KEYWORDS.some((keyword) => text.includes(keyword));
  }

  private findNearbyInput(element: Element): HTMLInputElement | null {
    const config = getConfig();
    if (config.inputSelector) {
      const input = document.querySelector(config.inputSelector);
      if (input instanceof HTMLInputElement) return input;
    }
    return this.detector.findRelatedInput(element);
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

  private hasElementChanged(element: Element): boolean {
    const currentHash = this.getElementHash(element);
    const previousHash = this.processedElements.get(element);
    if (!previousHash) return true;
    return currentHash !== previousHash;
  }

  private markElementProcessed(element: Element): void {
    const hash = this.getElementHash(element);
    this.processedElements.set(element, hash);
  }
}

class OCRApp {
  private ocr: DdddOCR;
  private detector: AutoDetector;
  private settingsUI: SettingsUI;
  private loadingIndicator: LoadingIndicator | null = null;
  private initialized = false;
  private eventEmitter: EventEmitter<OCREvents>;
  private menuCommandIds: Map<string, number> = new Map();

  constructor() {
    this.eventEmitter = new EventEmitter<OCREvents>();
    this.ocr = new DdddOCR();
    this.detector = new AutoDetector(this.ocr, this.eventEmitter);
    this.settingsUI = new SettingsUI();
    const config = getConfig();
    initLocale(config.language);
    Logger.setDebugMode(config.debugMode || false);
    this.registerMenuCommands();
    this.settingsUI.setOnConfigChange((config) => this.handleConfigChange(config));
  }

  async init(): Promise<void> {
    if (!shouldExecuteScript()) {
      Logger.debug('当前站点不满足执行条件');
      return;
    }
    if (this.initialized) return;
    this.initialized = true;
    this.loadingIndicator = new LoadingIndicator();
    Logger.info('DDDD OCR 启动');
    try {
      this.loadingIndicator.show(t('us.loading'));
      this.loadingIndicator.updateText(t('us.loadingModel'));
      await this.ocr.init();
      Logger.info('OCR 已就绪');
      this.loadingIndicator.updateText(t('us.ready'));
      const config = getConfig();
      if (config.autoDetect) {
        this.detector.start();
        Logger.info('自动检测已启动');
      }
      setTimeout(() => this.loadingIndicator?.hide(), 2000);
      this.showNotification(t('us.ready'), config.autoDetect ? t('us.readyAutoDetect') : t('us.readyManual'));
    } catch (error) {
      Logger.error('初始化失败:', error);
      this.loadingIndicator?.updateText(t('us.initFailedMsg', String(error)));
      setTimeout(() => this.loadingIndicator?.hide(), 3000);
      this.showNotification(t('us.initFailed'), String(error), true);
    }
  }

  private registerMenuCommands(): void {
    this.refreshMenuCommands();
  }

  private refreshMenuCommands(): void {
    // 先清除旧菜单
    for (const id of this.menuCommandIds.values()) {
      try { GM_unregisterMenuCommand(id); } catch {}
    }
    this.menuCommandIds.clear();

    const settingsId = GM_registerMenuCommand(t('us.menuOpenSettings'), () => this.settingsUI.show(), 's');
    this.menuCommandIds.set('settings', settingsId);

    const cacheId = GM_registerMenuCommand(t('us.menuClearCache'), async () => {
      Dialog.confirm({
        title: t('us.clearCacheTitle'),
        content: t('us.clearCacheMsg'),
        confirmText: t('us.clearCacheConfirm'),
        cancelText: t('common.cancel'),
        onConfirm: async () => {
          await clearModelCache();
          await clearWASMCache();
          this.showNotification(t('us.cacheCleared'), t('us.cacheClearedMsg'));
        },
      });
    }, 'd');
    this.menuCommandIds.set('cache', cacheId);

    const statusId = GM_registerMenuCommand(t('us.menuViewStatus'), () => this.showStatus(), 'i');
    this.menuCommandIds.set('status', statusId);
  }

  private showStatus(): void {
    const config = getConfig();
    const whitelisted = isWhitelisted();
    const rules = getSiteRules();
    const stats = statsManager.getStats();

    const yn = (v: boolean) => v ? t('common.enabled') : t('common.disabled');
    const content = `
<b>${t('status.scriptStatus')}</b> ${this.initialized ? t('status.initialized') : t('status.notInitialized')}
<b>${t('status.currentSite')}</b> ${window.location.hostname}
<b>${t('status.whitelistStatus')}</b> ${yn(config.enableWhitelist)}
<b>${t('status.whitelistCount')}</b> ${config.whitelist?.length || 0} ${t('common.sites')}
<b>${t('status.siteMatch')}</b> ${whitelisted ? t('status.inWhitelist') : t('status.notInWhitelist')}
<b>${t('status.autoDetect')}</b> ${yn(config.autoDetect)}
<b>${t('status.typewriterEffect')}</b> ${yn(config.typewriterEffect)}
<b>${t('status.autoCheckAgreement')}</b> ${yn(config.autoCheckAgreement)}
<b>${t('status.agreementSelectorCount')}</b> ${config.agreementSelectors?.length || 0}
<b>${t('status.autoCalculate')}</b> ${yn(config.autoCalculate)}
<b>${t('status.calcOutput')}</b> ${config.calculateOutputMode === 'result' ? t('status.calcOutputResult') : t('status.calcOutputEquation')}
<b>${t('status.calcRuleCount')}</b> ${config.calculateRules?.length || 0}
<b>${t('status.siteRuleCount')}</b> ${Object.keys(rules).length}
<b>${t('status.debugMode')}</b> ${yn(config.debugMode)}
<b>${t('status.uploadedModel')}</b> ${config.useUploadedModel ? t('common.enabled') : t('common.notEnabled')}
<b>${t('status.autoDownload')}</b> ${yn(config.autoDownload)}
<b>${t('status.totalRecognitions')}</b> ${stats.total} ${t('common.times')}`;

    Dialog.show({ title: t('status.title'), content });
  }

  private handleConfigChange(config: OCRConfig): void {
    // 更新 locale
    if (config.language === 'auto') {
      initLocale('auto');
    } else {
      setLocale(config.language as Locale);
    }

    Logger.setDebugMode(config.debugMode || false);
    if (config.autoDetect && !this.initialized) {
      this.init();
    }
    if (config.autoDetect) {
      this.detector.start();
    } else {
      this.detector.stop();
    }
    this.refreshMenuCommands();
  }

  private showNotification(title: string, text: string, isError = false): void {
    const config = getConfig();
    if (config.enableNotification && typeof GM_notification !== 'undefined') {
      GM_notification({ title, text, timeout: isError ? 5000 : 3000 });
    }
  }
}

function bootstrap(): void {
  const app = new OCRApp();
  if (!shouldExecuteScript()) {
    Logger.debug('DDDD OCR 不满足执行条件，仅注册菜单命令');
    return;
  }
  setTimeout(() => app.init(), 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

export { getSiteRules, saveSiteRule, deleteSiteRule, statsManager };