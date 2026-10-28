import { CONSTANTS, Logger, AMBIGUOUS_EXCLUDE_PATTERNS, STYLE_EXCLUDE_PATTERNS } from './config';
import type { CaptchaElementInfo, InputElementInfo } from './types';

export interface DetectedCaptcha {
  id: string;
  type: 'image' | 'canvas' | 'svg' | 'background';
  /**
   * Optional refinement for interactive captchas. Detection only — auto-solve
   * still TODO, but consumers can render different UI / treat differently.
   */
  subType?: 'slider' | 'click-select';
  /**
   * For slider/click-select captchas the user-visible container is often
   * a <div>/<section> wrapping one or more <canvas>/<img>. `element` is the
   * outer container (so coordinate / event work happens there); `innerCanvas`
   * is the actual pixel surface the OCR pipeline samples from.
   */
  innerCanvas?: HTMLCanvasElement | HTMLImageElement;
  /** Slider 子类型专用：滑块小图（拼图块），区别于 innerCanvas（带缺口的背景图）。
   *  缺口检测需要「背景图 + 小图」两张做模板匹配。 */
  sliderPiece?: HTMLCanvasElement | HTMLImageElement;
  /** Slider 子类型专用：用户实际拖拽的手柄/滑钮元素（拖拽事件派发目标）。 */
  sliderHandle?: HTMLElement;
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

/** 拖拽手柄的关键词（class/id 子串）。供 findSliderHandle 与结构化滑块检测共享，
 *  这样「靠手柄反推容器」与「容器内找手柄」两条路径用同一套信号，避免分叉。 */
const SLIDER_HANDLE_KEYWORDS = [
  'handle', 'slider-btn', 'sliderbtn', 'btn_slide', 'slide-btn', 'drag',
  'knob', 'thumb', 'gt_slider_knob', 'gt_slider', 'slider_button', 'nc_iconfont', 'control',
];

export class CaptchaDetector {
  private detectedCaptchas: DetectedCaptcha[] = [];
  private dirtyRoots = new Set<Element>();
  private lastFullScan = 0;
  private elementIds = new WeakMap<Element, string>();
  private nextElementId = 0;
  /** Cache last logged scan count to suppress identical-result spam in diagnostics buffer. */
  private lastLoggedScanCount = -1;
  private processedElements = new WeakMap<Element, string>();
  private checkedAgreements = new WeakSet<HTMLInputElement>();
  private customIncludeKeywords: string[] = [];
  private customExcludePatterns: string[] = [];
  private customAgreementKeywords: string[] = [];
  private customInputExcludeKeywords: string[] = [];
  captureForOCR: any;

