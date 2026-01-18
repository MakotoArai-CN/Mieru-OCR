import './content.css';
import { CaptchaDetector, type DetectedCaptcha } from '@core/captcha-detector';
import { AutoFill } from '@core/auto-fill';
import { CONSTANTS } from '@core/config';

let debugMode = false;
const detector = new CaptchaDetector();
const autoFill = new AutoFill();
let currentCaptcha: DetectedCaptcha | null = null;
let customInputElement: HTMLInputElement | null = null;
let isProcessing = false;
let autoDetectEnabled = true;
let autoFillEnabled = true;
let autoSubmitEnabled = false;
let autoSolveOnRuleEnabled = true;
let autoDetectorStarted = false;

async function initDebugMode() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (response.success && response.settings) {
      debugMode = response.settings.debugMode || false;
      autoDetectEnabled = response.settings.autoDetect !== false;
      autoFillEnabled = response.settings.autoFill !== false;
      autoSubmitEnabled = !!response.settings.autoSubmit;
      autoSolveOnRuleEnabled = response.settings.autoSolveOnRule !== false;
    }
  } catch (e) { }
}

const logger = {
  debug: (msg: string, ...args: any[]) => { if (debugMode) console.log('[DDDD OCR]', msg, ...args); },
  info: (msg: string, ...args: any[]) => { if (debugMode) console.log('[DDDD OCR]', msg, ...args); },
  warn: (msg: string, ...args: any[]) => { if (debugMode) console.warn('[DDDD OCR]', msg, ...args); },
  error: (msg: string, ...args: any[]) => { console.error('[DDDD OCR]', msg, ...args); },
};

async function init() {
  await initDebugMode();
  logger.info('内容脚本已加载');
  chrome.runtime.onMessage.addListener(handleMessage);

  setTimeout(async () => {
    await checkAndApplySiteRule();
    scanPage();
    startAutoDetector();
  }, 800);
}

function handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
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
    default:
      sendResponse({ success: false, error: '未知操作' });
  }
  return false;
}

async function checkAndApplySiteRule() {
  try {
    const rulesResponse = await chrome.runtime.sendMessage({ action: 'getSiteRules' });
    const settingsResponse = await chrome.runtime.sendMessage({ action: 'getSettings' });
    const settings = settingsResponse.success ? settingsResponse.settings : {};
    const rules = rulesResponse.success ? rulesResponse.rules : {};
    const rule = rules[location.hostname];

    autoDetectEnabled = settings.autoDetect !== false;
    autoFillEnabled = settings.autoFill !== false;
    autoSubmitEnabled = !!settings.autoSubmit;
    autoSolveOnRuleEnabled = settings.autoSolveOnRule !== false;
    debugMode = !!settings.debugMode;

    if (rule && rule.enabled !== false) {
      const element = document.querySelector(rule.selector);
      if (element) {
        const rect = element.getBoundingClientRect();
        currentCaptcha = {
          id: 'rule-selected',
          type: element.tagName.toLowerCase() === 'img'
            ? 'image'
            : element.tagName.toLowerCase() === 'canvas'
              ? 'canvas'
              : 'svg',
          element,
          rect,
          confidence: 100,
          inputElement: rule.inputSelector
            ? document.querySelector(rule.inputSelector)
            : detector.findRelatedInput(element),
          elementInfo: {
            tagName: element.tagName.toLowerCase(),
            id: (element as HTMLElement).id || null,
            className: (element as HTMLElement).className?.toString?.() || '',
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            src: (element as HTMLImageElement).src,
          },
        };
        if (currentCaptcha) {
          detector.highlight(currentCaptcha);
          const captchaToUnhighlight = currentCaptcha;
          setTimeout(() => detector.unhighlight(captchaToUnhighlight), 1200);
        }

        if (autoSolveOnRuleEnabled) {
          setTimeout(() => {
            tryAutoSolveOnce();
          }, 500);
        }
      }
    }
  } catch (error) {
    logger.error('检查网站规则失败', error);
  }
}

