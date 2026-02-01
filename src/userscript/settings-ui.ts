import { DEFAULT_CONFIG } from '@core/config';
import type { OCRConfig, CalculateRule } from '@core/types';
import { Dialog } from './dialog';
import { saveUploadedModel, deleteUploadedModel, ModelCache } from './model-loader';

const CONFIG_KEY = 'ddddocr_config';

function getConfig(): OCRConfig {
    const stored = GM_getValue(CONFIG_KEY);
    return stored ? { ...DEFAULT_CONFIG, ...stored } : DEFAULT_CONFIG;
}

function saveConfig(config: Partial<OCRConfig>): void {
    const current = getConfig();
    GM_setValue(CONFIG_KEY, { ...current, ...config });
}

function isMobile(): boolean {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
        (window.innerWidth <= 768);
}

export class SettingsUI {
    private container: HTMLDivElement | null = null;
    private overlay: HTMLDivElement | null = null;
    private isVisible = false;
    private onConfigChange: (config: OCRConfig) => void = () => { };
    private activeTab = 'general';
    private touchStartY = 0;

    constructor() {
        this.createStyles();
        this.handleResize = this.handleResize.bind(this);
    }

    private handleResize(): void {
        if (this.container) {
            this.container.classList.toggle('mobile', isMobile());
        }
    }

