// src/core/diagnostics.ts
var MAX_ENTRIES = 200;
var MAX_MSG_LEN = 300;
var FLUSH_DEBOUNCE_MS = 1000;
var BUFFER_KEY_PREFIX = "ddddocr_diag_log_";
var buffer = [];
var flushTimer = null;
var cachedCtx = null;
var enabled = false;
function detectContext() {
  if (cachedCtx)
    return cachedCtx;
  try {
    if (typeof self !== "undefined" && self.ServiceWorkerGlobalScope && self instanceof self.ServiceWorkerGlobalScope) {
      return cachedCtx = "sw";
    }
  } catch {}
  if (typeof window !== "undefined") {
    const href = typeof location !== "undefined" && location.href || "";
    if (href.includes("options"))
      return cachedCtx = "options";
    if (href.includes("popup"))
      return cachedCtx = "popup";
    if (href.includes("offscreen"))
      return cachedCtx = "offscreen";
    if (typeof globalThis.GM_getValue === "function")
      return cachedCtx = "userscript";
    try {
      if (window.top !== window)
        return cachedCtx = "subframe";
    } catch {
      return cachedCtx = "subframe";
    }
    return cachedCtx = "content";
  }
  return cachedCtx = "unknown";
}
var cachedStorage;
function getStorage() {
  if (cachedStorage !== undefined)
    return cachedStorage;
  try {
    const c = globalThis.browser;
    if (c?.storage?.local) {
      cachedStorage = {
        get: (k) => c.storage.local.get(k).then((r) => r[k]),
        set: (k, v) => c.storage.local.set({ [k]: v })
      };
      return cachedStorage;
    }
  } catch {}
  try {
    const b = globalThis.chrome;
    if (b?.storage?.local) {
      cachedStorage = {
        get: (k) => b.storage.local.get(k).then((r) => r[k]),
        set: (k, v) => b.storage.local.set({ [k]: v })
      };
      return cachedStorage;
    }
  } catch {}
  const gmGet = globalThis.GM_getValue;
  const gmSet = globalThis.GM_setValue;
  if (typeof gmGet === "function" && typeof gmSet === "function") {
    cachedStorage = {
      get: async (k) => gmGet(k),
      set: async (k, v) => gmSet(k, v)
    };
    return cachedStorage;
  }
  cachedStorage = null;
  return null;
}
function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
function safeStringify(v) {
  if (v == null)
    return String(v);
  if (typeof v === "string")
    return v;
  if (typeof v === "number" || typeof v === "boolean")
    return String(v);
  if (v instanceof Error)
    return `${v.name}: ${v.message}
${v.stack || ""}`;
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error)
        return { name: val.name, message: val.message, stack: val.stack };
      return val;
    });
  } catch {
    return "[unserializable]";
  }
}
function setDiagnosticsEnabled(v) {
  enabled = v;
}
function pushEntry(level, args) {
  if (!enabled)
    return;
  try {
    const msg = truncate(args.map(safeStringify).join(" "), MAX_MSG_LEN);
    buffer.push({ ts: Date.now(), level, ctx: detectContext(), msg });
    while (buffer.length > MAX_ENTRIES)
      buffer.shift();
    scheduleFlush();
  } catch {}
}
function scheduleFlush() {
  if (flushTimer)
    return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
}
async function flush() {
  const storage = getStorage();
  if (!storage)
    return;
  try {
    await storage.set(BUFFER_KEY_PREFIX + detectContext(), buffer.slice());
  } catch {}
}

// src/core/config.ts
var CONSTANTS = {
  MODEL_VERSION: "1.5.1",
  MODEL_REPO: "MakotoArai-CN/Mieru-OCR",
  MODEL_BRANCH: "main",
  MODEL_PATH: "public/common.onnx",
  CHARSETS_PATH: "public/charsets.json",
  DET_MODEL_PATH: "public/common_det.onnx",
  WASM_VERSION: "1.17.0",
  CACHE_DURATION: 30 * 24 * 60 * 60 * 1000,
  CAPTCHA_KEYWORDS: [
    "captcha",
    "verify",
    "code",
    "vcode",
    "authcode",
    "验证码",
    "checkcode",
    "yzm",
    "capimg",
    "signCaptcha",
    "imgcode",
    "seccode",
    "validcode",
    "yanzhengma",
    "validatecode",
    "piccode",
    "imgverify",
    "codeimg",
    "randcode",
    "identify",
    "kaptcha",
    "verifycode",
    "imgCaptcha",
    "captchaImg",
    "vcodeImg"
  ],
  INPUT_KEYWORDS: [
    "captcha",
    "verify",
    "code",
    "vcode",
    "authcode",
    "验证码",
    "checkcode",
    "yzm",
    "validatecode",
    "validcode",
    "seccode",
    "imgcode",
    "randcode",
    "identify",
    "kaptcha",
    "answer",
    "verifycode",
    "captchaInput",
    "vcodeInput"
  ],
  AGREEMENT_KEYWORDS: [
    "agree",
    "agreement",
    "accept",
    "terms",
    "policy",
    "privacy",
    "同意",
    "协议",
    "条款",
    "隐私",
    "用户协议",
    "隐私政策",
    "tos",
    "consent"
  ],
  INPUT_EXCLUDE_KEYWORDS: [
    "手机",
    "短信",
    "sms",
    "phone",
    "mobile",
    "手机验证码",
    "短信验证码",
    "手机号",
    "滑动验证码",
    "email",
    "mail",
    "邮箱",
    "邮箱验证码",
    "邮件验证码",
    "username",
    "user",
    "account",
    "账号",
    "用户名",
    "otp",
    "one time",
    "verification code",
    "动态码",
    "校验码",
    "短信校验",
    "手机校验码"
  ],
  EXCLUDED_INPUT_TYPES: [
    "password",
    "email",
    "tel",
    "phone",
    "mobile",
    "hidden",
    "submit",
    "button",
    "reset",
    "file",
    "image",
    "checkbox",
    "radio",
    "search",
    "url",
    "color",
    "range",
    "date",
    "time",
    "datetime-local",
    "month",
    "week"
  ],
  SLIDER_KEYWORDS: [
    "slider",
    "slide-captcha",
    "slide-verify",
    "puzzle",
    "jigsaw",
    "drag-verify",
    "滑块",
    "滑动",
    "拖动",
    "拖拽",
    "拼图",
    "geetest",
    "nc-container",
    "nc_wrapper",
    "verify-slide",
    "btn_slide"
  ],
  CLICK_SELECT_KEYWORDS: [
    "click-captcha",
    "click-verify",
    "point-captcha",
    "pickword",
    "pick-word",
    "点选",
    "文字点选",
    "图形点选",
    "text-click"
  ],
  EXCLUDED_INPUT_NAMES: [
    "username",
    "user",
    "account",
    "email",
    "mail",
    "phone",
    "mobile",
    "tel",
    "password",
    "pwd",
    "pass",
    "name",
    "realname",
    "nickname",
    "search",
    "query",
    "q",
    "keyword",
    "address",
    "city"
  ],
  EXCLUDE_PATTERNS: [
    "avatar",
    "logo",
    "icon",
    "banner",
    "ad",
    "sponsor",
    "background",
    "bg",
    "profile",
    "user",
    "photo",
    "emoji",
    "emoticon",
    "sticker",
    "gif",
    "loading",
    "spinner",
    "placeholder",
    "slider",
    "slide",
    "drag",
    "puzzle",
    "jigsaw"
  ],
  MIN_CAPTCHA_WIDTH: 50,
  MIN_CAPTCHA_HEIGHT: 20,
  MAX_CAPTCHA_WIDTH: 400,
  MAX_CAPTCHA_HEIGHT: 150,
  AUTO_DETECT_INTERVAL: 2000,
  GITHUB_MIRRORS: [
    "https://raw.githubusercontent.com",
    "https://ghproxy.com/https://raw.githubusercontent.com",
    "https://ghfast.top/https://raw.githubusercontent.com",
    "https://mirror.ghproxy.com/https://raw.githubusercontent.com",
    "https://raw.kkgithub.com",
    "https://gh-proxy.org",
    "https://hk.gh-proxy.org",
    "https://cdn.gh-proxy.org",
    "https://edgeone.gh-proxy.org",
    "https://github.moeyy.xyz/https://raw.githubusercontent.com",
    "https://ghps.cc/https://raw.githubusercontent.com",
    "https://cors.isteed.cc/github.com/MakotoArai-CN/Mieru-OCR/raw/main",
    "https://raw.githubusercontents.com"
  ],
  CDN_SOURCES: [
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://cdnjs.cloudflare.com",
    "https://fastly.jsdelivr.net",
    "https://registry.npmmirror.com"
  ]
};
var DEFAULT_CONFIG = {
  debugMode: false,
  autoDetect: true,
  captchaSelector: "",
  inputSelector: "",
  submitSelector: "",
  agreementSelector: "",
  agreementSelectors: [],
  autoCheckAgreement: true,
  useLocalModel: false,
  localModelPath: "",
  localCharsetsPath: "",
  autoDownload: true,
  enableWhitelist: true,
  whitelist: [],
  useUploadedModel: false,
  useUploadedWasm: false,
  theme: "auto",
  language: "auto",
  typewriterEffect: true,
  autoCalculate: false,
  calculateOutputMode: "result",
  calculateRules: [],
  customIncludeKeywords: [],
  customExcludePatterns: [],
  customAgreementKeywords: [],
  customInputExcludeKeywords: [],
  disabledCaptchaKeywords: [],
  disabledExcludePatterns: [],
  disabledAgreementKeywords: [],
  disabledInputExcludeKeywords: [],
  enableInteractiveCaptchaAssist: false,
  enableInteractiveCaptchaDebugOverlay: false,
  enableSliderPuzzleAssist: false,
  enableSingleSliderAssist: false,
  enableClickSelectAssist: false,
  enableNotification: true,
  autoSubmit: false,
  autoSolveOnRule: true,
  siteBlacklist: [],
  imageContextMenuEnabled: false,
  imageContextMenuAutoFill: true,
  preserveFocus: false,
  deepScan: false
};
var DEFAULT_EXTENSION_SETTINGS = {
  ...DEFAULT_CONFIG,
  timeout: 30000,
  retryCount: 3,
  autoFill: true,
  historyRetention: 7
};
class Logger {
  static debugMode = false;
  static prefix = "[Mieru-OCR]";
  static setDebugMode(enabled2) {
    this.debugMode = enabled2;
    setDiagnosticsEnabled(enabled2);
  }
  static isDebugMode() {
    return this.debugMode;
  }
  static debug(...args) {
    if (this.debugMode) {
      console.log(`${this.prefix} [DEBUG]`, ...args);
      pushEntry("debug", args);
    }
  }
  static info(...args) {
    if (this.debugMode) {
      console.info(`${this.prefix} [INFO]`, ...args);
      pushEntry("info", args);
    }
  }
  static warn(...args) {
    console.warn(`${this.prefix} [WARN]`, ...args);
    if (this.debugMode)
      pushEntry("warn", args);
  }
  static error(...args) {
    console.error(`${this.prefix} [ERROR]`, ...args);
    if (this.debugMode)
      pushEntry("error", args);
  }
  static group(label) {
    if (this.debugMode) {
      console.group(`${this.prefix} ${label}`);
    }
  }
  static groupEnd() {
    if (this.debugMode) {
      console.groupEnd();
    }
  }
  static table(data) {
    if (this.debugMode) {
      console.table(data);
    }
  }
  static time(label) {
    if (this.debugMode) {
      console.time(`${this.prefix} ${label}`);
    }
  }
  static timeEnd(label) {
    if (this.debugMode) {
      console.timeEnd(`${this.prefix} ${label}`);
    }
  }
}