function handleScan(sendResponse: (response: any) => void) {
  try {
    const captchas = detector.scan();
    currentCaptcha = detector.getMostLikelyCaptcha();
    sendResponse({
      success: true,
      captchas: captchas.map(c => ({ id: c.id, type: c.type, confidence: c.confidence, hasInput: !!c.inputElement })),
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
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('图片加载超时'));
      }, timeout);
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('图片加载失败'));
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

async function handleRecognize(captchaId: string, sendResponse: (response: any) => void) {
  if (isProcessing) {
    sendResponse({ success: false, error: '正在处理中' });
    return;
  }
  isProcessing = true;
  try {
    const captchas = detector.getDetectedCaptchas();
    const captcha = captchaId ? captchas.find(c => c.id === captchaId) : detector.getMostLikelyCaptcha();
    if (!captcha) throw new Error('未找到验证码');
    currentCaptcha = captcha;
    detector.highlight(captcha);
    await waitForReady(captcha);
    const imageData = await detector.captureImage(captcha);
    const response = await chrome.runtime.sendMessage({ action: 'recognizeCaptcha', imageData });
    detector.unhighlight(captcha);
    if (response.success) {
      const inputEl = customInputElement || currentCaptcha?.inputElement;
      if (autoFillEnabled && inputEl) {
        await autoFill.fill(inputEl, response.text, { simulate: true, autoSubmit: autoSubmitEnabled });
      }
      detector.markElementProcessed(captcha.element);
      sendResponse({ success: true, text: response.text, elapsed: response.elapsed, captchaId: captcha.id });
    } else {
      sendResponse({ success: false, error: response.error });
    }
  } catch (error) {
    if (currentCaptcha) detector.unhighlight(currentCaptcha);
    sendResponse({ success: false, error: (error as Error).message });
  } finally {
    isProcessing = false;
  }
}

