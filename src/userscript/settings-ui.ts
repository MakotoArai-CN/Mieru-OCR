import { DEFAULT_CONFIG, getThemeColors } from '@core/config';
import type { OCRConfig } from '@core/types';
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

export class SettingsUI {
  private container: HTMLDivElement | null = null;
  private isVisible = false;
  private onConfigChange: (config: OCRConfig) => void = () => {};

  constructor() {
    this.createStyles();
  }

  private createStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      .ddddocr-settings-container {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 480px;
        max-height: 80vh;
        background: #FFFFFF;
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        overflow: hidden;
        display: none;
      }
      .ddddocr-settings-header {
        background: #4A90E2;
        color: white;
        padding: 20px 24px;
        font-size: 18px;
        font-weight: 600;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .ddddocr-settings-close {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.2);
        border: none;
        color: white;
        font-size: 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.3s;
      }
      .ddddocr-settings-close:hover { background: rgba(255, 255, 255, 0.3); }
      .ddddocr-settings-body {
        padding: 24px;
        max-height: calc(80vh - 80px);
        overflow-y: auto;
      }
      .ddddocr-setting-group {
        margin-bottom: 24px;
        padding: 16px;
        background: #F8FBFF;
        border-radius: 12px;
        border: 1px solid #E8F0FE;
      }
      .ddddocr-setting-group-title {
        font-size: 14px;
        font-weight: 600;
        color: #4A90E2;
        margin-bottom: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .ddddocr-setting-item {
        margin-bottom: 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .ddddocr-setting-item:last-child { margin-bottom: 0; }
      .ddddocr-setting-label { font-size: 14px; color: #333; flex: 1; }
      .ddddocr-setting-desc { font-size: 12px; color: #666; margin-top: 4px; }
      .ddddocr-switch {
        position: relative;
        width: 48px;
        height: 24px;
        background: #CBD5E0;
        border-radius: 12px;
        cursor: pointer;
        transition: background 0.3s;
      }
      .ddddocr-switch.active { background: #FF69B4; }
      .ddddocr-switch-slider {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 20px;
        height: 20px;
        background: white;
        border-radius: 50%;
        transition: transform 0.3s;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      }
      .ddddocr-switch.active .ddddocr-switch-slider { transform: translateX(24px); }
      .ddddocr-input {
        padding: 8px 12px;
        border: 2px solid #E8F0FE;
        border-radius: 8px;
        font-size: 14px;
        width: 100%;
        margin-top: 8px;
        transition: border-color 0.3s;
      }
      .ddddocr-input:focus { outline: none; border-color: #4A90E2; }
      .ddddocr-file-input { display: none; }
      .ddddocr-file-label {
        display: inline-block;
        padding: 8px 16px;
        background: #E8F0FE;
        color: #4A90E2;
        border-radius: 8px;
        font-size: 13px;
        cursor: pointer;
        transition: background 0.3s;
        margin-top: 8px;
      }
      .ddddocr-file-label:hover { background: #D0E2F5; }
      .ddddocr-file-name { font-size: 12px; color: #666; margin-top: 6px; }
      .ddddocr-textarea {
        padding: 8px 12px;
        border: 2px solid #E8F0FE;
        border-radius: 8px;
        font-size: 14px;
        width: 100%;
        margin-top: 8px;
        min-height: 80px;
        resize: vertical;
        font-family: 'Courier New', monospace;
        transition: border-color 0.3s;
      }
      .ddddocr-textarea:focus { outline: none; border-color: #4A90E2; }
      .ddddocr-button {
        padding: 10px 20px;
        background: #4A90E2;
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.3s;
      }
      .ddddocr-button:hover { background: #357ABD; }
      .ddddocr-button.secondary { background: #FF69B4; }
      .ddddocr-button.secondary:hover { background: #FF1493; }
      .ddddocr-button.danger { background: #E74C3C; }
      .ddddocr-button.danger:hover { background: #C0392B; }
      .ddddocr-button-group { display: flex; gap: 12px; margin-top: 16px; }
      .ddddocr-info {
        padding: 12px;
        background: #FFF0F5;
        border: 1px solid #FFB6C1;
        border-radius: 8px;
        font-size: 12px;
        color: #666;
        margin-top: 12px;
      }
      .ddddocr-settings-visible { display: block !important; animation: ddddocr-fade-in 0.3s ease; }
      @keyframes ddddocr-fade-in {
        from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
        to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
    `;
    document.head.appendChild(style);
  }

  private async createContainer(): Promise<void> {
    this.container = document.createElement('div');
    this.container.className = 'ddddocr-settings-container';
    const config = getConfig();
    const cache = new ModelCache();
    const uploadedModel = await cache.getUploadedModel();
    const hasUploadedModel = !!uploadedModel;

    this.container.innerHTML = `
      <div class="ddddocr-settings-header">
        <span>🔧 DDDD OCR 设置</span>
        <button class="ddddocr-settings-close">×</button>
      </div>
      <div class="ddddocr-settings-body">
        <div class="ddddocr-setting-group">
          <div class="ddddocr-setting-group-title">模型设置</div>
          ${hasUploadedModel ? `<div class="ddddocr-info" style="background: #E8F5E9; border-color: #4CAF50; margin-bottom: 12px;">✅ 已上传模型: ${(uploadedModel.model.byteLength / 1024 / 1024).toFixed(2)} MB</div>` : ''}
          <div class="ddddocr-setting-item">
            <div>
              <div class="ddddocr-setting-label">使用上传的模型</div>
              <div class="ddddocr-setting-desc">上传 common.onnx 和 charsets.json</div>
            </div>
            <div class="ddddocr-switch ${config.useUploadedModel ? 'active' : ''}" data-setting="useUploadedModel">
              <div class="ddddocr-switch-slider"></div>
            </div>
          </div>
          <div id="uploadModelArea" style="display: ${config.useUploadedModel ? 'block' : 'none'}">
            <label class="ddddocr-file-label">📁 选择模型文件 (common.onnx)<input type="file" class="ddddocr-file-input" id="modelFileInput" accept=".onnx"></label>
            <div class="ddddocr-file-name" id="modelFileName">未选择文件</div>
            <label class="ddddocr-file-label" style="margin-top: 12px;">📄 选择字符集文件 (charsets.json)<input type="file" class="ddddocr-file-input" id="charsetsFileInput" accept=".json"></label>
            <div class="ddddocr-file-name" id="charsetsFileName">未选择文件</div>
            <div class="ddddocr-button-group">
              <button class="ddddocr-button" id="uploadModelBtn">保存上传的模型</button>
              <button class="ddddocr-button danger" id="deleteUploadedBtn">删除已上传模型</button>
            </div>
          </div>
          <div class="ddddocr-setting-item" id="autoDownloadItem" style="display: ${!config.useUploadedModel ? 'flex' : 'none'}; margin-top: 12px;">
            <div>
              <div class="ddddocr-setting-label">自动下载模型</div>
              <div class="ddddocr-setting-desc">首次使用时自动下载模型文件</div>
            </div>
            <div class="ddddocr-switch ${config.autoDownload ? 'active' : ''}" data-setting="autoDownload">
              <div class="ddddocr-switch-slider"></div>
            </div>
          </div>
        </div>
        <div class="ddddocr-setting-group">
          <div class="ddddocr-setting-group-title">功能设置</div>
          <div class="ddddocr-setting-item">
            <div>
              <div class="ddddocr-setting-label">自动检测并填充验证码</div>
              <div class="ddddocr-setting-desc">自动识别页面中的验证码并填充</div>
            </div>
            <div class="ddddocr-switch ${config.autoDetect ? 'active' : ''}" data-setting="autoDetect">
              <div class="ddddocr-switch-slider"></div>
            </div>
          </div>
          <div class="ddddocr-setting-item">
            <div>
              <div class="ddddocr-setting-label">验证码选择器</div>
              <div class="ddddocr-setting-desc">CSS选择器，留空则自动检测</div>
            </div>
          </div>
          <input type="text" class="ddddocr-input" placeholder="例如: img.captcha, #captchaImage" value="${config.captchaSelector || ''}" data-setting="captchaSelector">
          <div class="ddddocr-setting-item">
            <div>
              <div class="ddddocr-setting-label">输入框选择器</div>
              <div class="ddddocr-setting-desc">CSS选择器，留空则自动查找</div>
            </div>
          </div>
          <input type="text" class="ddddocr-input" placeholder="例如: input#captcha, .captcha-input" value="${config.inputSelector || ''}" data-setting="inputSelector">
          <div class="ddddocr-setting-item">
            <div>
              <div class="ddddocr-setting-label">提交按钮选择器</div>
              <div class="ddddocr-setting-desc">CSS选择器，留空则自动查找</div>
            </div>
          </div>
          <input type="text" class="ddddocr-input" placeholder="例如: button[type=submit]" value="${config.submitSelector || ''}" data-setting="submitSelector">
        </div>
        <div class="ddddocr-setting-group">
          <div class="ddddocr-setting-group-title">站点白名单</div>
          <div class="ddddocr-setting-item">
            <div>
              <div class="ddddocr-setting-label">启用白名单</div>
              <div class="ddddocr-setting-desc">仅在指定站点启用脚本</div>
            </div>
            <div class="ddddocr-switch ${config.enableWhitelist ? 'active' : ''}" data-setting="enableWhitelist">
              <div class="ddddocr-switch-slider"></div>
            </div>
          </div>
          <div id="whitelistSettings" style="display: ${config.enableWhitelist ? 'block' : 'none'}">
            <textarea class="ddddocr-textarea" placeholder="每行一个域名，例如：&#10;example.com&#10;*.example.com&#10;sub.example.com" data-setting="whitelist">${(config.whitelist || []).join('\n')}</textarea>
            <div class="ddddocr-info">支持通配符 * 匹配子域名。当前站点：${window.location.hostname}</div>
            <div class="ddddocr-button-group">
              <button class="ddddocr-button" id="exportConfigBtn">导出配置</button>
              <button class="ddddocr-button secondary" id="importConfigBtn">导入配置</button>
            </div>
          </div>
        </div>
        <div class="ddddocr-button-group">
          <button class="ddddocr-button" id="saveSettingsBtn">保存设置</button>
          <button class="ddddocr-button secondary" id="resetSettingsBtn">重置设置</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.container);
    this.bindEvents();
  }

  private bindEvents(): void {
    if (!this.container) return;

    this.container.querySelector('.ddddocr-settings-close')?.addEventListener('click', () => this.hide());

    this.container.querySelectorAll('.ddddocr-switch').forEach(switchEl => {
      switchEl.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const setting = target.dataset.setting;
        const isActive = target.classList.toggle('active');

        if (setting === 'useUploadedModel') {
          const uploadArea = this.container!.querySelector('#uploadModelArea') as HTMLElement;
          const autoDownload = this.container!.querySelector('#autoDownloadItem') as HTMLElement;
          uploadArea.style.display = isActive ? 'block' : 'none';
          autoDownload.style.display = isActive ? 'none' : 'flex';
        }
        if (setting === 'enableWhitelist') {
          const whitelistSettings = this.container!.querySelector('#whitelistSettings') as HTMLElement;
          whitelistSettings.style.display = isActive ? 'block' : 'none';
        }
      });
    });

    this.container.querySelector('#modelFileInput')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      const fileName = this.container!.querySelector('#modelFileName') as HTMLElement;
      if (file) fileName.textContent = `✅ ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
    });

    this.container.querySelector('#charsetsFileInput')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      const fileName = this.container!.querySelector('#charsetsFileName') as HTMLElement;
      if (file) fileName.textContent = `✅ ${file.name}`;
    });

    this.container.querySelector('#uploadModelBtn')?.addEventListener('click', async () => {
      const modelFile = (this.container!.querySelector('#modelFileInput') as HTMLInputElement).files?.[0];
      const charsetsFile = (this.container!.querySelector('#charsetsFileInput') as HTMLInputElement).files?.[0];
      if (!modelFile || !charsetsFile) {
        Dialog.show({ title: '缺少文件', content: '请选择模型文件和字符集文件', icon: '⚠️' });
        return;
      }
      try {
        await saveUploadedModel(modelFile, charsetsFile);
        saveConfig({ useUploadedModel: true });
        Dialog.show({ title: '上传成功', content: '模型文件已保存，请刷新页面以应用', icon: '✅' });
      } catch (error) {
        Dialog.show({ title: '上传失败', content: String(error), icon: '❌' });
      }
    });

    this.container.querySelector('#deleteUploadedBtn')?.addEventListener('click', () => {
      Dialog.confirm({
        title: '删除模型',
        content: '确定要删除已上传的模型吗？',
        icon: '🗑️',
        confirmText: '确定删除',
        cancelText: '取消',
        onConfirm: async () => {
          try {
            await deleteUploadedModel();
            saveConfig({ useUploadedModel: false });
            Dialog.show({ title: '删除成功', content: '已删除上传的模型', icon: '✅' });
            this.hide();
          } catch (error) {
            Dialog.show({ title: '删除失败', content: String(error), icon: '❌' });
          }
        },
      });
    });

    this.container.querySelector('#exportConfigBtn')?.addEventListener('click', () => {
      const config = getConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ddddocr-config.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    this.container.querySelector('#importConfigBtn')?.addEventListener('click', () => {
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
          Dialog.show({ title: '导入成功', content: '配置已导入，请刷新页面', icon: '✅' });
        } catch {
          Dialog.show({ title: '导入失败', content: '配置文件格式错误', icon: '❌' });
        }
      };
      input.click();
    });

    this.container.querySelector('#saveSettingsBtn')?.addEventListener('click', () => this.saveSettings());

    this.container.querySelector('#resetSettingsBtn')?.addEventListener('click', () => {
      Dialog.confirm({
        title: '重置设置',
        content: '确定要重置所有设置吗？页面将自动刷新。',
        icon: '⚠️',
        confirmText: '确定重置',
        cancelText: '取消',
        onConfirm: () => this.resetSettings(),
      });
    });
  }

  private saveSettings(): void {
    if (!this.container) return;
    const config: Partial<OCRConfig> = {};

    this.container.querySelectorAll('.ddddocr-switch').forEach(switchEl => {
      const setting = (switchEl as HTMLElement).dataset.setting;
      if (setting) {
        (config as any)[setting] = switchEl.classList.contains('active');
      }
    });

    this.container.querySelectorAll('input[data-setting]').forEach(input => {
      const setting = (input as HTMLInputElement).dataset.setting;
      if (setting) {
        (config as any)[setting] = (input as HTMLInputElement).value;
      }
    });

    this.container.querySelectorAll('textarea[data-setting]').forEach(textarea => {
      const setting = (textarea as HTMLTextAreaElement).dataset.setting;
      if (setting === 'whitelist') {
        const value = (textarea as HTMLTextAreaElement).value;
        config.whitelist = value.split('\n').filter(line => line.trim());
      }
    });

    saveConfig(config);
    this.onConfigChange(getConfig());

    if (typeof GM_notification !== 'undefined') {
      GM_notification({ title: '设置已保存', text: '配置已成功保存', timeout: 2000 });
    }
    this.hide();
  }

  private resetSettings(): void {
    saveConfig({
      autoDetect: false,
      captchaSelector: '',
      inputSelector: '',
      submitSelector: '',
      useUploadedModel: false,
      autoDownload: true,
      enableWhitelist: false,
      whitelist: [],
    });
    this.hide();
    window.location.reload();
  }

  public async show(): Promise<void> {
    if (!this.container) await this.createContainer();
    this.isVisible = true;
    this.container!.classList.add('ddddocr-settings-visible');
  }

  public hide(): void {
    if (this.container) {
      this.isVisible = false;
      this.container.classList.remove('ddddocr-settings-visible');
    }
  }

  public setOnConfigChange(callback: (config: OCRConfig) => void): void {
    this.onConfigChange = callback;
  }
}