    private createStyles(): void {
        const style = document.createElement('style');
        style.id = 'ddddocr-settings-styles';
        style.textContent = `
      .ddddocr-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px);
        z-index: 2147483646;
        display: none;
        animation: ddddocr-fade 0.2s ease;
        -webkit-overflow-scrolling: touch;
      }
      .ddddocr-overlay.visible { display: block; }

      .ddddocr-modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 560px;
        max-width: 95vw;
        max-height: 85vh;
        background: #4A90E2;
        border-radius: 20px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        overflow: hidden;
        display: none;
        box-shadow: 0 25px 80px rgba(74, 144, 226, 0.35);
      }
      .ddddocr-modal.visible {
        display: block;
        animation: ddddocr-scale 0.3s ease;
      }
      .ddddocr-modal.mobile {
        width: 100%;
        max-width: 100%;
        height: 100%;
        max-height: 100%;
        top: 0;
        left: 0;
        transform: none;
        border-radius: 0;
      }

      @keyframes ddddocr-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes ddddocr-scale {
        from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
        to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      .ddddocr-modal.mobile.visible {
        animation: ddddocr-slide-up 0.3s ease;
      }
      @keyframes ddddocr-slide-up {
        from { opacity: 0; transform: translateY(100%); }
        to { opacity: 1; transform: translateY(0); }
      }

      .ddddocr-header {
        background: rgba(255, 255, 255, 0.15);
        padding: 20px 24px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid rgba(255, 255, 255, 0.15);
      }
      .ddddocr-modal.mobile .ddddocr-header {
        padding: 16px;
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .ddddocr-title {
        color: white;
        font-size: 20px;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 10px;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      }
      .ddddocr-modal.mobile .ddddocr-title {
        font-size: 18px;
      }
      .ddddocr-close {
        width: 36px;
        height: 36px;
        min-width: 36px;
        min-height: 36px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.25);
        border: none;
        color: white;
        font-size: 24px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        -webkit-tap-highlight-color: transparent;
      }
      .ddddocr-close:hover { background: rgb(242, 0, 105); }
      .ddddocr-close:active { background: rgba(255, 255, 255, 0.5); }
      .ddddocr-modal.mobile .ddddocr-close {
        width: 44px;
        height: 44px;
        min-width: 44px;
        min-height: 44px;
      }

      .ddddocr-tabs {
        display: flex;
        background: rgba(255, 255, 255, 0.1);
        padding: 0 16px;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .ddddocr-tabs::-webkit-scrollbar { display: none; }
      .ddddocr-modal.mobile .ddddocr-tabs {
        padding: 0 8px;
        position: sticky;
        top: 76px;
        z-index: 10;
      }
      .ddddocr-tab {
        padding: 14px 16px;
        color: rgba(255, 255, 255, 0.8);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        background: none;
        position: relative;
        transition: all 0.2s;
        white-space: nowrap;
        -webkit-tap-highlight-color: transparent;
      }
      .ddddocr-modal.mobile .ddddocr-tab {
        padding: 12px 14px;
        font-size: 14px;
        min-height: 48px;
      }
      .ddddocr-tab:hover { color: white; }
      .ddddocr-tab.active { color: white; }
      .ddddocr-tab.active::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 30px;
        height: 3px;
        background: white;
        border-radius: 3px 3px 0 0;
      }

      .ddddocr-content {
        background: #f8fafc;
        padding: 24px;
        max-height: calc(85vh - 180px);
        overflow-y: auto;
        overflow-x: hidden;
        -webkit-overflow-scrolling: touch;
      }
      .ddddocr-modal.mobile .ddddocr-content {
        padding: 16px;
        max-height: none;
        height: calc(100% - 140px);
        padding-bottom: 100px;
      }
      .ddddocr-content::-webkit-scrollbar {
        width: 6px;
      }
      .ddddocr-content::-webkit-scrollbar-track {
        background: #f1f5f9;
        border-radius: 3px;
      }
      .ddddocr-content::-webkit-scrollbar-thumb {
        background: #FFB6C1;
        border-radius: 3px;
      }
      .ddddocr-content::-webkit-scrollbar-thumb:hover {
        background: #FF69B4;
      }

      .ddddocr-panel { display: none; }
      .ddddocr-panel.active { display: block; }

      .ddddocr-card {
        background: white;
        border-radius: 16px;
        padding: 20px;
        margin-bottom: 16px;
        box-shadow: 0 2px 12px rgba(74, 144, 226, 0.08);
        border: 1px solid rgba(74, 144, 226, 0.06);
      }
      .ddddocr-modal.mobile .ddddocr-card {
        padding: 16px;
        border-radius: 12px;
      }
      .ddddocr-card-title {
        font-size: 15px;
        font-weight: 600;
        color: #1e293b;
        margin-bottom: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .ddddocr-card-title::before {
        content: '';
        width: 4px;
        height: 16px;
        background: #4A90E2;
        border-radius: 2px;
      }

      .ddddocr-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 0;
        border-bottom: 1px solid #f1f5f9;
        gap: 12px;
      }
      .ddddocr-modal.mobile .ddddocr-row {
        padding: 16px 0;
      }
      .ddddocr-row:last-child { border-bottom: none; }
      .ddddocr-row-info { flex: 1; min-width: 0; }
      .ddddocr-row-label { font-size: 14px; color: #334155; font-weight: 500; }
      .ddddocr-modal.mobile .ddddocr-row-label { font-size: 15px; }
      .ddddocr-row-desc { font-size: 12px; color: #94a3b8; margin-top: 2px; }
      .ddddocr-modal.mobile .ddddocr-row-desc { font-size: 13px; }

      .ddddocr-switch {
        position: relative;
        width: 48px;
        height: 26px;
        min-width: 48px;
        background: #e2e8f0;
        border-radius: 13px;
        cursor: pointer;
        transition: background 0.3s;
        -webkit-tap-highlight-color: transparent;
      }
      .ddddocr-modal.mobile .ddddocr-switch {
        width: 56px;
        height: 32px;
        min-width: 56px;
      }
      .ddddocr-switch.on { background: #4A90E2; }
      .ddddocr-switch-knob {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        background: white;
        border-radius: 50%;
        transition: transform 0.3s;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
      }
      .ddddocr-modal.mobile .ddddocr-switch-knob {
        width: 26px;
        height: 26px;
      }
      .ddddocr-switch.on .ddddocr-switch-knob { transform: translateX(22px); }
      .ddddocr-modal.mobile .ddddocr-switch.on .ddddocr-switch-knob { transform: translateX(24px); }

      .ddddocr-input {
        width: 100%;
        padding: 12px 14px;
        border: 2px solid #e2e8f0;
        border-radius: 10px;
        font-size: 14px;
        transition: all 0.2s;
        margin-top: 8px;
        box-sizing: border-box;
      }
      .ddddocr-modal.mobile .ddddocr-input {
        padding: 14px 16px;
        font-size: 16px;
        border-radius: 12px;
      }
      .ddddocr-input:focus { outline: none; border-color: #4A90E2; box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.15); }

      .ddddocr-select {
        width: 100%;
        padding: 12px 14px;
        border: 2px solid #e2e8f0;
        border-radius: 10px;
        font-size: 14px;
        transition: all 0.2s;
        margin-top: 8px;
        box-sizing: border-box;
        background: white;
        cursor: pointer;
      }
      .ddddocr-modal.mobile .ddddocr-select {
        padding: 14px 16px;
        font-size: 16px;
        border-radius: 12px;
      }
      .ddddocr-select:focus { outline: none; border-color: #4A90E2; }

      .ddddocr-textarea {
        width: 100%;
        padding: 12px 14px;
        border: 2px solid #e2e8f0;
        border-radius: 10px;
        font-size: 13px;
        font-family: 'Monaco', 'Consolas', monospace;
        min-height: 100px;
        resize: vertical;
        transition: all 0.2s;
        margin-top: 8px;
        box-sizing: border-box;
      }
      .ddddocr-modal.mobile .ddddocr-textarea {
        padding: 14px 16px;
        font-size: 14px;
        min-height: 120px;
        border-radius: 12px;
      }
      .ddddocr-textarea:focus { outline: none; border-color: #4A90E2; box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.15); }

      .ddddocr-file-zone {
        border: 2px dashed #d1e3f6;
        border-radius: 12px;
        padding: 24px;
        text-align: center;
        cursor: pointer;
        transition: all 0.2s;
        margin-top: 12px;
        background: rgba(74, 144, 226, 0.02);
        -webkit-tap-highlight-color: transparent;
      }
      .ddddocr-file-zone:hover { border-color: #4A90E2; background: rgba(74, 144, 226, 0.05); }
      .ddddocr-file-zone:active { background: rgba(74, 144, 226, 0.1); }
      .ddddocr-file-zone input { display: none; }
      .ddddocr-file-icon { font-size: 32px; margin-bottom: 8px; }
      .ddddocr-file-text { font-size: 13px; color: #64748b; }
      .ddddocr-file-name { font-size: 12px; color: #4A90E2; margin-top: 8px; font-weight: 500; }

      .ddddocr-btn-group { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
      .ddddocr-btn {
        flex: 1;
        min-width: 100px;
        padding: 12px 20px;
        border: none;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        -webkit-tap-highlight-color: transparent;
      }
      .ddddocr-modal.mobile .ddddocr-btn {
        padding: 14px 20px;
        font-size: 15px;
        min-height: 48px;
      }
      .ddddocr-btn-primary {
        background: #4A90E2;
        color: white;
      }
      .ddddocr-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(74, 144, 226, 0.35); }
      .ddddocr-btn-primary:active { transform: translateY(0); }
      .ddddocr-btn-secondary { background: #f1f5f9; color: #475569; }
      .ddddocr-btn-secondary:hover { background: #e2e8f0; }
      .ddddocr-btn-secondary:active { background: #cbd5e1; }
      .ddddocr-btn-danger { background: #fee2e2; color: #dc2626; }
      .ddddocr-btn-danger:hover { background: #fecaca; }
      .ddddocr-btn-danger:active { background: #fca5a5; }
      .ddddocr-btn-sm { padding: 8px 14px; font-size: 12px; flex: none; min-width: auto; }
      .ddddocr-modal.mobile .ddddocr-btn-sm {
        padding: 10px 16px;
        font-size: 13px;
        min-height: 40px;
      }

      .ddddocr-hint {
        background: rgba(74, 144, 226, 0.08);
        border: 1px solid rgba(74, 144, 226, 0.15);
        border-radius: 10px;
        padding: 12px 14px;
        font-size: 12px;
        color: #64748b;
        margin-top: 12px;
      }
      .ddddocr-modal.mobile .ddddocr-hint {
        font-size: 13px;
        padding: 14px 16px;
      }

      .ddddocr-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: rgba(255, 182, 193, 0.2);
        color: #4A90E2;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 500;
        margin-bottom: 12px;
        border: 1px solid rgba(255, 182, 193, 0.4);
      }

      .ddddocr-rule-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px;
        background: #f8fafc;
        border-radius: 10px;
        margin-bottom: 8px;
        border: 1px solid rgba(74, 144, 226, 0.08);
      }
      .ddddocr-modal.mobile .ddddocr-rule-item {
        flex-wrap: wrap;
        padding: 14px;
      }
      .ddddocr-rule-item:last-child { margin-bottom: 0; }
      .ddddocr-rule-pattern { flex: 1; font-family: monospace; font-size: 13px; color: #334155; word-break: break-all; min-width: 0; }
      .ddddocr-rule-type { font-size: 11px; padding: 4px 8px; background: #e2e8f0; border-radius: 4px; color: #64748b; white-space: nowrap; }
      .ddddocr-rule-output { font-size: 11px; padding: 4px 8px; background: #dbeafe; border-radius: 4px; color: #4A90E2; white-space: nowrap; }
      .ddddocr-rule-delete {
        background: none;
        border: none;
        color: #ef4444;
        cursor: pointer;
        font-size: 16px;
        padding: 8px;
        min-width: 32px;
        min-height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        -webkit-tap-highlight-color: transparent;
      }

      .ddddocr-empty { text-align: center; padding: 24px; color: #94a3b8; font-size: 13px; }

      .ddddocr-add-rule { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
      .ddddocr-add-rule input { flex: 2; min-width: 120px; }
      .ddddocr-add-rule select { flex: 1; min-width: 80px; }
      .ddddocr-modal.mobile .ddddocr-add-rule {
        flex-direction: column;
      }
      .ddddocr-modal.mobile .ddddocr-add-rule input,
      .ddddocr-modal.mobile .ddddocr-add-rule select {
        width: 100%;
        flex: none;
      }

      .ddddocr-save-float {
        display: none;
      }
      .ddddocr-modal.mobile .ddddocr-save-float {
        display: block;
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        padding: 16px;
        background: white;
        box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.1);
        z-index: 100;
      }
      .ddddocr-modal.mobile .ddddocr-save-float .ddddocr-btn {
        width: 100%;
      }
      .ddddocr-modal.mobile .ddddocr-tabs .ddddocr-btn {
        display: none;
      }
    `;

        if (!document.getElementById('ddddocr-settings-styles')) {
            document.head.appendChild(style);
        }
    }

