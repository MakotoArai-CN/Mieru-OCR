import { t } from '@core/i18n';

export class Dialog {
  private static container: HTMLDivElement | null = null;
  private static stylesInjected = false;

  private static isMobile(): boolean {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      (window.innerWidth <= 768);
  }

  private static injectStyles(): void {
    if (this.stylesInjected) return;

    const style = document.createElement('style');
    style.textContent = `
      .Mieru-dialog-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: Mieru-fade-in 0.3s ease;
        padding: 16px;
        box-sizing: border-box;
      }

      .Mieru-dialog {
        background: white;
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(74, 144, 226, 0.25);
        max-width: 500px;
        width: 100%;
        max-height: 80vh;
        overflow: hidden;
        animation: Mieru-scale-in 0.3s ease;
        display: flex;
        flex-direction: column;
      }

      .Mieru-dialog.mobile {
        max-width: 100%;
        border-radius: 12px;
      }

      .Mieru-dialog-header {
        background: #4A90E2;
        color: white;
        padding: 20px 24px;
        font-size: 18px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }

      .Mieru-dialog.mobile .Mieru-dialog-header {
        padding: 16px 20px;
        font-size: 16px;
      }

      .Mieru-dialog-body {
        padding: 24px;
        max-height: calc(80vh - 140px);
        overflow-y: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        flex: 1;
        -webkit-overflow-scrolling: touch;
      }

      .Mieru-dialog.mobile .Mieru-dialog-body {
        padding: 20px;
      }

      .Mieru-dialog-body::-webkit-scrollbar {
        width: 6px;
      }

      .Mieru-dialog-body::-webkit-scrollbar-track {
        background: #f1f5f9;
        border-radius: 3px;
      }

      .Mieru-dialog-body::-webkit-scrollbar-thumb {
        background: #FFB6C1;
        border-radius: 3px;
      }

      .Mieru-dialog-body::-webkit-scrollbar-thumb:hover {
        background: #FF69B4;
      }

      .Mieru-dialog-content {
        color: #333;
        font-size: 14px;
        line-height: 1.6;
        white-space: pre-wrap;
      }

      .Mieru-dialog.mobile .Mieru-dialog-content {
        font-size: 15px;
      }

      .Mieru-dialog-footer {
        padding: 16px 24px;
        border-top: 1px solid #f1f5f9;
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        flex-shrink: 0;
      }

      .Mieru-dialog.mobile .Mieru-dialog-footer {
        padding: 16px 20px;
        flex-direction: column-reverse;
      }

      .Mieru-dialog-button {
        padding: 10px 24px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s;
        -webkit-tap-highlight-color: transparent;
      }

      .Mieru-dialog.mobile .Mieru-dialog-button {
        padding: 14px 24px;
        font-size: 15px;
        width: 100%;
      }

      .Mieru-dialog-button.primary {
        background: #4A90E2;
        color: white;
      }

      .Mieru-dialog-button.primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(74, 144, 226, 0.35);
      }

      .Mieru-dialog-button.primary:active {
        transform: translateY(0);
      }

      .Mieru-dialog-button.secondary {
        background: #f1f5f9;
        color: #4A90E2;
      }

      .Mieru-dialog-button.secondary:hover {
        background: #e2e8f0;
      }

      .Mieru-dialog-button.secondary:active {
        background: #cbd5e1;
      }

      @keyframes Mieru-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes Mieru-scale-in {
        from { opacity: 0; transform: scale(0.9); }
        to { opacity: 1; transform: scale(1); }
      }
    `;
    document.head.appendChild(style);
    this.stylesInjected = true;
  }

  private static stopPropagation(e: Event): void {
    e.stopPropagation();
  }

  /** 组装 header / body / footer。正文默认按纯文本渲染；只有显式传 html 才走 innerHTML——
   *  订阅名、错误信息等来自远程/用户的数据经常被塞进这里，直接拼 HTML 会构成 XSS。 */
  private static buildDialog(options: {
    title: string;
    content?: string;
    html?: string;
    icon?: string;
  }): { overlay: HTMLDivElement; dialog: HTMLDivElement; footer: HTMLDivElement } {
    const overlay = document.createElement('div');
    overlay.className = 'Mieru-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'Mieru-dialog';
    if (this.isMobile()) {
      dialog.classList.add('mobile');
    }

    const header = document.createElement('div');
    header.className = 'Mieru-dialog-header';
    header.textContent = `${options.icon || 'ℹ️'} ${options.title}`;

    const body = document.createElement('div');
    body.className = 'Mieru-dialog-body';
    const content = document.createElement('div');
    content.className = 'Mieru-dialog-content';
    if (typeof options.html === 'string') {
      content.innerHTML = options.html;
    } else {
      content.textContent = options.content ?? '';
    }
    body.appendChild(content);

    const footer = document.createElement('div');
    footer.className = 'Mieru-dialog-footer';

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    dialog.addEventListener('mousedown', this.stopPropagation);
    dialog.addEventListener('mouseup', this.stopPropagation);
    dialog.addEventListener('click', this.stopPropagation);
    dialog.addEventListener('dblclick', this.stopPropagation);
    dialog.addEventListener('wheel', this.stopPropagation);
    dialog.addEventListener('keydown', this.stopPropagation);
    dialog.addEventListener('keyup', this.stopPropagation);
    dialog.addEventListener('keypress', this.stopPropagation);
    dialog.addEventListener('contextmenu', this.stopPropagation);
    dialog.addEventListener('touchstart', this.stopPropagation, { passive: true });
    dialog.addEventListener('touchmove', this.stopPropagation, { passive: true });
    dialog.addEventListener('touchend', this.stopPropagation);

    this.container = overlay;
    return { overlay, dialog, footer };
  }

  static show(options: { title: string; content?: string; html?: string; icon?: string; confirmText?: string; onConfirm?: () => void }): void {
    this.injectStyles();
    this.close();

    const { overlay, footer } = this.buildDialog(options);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'Mieru-dialog-button primary';
    confirmBtn.textContent = options.confirmText || t('common.confirm');
    confirmBtn.addEventListener('click', () => {
      options.onConfirm?.();
      this.close();
    });
    footer.appendChild(confirmBtn);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
  }

  static confirm(options: { title: string; content?: string; html?: string; icon?: string; confirmText?: string; cancelText?: string; onConfirm?: () => void; onCancel?: () => void }): void {
    this.injectStyles();
    this.close();

    const { overlay, footer } = this.buildDialog({ ...options, icon: options.icon ?? '❓' });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'Mieru-dialog-button secondary cancel-btn';
    cancelBtn.textContent = options.cancelText || t('common.cancel');
    cancelBtn.addEventListener('click', () => {
      options.onCancel?.();
      this.close();
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'Mieru-dialog-button primary confirm-btn';
    confirmBtn.textContent = options.confirmText || t('common.confirm');
    confirmBtn.addEventListener('click', () => {
      options.onConfirm?.();
      this.close();
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        options.onCancel?.();
        this.close();
      }
    });
  }

  static close(): void {
    this.container?.remove();
    this.container = null;
  }
}