// src/core/captcha-detector.ts
class CaptchaDetector {
  detectedCaptchas = [];
  lastLoggedScanCount = -1;
  processedElements = new WeakMap;
  checkedAgreements = new WeakSet;
  customIncludeKeywords = [];
  customExcludePatterns = [];
  customAgreementKeywords = [];
  customInputExcludeKeywords = [];
  captureForOCR;
  setCustomPatterns(include, exclude, agreementKeywords, inputExcludeKeywords) {
    this.customIncludeKeywords = include.map((k) => k.toLowerCase().trim()).filter(Boolean);
    this.customExcludePatterns = exclude.map((p) => p.toLowerCase().trim()).filter(Boolean);
    this.customAgreementKeywords = (agreementKeywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean);
    this.customInputExcludeKeywords = (inputExcludeKeywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean);
  }
  getCaptchaKeywords() {
    if (this.customIncludeKeywords.length === 0)
      return CONSTANTS.CAPTCHA_KEYWORDS;
    return [...CONSTANTS.CAPTCHA_KEYWORDS, ...this.customIncludeKeywords];
  }
  getExcludePatterns() {
    if (this.customExcludePatterns.length === 0)
      return CONSTANTS.EXCLUDE_PATTERNS;
    return [...CONSTANTS.EXCLUDE_PATTERNS, ...this.customExcludePatterns];
  }
  getAgreementKeywords() {
    if (this.customAgreementKeywords.length === 0)
      return CONSTANTS.AGREEMENT_KEYWORDS;
    return [...CONSTANTS.AGREEMENT_KEYWORDS, ...this.customAgreementKeywords];
  }
  getInputExcludeKeywords() {
    if (this.customInputExcludeKeywords.length === 0)
      return CONSTANTS.INPUT_EXCLUDE_KEYWORDS;
    return [...CONSTANTS.INPUT_EXCLUDE_KEYWORDS, ...this.customInputExcludeKeywords];
  }
  hasNearbyCaptchaInput(element) {
    const input = this.findRelatedInput(element);
    if (!input)
      return false;
    return this.isCaptchaInputByName(input);
  }
  isExcludedElement(element) {
    const className = (element.className?.toString?.() || "").toLowerCase();
    const id = (element.id || "").toLowerCase();
    if (id.startsWith("mieru-") || className.startsWith("mieru-") || className.includes(" mieru-")) {
      return true;
    }
    if (id.startsWith("ddddocr") || className.includes("ddddocr")) {
      return true;
    }
    const excludePatterns = this.getExcludePatterns();
    const combined = `${className} ${id}`.trim();
    return excludePatterns.some((pattern) => combined.includes(pattern));
  }
  scan() {
    this.detectedCaptchas = [];
    Logger.time("CaptchaDetector.scan");
    this.scanImages();
    this.scanCanvas();
    this.scanSvg();
    this.scanBackgroundImages();
    this.scanInteractiveContainers();
    Logger.timeEnd("CaptchaDetector.scan");
    const count = this.detectedCaptchas.length;
    if (count > 0 || count !== this.lastLoggedScanCount) {
      Logger.debug("扫描结果:", count, "个验证码");
      this.lastLoggedScanCount = count;
    }
    return this.detectedCaptchas;
  }
  scanImages() {
    document.querySelectorAll("img").forEach((img, index) => {
      if (this.isLikelyCaptcha(img)) {
        const rect = img.getBoundingClientRect();
        const captcha = {
          id: `captcha-${index}`,
          type: "image",
          element: img,
          src: img.src,
          rect,
          confidence: this.calculateConfidence(img),
          inputElement: this.findRelatedInput(img),
          elementInfo: this.extractCaptchaInfo(img)
        };
        this.detectedCaptchas.push(captcha);
        Logger.debug("检测到图片验证码:", captcha.elementInfo);
      }
    });
  }
  scanCanvas() {
    document.querySelectorAll("canvas").forEach((canvas, index) => {
      if (this.isLikelyCanvasCaptcha(canvas)) {
        const rect = canvas.getBoundingClientRect();
        const captcha = {
          id: `captcha-canvas-${index}`,
          type: "canvas",
          element: canvas,
          rect,
          confidence: this.calculateConfidence(canvas),
          inputElement: this.findRelatedInput(canvas),
          elementInfo: this.extractCaptchaInfo(canvas)
        };
        this.detectedCaptchas.push(captcha);
        Logger.debug("检测到Canvas验证码:", captcha.elementInfo);
      }
    });
  }
  scanSvg() {
    document.querySelectorAll("svg").forEach((svg, index) => {
      if (this.isLikelySvgCaptcha(svg)) {
        const rect = svg.getBoundingClientRect();
        const captcha = {
          id: `captcha-svg-${index}`,
          type: "svg",
          element: svg,
          rect,
          confidence: this.calculateConfidence(svg),
          inputElement: this.findRelatedInput(svg),
          elementInfo: this.extractCaptchaInfo(svg)
        };
        this.detectedCaptchas.push(captcha);
        Logger.debug("检测到SVG验证码:", captcha.elementInfo);
      }
    });
  }
  scanBackgroundImages() {
    const candidates = document.querySelectorAll('div[style*="background"], span[style*="background"], td[style*="background"]');
    candidates.forEach((el, index) => {
      const htmlEl = el;
      if (this.isLikelyBackgroundCaptcha(htmlEl)) {
        const rect = htmlEl.getBoundingClientRect();
        const bgImage = htmlEl.style.backgroundImage || "";
        const captcha = {
          id: `captcha-bg-${index}`,
          type: "background",
          element: htmlEl,
          src: bgImage,
          rect,
          confidence: this.calculateConfidence(htmlEl),
          inputElement: this.findRelatedInput(htmlEl),
          elementInfo: this.extractCaptchaInfo(htmlEl)
        };
        this.detectedCaptchas.push(captcha);
        Logger.debug("检测到背景图验证码:", captcha.elementInfo);
      }
    });
  }
  scanInteractiveContainers() {
    const SLIDER = CONSTANTS.SLIDER_KEYWORDS;
    const CLICK = CONSTANTS.CLICK_SELECT_KEYWORDS;
    if (!SLIDER && !CLICK)
      return;
    const slider = (SLIDER || []).map((s) => s.toLowerCase());
    const click = (CLICK || []).map((s) => s.toLowerCase());
    const MAX_NODES = 600;
    let scanned = 0;
    const seen = new Set;
    const matchKeyword = (el, list) => {
      const haystack = ((el.className?.toString?.() || "") + " " + (el.id || "") + " " + (el.getAttribute("data-captcha-type") || "") + " " + (el.getAttribute("aria-label") || "")).toLowerCase();
      if (!haystack.trim())
        return false;
      return list.some((kw) => haystack.includes(kw));
    };
    const consider = (el, kind, idx) => {
      if (seen.has(el) || ++scanned > MAX_NODES)
        return;
      seen.add(el);
      if (!this.isVisible(el))
        return;
      const inner = el.querySelector("canvas, img");
      if (!inner)
        return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 24)
        return;
      const innerEl = inner;
      if (this.detectedCaptchas.some((c) => c.element === el || c.element === innerEl))
        return;
      const captcha = {
        id: `captcha-${kind}-${idx}`,
        type: "canvas",
        subType: kind,
        element: el,
        innerCanvas: innerEl,
        rect,
        confidence: this.calculateConfidence(el) + 10,
        inputElement: this.findRelatedInput(el),
        elementInfo: this.extractCaptchaInfo(el)
      };
      if (kind === "slider") {
        const parts = this.findSliderParts(el, innerEl);
        if (parts.background)
          captcha.innerCanvas = parts.background;
        if (parts.piece)
          captcha.sliderPiece = parts.piece;
        if (parts.handle)
          captcha.sliderHandle = parts.handle;
      }
      this.detectedCaptchas.push(captcha);
      Logger.debug(`检测到交互式验证码 (${kind}):`, captcha.elementInfo);
    };
    const buildSel = (list) => list.flatMap((kw) => [`[class*="${kw}" i]`, `[id*="${kw}" i]`, `[data-captcha-type*="${kw}" i]`]).join(",");
    if (slider.length) {
      const sel = buildSel(slider);
      try {
        document.querySelectorAll(sel).forEach((el, i) => {
          if (matchKeyword(el, slider))
            consider(el, "slider", i);
        });
      } catch {
        document.querySelectorAll("div, section, span").forEach((el, i) => {
          if (scanned > MAX_NODES)
            return;
          if (matchKeyword(el, slider))
            consider(el, "slider", i);
        });
      }
    }
    if (click.length) {
      const sel = buildSel(click);
      try {
        document.querySelectorAll(sel).forEach((el, i) => {
          if (matchKeyword(el, click))
            consider(el, "click-select", i);
        });
      } catch {
        document.querySelectorAll("div, section, span").forEach((el, i) => {
          if (scanned > MAX_NODES)
            return;
          if (matchKeyword(el, click))
            consider(el, "click-select", i);
        });
      }
    }
  }
  findSliderParts(container, fallbackInner) {
    const surfaces = Array.from(container.querySelectorAll("canvas, img"));
    const visible = surfaces.filter((s) => {
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const area = (s) => {
      const r = s.getBoundingClientRect();
      return r.width * r.height;
    };
    let background;
    let piece;
    if (visible.length >= 2) {
      const sorted = [...visible].sort((a, b) => area(b) - area(a));
      background = sorted[0];
      piece = sorted.slice(1).find((s) => {
        const r = s.getBoundingClientRect();
        const ratio = r.width / Math.max(1, r.height);
        return area(s) < area(background) * 0.6 && ratio > 0.4 && ratio < 2.5;
      }) || sorted[1];
    } else if (visible.length === 1) {
      background = visible[0];
    } else {
      background = fallbackInner;
    }
    return { background, piece, handle: this.findSliderHandle(container) };
  }
  findSliderHandle(container) {
    const KW = [
      "handle",
      "slider-btn",
      "sliderbtn",
      "btn_slide",
      "slide-btn",
      "drag",
      "knob",
      "thumb",
      "gt_slider_knob",
      "gt_slider",
      "nc_iconfont",
      "control"
    ];
    let candidates = [];
    try {
      const sel = KW.map((k) => `[class*="${k}" i],[id*="${k}" i]`).join(",");
      candidates = Array.from(container.querySelectorAll(sel));
    } catch {}
    candidates.push(...Array.from(container.querySelectorAll('[draggable="true"]')));
    if (candidates.length === 0 && typeof getComputedStyle === "function") {
      Array.from(container.querySelectorAll("*")).forEach((e) => {
        const cur = getComputedStyle(e).cursor;
        if (cur === "grab" || cur === "move") {
          const r = e.getBoundingClientRect();
          if (r.width > 10 && r.width < 90 && r.height > 10)
            candidates.push(e);
        }
      });
    }
    const visible = candidates.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width < 140;
    });
    if (visible.length === 0)
      return;
    visible.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return visible[0];
  }
  extractCaptchaInfo(element) {
    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      className: element.className?.toString?.() || "",
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      src: element.src
    };
  }
  extractInputInfo(input) {
    return {
      tagName: input.tagName.toLowerCase(),
      id: input.id || null,
      name: input.name || null,
      className: input.className || "",
      placeholder: input.placeholder || null,
      type: input.type || "text"
    };
  }
  getEffectiveSize(element) {
    const rect = element.getBoundingClientRect();
    let width = rect.width;
    let height = rect.height;
    if (element instanceof HTMLImageElement) {
      if (width === 0 && element.naturalWidth > 0) {
        width = element.naturalWidth;
      }
      if (height === 0 && element.naturalHeight > 0) {
        height = element.naturalHeight;
      }
      if (width === 0) {
        width = parseInt(element.getAttribute("width") || "0") || 0;
      }
      if (height === 0) {
        height = parseInt(element.getAttribute("height") || "0") || 0;
      }
    }
    return { width, height };
  }
  isLikelyCaptcha(img) {
    const { width, height } = this.getEffectiveSize(img);
    if (!this.isCaptchaSize(width, height)) {
      return false;
    }
    if (!this.isVisibleOrHasSize(img, width, height)) {
      return false;
    }
    if (this.isExcludedImage(img)) {
      return false;
    }
    if (this.matchesKeywords(img))
      return true;
    if (this.srcContainsKeywords(img.src))
      return true;
    if (this.parentContainsKeywords(img))
      return true;
    if (this.hasNearbyCaptchaInput(img))
      return true;
    if (this.isDataUrlImage(img) && this.isCaptchaSize(width, height)) {
      if (this.hasNearbyCaptchaInput(img) || this.parentContainsKeywords(img))
        return true;
    }
    return false;
  }
  isDataUrlImage(img) {
    return img.src && (img.src.startsWith("data:image/") || img.src.startsWith("blob:")) ? img.src : null;
  }
  isVisibleOrHasSize(element, effectiveWidth, effectiveHeight) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      return false;
    }
    return effectiveWidth > 0 && effectiveHeight > 0;
  }
  getImageSrcForExclusionCheck(img) {
    const src = (img.currentSrc || img.src || "").trim();
    if (!src)
      return "";
    if (src.startsWith("data:image/") || src.startsWith("blob:")) {
      return "";
    }
    try {
      const url = new URL(src, window.location.href);
      return (url.origin + url.pathname).toLowerCase();
    } catch {
      return src.slice(0, 200).toLowerCase();
    }
  }
  isExcludedImage(img) {
    const src = this.getImageSrcForExclusionCheck(img);
    const alt = (img.alt || "").toLowerCase();
    const className = (img.className?.toString?.() || "").toLowerCase();
    const id = (img.id || "").toLowerCase();
    const excludePatterns = this.getExcludePatterns();
    const combined = `${src} ${alt} ${className} ${id}`.trim();
    return excludePatterns.some((pattern) => combined.includes(pattern));
  }
  isLikelyCanvasCaptcha(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (!this.isCaptchaSize(rect.width, rect.height)) {
      return false;
    }
    if (!this.isVisible(canvas)) {
      return false;
    }
    if (this.isExcludedElement(canvas)) {
      return false;
    }
    if (this.matchesKeywords(canvas))
      return true;
    if (this.parentContainsKeywords(canvas))
      return true;
    if (this.hasNearbyCaptchaInput(canvas))
      return true;
    return false;
  }
  isLikelySvgCaptcha(svg) {
    const width = svg.clientWidth || parseInt(svg.getAttribute("width") || "0");
    const height = svg.clientHeight || parseInt(svg.getAttribute("height") || "0");
    if (!this.isCaptchaSize(width, height)) {
      return false;
    }
    if (!this.isVisible(svg)) {
      return false;
    }
    if (this.isExcludedElement(svg)) {
      return false;
    }
    if (this.matchesKeywords(svg))
      return true;
    if (this.parentContainsKeywords(svg))
      return true;
    if (this.hasNearbyCaptchaInput(svg))
      return true;
    return false;
  }
  isLikelyBackgroundCaptcha(el) {
    const bgImage = el.style.backgroundImage || "";
    if (!bgImage || bgImage === "none")
      return false;
    const rect = el.getBoundingClientRect();
    if (!this.isCaptchaSize(rect.width, rect.height)) {
      return false;
    }
    if (!this.isVisible(el)) {
      return false;
    }
    if (this.isExcludedElement(el)) {
      return false;
    }
    if (this.matchesKeywords(el))
      return true;
    if (this.parentContainsKeywords(el))
      return true;
    if (this.hasNearbyCaptchaInput(el))
      return true;
    if (bgImage.includes("data:image/"))
      return this.hasNearbyCaptchaInput(el) || this.parentContainsKeywords(el);
    return false;
  }
  isCaptchaSize(width, height) {
    return width >= CONSTANTS.MIN_CAPTCHA_WIDTH && width <= CONSTANTS.MAX_CAPTCHA_WIDTH && height >= CONSTANTS.MIN_CAPTCHA_HEIGHT && height <= CONSTANTS.MAX_CAPTCHA_HEIGHT;
  }
  isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  }
  isFrameworkCheckbox(checkbox) {
    const classNames = [
      "el-checkbox__original",
      "ant-checkbox-input",
      "ivu-checkbox-input",
      "van-checkbox__input",
      "weui-check",
      "mdui-checkbox-input",
      "mdc-checkbox__native-control"
    ];
    for (const cls of classNames) {
      if (checkbox.classList.contains(cls))
        return true;
    }
    const containerSelectors = [
      ".el-checkbox",
      ".ant-checkbox",
      ".ant-checkbox-wrapper",
      ".ivu-checkbox",
      ".ivu-checkbox-wrapper",
      ".van-checkbox",
      ".weui-check__label",
      ".mdui-checkbox",
      ".mdc-checkbox"
    ];
    for (const sel of containerSelectors) {
      if (checkbox.closest(sel))
        return true;
    }
    return false;
  }
  isCheckboxFunctional(checkbox) {
    if (checkbox.disabled)
      return false;
    if (this.isFrameworkCheckbox(checkbox)) {
      const containers = [
        checkbox.closest(".el-checkbox"),
        checkbox.closest(".ant-checkbox-wrapper"),
        checkbox.closest(".ivu-checkbox-wrapper"),
        checkbox.closest(".van-checkbox"),
        checkbox.closest("label")
      ];
      for (const container of containers) {
        if (container) {
          const style2 = window.getComputedStyle(container);
          if (style2.display !== "none" && style2.visibility !== "hidden") {
            return true;
          }
        }
      }
      let parent2 = checkbox.parentElement;
      let depth2 = 0;
      while (parent2 && depth2 < 5) {
        const style2 = window.getComputedStyle(parent2);
        if (style2.display === "none")
          return false;
        if (style2.visibility === "hidden")
          return false;
        parent2 = parent2.parentElement;
        depth2++;
      }
      return true;
    }
    const style = window.getComputedStyle(checkbox);
    if (style.display === "none")
      return false;
    let parent = checkbox.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.display === "none" || parentStyle.visibility === "hidden") {
        return false;
      }
      parent = parent.parentElement;
      depth++;
    }
    return true;
  }
  findClickableTarget(checkbox) {
    const elCheckbox = checkbox.closest(".el-checkbox");
    if (elCheckbox) {
      const inner = elCheckbox.querySelector(".el-checkbox__inner");
      if (inner)
        return inner;
      return elCheckbox;
    }
    const antWrapper = checkbox.closest(".ant-checkbox-wrapper");
    if (antWrapper) {
      const inner = antWrapper.querySelector(".ant-checkbox-inner");
      if (inner)
        return inner;
      return antWrapper;
    }
    const ivuWrapper = checkbox.closest(".ivu-checkbox-wrapper");
    if (ivuWrapper) {
      const inner = ivuWrapper.querySelector(".ivu-checkbox-inner");
      if (inner)
        return inner;
      return ivuWrapper;
    }
    const vanCheckbox = checkbox.closest(".van-checkbox");
    if (vanCheckbox) {
      const icon = vanCheckbox.querySelector(".van-checkbox__icon");
      if (icon)
        return icon;
      return vanCheckbox;
    }
    const label = checkbox.closest("label");
    if (label)
      return label;
    return null;
  }
  matchesKeywords(element) {
    const className = (element.className?.toString?.() || "").toLowerCase();
    const id = (element.id || "").toLowerCase();
    const keywords = this.getCaptchaKeywords();
    return keywords.some((keyword) => className.includes(keyword) || id.includes(keyword));
  }
  srcContainsKeywords(src) {
    if (!src)
      return false;
    const lowerSrc = src.toLowerCase();
    const keywords = this.getCaptchaKeywords();
    return keywords.some((keyword) => lowerSrc.includes(keyword));
  }
  parentContainsKeywords(element) {
    let parent = element.parentElement;
    let depth = 0;
    while (parent && depth < 3) {
      if (this.matchesKeywords(parent))
        return true;
      parent = parent.parentElement;
      depth++;
    }
    return false;
  }
  hasNearbyInput(element) {
    return this.findRelatedInput(element) !== null;
  }
  getInputLabelText(input) {
    try {
      if (input.id) {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (label)
          return (label.textContent || "").trim();
      }
      const wrapperLabel = input.closest("label");
      if (wrapperLabel)
        return (wrapperLabel.textContent || "").trim();
    } catch {}
    return "";
  }
  getInputSearchText(input) {
    const parts = [];
    parts.push(input.name || "");
    parts.push(input.id || "");
    parts.push(input.className || "");
    parts.push(input.placeholder || "");
    parts.push(input.getAttribute("aria-label") || "");
    parts.push(input.getAttribute("data-label") || "");
    parts.push(input.getAttribute("data-name") || "");
    parts.push(this.getInputLabelText(input));
    return parts.join(" ").toLowerCase();
  }
  isCaptchaInputByName(input) {
    const text = this.getInputSearchText(input);
    return CONSTANTS.INPUT_KEYWORDS.some((keyword) => text.includes(keyword));
  }
  isExcludedInputByText(input) {
    const text = this.getInputSearchText(input);
    const excluded = [
      "username",
      "user",
      "account",
      "email",
      "phone",
      "mobile",
      "tel",
      "password",
      "pwd",
      "pass",
      "search",
      "query",
      "keyword",
      "用户名",
      "账号",
      "密码",
      "手机号",
      "邮箱",
      "搜索",
      "查询",
      "关键字"
    ];
    const inputExcludeKeywords = this.getInputExcludeKeywords();
    const allExcluded = [...excluded, ...inputExcludeKeywords];
    return allExcluded.some((k) => text.includes(k));
  }
  scoreInputCandidate(input, captchaRect, inputRect) {
    const distance = this.calculateDistance(captchaRect, inputRect);
    let bonus = 0;
    const text = this.getInputSearchText(input);
    if (this.isCaptchaInputByName(input))
      bonus += 120;
    if (text.includes("验证码"))
      bonus += 140;
    if (text.includes("verify"))
      bonus += 80;
    if (text.includes("vcode"))
      bonus += 80;
    if (text.includes("authcode"))
      bonus += 80;
    if (text.includes("checkcode"))
      bonus += 80;
    if (text.includes("yzm"))
      bonus += 60;
    if (this.isExcludedInputByText(input))
      bonus -= 200;
    return distance - bonus;
  }
  findClosestInputInContainer(container, captchaRect, maxDistance = Infinity) {
    const inputs = container.querySelectorAll("input");
    let closest = null;
    let closestScore = Infinity;
    let closestDistance = Infinity;
    for (const input of inputs) {
      const htmlInput = input;
      if (!this.isValidCaptchaInput(htmlInput))
        continue;
      if (this.isExcludedInputByText(htmlInput) && !this.isCaptchaInputByName(htmlInput))
        continue;
      const inputRect = input.getBoundingClientRect();
      const distance = this.calculateDistance(captchaRect, inputRect);
      if (distance > maxDistance)
        continue;
      const score = this.scoreInputCandidate(htmlInput, captchaRect, inputRect);
      if (score < closestScore || Math.abs(score - closestScore) < 15 && distance < closestDistance) {
        closestScore = score;
        closestDistance = distance;
        closest = htmlInput;
      }
    }
    return closest;
  }
  findFrameworkRelatedInput(element) {
    const elInput = element.closest(".el-input") || element.closest(".el-input-group") || element.closest(".el-form-item");
    if (elInput) {
      const elInner = elInput.querySelector("input.el-input__inner");
      if (elInner && this.isValidCaptchaInput(elInner))
        return elInner;
      const anyInput = elInput.querySelector("input");
      if (anyInput && this.isValidCaptchaInput(anyInput))
        return anyInput;
    }
    const antInput = element.closest(".ant-input-group") || element.closest(".ant-form-item") || element.closest(".ant-input-affix-wrapper");
    if (antInput) {
      const anyInput = antInput.querySelector("input");
      if (anyInput && this.isValidCaptchaInput(anyInput))
        return anyInput;
    }
    const ivuInput = element.closest(".ivu-input-group") || element.closest(".ivu-form-item");
    if (ivuInput) {
      const anyInput = ivuInput.querySelector("input");
      if (anyInput && this.isValidCaptchaInput(anyInput))
        return anyInput;
    }
    const vanInput = element.closest(".van-field") || element.closest(".van-cell");
    if (vanInput) {
      const anyInput = vanInput.querySelector("input");
      if (anyInput && this.isValidCaptchaInput(anyInput))
        return anyInput;
    }
    return null;
  }
  findRelatedInput(element) {
    const frameworkInput = this.findFrameworkRelatedInput(element);
    if (frameworkInput)
      return frameworkInput;
    const captchaRect = element.getBoundingClientRect();
    const parent = element.parentElement;
    if (parent) {
      const input = this.findClosestInputInContainer(parent, captchaRect);
      if (input)
        return input;
    }
    let ancestor = parent?.parentElement;
    let depth = 0;
    while (ancestor && depth < 4) {
      const input = this.findClosestInputInContainer(ancestor, captchaRect, 180);
      if (input)
        return input;
      ancestor = ancestor.parentElement;
      depth++;
    }
    const inputs = document.querySelectorAll("input");
    let best = null;
    let bestScore = Infinity;
    for (const input of inputs) {
      const htmlInput = input;
      if (!this.isValidCaptchaInput(htmlInput))
        continue;
      if (this.isExcludedInputByText(htmlInput) && !this.isCaptchaInputByName(htmlInput))
        continue;
      const inputRect = input.getBoundingClientRect();
      const roughlyNear = inputRect.left > captchaRect.right && inputRect.left - captchaRect.right < 220 && Math.abs(inputRect.top - captchaRect.top) < 90 || inputRect.top > captchaRect.bottom && inputRect.top - captchaRect.bottom < 160 && Math.abs(inputRect.left - captchaRect.left) < 160 || this.calculateDistance(captchaRect, inputRect) < 240;
      if (!roughlyNear)
        continue;
      const score = this.scoreInputCandidate(htmlInput, captchaRect, inputRect);
      if (score < bestScore) {
        bestScore = score;
        best = htmlInput;
      }
    }
    return best;
  }
  isValidCaptchaInput(input) {
    const type = (input.type || "text").toLowerCase();
    if (CONSTANTS.EXCLUDED_INPUT_TYPES.includes(type)) {
      return false;
    }
    const name = (input.name || "").toLowerCase();
    const id = (input.id || "").toLowerCase();
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
  calculateConfidence(element) {
    let score = 0;
    if (this.matchesKeywords(element))
      score += 30;
    if (element.src && this.srcContainsKeywords(element.src))
      score += 20;
    if (this.parentContainsKeywords(element))
      score += 15;
    if (this.findRelatedInput(element))
      score += 25;
    const { width, height } = this.getEffectiveSize(element);
    if (this.isCaptchaSize(width, height))
      score += 10;
    return Math.min(score, 100);
  }
  guessRelatedCaptcha(inputElement) {
    const guessed = [];
    const inputRect = inputElement.getBoundingClientRect();
    Logger.debug("开始猜测关联的验证码元素, 输入框位置:", inputRect);
    const candidates = [];
    document.querySelectorAll("img").forEach((img) => {
      if (!this.isVisible(img))
        return;
      const { width, height } = this.getEffectiveSize(img);
      if (!this.isCaptchaSize(width, height))
        return;
      if (this.isExcludedImage(img))
        return;
      const rect = img.getBoundingClientRect();
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: img, distance, type: "image" });
    });
    document.querySelectorAll("canvas").forEach((canvas) => {
      if (!this.isVisible(canvas))
        return;
      const rect = canvas.getBoundingClientRect();
      if (!this.isCaptchaSize(rect.width, rect.height))
        return;
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: canvas, distance, type: "canvas" });
    });
    document.querySelectorAll("svg").forEach((svg) => {
      if (!this.isVisible(svg))
        return;
      const width = svg.clientWidth || parseInt(svg.getAttribute("width") || "0");
      const height = svg.clientHeight || parseInt(svg.getAttribute("height") || "0");
      if (!this.isCaptchaSize(width, height))
        return;
      const rect = svg.getBoundingClientRect();
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: svg, distance, type: "svg" });
    });
    document.querySelectorAll('div[style*="background"], span[style*="background"]').forEach((el) => {
      const htmlEl = el;
      if (!this.isVisible(htmlEl))
        return;
      const bgImage = htmlEl.style.backgroundImage || "";
      if (!bgImage || bgImage === "none")
        return;
      const rect = htmlEl.getBoundingClientRect();
      if (!this.isCaptchaSize(rect.width, rect.height))
        return;
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: htmlEl, distance, type: "background" });
    });
    candidates.sort((a, b) => a.distance - b.distance);
    const topCandidates = candidates.slice(0, 3);
    for (const candidate of topCandidates) {
      const confidence = Math.max(0, 100 - Math.floor(candidate.distance / 5));
      guessed.push({
        element: candidate.element,
        type: "captcha",
        confidence,
        selector: this.generateSelector(candidate.element)
      });
    }
    Logger.debug("猜测的验证码元素:", guessed);
    return guessed;
  }
  guessRelatedInput(captchaElement) {
    const guessed = [];
    const captchaRect = captchaElement.getBoundingClientRect();
    Logger.debug("开始猜测关联的输入框, 验证码位置:", captchaRect);
    const candidates = [];
    document.querySelectorAll("input").forEach((input) => {
      const htmlInput = input;
      if (!this.isValidCaptchaInput(htmlInput))
        return;
      if (!this.isVisible(htmlInput))
        return;
      const rect = htmlInput.getBoundingClientRect();
      const distance = this.calculateDistance(captchaRect, rect);
      const hasKeyword = this.isCaptchaInputByName(htmlInput);
      const score = this.scoreInputCandidate(htmlInput, captchaRect, rect);
      candidates.push({ element: htmlInput, distance, hasKeyword, score });
    });
    candidates.sort((a, b) => a.score - b.score);
    const topCandidates = candidates.slice(0, 3);
    for (const candidate of topCandidates) {
      let confidence = Math.max(0, 100 - Math.floor(candidate.distance / 5));
      if (candidate.hasKeyword)
        confidence = Math.min(100, confidence + 20);
      guessed.push({
        element: candidate.element,
        type: "input",
        confidence,
        selector: this.generateSelector(candidate.element)
      });
    }
    Logger.debug("猜测的输入框元素:", guessed);
    return guessed;
  }
  guessAgreementCheckboxes() {
    const guessed = [];
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((checkbox) => {
      const htmlCheckbox = checkbox;
      if (!this.isCheckboxFunctional(htmlCheckbox))
        return;
      if (this.checkedAgreements.has(htmlCheckbox))
        return;
      const textSources = [];
      textSources.push(htmlCheckbox.name || "");
      textSources.push(htmlCheckbox.id || "");
      textSources.push(htmlCheckbox.className || "");
      textSources.push(htmlCheckbox.getAttribute("data-type") || "");
      textSources.push(htmlCheckbox.getAttribute("data-name") || "");
      textSources.push(htmlCheckbox.getAttribute("aria-label") || "");
      textSources.push(htmlCheckbox.getAttribute("data-v-inspector") || "");
      const labelById = htmlCheckbox.id ? document.querySelector(`label[for="${htmlCheckbox.id}"]`) : null;
      if (labelById) {
        textSources.push(labelById.textContent || "");
        textSources.push(labelById.className || "");
      }
      const wrapperLabel = htmlCheckbox.closest("label");
      if (wrapperLabel) {
        textSources.push(wrapperLabel.textContent || "");
        textSources.push(wrapperLabel.className || "");
      }
      const frameworkContainers = [
        htmlCheckbox.closest(".el-checkbox"),
        htmlCheckbox.closest(".ant-checkbox-wrapper"),
        htmlCheckbox.closest(".ivu-checkbox-wrapper"),
        htmlCheckbox.closest(".van-checkbox"),
        htmlCheckbox.closest('[class*="checkbox"]')
      ];
      for (const container of frameworkContainers) {
        if (container) {
          textSources.push(container.textContent || "");
          textSources.push(container.className || "");
        }
      }
      let parent = htmlCheckbox.parentElement;
      let depth = 0;
      while (parent && depth < 6) {
        const tagName = parent.tagName.toLowerCase();
        textSources.push(parent.className || "");
        textSources.push(parent.id || "");
        if (["label", "div", "span", "p", "li", "td"].includes(tagName)) {
          const children = parent.children;
          for (let i = 0;i < children.length; i++) {
            const child = children[i];
            if (child.tagName !== "INPUT" && child.tagName !== "SCRIPT" && child.tagName !== "STYLE") {
              textSources.push(child.textContent || "");
              textSources.push(child.className || "");
            }
          }
        }
        if (tagName === "form" || tagName === "body")
          break;
        const parentClass = parent.className?.toLowerCase() || "";
        if (parentClass.includes("form-item") || parentClass.includes("formitem")) {
          textSources.push(parent.textContent || "");
          break;
        }
        parent = parent.parentElement;
        depth++;
      }
      const formItem = htmlCheckbox.closest('.el-form-item, .ant-form-item, .ivu-form-item, [class*="form-item"], [class*="formitem"]');
      if (formItem) {
        textSources.push(formItem.textContent || "");
        textSources.push(formItem.className || "");
      }
      const combinedText = textSources.join(" ").toLowerCase();
      const hasKeyword = this.getAgreementKeywords().some((keyword) => combinedText.includes(keyword));
      if (hasKeyword) {
        const clickTarget = this.findClickableTarget(htmlCheckbox);
        guessed.push({
          element: htmlCheckbox,
          type: "agreement",
          confidence: 80,
          selector: this.generateSelector(htmlCheckbox),
          clickTarget: clickTarget || undefined
        });
      }
    });
    Logger.debug("猜测的协议复选框:", guessed);
    return guessed;
  }
  findAgreementsBySelectors(selectors) {
    const found = [];
    for (const selector of selectors) {
      if (!selector.trim())
        continue;
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach((el) => {
          if (el instanceof HTMLInputElement && el.type === "checkbox") {
            if (!this.checkedAgreements.has(el)) {
              const clickTarget = this.findClickableTarget(el);
              found.push({
                element: el,
                type: "agreement",
                confidence: 100,
                selector,
                clickTarget: clickTarget || undefined
              });
            }
          }
        });
      } catch (e) {
        Logger.warn("无效的协议选择器:", selector, e);
      }
    }
    return found;
  }
  markAgreementChecked(checkbox) {
    this.checkedAgreements.add(checkbox);
  }
  calculateDistance(rect1, rect2) {
    const centerX1 = rect1.left + rect1.width / 2;
    const centerY1 = rect1.top + rect1.height / 2;
    const centerX2 = rect2.left + rect2.width / 2;
    const centerY2 = rect2.top + rect2.height / 2;
    return Math.sqrt(Math.pow(centerX2 - centerX1, 2) + Math.pow(centerY2 - centerY1, 2));
  }
  generateSelector(element) {
    if (element.id) {
      return "#" + element.id;
    }
    const className = element.className;
    if (className) {
      const classes = className.toString().trim().split(/\s+/).filter((c) => c && !c.includes(":"));
      if (classes.length > 0) {
        const selector = element.tagName.toLowerCase() + "." + classes.join(".");
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }
    }
    const path = [];
    let current = element;
    while (current && current !== document.body && path.length < 5) {
      let sel = current.tagName.toLowerCase();
      if (current.id) {
        path.unshift("#" + current.id);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
        if (siblings.length > 1) {
          sel += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      path.unshift(sel);
      current = current.parentElement;
    }
    return path.join(" > ");
  }
  async captureImage(captcha) {
    if (captcha.innerCanvas) {
      if (captcha.innerCanvas instanceof HTMLCanvasElement) {
        return this.captureCanvasElement(captcha.innerCanvas);
      }
      return this.captureImgElement(captcha.innerCanvas);
    }
    switch (captcha.type) {
      case "image":
        return this.captureImgElement(captcha.element);
      case "canvas":
        return this.captureCanvasElement(captcha.element);
      case "svg":
        return this.captureSvgElement(captcha.element);
      case "background":
        return this.captureBackgroundElement(captcha.element);
    }
  }
  async captureBuffer(captcha) {
    const blob = await this.captureBlob(captcha);
    return await blob.arrayBuffer();
  }
  async captureBlob(captcha) {
    if (captcha.innerCanvas) {
      if (captcha.innerCanvas instanceof HTMLCanvasElement) {
        return this.captureCanvasAsBlob(captcha.innerCanvas);
      }
      return this.captureImgAsBlob(captcha.innerCanvas);
    }
    switch (captcha.type) {
      case "image":
        return this.captureImgAsBlob(captcha.element);
      case "canvas":
        return this.captureCanvasAsBlob(captcha.element);
      case "svg":
        return this.captureSvgAsBlob(captcha.element);
      case "background":
        return this.captureBackgroundAsBlob(captcha.element);
    }
  }
  async captureImgElement(img) {
    await this.waitForImageLoad(img);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);
    try {
      return canvas.toDataURL("image/png");
    } catch {
      if (img.src.startsWith("data:"))
        return img.src;
      throw new Error("无法捕获跨域图片");
    }
  }
  async captureImgAsBlob(img) {
    await this.waitForImageLoad(img);
    if (img.src && !img.src.startsWith("data:") && !img.src.startsWith("blob:")) {
      try {
        const resp = await fetch(img.src, { credentials: "include" });
        if (resp.ok) {
          const ct = resp.headers.get("content-type") || "";
          if (ct.includes("image/")) {
            return await resp.blob();
          }
        }
      } catch {}
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob)
          resolve(blob);
        else
          reject(new Error("图片转换失败"));
      }, "image/png");
    });
  }
  async waitForImageLoad(img) {
    if (img.complete && img.naturalWidth > 0)
      return;
    if (img.src?.startsWith("data:") && img.naturalWidth > 0)
      return;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("图片加载超时")), 5000);
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("图片加载失败"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
      };
      img.addEventListener("load", onLoad);
      img.addEventListener("error", onError);
    });
  }
  captureCanvasElement(canvas) {
    return canvas.toDataURL("image/png");
  }
  captureCanvasAsBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob)
          resolve(blob);
        else
          reject(new Error("Canvas转换失败"));
      }, "image/png");
    });
  }
  async captureSvgElement(svg) {
    const blob = await this.captureSvgAsBlob(svg);
    return await this.blobToDataURL(blob);
  }
  async captureSvgAsBlob(svg) {
    const clonedSvg = svg.cloneNode(true);
    const rect = svg.getBoundingClientRect();
    clonedSvg.setAttribute("width", String(rect.width));
    clonedSvg.setAttribute("height", String(rect.height));
    if (!clonedSvg.getAttribute("xmlns")) {
      clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
    const serializer = new XMLSerializer;
    const svgString = serializer.serializeToString(clonedSvg);
    const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(svgBlob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image;
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("SVG转换失败"));
        el.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b)
            resolve(b);
          else
            reject(new Error("SVG转换失败"));
        }, "image/png");
      });
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async captureBackgroundElement(el) {
    const blob = await this.captureBackgroundAsBlob(el);
    return await this.blobToDataURL(blob);
  }
  async captureBackgroundAsBlob(el) {
    const bgImage = el.style.backgroundImage || window.getComputedStyle(el).backgroundImage || "";
    const urlMatch = bgImage.match(/url\(['"]?(.+?)['"]?\)/);
    if (!urlMatch) {
      throw new Error("无法提取背景图URL");
    }
    const imageUrl = urlMatch[1];
    if (imageUrl.startsWith("data:")) {
      const response = await fetch(imageUrl);
      return await response.blob();
    }
    const img = new Image;
    img.crossOrigin = "anonymous";
    img.src = imageUrl;
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("背景图加载失败"));
      setTimeout(() => reject(new Error("背景图加载超时")), 5000);
    });
    const canvas = document.createElement("canvas");
    const rect = el.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b)
          resolve(b);
        else
          reject(new Error("背景图转换失败"));
      }, "image/png");
    });
  }
  blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader;
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("读取失败"));
      reader.readAsDataURL(blob);
    });
  }
  highlight(captcha) {
    const el = captcha.element;
    el.setAttribute("data-captcha-highlight", "true");
  }
  unhighlight(captcha) {
    const el = captcha.element;
    el.removeAttribute("data-captcha-highlight");
  }
  highlightGuessed(element) {
    element.setAttribute("data-captcha-guessed", "true");
  }
  unhighlightGuessed(element) {
    element.removeAttribute("data-captcha-guessed");
  }
  unhighlightAllGuessed() {
    document.querySelectorAll("[data-captcha-guessed]").forEach((el) => {
      el.removeAttribute("data-captcha-guessed");
    });
  }
  getDetectedCaptchas() {
    return this.detectedCaptchas;
  }
  getMostLikelyCaptcha() {
    if (this.detectedCaptchas.length === 0)
      return null;
    return this.detectedCaptchas.reduce((best, current) => current.confidence > best.confidence ? current : best);
  }
  hasElementChanged(element) {
    const currentHash = this.getElementHash(element);
    const previousHash = this.processedElements.get(element);
    if (!previousHash)
      return true;
    return currentHash !== previousHash;
  }
  markElementProcessed(element) {
    const hash = this.getElementHash(element);
    this.processedElements.set(element, hash);
  }
  getElementHash(element) {
    if (element instanceof HTMLImageElement) {
      return element.src + "_" + element.naturalWidth + "_" + element.naturalHeight;
    } else if (element instanceof HTMLCanvasElement) {
      try {
        return element.toDataURL();
      } catch {
        return "canvas_" + Date.now();
      }
    } else if (element instanceof SVGElement) {
      return element.outerHTML;
    } else if (element instanceof HTMLElement && element.style.backgroundImage) {
      return element.style.backgroundImage;
    }
    return "";
  }
}

