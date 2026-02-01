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
      .ddddocr-dialog-overlay {
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
        animation: ddddocr-fade-in 0.3s ease;
        padding: 16px;
        box-sizing: border-box;
      }

      .ddddocr-dialog {
        background: white;
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(74, 144, 226, 0.25);
        max-width: 500px;
        width: 100%;
        max-height: 80vh;
        overflow: hidden;
        animation: ddddocr-scale-in 0.3s ease;
        display: flex;
        flex-direction: column;
      }

      .ddddocr-dialog.mobile {
        max-width: 100%;
        border-radius: 12px;
      }

      .ddddocr-dialog-header {
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

      .ddddocr-dialog.mobile .ddddocr-dialog-header {
        padding: 16px 20px;
        font-size: 16px;
      }

      .ddddocr-dialog-body {
        padding: 24px;
        max-height: calc(80vh - 140px);
        overflow-y: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        flex: 1;
        -webkit-overflow-scrolling: touch;
      }

      .ddddocr-dialog.mobile .ddddocr-dialog-body {
        padding: 20px;
      }

      .ddddocr-dialog-body::-webkit-scrollbar {
        width: 6px;
      }

      .ddddocr-dialog-body::-webkit-scrollbar-track {
        background: #f1f5f9;
        border-radius: 3px;
      }

      .ddddocr-dialog-body::-webkit-scrollbar-thumb {
        background: #FFB6C1;
        border-radius: 3px;
      }

      .ddddocr-dialog-body::-webkit-scrollbar-thumb:hover {
        background: #FF69B4;
      }

      .ddddocr-dialog-content {
        color: #333;
        font-size: 14px;
        line-height: 1.6;
        white-space: pre-wrap;
      }

      .ddddocr-dialog.mobile .ddddocr-dialog-content {
        font-size: 15px;
      }

      .ddddocr-dialog-footer {
        padding: 16px 24px;
        border-top: 1px solid #f1f5f9;
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        flex-shrink: 0;
      }

      .ddddocr-dialog.mobile .ddddocr-dialog-footer {
        padding: 16px 20px;
        flex-direction: column-reverse;
      }

      .ddddocr-dialog-button {
        padding: 10px 24px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s;
        -webkit-tap-highlight-color: transparent;
      }

      .ddddocr-dialog.mobile .ddddocr-dialog-button {
        padding: 14px 24px;
        font-size: 15px;
        width: 100%;
      }

      .ddddocr-dialog-button.primary {
        background: #4A90E2;
        color: white;
      }

      .ddddocr-dialog-button.primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(74, 144, 226, 0.35);
      }

      .ddddocr-dialog-button.primary:active {
        transform: translateY(0);
      }

      .ddddocr-dialog-button.secondary {
        background: #f1f5f9;
        color: #4A90E2;
      }

      .ddddocr-dialog-button.secondary:hover {
        background: #e2e8f0;
      }

      .ddddocr-dialog-button.secondary:active {
        background: #cbd5e1;
      }

      @keyframes ddddocr-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes ddddocr-scale-in {
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

  static show(options: { title: string; content: string; icon?: string; confirmText?: string; onConfirm?: () => void }): void {
    this.injectStyles();
    this.close();

    const overlay = document.createElement('div');
    overlay.className = 'ddddocr-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ddddocr-dialog';
    if (this.isMobile()) {
      dialog.classList.add('mobile');
    }

    dialog.innerHTML = `
      <div class="ddddocr-dialog-header">${options.icon || 'ℹ️'} ${options.title}</div>
      <div class="ddddocr-dialog-body">
        <div class="ddddocr-dialog-content">${options.content}</div>
      </div>
      <div class="ddddocr-dialog-footer">
        <button class="ddddocr-dialog-button primary">${options.confirmText || '确定'}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    this.container = overlay;

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

    dialog.querySelector('.ddddocr-dialog-button')?.addEventListener('click', () => {
      options.onConfirm?.();
      this.close();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
  }

  static confirm(options: { title: string; content: string; icon?: string; confirmText?: string; cancelText?: string; onConfirm?: () => void; onCancel?: () => void }): void {
    this.injectStyles();
    this.close();

    const overlay = document.createElement('div');
    overlay.className = 'ddddocr-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ddddocr-dialog';
    if (this.isMobile()) {
      dialog.classList.add('mobile');
    }

    dialog.innerHTML = `
      <div class="ddddocr-dialog-header">${options.icon || '❓'} ${options.title}</div>
      <div class="ddddocr-dialog-body">
        <div class="ddddocr-dialog-content">${options.content}</div>
      </div>
      <div class="ddddocr-dialog-footer">
        <button class="ddddocr-dialog-button secondary cancel-btn">${options.cancelText || '取消'}</button>
        <button class="ddddocr-dialog-button primary confirm-btn">${options.confirmText || '确定'}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    this.container = overlay;

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

    dialog.querySelector('.confirm-btn')?.addEventListener('click', () => {
      options.onConfirm?.();
      this.close();
    });

    dialog.querySelector('.cancel-btn')?.addEventListener('click', () => {
      options.onCancel?.();
      this.close();
    });

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