async function handleFill(text: string, options: any, sendResponse: (response: any) => void) {
  try {
    const inputEl = customInputElement || currentCaptcha?.inputElement;
    if (!inputEl) throw new Error('未找到验证码输入框');
    const success = await autoFill.fill(inputEl, text, options);
    sendResponse({ success });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

function handleGetStatus(sendResponse: (response: any) => void) {
  const captchas = detector.getDetectedCaptchas();
  sendResponse({
    success: true,
    isProcessing,
    captchaCount: captchas.length,
    hasCaptcha: captchas.length > 0,
    currentCaptcha: currentCaptcha ? { id: currentCaptcha.id, type: currentCaptcha.type, confidence: currentCaptcha.confidence } : null,
    autoDetectEnabled,
    hasCustomInput: !!customInputElement,
  });
}

function handleStartPicker(sendResponse: (response: any) => void) {
  initElementPicker('captcha', (result) => {
    if (result.cancelled) {
      sendResponse({ success: false, cancelled: true });
    } else if (result.success) {
      const pickedRect = result.element.getBoundingClientRect();
      currentCaptcha = {
        id: 'manual-selected',
        type: result.element.tagName.toLowerCase() === 'img'
          ? 'image'
          : result.element.tagName.toLowerCase() === 'canvas'
            ? 'canvas'
            : 'svg',
        element: result.element,
        rect: pickedRect,
        confidence: 100,
        inputElement: customInputElement || detector.findRelatedInput(result.element),
        elementInfo: {
          tagName: result.element.tagName.toLowerCase(),
          id: (result.element as HTMLElement).id || null,
          className: (result.element as HTMLElement).className?.toString?.() || '',
          width: Math.round(pickedRect.width),
          height: Math.round(pickedRect.height),
          src: (result.element as HTMLImageElement).src,
        },
      };
      sendResponse({ success: true, selector: result.selector, info: result.info, hostname: location.hostname });
    }
  });
  return true;
}

function handleStartInputPicker(sendResponse: (response: any) => void) {
  initElementPicker('input', (result) => {
    if (result.cancelled) {
      sendResponse({ success: false, cancelled: true });
    } else if (result.success && result.element instanceof HTMLInputElement) {
      customInputElement = result.element;
      if (currentCaptcha) {
        currentCaptcha.inputElement = customInputElement;
      }
      sendResponse({ success: true, selector: result.selector, info: result.info, hostname: location.hostname });
    } else {
      sendResponse({ success: false, error: '请选择输入框元素' });
    }
  });
  return true;
}

async function handlePreviewCaptcha(captchaId: string, sendResponse: (response: any) => void) {
  try {
    const captchas = detector.getDetectedCaptchas();
    const captcha = captchaId ? captchas.find(c => c.id === captchaId) : detector.getMostLikelyCaptcha();
    if (!captcha) throw new Error('未找到验证码');
    const imageData = await detector.captureImage(captcha);
    showCaptchaPreview(imageData, captcha);
    sendResponse({ success: true, imageData });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

function handleTriggerAuto(sendResponse: (response: any) => void) {
  try {
    startAutoDetector();
    setTimeout(() => {
      tryAutoSolveOnce();
    }, 200);
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function showCaptchaPreview(imageData: string, captcha: DetectedCaptcha) {
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
    <h3 style="margin:0 0 16px 0;color:${colors.primary};">🔍 验证码预览</h3>
    <div style="background:${colors.bgSecondary};padding:16px;border-radius:8px;text-align:center;margin-bottom:16px;border:1px solid ${colors.border};">
      <img src="${imageData}" style="max-width:100%;border:2px solid #4CAF50;border-radius:4px;">
    </div>
    <div style="background:${colors.bgSecondary};padding:12px;border-radius:8px;font-size:13px;margin-bottom:16px;border:1px solid ${colors.border};">
      <div style="color:${colors.textSecondary};"><strong style="color:${colors.text};">类型:</strong> ${captcha.type.toUpperCase()}</div>
    </div>
    <button id="preview-close" style="width:100%;padding:10px;background:${colors.primary};color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px;">关闭</button>
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

function startAutoDetector(): void {
  if (autoDetectorStarted) return;
  autoDetectorStarted = true;
  logger.info('自动识别已启用');

  scheduleInitialAuto();

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            if (node.matches('img, canvas, svg')) scheduleAutoSolve();
            if (node.querySelector('img, canvas, svg')) scheduleAutoSolve();
          }
        });
        if (mutation.target instanceof SVGElement) {
          scheduleAutoSolve();
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (target instanceof HTMLElement) {
          if (target instanceof HTMLImageElement) {
            if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src' || mutation.attributeName === 'srcset') {
              scheduleAutoSolve();
            }
          } else if (target instanceof HTMLCanvasElement) {
            scheduleAutoSolve();
          } else if (target instanceof SVGElement) {
            scheduleAutoSolve();
          } else if (mutation.attributeName === 'style' && target.style.backgroundImage) {
            scheduleAutoSolve();
          }
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'data-src', 'srcset', 'style', 'href'],
  });

  intervalTimer = window.setInterval(() => {
    if (isProcessing) return;
    const captchas = detector.scan();
    if (!captchas || captchas.length === 0) return;
    let changed = false;
    for (const c of captchas) {
      if (c.type === 'canvas' || c.type === 'svg' || c.type === 'image') {
        if (detector.hasElementChanged(c.element)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) scheduleAutoSolve();
  }, CONSTANTS.AUTO_DETECT_INTERVAL);
}

function scheduleInitialAuto(): void {
  if (initialTimer) clearTimeout(initialTimer);
  initialTimer = window.setTimeout(() => {
    scheduleAutoSolve();
    window.setTimeout(() => {
      scheduleAutoSolve();
    }, 2500);
  }, 300);
}

function scheduleAutoSolve(): void {
  if (!autoDetectEnabled) return;
  if (isProcessing) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => {
    tryAutoSolveOnce();
  }, 300);
}

function tryAutoSolveOnce(): void {
  if (!autoDetectEnabled) return;
  if (isProcessing) return;

  const captchas = detector.scan();
  if (!captchas || captchas.length === 0) return;

  let target: DetectedCaptcha | null = null;

  if (currentCaptcha && currentCaptcha.element && document.contains(currentCaptcha.element)) {
    target = currentCaptcha;
    if (!target.inputElement && !customInputElement) {
      target.inputElement = detector.findRelatedInput(target.element);
    }
  }

  if (!target) {
    target = detector.getMostLikelyCaptcha();
  }

  if (!target) return;

  const inputEl = customInputElement || target.inputElement;
  if (!inputEl) {
    logger.debug('自动识别跳过：未找到输入框');
    return;
  }

  if (!detector.hasElementChanged(target.element)) {
    return;
  }

  internalRecognizeAndFill(target);
}

async function internalRecognizeAndFill(captcha: DetectedCaptcha): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  currentCaptcha = captcha;

  try {
    detector.highlight(captcha);
    await waitForReady(captcha);
    const imageData = await detector.captureImage(captcha);
    const response = await chrome.runtime.sendMessage({ action: 'recognizeCaptcha', imageData });
    detector.unhighlight(captcha);

    if (!response?.success) {
      return;
    }

    const inputEl = customInputElement || captcha.inputElement;
    if (autoFillEnabled && inputEl) {
      await autoFill.fill(inputEl, response.text, { simulate: true, autoSubmit: autoSubmitEnabled });
    }

    detector.markElementProcessed(captcha.element);
  } catch (e) {
    try { detector.unhighlight(captcha); } catch { }
  } finally {
    isProcessing = false;
  }
}

function initElementPicker(mode: 'captcha' | 'input', callback: (result: any) => void) {
  let isActive = true;
  let hoveredElement: Element | null = null;

  const overlay = document.createElement('div');
  overlay.id = 'ddddocr-picker-overlay';
  overlay.style.cssText = 'position:fixed;pointer-events:none;border:3px solid #6366f1;background:rgba(99,102,241,0.15);z-index:999998;display:none;border-radius:4px;';
  document.body.appendChild(overlay);

  const tooltipText = mode === 'captcha' ? '🎯 点击选择验证码元素' : '📝 点击选择输入框';
  const tooltip = document.createElement('div');
  tooltip.id = 'ddddocr-picker-tooltip';
  tooltip.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#1a1a2e,#16213e);color:white;padding:12px 24px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.5);display:flex;align-items:center;gap:16px;border:1px solid #6366f1;';
  tooltip.innerHTML = `<span>${tooltipText}</span><span id="picker-info" style="color:#a1a1aa;font-size:12px;"></span><button id="picker-cancel" style="background:#ef4444;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">取消 (ESC)</button>`;
  document.body.appendChild(tooltip);

  function cleanup() {
    isActive = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    overlay.remove();
    tooltip.remove();
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isActive) return;
    const element = document.elementFromPoint(e.clientX, e.clientY);
    if (!element || element.id.includes('ddddocr')) return;

    let target: Element | null = null;
    if (mode === 'captcha') {
      if (['IMG', 'CANVAS', 'SVG'].includes(element.tagName)) {
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

  function handleClick(e: MouseEvent) {
    if (!isActive) return;
    e.preventDefault();
    e.stopPropagation();
    if (hoveredElement) {
      const selector = generateSelector(hoveredElement);
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

  function handleKeyDown(e: KeyboardEvent) {
    if (!isActive) return;
    if (e.key === 'Escape' || (document.getElementById('picker-cancel')?.addEventListener('click', () => { return true; })) ) {
      e.preventDefault();
      cleanup();
      callback({ cancelled: true });
    }
  }

  function generateSelector(element: Element): string {
    if ((element as HTMLElement).id) return '#' + (element as HTMLElement).id;
    const className = (element as HTMLElement).className;
    if (className) {
      const classes = className.toString().trim().split(/\s+/).filter(c => c && !c.includes(':'));
      if (classes.length > 0) {
        const selector = element.tagName.toLowerCase() + '.' + classes.join('.');
        if (document.querySelectorAll(selector).length === 1) return selector;
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
        if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      path.unshift(sel);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  document.getElementById('picker-cancel')!.addEventListener('click', () => {
    cleanup();
    callback({ cancelled: true });
  });

  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
}

function scanPage() {
  const captchas = detector.scan();
  if (captchas.length > 0) {
    chrome.runtime.sendMessage({
      action: 'captchaDetected',
      count: captchas.length,
      bestConfidence: detector.getMostLikelyCaptcha()?.confidence || 0,
    }).catch(() => { });
  }
}

init();