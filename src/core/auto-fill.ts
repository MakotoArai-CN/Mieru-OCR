export class AutoFill {
  private lastFilledInput: HTMLInputElement | null = null;

  async fill(
    inputElement: HTMLInputElement,
    text: string,
    options: { simulate?: boolean; autoSubmit?: boolean; typewriterEffect?: boolean; preserveFocus?: boolean } = {}
  ): Promise<boolean> {
    const { simulate = true, autoSubmit = false, typewriterEffect = true, preserveFocus = true } = options;
    try {
      if (!inputElement) throw new Error('未找到输入框');

      // Capture whatever the user is currently doing so we can restore it
      // after filling — keeps the cursor in the username field even if
      // the OCR finishes mid-typing.
      const previouslyActive = preserveFocus
        ? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
        : null;

      if (!preserveFocus) {
        inputElement.focus();
      }
      this.clearInputValue(inputElement);

      if (simulate && typewriterEffect) {
        await this.simulateTyping(inputElement, text, preserveFocus);
      } else {
        this.setInputValue(inputElement, text);
      }

      this.lastFilledInput = inputElement;
      this.highlightInput(inputElement);

      if (preserveFocus
        && previouslyActive
        && previouslyActive !== inputElement
        && document.activeElement !== previouslyActive) {
        try { previouslyActive.focus({ preventScroll: true }); } catch { /* element gone */ }
      }

      if (autoSubmit) {
        await this.submitForm(inputElement);
      }
      return true;
    } catch (error) {
      console.error('填充失败', error);
      return false;
    }
  }

  private clearInputValue(input: HTMLInputElement): void {
    this.setInputValue(input, '');
  }

  private setInputValue(input: HTMLInputElement, value: string): void {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, value);
    } else {
      input.value = value;
    }

    this.dispatchInputEvents(input);
  }

  private dispatchInputEvents(input: HTMLInputElement): void {
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: input.value,
    });
    input.dispatchEvent(inputEvent);

    this.dispatchEvent(input, 'change');

    const reactKey = Object.keys(input).find(key => 
      key.startsWith('__reactProps$') || 
      key.startsWith('__reactFiber$') ||
      key.startsWith('__reactEventHandlers$')
    );
    if (reactKey) {
      const tracker = (input as any)._valueTracker;
      if (tracker) {
        tracker.setValue('');
      }
    }

    const ngModel = (input as any).ngModel || input.getAttribute('ng-model') || input.getAttribute('[(ngModel)]');
    if (ngModel) {
      this.dispatchEvent(input, 'input');
      this.dispatchEvent(input, 'blur');
    }

    const vueKey = Object.keys(input).find(key => key.startsWith('__vue'));
    if (vueKey || input.hasAttribute('v-model')) {
      const compositionStart = new CompositionEvent('compositionstart', { bubbles: true });
      const compositionEnd = new CompositionEvent('compositionend', { bubbles: true, data: input.value });
      input.dispatchEvent(compositionStart);
      input.dispatchEvent(compositionEnd);
    }
  }

  private async simulateTyping(input: HTMLInputElement, text: string, preserveFocus = false): Promise<void> {
    for (const char of text) {
      this.dispatchKeyEvent(input, 'keydown', char);

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(input, input.value + char);
      } else {
        input.value += char;
      }

      const inputEvent = new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: char,
      });
      input.dispatchEvent(inputEvent);

      this.dispatchKeyEvent(input, 'keyup', char);
      await this.delay(50 + Math.random() * 100);
    }
    this.dispatchEvent(input, 'change');
    // Only fire blur when we actually focused the input — otherwise we'd
    // be telling listeners "input lost focus" when it never had it, and
    // some forms treat that as a validation trigger.
    if (!preserveFocus) {
      this.dispatchEvent(input, 'blur');
    }
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