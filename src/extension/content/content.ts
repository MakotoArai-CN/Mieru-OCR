import './content.css';
import { CaptchaDetector, type DetectedCaptcha, type GuessedElement } from '@core/captcha-detector';
import { AutoFill } from '@core/auto-fill';
import { Calculator } from '@core/calculator';
import { CONSTANTS, Logger } from '@core/config';
import type { SiteRule } from '@core/types';
import { initLocale, t } from '@core/i18n';

let debugMode = false;
let contextInvalidated = false;
const detector = new CaptchaDetector();
const autoFill = new AutoFill();

let currentCaptcha: DetectedCaptcha | null = null;
let customInputElement: HTMLInputElement | null = null;
let customCaptchaElement: Element | null = null;

const processingElements = new Set<string>();

let autoDetectEnabled = true;
let autoFillEnabled = true;
let autoSubmitEnabled = false;
let imageContextMenuAutoFill = true;
let autoSolveOnRuleEnabled = true;
let autoDetectorStarted = false;

let typewriterEffect = true;
let autoCalculate = false;
let autoCheckAgreement = true;
let preserveFocus = false;
let calculateRules: any[] = [];
let agreementSelectors: string[] = [];

let captchaSelector = '';
let inputSelector = '';
let submitSelector = '';
let siteBlacklist: string[] = [];

let guessedElements: GuessedElement[] = [];
let guessMode: 'captcha' | 'input' | null = null;
let guessClickHandler: ((e: MouseEvent) => void) | null = null;

function isProcessing(): boolean {
  return processingElements.size > 0;
}
function isElementProcessing(id: string): boolean {
  return processingElements.has(id);
}
function startProcessing(id: string): boolean {
  if (processingElements.has(id)) return false;
  processingElements.add(id);
  return true;
}
function stopProcessing(id: string): void {
  processingElements.delete(id);
}

function normalizeCaptchaElement(el: Element | null): Element | null {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'img' || tag === 'canvas' || tag === 'svg') return el;
  if (el instanceof HTMLElement) {
    if (el.style && el.style.backgroundImage && el.style.backgroundImage !== 'none') return el;
    const inner = el.querySelector('img, canvas, svg');
    if (inner) return inner;
  }
  return null;
}

function queryInputElementBySelector(selector: string): HTMLInputElement | null {
  if (!selector || !selector.trim()) return null;
  try {
    const el = document.querySelector(selector);
    if (!el) return null;
    if (el instanceof HTMLInputElement) return el;
    if (el instanceof HTMLElement) {
      const input = el.querySelector('input');
      if (input instanceof HTMLInputElement) return input;
    }
  } catch { }
  return null;
}

function querySubmitElementBySelector(selector: string): HTMLElement | null {
  if (!selector || !selector.trim()) return null;
  try {
    const el = document.querySelector(selector);
    if (el instanceof HTMLElement) return el;
  } catch { }
  return null;
}

async function submitWithSelectorOrDefault(inputEl: HTMLInputElement): Promise<void> {
  if (submitSelector) {
    const btn = querySubmitElementBySelector(submitSelector);
    if (btn) {
      btn.click();
      return;
    }
  }
  await autoFill.submitForm(inputEl);
}

async function fillInputAndMaybeSubmit(inputEl: HTMLInputElement, text: string): Promise<void> {
  if (!autoFillEnabled) return;
  await autoFill.fill(inputEl, text, {
    simulate: true,
    autoSubmit: false,
    typewriterEffect: typewriterEffect,
    preserveFocus,
  });
  if (autoSubmitEnabled) {
    await submitWithSelectorOrDefault(inputEl);
  }
}

function getFullUrl(): string {
  return window.location.href;
}
function getUrlPattern(): string {
  return window.location.origin + window.location.pathname;
}

function isBlacklisted(): boolean {
  const hostname = location.hostname;
  const fullUrl = location.href;
  return siteBlacklist.some(pattern => {
    if (!pattern) return false;
    try {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp('^' + escaped + '$', 'i');
      if (regex.test(hostname)) return true;
      if (regex.test(fullUrl)) return true;
      if (!pattern.includes('*') && (fullUrl.startsWith(pattern) || fullUrl.split('#')[0] === pattern.split('#')[0] && pattern.includes('#'))) return true;
      return false;
    } catch {
      return hostname === pattern || fullUrl.startsWith(pattern);
    }
  });
}

function getCaptchaTypeFromElement(element: Element): 'image' | 'canvas' | 'svg' | 'background' {
  const tag = element.tagName.toLowerCase();
  if (tag === 'img') return 'image';
  if (tag === 'canvas') return 'canvas';
  if (tag === 'svg') return 'svg';
  if (element instanceof HTMLElement && element.style.backgroundImage) return 'background';
  return 'image';
}

function buildCaptchaFromElement(element: Element, id: string, inputElement: HTMLInputElement | null): DetectedCaptcha {
  const rect = element.getBoundingClientRect();
  return {
    id,
    type: getCaptchaTypeFromElement(element),
    element,
    rect,
    confidence: 100,
    inputElement,
    elementInfo: {
      tagName: element.tagName.toLowerCase(),
      id: (element as HTMLElement).id || null,
      className: (element as HTMLElement).className?.toString?.() || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      src: (element as HTMLImageElement).src,
    },
  };
}

function buildCaptchasFromSelector(selector: string): DetectedCaptcha[] {
  const result: DetectedCaptcha[] = [];
  if (!selector || !selector.trim()) return result;
  let list: NodeListOf<Element>;
  try {
    list = document.querySelectorAll(selector);
  } catch (e) {
    Logger.warn('无效的验证码选择器:', selector, e);
    return result;
  }
  let index = 0;
  list.forEach((el) => {
    const normalized = normalizeCaptchaElement(el);
    if (!normalized) return;
    const inputEl = resolveInputElementForCaptcha(normalized);
    result.push(buildCaptchaFromElement(normalized, `selector-${index++}`, inputEl));
  });
  return result;
}