// src/core/slide-detector.ts
function toGray(imgData) {
  const { data, width, height } = imgData;
  const out = new Float32Array(width * height);
  for (let i = 0;i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    const r = data[i] * a + 255 * (1 - a);
    const g = data[i + 1] * a + 255 * (1 - a);
    const b = data[i + 2] * a + 255 * (1 - a);
    out[i / 4] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return { data: out, width, height };
}
function gaussianKernel1D(sigma, size) {
  const k = new Float32Array(size);
  const half = (size - 1) / 2;
  let sum = 0;
  for (let i = 0;i < size; i++) {
    const x = i - half;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0;i < size; i++)
    k[i] /= sum;
  return k;
}
function gaussianBlur(gray, sigma = 1.4) {
  const { data, width: w, height: h } = gray;
  const size = Math.max(3, Math.ceil(sigma * 3) * 2 + 1);
  const kernel = gaussianKernel1D(sigma, size);
  const half = size - 1 >> 1;
  const tmp = new Float32Array(w * h);
  for (let y = 0;y < h; y++) {
    for (let x = 0;x < w; x++) {
      let s = 0;
      for (let i = 0;i < size; i++) {
        let xi = x + i - half;
        if (xi < 0)
          xi = 0;
        else if (xi >= w)
          xi = w - 1;
        s += data[y * w + xi] * kernel[i];
      }
      tmp[y * w + x] = s;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0;y < h; y++) {
    for (let x = 0;x < w; x++) {
      let s = 0;
      for (let i = 0;i < size; i++) {
        let yi = y + i - half;
        if (yi < 0)
          yi = 0;
        else if (yi >= h)
          yi = h - 1;
        s += tmp[yi * w + x] * kernel[i];
      }
      out[y * w + x] = s;
    }
  }
  return { data: out, width: w, height: h };
}
function sobel(blurred) {
  const { data, width: w, height: h } = blurred;
  const mag = new Float32Array(w * h);
  const angle = new Float32Array(w * h);
  for (let y = 1;y < h - 1; y++) {
    for (let x = 1;x < w - 1; x++) {
      const tl = data[(y - 1) * w + (x - 1)];
      const t = data[(y - 1) * w + x];
      const tr = data[(y - 1) * w + (x + 1)];
      const l = data[y * w + (x - 1)];
      const r = data[y * w + (x + 1)];
      const bl = data[(y + 1) * w + (x - 1)];
      const b = data[(y + 1) * w + x];
      const br = data[(y + 1) * w + (x + 1)];
      const dx = -tl - 2 * l - bl + tr + 2 * r + br;
      const dy = -tl - 2 * t - tr + bl + 2 * b + br;
      const idx = y * w + x;
      mag[idx] = Math.sqrt(dx * dx + dy * dy);
      angle[idx] = Math.atan2(dy, dx);
    }
  }
  return { mag, angle, width: w, height: h };
}
function nonMaxSuppression({ mag, angle, width: w, height: h }) {
  const out = new Float32Array(w * h);
  for (let y = 1;y < h - 1; y++) {
    for (let x = 1;x < w - 1; x++) {
      const idx = y * w + x;
      let a = angle[idx] * 180 / Math.PI;
      if (a < 0)
        a += 180;
      let n1, n2;
      if (a >= 0 && a < 22.5 || a >= 157.5 && a <= 180) {
        n1 = mag[idx - 1];
        n2 = mag[idx + 1];
      } else if (a >= 22.5 && a < 67.5) {
        n1 = mag[(y + 1) * w + (x - 1)];
        n2 = mag[(y - 1) * w + (x + 1)];
      } else if (a >= 67.5 && a < 112.5) {
        n1 = mag[(y - 1) * w + x];
        n2 = mag[(y + 1) * w + x];
      } else {
        n1 = mag[(y - 1) * w + (x - 1)];
        n2 = mag[(y + 1) * w + (x + 1)];
      }
      out[idx] = mag[idx] >= n1 && mag[idx] >= n2 ? mag[idx] : 0;
    }
  }
  return { data: out, width: w, height: h };
}
function hysteresis(suppressed, lowT, highT) {
  const { data, width: w, height: h } = suppressed;
  const out = new Uint8ClampedArray(w * h);
  const STRONG = 255, WEAK = 75;
  const stack = [];
  for (let i = 0;i < w * h; i++) {
    if (data[i] >= highT) {
      out[i] = STRONG;
      stack.push(i);
    } else if (data[i] >= lowT) {
      out[i] = WEAK;
    }
  }
  while (stack.length) {
    const idx = stack.pop();
    const y = idx / w | 0, x = idx % w;
    for (let dy = -1;dy <= 1; dy++) {
      for (let dx = -1;dx <= 1; dx++) {
        if (!dx && !dy)
          continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h)
          continue;
        const ni = ny * w + nx;
        if (out[ni] === WEAK) {
          out[ni] = STRONG;
          stack.push(ni);
        }
      }
    }
  }
  for (let i = 0;i < w * h; i++)
    if (out[i] === WEAK)
      out[i] = 0;
  return { data: out, width: w, height: h };
}
function canny(gray, lowT = 50, highT = 150, sigma = 1.4) {
  const blurred = gaussianBlur(gray, sigma);
  const grad = sobel(blurred);
  const sup = nonMaxSuppression(grad);
  return hysteresis(sup, lowT, highT);
}
function matchTemplate(image, template) {
  const { data: I, width: iw, height: ih } = image;
  const { data: T, width: tw, height: th } = template;
  const rw = iw - tw + 1;
  const rh = ih - th + 1;
  if (rw < 1 || rh < 1) {
    throw new Error(`Template (${tw}x${th}) larger than image (${iw}x${ih})`);
  }
  let tSum = 0;
  const N = tw * th;
  for (let i = 0;i < N; i++)
    tSum += T[i];
  const tMean = tSum / N;
  let tSqSum = 0;
  const Tn = new Float32Array(N);
  for (let i = 0;i < N; i++) {
    Tn[i] = T[i] - tMean;
    tSqSum += Tn[i] * Tn[i];
  }
  const tNorm = Math.sqrt(tSqSum);
  let bestScore = -Infinity, bestX = 0, bestY = 0;
  for (let y = 0;y < rh; y++) {
    for (let x = 0;x < rw; x++) {
      let iSum = 0;
      for (let dy = 0;dy < th; dy++) {
        const rowOff = (y + dy) * iw + x;
        for (let dx = 0;dx < tw; dx++) {
          iSum += I[rowOff + dx];
        }
      }
      const iMean = iSum / N;
      let num = 0, iSqSum = 0;
      for (let dy = 0;dy < th; dy++) {
        const rowOff = (y + dy) * iw + x;
        const tRowOff = dy * tw;
        for (let dx = 0;dx < tw; dx++) {
          const v = I[rowOff + dx] - iMean;
          num += v * Tn[tRowOff + dx];
          iSqSum += v * v;
        }
      }
      const denom = Math.sqrt(iSqSum) * tNorm;
      const score = denom > 0.000000001 ? num / denom : 0;
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { x: bestX, y: bestY, score: bestScore, width: rw, height: rh };
}
function alphaBBox(imgData, alphaThresh = 16) {
  const { data, width, height } = imgData;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  let transparentCount = 0;
  for (let y = 0;y < height; y++) {
    for (let x = 0;x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a <= alphaThresh) {
        transparentCount++;
        continue;
      }
      if (x < minX)
        minX = x;
      if (y < minY)
        minY = y;
      if (x > maxX)
        maxX = x;
      if (y > maxY)
        maxY = y;
    }
  }
  const total = width * height;
  if (transparentCount < total * 0.02 || transparentCount > total * 0.98 || maxX < 0)
    return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function cropGray(gray, box) {
  const { data, width: w } = gray;
  const out = new Float32Array(box.w * box.h);
  for (let y = 0;y < box.h; y++) {
    for (let x = 0;x < box.w; x++) {
      out[y * box.w + x] = data[(box.y + y) * w + (box.x + x)];
    }
  }
  return { data: out, width: box.w, height: box.h };
}
function toFloatEdge(edge) {
  const out = new Float32Array(edge.data.length);
  for (let i = 0;i < edge.data.length; i++)
    out[i] = edge.data[i];
  return { data: out, width: edge.width, height: edge.height };
}
function downsampleGray(gray, factor) {
  const { data, width: w, height: h } = gray;
  const nw = Math.floor(w / factor), nh = Math.floor(h / factor);
  const out = new Float32Array(nw * nh);
  for (let y = 0;y < nh; y++) {
    for (let x = 0;x < nw; x++) {
      let s = 0, c = 0;
      for (let dy = 0;dy < factor; dy++) {
        for (let dx = 0;dx < factor; dx++) {
          s += data[(y * factor + dy) * w + (x * factor + dx)];
          c++;
        }
      }
      out[y * nw + x] = s / c;
    }
  }
  return { data: out, width: nw, height: nh };
}
function countNonZero(arr) {
  let n = 0;
  for (let i = 0;i < arr.length; i++)
    if (arr[i] !== 0)
      n++;
  return n;
}
function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
function slideMatch(targetImgData, bgImgData, opts = {}) {
  const { lowT = 50, highT = 150, sigma = 1.4, downsample = 1, minEdgePixels = 12 } = opts;
  const t0 = now();
  let cropOffset = { x: 0, y: 0 };
  const box = alphaBBox(targetImgData);
  let targetGray = toGray(targetImgData);
  let bgGray = toGray(bgImgData);
  if (box) {
    cropOffset = { x: box.x, y: box.y };
    targetGray = cropGray(targetGray, box);
  }
  if (downsample > 1) {
    targetGray = downsampleGray(targetGray, downsample);
    bgGray = downsampleGray(bgGray, downsample);
  }
  const tEdge = canny(targetGray, lowT, highT, sigma);
  const bgEdge = canny(bgGray, lowT, highT, sigma);
  const tEdgeCount = countNonZero(tEdge.data);
  let m;
  let method;
  if (tEdgeCount < minEdgePixels) {
    method = "grayscale-fallback";
    m = matchTemplate(bgGray, targetGray);
  } else {
    method = box ? "edge+alpha" : "edge";
    m = matchTemplate(toFloatEdge(bgEdge), toFloatEdge(tEdge));
  }
  const t1 = now();
  return {
    x: m.x * downsample - cropOffset.x,
    y: m.y * downsample - cropOffset.y,
    score: m.score,
    method,
    targetEdgeCount: tEdgeCount,
    elapsed: t1 - t0,
    downsample
  };
}
function detectGapByColumnEdges(bgImgData, marginX = 0) {
  const gray = toGray(bgImgData);
  const edge = canny(gray);
  const { data, width: w, height: h } = edge;
  const colEnergy = new Float32Array(w);
  for (let x = 0;x < w; x++) {
    let s = 0;
    for (let y = 0;y < h; y++)
      s += data[y * w + x];
    colEnergy[x] = s;
  }
  let bestX = marginX, best = -1;
  for (let x = Math.max(marginX, 2);x < w - 2; x++) {
    if (colEnergy[x] > best) {
      best = colEnergy[x];
      bestX = x;
    }
  }
  return { x: bestX, score: best };
}

// src/core/interaction/trajectory.ts
function humanDragTrajectory(distance, rand = Math.random) {
  const steps = [];
  if (distance <= 0)
    return [{ x: 0, y: 0, dt: 16 }];
  let current = 0;
  let velocity = 0;
  const maxVelocity = 8;
  const accelerationPhase = distance * 0.6;
  while (current < accelerationPhase) {
    velocity = Math.min(velocity + 0.5 + rand() * 0.5, maxVelocity);
    current += velocity;
    steps.push({ x: current, dt: 16 + rand() * 8 });
  }
  while (current < distance - 5) {
    velocity = Math.max(velocity - (0.3 + rand() * 0.4), 1);
    current += velocity;
    steps.push({ x: current, dt: 16 + rand() * 12 });
  }
  current = Math.min(current, distance + 3);
  steps.push({ x: current, dt: 50 + rand() * 30 });
  steps.push({ x: distance - 1, dt: 80 + rand() * 40 });
  steps.push({ x: distance, dt: 60 + rand() * 30 });
  return steps.map((s) => ({
    x: Math.max(0, s.x + (rand() - 0.5) * 2),
    y: (rand() - 0.5) * 3,
    dt: s.dt
  }));
}
function bezierPath(from, to, steps = 25, rand = Math.random) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const offset1 = (rand() - 0.5) * Math.min(60, dist * 0.4);
  const offset2 = (rand() - 0.5) * Math.min(60, dist * 0.4);
  const c1 = {
    x: from.x + dx * 0.3 + nx * offset1,
    y: from.y + dy * 0.3 + ny * offset1
  };
  const c2 = {
    x: from.x + dx * 0.7 + nx * offset2,
    y: from.y + dy * 0.7 + ny * offset2
  };
  const pts = [];
  for (let i = 0;i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x;
    const y = mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y;
    pts.push({ x, y });
  }
  return pts;
}

// src/core/interaction/pointer.ts
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function viewOf(target) {
  const doc = target.ownerDocument || document;
  return doc.defaultView || window;
}
function firePointer(target, type, x, y, extra = {}) {
  if (typeof PointerEvent === "undefined")
    return;
  const ev = new PointerEvent(type, {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    bubbles: true,
    cancelable: true,
    view: viewOf(target),
    ...extra
  });
  target.dispatchEvent(ev);
}
function fireMouse(target, type, x, y, extra = {}) {
  const ev = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === "mouseup" || type === "click" ? 0 : 1,
    bubbles: true,
    cancelable: true,
    view: viewOf(target),
    ...extra
  });
  target.dispatchEvent(ev);
}
function pressDown(handle, x, y) {
  try {
    handle.setPointerCapture?.(1);
  } catch {}
  firePointer(handle, "pointerdown", x, y);
  fireMouse(handle, "mousedown", x, y);
}
function moveTo(handle, x, y) {
  const doc = handle.ownerDocument || document;
  firePointer(handle, "pointermove", x, y);
  fireMouse(handle, "mousemove", x, y);
  firePointer(doc, "pointermove", x, y);
  fireMouse(doc, "mousemove", x, y);
}
function release(handle, x, y) {
  const doc = handle.ownerDocument || document;
  try {
    handle.releasePointerCapture?.(1);
  } catch {}
  firePointer(handle, "pointerup", x, y);
  fireMouse(handle, "mouseup", x, y);
  firePointer(doc, "pointerup", x, y);
  fireMouse(doc, "mouseup", x, y);
}
async function dragAlong(handle, trajectory) {
  const rect = handle.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  pressDown(handle, startX, startY);
  await delay(40 + Math.random() * 60);
  let lastX = startX;
  for (const step of trajectory) {
    await delay(step.dt);
    lastX = startX + step.x;
    moveTo(handle, lastX, startY + step.y);
  }
  await delay(50 + Math.random() * 60);
  release(handle, lastX, startY);
  return lastX;
}
async function moveAndClick(path, rootDoc = document) {
  for (let i = 0;i < path.length; i++) {
    const p = path[i];
    firePointer(rootDoc, "pointermove", p.x, p.y);
    fireMouse(rootDoc, "mousemove", p.x, p.y);
    await delay(8 + Math.random() * 14);
  }
  const last = path[path.length - 1];
  const target = rootDoc.elementFromPoint(last.x, last.y) || rootDoc.body;
  firePointer(target, "pointerdown", last.x, last.y);
  fireMouse(target, "mousedown", last.x, last.y);
  await delay(40 + Math.random() * 80);
  firePointer(target, "pointerup", last.x, last.y);
  fireMouse(target, "mouseup", last.x, last.y);
  fireMouse(target, "click", last.x, last.y);
}

