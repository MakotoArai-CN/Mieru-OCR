export class Dialog {
  private static container: HTMLDivElement | null = null;
  private static stylesInjected = false;

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
      }
      .ddddocr-dialog {
        background: white;
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        max-width: 500px;
        width: 90%;
        max-height: 80vh;
        overflow: hidden;
        animation: ddddocr-scale-in 0.3s ease;
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
      }
      .ddddocr-dialog-body {
        padding: 24px;
        max-height: calc(80vh - 140px);
        overflow-y: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .ddddocr-dialog-content {
        color: #333;
        font-size: 14px;
        line-height: 1.6;
        white-space: pre-wrap;
      }
      .ddddocr-dialog-footer {
        padding: 16px 24px;
        border-top: 1px solid #E8F0FE;
        display: flex;
        justify-content: flex-end;
        gap: 12px;
      }
      .ddddocr-dialog-button {
        padding: 10px 24px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s;
      }
      .ddddocr-dialog-button.primary {
        background: #4A90E2;
        color: white;
      }
      .ddddocr-dialog-button.primary:hover {
        background: #357ABD;
      }
      .ddddocr-dialog-button.secondary {
        background: #E8F0FE;
        color: #4A90E2;
      }
      .ddddocr-dialog-button.secondary:hover {
        background: #D0E2F5;
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

  static show(options: { title: string; content: string; icon?: string; confirmText?: string; onConfirm?: () => void }): void {
    this.injectStyles();
    this.close();

    const overlay = document.createElement('div');
    overlay.className = 'ddddocr-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ddddocr-dialog';
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