function resolveInputElementForCaptcha(captchaElement: Element): HTMLInputElement | null {
  if (customInputElement) return customInputElement;
  const bySelector = queryInputElementBySelector(inputSelector);
  if (bySelector) return bySelector;
  const related = detector.findRelatedInput(captchaElement);
  if (related) return related;
  return null;
}

async function initSettings(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (response.success && response.settings) {
      debugMode = response.settings.debugMode || false;
      autoDetectEnabled = response.settings.autoDetect !== false;
      autoFillEnabled = response.settings.autoFill !== false;
      autoSubmitEnabled = !!response.settings.autoSubmit;
      imageContextMenuAutoFill = response.settings.imageContextMenuAutoFill !== false;
      autoSolveOnRuleEnabled = response.settings.autoSolveOnRule !== false;
      typewriterEffect = response.settings.typewriterEffect !== false;
      autoCalculate = !!response.settings.autoCalculate;
      autoCheckAgreement = response.settings.autoCheckAgreement !== false;
      preserveFocus = !!response.settings.preserveFocus;
      calculateRules = response.settings.calculateRules || [];
      agreementSelectors = response.settings.agreementSelectors || [];
      captchaSelector = response.settings.captchaSelector || '';
      inputSelector = response.settings.inputSelector || '';
      submitSelector = response.settings.submitSelector || '';
      siteBlacklist = response.settings.siteBlacklist || [];
      detector.setCustomPatterns(
        response.settings.customIncludeKeywords || [],
        response.settings.customExcludePatterns || [],
        response.settings.customAgreementKeywords || [],
        response.settings.customInputExcludeKeywords || [],
      );
      Logger.setDebugMode(debugMode);
      initLocale(response.settings.language || 'auto');
      Logger.info('设置已加载:', response.settings);
    }
  } catch (e) {
    Logger.error('加载设置失败:', e);
  }
}

async function init(): Promise<void> {
  await initSettings();
  Logger.info('内容脚本已加载', { url: getFullUrl(), hostname: location.hostname });
  chrome.runtime.onMessage.addListener(handleMessage);
  setTimeout(async () => {
    if (isBlacklisted()) {
      Logger.info('当前站点在黑名单中，跳过自动识别');
      return;
    }
    await checkAndApplySiteRule();
    scanPage();
    startAutoDetector();
    checkAgreementBoxes();
  }, 800);
}

function handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void): boolean {
  Logger.debug('收到消息:', message.action);
  switch (message.action) {
    case 'ping':
      sendResponse({ success: true });
      return true;
    case 'scan':
      handleScan(sendResponse);
      return true;
    case 'recognize':
      handleRecognize(message.captchaId, sendResponse);
      return true;
    case 'fill':
      handleFill(message.text, message.options, sendResponse);
      return true;
    case 'getStatus':
      handleGetStatus(sendResponse);
      return true;
    case 'startPicker':
      handleStartPicker(sendResponse);
      return true;
    case 'startInputPicker':
      handleStartInputPicker(sendResponse);
      return true;
    case 'previewCaptcha':
      handlePreviewCaptcha(message.captchaId, sendResponse);
      return true;
    case 'triggerAuto':
      handleTriggerAuto(sendResponse);
      return true;
    case 'updateSettings':
      initSettings().then(() => sendResponse({ success: true }));
      return true;
    case 'recognizeImageBySrc':
      handleRecognizeImageBySrc(message.srcUrl, sendResponse);
      return true;
    default:
      sendResponse({ success: false, error: t('content.unknownAction') });
  }
  return false;
}

/**
 * Recognize an image picked from the browser's right-click menu.
 * Behavior (Option C): always copy the result to the clipboard, additionally
 * try to fill a related input when imageContextMenuAutoFill is on, and surface
 * a toast so the user sees what happened. Clipboard is the never-fail path —
 * even if filling lands on the wrong field the user can paste manually.
 */