// src/core/interaction/slider-solver.ts
function elementToImageData(el) {
  const w = el.naturalWidth || el.width || 0;
  const h = el.naturalHeight || el.height || 0;
  if (!w || !h)
    return null;
  try {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx)
      return null;
    ctx.drawImage(el, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }
}
async function solveSlider(captcha, opts = {}) {
  const log = opts.onLog || (() => {});
  const minScore = opts.minScore ?? 0.3;
  const fail = (reason, extra = {}) => ({
    success: false,
    gapX: 0,
    distance: 0,
    score: NaN,
    method: "none",
    reason,
    ...extra
  });
  const bgEl = captcha.innerCanvas;
  const handle = captcha.sliderHandle;
  if (!bgEl)
    return fail("no-background");
  if (!handle)
    return fail("no-handle");
  const bg = elementToImageData(bgEl);
  if (!bg) {
    log("背景图不可读（跨域 tainted canvas），无法做缺口检测");
    return fail("tainted-canvas");
  }
  let gapXNative;
  let score;
  let method;
  const piece = captcha.sliderPiece ? elementToImageData(captcha.sliderPiece) : null;
  if (piece) {
    const m = slideMatch(piece, bg);
    gapXNative = m.x;
    score = m.score;
    method = m.method;
    log(`slideMatch: x=${gapXNative}px score=${score.toFixed(3)} method=${method} (${m.elapsed.toFixed(0)}ms)`);
    if (score < minScore)
      return fail("low-confidence", { gapX: gapXNative, score, method });
  } else {
    const m = detectGapByColumnEdges(bg, Math.round(bg.width * 0.1));
    gapXNative = m.x;
    score = NaN;
    method = "column-edge";
    log(`无滑块小图，列边缘兜底: x=${gapXNative}px`);
  }
  const bgRect = bgEl.getBoundingClientRect();
  const nativeW = bgEl.naturalWidth || bgEl.width || bgRect.width;
  const scale = bgRect.width / Math.max(1, nativeW);
  const gapDisplayX = gapXNative * scale;
  let pieceStartOffset = 0;
  if (captcha.sliderPiece) {
    const pr = captcha.sliderPiece.getBoundingClientRect();
    const rawOffset = Math.max(0, pr.left - bgRect.left);
    if (rawOffset < gapDisplayX * 0.5) {
      pieceStartOffset = rawOffset;
    } else {
      log(`忽略可疑的 piece 起始偏移 ${rawOffset.toFixed(1)}px（≥ 缺口 ${gapDisplayX.toFixed(1)}px 的一半，疑似误识别图层）`);
    }
  }
  const distance = Math.max(0, gapDisplayX - pieceStartOffset + (opts.offset ?? 0));
  log(`scale=${scale.toFixed(3)} gapX=${gapDisplayX.toFixed(1)}px pieceStart=${pieceStartOffset.toFixed(1)}px → distance=${distance.toFixed(1)}px`);
  if (distance < 2)
    return fail("distance-too-small", { gapX: gapDisplayX, distance, score, method });
  const traj = humanDragTrajectory(distance);
  log(`拖拽轨迹点数=${traj.length}`);
  const finalX = await dragAlong(handle, traj);
  log(`拖拽完成，终点 clientX=${finalX.toFixed(1)}`);
  return { success: true, gapX: gapDisplayX, distance, score, method };
}

