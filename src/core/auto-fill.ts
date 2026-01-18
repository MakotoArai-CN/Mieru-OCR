export class AutoFill {
  private lastFilledInput: HTMLInputElement | null = null;

  async fill(inputElement: HTMLInputElement, text: string, options: { simulate?: boolean; autoSubmit?: boolean } = {}): Promise<boolean> {
    const { simulate = true, autoSubmit = false } = options;

    try {
      if (!inputElement) throw new Error('未找到输入框');

      inputElement.focus();
      inputElement.value = '';
      this.dispatchEvent(inputElement, 'input');

      if (simulate) {
        await this.simulateTyping(inputElement, text);
      } else {
        inputElement.value = text;
        this.dispatchEvent(inputElement, 'input');
        this.dispatchEvent(inputElement, 'change');
      }

      this.lastFilledInput = inputElement;
      this.highlightInput(inputElement);

      if (autoSubmit) {
        await this.submitForm(inputElement);
      }

      return true;
    } catch (error) {
      console.error('填充失败', error);
      return false;
    }
  }

  private async simulateTyping(input: HTMLInputElement, text: string): Promise<void> {
    for (const char of text) {
      this.dispatchKeyEvent(input, 'keydown', char);
      input.value += char;
      this.dispatchEvent(input, 'input');
      this.dispatchKeyEvent(input, 'keyup', char);
      await this.delay(50 + Math.random() * 100);
    }
    this.dispatchEvent(input, 'change');
    this.dispatchEvent(input, 'blur');
  }

  private dispatchEvent(element: HTMLElement, eventType: string): void {
    element.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
  }

  private dispatchKeyEvent(element: HTMLElement, eventType: string, key: string): void {
    element.dispatchEvent(new KeyboardEvent(eventType, {
      key,
      code: `Key${key.toUpperCase()}`,
      charCode: key.charCodeAt(0),
      keyCode: key.charCodeAt(0),
      bubbles: true,
      cancelable: true,
    }));
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private highlightInput(input: HTMLInputElement): void {
    const originalBorder = input.style.border;
    const originalBoxShadow = input.style.boxShadow;

    input.style.border = '2px solid #4CAF50';
    input.style.boxShadow = '0 0 8px rgba(76, 175, 80, 0.5)';

    setTimeout(() => {
      input.style.border = originalBorder;
      input.style.boxShadow = originalBoxShadow;
    }, 2000);
  }

  async submitForm(input: HTMLInputElement): Promise<void> {
    const form = input.closest('form');
    if (form) {
      const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
      if (form.dispatchEvent(submitEvent)) {
        form.submit();
      }
    } else {
      const parent = input.parentElement?.parentElement || document;
      const submitBtn = parent.querySelector(
        'button[type="submit"], input[type="submit"], button:not([type])'
      ) as HTMLElement;
      if (submitBtn) {
        submitBtn.click();
      }
    }
  }

  getLastFilledInput(): HTMLInputElement | null {
    return this.lastFilledInput;
  }
}