    private async createContainer(): Promise<void> {
        this.overlay = document.createElement('div');
        this.overlay.className = 'ddddocr-overlay';

        this.container = document.createElement('div');
        this.container.className = 'ddddocr-modal';

        if (isMobile()) {
            this.container.classList.add('mobile');
        }

        const config = getConfig();

        let hasUploadedModel = false;
        let uploadedModelSize = 0;

        try {
            const cache = new ModelCache();
            const uploadedModel = await cache.getUploadedModel();
            if (uploadedModel) {
                hasUploadedModel = true;
                uploadedModelSize = uploadedModel.model.byteLength;
            }
        } catch (e) {
            console.warn('Failed to load uploaded model info:', e);
        }

        const rulesHtml = this.renderCalculateRules(config.calculateRules || []);

        this.container.innerHTML = `
      <div class="ddddocr-header">
        <div class="ddddocr-title">⚡ DDDD OCR 设置</div>
        <button class="ddddocr-close">×</button>
      </div>
      <div class="ddddocr-tabs">
        <button class="ddddocr-tab active" data-tab="general">基本设置</button>
        <button class="ddddocr-tab" data-tab="calculate">四则运算</button>
        <button class="ddddocr-tab" data-tab="model">模型管理</button>
        <button class="ddddocr-tab" data-tab="whitelist">站点白名单</button>
        <button class="ddddocr-btn ddddocr-btn-primary" id="saveBtn">保存</button>
      </div>
      <div class="ddddocr-content">
        <div class="ddddocr-panel active" data-panel="general">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">检测与填充</div>
              <div class="ddddocr-row">
                <div class="ddddocr-row-info">
                  <div class="ddddocr-row-label">自动检测并填充</div>
                  <div class="ddddocr-row-desc">自动识别页面验证码并填充结果</div>
                </div>
                <div class="ddddocr-switch ${config.autoDetect ? 'on' : ''}" data-key="autoDetect">
                  <div class="ddddocr-switch-knob"></div>
                </div>
              </div>
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">打字机效果</div>
                <div class="ddddocr-row-desc">模拟人工逐字输入，关闭则一次性填充</div>
              </div>
              <div class="ddddocr-switch ${config.typewriterEffect ? 'on' : ''}" data-key="typewriterEffect">
                <div class="ddddocr-switch-knob"></div>
              </div>
            </div>
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">自动勾选协议</div>
                <div class="ddddocr-row-desc">自动勾选用户协议、隐私政策等复选框</div>
              </div>
              <div class="ddddocr-switch ${config.autoCheckAgreement ? 'on' : ''}" data-key="autoCheckAgreement">
                <div class="ddddocr-switch-knob"></div>
              </div>
            </div>
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">系统通知</div>
                <div class="ddddocr-row-desc">识别完成后显示桌面通知提醒</div>
              </div>
              <div class="ddddocr-switch ${config.enableNotification ? 'on' : ''}" data-key="enableNotification">
                <div class="ddddocr-switch-knob"></div>
              </div>
            </div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">自定义选择器</div>
            <div class="ddddocr-row-label">验证码选择器</div>
            <input type="text" class="ddddocr-input" data-key="captchaSelector" placeholder="img.captcha 或 #captchaImg" value="${config.captchaSelector || ''}">
            <div class="ddddocr-row-label" style="margin-top: 12px;">输入框选择器</div>
            <input type="text" class="ddddocr-input" data-key="inputSelector" placeholder="input#code 或 .captcha-input" value="${config.inputSelector || ''}">
            <div class="ddddocr-hint">留空则自动检测页面中的验证码元素</div>
          </div>
        </div>
        <div class="ddddocr-panel" data-panel="calculate">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">四则运算识别</div>
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">自动计算结果</div>
                <div class="ddddocr-row-desc">识别到 "3+5=?" 自动计算并填充</div>
              </div>
              <div class="ddddocr-switch ${config.autoCalculate ? 'on' : ''}" data-key="autoCalculate">
                <div class="ddddocr-switch-knob"></div>
              </div>
            </div>
            <div id="calculateOptionsArea" style="display: ${config.autoCalculate ? 'block' : 'none'}">
              <div class="ddddocr-row-label" style="margin-top: 16px;">默认输出格式</div>
              <select class="ddddocr-select" data-key="calculateOutputMode">
                <option value="result" ${config.calculateOutputMode === 'result' ? 'selected' : ''}>仅结果 (如: 8)</option>
                <option value="equation" ${config.calculateOutputMode === 'equation' ? 'selected' : ''}>完整等式 (如: 3+5=8)</option>
              </select>
              <div class="ddddocr-hint">可为不同站点配置不同的输出格式</div>
            </div>
          </div>
          <div class="ddddocr-card" id="calculateRulesCard" style="display: ${config.autoCalculate ? 'block' : 'none'}">
            <div class="ddddocr-card-title">站点规则</div>
            <div id="calculateRulesList">${rulesHtml}</div>
            <div class="ddddocr-add-rule">
              <input type="text" class="ddddocr-input" id="newRulePattern" placeholder="站点匹配 (如: *.example.com)" style="margin-top:0">
              <select class="ddddocr-select" id="newRuleMatchType" style="margin-top:0">
                <option value="wildcard">通配符</option>
                <option value="regex">正则表达式</option>
              </select>
              <select class="ddddocr-select" id="newRuleOutputMode" style="margin-top:0">
                <option value="result">仅结果</option>
                <option value="equation">完整等式</option>
              </select>
              <button class="ddddocr-btn ddddocr-btn-primary ddddocr-btn-sm" id="addRuleBtn">添加</button>
            </div>
            <div class="ddddocr-hint">
              <b>通配符:</b> * 匹配任意字符，? 匹配单个字符<br>
              <b>正则:</b> 使用标准正则表达式语法
            </div>
          </div>
        </div>
        <div class="ddddocr-panel" data-panel="model">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">模型来源</div>
            ${hasUploadedModel ? `<div class="ddddocr-badge">✓ 已上传本地模型 (${(uploadedModelSize / 1024 / 1024).toFixed(1)} MB)</div>` : ''}
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">使用上传的模型</div>
                <div class="ddddocr-row-desc">优先使用本地上传的模型文件</div>
              </div>
              <div class="ddddocr-switch ${config.useUploadedModel ? 'on' : ''}" data-key="useUploadedModel">
                <div class="ddddocr-switch-knob"></div>
              </div>
            </div>
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">自动下载模型</div>
                <div class="ddddocr-row-desc">首次使用时自动从网络下载模型</div>
              </div>
              <div class="ddddocr-switch ${config.autoDownload ? 'on' : ''}" data-key="autoDownload">
                <div class="ddddocr-switch-knob"></div>
              </div>
            </div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">上传模型文件</div>
            <div class="ddddocr-file-zone" id="modelZone">
              <input type="file" id="modelFile" accept=".onnx">
              <div class="ddddocr-file-icon">📦</div>
              <div class="ddddocr-file-text">点击上传 common.onnx</div>
              <div class="ddddocr-file-name" id="modelName"></div>
            </div>
            <div class="ddddocr-file-zone" id="charsetsZone" style="margin-top: 12px;">
              <input type="file" id="charsetsFile" accept=".json">
              <div class="ddddocr-file-icon">📄</div>
              <div class="ddddocr-file-text">点击上传 charsets.json</div>
              <div class="ddddocr-file-name" id="charsetsName"></div>
            </div>
            <div class="ddddocr-btn-group">
              <button class="ddddocr-btn ddddocr-btn-primary" id="uploadBtn">保存模型</button>
              <button class="ddddocr-btn ddddocr-btn-danger" id="deleteModelBtn">删除模型</button>
            </div>
          </div>
        </div>
        <div class="ddddocr-panel" data-panel="whitelist">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">白名单设置</div>
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">启用站点白名单</div>
                <div class="ddddocr-row-desc">仅在白名单站点启用脚本功能</div>
              </div>
              <div class="ddddocr-switch ${config.enableWhitelist ? 'on' : ''}" data-key="enableWhitelist">
                <div class="ddddocr-switch-knob"></div>
              </div>
            </div>
            <div id="whitelistArea" style="display: ${config.enableWhitelist ? 'block' : 'none'}">
              <textarea class="ddddocr-textarea" data-key="whitelist" placeholder="每行一个域名，支持通配符&#10;example.com&#10;*.example.com&#10;sub.example.com">${(config.whitelist || []).join('\n')}</textarea>
              <div class="ddddocr-hint">当前站点: ${window.location.hostname}</div>
            </div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">配置导入导出</div>
            <div class="ddddocr-btn-group">
              <button class="ddddocr-btn ddddocr-btn-secondary" id="exportBtn">导出配置</button>
              <button class="ddddocr-btn ddddocr-btn-secondary" id="importBtn">导入配置</button>
              <button class="ddddocr-btn ddddocr-btn-danger" id="resetBtn">重置设置</button>
            </div>
          </div>
        </div>
      </div>
      <div class="ddddocr-save-float">
        <button class="ddddocr-btn ddddocr-btn-primary" id="saveBtnFloat">保存设置</button>
      </div>
    `;

        document.body.appendChild(this.overlay);
        document.body.appendChild(this.container);

        this.bindEvents();
        window.addEventListener('resize', this.handleResize);
    }