  setCustomPatterns(include: string[], exclude: string[], agreementKeywords?: string[], inputExcludeKeywords?: string[]): void {
    this.lastFullScan = 0;
    this.customIncludeKeywords = include.map(k => k.toLowerCase().trim()).filter(Boolean);
    this.customExcludePatterns = exclude.map(p => p.toLowerCase().trim()).filter(Boolean);
    this.customAgreementKeywords = (agreementKeywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
    this.customInputExcludeKeywords = (inputExcludeKeywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
  }

  private getCaptchaKeywords(): string[] {
    if (this.customIncludeKeywords.length === 0) return CONSTANTS.CAPTCHA_KEYWORDS;
    return [...CONSTANTS.CAPTCHA_KEYWORDS, ...this.customIncludeKeywords];
  }

  private getExcludePatterns(): string[] {
    if (this.customExcludePatterns.length === 0) return CONSTANTS.EXCLUDE_PATTERNS;
    return [...CONSTANTS.EXCLUDE_PATTERNS, ...this.customExcludePatterns];
  }

  /**
   * className / id 专用的排除词表。'ad' / 'bg' 这类短词在 Tailwind 类名里极常见
   * （shadow-md 含 "ad"、bg-white 含 "bg"），子串匹配会把真实验证码图片整体排除。
   * 它们只在 URL / alt 上参与匹配（见 isExcludedImage）。
   */
  private getStyleExcludePatterns(): string[] {
    const custom = this.customExcludePatterns.filter(
      (pattern) => !AMBIGUOUS_EXCLUDE_PATTERNS.includes(pattern),
    );
    const base = [...STYLE_EXCLUDE_PATTERNS];
    return custom.length === 0 ? base : [...base, ...custom];
  }

  private getAgreementKeywords(): string[] {
    if (this.customAgreementKeywords.length === 0) return CONSTANTS.AGREEMENT_KEYWORDS;
    return [...CONSTANTS.AGREEMENT_KEYWORDS, ...this.customAgreementKeywords];
  }

  private getInputExcludeKeywords(): string[] {
    if (this.customInputExcludeKeywords.length === 0) return CONSTANTS.INPUT_EXCLUDE_KEYWORDS;
    return [...CONSTANTS.INPUT_EXCLUDE_KEYWORDS, ...this.customInputExcludeKeywords];
  }

  private hasNearbyCaptchaInput(element: Element): boolean {
    const input = this.findRelatedInput(element);
    if (!input) return false;
    return this.isCaptchaInputByName(input);
  }

  private isExcludedElement(element: Element): boolean {
    const className = ((element as HTMLElement).className?.toString?.() || '').toLowerCase();
    const id = ((element as HTMLElement).id || '').toLowerCase();
    // 排除本扩展自身注入的 UI 元素（toast / picker overlay / 高亮框 / loading 等），
    // 它们的 id / class 都以 `Mieru-` 前缀（picker 用），或 `ddddocr` （历史命名）开头。
    // 不加这条扫描会把右键识别的 toast 当成背景图验证码。
    if (id.startsWith('mieru-') || className.startsWith('mieru-') || className.includes(' mieru-')) {
      return true;
    }
    if (id.startsWith('ddddocr') || className.includes('ddddocr')) {
      return true;
    }
    const excludePatterns = this.getStyleExcludePatterns();
    const combined = `${className} ${id}`.trim();
    return excludePatterns.some(pattern => combined.includes(pattern));
  }

  invalidateScan(node?: Node): void {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!element || element === document.body || element === document.documentElement || this.dirtyRoots.size >= 20) {
      this.lastFullScan = 0;
      this.dirtyRoots.clear();
      return;
    }
    this.dirtyRoots.add(element.closest('form, [role="dialog"]') || element.parentElement || element);
  }

  scanCached(opts: { includeInteractive?: boolean } = {}): DetectedCaptcha[] {
    if (Date.now() - this.lastFullScan >= 15000 || (opts.includeInteractive && this.dirtyRoots.size > 0)) {
      return this.scan(opts);
    }
    const roots = [...this.dirtyRoots];
    this.dirtyRoots.clear();
    for (const root of roots) {
      if (root.isConnected && !roots.some(other => other !== root && other.contains(root))) this.scan({ root });
    }
    this.detectedCaptchas = this.detectedCaptchas.filter(captcha => captcha.element.isConnected);
    return this.detectedCaptchas;
  }

  private elementId(element: Element): string {
    let id = this.elementIds.get(element);
    if (!id) {
      id = `captcha-${++this.nextElementId}`;
      this.elementIds.set(element, id);
    }
    return id;
  }

  /**
   * 本扩展/脚本自己注入的 UI（预览浮层、拾取器、toast、猜点提示）。
   * 它们里面有验证码图片和 `captcha` 字样，若不排除会被当成页面验证码反复识别。
   * 统一用 id/class 前缀 `Mieru-` 与 `data-mieru-*` 标记，`closest` 连祖先一起判断。
   */
  private isOwnUi(element: Element): boolean {
    if (typeof element.closest !== 'function') return false;
    return !!element.closest('[id^="Mieru-"], [class^="Mieru-"], [data-mieru], [data-mieru-toast]');
  }

  private candidates<T extends Element>(root: ParentNode, selector: string): T[] {
    const children = Array.from(root.querySelectorAll<T>(selector)).filter(el => !this.isOwnUi(el));
    if (root instanceof Element && root.matches(selector) && !this.isOwnUi(root)) children.unshift(root as T);
    return children;
  }

  scan(opts: { includeInteractive?: boolean; root?: Element } = {}): DetectedCaptcha[] {
    const root = opts.root || document;
    this.detectedCaptchas = opts.root
      ? this.detectedCaptchas.filter(captcha => captcha.element.isConnected && !root.contains(captcha.element))
      : [];
    if (!opts.root) {
      this.lastFullScan = Date.now();
      this.dirtyRoots.clear();
    }
    Logger.time('CaptchaDetector.scan');
    this.scanImages(root);
    this.scanCanvas(root);
    this.scanSvg(root);
    this.scanBackgroundImages(root);
    // 滑块 / 文字点选盲扫默认关闭（1.2.3 起扩展改为订阅/规则驱动——误扫率高、会对普通拖拽控件
    // 误触发自动操作）。扩展的交互式求解只经 content 的 checkAndApplySiteRule → customCaptchaSubType
    // 路径。仅当调用方显式传 includeInteractive=true 时才做盲扫——目前只有 userscript 沿用
    // （其交互式仍受用户开关 gate，订阅化列为后续跟进）。
    if (opts.includeInteractive) {
      this.scanInteractiveContainers();
      this.scanStructuralSliders();
    }
    Logger.timeEnd('CaptchaDetector.scan');
    // 仅在结果数变化或 >0 时记录日志，避免周期扫描刷爆 200 条诊断缓冲
    const count = this.detectedCaptchas.length;
    if (count > 0 || count !== this.lastLoggedScanCount) {
      Logger.debug('扫描结果:', count, '个验证码');
      this.lastLoggedScanCount = count;
    }
    return this.detectedCaptchas;
  }

  private scanImages(root: ParentNode): void {
    this.candidates<HTMLImageElement>(root, 'img').forEach(img => {
      if (this.isLikelyCaptcha(img)) {
        const rect = img.getBoundingClientRect();
        const captcha: DetectedCaptcha = {
          id: this.elementId(img),
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

  private scanCanvas(root: ParentNode): void {
    this.candidates<HTMLCanvasElement>(root, 'canvas').forEach(canvas => {
      if (this.isLikelyCanvasCaptcha(canvas)) {
        const rect = canvas.getBoundingClientRect();
        const captcha: DetectedCaptcha = {
          id: this.elementId(canvas),
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

  private scanSvg(root: ParentNode): void {
    this.candidates<SVGElement>(root, 'svg').forEach(svg => {
      if (this.isLikelySvgCaptcha(svg)) {
        const rect = svg.getBoundingClientRect();
        const captcha: DetectedCaptcha = {
          id: this.elementId(svg),
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

  private scanBackgroundImages(root: ParentNode): void {
    const candidates = this.candidates<HTMLElement>(root, 'div[style*="background"], span[style*="background"], td[style*="background"]');
    candidates.forEach(el => {
      const htmlEl = el as HTMLElement;
      if (this.isLikelyBackgroundCaptcha(htmlEl)) {
        const rect = htmlEl.getBoundingClientRect();
        const bgImage = htmlEl.style.backgroundImage || '';
        const captcha: DetectedCaptcha = {
          id: this.elementId(htmlEl),
          type: 'background',
          element: htmlEl,
          src: bgImage,
          rect,
          confidence: this.calculateConfidence(htmlEl),
          inputElement: this.findRelatedInput(htmlEl),
          elementInfo: this.extractCaptchaInfo(htmlEl),
        };
        this.detectedCaptchas.push(captcha);
        Logger.debug('检测到背景图验证码:', captcha.elementInfo);
      }
    });
  }

  /**
   * Detect interactive captchas wrapped in DOM containers (the most common
   * real-world pattern):
   *   <div class="slider-captcha"><canvas>...</canvas><div class="track">...</div></div>
   *   <div class="click-captcha"><canvas>...</canvas></div>
   *
   * 仅在 scan({ includeInteractive: true }) 时调用（目前只有 userscript）。扩展不再盲扫，
   * 交互式改由订阅/站点规则驱动。
   */
  private scanInteractiveContainers(): void {
    const SLIDER = (CONSTANTS as any).SLIDER_KEYWORDS as string[] | undefined;
    const CLICK = (CONSTANTS as any).CLICK_SELECT_KEYWORDS as string[] | undefined;
    if (!SLIDER && !CLICK) return;
    const slider = (SLIDER || []).map((s) => s.toLowerCase());
    const click = (CLICK || []).map((s) => s.toLowerCase());

    const MAX_NODES = 600;
    let scanned = 0;
    const seen = new Set<Element>();
    const matchKeyword = (el: Element, list: string[]): boolean => {
      const haystack = (
        ((el as HTMLElement).className?.toString?.() || '') + ' '
        + ((el as HTMLElement).id || '') + ' '
        + (el.getAttribute('data-captcha-type') || '') + ' '
        + (el.getAttribute('aria-label') || '')
      ).toLowerCase();
      if (!haystack.trim()) return false;
      return list.some((kw) => haystack.includes(kw));
    };

    const consider = (el: Element, kind: 'slider' | 'click-select', idx: number) => {
      if (seen.has(el) || ++scanned > MAX_NODES) return;
      seen.add(el);
      if (!this.isVisible(el)) return;
      const inner = el.querySelector('canvas, img');
      if (!inner) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 24) return;
      const innerEl = inner as HTMLCanvasElement | HTMLImageElement;
      if (this.detectedCaptchas.some((c) => c.element === el || c.element === innerEl)) return;

      const captcha: DetectedCaptcha = {
        id: `captcha-${kind}-${idx}`,
        type: 'canvas',
        subType: kind,
        element: el,
        innerCanvas: innerEl,
        rect,
        confidence: this.calculateConfidence(el) + 10,
        inputElement: this.findRelatedInput(el),
        elementInfo: this.extractCaptchaInfo(el),
      };
      if (kind === 'slider') {
        const parts = this.findSliderParts(el, innerEl);
        if (parts.background) captcha.innerCanvas = parts.background;
        if (parts.piece) captcha.sliderPiece = parts.piece;
        if (parts.handle) captcha.sliderHandle = parts.handle;
      }
      this.detectedCaptchas.push(captcha);
      Logger.debug(`检测到交互式验证码 (${kind}):`, captcha.elementInfo);
    };

    const buildSel = (list: string[]): string => list
      .flatMap((kw) => [`[class*="${kw}" i]`, `[id*="${kw}" i]`, `[data-captcha-type*="${kw}" i]`])
      .join(',');

    if (slider.length) {
      const sel = buildSel(slider);
      try {
        document.querySelectorAll(sel).forEach((el, i) => {
          if (matchKeyword(el, slider)) consider(el, 'slider', i);
        });
      } catch {
        document.querySelectorAll('div, section, span').forEach((el, i) => {
          if (scanned > MAX_NODES) return;
          if (matchKeyword(el, slider)) consider(el, 'slider', i);
        });
      }
    }
    if (click.length) {
      const sel = buildSel(click);
      try {
        document.querySelectorAll(sel).forEach((el, i) => {
          if (matchKeyword(el, click)) consider(el, 'click-select', i);
        });
      } catch {
        document.querySelectorAll('div, section, span').forEach((el, i) => {
          if (scanned > MAX_NODES) return;
          if (matchKeyword(el, click)) consider(el, 'click-select', i);
        });
      }
    }
  }

  /**
   * 结构化滑块检测：不依赖类名关键词，靠「拖拽手柄 + 图像面 + 横向轨道形态」识别滑块容器。
   * 仅在 scan({ includeInteractive: true }) 时调用（判据从严，避免误判普通拖拽控件）。
   */
  private scanStructuralSliders(): void {
    let candidates: HTMLElement[] = [];
    try {
      const sel =
        SLIDER_HANDLE_KEYWORDS.map((k) => `[class*="${k}" i],[id*="${k}" i]`).join(',') +
        ',[draggable="true"]';
      candidates = Array.from(document.querySelectorAll<HTMLElement>(sel));
    } catch {
      /* selector 不支持时忽略关键词候选 */
    }
    if (candidates.length < 30 && typeof getComputedStyle === 'function') {
      const all = document.querySelectorAll<HTMLElement>('div,span,a,button,i');
      const LIMIT = 1500;
      for (let i = 0; i < all.length && i < LIMIT; i++) {
        const e = all[i];
        const cur = getComputedStyle(e).cursor;
        if (cur === 'grab' || cur === 'move') {
          const r = e.getBoundingClientRect();
          if (r.width > 10 && r.width <= 140 && r.height > 10) candidates.push(e);
        }
      }
    }

    const MAX_HANDLES = 40;
    let scanned = 0;
    for (const handle of candidates) {
      if (++scanned > MAX_HANDLES) break;
      const hr = handle.getBoundingClientRect();
      if (hr.width <= 0 || hr.height <= 0 || hr.width > 140) continue;

      let el: Element | null = handle.parentElement;
      let depth = 0;
      while (el && depth < 6 && el !== document.body && el !== document.documentElement) {
        // 该祖先已被其它扫描（图片/canvas/背景图）收录时只跳过这一层，继续往上找真正的
        // 滑块容器——早期这里 break 整条链，导致手柄父级恰好被收录时结构化检测直接失效。
        if (this.detectedCaptchas.some((c) => c.element === el)) {
          el = el.parentElement;
          depth++;
          continue;
        }
        const inner = el.querySelector('canvas, img') as
          | HTMLCanvasElement
          | HTMLImageElement
          | null;
        if (inner) {
          const rect = el.getBoundingClientRect();
          const horizontal = rect.width >= rect.height;
          const sized =
            rect.width >= 80 && rect.width <= 600 && rect.height >= 24 && rect.height <= 360;
          const handleAtLeft = hr.left - rect.left < rect.width * 0.5;
          if (this.isVisible(el) && horizontal && sized && handleAtLeft) {
            const parts = this.findSliderParts(el, inner);
            const captcha: DetectedCaptcha = {
              id: `captcha-slider-struct-${this.detectedCaptchas.length}`,
              type: 'canvas',
              subType: 'slider',
              element: el,
              innerCanvas: parts.background || inner,
              sliderPiece: parts.piece,
              sliderHandle: parts.handle || handle,
              rect,
              confidence: this.calculateConfidence(el) + 5,
              inputElement: null,
              elementInfo: this.extractCaptchaInfo(el),
            };
            this.detectedCaptchas.push(captcha);
            Logger.debug('结构化检测到滑块:', captcha.elementInfo);
            break;
          }
        }
        el = el.parentElement;
        depth++;
      }
    }
  }

  /**
   * 在滑块容器内定位三要素：背景缺口图、滑块小图、拖拽手柄。纯启发式，
   * 覆盖常见结构（GeeTest、开源滑块库）。拿不到的项返回 undefined，由 solver 兜底。
   */
  private findSliderParts(
    container: Element,
    fallbackInner: HTMLCanvasElement | HTMLImageElement,
  ): {
    background?: HTMLCanvasElement | HTMLImageElement;
    piece?: HTMLCanvasElement | HTMLImageElement;
    handle?: HTMLElement;
  } {
    const surfaces = Array.from(
      container.querySelectorAll('canvas, img'),
    ) as (HTMLCanvasElement | HTMLImageElement)[];
    const visible = surfaces.filter((s) => {
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const area = (s: Element): number => {
      const r = s.getBoundingClientRect();
      return r.width * r.height;
    };

    let background: HTMLCanvasElement | HTMLImageElement | undefined;
    let piece: HTMLCanvasElement | HTMLImageElement | undefined;
    if (visible.length >= 2) {
      const sorted = [...visible].sort((a, b) => area(b) - area(a));
      background = sorted[0];
      // 小图：明显小于背景且宽高比接近 1（拼图块通常近方形）
      piece =
        sorted.slice(1).find((s) => {
          const r = s.getBoundingClientRect();
          const ratio = r.width / Math.max(1, r.height);
          return area(s) < area(background!) * 0.6 && ratio > 0.4 && ratio < 2.5;
        }) || sorted[1];
    } else if (visible.length === 1) {
      background = visible[0];
    } else {
      background = fallbackInner;
    }

    return { background, piece, handle: this.findSliderHandle(container) };
  }

  /** 在容器内定位拖拽手柄：关键词 → draggable → cursor 样式，取最靠左的合理候选。 */
  private findSliderHandle(container: Element): HTMLElement | undefined {
    const KW = SLIDER_HANDLE_KEYWORDS;
    let candidates: HTMLElement[] = [];
    try {
      const sel = KW.map((k) => `[class*="${k}" i],[id*="${k}" i]`).join(',');
      candidates = Array.from(container.querySelectorAll<HTMLElement>(sel));
    } catch {
      /* selector 不支持时忽略 */
    }
    candidates.push(...Array.from(container.querySelectorAll<HTMLElement>('[draggable="true"]')));
    if (candidates.length === 0 && typeof getComputedStyle === 'function') {
      Array.from(container.querySelectorAll<HTMLElement>('*')).forEach((e) => {
        const cur = getComputedStyle(e).cursor;
        if (cur === 'grab' || cur === 'move') {
          const r = e.getBoundingClientRect();
          if (r.width > 10 && r.width < 90 && r.height > 10) candidates.push(e);
        }
      });
    }
    const visible = candidates.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width < 140;
    });
    if (visible.length === 0) return undefined;
    visible.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return visible[0];
  }

  /**
   * 从「用户手动选中的容器」构造一个交互式 DetectedCaptcha（滑块 / 文字点选）。
   * 入口是已知容器、已知 subType，不做关键词盲扫猜测——用于 picker 手选 / 规则命中后
   * 按 subType 直接求解（1.2.3 起交互式只走规则路径，不再盲扫）。
   * 拿不到内部 canvas/img 时返回 null（交互验证码必须有像素面可读）。
   */
  buildInteractiveCaptcha(
    container: Element,
    subType: 'slider' | 'click-select',
    idSuffix: string | number = 0,
  ): DetectedCaptcha | null {
    const innerEl = container.querySelector('canvas, img') as
      | HTMLCanvasElement
      | HTMLImageElement
      | null;
    if (!innerEl) return null;
    const rect = container.getBoundingClientRect();
    const captcha: DetectedCaptcha = {
      id: `captcha-${subType}-${idSuffix}`,
      type: 'canvas',
      subType,
      element: container,
      innerCanvas: innerEl,
      rect,
      confidence: 100,
      inputElement: this.findRelatedInput(container),
      elementInfo: this.extractCaptchaInfo(container),
    };
    if (subType === 'slider') {
      const parts = this.findSliderParts(container, innerEl);
      if (parts.background) captcha.innerCanvas = parts.background;
      if (parts.piece) captcha.sliderPiece = parts.piece;
      if (parts.handle) captcha.sliderHandle = parts.handle;
    }
    return captcha;
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

  private getEffectiveSize(element: Element): { width: number; height: number } {
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
        width = parseInt(element.getAttribute('width') || '0') || 0;
      }
      if (height === 0) {
        height = parseInt(element.getAttribute('height') || '0') || 0;
      }
    }
    return { width, height };
  }

  private isLikelyCaptcha(img: HTMLImageElement): boolean {
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
    if (this.matchesKeywords(img)) return true;
    if (this.srcContainsKeywords(img.src)) return true;
    if (this.parentContainsKeywords(img)) return true;
    if (this.hasNearbyCaptchaInput(img)) return true;
    if (this.isDataUrlImage(img) && this.isCaptchaSize(width, height)) {
      if (this.hasNearbyCaptchaInput(img) || this.parentContainsKeywords(img)) return true;
    }
    return false;
  }

  private isDataUrlImage(img: HTMLImageElement): string | null {
    return img.src && (img.src.startsWith('data:image/') || img.src.startsWith('blob:')) ? img.src : null;
  }

  private isVisibleOrHasSize(element: Element, effectiveWidth: number, effectiveHeight: number): boolean {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      return false;
    }
    return effectiveWidth > 0 && effectiveHeight > 0;
  }

  private getImageSrcForExclusionCheck(img: HTMLImageElement): string {
    const src = (img.currentSrc || img.src || '').trim();
    if (!src) return '';
    if (src.startsWith('data:image/') || src.startsWith('blob:')) {
      return '';
    }
    try {
      const url = new URL(src, window.location.href);
      return (url.origin + url.pathname).toLowerCase();
    } catch {
      return src.slice(0, 200).toLowerCase();
    }
  }

  private isExcludedImage(img: HTMLImageElement): boolean {
    const src = this.getImageSrcForExclusionCheck(img);
    const alt = (img.alt || '').toLowerCase();
    const className = (img.className?.toString?.() || '').toLowerCase();
    const id = (img.id || '').toLowerCase();
    // URL / alt 用完整词表（文件名里的 bg.png / ad.png 有排除意义）；
    // className / id 用剔除短词的词表，避免误伤 Tailwind 工具类。
    const urlText = `${src} ${alt}`.trim();
    if (this.getExcludePatterns().some(pattern => urlText.includes(pattern))) return true;
    const styleText = `${className} ${id}`.trim();
    return this.getStyleExcludePatterns().some(pattern => styleText.includes(pattern));
  }

  public isLikelyCanvasCaptcha(canvas: HTMLCanvasElement): boolean {
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
    if (this.matchesKeywords(canvas)) return true;
    if (this.parentContainsKeywords(canvas)) return true;
    if (this.hasNearbyCaptchaInput(canvas)) return true;
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
    if (this.isExcludedElement(svg)) {
      return false;
    }
    if (this.matchesKeywords(svg)) return true;
    if (this.parentContainsKeywords(svg)) return true;
    if (this.hasNearbyCaptchaInput(svg)) return true;
    return false;
  }

  private isLikelyBackgroundCaptcha(el: HTMLElement): boolean {
    // 注意：候选选择器是 [style*="background"]，简写 `background: #eee`（纯色、无图）也会命中。
    // 这种元素的 el.style.backgroundImage 返回 'initial' 而非 ''/'none'，若不排除就会把纯色
    // 容器（如滑块轨道）误判成背景图验证码，并抢占结构化检测的祖先链。
    const bgImage = el.style.backgroundImage || '';
    if (!bgImage || bgImage === 'none' || bgImage === 'initial' || bgImage === 'unset') return false;
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
    if (this.matchesKeywords(el)) return true;
    if (this.parentContainsKeywords(el)) return true;
    if (this.hasNearbyCaptchaInput(el)) return true;
    if (bgImage.includes('data:image/')) return this.hasNearbyCaptchaInput(el) || this.parentContainsKeywords(el);
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
    const keywords = this.getCaptchaKeywords();
    return keywords.some(
      keyword => className.includes(keyword) || id.includes(keyword)
    );
  }

  private srcContainsKeywords(src: string): boolean {
    if (!src) return false;
    const lowerSrc = src.toLowerCase();
    const keywords = this.getCaptchaKeywords();
    return keywords.some(keyword => lowerSrc.includes(keyword));
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

  private getInputLabelText(input: HTMLInputElement): string {
    try {
      if (input.id) {
        const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (label) return (label.textContent || '').trim();
      }
      const wrapperLabel = input.closest('label');
      if (wrapperLabel) return (wrapperLabel.textContent || '').trim();
    } catch { }
    return '';
  }

  private getInputSearchText(input: HTMLInputElement): string {
    const parts: string[] = [];
    parts.push(input.name || '');
    parts.push(input.id || '');
    parts.push(input.className || '');
    parts.push(input.placeholder || '');
    parts.push(input.getAttribute('aria-label') || '');
    parts.push(input.getAttribute('data-label') || '');
    parts.push(input.getAttribute('data-name') || '');
    parts.push(this.getInputLabelText(input));
    return parts.join(' ').toLowerCase();
  }

  private isCaptchaInputByName(input: HTMLInputElement): boolean {
    const text = this.getInputSearchText(input);
    return CONSTANTS.INPUT_KEYWORDS.some(keyword => text.includes(keyword));
  }

  private isExcludedInputByText(input: HTMLInputElement): boolean {
    const text = this.getInputSearchText(input);
    const excluded = [
      'username', 'user', 'account', 'email', 'phone', 'mobile', 'tel',
      'password', 'pwd', 'pass',
      'search', 'query', 'keyword',
      '用户名', '账号', '密码', '手机号', '邮箱', '搜索', '查询', '关键字',
    ];
    const inputExcludeKeywords = this.getInputExcludeKeywords();
    const allExcluded = [...excluded, ...inputExcludeKeywords];
    return allExcluded.some(k => text.includes(k));
  }

  private scoreInputCandidate(input: HTMLInputElement, captchaRect: DOMRect, inputRect: DOMRect): number {
    const distance = this.calculateDistance(captchaRect, inputRect);
    let bonus = 0;
    const text = this.getInputSearchText(input);
    if (this.isCaptchaInputByName(input)) bonus += 120;
    if (text.includes('验证码')) bonus += 140;
    if (text.includes('verify')) bonus += 80;
    if (text.includes('vcode')) bonus += 80;
    if (text.includes('authcode')) bonus += 80;
    if (text.includes('checkcode')) bonus += 80;
    if (text.includes('yzm')) bonus += 60;
    if (this.isExcludedInputByText(input)) bonus -= 200;
    return distance - bonus;
  }

  private findClosestInputInContainer(
    container: Element,
    captchaRect: DOMRect,
    maxDistance: number = Infinity
  ): HTMLInputElement | null {
    const inputs = container.querySelectorAll('input');
    let closest: HTMLInputElement | null = null;
    let closestScore = Infinity;
    let closestDistance = Infinity;
    for (const input of inputs) {
      const htmlInput = input as HTMLInputElement;
      if (!this.isValidCaptchaInput(htmlInput)) continue;
      // 排除 search / 登录 / 邮箱等明显与验证码无关的输入框 —— 它们即使距离最近也不应被回填。
      // 唯一例外：该输入框同时带有验证码关键词（罕见但允许）。
      if (this.isExcludedInputByText(htmlInput) && !this.isCaptchaInputByName(htmlInput)) continue;
      const inputRect = input.getBoundingClientRect();
      const distance = this.calculateDistance(captchaRect, inputRect);
      if (distance > maxDistance) continue;
      const score = this.scoreInputCandidate(htmlInput, captchaRect, inputRect);
      if (
        score < closestScore ||
        (Math.abs(score - closestScore) < 15 && distance < closestDistance)
      ) {
        closestScore = score;
        closestDistance = distance;
        closest = htmlInput;
      }
    }
    return closest;
  }

  private findFrameworkRelatedInput(element: Element): HTMLInputElement | null {
    const elInput = element.closest('.el-input') || element.closest('.el-input-group') || element.closest('.el-form-item');
    if (elInput) {
      const elInner = elInput.querySelector('input.el-input__inner') as HTMLInputElement | null;
      if (elInner && this.isValidCaptchaInput(elInner)) return elInner;
      const anyInput = elInput.querySelector('input') as HTMLInputElement | null;
      if (anyInput && this.isValidCaptchaInput(anyInput)) return anyInput;
    }
    const antInput = element.closest('.ant-input-group') || element.closest('.ant-form-item') || element.closest('.ant-input-affix-wrapper');
    if (antInput) {
      const anyInput = antInput.querySelector('input') as HTMLInputElement | null;
      if (anyInput && this.isValidCaptchaInput(anyInput)) return anyInput;
    }
    const ivuInput = element.closest('.ivu-input-group') || element.closest('.ivu-form-item');
    if (ivuInput) {
      const anyInput = ivuInput.querySelector('input') as HTMLInputElement | null;
      if (anyInput && this.isValidCaptchaInput(anyInput)) return anyInput;
    }
    const vanInput = element.closest('.van-field') || element.closest('.van-cell');
    if (vanInput) {
      const anyInput = vanInput.querySelector('input') as HTMLInputElement | null;
      if (anyInput && this.isValidCaptchaInput(anyInput)) return anyInput;
    }
    return null;
  }

  findRelatedInput(element: Element): HTMLInputElement | null {
    const frameworkInput = this.findFrameworkRelatedInput(element);
    if (frameworkInput) return frameworkInput;
    const captchaRect = element.getBoundingClientRect();
    const parent = element.parentElement;
    if (parent) {
      const input = this.findClosestInputInContainer(parent, captchaRect);
      if (input) return input;
    }
    let ancestor = parent?.parentElement;
    let depth = 0;
    while (ancestor && depth < 4) {
      const input = this.findClosestInputInContainer(ancestor, captchaRect, 180);
      if (input) return input;
      ancestor = ancestor.parentElement;
      depth++;
    }
    const inputs = document.querySelectorAll('input');
    let best: HTMLInputElement | null = null;
    let bestScore = Infinity;
    for (const input of inputs) {
      const htmlInput = input as HTMLInputElement;
      if (!this.isValidCaptchaInput(htmlInput)) continue;
      // 全局兜底搜索时更严格：除非该输入框带验证码关键词，否则不接受明显属于排除类别（搜索/账号/邮箱等）的输入。
      // 因为在文档全局范围内，「最近」的输入框完全可能是页面顶部的搜索栏，而它和验证码图片本无关联。
      if (this.isExcludedInputByText(htmlInput) && !this.isCaptchaInputByName(htmlInput)) continue;
      const inputRect = input.getBoundingClientRect();
      const roughlyNear =
        (
          (inputRect.left > captchaRect.right && inputRect.left - captchaRect.right < 220 && Math.abs(inputRect.top - captchaRect.top) < 90) ||
          (inputRect.top > captchaRect.bottom && inputRect.top - captchaRect.bottom < 160 && Math.abs(inputRect.left - captchaRect.left) < 160) ||
          (this.calculateDistance(captchaRect, inputRect) < 240)
        );
      if (!roughlyNear) continue;
      const score = this.scoreInputCandidate(htmlInput, captchaRect, inputRect);
      if (score < bestScore) {
        bestScore = score;
        best = htmlInput;
      }
    }
    return best;
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

  private calculateConfidence(element: Element): number {
    let score = 0;
    if (this.matchesKeywords(element)) score += 30;
    if ((element as HTMLImageElement).src && this.srcContainsKeywords((element as HTMLImageElement).src)) score += 20;
    if (this.parentContainsKeywords(element)) score += 15;
    if (this.findRelatedInput(element)) score += 25;
    const { width, height } = this.getEffectiveSize(element);
    if (this.isCaptchaSize(width, height)) score += 10;
    return Math.min(score, 100);
  }

  guessRelatedCaptcha(inputElement: HTMLInputElement): GuessedElement[] {
    const guessed: GuessedElement[] = [];
    const inputRect = inputElement.getBoundingClientRect();
    Logger.debug('开始猜测关联的验证码元素, 输入框位置:', inputRect);
    const candidates: { element: Element; distance: number; type: 'image' | 'canvas' | 'svg' | 'background' }[] = [];
    document.querySelectorAll('img').forEach(img => {
      if (!this.isVisible(img)) return;
      const { width, height } = this.getEffectiveSize(img);
      if (!this.isCaptchaSize(width, height)) return;
      if (this.isExcludedImage(img as HTMLImageElement)) return;
      const rect = img.getBoundingClientRect();
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
      const width = (svg as SVGElement).clientWidth || parseInt((svg as SVGElement).getAttribute('width') || '0');
      const height = (svg as SVGElement).clientHeight || parseInt((svg as SVGElement).getAttribute('height') || '0');
      if (!this.isCaptchaSize(width, height)) return;
      const rect = svg.getBoundingClientRect();
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: svg, distance, type: 'svg' });
    });
    document.querySelectorAll('div[style*="background"], span[style*="background"]').forEach(el => {
      const htmlEl = el as HTMLElement;
      if (!this.isVisible(htmlEl)) return;
      const bgImage = htmlEl.style.backgroundImage || '';
      if (!bgImage || bgImage === 'none') return;
      const rect = htmlEl.getBoundingClientRect();
      if (!this.isCaptchaSize(rect.width, rect.height)) return;
      const distance = this.calculateDistance(inputRect, rect);
      candidates.push({ element: htmlEl, distance, type: 'background' });
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
    const candidates: { element: HTMLInputElement; distance: number; hasKeyword: boolean; score: number }[] = [];
    document.querySelectorAll('input').forEach(input => {
      const htmlInput = input as HTMLInputElement;
      if (!this.isValidCaptchaInput(htmlInput)) return;
      if (!this.isVisible(htmlInput)) return;
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
      const hasKeyword = this.getAgreementKeywords().some(keyword => combinedText.includes(keyword));
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
    // For interactive containers, OCR samples the inner canvas/img — the
    // outer DOM container is the user-interaction target, not the pixel source.
    if (captcha.innerCanvas) {
      if (captcha.innerCanvas instanceof HTMLCanvasElement) {
        return this.captureCanvasElement(captcha.innerCanvas);
      }
      return this.captureImgElement(captcha.innerCanvas);
    }
    switch (captcha.type) {
      case 'image':
        return this.captureImgElement(captcha.element as HTMLImageElement);
      case 'canvas':
        return this.captureCanvasElement(captcha.element as HTMLCanvasElement);
      case 'svg':
        return this.captureSvgElement(captcha.element as SVGElement);
      case 'background':
        return this.captureBackgroundElement(captcha.element as HTMLElement);
    }
  }

  async captureBuffer(captcha: DetectedCaptcha): Promise<ArrayBuffer> {
    const blob = await this.captureBlob(captcha);
    return await blob.arrayBuffer();
  }

  async captureBlob(captcha: DetectedCaptcha): Promise<Blob> {
    if (captcha.innerCanvas) {
      if (captcha.innerCanvas instanceof HTMLCanvasElement) {
        return this.captureCanvasAsBlob(captcha.innerCanvas);
      }
      return this.captureImgAsBlob(captcha.innerCanvas);
    }
    switch (captcha.type) {
      case 'image':
        return this.captureImgAsBlob(captcha.element as HTMLImageElement);
      case 'canvas':
        return this.captureCanvasAsBlob(captcha.element as HTMLCanvasElement);
      case 'svg':
        return this.captureSvgAsBlob(captcha.element as SVGElement);
      case 'background':
        return this.captureBackgroundAsBlob(captcha.element as HTMLElement);
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
    if (!clonedSvg.getAttribute('xmlns')) {
      clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
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

  private async captureBackgroundElement(el: HTMLElement): Promise<string> {
    const blob = await this.captureBackgroundAsBlob(el);
    return await this.blobToDataURL(blob);
  }

  private async captureBackgroundAsBlob(el: HTMLElement): Promise<Blob> {
    const bgImage = el.style.backgroundImage || window.getComputedStyle(el).backgroundImage || '';
    const urlMatch = bgImage.match(/url\(['"]?(.+?)['"]?\)/);
    if (!urlMatch) {
      throw new Error('无法提取背景图URL');
    }
    const imageUrl = urlMatch[1];
    if (imageUrl.startsWith('data:')) {
      const response = await fetch(imageUrl);
      return await response.blob();
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('背景图加载失败'));
      setTimeout(() => reject(new Error('背景图加载超时')), 5000);
    });
    const canvas = document.createElement('canvas');
    const rect = el.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('背景图转换失败'));
      }, 'image/png');
    });
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