async function handleRecognizeImageBySrc(srcUrl: string, sendResponse: (r: any) => void): Promise<void> {
  if (!srcUrl) {
    sendResponse({ success: false, error: 'missing srcUrl' });
    return;
  }
  try {
    Logger.info('右键识别请求:', srcUrl);
    let imgEl: HTMLImageElement | null = null;
    for (const img of Array.from(document.querySelectorAll('img'))) {
      if (img instanceof HTMLImageElement && (img.src === srcUrl || img.currentSrc === srcUrl)) {
        imgEl = img;
        break;
      }
    }
    let imageData: string;
    if (imgEl) {
      imageData = await detector.captureImage({
        id: 'ctx-' + Date.now(),
        element: imgEl,
        type: 'image',
      } as unknown as DetectedCaptcha);
    } else {
      const resp = await fetch(srcUrl);
      const blob = await resp.blob();
      imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
    const response = await chrome.runtime.sendMessage({
      action: 'recognizeCaptcha',
      imageData,
    });
    if (!response?.success) {
      Logger.warn('右键识别失败:', response?.error);
      showContextMenuToast({ kind: 'error', errorMessage: response?.error || t('content.unknownError') });
      sendResponse({ success: false, error: response?.error });
      return;
    }
    let resultText: string = response.text;
    if (autoCalculate) {
      resultText = Calculator.processResult(
        response.text,
        { autoCalculate: true, outputMode: 'result', rules: calculateRules },
        location.hostname,
      );
    }
    Logger.info('右键识别结果:', resultText);

    // Always copy to clipboard — never-fail recovery path.
    let copied = false;
    try {
      await navigator.clipboard.writeText(resultText);
      copied = true;
    } catch (e) {
      Logger.warn('剪贴板写入失败:', e);
    }

    // Optionally also fill nearest input.
    // 注意：这里直接用 autoFill.fill()，不走 fillInputAndMaybeSubmit —— 后者会被全局
    // autoFillEnabled 总闸卡掉。但右键是用户主动操作，应只听 imageContextMenuAutoFill
    // 这一开关，否则会出现「我开了右键填充却没反应」的疑惑。
    let filled = false;
    let fillSkipReason: 'no-input' | 'fill-error' | null = null;
    if (imageContextMenuAutoFill) {
      let inputEl: HTMLInputElement | null = null;
      if (imgEl) inputEl = detector.findRelatedInput(imgEl);
      if (!inputEl) inputEl = queryInputElementBySelector(inputSelector);
      if (!inputEl) {
        fillSkipReason = 'no-input';
        Logger.info('右键识别：未找到可填入的输入框（已复制到剪贴板，用户可手动粘贴）');
      } else {
        try {
          await autoFill.fill(inputEl, resultText, {
            simulate: true,
            autoSubmit: false,
            typewriterEffect,
            preserveFocus,
          });
          filled = true;
          if (autoSubmitEnabled) {
            await submitWithSelectorOrDefault(inputEl);
          }
        } catch (e) {
          fillSkipReason = 'fill-error';
          Logger.warn('右键识别填充失败:', e);
        }
      }
    }

    showContextMenuToast({
      result: resultText,
      filled,
      copied,
      fillSkipReason,
      autoFillEnabled: imageContextMenuAutoFill,
    });
    sendResponse({ success: true, text: resultText, filled, copied });
  } catch (e) {
    Logger.error('右键识别出错:', e);
    showContextMenuToast({ kind: 'error', errorMessage: (e as Error).message });
    sendResponse({ success: false, error: (e as Error).message });
  }
}

/** Lightweight non-blocking toast for right-click results.
 *  Two-line layout: prominent result text on top, subtle status row below.
 *  Built with explicit DOM nodes (not innerHTML) to be CSP-safe and avoid
 *  injecting user-influenced text into HTML.
 */
type ContextToastInput =
  | { kind: 'error'; errorMessage: string }
  | {
    kind?: undefined;
    result: string;
    filled: boolean;
    copied: boolean;
    fillSkipReason: 'no-input' | 'fill-error' | null;
    autoFillEnabled: boolean;
  };

function showContextMenuToast(input: ContextToastInput): void {
  try {
    const id = 'ddddocr-ctx-toast';
    const old = document.getElementById(id);
    if (old) old.remove();

    const isError = input.kind === 'error';
    const wrapper = document.createElement('div');
    wrapper.id = id;
    const bg = isError
      ? 'linear-gradient(135deg,#ef4444,#dc2626)'
      : 'linear-gradient(135deg,#10b981,#059669)';
    wrapper.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px',
      'min-width:220px', 'max-width:380px',
      'padding:14px 18px',
      `background:${bg}`,
      'color:#fff',
      'border-radius:12px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif',
      'z-index:2147483647',
      'box-shadow:0 12px 32px rgba(0,0,0,.28)',
      'opacity:0', 'transform:translateY(8px)',
      'transition:opacity .25s ease,transform .25s ease',
    ].join(';');

    if (isError) {
      const label = document.createElement('div');
      label.textContent = t('ctxToast.errorLabel');
      label.style.cssText = 'font-size:11px;opacity:.85;letter-spacing:.5px;margin-bottom:4px;';
      wrapper.appendChild(label);
      const msg = document.createElement('div');
      msg.textContent = input.errorMessage;
      msg.style.cssText = 'font-size:14px;font-weight:500;line-height:1.4;word-break:break-all;';
      wrapper.appendChild(msg);
    } else {
      const { result, filled, copied, fillSkipReason, autoFillEnabled } = input;
      const label = document.createElement('div');
      label.textContent = t('ctxToast.resultLabel');
      label.style.cssText = 'font-size:11px;opacity:.85;letter-spacing:.5px;margin-bottom:4px;';
      wrapper.appendChild(label);

      const text = document.createElement('div');
      text.textContent = result;
      text.style.cssText = 'font-size:18px;font-weight:600;letter-spacing:1px;line-height:1.3;word-break:break-all;font-family:"SF Mono",Menlo,Monaco,Consolas,monospace;';
      wrapper.appendChild(text);

      const status = document.createElement('div');
      status.style.cssText = 'margin-top:8px;font-size:12px;opacity:.92;display:flex;flex-wrap:wrap;gap:10px;';
      const items: { ok: boolean; label: string }[] = [];
      if (autoFillEnabled) {
        if (filled) items.push({ ok: true, label: t('ctxToast.filled') });
        else if (fillSkipReason === 'no-input') items.push({ ok: false, label: t('ctxToast.noInput') });
        else if (fillSkipReason === 'fill-error') items.push({ ok: false, label: t('ctxToast.fillFailed') });
      }
      items.push(copied
        ? { ok: true, label: t('ctxToast.copied') }
        : { ok: false, label: t('ctxToast.copyFailed') });
      for (const it of items) {
        const chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
        const icon = document.createElement('span');
        icon.textContent = it.ok ? '✓' : '!';
        icon.style.cssText = `display:inline-flex;justify-content:center;align-items:center;width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,${it.ok ? '.22' : '.32'});font-size:10px;font-weight:700;`;
        chip.appendChild(icon);
        const txt = document.createElement('span');
        txt.textContent = it.label;
        chip.appendChild(txt);
        status.appendChild(chip);
      }
      wrapper.appendChild(status);
    }

    document.body.appendChild(wrapper);
    requestAnimationFrame(() => {
      wrapper.style.opacity = '1';
      wrapper.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      wrapper.style.opacity = '0';
      wrapper.style.transform = 'translateY(8px)';
    }, 3200);
    setTimeout(() => wrapper.remove(), 3600);
  } catch { /* DOM not ready / shadow root — silent */ }
}

