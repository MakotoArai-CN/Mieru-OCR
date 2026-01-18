export class LoadingIndicator {
  private container: HTMLDivElement | null = null;

  constructor() {
    this.create();
  }

  private create(): void {
    const style = document.createElement('style');
    style.textContent = `
      .ddddocr-loading-indicator {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 4px;
        z-index: 2147483647;
        overflow: hidden;
        background: linear-gradient(90deg, #4A90E2 0%, #FF69B4 25%, #87CEEB 50%, #FF69B4 75%, #4A90E2 100%);
        background-size: 200% 100%;
        animation: ddddocr-wave 3s linear infinite;
        opacity: 0;
        transition: opacity 0.3s;
      }
      .ddddocr-loading-indicator.visible { opacity: 1; }
      @keyframes ddddocr-wave {
        0% { background-position: 0% 50%; }
        100% { background-position: 200% 50%; }
      }
      .ddddocr-loading-text {
        position: fixed;
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        background: #4A90E2;
        color: white;
        padding: 6px 16px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 500;
        z-index: 2147483647;
        opacity: 0;
        transition: opacity 0.3s;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }
      .ddddocr-loading-text.visible { opacity: 1; }
    `;
    document.head.appendChild(style);

    this.container = document.createElement('div');
    this.container.className = 'ddddocr-loading-indicator';
    document.body.appendChild(this.container);

    const textEl = document.createElement('div');
    textEl.className = 'ddddocr-loading-text';
    textEl.id = 'ddddocr-loading-text';
    textEl.textContent = '正在初始化 DDDD OCR...';
    document.body.appendChild(textEl);
  }

  public show(text?: string): void {
    if (!this.container) return;
    this.container.classList.add('visible');
    const textEl = document.getElementById('ddddocr-loading-text');
    if (textEl) {
      if (text) textEl.textContent = text;
      textEl.classList.add('visible');
    }
  }

  public updateText(text: string): void {
    const textEl = document.getElementById('ddddocr-loading-text');
    if (textEl) textEl.textContent = text;
  }

  public hide(): void {
    if (!this.container) return;
    this.container.classList.remove('visible');
    const textEl = document.getElementById('ddddocr-loading-text');
    if (textEl) textEl.classList.remove('visible');
    setTimeout(() => {
      this.container?.remove();
      textEl?.remove();
      this.container = null;
    }, 300);
  }
}
