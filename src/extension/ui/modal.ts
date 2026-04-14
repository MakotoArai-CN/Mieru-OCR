import { t } from '@core/i18n';

export interface AlertOptions {
    title?: string;
    message: string;
    confirmText?: string;
}

export interface ConfirmOptions {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
}

let activeOverlay: HTMLDivElement | null = null;

function ensureStyles(): void {
    if (document.getElementById('ddddocr-ui-modal-styles')) return;

    const style = document.createElement('style');
    style.id = 'ddddocr-ui-modal-styles';
    style.textContent = `
.ddddocr-ui-modal-overlay {
position: fixed;
inset: 0;
background: rgba(0, 0, 0, 0.55);
z-index: 2147483646;
display: flex;
align-items: center;
justify-content: center;
padding: 16px;
box-sizing: border-box;
}
.ddddocr-ui-modal {
width: min(520px, 100%);
background: var(--bg-secondary, #ffffff);
border: 1px solid var(--border, #e4e4e7);
border-radius: 14px;
box-shadow: 0 12px 40px rgba(0,0,0,0.35);
overflow: hidden;
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
.ddddocr-ui-modal-header {
display: flex;
align-items: center;
justify-content: space-between;
gap: 12px;
padding: 14px 16px;
background: var(--bg-tertiary, #f8fbff);
border-bottom: 1px solid var(--border, #e4e4e7);
}
.ddddocr-ui-modal-title {
font-size: 14px;
font-weight: 600;
color: var(--text-primary, #1a1a2e);
line-height: 1.2;
}
.ddddocr-ui-modal-close {
border: none;
background: transparent;
color: var(--text-secondary, #52525b);
cursor: pointer;
padding: 6px 8px;
border-radius: 8px;
transition: all 0.2s ease;
font-size: 18px;
line-height: 1;
}
.ddddocr-ui-modal-close:hover {
background: var(--bg-hover, #d0e2f5);
color: var(--text-primary, #1a1a2e);
}
.ddddocr-ui-modal-body {
padding: 16px;
color: var(--text-secondary, #52525b);
font-size: 13px;
line-height: 1.6;
white-space: pre-wrap;
word-break: break-word;
}
.ddddocr-ui-modal-actions {
display: flex;
justify-content: flex-end;
gap: 10px;
padding: 14px 16px;
border-top: 1px solid var(--border, #e4e4e7);
background: var(--bg-secondary, #ffffff);
}
.ddddocr-ui-modal-btn {
display: inline-flex;
align-items: center;
justify-content: center;
gap: 6px;
padding: 10px 14px;
border-radius: 10px;
font-size: 13px;
font-weight: 500;
border: 1px solid var(--border, #e4e4e7);
background: var(--bg-tertiary, #f8fbff);
color: var(--text-primary, #1a1a2e);
cursor: pointer;
transition: all 0.2s ease;
-webkit-tap-highlight-color: transparent;
min-height: 38px;
}
.ddddocr-ui-modal-btn:hover { background: var(--bg-hover, #d0e2f5); }
.ddddocr-ui-modal-btn.primary {
background: var(--primary, #4A90E2);
border-color: var(--primary, #4A90E2);
color: #fff;
}
.ddddocr-ui-modal-btn.primary:hover { background: var(--primary-hover, #357ABD); }
@media screen and (max-width: 768px) {
.ddddocr-ui-modal { border-radius: 12px; }
.ddddocr-ui-modal-actions { flex-direction: column-reverse; }
.ddddocr-ui-modal-btn { width: 100%; min-height: 44px; font-size: 14px; }
}
`;
    document.head.appendChild(style);
}

function cleanup(overlay: HTMLDivElement): void {
    try {
        overlay.remove();
    } catch { }
    if (activeOverlay === overlay) activeOverlay = null;
}

function createBaseModal(title: string): {
    overlay: HTMLDivElement;
    modal: HTMLDivElement;
    body: HTMLDivElement;
    actions: HTMLDivElement;
    closeBtn: HTMLButtonElement;
} {
    ensureStyles();

    if (activeOverlay) {
        cleanup(activeOverlay);
    }

    const overlay = document.createElement('div');
    overlay.className = 'ddddocr-ui-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'ddddocr-ui-modal';

    const header = document.createElement('div');
    header.className = 'ddddocr-ui-modal-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'ddddocr-ui-modal-title';
    titleEl.textContent = title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ddddocr-ui-modal-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '×';

    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'ddddocr-ui-modal-body';

    const actions = document.createElement('div');
    actions.className = 'ddddocr-ui-modal-actions';

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    const stopEvents = (e: Event) => e.stopPropagation();
    ['mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu', 'keydown', 'keyup', 'keypress'].forEach(evt => {
        modal.addEventListener(evt, stopEvents);
    });
    modal.addEventListener('touchstart', stopEvents, { passive: true });
    modal.addEventListener('touchmove', stopEvents, { passive: true });
    modal.addEventListener('touchend', stopEvents);

    document.body.appendChild(overlay);
    activeOverlay = overlay;

    return { overlay, modal, body, actions, closeBtn };
}

export function showAlert(options: AlertOptions): Promise<void> {
    return new Promise((resolve) => {
        const title = options.title || t('dialog.defaultTitle');
        const { overlay, body, actions, closeBtn } = createBaseModal(title);

        body.textContent = options.message;

        const okBtn = document.createElement('button');
        okBtn.className = 'ddddocr-ui-modal-btn primary';
        okBtn.type = 'button';
        okBtn.textContent = options.confirmText || t('common.confirm');

        const done = () => {
            cleanup(overlay);
            document.removeEventListener('keydown', onKeyDown, true);
            resolve();
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                done();
            }
        };

        okBtn.addEventListener('click', done);
        closeBtn.addEventListener('click', done);
        overlay.addEventListener('click', done);
        document.addEventListener('keydown', onKeyDown, true);

        actions.appendChild(okBtn);
        okBtn.focus();
    });
}

export function showConfirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
        const title = options.title || t('dialog.confirmTitle');
        const { overlay, body, actions, closeBtn } = createBaseModal(title);

        body.textContent = options.message;

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'ddddocr-ui-modal-btn';
        cancelBtn.type = 'button';
        cancelBtn.textContent = options.cancelText || t('common.cancel');

        const okBtn = document.createElement('button');
        okBtn.className = 'ddddocr-ui-modal-btn primary';
        okBtn.type = 'button';
        okBtn.textContent = options.confirmText || t('common.confirm');

        const done = (value: boolean) => {
            cleanup(overlay);
            document.removeEventListener('keydown', onKeyDown, true);
            resolve(value);
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                done(false);
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                done(true);
            }
        };

        cancelBtn.addEventListener('click', () => done(false));
        okBtn.addEventListener('click', () => done(true));
        closeBtn.addEventListener('click', () => done(false));
        overlay.addEventListener('click', () => done(false));
        document.addEventListener('keydown', onKeyDown, true);

        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        okBtn.focus();
    });
}