async function checkAndApplySiteRule(): Promise<void> {
  try {
    const rulesResponse = await chrome.runtime.sendMessage({ action: 'getSiteRules' });
    const rules = rulesResponse.success ? rulesResponse.rules : {};
    Logger.debug('站点规则:', rules);
    const currentUrl = getFullUrl();
    const currentHostname = location.hostname;
    let matchedRule: (SiteRule & { hostname: string }) | null = null;
    for (const key of Object.keys(rules)) {
      const rule = rules[key];
      if (!rule.enabled) continue;
      if (rule.fullUrl && currentUrl === rule.fullUrl) {
        matchedRule = rule;
        Logger.debug('匹配完整URL规则:', rule);
        break;
      }
      if (rule.urlPattern && currentUrl.startsWith(rule.urlPattern)) {
        matchedRule = rule;
        Logger.debug('匹配URL模式规则:', rule);
        break;
      }
      if (rule.hostname === currentHostname && !rule.fullUrl && !rule.urlPattern) {
        matchedRule = rule;
        Logger.debug('匹配主机名规则:', rule);
      }
    }
    if (matchedRule) {
      const element = normalizeCaptchaElement(document.querySelector(matchedRule.selector));
      if (element) {
        let inputEl: HTMLInputElement | null = null;
        if (matchedRule.inputSelector) {
          inputEl = queryInputElementBySelector(matchedRule.inputSelector);
        }
        if (!inputEl) {
          inputEl = detector.findRelatedInput(element);
        }
        customCaptchaElement = element;
        customInputElement = inputEl;
        currentCaptcha = buildCaptchaFromElement(element, 'rule-selected', inputEl);
        Logger.info('应用站点规则, 验证码元素:', currentCaptcha.elementInfo);
        detector.highlight(currentCaptcha);
        setTimeout(() => detector.unhighlight(currentCaptcha!), 1200);
        if (autoSolveOnRuleEnabled) {
          setTimeout(() => tryAutoSolveOnce(), 500);
        }
      } else {
        Logger.warn('规则选择器未匹配到元素:', matchedRule.selector);
      }
    }
  } catch (error) {
    Logger.error('检查网站规则失败:', error);
  }
}

function checkAgreementBoxes(): void {
  if (!autoCheckAgreement) return;
  let agreementsToCheck: GuessedElement[] = [];
  if (agreementSelectors && agreementSelectors.length > 0) {
    agreementsToCheck = detector.findAgreementsBySelectors(agreementSelectors);
  }
  if (agreementsToCheck.length === 0) {
    agreementsToCheck = detector.guessAgreementCheckboxes();
  }
  Logger.debug('猜测的协议复选框:', agreementsToCheck);
  for (const agreement of agreementsToCheck) {
    const checkbox = agreement.element as HTMLInputElement;
    if (checkbox.checked) continue;
    const clickTarget = agreement.clickTarget;
    if (clickTarget) {
      clickTarget.click();
      Logger.info('点击协议复选框容器:', detector.generateSelector(clickTarget));
    } else {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      });
      checkbox.dispatchEvent(clickEvent);
      Logger.info('直接勾选协议复选框:', agreement.selector);
    }
    detector.markAgreementChecked(checkbox);
  }
}

function handleScan(sendResponse: (response: any) => void): void {
  try {
    Logger.time('handleScan');
    const captchas = customCaptchaElement
      ? [buildCaptchaFromElement(customCaptchaElement, 'custom', resolveInputElementForCaptcha(customCaptchaElement))]
      : (captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.scan());
    currentCaptcha = captchas.length > 0 ? captchas[0] : detector.getMostLikelyCaptcha();
    Logger.timeEnd('handleScan');
    sendResponse({
      success: true,
      captchas: captchas.map(c => ({
        id: c.id,
        type: c.type,
        confidence: c.confidence,
        hasInput: !!c.inputElement,
      })),
      bestCaptcha: currentCaptcha
        ? { id: currentCaptcha.id, type: currentCaptcha.type, confidence: currentCaptcha.confidence }
        : null,
    });
  } catch (error) {
    Logger.error('扫描失败:', error);
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function waitForReady(captcha: DetectedCaptcha, timeout = 8000): Promise<void> {
  if (captcha.type === 'image') {
    const img = captcha.element as HTMLImageElement;
    if (img.complete && img.naturalWidth > 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(t('content.imageTimeout')));
      }, timeout);
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(t('content.imageFailed')));
      };
      const cleanup = () => {
        clearTimeout(timer);
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });
    return;
  }
  await new Promise(resolve => requestAnimationFrame(resolve));
}

async function handleRecognize(captchaId: string, sendResponse: (response: any) => void): Promise<void> {
  const processId = captchaId || 'manual-' + Date.now();
  if (!startProcessing(processId)) {
    sendResponse({ success: false, error: t('content.processing') });
    return;
  }
  Logger.time('handleRecognize');
  try {
    let captcha: DetectedCaptcha | null = null;
    if (customCaptchaElement) {
      captcha = buildCaptchaFromElement(customCaptchaElement, 'custom-selected', resolveInputElementForCaptcha(customCaptchaElement));
    } else if (captchaSelector) {
      const list = buildCaptchasFromSelector(captchaSelector);
      captcha = captchaId ? (list.find(c => c.id === captchaId) || list[0] || null) : (list[0] || null);
    } else {
      const captchas = detector.getDetectedCaptchas();
      captcha = captchaId
        ? captchas.find(c => c.id === captchaId) || null
        : detector.getMostLikelyCaptcha();
    }
    if (!captcha) {
      throw new Error(t('content.captchaNotFound'));
    }
    const inputEl = resolveInputElementForCaptcha(captcha.element);
    if (!inputEl) {
      throw new Error(t('content.inputNotFound'));
    }
    captcha.inputElement = inputEl;
    currentCaptcha = captcha;

    detector.highlight(captcha);
    await waitForReady(captcha);
    const imageData = await detector.captureImage(captcha);
    Logger.debug('捕获验证码图像, 大小:', imageData.length);
    const response = await chrome.runtime.sendMessage({
      action: 'recognizeCaptcha',
      imageData,
    });
    detector.unhighlight(captcha);
    Logger.timeEnd('handleRecognize');

    if (response.success) {
      let resultText = response.text;
      if (autoCalculate) {
        resultText = Calculator.processResult(
          response.text, {
          autoCalculate: true,
          outputMode: 'result',
          rules: calculateRules,
        },
          location.hostname
        );
        Logger.debug('计算处理结果:', response.text, '->', resultText);
      }
      await fillInputAndMaybeSubmit(inputEl, resultText);
      Logger.info('自动填充完成:', resultText);
      detector.markElementProcessed(captcha.element);
      sendResponse({
        success: true,
        text: resultText,
        elapsed: response.elapsed,
        captchaId: captcha.id,
      });
      chrome.runtime.sendMessage({
        action: 'recordStats',
        hostname: location.hostname,
        elapsed: response.elapsed || 0,
      }).catch(() => { });
    } else {
      sendResponse({ success: false, error: response.error });
    }
  } catch (error) {
    Logger.error('识别失败:', error);
    if (currentCaptcha) detector.unhighlight(currentCaptcha);
    sendResponse({ success: false, error: (error as Error).message });
  } finally {
    stopProcessing(processId);
  }
}

