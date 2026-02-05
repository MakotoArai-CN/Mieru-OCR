import { DEFAULT_CONFIG } from '@core/config';
import type { OCRConfig, CalculateRule, SiteRule } from '@core/types';
import { Dialog } from './dialog';
import { saveUploadedModel, deleteUploadedModel, ModelCache } from './model-loader';
import { getConfig, saveConfig, getSiteRules, saveSiteRule, deleteSiteRule, statsManager } from './storage';

const CONFIG_KEY = 'ddddocr_config';

function isMobile(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (window.innerWidth <= 768);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleDateString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export class SettingsUI {
  private container: HTMLDivElement | null = null;
  private overlay: HTMLDivElement | null = null;
  private isVisible = false;
  private onConfigChange: (config: OCRConfig) => void = () => {};
  private activeTab = 'general';
  private currentEditRuleKey: string | null = null;

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
  width: 640px;
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
.ddddocr-modal.mobile .ddddocr-title { font-size: 18px; }

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
.ddddocr-modal.mobile .ddddocr-close { width: 44px; height: 44px; min-width: 44px; min-height: 44px; }

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
.ddddocr-modal.mobile .ddddocr-tabs { padding: 0 8px; position: sticky; top: 76px; z-index: 10; }

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
.ddddocr-modal.mobile .ddddocr-tab { padding: 12px 14px; font-size: 14px; min-height: 48px; }
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
.ddddocr-content::-webkit-scrollbar { width: 6px; }
.ddddocr-content::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 3px; }
.ddddocr-content::-webkit-scrollbar-thumb { background: #FFB6C1; border-radius: 3px; }
.ddddocr-content::-webkit-scrollbar-thumb:hover { background: #FF69B4; }

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
.ddddocr-modal.mobile .ddddocr-card { padding: 16px; border-radius: 12px; }

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
.ddddocr-modal.mobile .ddddocr-row { padding: 16px 0; }
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
.ddddocr-modal.mobile .ddddocr-switch { width: 56px; height: 32px; min-width: 56px; }
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
.ddddocr-modal.mobile .ddddocr-switch-knob { width: 26px; height: 26px; }
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
.ddddocr-modal.mobile .ddddocr-input { padding: 14px 16px; font-size: 16px; border-radius: 12px; }
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
.ddddocr-modal.mobile .ddddocr-select { padding: 14px 16px; font-size: 16px; border-radius: 12px; }
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
.ddddocr-modal.mobile .ddddocr-textarea { padding: 14px 16px; font-size: 14px; min-height: 120px; border-radius: 12px; }
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
.ddddocr-file-icon { font-size: 32px; margin-bottom: 8px; color: #4A90E2; }
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
.ddddocr-modal.mobile .ddddocr-btn { padding: 14px 20px; font-size: 15px; min-height: 48px; }
.ddddocr-btn-primary { background: #4A90E2; color: white; }
.ddddocr-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(74, 144, 226, 0.35); }
.ddddocr-btn-primary:active { transform: translateY(0); }
.ddddocr-btn-secondary { background: #f1f5f9; color: #475569; }
.ddddocr-btn-secondary:hover { background: #e2e8f0; }
.ddddocr-btn-secondary:active { background: #cbd5e1; }
.ddddocr-btn-danger { background: #fee2e2; color: #dc2626; }
.ddddocr-btn-danger:hover { background: #fecaca; }
.ddddocr-btn-danger:active { background: #fca5a5; }
.ddddocr-btn-sm { padding: 8px 14px; font-size: 12px; flex: none;}
.ddddocr-modal.mobile .ddddocr-btn-sm { padding: 10px 16px; font-size: 13px; min-height: 40px; }

.ddddocr-hint {
  background: rgba(74, 144, 226, 0.08);
  border: 1px solid rgba(74, 144, 226, 0.15);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 12px;
  color: #64748b;
  margin-top: 12px;
}
.ddddocr-modal.mobile .ddddocr-hint { font-size: 13px; padding: 14px 16px; }

.ddddocr-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 12px;
  border: 1px solid rgba(16, 185, 129, 0.3);
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
.ddddocr-modal.mobile .ddddocr-rule-item { flex-wrap: wrap; padding: 14px; }
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
.ddddocr-rule-edit {
  background: none;
  border: none;
  color: #4A90E2;
  cursor: pointer;
  font-size: 12px;
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
.ddddocr-modal.mobile .ddddocr-add-rule { flex-direction: column; }
.ddddocr-modal.mobile .ddddocr-add-rule input,
.ddddocr-modal.mobile .ddddocr-add-rule select { width: 100%; flex: none; }

.ddddocr-save-float { display: none; }
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
.ddddocr-modal.mobile .ddddocr-save-float .ddddocr-btn { width: 100%; }
.ddddocr-modal.mobile .ddddocr-tabs .ddddocr-btn { display: none; }

/* 统计样式 */
.ddddocr-stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.ddddocr-modal.mobile .ddddocr-stats-grid { grid-template-columns: 1fr; }

.ddddocr-stat-card {
  background: linear-gradient(135deg, #4A90E2 0%, #357ABD 100%);
  border-radius: 12px;
  padding: 16px;
  color: white;
  position: relative;
  overflow: hidden;
}
.ddddocr-stat-card::before {
  content: '';
  position: absolute;
  top: -50%;
  right: -50%;
  width: 100%;
  height: 100%;
  background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
  pointer-events: none;
}
.ddddocr-stat-card.accent { background: linear-gradient(135deg, #FF69B4 0%, #FF1493 100%); }
.ddddocr-stat-card.success { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
.ddddocr-stat-card.warning { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }

.ddddocr-stat-label { font-size: 12px; opacity: 0.9; margin-bottom: 6px; }
.ddddocr-stat-value { font-size: 28px; font-weight: 700; line-height: 1; }
.ddddocr-stat-unit { font-size: 14px; font-weight: 400; opacity: 0.8; margin-left: 4px; }

.ddddocr-rank-list { max-height: 400px; overflow-y: auto; }
.ddddocr-rank-item {
  display: flex;
  align-items: center;
  padding: 14px 12px;
  background: #f8fafc;
  border-radius: 10px;
  margin-bottom: 8px;
  border: 1px solid rgba(74, 144, 226, 0.08);
  transition: all 0.2s;
}
.ddddocr-rank-item:hover { background: #f1f5f9; }
.ddddocr-rank-item:last-child { margin-bottom: 0; }

.ddddocr-rank-num {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #e2e8f0;
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 12px;
  flex-shrink: 0;
}
.ddddocr-rank-item:nth-child(1) .ddddocr-rank-num { background: linear-gradient(135deg, #fbbf24, #f59e0b); color: white; }
.ddddocr-rank-item:nth-child(2) .ddddocr-rank-num { background: linear-gradient(135deg, #94a3b8, #64748b); color: white; }
.ddddocr-rank-item:nth-child(3) .ddddocr-rank-num { background: linear-gradient(135deg, #cd7f32, #b8860b); color: white; }

.ddddocr-rank-info { flex: 1; min-width: 0; }
.ddddocr-rank-host { font-size: 14px; font-weight: 500; color: #334155; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ddddocr-rank-meta { font-size: 12px; color: #94a3b8; margin-top: 4px; display: flex; gap: 12px; }
.ddddocr-rank-count { font-size: 18px; font-weight: 700; color: #4A90E2; margin-left: 12px; flex-shrink: 0; }

.ddddocr-progress-bar { height: 6px; background: #e2e8f0; border-radius: 3px; margin-top: 8px; overflow: hidden; }
.ddddocr-progress-fill { height: 100%; background: linear-gradient(90deg, #4A90E2, #FF69B4); border-radius: 3px; transition: width 0.3s ease; }

/* 站点规则样式 */
.ddddocr-site-rule-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  background: #f8fafc;
  border-radius: 10px;
  margin-bottom: 10px;
  border: 1px solid rgba(74, 144, 226, 0.08);
}
.ddddocr-site-rule-item:last-child { margin-bottom: 0; }
.ddddocr-site-rule-info { flex: 1; min-width: 0; }
.ddddocr-site-rule-key { font-size: 14px; font-weight: 500; color: #334155; word-break: break-all; margin-bottom: 4px; }
.ddddocr-site-rule-selector { font-size: 12px; color: #64748b; font-family: monospace; word-break: break-all; }
.ddddocr-site-rule-badge { font-size: 10px; padding: 2px 6px; background: #dbeafe; color: #4A90E2; border-radius: 4px; margin-top: 6px; display: inline-block; }
.ddddocr-site-rule-actions { display: flex; gap: 4px; flex-shrink: 0; }

.ddddocr-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.ddddocr-card-header .ddddocr-card-title { margin-bottom: 0; }
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

    const calcRulesHtml = this.renderCalculateRules(config.calculateRules || []);
    const siteRulesHtml = this.renderSiteRules();
    const statsHtml = this.renderStats();
    const agreementHtml = this.renderAgreementSelectors(config.agreementSelectors || []);

    this.container.innerHTML = `
      <div class="ddddocr-header">
        <div class="ddddocr-title">DDDD OCR 设置</div>
        <button class="ddddocr-close">×</button>
      </div>
      <div class="ddddocr-tabs">
        <button class="ddddocr-tab active" data-tab="general">基本设置</button>
        <button class="ddddocr-tab" data-tab="rules">网站规则</button>
        <button class="ddddocr-tab" data-tab="stats">识别统计</button>
        <button class="ddddocr-tab" data-tab="calculate">四则运算</button>
        <button class="ddddocr-tab" data-tab="model">模型管理</button>
        <button class="ddddocr-tab" data-tab="whitelist">站点白名单</button>
        <button class="ddddocr-btn ddddocr-btn-primary ddddocr-btn-sm" id="saveBtn">保存</button>
      </div>
      <div class="ddddocr-content">
        <!-- 基本设置 -->
        <div class="ddddocr-panel active" data-panel="general">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">检测与填充</div>
            ${this.renderSwitchRow('autoDetect', '自动检测并填充', '自动识别页面验证码并填充结果', config.autoDetect)}
            ${this.renderSwitchRow('typewriterEffect', '打字机效果', '模拟人工逐字输入，关闭则一次性填充', config.typewriterEffect)}
            ${this.renderSwitchRow('autoCheckAgreement', '自动勾选协议', '自动勾选用户协议、隐私政策等复选框', config.autoCheckAgreement)}
            ${this.renderSwitchRow('enableNotification', '系统通知', '识别完成后显示桌面通知提醒', config.enableNotification)}
            ${this.renderSwitchRow('debugMode', '调试模式', '在控制台输出详细日志', config.debugMode)}
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">自定义选择器</div>
            <div class="ddddocr-row-label">验证码选择器</div>
            <input type="text" class="ddddocr-input" data-key="captchaSelector" placeholder="img.captcha 或 #captchaImg" value="${escapeHtml(config.captchaSelector || '')}">
            <div class="ddddocr-row-label" style="margin-top: 12px;">输入框选择器</div>
            <input type="text" class="ddddocr-input" data-key="inputSelector" placeholder="input#code 或 .captcha-input" value="${escapeHtml(config.inputSelector || '')}">
            <div class="ddddocr-hint">留空则自动检测页面中的验证码元素</div>
            <div class="ddddocr-row-label" style="margin-top: 12px;">协议复选框选择器</div>
            <div id="agreementSelectorsList">${agreementHtml}</div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <input type="text" class="ddddocr-input" id="newAgreementSelector" placeholder="input#agree, .privacy-checkbox" style="margin-top: 0; flex: 1;">
              <button class="ddddocr-btn ddddocr-btn-primary ddddocr-btn-sm" id="addAgreementSelectorBtn">添加</button>
            </div>
            <div class="ddddocr-hint">支持添加多个协议复选框选择器</div>
          </div>
        </div>

        <!-- 网站规则 -->
        <div class="ddddocr-panel" data-panel="rules">
          <div class="ddddocr-card">
            <div class="ddddocr-card-header">
              <div class="ddddocr-card-title">已保存的规则</div>
              <div style="display: flex; gap: 8px;">
                <button class="ddddocr-btn ddddocr-btn-secondary ddddocr-btn-sm" id="exportRulesBtn">导出</button>
                <button class="ddddocr-btn ddddocr-btn-secondary ddddocr-btn-sm" id="importRulesBtn">导入</button>
              </div>
            </div>
            <div id="siteRulesList">${siteRulesHtml}</div>
          </div>
          <div class="ddddocr-card" id="editRuleCard" style="display: none;">
            <div class="ddddocr-card-title">编辑规则</div>
            <div class="ddddocr-row-label">规则标识</div>
            <input type="text" class="ddddocr-input" id="editRuleKey" readonly>
            <input type="hidden" id="editRuleOriginalKey">
            <div class="ddddocr-row-label" style="margin-top: 12px;">验证码选择器</div>
            <input type="text" class="ddddocr-input" id="editRuleSelector" placeholder="img.captcha">
            <div class="ddddocr-row-label" style="margin-top: 12px;">输入框选择器</div>
            <input type="text" class="ddddocr-input" id="editRuleInput" placeholder="input#code">
            <div class="ddddocr-btn-group">
              <button class="ddddocr-btn ddddocr-btn-primary" id="saveEditRuleBtn">保存修改</button>
              <button class="ddddocr-btn ddddocr-btn-secondary" id="cancelEditRuleBtn">取消</button>
            </div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">添加规则</div>
            <div class="ddddocr-row-label">主机名/URL</div>
            <input type="text" class="ddddocr-input" id="newRuleHostname" placeholder="example.com 或完整URL" style="margin-top: 0;">
            <div class="ddddocr-row-label" style="margin-top: 12px;">验证码选择器</div>
            <input type="text" class="ddddocr-input" id="newRuleSelector" placeholder="img.captcha">
            <div class="ddddocr-row-label" style="margin-top: 12px;">输入框选择器</div>
            <input type="text" class="ddddocr-input" id="newRuleInputSelector" placeholder="input#code (可选)">
            <button class="ddddocr-btn ddddocr-btn-primary" id="addSiteRuleBtn" style="margin-top: 16px;">添加规则</button>
          </div>
        </div>

        <!-- 识别统计 -->
        <div class="ddddocr-panel" data-panel="stats">
          ${statsHtml}
        </div>

        <!-- 四则运算 -->
        <div class="ddddocr-panel" data-panel="calculate">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">四则运算识别</div>
            ${this.renderSwitchRow('autoCalculate', '自动计算结果', '识别到 "3+5=?" 自动计算并填充', config.autoCalculate)}
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
            <div id="calculateRulesList">${calcRulesHtml}</div>
            <div class="ddddocr-add-rule">
              <input type="text" class="ddddocr-input" id="newCalcRulePattern" placeholder="站点匹配 (如: *.example.com)" style="margin-top:0">
              <select class="ddddocr-select" id="newCalcRuleMatchType" style="margin-top:0">
                <option value="wildcard">通配符</option>
                <option value="regex">正则表达式</option>
              </select>
              <select class="ddddocr-select" id="newCalcRuleOutputMode" style="margin-top:0">
                <option value="result">仅结果</option>
                <option value="equation">完整等式</option>
              </select>
              <button class="ddddocr-btn ddddocr-btn-primary ddddocr-btn-sm" id="addCalcRuleBtn">添加</button>
            </div>
            <div class="ddddocr-hint">
              <b>通配符:</b> * 匹配任意字符，? 匹配单个字符<br>
              <b>正则:</b> 使用标准正则表达式语法
            </div>
          </div>
        </div>

        <!-- 模型管理 -->
        <div class="ddddocr-panel" data-panel="model">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">模型来源</div>
            ${hasUploadedModel ? `<div class="ddddocr-badge">[已上传] 本地模型 (${(uploadedModelSize / 1024 / 1024).toFixed(1)} MB)</div>` : ''}
            ${this.renderSwitchRow('useUploadedModel', '使用上传的模型', '优先使用本地上传的模型文件', config.useUploadedModel)}
            ${this.renderSwitchRow('autoDownload', '自动下载模型', '首次使用时自动从网络下载模型', config.autoDownload)}
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">上传模型文件</div>
            <div class="ddddocr-file-zone" id="modelZone">
              <input type="file" id="modelFile" accept=".onnx">
              <div class="ddddocr-file-icon">[ONNX]</div>
              <div class="ddddocr-file-text">点击上传 common.onnx</div>
              <div class="ddddocr-file-name" id="modelName"></div>
            </div>
            <div class="ddddocr-file-zone" id="charsetsZone" style="margin-top: 12px;">
              <input type="file" id="charsetsFile" accept=".json">
              <div class="ddddocr-file-icon">[JSON]</div>
              <div class="ddddocr-file-text">点击上传 charsets.json</div>
              <div class="ddddocr-file-name" id="charsetsName"></div>
            </div>
            <div class="ddddocr-btn-group">
              <button class="ddddocr-btn ddddocr-btn-primary" id="uploadBtn">保存模型</button>
              <button class="ddddocr-btn ddddocr-btn-danger" id="deleteModelBtn">删除模型</button>
            </div>
          </div>
        </div>

        <!-- 站点白名单 -->
        <div class="ddddocr-panel" data-panel="whitelist">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">白名单设置</div>
            ${this.renderSwitchRow('enableWhitelist', '启用站点白名单', '仅在白名单站点启用脚本功能', config.enableWhitelist)}
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

  private renderSwitchRow(key: string, label: string, desc: string, checked: boolean): string {
    return `
      <div class="ddddocr-row">
        <div class="ddddocr-row-info">
          <div class="ddddocr-row-label">${label}</div>
          <div class="ddddocr-row-desc">${desc}</div>
        </div>
        <div class="ddddocr-switch ${checked ? 'on' : ''}" data-key="${key}">
          <div class="ddddocr-switch-knob"></div>
        </div>
      </div>
    `;
  }

  private renderCalculateRules(rules: CalculateRule[]): string {
    if (!rules || rules.length === 0) {
      return '<div class="ddddocr-empty">暂无规则，将使用默认输出格式</div>';
    }
    return rules.map((rule, index) => `
      <div class="ddddocr-rule-item" data-index="${index}">
        <span class="ddddocr-rule-pattern">${escapeHtml(rule.pattern)}</span>
        <span class="ddddocr-rule-type">${rule.matchType === 'regex' ? '正则' : '通配符'}</span>
        <span class="ddddocr-rule-output">${rule.outputMode === 'result' ? '仅结果' : '完整等式'}</span>
        <button class="ddddocr-rule-delete btn-delete-calc-rule" data-index="${index}">×</button>
      </div>
    `).join('');
  }

  private renderSiteRules(): string {
    const rules = getSiteRules();
    const keys = Object.keys(rules);
    if (keys.length === 0) {
      return '<div class="ddddocr-empty">暂无保存的规则</div>';
    }
    return keys.map(key => {
      const rule = rules[key];
      const displayKey = key.length > 35 ? key.substring(0, 35) + '...' : key;
      const selectorDisplay = rule.selector.length > 40 ? rule.selector.substring(0, 40) + '...' : rule.selector;
      return `
        <div class="ddddocr-site-rule-item" data-key="${escapeHtml(key)}">
          <div class="ddddocr-site-rule-info">
            <div class="ddddocr-site-rule-key">${escapeHtml(displayKey)}</div>
            <div class="ddddocr-site-rule-selector">${escapeHtml(selectorDisplay)}</div>
            ${rule.fullUrl ? '<div class="ddddocr-site-rule-badge">完整URL匹配</div>' : ''}
          </div>
          <div class="ddddocr-site-rule-actions">
            <button class="ddddocr-rule-edit btn-edit-site-rule" data-key="${escapeHtml(key)}">编辑</button>
            <button class="ddddocr-rule-delete btn-delete-site-rule" data-key="${escapeHtml(key)}">×</button>
          </div>
        </div>
      `;
    }).join('');
  }

  private renderStats(): string {
    const stats = statsManager.getStats();
    const sites = Object.entries(stats.sites || {}) as [string, { count: number; lastTime: number; totalTime: number }][];
    const totalTime = sites.reduce((sum, [, s]) => sum + s.totalTime, 0);
    const avgTime = stats.total > 0 ? Math.round(totalTime / stats.total) : 0;
    const lastUpdate = stats.updated ? formatTime(stats.updated) : '-';

    let rankHtml = '';
    if (sites.length === 0) {
      rankHtml = '<div class="ddddocr-empty">暂无统计数据</div>';
    } else {
      sites.sort((a, b) => b[1].count - a[1].count);
      const topSites = sites.slice(0, 15);
      const maxCount = topSites[0]?.[1].count || 1;
      rankHtml = topSites.map(([hostname, siteStats], index) => {
        const siteAvgTime = siteStats.count > 0 ? Math.round(siteStats.totalTime / siteStats.count) : 0;
        const lastTimeStr = formatTime(siteStats.lastTime);
        const progressWidth = Math.round((siteStats.count / maxCount) * 100);
        return `
          <div class="ddddocr-rank-item">
            <div class="ddddocr-rank-num">${index + 1}</div>
            <div class="ddddocr-rank-info">
              <div class="ddddocr-rank-host">${escapeHtml(hostname)}</div>
              <div class="ddddocr-rank-meta">
                <span>平均 ${siteAvgTime}ms</span>
                <span>最后: ${lastTimeStr}</span>
              </div>
              <div class="ddddocr-progress-bar">
                <div class="ddddocr-progress-fill" style="width: ${progressWidth}%"></div>
              </div>
            </div>
            <div class="ddddocr-rank-count">${siteStats.count}</div>
          </div>
        `;
      }).join('');
    }

    return `
      <div class="ddddocr-stats-grid">
        <div class="ddddocr-stat-card">
          <div class="ddddocr-stat-label">总识别次数</div>
          <div class="ddddocr-stat-value">${stats.total}<span class="ddddocr-stat-unit">次</span></div>
        </div>
        <div class="ddddocr-stat-card accent">
          <div class="ddddocr-stat-label">统计站点数</div>
          <div class="ddddocr-stat-value">${sites.length}<span class="ddddocr-stat-unit">个</span></div>
        </div>
        <div class="ddddocr-stat-card success">
          <div class="ddddocr-stat-label">平均识别耗时</div>
          <div class="ddddocr-stat-value">${avgTime}<span class="ddddocr-stat-unit">ms</span></div>
        </div>
        <div class="ddddocr-stat-card warning">
          <div class="ddddocr-stat-label">最后更新</div>
          <div class="ddddocr-stat-value" style="font-size: 16px;">${lastUpdate}</div>
        </div>
      </div>
      <div class="ddddocr-card">
        <div class="ddddocr-card-header">
          <div class="ddddocr-card-title">站点排行榜</div>
          <button class="ddddocr-btn ddddocr-btn-danger ddddocr-btn-sm" id="clearStatsBtn">清除统计</button>
        </div>
        <div class="ddddocr-rank-list" id="statsRankList">${rankHtml}</div>
      </div>
    `;
  }

  private renderAgreementSelectors(selectors: string[]): string {
    if (!selectors || selectors.length === 0) {
      return '<div class="ddddocr-empty" style="padding: 12px;">暂无协议选择器</div>';
    }
    return selectors.map((selector, index) => `
      <div class="ddddocr-rule-item" data-agreement-index="${index}">
        <span class="ddddocr-rule-pattern">${escapeHtml(selector)}</span>
        <button class="ddddocr-rule-delete btn-delete-agreement" data-index="${index}">×</button>
      </div>
    `).join('');
  }

  private stopPropagation(e: Event): void {
    e.stopPropagation();
  }

  private bindEvents(): void {
    if (!this.container || !this.overlay) return;

    // 阻止事件冒泡
    const events = ['mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown', 'keyup', 'keypress', 'contextmenu'];
    events.forEach(evt => this.container!.addEventListener(evt, this.stopPropagation));
    this.container.addEventListener('touchstart', this.stopPropagation, { passive: true });
    this.container.addEventListener('touchmove', this.stopPropagation, { passive: true });
    this.container.addEventListener('touchend', this.stopPropagation);

    // 关闭按钮
    this.container.querySelector('.ddddocr-close')?.addEventListener('click', () => this.hide());
    this.overlay.addEventListener('click', () => this.hide());

    // 标签切换
    this.container.querySelectorAll('.ddddocr-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = (tab as HTMLElement).dataset.tab;
        if (tabName) this.switchTab(tabName);
      });
    });

    // 开关事件
    this.container.querySelectorAll('.ddddocr-switch').forEach(sw => {
      sw.addEventListener('click', () => {
        sw.classList.toggle('on');
        const key = (sw as HTMLElement).dataset.key;
        if (key === 'enableWhitelist') {
          const area = this.container!.querySelector('#whitelistArea') as HTMLElement;
          if (area) area.style.display = sw.classList.contains('on') ? 'block' : 'none';
        }
        if (key === 'autoCalculate') {
          const optionsArea = this.container!.querySelector('#calculateOptionsArea') as HTMLElement;
          const rulesCard = this.container!.querySelector('#calculateRulesCard') as HTMLElement;
          const show = sw.classList.contains('on');
          if (optionsArea) optionsArea.style.display = show ? 'block' : 'none';
          if (rulesCard) rulesCard.style.display = show ? 'block' : 'none';
        }
      });
    });

    // 协议选择器
    this.container.querySelector('#addAgreementSelectorBtn')?.addEventListener('click', () => this.addAgreementSelector());
    this.bindAgreementSelectorDeleteEvents();

    // 四则运算规则
    this.container.querySelector('#addCalcRuleBtn')?.addEventListener('click', () => this.addCalculateRule());
    this.bindCalcRuleDeleteEvents();

    // 站点规则
    this.container.querySelector('#addSiteRuleBtn')?.addEventListener('click', () => this.addSiteRule());
    this.container.querySelector('#saveEditRuleBtn')?.addEventListener('click', () => this.saveEditRule());
    this.container.querySelector('#cancelEditRuleBtn')?.addEventListener('click', () => this.cancelEditRule());
    this.container.querySelector('#exportRulesBtn')?.addEventListener('click', () => this.exportSiteRules());
    this.container.querySelector('#importRulesBtn')?.addEventListener('click', () => this.importSiteRules());
    this.bindSiteRuleEvents();

    // 统计
    this.container.querySelector('#clearStatsBtn')?.addEventListener('click', () => this.clearStats());

    // 模型上传
    this.bindModelEvents();

    // 配置导入导出
    this.container.querySelector('#exportBtn')?.addEventListener('click', () => this.exportConfig());
    this.container.querySelector('#importBtn')?.addEventListener('click', () => this.importConfig());
    this.container.querySelector('#resetBtn')?.addEventListener('click', () => this.resetConfig());

    // 保存按钮
    this.container.querySelector('#saveBtn')?.addEventListener('click', () => this.saveSettings());
    this.container.querySelector('#saveBtnFloat')?.addEventListener('click', () => this.saveSettings());
  }

  private bindModelEvents(): void {
    const modelZone = this.container?.querySelector('#modelZone') as HTMLElement;
    const modelInput = this.container?.querySelector('#modelFile') as HTMLInputElement;
    const modelName = this.container?.querySelector('#modelName') as HTMLElement;
    const charsetsZone = this.container?.querySelector('#charsetsZone') as HTMLElement;
    const charsetsInput = this.container?.querySelector('#charsetsFile') as HTMLInputElement;
    const charsetsName = this.container?.querySelector('#charsetsName') as HTMLElement;

    modelZone?.addEventListener('click', () => modelInput?.click());
    modelInput?.addEventListener('change', () => {
      if (modelInput.files?.[0]) modelName.textContent = `[OK] ${modelInput.files[0].name}`;
    });
    charsetsZone?.addEventListener('click', () => charsetsInput?.click());
    charsetsInput?.addEventListener('change', () => {
      if (charsetsInput.files?.[0]) charsetsName.textContent = `[OK] ${charsetsInput.files[0].name}`;
    });

    this.container?.querySelector('#uploadBtn')?.addEventListener('click', async () => {
      const modelFile = modelInput?.files?.[0];
      const charsetsFile = charsetsInput?.files?.[0];
      if (!modelFile || !charsetsFile) {
        Dialog.show({ title: '提示', content: '请选择模型文件和字符集文件', icon: '' });
        return;
      }
      try {
        await saveUploadedModel(modelFile, charsetsFile);
        saveConfig({ useUploadedModel: true });
        Dialog.show({ title: '成功', content: '模型已保存，请刷新页面', icon: '' });
      } catch (e) {
        Dialog.show({ title: '错误', content: String(e), icon: '' });
      }
    });

    this.container?.querySelector('#deleteModelBtn')?.addEventListener('click', () => {
      Dialog.confirm({
        title: '删除模型',
        content: '确定删除已上传的模型吗？',
        onConfirm: async () => {
          await deleteUploadedModel();
          saveConfig({ useUploadedModel: false });
          Dialog.show({ title: '成功', content: '模型已删除', icon: '' });
        },
      });
    });
  }

  private bindAgreementSelectorDeleteEvents(): void {
    this.container?.querySelectorAll('.btn-delete-agreement').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt((e.target as HTMLElement).dataset.index || '0');
        this.deleteAgreementSelector(index);
      });
    });
  }

  private bindCalcRuleDeleteEvents(): void {
    this.container?.querySelectorAll('.btn-delete-calc-rule').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt((e.target as HTMLElement).dataset.index || '0');
        this.deleteCalculateRule(index);
      });
    });
  }

  private bindSiteRuleEvents(): void {
    this.container?.querySelectorAll('.btn-edit-site-rule').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = (e.target as HTMLElement).dataset.key;
        if (key) this.editSiteRule(key);
      });
    });
    this.container?.querySelectorAll('.btn-delete-site-rule').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = (e.target as HTMLElement).dataset.key;
        if (key) this.deleteSiteRuleUI(key);
      });
    });
  }

  private addAgreementSelector(): void {
    const input = this.container?.querySelector('#newAgreementSelector') as HTMLInputElement;
    const selector = input?.value.trim();
    if (!selector) {
      Dialog.show({ title: '提示', content: '请输入选择器', icon: '' });
      return;
    }
    const config = getConfig();
    const selectors: string[] = config.agreementSelectors || [];
    if (selectors.includes(selector)) {
      Dialog.show({ title: '提示', content: '选择器已存在', icon: '' });
      return;
    }
    selectors.push(selector);
    saveConfig({ agreementSelectors: selectors });
    const list = this.container?.querySelector('#agreementSelectorsList') as HTMLElement;
    if (list) list.innerHTML = this.renderAgreementSelectors(selectors);
    this.bindAgreementSelectorDeleteEvents();
    input.value = '';
  }

  private deleteAgreementSelector(index: number): void {
    const config = getConfig();
    const selectors: string[] = config.agreementSelectors || [];
    selectors.splice(index, 1);
    saveConfig({ agreementSelectors: selectors });
    const list = this.container?.querySelector('#agreementSelectorsList') as HTMLElement;
    if (list) list.innerHTML = this.renderAgreementSelectors(selectors);
    this.bindAgreementSelectorDeleteEvents();
  }

  private addCalculateRule(): void {
    const patternInput = this.container?.querySelector('#newCalcRulePattern') as HTMLInputElement;
    const matchTypeSelect = this.container?.querySelector('#newCalcRuleMatchType') as HTMLSelectElement;
    const outputModeSelect = this.container?.querySelector('#newCalcRuleOutputMode') as HTMLSelectElement;
    const pattern = patternInput?.value.trim();
    if (!pattern) {
      Dialog.show({ title: '提示', content: '请输入站点匹配规则', icon: '' });
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
    const list = this.container?.querySelector('#calculateRulesList') as HTMLElement;
    if (list) list.innerHTML = this.renderCalculateRules(rules);
    this.bindCalcRuleDeleteEvents();
    patternInput.value = '';
  }

  private deleteCalculateRule(index: number): void {
    const config = getConfig();
    const rules: CalculateRule[] = config.calculateRules || [];
    rules.splice(index, 1);
    saveConfig({ calculateRules: rules });
    const list = this.container?.querySelector('#calculateRulesList') as HTMLElement;
    if (list) list.innerHTML = this.renderCalculateRules(rules);
    this.bindCalcRuleDeleteEvents();
  }

  private addSiteRule(): void {
    const hostnameInput = this.container?.querySelector('#newRuleHostname') as HTMLInputElement;
    const selectorInput = this.container?.querySelector('#newRuleSelector') as HTMLInputElement;
    const inputSelectorInput = this.container?.querySelector('#newRuleInputSelector') as HTMLInputElement;
    const hostname = hostnameInput?.value.trim();
    const selector = selectorInput?.value.trim();
    const inputSelector = inputSelectorInput?.value.trim();
    if (!hostname || !selector) {
      Dialog.show({ title: '提示', content: '请填写主机名和验证码选择器', icon: '' });
      return;
    }
    saveSiteRule(hostname, { selector, inputSelector: inputSelector || undefined, enabled: true });
    this.refreshSiteRulesList();
    hostnameInput.value = '';
    selectorInput.value = '';
    inputSelectorInput.value = '';
  }

  private editSiteRule(key: string): void {
    const rules = getSiteRules();
    const rule = rules[key];
    if (!rule) return;
    this.currentEditRuleKey = key;
    const editCard = this.container?.querySelector('#editRuleCard') as HTMLElement;
    const keyInput = this.container?.querySelector('#editRuleKey') as HTMLInputElement;
    const originalKeyInput = this.container?.querySelector('#editRuleOriginalKey') as HTMLInputElement;
    const selectorInput = this.container?.querySelector('#editRuleSelector') as HTMLInputElement;
    const inputInput = this.container?.querySelector('#editRuleInput') as HTMLInputElement;
    if (editCard) editCard.style.display = 'block';
    if (keyInput) keyInput.value = key;
    if (originalKeyInput) originalKeyInput.value = key;
    if (selectorInput) selectorInput.value = rule.selector || '';
    if (inputInput) inputInput.value = rule.inputSelector || '';
  }

  private saveEditRule(): void {
    const originalKeyInput = this.container?.querySelector('#editRuleOriginalKey') as HTMLInputElement;
    const selectorInput = this.container?.querySelector('#editRuleSelector') as HTMLInputElement;
    const inputInput = this.container?.querySelector('#editRuleInput') as HTMLInputElement;
    const originalKey = originalKeyInput?.value;
    const selector = selectorInput?.value.trim();
    const inputSelector = inputInput?.value.trim();
    if (!selector) {
      Dialog.show({ title: '提示', content: '验证码选择器不能为空', icon: '' });
      return;
    }
    if (originalKey) {
      const rules = getSiteRules();
      const oldRule = rules[originalKey];
      if (oldRule) {
        deleteSiteRule(originalKey);
        saveSiteRule(oldRule.hostname, {
          ...oldRule,
          selector,
          inputSelector: inputSelector || undefined,
        });
      }
    }
    this.cancelEditRule();
    this.refreshSiteRulesList();
  }

  private cancelEditRule(): void {
    this.currentEditRuleKey = null;
    const editCard = this.container?.querySelector('#editRuleCard') as HTMLElement;
    if (editCard) editCard.style.display = 'none';
  }

  private deleteSiteRuleUI(key: string): void {
    Dialog.confirm({
      title: '删除规则',
      content: `确定删除规则 "${key}" 吗？`,
      onConfirm: () => {
        deleteSiteRule(key);
        this.refreshSiteRulesList();
      },
    });
  }

  private refreshSiteRulesList(): void {
    const list = this.container?.querySelector('#siteRulesList') as HTMLElement;
    if (list) list.innerHTML = this.renderSiteRules();
    this.bindSiteRuleEvents();
  }

  private exportSiteRules(): void {
    const rules = getSiteRules();
    const exportData = Object.entries(rules).map(([key, rule]) => ({
      hostname: rule.hostname || key,
      selector: rule.selector,
      inputSelector: rule.inputSelector,
      fullUrl: rule.fullUrl,
    }));
    this.downloadJson(exportData, 'ddddocr-rules.json');
  }

  private importSiteRules(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const rules = JSON.parse(text);
        if (!Array.isArray(rules)) throw new Error('格式错误');
        for (const rule of rules) {
          if (!rule.hostname || !rule.selector) continue;
          saveSiteRule(rule.hostname, {
            selector: rule.selector,
            inputSelector: rule.inputSelector,
            fullUrl: rule.fullUrl,
            enabled: true,
          });
        }
        this.refreshSiteRulesList();
        Dialog.show({ title: '成功', content: `已导入 ${rules.length} 条规则`, icon: '' });
      } catch {
        Dialog.show({ title: '错误', content: '规则文件格式错误', icon: '' });
      }
    };
    input.click();
  }

  private clearStats(): void {
    Dialog.confirm({
      title: '清除统计',
      content: '确定要清除所有统计数据吗？',
      onConfirm: () => {
        statsManager.clear();
        const panel = this.container?.querySelector('[data-panel="stats"]') as HTMLElement;
        if (panel) panel.innerHTML = this.renderStats();
        this.container?.querySelector('#clearStatsBtn')?.addEventListener('click', () => this.clearStats());
      },
    });
  }

  private exportConfig(): void {
    const config = getConfig();
    this.downloadJson(config, 'ddddocr-config.json');
  }

  private importConfig(): void {
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
        Dialog.show({ title: '成功', content: '配置已导入，请刷新页面', icon: '' });
      } catch {
        Dialog.show({ title: '错误', content: '配置文件格式错误', icon: '' });
      }
    };
    input.click();
  }

  private resetConfig(): void {
    Dialog.confirm({
      title: '重置设置',
      content: '确定重置所有设置吗？',
      onConfirm: () => {
        GM_setValue(CONFIG_KEY, DEFAULT_CONFIG);
        Dialog.show({ title: '成功', content: '设置已重置，请刷新页面', icon: '' });
      },
    });
  }

  private downloadJson(data: any, filename: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
    // 刷新统计页面数据
    if (tabName === 'stats') {
      const panel = this.container.querySelector('[data-panel="stats"]') as HTMLElement;
      if (panel) panel.innerHTML = this.renderStats();
      this.container.querySelector('#clearStatsBtn')?.addEventListener('click', () => this.clearStats());
    }
  }

  private saveSettings(): void {
    if (!this.container) return;
    const config: Partial<OCRConfig> = {};

    this.container.querySelectorAll('.ddddocr-switch').forEach(sw => {
      const key = (sw as HTMLElement).dataset.key;
      if (key) (config as any)[key] = sw.classList.contains('on');
    });

    this.container.querySelectorAll('input[data-key]').forEach(input => {
      const key = (input as HTMLInputElement).dataset.key;
      if (key) (config as any)[key] = (input as HTMLInputElement).value.trim();
    });

    this.container.querySelectorAll('select[data-key]').forEach(select => {
      const key = (select as HTMLSelectElement).dataset.key;
      if (key) (config as any)[key] = (select as HTMLSelectElement).value;
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