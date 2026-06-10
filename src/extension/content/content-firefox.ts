import './content.css';
import { CaptchaDetector, type DetectedCaptcha, type GuessedElement } from '@core/captcha-detector';
import { AutoFill } from '@core/auto-fill';
import { Calculator } from '@core/calculator';
import { solveSlider } from '@core/interaction/slider-solver';
import { solveClickSelect, type LabeledBox } from '@core/interaction/click-select-solver';
import { assistCloudflare, isCloudflareFrame, detectTurnstile } from '@core/interaction/cloudflare';
import type { ImageLike } from '@core/slide-detector';
import { CONSTANTS, Logger } from '@core/config';
import type { SiteRule } from '@core/types';
import { initLocale, t } from '@core/i18n';

declare const browser: any;

/** 当前 content.js 是否运行在顶层文档（all_frames:true 后 sub-frame 同样会注入本脚本）。 */
const IS_TOP_FRAME: boolean = (() => {
  try { return window.top === window; } catch { return false; }
})();

let debugMode = false;
let contextInvalidated = false;
const detector = new CaptchaDetector();
const autoFill = new AutoFill();

let currentCaptcha: DetectedCaptcha | null = null;
let customInputElement: HTMLInputElement | null = null;
let customCaptchaElement: Element | null = null;
/** customCaptchaElement 为交互式（来自带 subType 的规则）时记录类型，tryAutoSolveOnce 重建时保留。 */
let customCaptchaSubType: 'slider' | 'click-select' | null = null;

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
let deepScan = false;

// 交互式验证码辅助开关——一律默认关闭，仅用户在设置里开启后才启用。
let enableSliderPuzzleAssist = false;
let enableSingleSliderAssist = false;
let enableClickSelectAssist = false;
let enableInteractiveCaptchaAssist = false;

let guessedElements: GuessedElement[] = [];
let guessMode: 'captcha' | 'input' | null = null;
let guessClickHandler: ((e: MouseEvent) => void) | null = null;

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

/**
 * 交互式验证码（滑块/点选）求解的冷却表。容器多为普通 div，getElementHash 返回空串，
 * hasElementChanged 恒为 true，会导致每次扫描都重试——失败时日志刷屏、CPU 空转、观感"卡"。
 * 求解后（无论成败）记录时间戳，冷却期内不再对同一容器重试。成功用长冷却，失败用短冷却。
 */