async function handleFill(text: string, options: any, sendResponse: (response: any) => void): Promise<void> {
  try {
    const inputEl = customInputElement || queryInputElementBySelector(inputSelector) || currentCaptcha?.inputElement;
    if (!inputEl) {
      throw new Error(t('content.inputNotFound'));
    }
    const success = await autoFill.fill(inputEl, text, { ...options, typewriterEffect, preserveFocus });
    Logger.info('填充结果:', success ? '成功' : '失败');
    if (options?.autoSubmit) {
      await submitWithSelectorOrDefault(inputEl);
    }
    sendResponse({ success });
  } catch (error) {
    Logger.error('填充失败:', error);
    sendResponse({ success: false, error: (error as Error).message });
  }
}

function handleGetStatus(sendResponse: (response: any) => void): void {
  const captchas = captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.getDetectedCaptchas();
  const resolvedInput = customInputElement || queryInputElementBySelector(inputSelector) || currentCaptcha?.inputElement;
  const status = {
    success: true,
    isProcessing: isProcessing(),
    captchaCount: captchas.length,
    hasCaptcha: captchas.length > 0 || !!customCaptchaElement,
    currentCaptcha: currentCaptcha
      ? { id: currentCaptcha.id, type: currentCaptcha.type, confidence: currentCaptcha.confidence }
      : null,
    autoDetectEnabled,
    hasCustomInput: !!customInputElement,
    hasCustomCaptcha: !!customCaptchaElement,
    isReady: !!(customCaptchaElement || captchas.length > 0) && !!resolvedInput,
  };
  Logger.debug('状态查询:', status);
  sendResponse(status);
}

function handleStartPicker(sendResponse: (response: any) => void): void {
  initElementPicker('captcha', async (result) => {
    if (result.cancelled) {
      sendResponse({ success: false, cancelled: true });
      return;
    }
    if (result.success) {
      customCaptchaElement = normalizeCaptchaElement(result.element);
      if (!customCaptchaElement) {
        sendResponse({ success: false, error: t('picker.selectCaptcha') });
        return;
      }
      currentCaptcha = buildCaptchaFromElement(customCaptchaElement, 'manual-selected', resolveInputElementForCaptcha(customCaptchaElement));
      Logger.info('手动选择验证码元素:', result.selector);
      if (!customInputElement && !queryInputElementBySelector(inputSelector)) {
        startGuessMode('input', customCaptchaElement);
      } else {
        await saveAndRecognize(result.selector);
      }
      sendResponse({
        success: true,
        selector: result.selector,
        info: result.info,
        hostname: location.hostname,
        fullUrl: getFullUrl(),
        urlPattern: getUrlPattern(),
      });
    }
  });
}

function handleStartInputPicker(sendResponse: (response: any) => void): void {
  initElementPicker('input', async (result) => {
    if (result.cancelled) {
      sendResponse({ success: false, cancelled: true });
      return;
    }
    if (result.success && result.element instanceof HTMLInputElement) {
      customInputElement = result.element;
      if (currentCaptcha) {
        currentCaptcha.inputElement = customInputElement;
      }
      Logger.info('手动选择输入框:', result.selector);
      if (!customCaptchaElement) {
        startGuessMode('captcha', result.element);
      } else {
        await saveAndRecognize(undefined, result.selector);
      }
      sendResponse({
        success: true,
        selector: result.selector,
        info: result.info,
        hostname: location.hostname,
        fullUrl: getFullUrl(),
        urlPattern: getUrlPattern(),
      });
    } else {
      sendResponse({ success: false, error: t('picker.selectInput') });
    }
  });
}

function startGuessMode(mode: 'captcha' | 'input', referenceElement: Element): void {
  clearGuessMode();
  guessMode = mode;
  if (mode === 'captcha') {
    guessedElements = detector.guessRelatedCaptcha(referenceElement as HTMLInputElement);
  } else {
    guessedElements = detector.guessRelatedInput(referenceElement);
  }
  if (guessedElements.length === 0) {
    Logger.debug('未找到可猜测的元素');
    return;
  }
  Logger.info(`开始猜测模式: ${mode}, 找到 ${guessedElements.length} 个候选元素`);
  for (const guessed of guessedElements) {
    detector.highlightGuessed(guessed.element);
  }
  showGuessTooltip(mode);
  guessClickHandler = (e: MouseEvent) => {
    const target = e.target as Element;
    for (const guessed of guessedElements) {
      if (guessed.element === target || guessed.element.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        Logger.info('用户选择了猜测的元素:', guessed.selector);
        if (mode === 'captcha') {
          customCaptchaElement = guessed.element;
          currentCaptcha = buildCaptchaFromElement(guessed.element, 'guessed-selected', resolveInputElementForCaptcha(guessed.element));
          saveAndRecognize(guessed.selector);
        } else {
          customInputElement = guessed.element as HTMLInputElement;
          if (currentCaptcha) {
            currentCaptcha.inputElement = customInputElement;
          }
          saveAndRecognize(undefined, guessed.selector);
        }
        clearGuessMode();
        break;
      }
    }
  };
  document.addEventListener('click', guessClickHandler, true);
  setTimeout(() => {
    if (guessMode) {
      Logger.debug('猜测模式超时');
      clearGuessMode();
    }
  }, 30000);
}

function clearGuessMode(): void {
  if (guessClickHandler) {
    document.removeEventListener('click', guessClickHandler, true);
    guessClickHandler = null;
  }
  detector.unhighlightAllGuessed();
  hideGuessTooltip();
  guessedElements = [];
  guessMode = null;
}