// src/core/image-processor.ts
class ImageProcessor {
  static extractImageFromElement(img) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
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
  static async loadImage(input) {
    if (typeof document === "undefined") {
      return this.loadImageInServiceWorker(input);
    }
    if (input instanceof HTMLImageElement) {
      return this.extractImageFromElement(input);
    }
    const img = new Image;
    img.crossOrigin = "anonymous";
    if (typeof input === "string") {
      img.src = input;
    } else {
      img.src = URL.createObjectURL(input);
    }
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片加载失败"));
      setTimeout(() => reject(new Error("图片加载超时")), 1e4);
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const grayData = this.toGrayscale(imageData.data);
    if (typeof input !== "string") {
      URL.revokeObjectURL(img.src);
    }
    return {
      data: grayData,
      width: img.width,
      height: img.height
    };
  }
  static async loadImageInServiceWorker(input) {
    let blob;
    if (typeof input === "string") {
      if (input.startsWith("data:")) {
        const response = await fetch(input);
        blob = await response.blob();
      } else {
        const response = await fetch(input);
        blob = await response.blob();
      }
    } else if (input instanceof Blob) {
      blob = input;
    } else {
      throw new Error("Service Worker 环境不支持 HTMLImageElement");
    }
    const imageBitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
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
  static toGrayscale(data) {
    const gray = new Uint8ClampedArray(data.length / 4);
    for (let i = 0;i < data.length; i += 4) {
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
  static resize(data, width, height, newWidth, newHeight) {
    const result = new Uint8ClampedArray(newWidth * newHeight);
    const xRatio = width / newWidth;
    const yRatio = height / newHeight;
    for (let y = 0;y < newHeight; y++) {
      for (let x = 0;x < newWidth; x++) {
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
  static normalize(data) {
    const normalized = new Float32Array(data.length);
    for (let i = 0;i < data.length; i++) {
      normalized[i] = data[i] / 255;
    }
    return normalized;
  }
  static normalizeStd(data, mean, std) {
    const out = new Float32Array(data.length);
    const inv = 1 / std;
    for (let i = 0;i < data.length; i++) {
      out[i] = (data[i] / 255 - mean) * inv;
    }
    return out;
  }
  static padOrCropWidth(data, width, height, targetWidth, fillValue) {
    if (width === targetWidth)
      return data;
    const out = new Float32Array(targetWidth * height);
    if (width < targetWidth) {
      out.fill(fillValue);
      for (let y = 0;y < height; y++) {
        const srcOff = y * width;
        const dstOff = y * targetWidth;
        for (let x = 0;x < width; x++) {
          out[dstOff + x] = data[srcOff + x];
        }
      }
    } else {
      for (let y = 0;y < height; y++) {
        const srcOff = y * width;
        const dstOff = y * targetWidth;
        for (let x = 0;x < targetWidth; x++) {
          out[dstOff + x] = data[srcOff + x];
        }
      }
    }
    return out;
  }
}

// src/core/ocr-engine.ts
class OCREngine {
  session = null;
  charsets = [];
  initialized = false;
  ort = null;
  options;
  constructor(options) {
    this.options = options;
  }
  async init() {
    if (this.initialized)
      return;
    console.log("\uD83D\uDD27 初始化 OCR 引擎...");
    if (this.options.getOrt) {
      this.ort = await this.options.getOrt();
    } else {
      this.ort = await this.waitForOrt();
    }
    if (!this.ort) {
      throw new Error("ONNX Runtime 未找到");
    }
    if (this.options.wasmPaths) {
      this.ort.env.wasm.wasmPaths = this.options.wasmPaths;
    }
    this.ort.env.wasm.numThreads = 4;
    this.ort.env.wasm.simd = true;
    this.ort.env.logLevel = "error";
    console.log("\uD83D\uDCE5 加载模型...");
    const { model, charsets } = await this.options.getModel();
    this.charsets = charsets;
    console.log("\uD83D\uDE80 创建推理会话...");
    this.session = await this.ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    this.initialized = true;
    console.log("✅ OCR 引擎已就绪");
  }
  async waitForOrt() {
    const getOrtInstance = () => {
      if (typeof ort !== "undefined")
        return ort;
      if (typeof window !== "undefined" && window.ort)
        return window.ort;
      if (typeof globalThis !== "undefined" && globalThis.ort)
        return globalThis.ort;
      try {
        if (typeof unsafeWindow !== "undefined" && unsafeWindow.ort)
          return unsafeWindow.ort;
      } catch (e) {}
      return null;
    };
    let ortInstance = getOrtInstance();
    if (ortInstance) {
      console.log("✅ ort 已存在");
      return ortInstance;
    }
    console.log("⏳ 等待 ort 加载...");
    for (let i = 0;i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ortInstance = getOrtInstance();
      if (ortInstance) {
        console.log("✅ ort 已就绪");
        return ortInstance;
      }
    }
    throw new Error("等待 ort 超时");
  }
  async recognize(input) {
    if (!this.initialized || !this.session) {
      await this.init();
    }
    const startTime = Date.now();
    const { data, width, height } = await ImageProcessor.loadImage(input);
    const targetHeight = 64;
    let targetWidth = Math.floor(width * (targetHeight / height));
    if (targetWidth < 1)
      targetWidth = 1;
    const resized = ImageProcessor.resize(data, width, height, targetWidth, targetHeight);
    const style = this.options.preprocess ?? "simple";
    let normalized;
    let fillValue = 1;
    if (style === "standardize") {
      const mean = this.options.preprocessMean ?? 0.456;
      const std = this.options.preprocessStd ?? 0.224;
      normalized = ImageProcessor.normalizeStd(resized, mean, std);
      fillValue = (1 - mean) / std;
    } else {
      normalized = ImageProcessor.normalize(resized);
      fillValue = 1;
    }
    let finalWidth = targetWidth;
    if (this.options.fixedWidth) {
      normalized = ImageProcessor.padOrCropWidth(normalized, targetWidth, targetHeight, this.options.fixedWidth, fillValue);
      finalWidth = this.options.fixedWidth;
    }
    const tensor = new this.ort.Tensor("float32", normalized, [1, 1, targetHeight, finalWidth]);
    const feeds = { input1: tensor };
    const results = await this.session.run(feeds);
    const output = results.output;
    const text = this.decodeOutput(output);
    console.log(`识别完成: ${text} (耗时: ${Date.now() - startTime}ms)`);
    return { text };
  }
  getCharsets() {
    return this.charsets;
  }
  decodeOutput(output) {
    const indices = this.convertToNumberArray(output.data);
    const result = [];
    let prevIdx = -1;
    for (const idx of indices) {
      if (idx === prevIdx) {
        continue;
      }
      prevIdx = idx;
      if (idx <= 0 || idx >= this.charsets.length) {
        continue;
      }
      const char = this.charsets[idx];
      if (!char) {
        continue;
      }
      result.push(char);
    }
    return result.join("");
  }
  convertToNumberArray(data) {
    const result = [];
    for (let i = 0;i < data.length; i++) {
      const value = data[i];
      if (typeof value === "bigint") {
        result.push(Number(value));
      } else if (typeof value === "number") {
        result.push(Math.round(value));
      } else {
        result.push(0);
      }
    }
    return result;
  }
  async destroy() {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.initialized = false;
  }
}

// src/core/detection-engine.ts
class DetectionEngine {
  session = null;
  ort = null;
  initialized = false;
  options;
  inputSize;
  scoreThreshold;
  nmsIou;
  grid = null;
  constructor(options) {
    this.options = options;
    this.inputSize = options.inputSize ?? 416;
    this.scoreThreshold = options.scoreThreshold ?? 0.1;
    this.nmsIou = options.nmsIou ?? 0.45;
  }
  async init() {
    if (this.initialized)
      return;
    console.log("\uD83D\uDD27 初始化目标检测引擎...");
    this.ort = this.options.getOrt ? await this.options.getOrt() : await this.waitForOrt();
    if (!this.ort)
      throw new Error("ONNX Runtime 未找到");
    if (this.options.wasmPaths) {
      this.ort.env.wasm.wasmPaths = this.options.wasmPaths;
    }
    if (this.options.numThreads != null) {
      this.ort.env.wasm.numThreads = this.options.numThreads;
    }
    this.ort.env.wasm.simd = true;
    this.ort.env.logLevel = "error";
    const { model } = await this.options.getModel();
    console.log("\uD83D\uDE80 创建检测推理会话...");
    this.session = await this.ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    this.initialized = true;
    console.log("✅ 目标检测引擎已就绪");
  }
  isReady() {
    return this.initialized && !!this.session;
  }
  async waitForOrt() {
    const getOrtInstance = () => {
      if (typeof ort !== "undefined")
        return ort;
      if (typeof window !== "undefined" && window.ort)
        return window.ort;
      if (typeof globalThis !== "undefined" && globalThis.ort)
        return globalThis.ort;
      try {
        if (typeof unsafeWindow !== "undefined" && unsafeWindow.ort)
          return unsafeWindow.ort;
      } catch (e) {}
      return null;
    };
    let instance = getOrtInstance();
    if (instance)
      return instance;
    for (let i = 0;i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      instance = getOrtInstance();
      if (instance)
        return instance;
    }
    throw new Error("等待 ort 超时");
  }
  async detect(image) {
    if (!this.initialized || !this.session) {
      await this.init();
    }
    const S = this.inputSize;
    const { data, width: srcW, height: srcH } = image;
    const r = Math.min(S / srcH, S / srcW);
    const newW = Math.max(1, Math.round(srcW * r));
    const newH = Math.max(1, Math.round(srcH * r));
    const plane = S * S;
    const chw = new Float32Array(3 * plane);
    chw.fill(114);
    const planeB = 0;
    const planeG = plane;
    const planeR = 2 * plane;
    const xRatio = srcW / newW;
    const yRatio = srcH / newH;
    for (let y = 0;y < newH; y++) {
      const py = y * yRatio;
      const y1 = Math.floor(py);
      const y2 = Math.min(y1 + 1, srcH - 1);
      const fy = py - y1;
      for (let x = 0;x < newW; x++) {
        const px = x * xRatio;
        const x1 = Math.floor(px);
        const x2 = Math.min(x1 + 1, srcW - 1);
        const fx = px - x1;
        const wa = (1 - fx) * (1 - fy);
        const wb = fx * (1 - fy);
        const wc = (1 - fx) * fy;
        const wd = fx * fy;
        const i11 = (y1 * srcW + x1) * 4;
        const i12 = (y1 * srcW + x2) * 4;
        const i21 = (y2 * srcW + x1) * 4;
        const i22 = (y2 * srcW + x2) * 4;
        const R = data[i11] * wa + data[i12] * wb + data[i21] * wc + data[i22] * wd;
        const G = data[i11 + 1] * wa + data[i12 + 1] * wb + data[i21 + 1] * wc + data[i22 + 1] * wd;
        const B = data[i11 + 2] * wa + data[i12 + 2] * wb + data[i21 + 2] * wc + data[i22 + 2] * wd;
        const off = y * S + x;
        chw[planeB + off] = B;
        chw[planeG + off] = G;
        chw[planeR + off] = R;
      }
    }
    const inputName = this.session.inputNames?.[0] ?? "images";
    const tensor = new this.ort.Tensor("float32", chw, [1, 3, S, S]);
    const results = await this.session.run({ [inputName]: tensor });
    const outName = this.session.outputNames?.[0] ?? Object.keys(results)[0];
    const out = results[outName];
    return this.decode(out, r, srcW, srcH);
  }
  decode(output, ratio, srcW, srcH) {
    const dims = output.dims || output.shape;
    const numAnchors = dims[1];
    const step = dims[2];
    const data = output.data;
    const grid = this.getGrid(numAnchors);
    const boxes = [];
    for (let a = 0;a < numAnchors; a++) {
      const off = a * step;
      const obj = data[off + 4];
      let cls = 1;
      const numClasses = step - 5;
      if (numClasses >= 1) {
        cls = data[off + 5];
        for (let c = 1;c < numClasses; c++) {
          const v = data[off + 5 + c];
          if (v > cls)
            cls = v;
        }
      }
      const score = obj * cls;
      if (score < this.scoreThreshold)
        continue;
      const cell = grid[a];
      const cx = (data[off] + cell.gx) * cell.stride;
      const cy = (data[off + 1] + cell.gy) * cell.stride;
      const bw = Math.exp(data[off + 2]) * cell.stride;
      const bh = Math.exp(data[off + 3]) * cell.stride;
      let x1 = (cx - bw / 2) / ratio;
      let y1 = (cy - bh / 2) / ratio;
      let x2 = (cx + bw / 2) / ratio;
      let y2 = (cy + bh / 2) / ratio;
      x1 = Math.max(0, Math.min(x1, srcW));
      y1 = Math.max(0, Math.min(y1, srcH));
      x2 = Math.max(0, Math.min(x2, srcW));
      y2 = Math.max(0, Math.min(y2, srcH));
      if (x2 <= x1 || y2 <= y1)
        continue;
      boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, conf: score });
    }
    return this.nms(boxes);
  }
  getGrid(expectedAnchors) {
    if (this.grid && this.grid.length === expectedAnchors)
      return this.grid;
    const S = this.inputSize;
    const strides = [8, 16, 32];
    const grid = [];
    for (const stride of strides) {
      const hsize = Math.floor(S / stride);
      const wsize = Math.floor(S / stride);
      for (let gy = 0;gy < hsize; gy++) {
        for (let gx = 0;gx < wsize; gx++) {
          grid.push({ gx, gy, stride });
        }
      }
    }
    this.grid = grid;
    return grid;
  }
  nms(boxes) {
    boxes.sort((a, b) => b.conf - a.conf);
    const keep = [];
    const suppressed = new Array(boxes.length).fill(false);
    for (let i = 0;i < boxes.length; i++) {
      if (suppressed[i])
        continue;
      const a = boxes[i];
      keep.push(a);
      for (let j = i + 1;j < boxes.length; j++) {
        if (suppressed[j])
          continue;
        if (this.iou(a, boxes[j]) > this.nmsIou)
          suppressed[j] = true;
      }
    }
    return keep;
  }
  iou(a, b) {
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;
    const bx2 = b.x + b.w;
    const by2 = b.y + b.h;
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const union = a.w * a.h + b.w * b.h - inter;
    return union <= 0 ? 0 : inter / union;
  }
  async destroy() {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.initialized = false;
  }
}

// src/core/interaction/click-select-solver.ts
function makeCanvas(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx)
    throw new Error("无法创建 2d 上下文");
  return { canvas, ctx };
}
function cropToDataURL(image, box) {
  const sx = Math.round(box.x);
  const sy = Math.round(box.y);
  const sw = Math.max(1, Math.round(box.w));
  const sh = Math.max(1, Math.round(box.h));
  const full = makeCanvas(image.width, image.height);
  full.ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const pad = Math.max(2, Math.round(Math.min(sw, sh) * 0.15));
  const cw = sw + pad * 2;
  const ch = sh + pad * 2;
  const crop = makeCanvas(cw, ch);
  crop.ctx.fillStyle = "#ffffff";
  crop.ctx.fillRect(0, 0, cw, ch);
  crop.ctx.drawImage(full.canvas, sx - pad, sy - pad, cw, ch, 0, 0, cw, ch);
  return crop.canvas.toDataURL();
}
async function labelBoxesWithEngines(image, det, ocr) {
  const boxes = await det.detect(image);
  const out = [];
  for (const b of boxes) {
    let char = "";
    try {
      const r = await ocr.recognize(cropToDataURL(image, b));
      char = (r.text || "").trim();
    } catch {
      char = "";
    }
    out.push({ ...b, char });
  }
  return out;
}
function splitChars(text) {
  return Array.from(text || "").map((c) => c.trim()).filter((c) => c && !/[，。、,.\s:：;；!！?？·…—\-_/\\|()（）[\]【】]/.test(c));
}
var PROMPT_INSTRUCTION_PHRASES = [
  "从上到下",
  "从左到右",
  "从右到左",
  "从下到上",
  "请依次",
  "依次",
  "请按照",
  "请按",
  "按照",
  "按顺序",
  "顺序",
  "先后顺序",
  "先后",
  "请点击",
  "请选择",
  "请在",
  "点击下列",
  "点击下面",
  "点击图中",
  "点击图片中",
  "点击",
  "点选",
  "选择",
  "选中",
  "下列",
  "下面",
  "图中",
  "图片中",
  "其中",
  "完成验证",
  "验证码",
  "验证",
  "提示",
  "目标",
  "汉字",
  "文字",
  "中文",
  "词语",
  "正确",
  "识别",
  "所示",
  "如图",
  "图形",
  "这些",
  "上方",
  "下方",
  "请"
];
function stripInstructionWords(text) {
  let out = text;
  for (const w of PROMPT_INSTRUCTION_PHRASES) {
    out = out.split(w).join("");
  }
  return out;
}
function charMatch(boxChar, target) {
  if (!boxChar)
    return false;
  if (boxChar === target)
    return true;
  if (target.length === 1 && boxChar.includes(target))
    return true;
  return false;
}
function readPromptOrderFromDom(captcha) {
  const container = captcha.element;
  const candidates = [];
  const scan = (el, depth) => {
    if (!el || depth < 0)
      return;
    const text = (el.textContent || "").trim();
    if (text && text.length <= 40)
      candidates.push(text);
  };
  scan(container, 1);
  scan(container.previousElementSibling, 0);
  scan(container.parentElement, 0);
  const extractTargets = (text) => {
    const quoted = text.match(/[「『"'""']([^「』"'""']{1,12})[」』"'""']/);
    if (quoted && quoted[1]) {
      const chars = splitChars(stripInstructionWords(quoted[1]));
      if (chars.length >= 1)
        return chars;
    }
    const afterColon = text.match(/[：:]\s*(.+)$/);
    if (afterColon && afterColon[1]) {
      const chars = splitChars(stripInstructionWords(afterColon[1]));
      if (chars.length >= 1)
        return chars;
    }
    const stripped = splitChars(stripInstructionWords(text));
    if (stripped.length >= 1)
      return stripped;
    return null;
  };
  for (const text of candidates) {
    if (!/(依次|顺序|点击|点选|选择|选中)/.test(text))
      continue;
    const targets = extractTargets(text);
    if (targets && targets.length >= 1)
      return targets;
  }
  return null;
}
async function solveClickSelect(captcha, opts) {
  const log = opts.onLog || (() => {});
  const imgEl = captcha.innerCanvas;
  if (!imgEl)
    return { success: false, reason: "no-image" };
  const image = elementToImageData(imgEl);
  if (!image) {
    log("点选主图不可读（跨域 tainted canvas）");
    return { success: false, reason: "tainted-canvas" };
  }
  let order = opts.promptOrder && opts.promptOrder.length ? opts.promptOrder : undefined;
  if (!order) {
    const fromDom = readPromptOrderFromDom(captcha);
    if (fromDom) {
      order = fromDom;
      log(`从 DOM 读到题序: ${order.join("")}`);
    }
  }
  if (!order && opts.recognizePromptImage && opts.promptImage) {
    const txt = await opts.recognizePromptImage(opts.promptImage);
    order = splitChars(txt);
    log(`OCR 题图得到题序: ${order.join("")}`);
  }
  if (!order || order.length === 0)
    return { success: false, reason: "no-prompt-order" };
  const labeled = await opts.labelBoxes(image);
  const detected = labeled.map((b) => b.char || "?").join("");
  log(`检测到 ${labeled.length} 个候选框: ${detected}`);
  if (labeled.length === 0)
    return { success: false, reason: "no-boxes", detected };
  const used = new Set;
  const chosen = [];
  for (const target of order) {
    let bestIdx = -1;
    let bestConf = -1;
    for (let i = 0;i < labeled.length; i++) {
      if (used.has(i))
        continue;
      if (charMatch(labeled[i].char, target) && labeled[i].conf > bestConf) {
        bestIdx = i;
        bestConf = labeled[i].conf;
      }
    }
    if (bestIdx < 0) {
      log(`题面字符「${target}」未在候选框中找到`);
      return { success: false, reason: `unmatched:${target}`, detected };
    }
    used.add(bestIdx);
    chosen.push(labeled[bestIdx]);
  }
  const rect = imgEl.getBoundingClientRect();
  const scaleX = rect.width / image.width;
  const scaleY = rect.height / image.height;
  const rootDoc = imgEl.ownerDocument || document;
  const [gapMin, gapMax] = opts.clickGap ?? [180, 360];
  const clicks = [];
  let from = { x: rect.left - 30, y: rect.top - 30 };
  for (const b of chosen) {
    const cx = rect.left + (b.x + b.w / 2) * scaleX;
    const cy = rect.top + (b.y + b.h / 2) * scaleY;
    const path = bezierPath(from, { x: cx, y: cy }, 22 + Math.floor(Math.random() * 10));
    await moveAndClick(path, rootDoc);
    clicks.push({ x: cx, y: cy, char: b.char });
    log(`点击「${b.char}」@ (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
    from = { x: cx, y: cy };
    await delay(gapMin + Math.random() * (gapMax - gapMin));
  }
  return { success: true, clicks, detected };
}

// src/core/interaction/cloudflare.ts
var CF_IFRAME_SELECTOR = 'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]';
var CF_CONTAINER_SELECTOR = ".cf-turnstile, #cf-turnstile, [data-sitekey]";
function isCloudflareFrame() {
  try {
    return /(^|\.)challenges\.cloudflare\.com$/.test(location.hostname);
  } catch {
    return false;
  }
}
function detectTurnstile(root = document) {
  const out = [];
  const seen = new Set;
  root.querySelectorAll(CF_CONTAINER_SELECTOR).forEach((el) => {
    if (seen.has(el))
      return;
    seen.add(el);
    const he = el;
    out.push({
      kind: "container",
      element: he,
      sitekey: he.getAttribute("data-sitekey") || undefined,
      rect: he.getBoundingClientRect()
    });
  });
  root.querySelectorAll(CF_IFRAME_SELECTOR).forEach((el) => {
    if (seen.has(el))
      return;
    seen.add(el);
    const he = el;
    out.push({ kind: "iframe", element: he, rect: he.getBoundingClientRect() });
  });
  return out;
}
function findCheckboxInFrame() {
  const candidates = [
    'input[type="checkbox"]',
    '[role="checkbox"]',
    "label",
    ".cb-c",
    ".ctp-checkbox-label",
    "#challenge-stage"
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.getBoundingClientRect().width > 0)
      return el;
  }
  return null;
}
function highlightForManual(el, ms) {
  try {
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  } catch {}
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = "3px solid #f48120";
  el.style.outlineOffset = "2px";
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOffset;
  }, ms);
}
async function assistCloudflare(opts = {}) {
  const log = opts.onLog || (() => {});
  const highlightMs = opts.highlightMs ?? 2600;
  if (isCloudflareFrame()) {
    const box = findCheckboxInFrame();
    if (!box) {
      log("CF iframe 内未找到复选框（可能尚未渲染或结构变化）");
      return { success: false, mode: "iframe-click", reason: "no-checkbox" };
    }
    const rect = box.getBoundingClientRect();
    const target = {
      x: rect.left + rect.width / 2 + (Math.random() - 0.5) * 6,
      y: rect.top + rect.height / 2 + (Math.random() - 0.5) * 6
    };
    const from = { x: target.x - 80 - Math.random() * 60, y: target.y + 60 + Math.random() * 50 };
    log("在 CF iframe 内生成自然轨迹并尝试点击（isTrusted=false，CF 很可能拒绝）");
    const path = bezierPath(from, target, 28 + Math.floor(Math.random() * 12));
    await moveAndClick(path, document);
    await delay(120);
    const checked = box.checked === true || box.getAttribute("aria-checked") === "true";
    log(`点击已派发。复选框状态启发式：${checked ? "看似已勾选" : "未变化"}（CF 最终判定在服务端，客户端无从得知）`);
    return { success: true, mode: "iframe-click", checkboxToggledHint: checked };
  }
  const widgets = detectTurnstile();
  if (widgets.length === 0) {
    return { success: false, mode: "none", reason: "no-widget", widgets: 0 };
  }
  log(`顶层 frame 识别到 ${widgets.length} 个 Turnstile 部件；跨域 iframe 无法直接操作，滚动+高亮提示用户亲自点击`);
  for (const w of widgets) {
    highlightForManual(w.element, highlightMs);
  }
  return { success: true, mode: "assist-manual", widgets: widgets.length };
}

// test/playground/playground.ts
function $(id) {
  return document.getElementById(id);
}
function logTo(boxId, msg, cls = "") {
  const box = $(boxId);
  const span = document.createElement("span");
  if (cls)
    span.className = cls;
  span.textContent = msg + `
`;
  box.appendChild(span);
  box.scrollTop = box.scrollHeight;
}
function setMetrics(boxId, items) {
  $(boxId).innerHTML = items.map((i) => `<div class="metric"><div class="v">${i.v}</div><div class="k">${i.k}</div></div>`).join("");
}
var BG_W = 320;
var BG_H = 160;
var TPL = 60;
function puzzlePath(ctx, w, h) {
  const r = w * 0.18;
  const cx = w / 2, cy = h / 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(cx - r, 0);
  ctx.arc(cx, 0, r, Math.PI, 0, true);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, cy - r);
  ctx.arc(w, cy, r, Math.PI * 1.5, Math.PI * 0.5, true);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
}
function renderPuzzle() {
  const gapX = 90 + Math.floor(Math.random() * (BG_W - TPL - 110));
  const gapY = Math.floor((BG_H - TPL) / 2 + (Math.random() - 0.5) * 30);
  const bg = $("gtBg");
  bg.width = BG_W;
  bg.height = BG_H;
  const bctx = bg.getContext("2d");
  const grad = bctx.createLinearGradient(0, 0, BG_W, BG_H);
  grad.addColorStop(0, "#43cea2");
  grad.addColorStop(1, "#185a9d");
  bctx.fillStyle = grad;
  bctx.fillRect(0, 0, BG_W, BG_H);
  for (let i = 0;i < 80; i++) {
    bctx.fillStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.25})`;
    bctx.beginPath();
    bctx.arc(Math.random() * BG_W, Math.random() * BG_H, 3 + Math.random() * 16, 0, Math.PI * 2);
    bctx.fill();
  }
  for (let i = 0;i < 6; i++) {
    bctx.strokeStyle = `rgba(0,0,0,${0.1 + Math.random() * 0.2})`;
    bctx.lineWidth = 1;
    bctx.beginPath();
    bctx.moveTo(Math.random() * BG_W, 0);
    bctx.lineTo(Math.random() * BG_W, BG_H);
    bctx.stroke();
  }
  const slice = $("gtSlice");
  slice.width = TPL;
  slice.height = BG_H;
  const sctx = slice.getContext("2d");
  sctx.clearRect(0, 0, TPL, BG_H);
  sctx.save();
  sctx.translate(0, gapY);
  puzzlePath(sctx, TPL, TPL);
  sctx.clip();
  sctx.drawImage(bg, gapX, gapY, TPL, TPL, 0, 0, TPL, TPL);
  sctx.restore();
  bctx.save();
  bctx.translate(gapX, gapY);
  puzzlePath(bctx, TPL, TPL);
  bctx.fillStyle = "rgba(0,0,0,0.5)";
  bctx.fill();
  bctx.strokeStyle = "rgba(0,0,0,0.85)";
  bctx.lineWidth = 2;
  bctx.stroke();
  bctx.restore();
  slice.style.left = "0px";
  $("gtBtn").style.left = "0px";
  $("gtFill").style.width = "0px";
  truth = { gapX, gapY };
  return truth;
}
var truth = { gapX: 0, gapY: 0 };
function installSliderBehavior() {
  const btn = $("gtBtn");
  const slice = $("gtSlice");
  const fill = $("gtFill");
  const track = btn.parentElement;
  const maxX = track.clientWidth - btn.offsetWidth;
  let dragging = false;
  let startX = 0;
  let curLeft = 0;
  const onDown = (clientX) => {
    dragging = true;
    startX = clientX - curLeft;
    btn.classList.add("active");
  };
  const onMove = (clientX) => {
    if (!dragging)
      return;
    curLeft = Math.max(0, Math.min(maxX, clientX - startX));
    btn.style.left = curLeft + "px";
    fill.style.width = curLeft + "px";
    slice.style.left = curLeft + "px";
  };
  const onUp = () => {
    if (!dragging)
      return;
    dragging = false;
    btn.classList.remove("active");
    const err = Math.abs(curLeft - truth.gapX);
    const ok = err <= 6;
    logTo("sliderLog", `释放：滑块落点=${curLeft.toFixed(1)}px 缺口真值=${truth.gapX}px 误差=${err.toFixed(1)}px → ${ok ? "✓ 通过" : "✗ 失败"}`, ok ? "ok" : "err");
  };
  btn.addEventListener("pointerdown", (e) => onDown(e.clientX));
  btn.addEventListener("mousedown", (e) => onDown(e.clientX));
  document.addEventListener("pointermove", (e) => onMove(e.clientX));
  document.addEventListener("mousemove", (e) => onMove(e.clientX));
  document.addEventListener("pointerup", onUp);
  document.addEventListener("mouseup", onUp);
}
var detector = new CaptchaDetector;
function doDetect() {
  const captchas = detector.scan();
  logTo("sliderLog", `--- 检测 ---`, "dim");
  logTo("sliderLog", `CaptchaDetector.scan() 返回 ${captchas.length} 个候选`);
  const slider = captchas.find((c) => c.subType === "slider");
  if (!slider) {
    logTo("sliderLog", "未识别出 slider 子类型（检查 SLIDER_KEYWORDS 是否命中 geetest_slider）", "warn");
    return;
  }
  logTo("sliderLog", `命中 slider：id=${slider.id} confidence=${slider.confidence}`, "ok");
  logTo("sliderLog", `  背景图: ${slider.innerCanvas?.tagName.toLowerCase()} ${slider.innerCanvas?.width}×${slider.innerCanvas?.height}`);
  logTo("sliderLog", `  滑块小图: ${slider.sliderPiece ? `${slider.sliderPiece.width}×${slider.sliderPiece.height}` : "未找到"}`, slider.sliderPiece ? "" : "warn");
  logTo("sliderLog", `  拖拽手柄: ${slider.sliderHandle ? slider.sliderHandle.className || slider.sliderHandle.tagName : "未找到"}`, slider.sliderHandle ? "" : "warn");
}
async function doSolve() {
  renderPuzzle();
  await new Promise((r) => setTimeout(r, 100));
  const captchas = detector.scan();
  const slider = captchas.find((c) => c.subType === "slider");
  if (!slider) {
    logTo("sliderLog", "未检测到 slider，无法求解", "err");
    return;
  }
  logTo("sliderLog", `--- 自动求解 (真值缺口 x=${truth.gapX}px) ---`, "dim");
  const res = await solveSlider(slider, { onLog: (m) => logTo("sliderLog", "  " + m, "dim") });
  if (res.success) {
    const err = Math.abs(res.gapX - truth.gapX);
    logTo("sliderLog", `求解完成：检测缺口=${res.gapX.toFixed(1)}px 真值=${truth.gapX}px 误差=${err.toFixed(1)}px score=${res.score.toFixed(3)}`, err <= 8 ? "ok" : "warn");
  } else {
    logTo("sliderLog", `求解未执行：${res.reason}`, "err");
  }
}
function doSelftest(n = 30) {
  logTo("sliderLog", `--- 自测 ${n} 次（缺口检测准确率）---`, "dim");
  let okCount = 0;
  let totalErr = 0;
  let totalMs = 0;
  for (let i = 0;i < n; i++) {
    const t = renderPuzzle();
    const bg = elementToImageData($("gtBg"));
    const piece = elementToImageData($("gtSlice"));
    if (!bg || !piece) {
      logTo("sliderLog", "画布不可读，跳过", "err");
      continue;
    }
    const m = slideMatch(piece, bg);
    const err = Math.abs(m.x - t.gapX);
    totalErr += err;
    totalMs += m.elapsed;
    if (err <= 6)
      okCount++;
  }
  const acc = (okCount / n * 100).toFixed(1);
  setMetrics("sliderMetrics", [
    { k: "成功率 (误差≤6px)", v: acc + "%" },
    { k: "平均误差", v: (totalErr / n).toFixed(1) + "px" },
    { k: "平均耗时", v: (totalMs / n).toFixed(0) + "ms" },
    { k: "样本数", v: String(n) }
  ]);
  logTo("sliderLog", `自测完成：成功率 ${acc}%，平均误差 ${(totalErr / n).toFixed(1)}px，平均 ${(totalMs / n).toFixed(0)}ms`, okCount === n ? "ok" : "warn");
  renderPuzzle();
}
var CS_POOL = "天地人和山水风云日月星辰花鸟鱼虫春夏秋冬东南西北中上下左右大小多少";
var CS_K = 6;
var CS_PICK = 3;
var csTruth = [];
var csOrder = [];
var ocrEngine = null;
var detEngine = null;
async function getEngines() {
  const ort2 = window.ort;
  if (!ort2)
    throw new Error("window.ort 未加载（检查 ort.min.js 是否成功引入）");
  ort2.env.wasm.numThreads = 1;
  ort2.env.wasm.simd = true;
  ort2.env.logLevel = "error";
  const WASM = "/node_modules/onnxruntime-web/dist/";
  if (!ocrEngine) {
    logTo("csLog", "初始化 OCR 引擎 (common.onnx)…", "dim");
    ocrEngine = new OCREngine({
      getModel: async () => ({
        model: await (await fetch("/public/common.onnx")).arrayBuffer(),
        charsets: await (await fetch("/public/charsets.json")).json()
      }),
      getOrt: async () => ort2,
      wasmPaths: WASM
    });
    await ocrEngine.init();
  }
  if (!detEngine) {
    logTo("csLog", "初始化检测引擎 (common_det.onnx)…", "dim");
    detEngine = new DetectionEngine({
      getModel: async () => ({ model: await (await fetch("/public/common_det.onnx")).arrayBuffer() }),
      getOrt: async () => ort2,
      wasmPaths: WASM,
      numThreads: 1
    });
    await detEngine.init();
  }
  return { ocr: ocrEngine, det: detEngine };
}
function clearMarkers() {
  $("csWrap").querySelectorAll(".cs-marker").forEach((m) => m.remove());
}
function drawMarker(x, y, label, ok) {
  const d = document.createElement("div");
  d.className = "cs-marker";
  d.textContent = label;
  d.style.left = x + "px";
  d.style.top = y + "px";
  if (!ok)
    d.style.background = "rgba(245,158,11,.9)";
  $("csWrap").appendChild(d);
}
function renderClickSelect() {
  const canvas = $("csCanvas");
  const { width: W, height: H } = canvas;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#eef3f8");
  grad.addColorStop(1, "#dde6f0");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0;i < 60; i++) {
    ctx.fillStyle = `rgba(120,140,170,${0.04 + Math.random() * 0.1})`;
    ctx.beginPath();
    ctx.arc(Math.random() * W, Math.random() * H, 4 + Math.random() * 14, 0, Math.PI * 2);
    ctx.fill();
  }
  const pool = Array.from(CS_POOL);
  const chosen = [];
  while (chosen.length < CS_K) {
    const c = pool[Math.floor(Math.random() * pool.length)];
    if (!chosen.includes(c))
      chosen.push(c);
  }
  const cols = 3, rows = 2, cellW = W / cols, cellH = H / rows, font = 38;
  csTruth = [];
  chosen.forEach((ch, idx) => {
    const col = idx % cols, row = Math.floor(idx / cols);
    const cx = cellW * col + cellW / 2 + (Math.random() - 0.5) * cellW * 0.4;
    const cy = cellH * row + cellH / 2 + (Math.random() - 0.5) * cellH * 0.4;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((Math.random() - 0.5) * 0.4);
    ctx.font = `bold ${font}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `hsl(${Math.floor(Math.random() * 360)},70%,26%)`;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    csTruth.push({ char: ch, cx, cy, r: font * 0.7 });
  });
  const shuffled = chosen.slice().sort(() => Math.random() - 0.5);
  csOrder = shuffled.slice(0, CS_PICK);
  $("csPrompt").textContent = csOrder.join(" ");
  clearMarkers();
}
function doDetectCS() {
  const captchas = detector.scan();
  logTo("csLog", "--- 检测 ---", "dim");
  const cs = captchas.find((c) => c.subType === "click-select");
  if (!cs) {
    logTo("csLog", "未识别出 click-select（检查 point-captcha 是否命中 CLICK_SELECT_KEYWORDS）", "warn");
    return;
  }
  logTo("csLog", `命中 click-select：id=${cs.id} confidence=${cs.confidence}`, "ok");
  const ic = cs.innerCanvas;
  logTo("csLog", `  主图: ${ic?.tagName.toLowerCase()} ${ic?.width}×${ic?.height}`);
  logTo("csLog", `  题面顺序(truth): ${csOrder.join(" ")}`);
}
async function doSolveCS() {
  clearMarkers();
  const total = csOrder.length;
  const captchas = detector.scan();
  const cs = captchas.find((c) => c.subType === "click-select");
  if (!cs) {
    logTo("csLog", "未检测到 click-select，无法求解", "err");
    return { ok: false, correct: 0, total, reason: "no-detect" };
  }
  let engines;
  try {
    engines = await getEngines();
  } catch (e) {
    logTo("csLog", "引擎初始化失败: " + e.message, "err");
    return { ok: false, correct: 0, total, reason: "engine-init" };
  }
  const canvas = $("csCanvas");
  const clicks = [];
  const onClick = (e) => {
    const r = canvas.getBoundingClientRect();
    clicks.push({ x: e.clientX - r.left, y: e.clientY - r.top });
  };
  canvas.addEventListener("click", onClick);
  logTo("csLog", `--- 自动求解 (题面 ${csOrder.join(" ")}) ---`, "dim");
  const res = await solveClickSelect(cs, {
    promptOrder: csOrder.slice(),
    labelBoxes: (img) => labelBoxesWithEngines(img, engines.det, engines.ocr),
    clickGap: [120, 220],
    onLog: (m) => logTo("csLog", "  " + m, "dim")
  });
  canvas.removeEventListener("click", onClick);
  if (!res.success) {
    logTo("csLog", `求解未成功：${res.reason}（检测标注串：${res.detected ?? "—"}）`, "warn");
    return { ok: false, correct: 0, total, reason: res.reason };
  }
  let correct = 0;
  csOrder.forEach((expected, i) => {
    const c = clicks[i];
    if (!c)
      return;
    const hit = csTruth.find((t) => Math.abs(c.x - t.cx) <= t.r && Math.abs(c.y - t.cy) <= t.r);
    const good = !!hit && hit.char === expected;
    if (good)
      correct++;
    drawMarker(c.x, c.y, String(i + 1), good);
    logTo("csLog", `  第${i + 1}击 期望「${expected}」落点(${c.x.toFixed(0)},${c.y.toFixed(0)}) → 命中「${hit?.char ?? "空白"}」 ${good ? "✓" : "✗"}`, good ? "ok" : "err");
  });
  const ok = correct === total && clicks.length === total;
  logTo("csLog", `端到端：点击 ${clicks.length}/${total}，命中正确 ${correct}/${total} → ${ok ? "✓ 通过" : "✗ 失败"}`, ok ? "ok" : "err");
  return { ok, correct, total };
}
async function doSelftestCS(n = 10) {
  logTo("csLog", `--- 自测 ${n} 次（端到端通过率）---`, "dim");
  let pass = 0, totalCorrect = 0, totalChars = 0;
  const t0 = Date.now();
  for (let i = 0;i < n; i++) {
    renderClickSelect();
    await new Promise((r2) => setTimeout(r2, 50));
    const r = await doSolveCS();
    if (r.ok)
      pass++;
    totalCorrect += r.correct;
    totalChars += r.total;
  }
  const ms = Date.now() - t0;
  setMetrics("csMetrics", [
    { k: "端到端通过率", v: (pass / n * 100).toFixed(0) + "%" },
    { k: "单字命中率", v: (totalChars ? totalCorrect / totalChars * 100 : 0).toFixed(0) + "%" },
    { k: "平均耗时", v: (ms / n).toFixed(0) + "ms" },
    { k: "样本数", v: String(n) }
  ]);
  logTo("csLog", `自测完成：通过 ${pass}/${n}，单字命中 ${totalCorrect}/${totalChars}`, pass === n ? "ok" : "warn");
  renderClickSelect();
}
function doDetectCF() {
  const widgets = detectTurnstile();
  logTo("cfLog", "--- 检测 Turnstile ---", "dim");
  logTo("cfLog", `detectTurnstile() 命中 ${widgets.length} 个部件`, widgets.length ? "ok" : "warn");
  widgets.forEach((w, i) => {
    logTo("cfLog", `  ${i + 1}. kind=${w.kind}${w.sitekey ? ` sitekey=${w.sitekey}` : ""} ${Math.round(w.rect.width)}×${Math.round(w.rect.height)}`);
  });
  const iframe = widgets.find((w) => w.kind === "iframe");
  if (iframe) {
    let canReach = false;
    try {
      canReach = !!iframe.element.contentDocument;
    } catch {
      canReach = false;
    }
    logTo("cfLog", `  跨域边界：顶层能否读取 iframe.contentDocument = ${canReach ? "能（异常/同源）" : "不能（符合预期，CF 跨域隔离）"}`, canReach ? "warn" : "ok");
  } else {
    logTo("cfLog", "  （未见 CF iframe：测试 sitekey 脚本可能未加载，但 .cf-turnstile 容器仍被命中）", "dim");
  }
}
async function doAssistCF() {
  logTo("cfLog", "--- 辅助（顶层滚动 + 高亮）---", "dim");
  const res = await assistCloudflare({ onLog: (m) => logTo("cfLog", "  " + m, "dim") });
  logTo("cfLog", `结果: mode=${res.mode} success=${res.success}${res.widgets != null ? ` widgets=${res.widgets}` : ""}`, res.success ? "ok" : "warn");
  logTo("cfLog", "注：辅助 ≠ 绕过。合成点击 isTrusted=false + CF 网络/行为指纹，客户端无法自动通过（见右侧评分 mock）。", "warn");
}
function main() {
  renderPuzzle();
  installSliderBehavior();
  $("sliderRegen").addEventListener("click", () => {
    renderPuzzle();
    logTo("sliderLog", `已重新生成，缺口真值 x=${truth.gapX}px`, "dim");
  });
  $("sliderDetect").addEventListener("click", doDetect);
  $("sliderSolve").addEventListener("click", () => {
    doSolve();
  });
  $("sliderSelftest").addEventListener("click", () => doSelftest(30));
  logTo("sliderLog", "Ready. 「检测」验证 CaptchaDetector 命中；「自动求解」跑 slideMatch+拖拽；「自测」测缺口检测准确率。", "ok");
  renderClickSelect();
  $("csRegen").addEventListener("click", () => {
    renderClickSelect();
    logTo("csLog", `已重新生成，题面=${csOrder.join(" ")}`, "dim");
  });
  $("csDetect").addEventListener("click", doDetectCS);
  $("csSolve").addEventListener("click", () => {
    doSolveCS();
  });
  $("csSelftest").addEventListener("click", () => {
    doSelftestCS(10);
  });
  logTo("csLog", "Ready. 「检测」验证命中；「自动求解」跑 common_det+OCR+点击；「自测」测端到端通过率。首次求解会初始化模型（约 30s）。", "ok");
  $("cfDetect").addEventListener("click", doDetectCF);
  $("cfAssist").addEventListener("click", () => {
    doAssistCF();
  });
  logTo("cfLog", "Ready. 「检测」验证 detectTurnstile 命中 + 跨域边界；「辅助」跑顶层滚动+高亮降级。右侧 mock 可点「机器人模式 / 辅助点击」对比评分。", "ok");
}
main();