const interactiveCooldown = new WeakMap<Element, number>();
const INTERACTIVE_COOLDOWN_OK_MS = 30000;   // 成功后 30s 内不重试
const INTERACTIVE_COOLDOWN_FAIL_MS = 8000;  // 失败后 8s 退避再试
function isInteractiveCoolingDown(el: Element): boolean {
  const until = interactiveCooldown.get(el);
  return until !== undefined && Date.now() < until;
}
function setInteractiveCooldown(el: Element, ok: boolean): void {
  interactiveCooldown.set(el, Date.now() + (ok ? INTERACTIVE_COOLDOWN_OK_MS : INTERACTIVE_COOLDOWN_FAIL_MS));
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

async function initSettings(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ action: 'getSettings' });
    if (response && response.success && response.settings) {
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
      deepScan = !!response.settings.deepScan;
      // 交互辅助开关：缺省 undefined → false，确保默认关闭。
      enableSliderPuzzleAssist = !!response.settings.enableSliderPuzzleAssist;
      enableSingleSliderAssist = !!response.settings.enableSingleSliderAssist;
      enableClickSelectAssist = !!response.settings.enableClickSelectAssist;
      enableInteractiveCaptchaAssist = !!response.settings.enableInteractiveCaptchaAssist;
      calculateRules = response.settings.calculateRules || [];
      agreementSelectors = response.settings.agreementSelectors || [];
      captchaSelector = response.settings.captchaSelector || '';
      inputSelector = response.settings.inputSelector || '';
      submitSelector = response.settings.submitSelector || '';
      siteBlacklist = response.settings.siteBlacklist || [];
      detector.setCustomPatterns(
        response.settings.customIncludeKeywords || [],
        response.settings.customExcludePatterns || []
      );
      Logger.setDebugMode(debugMode);
      initLocale(response.settings.language || 'auto');
      Logger.info('设置已加载:', response.settings);
    }
  } catch (e) {
    Logger.error('加载设置失败:', e);
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

function resolveInputElementForCaptcha(captchaElement: Element): HTMLInputElement | null {
  if (customInputElement) return customInputElement;
  const bySelector = queryInputElementBySelector(inputSelector);
  if (bySelector) return bySelector;
  const related = detector.findRelatedInput(captchaElement);
  if (related) return related;
  return null;
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

async function init(): Promise<void> {
  await initSettings();

  // 子框架启动门控：未启用「深度扫描」时直接退出，避免在广告 / 分析 iframe 中徒增开销。
  if (!IS_TOP_FRAME && !deepScan) {
    return;
  }

  Logger.info('内容脚本已加载 (Firefox)', {
    url: getFullUrl(),
    hostname: location.hostname,
    topFrame: IS_TOP_FRAME,
    deepScan,
  });

  if (deepScan) {
    installFrameBridge();
    if (!IS_TOP_FRAME) {
      requestParentHostInfo();
    }
  }

  browser.runtime.onMessage.addListener((message: any, sender: any) => {
    return new Promise((resolve) => {
      handleMessage(message, sender, resolve);
    });
  });

  setTimeout(async () => {
    if (isBlacklisted()) {
      Logger.info('当前站点在黑名单中，跳过自动识别');
      return;
    }
    await checkAndApplySiteRule();
    scanPage();
    startAutoDetector();
    checkAgreementBoxes();
  }, IS_TOP_FRAME ? 800 : 1200);
}

function handleMessage(message: any, _sender: any, sendResponse: (response: any) => void): void {
  Logger.debug('收到消息:', message.action);
  switch (message.action) {
    case 'ping':
      sendResponse({ success: true });
      break;
    case 'scan':
      handleScan(sendResponse);
      break;
    case 'recognize':
      handleRecognize(message.captchaId, sendResponse);
      break;
    case 'fill':
      handleFill(message.text, message.options, sendResponse);
      break;
    case 'getStatus':
      handleGetStatus(sendResponse);
      break;
    case 'startPicker':
      handleStartPicker(sendResponse);
      break;
    case 'startInputPicker':
      handleStartInputPicker(sendResponse);
      break;
    case 'previewCaptcha':
      handlePreviewCaptcha(message.captchaId, sendResponse);
      break;
    case 'triggerAuto':
      handleTriggerAuto(sendResponse);
      break;
    case 'updateSettings':
      initSettings().then(() => sendResponse({ success: true }));
      break;
    case 'recognizeImageBySrc':
      handleRecognizeImageBySrc(message.srcUrl, sendResponse);
      break;
    default:
      sendResponse({ success: false, error: t('content.unknownAction') });
  }
}

async function handleRecognizeImageBySrc(srcUrl: string, sendResponse: (r: any) => void): Promise<void> {
  if (!srcUrl) {
    sendResponse({ success: false, error: 'missing srcUrl' });
    return;
  }
  try {
    Logger.info('右键识别请求:', srcUrl, { topFrame: IS_TOP_FRAME });
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
    const response = await browser.runtime.sendMessage({
      action: 'recognizeCaptcha',
      imageData,
    });
    if (!response?.success) {
      Logger.warn('右键识别失败:', response?.error);
      reportContextResult({ kind: 'error', errorMessage: response?.error || t('content.unknownError') });
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

    let filled = false;
    let fillSkipReason: 'no-input' | 'fill-error' | null = null;
    if (imageContextMenuAutoFill) {
      let inputEl: HTMLInputElement | null = null;
      if (imgEl) inputEl = detector.findRelatedInput(imgEl);
      if (!inputEl) inputEl = queryInputElementBySelector(inputSelector);
      if (!inputEl) {
        fillSkipReason = 'no-input';
        Logger.info('右键识别：未找到可填入的输入框');
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

    reportContextResult({
      result: resultText,
      filled,
      fillSkipReason,
      autoFillEnabled: imageContextMenuAutoFill,
    });
    sendResponse({ success: true, text: resultText, filled });
  } catch (e) {
    Logger.error('右键识别出错:', e);
    reportContextResult({ kind: 'error', errorMessage: (e as Error).message });
    sendResponse({ success: false, error: (e as Error).message });
  }
}

/** Sub-frame 转发右键识别结果到顶层 frame，由顶层完成剪贴板写入与 toast 展示。 */
function reportContextResult(
  payload: { kind: 'error'; errorMessage: string }
    | { result: string; filled: boolean; fillSkipReason: 'no-input' | 'fill-error' | null; autoFillEnabled: boolean }
): void {
  if (IS_TOP_FRAME || !deepScan) {
    deliverContextResult(payload);
    return;
  }
  try {
    window.top?.postMessage({
      _mieru: MIERU_MSG_NS,
      type: 'ctx-result',
      payload,
    }, '*');
    Logger.info('[deepScan] 右键识别结果转发到顶层 (Firefox)', { kind: (payload as any).kind || 'ok' });
  } catch (e) {
    Logger.warn('[deepScan] 转发右键结果失败，回退本地展示 (Firefox)', e);
    deliverContextResult(payload);
  }
}

async function deliverContextResult(
  payload: { kind: 'error'; errorMessage: string }
    | { result: string; filled: boolean; fillSkipReason: 'no-input' | 'fill-error' | null; autoFillEnabled: boolean }
): Promise<void> {
  if ((payload as any).kind === 'error') {
    showContextMenuToast(payload as any);
    return;
  }
  const ok = payload as { result: string; filled: boolean; fillSkipReason: 'no-input' | 'fill-error' | null; autoFillEnabled: boolean };
  let copied = false;
  try {
    await navigator.clipboard.writeText(ok.result);
    copied = true;
  } catch (e) {
    Logger.warn('剪贴板写入失败:', e);
  }
  showContextMenuToast({
    result: ok.result,
    filled: ok.filled,
    copied,
    fillSkipReason: ok.fillSkipReason,
    autoFillEnabled: ok.autoFillEnabled,
  });
}

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
    const id = 'Mieru-ctx-toast';
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
  } catch { /* silent */ }
}

async function checkAndApplySiteRule(): Promise<void> {
  try {
    const rulesResponse = await browser.runtime.sendMessage({ action: 'getSiteRules' });
    const rules = (rulesResponse && rulesResponse.success) ? rulesResponse.rules : {};
    Logger.debug('站点规则:', rules);
    const currentUrl = getFullUrl();
    const currentHostname = location.hostname;

    const candidateHostnames = new Set<string>([currentHostname]);
    if (!IS_TOP_FRAME && parentHostname) {
      candidateHostnames.add(parentHostname);
    }

    let matchedRule: (SiteRule & { hostname: string }) | null = null;
    for (const key of Object.keys(rules)) {
      const rule = rules[key];
      if (!rule.enabled) continue;

      // 接力规则归属判定：顶层跳过；子框架需 frameUrl 与自身匹配
      if (rule.frameSelector) {
        if (IS_TOP_FRAME) continue;
        if (!frameUrlMatchesSelf(rule.frameUrl)) continue;
      }

      if (rule.fullUrl && currentUrl === rule.fullUrl) {
        matchedRule = rule;
        break;
      }
      if (rule.urlPattern && currentUrl.startsWith(rule.urlPattern)) {
        matchedRule = rule;
        break;
      }
      if (candidateHostnames.has(rule.hostname) && !rule.fullUrl && !rule.urlPattern) {
        matchedRule = rule;
      }
    }
    if (matchedRule) {
      // 交互式规则（滑块/点选）：目标是容器，不能 normalizeCaptchaElement（会下钻成内部 canvas）。
      if (matchedRule.subType === 'slider' || matchedRule.subType === 'click-select') {
        const container = document.querySelector(matchedRule.selector);
        if (container) {
          const interactive = detector.buildInteractiveCaptcha(container, matchedRule.subType, 'rule');
          if (interactive) {
            customCaptchaElement = container;
            customCaptchaSubType = matchedRule.subType;
            currentCaptcha = interactive;
            Logger.info('应用站点规则（交互式）:', {
              subType: matchedRule.subType,
              ...interactive.elementInfo,
              viaFrameRule: !!matchedRule.frameSelector,
              topFrame: IS_TOP_FRAME,
            });
            detector.highlight(currentCaptcha);
            setTimeout(() => detector.unhighlight(currentCaptcha!), 1200);
            if (autoSolveOnRuleEnabled) {
              setTimeout(() => tryAutoSolveOnce(), 500);
            }
          } else {
            Logger.warn('交互式规则容器内无 canvas/img:', matchedRule.selector);
          }
        } else {
          Logger.warn('规则选择器未匹配到元素:', matchedRule.selector);
        }
        return;
      }
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
        Logger.info('应用站点规则, 验证码元素:', {
          ...currentCaptcha.elementInfo,
          viaFrameRule: !!matchedRule.frameSelector,
          topFrame: IS_TOP_FRAME,
        });
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

function frameUrlMatchesSelf(frameUrl: string | undefined): boolean {
  if (!frameUrl) return true;
  try {
    const a = new URL(frameUrl);
    const b = new URL(location.href);
    if (a.origin !== b.origin) return false;
    if (a.pathname === b.pathname) return true;
    return b.pathname.startsWith(a.pathname.replace(/[^/]+$/, ''));
  } catch {
    return false;
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
      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      checkbox.dispatchEvent(clickEvent);
      Logger.info('直接勾选协议复选框:', agreement.selector);
    }
    detector.markAgreementChecked(checkbox);
  }
}

function handleScan(sendResponse: (response: any) => void): void {
  try {
    const captchas = customCaptchaElement
      ? [buildCaptchaFromElement(customCaptchaElement, 'custom', resolveInputElementForCaptcha(customCaptchaElement))]
      : (captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.scan());
    currentCaptcha = captchas.length > 0 ? captchas[0] : detector.getMostLikelyCaptcha();
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
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function waitForReady(captcha: DetectedCaptcha, timeout = 8000): Promise<void> {
  if (captcha.type === 'image') {
    const img = captcha.element as HTMLImageElement;
    if (img.complete && img.naturalWidth > 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(t('content.imageTimeout'))); }, timeout);
      const onLoad = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error(t('content.imageFailed'))); };
      const cleanup = () => { clearTimeout(timer); img.removeEventListener('load', onLoad); img.removeEventListener('error', onError); };
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
  try {
    let captcha: DetectedCaptcha | null = null;
    if (customCaptchaElement) {
      captcha = buildCaptchaFromElement(customCaptchaElement, 'custom-selected', resolveInputElementForCaptcha(customCaptchaElement));
    } else if (captchaSelector) {
      const list = buildCaptchasFromSelector(captchaSelector);
      captcha = captchaId ? (list.find(c => c.id === captchaId) || list[0] || null) : (list[0] || null);
    } else {
      const captchas = detector.getDetectedCaptchas();
      captcha = captchaId ? captchas.find(c => c.id === captchaId) || null : detector.getMostLikelyCaptcha();
    }
    if (!captcha) throw new Error(t('content.captchaNotFound'));
    currentCaptcha = captcha;

    const inputEl = resolveInputElementForCaptcha(captcha.element);
    if (!inputEl) throw new Error(t('content.inputNotFound'));
    captcha.inputElement = inputEl;

    detector.highlight(captcha);
    await waitForReady(captcha);
    const imageData = await detector.captureImage(captcha);
    const response = await browser.runtime.sendMessage({ action: 'recognizeCaptcha', imageData });
    detector.unhighlight(captcha);
    if (response && response.success) {
      let resultText = response.text;
      if (autoCalculate) {
        resultText = Calculator.processResult(response.text, { autoCalculate: true, outputMode: 'result', rules: calculateRules }, location.hostname);
      }
      await fillInputAndMaybeSubmit(inputEl, resultText);
      detector.markElementProcessed(captcha.element);
      sendResponse({ success: true, text: resultText, elapsed: response.elapsed, captchaId: captcha.id });
      browser.runtime.sendMessage({ action: 'recordStats', hostname: location.hostname, elapsed: response.elapsed || 0 }).catch(() => { });
    } else {
      sendResponse({ success: false, error: (response && response.error) || t('content.recognitionFailed') });
    }
  } catch (error) {
    if (currentCaptcha) detector.unhighlight(currentCaptcha);
    sendResponse({ success: false, error: (error as Error).message });
  } finally {
    stopProcessing(processId);
  }
}

async function handleFill(text: string, options: any, sendResponse: (response: any) => void): Promise<void> {
  try {
    const inputEl = customInputElement || queryInputElementBySelector(inputSelector) || currentCaptcha?.inputElement;
    if (!inputEl) throw new Error(t('content.inputNotFound'));
    const success = await autoFill.fill(inputEl, text, { ...options, typewriterEffect, preserveFocus });
    if (options?.autoSubmit) {
      await submitWithSelectorOrDefault(inputEl);
    }
    sendResponse({ success });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function handleGetStatus(sendResponse: (response: any) => void): Promise<void> {
  const captchas = captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.getDetectedCaptchas();
  const resolvedInput = customInputElement || queryInputElementBySelector(inputSelector) || currentCaptcha?.inputElement;

  let hasFrameRule = false;
  if (IS_TOP_FRAME && deepScan) {
    try {
      const rulesResponse = await browser.runtime.sendMessage({ action: 'getSiteRules' });
      const rules: Record<string, any> = (rulesResponse && rulesResponse.success) ? (rulesResponse.rules || {}) : {};
      const currentHostname = location.hostname;
      const currentUrl = getFullUrl();
      hasFrameRule = Object.values(rules).some((r: any) => {
        if (!r || !r.enabled || !r.frameSelector) return false;
        if (r.fullUrl) return r.fullUrl === currentUrl;
        if (r.urlPattern) return currentUrl.startsWith(r.urlPattern);
        return r.hostname === currentHostname;
      });
    } catch (e) {
      Logger.warn('[deepScan] 查询接力规则失败 (Firefox)', e);
    }
  }

  sendResponse({
    success: true,
    isProcessing: processingElements.size > 0,
    captchaCount: captchas.length,
    hasCaptcha: captchas.length > 0 || !!customCaptchaElement || hasFrameRule,
    currentCaptcha: currentCaptcha ? { id: currentCaptcha.id, type: currentCaptcha.type, confidence: currentCaptcha.confidence } : null,
    autoDetectEnabled,
    hasCustomInput: !!customInputElement || hasFrameRule,
    hasCustomCaptcha: !!customCaptchaElement || hasFrameRule,
    hasFrameRule,
    isReady: hasFrameRule || (!!(customCaptchaElement || captchas.length > 0) && !!resolvedInput),
  });
}

function handleStartPicker(sendResponse: (response: any) => void): void {
  initElementPicker('captcha', async (result) => {
    if (result.cancelled) { sendResponse({ success: false, cancelled: true }); return; }
    if (!result.success) { sendResponse({ success: false }); return; }

    // picker 内可切换类型：result.mode 为 captcha（文本 OCR）/ slider / click-select。
    const subType: 'slider' | 'click-select' | undefined =
      result.mode === 'slider' ? 'slider' : result.mode === 'click-select' ? 'click-select' : undefined;

    // 跨框架接力：直接保存规则（含 frameSelector + subType），无法在顶层文档对元素做后续操作
    if (result.frameSelector) {
      Logger.info('[deepScan] 接力规则保存 (Firefox)', {
        frameSelector: result.frameSelector,
        innerSelector: result.selector,
        subType,
      });
      try {
        await browser.runtime.sendMessage({
          action: 'saveSiteRule',
          hostname: location.hostname,
          rule: {
            selector: result.selector,
            subType,
            frameSelector: result.frameSelector,
            frameUrl: result.frameUrl,
            fullUrl: getFullUrl(),
            urlPattern: getUrlPattern(),
            enabled: true,
          },
        });
      } catch (e) {
        Logger.error('[deepScan] 保存接力规则失败 (Firefox)', e);
      }
      sendResponse({
        success: true,
        subType,
        selector: result.selector,
        frameSelector: result.frameSelector,
        frameUrl: result.frameUrl,
        info: result.info,
        hostname: location.hostname,
        fullUrl: getFullUrl(),
        urlPattern: getUrlPattern(),
      });
      return;
    }

    // 交互式（滑块 / 点选）：result.element 已是容器，存带 subType 的规则并就地求解。
    if (subType) {
      const interactive = detector.buildInteractiveCaptcha(result.element, subType, 'manual');
      if (!interactive) { sendResponse({ success: false, error: t('picker.selectCaptcha') }); return; }
      customCaptchaElement = result.element;
      customCaptchaSubType = subType;
      currentCaptcha = interactive;
      Logger.info(`手动选择${subType === 'slider' ? '滑块' : '点选'}容器 (Firefox):`, result.selector);
      try {
        await browser.runtime.sendMessage({
          action: 'saveSiteRule',
          hostname: location.hostname,
          rule: {
            selector: result.selector,
            subType,
            fullUrl: getFullUrl(),
            urlPattern: getUrlPattern(),
            enabled: true,
          },
        });
      } catch (e) {
        Logger.error('保存交互式规则失败 (Firefox)', e);
      }
      sendResponse({
        success: true,
        subType,
        selector: result.selector,
        info: result.info,
        hostname: location.hostname,
        fullUrl: getFullUrl(),
        urlPattern: getUrlPattern(),
      });
      return;
    }

    // 文本 / 图片 OCR：维持原逻辑。
    customCaptchaElement = normalizeCaptchaElement(result.element);
    customCaptchaSubType = null;
    if (!customCaptchaElement) { sendResponse({ success: false, error: t('picker.selectCaptcha') }); return; }
    currentCaptcha = buildCaptchaFromElement(customCaptchaElement, 'manual-selected', resolveInputElementForCaptcha(customCaptchaElement));
    if (!customInputElement && !queryInputElementBySelector(inputSelector)) { startGuessMode('input', customCaptchaElement); } else { await saveAndRecognize(result.selector); }
    sendResponse({ success: true, selector: result.selector, info: result.info, hostname: location.hostname, fullUrl: getFullUrl(), urlPattern: getUrlPattern() });
  });
}

function handleStartInputPicker(sendResponse: (response: any) => void): void {
  initElementPicker('input', async (result) => {
    if (result.cancelled) { sendResponse({ success: false, cancelled: true }); return; }
    if (result.success && result.frameSelector) {
      Logger.info('[deepScan] 接力输入框规则保存 (Firefox)', {
        frameSelector: result.frameSelector,
        innerSelector: result.selector,
      });
      // 输入框相关规则与已有 captcha 规则可能拆开存储 —— 这里仅回传，由调用方决定如何合并
      sendResponse({
        success: true,
        selector: result.selector,
        frameSelector: result.frameSelector,
        frameUrl: result.frameUrl,
        info: result.info,
        hostname: location.hostname,
        fullUrl: getFullUrl(),
        urlPattern: getUrlPattern(),
      });
      return;
    }
    if (result.success && result.element instanceof HTMLInputElement) {
      customInputElement = result.element;
      if (currentCaptcha) currentCaptcha.inputElement = customInputElement;
      if (!customCaptchaElement) { startGuessMode('captcha', result.element); } else { await saveAndRecognize(undefined, result.selector); }
      sendResponse({ success: true, selector: result.selector, info: result.info, hostname: location.hostname, fullUrl: getFullUrl(), urlPattern: getUrlPattern() });
    } else {
      sendResponse({ success: false, error: t('picker.selectInput') });
    }
  });
}

function startGuessMode(mode: 'captcha' | 'input', referenceElement: Element): void {
  clearGuessMode();
  guessMode = mode;
  guessedElements = mode === 'captcha'
    ? detector.guessRelatedCaptcha(referenceElement as HTMLInputElement)
    : detector.guessRelatedInput(referenceElement);
  if (guessedElements.length === 0) return;
  for (const guessed of guessedElements) { detector.highlightGuessed(guessed.element); }
  showGuessTooltip(mode);
  guessClickHandler = (e: MouseEvent) => {
    const target = e.target as Element;
    for (const guessed of guessedElements) {
      if (guessed.element === target || guessed.element.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        if (mode === 'captcha') {
          customCaptchaElement = guessed.element;
          currentCaptcha = buildCaptchaFromElement(guessed.element, 'guessed-selected', resolveInputElementForCaptcha(guessed.element));
          saveAndRecognize(guessed.selector);
        } else {
          customInputElement = guessed.element as HTMLInputElement;
          if (currentCaptcha) currentCaptcha.inputElement = customInputElement;
          saveAndRecognize(undefined, guessed.selector);
        }
        clearGuessMode();
        break;
      }
    }
  };
  document.addEventListener('click', guessClickHandler, true);
  setTimeout(() => { if (guessMode) clearGuessMode(); }, 30000);
}

function clearGuessMode(): void {
  if (guessClickHandler) { document.removeEventListener('click', guessClickHandler, true); guessClickHandler = null; }
  detector.unhighlightAllGuessed();
  hideGuessTooltip();
  guessedElements = [];
  guessMode = null;
}

function showGuessTooltip(mode: 'captcha' | 'input'): void {
  hideGuessTooltip();
  const tooltip = document.createElement('div');
  tooltip.id = 'Mieru-guess-tooltip';
  tooltip.className = 'Mieru-guessed-tooltip';
  tooltip.textContent = mode === 'captcha' ? t('picker.guessCaptcha') : t('picker.guessInput');
  tooltip.style.cssText = 'top: 10px; left: 50%; transform: translateX(-50%);';
  document.body.appendChild(tooltip);
}

function hideGuessTooltip(): void {
  const tooltip = document.getElementById('Mieru-guess-tooltip');
  if (tooltip) tooltip.remove();
}

async function saveAndRecognize(captchaSelectorArg?: string, inputSelectorArg?: string): Promise<void> {
  if (!customCaptchaElement && !currentCaptcha) return;
  const selector = captchaSelectorArg || detector.generateSelector(customCaptchaElement || currentCaptcha!.element);
  const inputSel = inputSelectorArg || (customInputElement ? detector.generateSelector(customInputElement) : undefined);
  try {
    await browser.runtime.sendMessage({
      action: 'saveSiteRule',
      hostname: location.hostname,
      rule: { selector, inputSelector: inputSel, fullUrl: getFullUrl(), urlPattern: getUrlPattern(), enabled: true },
    });
    if (customCaptchaElement && (customInputElement || queryInputElementBySelector(inputSelector))) {
      setTimeout(() => tryAutoSolveOnce(), 300);
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
      captcha = captchaId ? captchas.find(c => c.id === captchaId) || null : detector.getMostLikelyCaptcha();
    }
    if (!captcha) throw new Error(t('content.captchaNotFound'));
    const imageData = await detector.captureImage(captcha);
    showCaptchaPreview(imageData, captcha);
    sendResponse({ success: true, imageData });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

function handleTriggerAuto(sendResponse: (response: any) => void): void {
  try {
    startAutoDetector();
    setTimeout(() => tryAutoSolveOnce(), 200);
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function showCaptchaPreview(imageData: string, captcha: DetectedCaptcha): Promise<void> {
  const existing = document.getElementById('Mieru-preview');
  if (existing) existing.remove();
  let effectiveTheme = 'light';
  try {
    const settingsResponse = await browser.runtime.sendMessage({ action: 'getSettings' });
    const theme = (settingsResponse && settingsResponse.settings) ? settingsResponse.settings.theme || 'auto' : 'auto';
    effectiveTheme = theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  } catch { }
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
  overlay.id = 'Mieru-preview';
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
    return !!browser.runtime?.id;
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
 * Skip mutations originating there to avoid feedback loops with virtual scroll.
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

const MIN_SCAN_INTERVAL_MS = 1500;
let lastScanTriggerTime = 0;

function startAutoDetector(): void {
  if (autoDetectorStarted) return;
  autoDetectorStarted = true;
  scheduleInitialAuto();
  observer = new MutationObserver((mutations) => {
    if (!guardContext()) return;
    let shouldCheckAgreements = false;
    let triggerScan = false;
    for (const mutation of mutations) {
      if (isInsideScrollableContainer(mutation.target)) continue;

      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            if (node.matches('img, canvas, svg')) triggerScan = true;
            else if (node.querySelector('img, canvas, svg')) triggerScan = true;
            else if (node.style && node.style.backgroundImage) triggerScan = true;
            if (node.matches('input[type="checkbox"]') || node.querySelector('input[type="checkbox"]')) shouldCheckAgreements = true;
            if (node.classList.contains('el-checkbox') || node.querySelector('.el-checkbox')) shouldCheckAgreements = true;
            if (node.classList.contains('ant-checkbox') || node.querySelector('.ant-checkbox')) shouldCheckAgreements = true;
          }
        });
        if (mutation.target instanceof SVGElement) triggerScan = true;
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (target instanceof HTMLElement) {
          if (target instanceof HTMLImageElement && (mutation.attributeName === 'src' || mutation.attributeName === 'data-src' || mutation.attributeName === 'srcset')) triggerScan = true;
          else if (target instanceof HTMLCanvasElement) triggerScan = true;
          else if (target instanceof SVGElement) triggerScan = true;
          else if (mutation.attributeName === 'style' && target.style.backgroundImage) triggerScan = true;
        }
      }
    }
    if (triggerScan) scheduleAutoSolve();
    if (shouldCheckAgreements) scheduleAgreementCheck();
  });
  observer.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'data-src', 'srcset', 'style', 'href'],
  });
  intervalTimer = window.setInterval(() => {
    if (!guardContext()) return;
    void maybeAssistCloudflare();
    const captchas = captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.scan();
    if (!captchas || captchas.length === 0) return;
    let changed = false;
    for (const c of captchas) { if (detector.hasElementChanged(c.element)) { changed = true; break; } }
    if (changed) scheduleAutoSolve();
    checkAgreementBoxes();
  }, CONSTANTS.AUTO_DETECT_INTERVAL);
}

/**
 * Cloudflare Turnstile 辅助（受 enableInteractiveCaptchaAssist 控制，默认关闭）。
 * 详见 content.ts 同名函数：只在顶层/普通 frame 做滚动+高亮，不在 CF iframe 内自动点击。
 */
let cfAssisted = false;
async function maybeAssistCloudflare(): Promise<void> {
  if (!enableInteractiveCaptchaAssist) return;
  if (cfAssisted) return;
  if (isCloudflareFrame()) return;
  if (detectTurnstile().length === 0) return;
  cfAssisted = true;
  try {
    const res = await assistCloudflare({ onLog: (m) => Logger.info('[cloudflare]', m) });
    Logger.info('CF 辅助结果:', res);
    if (res.mode === 'assist-manual') {
      window.setTimeout(() => { cfAssisted = false; }, 8000);
    }
  } catch (e) {
    Logger.warn('CF 辅助异常:', e);
    cfAssisted = false;
  }
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

  const fixedInput = queryInputElementBySelector(inputSelector);

  // 交互式自定义验证码（来自带 subType 的规则）：重建带 subType 的 captcha，
  // 不要求关联输入框，交给 internalRecognizeAndFill 的 subType 分支（受辅助开关 gate）。
  if (customCaptchaElement && customCaptchaSubType) {
    if (detector.hasElementChanged(customCaptchaElement) && !isInteractiveCoolingDown(customCaptchaElement)) {
      const captcha = detector.buildInteractiveCaptcha(customCaptchaElement, customCaptchaSubType, 'custom');
      if (captcha) internalRecognizeAndFill(captcha);
    }
    return;
  }

  if (customCaptchaElement && (customInputElement || fixedInput)) {
    const inputEl = customInputElement || fixedInput!;
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
    // 交互式验证码（滑块/点选）不需要关联输入框；按各自开关 gate，默认关闭则跳过。
    if (captcha.subType === 'slider' || captcha.subType === 'click-select') {
      const assistOn = captcha.subType === 'slider'
        ? (enableSliderPuzzleAssist || enableSingleSliderAssist)
        : enableClickSelectAssist;
      if (!assistOn) continue;
      if (isInteractiveCoolingDown(captcha.element)) continue;
      if (!detector.hasElementChanged(captcha.element)) continue;
      if (isElementProcessing(captcha.id)) continue;
      captchasToProcess.push(captcha);
      continue;
    }
    const inputEl = customInputElement || fixedInput || captcha.inputElement || detector.findRelatedInput(captcha.element);
    if (!inputEl) continue;
    if (!detector.hasElementChanged(captcha.element)) continue;
    if (isElementProcessing(captcha.id)) continue;
    captchasToProcess.push({ ...captcha, inputElement: inputEl });
  }
  for (const captcha of captchasToProcess) {
    internalRecognizeAndFill(captcha);
  }
}

/**
 * 把主图像素编码成 PNG dataURL。content 与背景页之间用 browser.runtime 消息通信
 * （JSON 序列化，不能直接传 TypedArray），故点选求解需要的像素以 dataURL 过桥。
 */
function imageLikeToDataURL(image: ImageLike): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2d 上下文');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return canvas.toDataURL();
}

/** 点选求解的 labelBoxes 回调：把主图送到背景页做检测 + OCR 标字，拿回标注框。 */
async function labelBoxesViaBackground(image: ImageLike): Promise<LabeledBox[]> {
  const imageData = imageLikeToDataURL(image);
  const resp = await browser.runtime.sendMessage({ action: 'detectText', imageData });
  if (!resp?.success) throw new Error(resp?.error || '文字检测失败');
  return (resp.boxes || []) as LabeledBox[];
}

async function internalRecognizeAndFill(captcha: DetectedCaptcha): Promise<void> {
  if (!guardContext()) return;
  if (!startProcessing(captcha.id)) return;
  currentCaptcha = captcha;
  const startTime = Date.now();
  try {
    // 交互式验证码（滑块）：走辅助拖拽而非 OCR 填充。仅在用户开启对应开关后启用。
    if (captcha.subType === 'slider') {
      if (!enableSliderPuzzleAssist && !enableSingleSliderAssist) {
        Logger.debug('检测到滑块，但滑块辅助开关未开启，跳过');
        return;
      }
      try {
        detector.highlight(captcha);
        await waitForReady(captcha);
        const res = await solveSlider(captcha, { onLog: (m) => Logger.info('[slider]', m) });
        if (res.success) {
          Logger.info('滑块辅助拖拽完成:', res);
          detector.markElementProcessed(captcha.element);
        } else {
          Logger.warn('滑块辅助未执行:', res.reason, res);
        }
        setInteractiveCooldown(captcha.element, res.success);
      } finally {
        try { detector.unhighlight(captcha); } catch { }
      }
      return;
    }
    // 文字点选：端到端求解（检测模型 + OCR + 轨迹点击）。MV2 下检测在背景页跑，
    // 本端把主图像素编码成 dataURL 送过去、拿回标注框后做坐标换算与点击。
    if (captcha.subType === 'click-select') {
      if (!enableClickSelectAssist) {
        Logger.debug('检测到文字点选，但点选辅助开关未开启，跳过');
        return;
      }
      try {
        detector.highlight(captcha);
        await waitForReady(captcha);
        const res = await solveClickSelect(captcha, {
          labelBoxes: labelBoxesViaBackground,
          onLog: (m) => Logger.info('[click-select]', m),
        });
        if (res.success) {
          Logger.info('文字点选辅助点击完成:', res);
          detector.markElementProcessed(captcha.element);
        } else {
          Logger.warn('文字点选辅助未执行:', res.reason, res);
        }
        setInteractiveCooldown(captcha.element, res.success);
      } finally {
        try { detector.unhighlight(captcha); } catch { }
      }
      return;
    }
    detector.highlight(captcha);
    await waitForReady(captcha);
    const imageData = await detector.captureImage(captcha);
    const response = await browser.runtime.sendMessage({ action: 'recognizeCaptcha', imageData });
    detector.unhighlight(captcha);
    if (!response || !response.success) return;
    let resultText = response.text;
    if (autoCalculate) {
      resultText = Calculator.processResult(
        response.text, { autoCalculate: true, outputMode: 'result', rules: calculateRules },
        location.hostname
      );
    }
    const inputEl = captcha.inputElement || queryInputElementBySelector(inputSelector);
    if (inputEl) {
      await fillInputAndMaybeSubmit(inputEl, resultText);
    }
    detector.markElementProcessed(captcha.element);
    const elapsed = typeof response.elapsed === 'number' ? response.elapsed : (Date.now() - startTime);
    browser.runtime.sendMessage({
      action: 'recordStats',
      hostname: location.hostname,
      elapsed,
    }).catch(() => { });
  } catch (e) {
    Logger.error('识别填充失败:', e);
    try { detector.unhighlight(captcha); } catch { }
  } finally {
    stopProcessing(captcha.id);
  }
}

// ============================================================================
// 深度扫描 · 跨框架 picker 桥接（Firefox MV2）
// 协议与 Chrome 版本一致，详见 content.ts 中的注释。
// ============================================================================

const MIERU_MSG_NS = 1;

interface PendingFrameRelay {
  requestId: string;
  iframe: HTMLIFrameElement;
  mode: 'captcha' | 'input' | 'slider' | 'click-select';
  callback: (result: any) => void;
}

let pendingFrameRelay: PendingFrameRelay | null = null;
let parentHostname: string | null = null;

function installFrameBridge(): void {
  window.addEventListener('message', onFrameBridgeMessage);
  Logger.info('[deepScan] frame bridge installed (Firefox)', { topFrame: IS_TOP_FRAME });
}

function requestParentHostInfo(): void {
  try {
    window.parent.postMessage({ _mieru: MIERU_MSG_NS, type: 'request-host-info' }, '*');
    Logger.info('[deepScan] 子框架请求父 hostname (Firefox)');
  } catch (e) {
    Logger.warn('[deepScan] postMessage(request-host-info) 失败 (Firefox)', e);
  }
  setTimeout(() => {
    if (parentHostname) return;
    try {
      if (document.referrer) {
        parentHostname = new URL(document.referrer).hostname;
        Logger.info('[deepScan] parent host-info 握手超时，回退到 referrer (Firefox)', { parentHostname });
      }
    } catch { /* ignore */ }
  }, 1500);
}

function onFrameBridgeMessage(event: MessageEvent): void {
  const data = event.data;
  if (!data || data._mieru !== MIERU_MSG_NS) return;

  if (!IS_TOP_FRAME) {
    try { if (event.source !== window.parent) return; } catch { return; }
    if (data.type === 'enter-picker') {
      const mode: 'captcha' | 'input' | 'slider' | 'click-select' =
        data.mode === 'input' ? 'input'
        : data.mode === 'slider' ? 'slider'
        : data.mode === 'click-select' ? 'click-select'
        : 'captcha';
      const requestId = String(data.requestId || '');
      Logger.info('[deepScan] 子框架进入 picker (Firefox)', { mode, requestId, url: getFullUrl() });
      initElementPicker(mode, (result) => {
        try {
          if (result.cancelled) {
            (event.source as Window).postMessage({ _mieru: MIERU_MSG_NS, type: 'picker-cancelled', requestId }, '*');
            Logger.info('[deepScan] 子框架回包：取消 (Firefox)', { requestId });
          } else if (result.success) {
            (event.source as Window).postMessage({
              _mieru: MIERU_MSG_NS,
              type: 'picker-result',
              requestId,
              selector: result.selector,
              info: result.info,
            }, '*');
            Logger.info('[deepScan] 子框架回包：结果 (Firefox)', { requestId, selector: result.selector });
          }
        } catch (e) {
          Logger.warn('[deepScan] 子框架回包失败 (Firefox)', e);
        }
      });
    } else if (data.type === 'host-info' && typeof data.hostname === 'string') {
      const isNew = parentHostname !== data.hostname;
      parentHostname = data.hostname;
      Logger.info('[deepScan] 子框架收到父 hostname (Firefox)', { parentHostname });
      if (isNew && !customCaptchaElement) {
        Logger.debug('[deepScan] parent hostname 到达，重试规则匹配 (Firefox)');
        checkAndApplySiteRule();
      }
    }
    return;
  }

  // 顶层：响应子框架的 host-info 请求
  if (data.type === 'request-host-info') {
    try {
      (event.source as Window).postMessage({
        _mieru: MIERU_MSG_NS, type: 'host-info', hostname: location.hostname,
      }, '*');
      Logger.debug('[deepScan] 顶层回复 host-info (Firefox)', { hostname: location.hostname });
    } catch (e) {
      Logger.warn('[deepScan] 回复 host-info 失败 (Firefox)', e);
    }
    return;
  }

  // 顶层：接收子框架转发的右键识别结果
  if (data.type === 'ctx-result' && data.payload) {
    Logger.info('[deepScan] 顶层收到子框架右键识别结果 (Firefox)', { kind: data.payload.kind || 'ok' });
    deliverContextResult(data.payload);
    return;
  }

  if (!pendingFrameRelay) return;
  if (event.source !== pendingFrameRelay.iframe.contentWindow) return;
  if (data.requestId !== pendingFrameRelay.requestId) return;

  if (data.type === 'picker-result') {
    Logger.info('[deepScan] 顶层收到子框架 picker 结果 (Firefox)', {
      mode: pendingFrameRelay.mode,
      innerSelector: data.selector,
    });
    const frameSelector = detector.generateSelector(pendingFrameRelay.iframe);
    const frameUrl = (() => { try { return pendingFrameRelay.iframe.src || ''; } catch { return ''; } })();
    const relay = pendingFrameRelay;
    pendingFrameRelay = null;
    relay.callback({
      success: true,
      selector: data.selector,
      frameSelector,
      frameUrl,
      info: data.info,
    });
  } else if (data.type === 'picker-cancelled') {
    Logger.info('[deepScan] 子框架取消 picker (Firefox)', { mode: pendingFrameRelay.mode });
    const relay = pendingFrameRelay;
    pendingFrameRelay = null;
    relay.callback({ cancelled: true });
  }
}

function startFrameRelay(
  iframe: HTMLIFrameElement,
  mode: 'captcha' | 'input' | 'slider' | 'click-select',
  pickerCleanup: () => void,
  callback: (result: any) => void,
): boolean {
  if (!iframe.contentWindow) {
    Logger.warn('[deepScan] iframe 没有 contentWindow (Firefox)');
    return false;
  }
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cancelTimer = setTimeout(() => {
    if (pendingFrameRelay?.requestId === requestId) {
      Logger.warn('[deepScan] 子框架接力超时 (Firefox)');
      pendingFrameRelay = null;
      callback({ cancelled: true, error: 'frame-relay-timeout' });
    }
  }, 10000);

  pendingFrameRelay = {
    requestId,
    iframe,
    mode,
    callback: (result) => { clearTimeout(cancelTimer); callback(result); },
  };

  try {
    iframe.contentWindow.postMessage({
      _mieru: MIERU_MSG_NS, type: 'enter-picker', mode, requestId,
    }, '*');
    Logger.info('[deepScan] 顶层发起子框架接力 (Firefox)', { requestId, mode, frameUrl: iframe.src });
    pickerCleanup();
    return true;
  } catch (e) {
    Logger.warn('[deepScan] postMessage 失败 (Firefox)', e);
    clearTimeout(cancelTimer);
    pendingFrameRelay = null;
    return false;
  }
}

function pickInteractiveContainer(element: Element, mode: 'slider' | 'click-select'): Element {
  const SURFACE = new Set(['IMG', 'CANVAS', 'SVG']);
  const kw = mode === 'slider' ? CONSTANTS.SLIDER_KEYWORDS : CONSTANTS.CLICK_SELECT_KEYWORDS;
  try {
    const sel = kw.map((k) => `[class*="${k}" i],[id*="${k}" i],[data-captcha-type*="${k}" i]`).join(',');
    let hit: Element | null = element.closest(sel);
    while (hit && SURFACE.has(hit.tagName)) {
      hit = hit.parentElement ? hit.parentElement.closest(sel) : null;
    }
    if (hit && hit.querySelector('canvas, img')) return hit;
  } catch { /* ignore */ }
  let cur: Element | null = SURFACE.has(element.tagName) ? element.parentElement : element;
  while (cur && cur !== document.body) {
    if (!SURFACE.has(cur.tagName) && cur.querySelector('canvas, img')) return cur;
    cur = cur.parentElement;
  }
  return SURFACE.has(element.tagName) && element.parentElement ? element.parentElement : element;
}

function initElementPicker(mode: 'captcha' | 'input' | 'slider' | 'click-select', callback: (result: any) => void): void {
  let isActive = true;
  let hoveredElement: Element | null = null;
  let hoveredIframe: HTMLIFrameElement | null = null;
  let curMode: 'captcha' | 'input' | 'slider' | 'click-select' = mode;
  const showTypeToggle = mode !== 'input';
  const isInteractiveMode = () => curMode === 'slider' || curMode === 'click-select';
  const overlay = document.createElement('div');
  overlay.id = 'Mieru-picker-overlay';
  overlay.style.cssText = 'position:fixed;pointer-events:none;border:3px solid #6366f1;background:rgba(99,102,241,0.15);z-index:999998;display:none;border-radius:4px;';
  document.body.appendChild(overlay);
  const tooltipTextFor = (m: typeof curMode): string => m === 'captcha' ? t('picker.selectCaptcha')
    : m === 'slider' ? t('picker.selectSlider')
    : m === 'click-select' ? t('picker.selectClickSelect')
    : t('picker.selectInput');
  const tooltip = document.createElement('div');
  tooltip.id = 'Mieru-picker-tooltip';
  tooltip.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#1a1a2e,#16213e);color:white;padding:12px 24px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.5);display:flex;align-items:center;gap:12px;border:1px solid #6366f1;flex-wrap:wrap;max-width:90vw;';
  const toggleHtml = showTypeToggle
    ? `<span id="picker-type-toggle" style="display:inline-flex;border:1px solid #6366f1;border-radius:8px;overflow:hidden;">
         <button data-type="captcha" class="picker-type-btn" style="background:#6366f1;color:#fff;border:none;padding:5px 10px;cursor:pointer;font-size:12px;">${t('picker.typeText')}</button>
         <button data-type="slider" class="picker-type-btn" style="background:transparent;color:#a1a1aa;border:none;padding:5px 10px;cursor:pointer;font-size:12px;">${t('picker.typeSlider')}</button>
         <button data-type="click-select" class="picker-type-btn" style="background:transparent;color:#a1a1aa;border:none;padding:5px 10px;cursor:pointer;font-size:12px;">${t('picker.typeClickSelect')}</button>
       </span>`
    : '';
  tooltip.innerHTML = `<span id="picker-title">${tooltipTextFor(curMode)}</span>${toggleHtml}<span id="picker-info" style="color:#a1a1aa;font-size:12px;"></span><button id="picker-cancel" style="background:#ef4444;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">${t('picker.cancel')}</button>`;
  document.body.appendChild(tooltip);
  function updateTypeToggleUI(): void {
    const title = document.getElementById('picker-title');
    if (title) title.textContent = tooltipTextFor(curMode);
    tooltip.querySelectorAll<HTMLButtonElement>('.picker-type-btn').forEach((b) => {
      const active = b.dataset.type === curMode;
      b.style.background = active ? '#6366f1' : 'transparent';
      b.style.color = active ? '#fff' : '#a1a1aa';
    });
  }
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

    if (IS_TOP_FRAME && deepScan && element.tagName === 'IFRAME') {
      hoveredIframe = element as HTMLIFrameElement;
      hoveredElement = null;
      const rect = element.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.borderColor = '#f59e0b';
      overlay.style.background = 'rgba(245,158,11,0.15)';
      overlay.style.top = rect.top + 'px';
      overlay.style.left = rect.left + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';
      const infoEl = document.getElementById('picker-info');
      if (infoEl) infoEl.textContent = t('picker.iframeHint');
      return;
    }

    hoveredIframe = null;
    overlay.style.borderColor = '#6366f1';
    overlay.style.background = 'rgba(99,102,241,0.15)';

    let target: Element | null = null;
    if (curMode === 'captcha') {
      if (['IMG', 'CANVAS', 'SVG'].includes(element.tagName)) target = element;
      else if (element instanceof HTMLElement && element.style.backgroundImage) target = element;
      else target = element.querySelector('img, canvas, svg') || element.closest('img, canvas, svg');
    } else if (isInteractiveMode()) {
      // 滑块 / 点选：选「容器」而非内部 canvas/img（关键词可能命中 canvas 本身）。
      target = pickInteractiveContainer(element, curMode as 'slider' | 'click-select');
    } else {
      target = element.tagName === 'INPUT' ? element : element.closest('input');
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
    const tgt = e.target as Element;
    if (tgt && (tgt.closest('#picker-type-toggle') || tgt.id === 'picker-cancel')) return;
    e.preventDefault();
    e.stopPropagation();

    if (IS_TOP_FRAME && deepScan && hoveredIframe) {
      const ok = startFrameRelay(hoveredIframe, curMode, cleanup, callback);
      if (!ok) {
        const infoEl = document.getElementById('picker-info');
        if (infoEl) infoEl.textContent = t('picker.iframeRelayFailed');
        hoveredIframe = null;
      }
      return;
    }

    if (hoveredElement) {
      const selector = detector.generateSelector(hoveredElement);
      const rect = hoveredElement.getBoundingClientRect();
      cleanup();
      callback({ success: true, mode: curMode, element: hoveredElement, selector, info: { tagName: hoveredElement.tagName.toLowerCase(), id: (hoveredElement as HTMLElement).id || null, width: Math.round(rect.width), height: Math.round(rect.height) } });
    }
  }
  function handleKeyDown(e: KeyboardEvent): void {
    if (!isActive) return;
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); callback({ cancelled: true }); }
  }
  document.getElementById('picker-cancel')!.addEventListener('click', () => { cleanup(); callback({ cancelled: true }); });
  tooltip.querySelectorAll<HTMLButtonElement>('.picker-type-btn').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      curMode = (b.dataset.type as typeof curMode) || 'captcha';
      hoveredElement = null;
      overlay.style.display = 'none';
      updateTypeToggleUI();
    });
  });
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
}

function scanPage(): void {
  const captchas = captchaSelector ? buildCaptchasFromSelector(captchaSelector) : detector.scan();
  if (captchas.length > 0) {
    browser.runtime.sendMessage({
      action: 'captchaDetected',
      count: captchas.length,
      bestConfidence: detector.getMostLikelyCaptcha()?.confidence || 0,
    }).catch(() => { });
  }
}

init();