    private renderCalculateRules(rules: CalculateRule[]): string {
        if (!rules || rules.length === 0) {
            return '<div class="ddddocr-empty">暂无规则，将使用默认输出格式</div>';
        }

        return rules.map((rule, index) => `
      <div class="ddddocr-rule-item" data-index="${index}">
        <span class="ddddocr-rule-pattern">${this.escapeHtml(rule.pattern)}</span>
        <span class="ddddocr-rule-type">${rule.matchType === 'regex' ? '正则' : '通配符'}</span>
        <span class="ddddocr-rule-output">${rule.outputMode === 'result' ? '仅结果' : '完整等式'}</span>
        <button class="ddddocr-rule-delete" data-index="${index}">×</button>
      </div>
    `).join('');
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    private stopPropagation(e: Event): void {
        e.stopPropagation();
    }

    private bindEvents(): void {
        if (!this.container || !this.overlay) return;

        this.container.addEventListener('mousedown', this.stopPropagation);
        this.container.addEventListener('mouseup', this.stopPropagation);
        this.container.addEventListener('click', this.stopPropagation);
        this.container.addEventListener('dblclick', this.stopPropagation);
        this.container.addEventListener('wheel', this.stopPropagation);
        this.container.addEventListener('keydown', this.stopPropagation);
        this.container.addEventListener('keyup', this.stopPropagation);
        this.container.addEventListener('keypress', this.stopPropagation);
        this.container.addEventListener('contextmenu', this.stopPropagation);
        this.container.addEventListener('touchstart', this.stopPropagation, { passive: true });
        this.container.addEventListener('touchmove', this.stopPropagation, { passive: true });
        this.container.addEventListener('touchend', this.stopPropagation);

        this.container.querySelector('.ddddocr-close')?.addEventListener('click', () => this.hide());
        this.overlay.addEventListener('click', () => this.hide());
        this.container.querySelector('#cancelBtn')?.addEventListener('click', () => this.hide());

        this.container.querySelectorAll('.ddddocr-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = (tab as HTMLElement).dataset.tab!;
                this.switchTab(tabName);
            });
        });

        this.container.querySelectorAll('.ddddocr-switch').forEach(sw => {
            const handleToggle = () => {
                sw.classList.toggle('on');

                const key = (sw as HTMLElement).dataset.key;

                if (key === 'enableWhitelist') {
                    const area = this.container!.querySelector('#whitelistArea') as HTMLElement;
                    area.style.display = sw.classList.contains('on') ? 'block' : 'none';
                }

                if (key === 'autoCalculate') {
                    const optionsArea = this.container!.querySelector('#calculateOptionsArea') as HTMLElement;
                    const rulesCard = this.container!.querySelector('#calculateRulesCard') as HTMLElement;
                    const show = sw.classList.contains('on');
                    optionsArea.style.display = show ? 'block' : 'none';
                    rulesCard.style.display = show ? 'block' : 'none';
                }
            };

            sw.addEventListener('click', handleToggle);
        });

        const modelZone = this.container.querySelector('#modelZone') as HTMLElement;
        const modelInput = this.container.querySelector('#modelFile') as HTMLInputElement;
        const modelName = this.container.querySelector('#modelName') as HTMLElement;

        modelZone.addEventListener('click', () => modelInput.click());
        modelInput.addEventListener('change', () => {
            if (modelInput.files?.[0]) {
                modelName.textContent = `✓ ${modelInput.files[0].name}`;
            }
        });

        const charsetsZone = this.container.querySelector('#charsetsZone') as HTMLElement;
        const charsetsInput = this.container.querySelector('#charsetsFile') as HTMLInputElement;
        const charsetsName = this.container.querySelector('#charsetsName') as HTMLElement;

        charsetsZone.addEventListener('click', () => charsetsInput.click());
        charsetsInput.addEventListener('change', () => {
            if (charsetsInput.files?.[0]) {
                charsetsName.textContent = `✓ ${charsetsInput.files[0].name}`;
            }
        });

        this.container.querySelector('#uploadBtn')?.addEventListener('click', async () => {
            const modelFile = modelInput.files?.[0];
            const charsetsFile = charsetsInput.files?.[0];

            if (!modelFile || !charsetsFile) {
                Dialog.show({ title: '提示', content: '请选择模型文件和字符集文件', icon: '⚠️' });
                return;
            }

            try {
                await saveUploadedModel(modelFile, charsetsFile);
                saveConfig({ useUploadedModel: true });
                Dialog.show({ title: '成功', content: '模型已保存，请刷新页面', icon: '✅' });
            } catch (e) {
                Dialog.show({ title: '错误', content: String(e), icon: '❌' });
            }
        });

        this.container.querySelector('#deleteModelBtn')?.addEventListener('click', () => {
            Dialog.confirm({
                title: '删除模型',
                content: '确定删除已上传的模型吗？',
                icon: '🗑️',
                onConfirm: async () => {
                    await deleteUploadedModel();
                    saveConfig({ useUploadedModel: false });
                    Dialog.show({ title: '成功', content: '模型已删除', icon: '✅' });
                },
            });
        });

        this.container.querySelector('#exportBtn')?.addEventListener('click', () => {
            const config = getConfig();
            const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'ddddocr-config.json';
            a.click();
            URL.revokeObjectURL(url);
        });

        this.container.querySelector('#importBtn')?.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = async (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (!file) return;
                try {
                    const text = await file.text();
                    const config = JSON.parse(text);
                    saveConfig(config);
                    Dialog.show({ title: '成功', content: '配置已导入，请刷新页面', icon: '✅' });
                } catch {
                    Dialog.show({ title: '错误', content: '配置文件格式错误', icon: '❌' });
                }
            };
            input.click();
        });

        this.container.querySelector('#resetBtn')?.addEventListener('click', () => {
            Dialog.confirm({
                title: '重置设置',
                content: '确定重置所有设置吗？',
                icon: '⚠️',
                onConfirm: () => {
                    GM_setValue(CONFIG_KEY, DEFAULT_CONFIG);
                    Dialog.show({ title: '成功', content: '设置已重置，请刷新页面', icon: '✅' });
                },
            });
        });

        this.container.querySelector('#addRuleBtn')?.addEventListener('click', () => this.addCalculateRule());
        this.bindRuleDeleteEvents();

        this.container.querySelector('#saveBtn')?.addEventListener('click', () => this.saveSettings());
        this.container.querySelector('#saveBtnFloat')?.addEventListener('click', () => this.saveSettings());
    }

    private bindRuleDeleteEvents(): void {
        this.container?.querySelectorAll('.ddddocr-rule-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt((e.target as HTMLElement).dataset.index || '0');
                this.deleteCalculateRule(index);
            });
        });
    }

    private addCalculateRule(): void {
        const patternInput = this.container?.querySelector('#newRulePattern') as HTMLInputElement;
        const matchTypeSelect = this.container?.querySelector('#newRuleMatchType') as HTMLSelectElement;
        const outputModeSelect = this.container?.querySelector('#newRuleOutputMode') as HTMLSelectElement;

        const pattern = patternInput.value.trim();
        if (!pattern) {
            Dialog.show({ title: '提示', content: '请输入站点匹配规则', icon: '⚠️' });
            return;
        }

        const config = getConfig();
        const rules: CalculateRule[] = config.calculateRules || [];

        rules.push({
            pattern,
            matchType: matchTypeSelect.value as 'wildcard' | 'regex',
            outputMode: outputModeSelect.value as 'result' | 'equation',
            enabled: true,
        });

        saveConfig({ calculateRules: rules });

        const rulesList = this.container?.querySelector('#calculateRulesList') as HTMLElement;
        rulesList.innerHTML = this.renderCalculateRules(rules);
        this.bindRuleDeleteEvents();

        patternInput.value = '';
    }

    private deleteCalculateRule(index: number): void {
        const config = getConfig();
        const rules: CalculateRule[] = config.calculateRules || [];
        rules.splice(index, 1);
        saveConfig({ calculateRules: rules });

        const rulesList = this.container?.querySelector('#calculateRulesList') as HTMLElement;
        rulesList.innerHTML = this.renderCalculateRules(rules);
        this.bindRuleDeleteEvents();
    }

    private switchTab(tabName: string): void {
        if (!this.container) return;

        this.activeTab = tabName;

        this.container.querySelectorAll('.ddddocr-tab').forEach(tab => {
            tab.classList.toggle('active', (tab as HTMLElement).dataset.tab === tabName);
        });

        this.container.querySelectorAll('.ddddocr-panel').forEach(panel => {
            panel.classList.toggle('active', (panel as HTMLElement).dataset.panel === tabName);
        });
    }

    private saveSettings(): void {
        if (!this.container) return;

        const config: Partial<OCRConfig> = {};

        this.container.querySelectorAll('.ddddocr-switch').forEach(sw => {
            const key = (sw as HTMLElement).dataset.key;
            if (key) {
                (config as any)[key] = sw.classList.contains('on');
            }
        });

        this.container.querySelectorAll('input[data-key]').forEach(input => {
            const key = (input as HTMLInputElement).dataset.key;
            if (key) {
                (config as any)[key] = (input as HTMLInputElement).value.trim();
            }
        });

        this.container.querySelectorAll('select[data-key]').forEach(select => {
            const key = (select as HTMLSelectElement).dataset.key;
            if (key) {
                (config as any)[key] = (select as HTMLSelectElement).value;
            }
        });

        this.container.querySelectorAll('textarea[data-key]').forEach(textarea => {
            const key = (textarea as HTMLTextAreaElement).dataset.key;
            if (key) {
                const value = (textarea as HTMLTextAreaElement).value;
                (config as any)[key] = value.split('\n').filter(line => line.trim());
            }
        });

        saveConfig(config);
        this.onConfigChange(getConfig());

        if (typeof GM_notification !== 'undefined') {
            GM_notification({ title: '设置已保存', text: '配置已成功保存', timeout: 2000 });
        }

        this.hide();
    }

    public async show(): Promise<void> {
        if (!this.container) await this.createContainer();

        this.isVisible = true;
        this.overlay?.classList.add('visible');
        this.container?.classList.add('visible');

        if (isMobile()) {
            this.container?.classList.add('mobile');
            document.body.style.overflow = 'hidden';
        }
    }

    public hide(): void {
        this.isVisible = false;
        this.overlay?.classList.remove('visible');
        this.container?.classList.remove('visible');
        document.body.style.overflow = '';
        window.removeEventListener('resize', this.handleResize);
    }

    public setOnConfigChange(callback: (config: OCRConfig) => void): void {
        this.onConfigChange = callback;
    }
}