function showGuessTooltip(mode: 'captcha' | 'input'): void {
  hideGuessTooltip();
  const tooltip = document.createElement('div');
  tooltip.id = 'ddddocr-guess-tooltip';
  tooltip.className = 'ddddocr-guessed-tooltip';
  tooltip.textContent = mode === 'captcha'
    ? t('picker.guessCaptcha')
    : t('picker.guessInput');
  tooltip.style.cssText = 'top: 10px; left: 50%; transform: translateX(-50%);';
  document.body.appendChild(tooltip);
}

function hideGuessTooltip(): void {
  const tooltip = document.getElementById('ddddocr-guess-tooltip');
  if (tooltip) {
    tooltip.remove();
  }
}

async function saveAndRecognize(captchaSelectorArg?: string, inputSelectorArg?: string): Promise<void> {
  if (!customCaptchaElement && !currentCaptcha) {
    Logger.warn('无验证码元素，无法保存规则');
    return;
  }
  const selector = captchaSelectorArg || detector.generateSelector(customCaptchaElement || currentCaptcha!.element);
  const inputSel = inputSelectorArg || (customInputElement ? detector.generateSelector(customInputElement) : undefined);
  try {
    await chrome.runtime.sendMessage({
      action: 'saveSiteRule',
      hostname: location.hostname,
      rule: {
        selector,
        inputSelector: inputSel,
        fullUrl: getFullUrl(),
        urlPattern: getUrlPattern(),
        enabled: true,
      },
    });
    Logger.info('规则已保存:', { selector, inputSelector: inputSel });
    if (customCaptchaElement && (customInputElement || queryInputElementBySelector(inputSelector))) {
      setTimeout(() => {
        tryAutoSolveOnce();
      }, 300);
    }
  } catch (error) {
    Logger.error('保存规则失败:', error);
  }
}

async function handlePreviewCaptcha(captchaId: string, sendResponse: (response: any) => void): Promise<void> {
  try {
    let captcha: DetectedCaptcha | null = null;
    if (customCaptchaElement) {
      captcha = buildCaptchaFromElement(customCaptchaElement, 'preview', resolveInputElementForCaptcha(customCaptchaElement));
    } else if (captchaSelector) {
      const list = buildCaptchasFromSelector(captchaSelector);
      captcha = captchaId ? (list.find(c => c.id === captchaId) || list[0] || null) : (list[0] || null);
    } else {
      const captchas = detector.getDetectedCaptchas();
      captcha = captchaId
        ? captchas.find(c => c.id === captchaId) || null
        : detector.getMostLikelyCaptcha();
    }
    if (!captcha) {
      throw new Error(t('content.captchaNotFound'));
    }
    const imageData = await detector.captureImage(captcha);
    showCaptchaPreview(imageData, captcha);
    sendResponse({ success: true, imageData });
  } catch (error) {
    Logger.error('预览失败:', error);
    sendResponse({ success: false, error: (error as Error).message });
  }
}

function handleTriggerAuto(sendResponse: (response: any) => void): void {
  try {
    startAutoDetector();
    setTimeout(() => {
      tryAutoSolveOnce();
    }, 200);
    sendResponse({ success: true });
  } catch (error) {
    Logger.error('触发自动识别失败:', error);
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function showCaptchaPreview(imageData: string, captcha: DetectedCaptcha): Promise<void> {
  const existing = document.getElementById('ddddocr-preview');
  if (existing) existing.remove();
  const settingsResponse = await chrome.runtime.sendMessage({ action: 'getSettings' });
  const theme = settingsResponse.settings?.theme || 'auto';
  let effectiveTheme = theme;
  if (theme === 'auto') {
    effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const isDark = effectiveTheme === 'dark';
  const colors = {
    bg: isDark ? '#1a1a2e' : '#ffffff',
    bgSecondary: isDark ? '#252540' : '#f8fbff',
    text: isDark ? '#ffffff' : '#1a1a2e',
    textSecondary: isDark ? '#a1a1aa' : '#52525b',
    primary: '#4A90E2',
    border: isDark ? '#27272a' : '#e4e4e7',
  };
  const overlay = document.createElement('div');
  overlay.id = 'ddddocr-preview';
  overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;`;
  const dialog = document.createElement('div');
  dialog.style.cssText = `background:${colors.bg};padding:24px;border-radius:16px;max-width:500px;color:${colors.text};border:1px solid ${colors.border};`;
  dialog.innerHTML = `
<h3 style="margin:0 0 16px 0;color:${colors.primary};">${t('popup.previewTitle')}</h3>
<div style="background:${colors.bgSecondary};padding:16px;border-radius:8px;text-align:center;margin-bottom:16px;border:1px solid ${colors.border};">
<img src="${imageData}" style="max-width:100%;border:2px solid #4CAF50;border-radius:4px;">
</div>
<div style="background:${colors.bgSecondary};padding:12px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid ${colors.border};">
<div style="color:${colors.textSecondary};"><strong style="color:${colors.text};">${t('popup.type')}</strong> ${captcha.type.toUpperCase()}</div>
<div style="color:${colors.textSecondary};margin-top:4px;"><strong style="color:${colors.text};">${t('popup.size')}</strong> ${captcha.elementInfo.width} × ${captcha.elementInfo.height}</div>
</div>
<button id="preview-close" style="width:100%;padding:10px;background:${colors.primary};color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px;">${t('common.close')}</button>
`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.getElementById('preview-close')!.onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

let observer: MutationObserver | null = null;
let intervalTimer: number | null = null;
let initialTimer: number | null = null;
let pendingTimer: number | null = null;
let agreementCheckTimer: number | null = null;

function isContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function destroyAutoDetector(): void {
  contextInvalidated = true;
  autoDetectEnabled = false;
  autoDetectorStarted = false;
  if (observer) { observer.disconnect(); observer = null; }
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (agreementCheckTimer) { clearTimeout(agreementCheckTimer); agreementCheckTimer = null; }
  Logger.info('扩展上下文已失效，自动识别已停止');
}

function guardContext(): boolean {
  if (contextInvalidated) return false;
  if (!isContextValid()) {
    destroyAutoDetector();
    return false;
  }
  return true;
}

/**
 * Heuristic: is this element inside a scrollable/virtualized container?
 * Virtual scroll libraries (react-virtualized, vue-virtual-scroller, ant-table-body, etc.)
 * append items dynamically. Reacting to those mutations causes a feedback loop:
 * scan -> getBoundingClientRect (forced layout) -> IntersectionObserver fires
 * inside the virtual list -> list loads more items -> mutation -> scan ...
 * Skip mutations from inside such containers — captchas are virtually never
 * placed inside a virtual list.
 */
function isInsideScrollableContainer(node: Node | null): boolean {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  let depth = 0;
  while (el && depth < 8) {
    if (el === document.body || el === document.documentElement) return false;
    const cls = ((el as HTMLElement).className?.toString?.() || '').toLowerCase();
    const role = el.getAttribute?.('role') || '';
    if (
      cls.includes('virtual') ||
      cls.includes('vue-recycle-scroller') ||
      cls.includes('rv-') ||
      cls.includes('-table-body') ||
      cls.includes('-table-tbody') ||
      cls.includes('infinite-scroll') ||
      role === 'grid' ||
      role === 'listbox' ||
      role === 'feed' ||
      role === 'rowgroup'
    ) return true;
    const style = (el as HTMLElement).style;
    if (style && (style.overflow === 'auto' || style.overflow === 'scroll' ||
        style.overflowY === 'auto' || style.overflowY === 'scroll')) {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.height > 200 && (el as HTMLElement).scrollHeight > rect.height + 50) return true;
    }
    el = el.parentElement;
    depth++;
  }
  return false;
}

/** Hard throttle for scan triggers — even debounced calls can pile up if mutations
 *  are continuous. We refuse to scan more often than this regardless of triggers. */
const MIN_SCAN_INTERVAL_MS = 1500;
let lastScanTriggerTime = 0;

function startAutoDetector(): void {
  if (autoDetectorStarted) return;
  autoDetectorStarted = true;
  Logger.info('自动识别已启用');
  scheduleInitialAuto();
  observer = new MutationObserver((mutations) => {
    if (!guardContext()) return;
    let shouldCheckAgreements = false;
    let triggerScan = false;
    for (const mutation of mutations) {
      // Skip mutations originating from scrollable/virtualized containers
      if (isInsideScrollableContainer(mutation.target)) continue;

      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            if (node.matches('img, canvas, svg')) triggerScan = true;
            else if (node.querySelector('img, canvas, svg')) triggerScan = true;
            else if (node.style && node.style.backgroundImage) triggerScan = true;
            if (node.matches('input[type="checkbox"]') || node.querySelector('input[type="checkbox"]')) {
              shouldCheckAgreements = true;
            }
            if (node.classList.contains('el-checkbox') || node.querySelector('.el-checkbox')) {
              shouldCheckAgreements = true;
            }
            if (node.classList.contains('ant-checkbox') || node.querySelector('.ant-checkbox')) {
              shouldCheckAgreements = true;
            }
          }
        });
        if (mutation.target instanceof SVGElement) {
          triggerScan = true;
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (target instanceof HTMLElement) {
          if (target instanceof HTMLImageElement) {
            if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src' || mutation.attributeName === 'srcset') {
              triggerScan = true;
            }
          } else if (target instanceof HTMLCanvasElement) {
            triggerScan = true;
          } else if (target instanceof SVGElement) {
            triggerScan = true;
          } else if (mutation.attributeName === 'style' && target.style.backgroundImage) {
            triggerScan = true;
          }
        }
      }
    }
    if (triggerScan) scheduleAutoSolve();
    if (shouldCheckAgreements) {
      scheduleAgreementCheck();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'data-src', 'srcset', 'style', 'href'],
  });
  intervalTimer = window.setInterval(() => {
    if (!guardContext()) return;
    const captchas = captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.scan();
    if (!captchas || captchas.length === 0) return;
    let changed = false;
    for (const c of captchas) {
      if (detector.hasElementChanged(c.element)) {
        changed = true;
        break;
      }
    }
    if (changed) scheduleAutoSolve();
    checkAgreementBoxes();
  }, CONSTANTS.AUTO_DETECT_INTERVAL);
}

function scheduleAgreementCheck(): void {
  if (agreementCheckTimer) clearTimeout(agreementCheckTimer);
  agreementCheckTimer = window.setTimeout(() => {
    if (!guardContext()) return;
    checkAgreementBoxes();
  }, 500);
}

function scheduleInitialAuto(): void {
  if (initialTimer) clearTimeout(initialTimer);
  initialTimer = window.setTimeout(() => {
    if (!guardContext()) return;
    scheduleAutoSolve();
    window.setTimeout(() => {
      if (!guardContext()) return;
      scheduleAutoSolve();
    }, 2500);
  }, 300);
}

function scheduleAutoSolve(): void {
  if (!autoDetectEnabled || !guardContext()) return;
  // Hard throttle: even if mutations are continuous (e.g. a virtual list still
  // settling), we refuse to fire scans more often than MIN_SCAN_INTERVAL_MS.
  const now = Date.now();
  const sinceLast = now - lastScanTriggerTime;
  if (pendingTimer) clearTimeout(pendingTimer);
  const delay = sinceLast >= MIN_SCAN_INTERVAL_MS
    ? 300
    : Math.max(300, MIN_SCAN_INTERVAL_MS - sinceLast);
  pendingTimer = window.setTimeout(() => {
    lastScanTriggerTime = Date.now();
    tryAutoSolveOnce();
  }, delay);
}

function tryAutoSolveOnce(): void {
  if (!autoDetectEnabled || !guardContext()) return;
  Logger.debug('尝试自动识别...');

  const fixedInput = queryInputElementBySelector(inputSelector);

  if (customCaptchaElement) {
    const inputEl = customInputElement || fixedInput || detector.findRelatedInput(customCaptchaElement);
    if (!inputEl) return;
    if (detector.hasElementChanged(customCaptchaElement)) {
      const captcha = buildCaptchaFromElement(customCaptchaElement, 'custom', inputEl);
      internalRecognizeAndFill(captcha);
    }
    return;
  }

  const captchas = captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.scan();
  if (!captchas || captchas.length === 0) return;

  const captchasToProcess: DetectedCaptcha[] = [];
  for (const captcha of captchas) {
    const inputEl = customInputElement || fixedInput || captcha.inputElement || detector.findRelatedInput(captcha.element);
    if (!inputEl) continue;
    if (!detector.hasElementChanged(captcha.element)) continue;
    if (isElementProcessing(captcha.id)) continue;
    captchasToProcess.push({ ...captcha, inputElement: inputEl });
  }

  if (captchasToProcess.length === 0) return;
  Logger.info(`发现 ${captchasToProcess.length} 个待处理验证码`);
  for (const captcha of captchasToProcess) {
    internalRecognizeAndFill(captcha);
  }
}

async function internalRecognizeAndFill(captcha: DetectedCaptcha): Promise<void> {
  if (!guardContext()) return;
  if (!startProcessing(captcha.id)) return;
  currentCaptcha = captcha;
  const startTime = Date.now();
  Logger.time('internalRecognizeAndFill');
  try {
    detector.highlight(captcha);
    await waitForReady(captcha);
    const imageData = await detector.captureImage(captcha);
    Logger.debug('发送识别请求...');
    const response = await chrome.runtime.sendMessage({
      action: 'recognizeCaptcha',
      imageData,
    });
    detector.unhighlight(captcha);
    if (!response?.success) {
      Logger.warn('识别失败:', response?.error);
      return;
    }
    let resultText = response.text;
    if (autoCalculate) {
      resultText = Calculator.processResult(
        response.text, {
        autoCalculate: true,
        outputMode: 'result',
        rules: calculateRules,
      },
        location.hostname
      );
    }
    Logger.info('识别结果:', resultText);

    const inputEl = captcha.inputElement || queryInputElementBySelector(inputSelector);
    if (inputEl) {
      await fillInputAndMaybeSubmit(inputEl, resultText);
    }
    detector.markElementProcessed(captcha.element);
    const elapsed = typeof response.elapsed === 'number' ? response.elapsed : (Date.now() - startTime);
    chrome.runtime.sendMessage({
      action: 'recordStats',
      hostname: location.hostname,
      elapsed,
    }).catch(() => { });
    Logger.timeEnd('internalRecognizeAndFill');
  } catch (e) {
    Logger.error('识别填充失败:', e);
    try { detector.unhighlight(captcha); } catch { }
  } finally {
    stopProcessing(captcha.id);
  }
}

function initElementPicker(mode: 'captcha' | 'input', callback: (result: any) => void): void {
  let isActive = true;
  let hoveredElement: Element | null = null;
  const overlay = document.createElement('div');
  overlay.id = 'ddddocr-picker-overlay';
  overlay.style.cssText = 'position:fixed;pointer-events:none;border:3px solid #6366f1;background:rgba(99,102,241,0.15);z-index:999998;display:none;border-radius:4px;';
  document.body.appendChild(overlay);
  const tooltipText = mode === 'captcha' ? t('picker.selectCaptcha') : t('picker.selectInput');
  const tooltip = document.createElement('div');
  tooltip.id = 'ddddocr-picker-tooltip';
  tooltip.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#1a1a2e,#16213e);color:white;padding:12px 24px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.5);display:flex;align-items:center;gap:16px;border:1px solid #6366f1;';
  tooltip.innerHTML = `<span>${tooltipText}</span><span id="picker-info" style="color:#a1a1aa;font-size:12px;"></span><button id="picker-cancel" style="background:#ef4444;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">${t('picker.cancel')}</button>`;
  document.body.appendChild(tooltip);
  function cleanup(): void {
    isActive = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    overlay.remove();
    tooltip.remove();
  }
  function handleMouseMove(e: MouseEvent): void {
    if (!isActive) return;
    const element = document.elementFromPoint(e.clientX, e.clientY);
    if (!element || element.id.includes('ddddocr')) return;
    let target: Element | null = null;
    if (mode === 'captcha') {
      if (['IMG', 'CANVAS', 'SVG'].includes(element.tagName)) {
        target = element;
      } else if (element instanceof HTMLElement && element.style.backgroundImage) {
        target = element;
      } else {
        target = element.querySelector('img, canvas, svg') || element.closest('img, canvas, svg');
      }
    } else {
      if (element.tagName === 'INPUT') {
        target = element;
      } else {
        target = element.closest('input');
      }
    }
    if (target) {
      hoveredElement = target;
      const rect = target.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.top = rect.top + 'px';
      overlay.style.left = rect.left + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';
      const infoEl = document.getElementById('picker-info');
      if (infoEl) {
        let info = target.tagName.toLowerCase();
        if ((target as HTMLElement).id) info += '#' + (target as HTMLElement).id;
        info += ` (${Math.round(rect.width)}×${Math.round(rect.height)})`;
        infoEl.textContent = info;
      }
    } else {
      overlay.style.display = 'none';
      hoveredElement = null;
    }
  }
  function handleClick(e: MouseEvent): void {
    if (!isActive) return;
    e.preventDefault();
    e.stopPropagation();
    if (hoveredElement) {
      const selector = detector.generateSelector(hoveredElement);
      const rect = hoveredElement.getBoundingClientRect();
      cleanup();
      callback({
        success: true,
        element: hoveredElement,
        selector,
        info: {
          tagName: hoveredElement.tagName.toLowerCase(),
          id: (hoveredElement as HTMLElement).id || null,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    }
  }
  function handleKeyDown(e: KeyboardEvent): void {
    if (!isActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
      callback({ cancelled: true });
    }
  }
  document.getElementById('picker-cancel')!.addEventListener('click', () => {
    cleanup();
    callback({ cancelled: true });
  });
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
}

function scanPage(): void {
  const captchas = captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.scan();
  if (captchas.length > 0) {
    Logger.info(`扫描发现 ${captchas.length} 个验证码`);
    chrome.runtime.sendMessage({
      action: 'captchaDetected',
      count: captchas.length,
      bestConfidence: detector.getMostLikelyCaptcha()?.confidence || 0,
    }).catch(() => { });
  }
}

init();