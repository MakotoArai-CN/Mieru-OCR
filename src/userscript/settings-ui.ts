import { CONSTANTS, DEFAULT_CONFIG, getThemeColors } from '@core/config';
import type { OCRConfig, CalculateRule, SiteRule } from '@core/types';
import { t, initLocale, setLocale, getCurrentLocale, translatePage } from '@core/i18n';
import type { Locale } from '@core/i18n';
import { Dialog } from './dialog';
import { saveUploadedModel, deleteUploadedModel, ModelCache } from './model-loader';
import { getConfig, saveConfig, getSiteRules, saveSiteRule, deleteSiteRule, statsManager } from './storage';

type ChipFieldKey = 'customIncludeKeywords' | 'customExcludePatterns' | 'customAgreementKeywords' | 'customInputExcludeKeywords';
type DisabledChipKey = 'disabledCaptchaKeywords' | 'disabledExcludePatterns' | 'disabledAgreementKeywords' | 'disabledInputExcludeKeywords';

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
  private containerLocale: string = '';
  private mediaQuery: MediaQueryList | null = null;
  private mediaQueryHandler: (() => void) | null = null;

  private readonly CHIP_META: Record<ChipFieldKey, { builtin: string[]; disabledKey: DisabledChipKey }> = {
    customIncludeKeywords: { builtin: [...CONSTANTS.CAPTCHA_KEYWORDS], disabledKey: 'disabledCaptchaKeywords' },
    customExcludePatterns: { builtin: [...CONSTANTS.EXCLUDE_PATTERNS], disabledKey: 'disabledExcludePatterns' },
    customAgreementKeywords: { builtin: [...CONSTANTS.AGREEMENT_KEYWORDS], disabledKey: 'disabledAgreementKeywords' },
    customInputExcludeKeywords: { builtin: [...CONSTANTS.INPUT_EXCLUDE_KEYWORDS], disabledKey: 'disabledInputExcludeKeywords' },
  };

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
  background: var(--bg-secondary);
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
  padding-bottom: 24px;
}
.ddddocr-content::-webkit-scrollbar { width: 6px; }
.ddddocr-content::-webkit-scrollbar-track { background: var(--border); border-radius: 3px; }
.ddddocr-content::-webkit-scrollbar-thumb { background: #FFB6C1; border-radius: 3px; }
.ddddocr-content::-webkit-scrollbar-thumb:hover { background: #FF69B4; }

.ddddocr-panel { display: none; }
.ddddocr-panel.active { display: block; }

.ddddocr-card {
  background: var(--bg-primary);
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
  color: var(--text-primary);
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
  border-bottom: 1px solid var(--border);
  gap: 12px;
}
.ddddocr-modal.mobile .ddddocr-row { padding: 16px 0; }
.ddddocr-row:last-child { border-bottom: none; }

.ddddocr-row-info { flex: 1; min-width: 0; }
.ddddocr-row-label { font-size: 14px; color: var(--text-primary); font-weight: 500; }
.ddddocr-modal.mobile .ddddocr-row-label { font-size: 15px; }
.ddddocr-row-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.ddddocr-modal.mobile .ddddocr-row-desc { font-size: 13px; }

.ddddocr-switch {
  position: relative;
  width: 48px;
  height: 26px;
  min-width: 48px;
  background: var(--border);
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
  background: var(--bg-primary);
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
  border: 2px solid var(--border);
  border-radius: 10px;
  font-size: 14px;
  transition: all 0.2s;
  margin-top: 8px;
  box-sizing: border-box;
  background: var(--bg-primary);
  color: var(--text-primary);
}
.ddddocr-modal.mobile .ddddocr-input { padding: 14px 16px; font-size: 16px; border-radius: 12px; }
.ddddocr-input:focus { outline: none; border-color: #4A90E2; box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.15); }

.ddddocr-select {
  width: 100%;
  padding: 12px 14px;
  border: 2px solid var(--border);
  border-radius: 10px;
  font-size: 14px;
  transition: all 0.2s;
  margin-top: 8px;
  box-sizing: border-box;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
}
.ddddocr-modal.mobile .ddddocr-select { padding: 14px 16px; font-size: 16px; border-radius: 12px; }
.ddddocr-select:focus { outline: none; border-color: #4A90E2; }

.ddddocr-textarea {
  width: 100%;
  padding: 12px 14px;
  border: 2px solid var(--border);
  border-radius: 10px;
  font-size: 13px;
  font-family: 'Monaco', 'Consolas', monospace;
  min-height: 100px;
  resize: vertical;
  transition: all 0.2s;
  margin-top: 8px;
  box-sizing: border-box;
  background: var(--bg-primary);
  color: var(--text-primary);
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
.ddddocr-file-text { font-size: 13px; color: var(--text-secondary); }
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
.ddddocr-btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); }
.ddddocr-btn-secondary:hover { background: var(--border); }
.ddddocr-btn-secondary:active { background: var(--bg-hover); }
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
  color: var(--text-secondary);
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
  background: var(--bg-secondary);
  border-radius: 10px;
  margin-bottom: 8px;
  border: 1px solid rgba(74, 144, 226, 0.08);
}
.ddddocr-modal.mobile .ddddocr-rule-item { flex-wrap: wrap; padding: 14px; }
.ddddocr-rule-item:last-child { margin-bottom: 0; }
.ddddocr-rule-pattern { flex: 1; font-family: monospace; font-size: 13px; color: var(--text-primary); word-break: break-all; min-width: 0; }
.ddddocr-rule-type { font-size: 11px; padding: 4px 8px; background: var(--border); border-radius: 4px; color: var(--text-secondary); white-space: nowrap; }
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

.ddddocr-empty { text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px; }

.ddddocr-add-rule { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.ddddocr-add-rule input { flex: 2; min-width: 120px; }
.ddddocr-add-rule select { flex: 1; min-width: 80px; }
.ddddocr-modal.mobile .ddddocr-add-rule { flex-direction: column; }
.ddddocr-modal.mobile .ddddocr-add-rule input,
.ddddocr-modal.mobile .ddddocr-add-rule select { width: 100%; flex: none; }

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
  background: var(--bg-secondary);
  border-radius: 10px;
  margin-bottom: 8px;
  border: 1px solid rgba(74, 144, 226, 0.08);
  transition: all 0.2s;
}
.ddddocr-rank-item:hover { background: var(--bg-tertiary); }
.ddddocr-rank-item:last-child { margin-bottom: 0; }

.ddddocr-rank-num {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--border);
  color: var(--text-secondary);
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
.ddddocr-rank-host { font-size: 14px; font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ddddocr-rank-meta { font-size: 12px; color: var(--text-muted); margin-top: 4px; display: flex; gap: 12px; }
.ddddocr-rank-count { font-size: 18px; font-weight: 700; color: #4A90E2; margin-left: 12px; flex-shrink: 0; }

.ddddocr-progress-bar { height: 6px; background: var(--border); border-radius: 3px; margin-top: 8px; overflow: hidden; }
.ddddocr-progress-fill { height: 100%; background: linear-gradient(90deg, #4A90E2, #FF69B4); border-radius: 3px; transition: width 0.3s ease; }

/* 站点规则样式 */
.ddddocr-site-rule-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: 10px;
  margin-bottom: 10px;
  border: 1px solid rgba(74, 144, 226, 0.08);
}
.ddddocr-site-rule-item:last-child { margin-bottom: 0; }
.ddddocr-site-rule-info { flex: 1; min-width: 0; }
.ddddocr-site-rule-key { font-size: 14px; font-weight: 500; color: var(--text-primary); word-break: break-all; margin-bottom: 4px; }
.ddddocr-site-rule-selector { font-size: 12px; color: var(--text-secondary); font-family: monospace; word-break: break-all; }
.ddddocr-site-rule-badge { font-size: 10px; padding: 2px 6px; background: #dbeafe; color: #4A90E2; border-radius: 4px; margin-top: 6px; display: inline-block; }
.ddddocr-site-rule-actions { display: flex; gap: 4px; flex-shrink: 0; }

.ddddocr-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.ddddocr-card-header .ddddocr-card-title { margin-bottom: 0; }

/* Chip keyword styles */
.ddddocr-keyword-group {
  padding: 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 12px;
}
.ddddocr-keyword-group:last-child { margin-bottom: 0; }
.ddddocr-keyword-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.ddddocr-keyword-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ddddocr-keyword-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}
.ddddocr-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 38px;
}
.ddddocr-chip-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  max-width: 100%;
  font-size: 13px;
}
.ddddocr-chip-item.builtin { border-color: rgba(74, 144, 226, 0.35); }
.ddddocr-chip-item.custom { border-color: rgba(255, 105, 180, 0.35); }
.ddddocr-chip-text {
  color: var(--text-primary);
  word-break: break-all;
}
.ddddocr-chip-meta {
  font-size: 11px;
  color: var(--text-muted);
}
.ddddocr-chip-remove {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: var(--bg-hover);
  color: var(--text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  font-size: 14px;
  transition: all 0.2s;
}
.ddddocr-chip-remove:hover { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
.ddddocr-chip-input-row { margin-top: 12px; }
.ddddocr-chip-input {
  width: 100%;
  padding: 10px 14px;
  border: 2px solid var(--border);
  border-radius: 10px;
  font-size: 13px;
  box-sizing: border-box;
  background: var(--bg-primary);
  color: var(--text-primary);
  transition: all 0.2s;
}
.ddddocr-chip-input:focus { outline: none; border-color: #4A90E2; box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.15); }
.ddddocr-chip-reset {
  padding: 4px 10px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}
.ddddocr-chip-reset:hover { border-color: #4A90E2; color: #4A90E2; }
.ddddocr-chip-empty {
  width: 100%;
  text-align: center;
  padding: 12px;
  color: var(--text-muted);
  font-size: 12px;
}
`;
    if (!document.getElementById('ddddocr-settings-styles')) {
      document.head.appendChild(style);
    }
  }

  private applyTheme(): void {
    if (!this.container) return;
    const config = getConfig();
    const colors = getThemeColors(config.theme || 'auto');
    for (const [key, value] of Object.entries(colors)) {
      this.container.style.setProperty(key, value);
    }
  }

  private setupThemeMediaQuery(): void {
    // Clean up previous listener
    if (this.mediaQuery && this.mediaQueryHandler) {
      if (typeof this.mediaQuery.removeEventListener === 'function') {
        this.mediaQuery.removeEventListener('change', this.mediaQueryHandler);
      }
    }
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaQueryHandler = () => {
      const config = getConfig();
      if ((config.theme || 'auto') === 'auto') {
        this.applyTheme();
      }
    };
    if (typeof this.mediaQuery.addEventListener === 'function') {
      this.mediaQuery.addEventListener('change', this.mediaQueryHandler);
    } else if (typeof this.mediaQuery.addListener === 'function') {
      this.mediaQuery.addListener(this.mediaQueryHandler);
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
        <div class="ddddocr-title">${t('settings.title')}</div>
        <button class="ddddocr-close">×</button>
      </div>
      <div class="ddddocr-tabs">
        <button class="ddddocr-tab active" data-tab="general">${t('settings.tab.general')}</button>
        <button class="ddddocr-tab" data-tab="rules">${t('settings.tab.rules')}</button>
        <button class="ddddocr-tab" data-tab="stats">${t('settings.tab.stats')}</button>
        <button class="ddddocr-tab" data-tab="calculate">${t('settings.tab.calculate')}</button>
        <button class="ddddocr-tab" data-tab="model">${t('settings.tab.model')}</button>
        <button class="ddddocr-tab" data-tab="whitelist">${t('settings.tab.whitelist')}</button>
      </div>
      <div class="ddddocr-content">
        <!-- General -->
        <div class="ddddocr-panel active" data-panel="general">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('settings.detect.title')}</div>
            ${this.renderSwitchRow('autoDetect', t('settings.detect.auto'), t('settings.detect.autoHint'), config.autoDetect)}
            ${this.renderSwitchRow('typewriterEffect', t('settings.typewriter'), t('settings.typewriter.hint'), config.typewriterEffect)}
            ${this.renderSwitchRow('autoCheckAgreement', t('settings.autoCheckAgreement'), t('settings.autoCheckAgreement.hint'), config.autoCheckAgreement)}
            ${this.renderSwitchRow('enableNotification', t('settings.notification'), t('settings.notification.hint'), config.enableNotification)}
            ${this.renderSwitchRow('autoSubmit', t('settings.autoSubmit'), t('settings.autoSubmit.hint'), config.autoSubmit ?? false)}
            ${this.renderSwitchRow('autoSolveOnRule', t('settings.autoSolveOnRule'), t('settings.autoSolveOnRule.hint'), config.autoSolveOnRule ?? true)}
            ${this.renderSwitchRow('debugMode', t('settings.debugMode'), t('settings.debugMode.hint'), config.debugMode)}
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('settings.selectors')}</div>
            <div class="ddddocr-row-label">${t('settings.captchaSelector')}</div>
            <input type="text" class="ddddocr-input" data-key="captchaSelector" placeholder="img.captcha, #captchaImg" value="${escapeHtml(config.captchaSelector || '')}">
            <div class="ddddocr-row-label" style="margin-top: 12px;">${t('settings.inputSelector')}</div>
            <input type="text" class="ddddocr-input" data-key="inputSelector" placeholder="input#code, .captcha-input" value="${escapeHtml(config.inputSelector || '')}">
            <div class="ddddocr-row-label" style="margin-top: 12px;">${t('settings.submitSelector')}</div>
            <input type="text" class="ddddocr-input" data-key="submitSelector" placeholder="${t('settings.submitSelector.placeholder')}" value="${escapeHtml(config.submitSelector || '')}">
            <div class="ddddocr-hint">${t('settings.captchaSelector.hint')}</div>
            <div class="ddddocr-row-label" style="margin-top: 12px;">${t('settings.agreementSelector')}</div>
            <div id="agreementSelectorsList">${agreementHtml}</div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <input type="text" class="ddddocr-input" id="newAgreementSelector" placeholder="${t('settings.agreementSelector.placeholder')}" style="margin-top: 0; flex: 1;">
              <button class="ddddocr-btn ddddocr-btn-primary ddddocr-btn-sm" id="addAgreementSelectorBtn">${t('common.add')}</button>
            </div>
            <div class="ddddocr-hint">${t('settings.agreementSelector.hint')}</div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('settings.appearance')}</div>
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">${t('settings.theme')}</div>
              </div>
              <select class="ddddocr-select" data-key="theme" style="margin-top:0; width: auto; min-width: 120px;">
                <option value="auto" ${config.theme === 'auto' ? 'selected' : ''}>${t('settings.theme.auto')}</option>
                <option value="light" ${config.theme === 'light' ? 'selected' : ''}>${t('settings.theme.light')}</option>
                <option value="dark" ${config.theme === 'dark' ? 'selected' : ''}>${t('settings.theme.dark')}</option>
              </select>
            </div>
            <div class="ddddocr-row">
              <div class="ddddocr-row-info">
                <div class="ddddocr-row-label">${t('settings.language')}</div>
                <div class="ddddocr-row-desc">${t('settings.language.hint')}</div>
              </div>
              <select class="ddddocr-select" data-key="language" style="margin-top:0; width: auto; min-width: 120px;">
                <option value="auto" ${config.language === 'auto' ? 'selected' : ''}>${t('settings.language.auto')}</option>
                <option value="zh" ${config.language === 'zh' ? 'selected' : ''}>${t('settings.language.zh')}</option>
                <option value="ja" ${config.language === 'ja' ? 'selected' : ''}>${t('settings.language.ja')}</option>
                <option value="en" ${config.language === 'en' ? 'selected' : ''}>${t('settings.language.en')}</option>
              </select>
            </div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('settings.keywords.title')}</div>
            <div id="ddddocr-keyword-chip-groups">
              ${this.renderKeywordChipGroupsHtml()}
            </div>
          </div>
        </div>

        <!-- Site Rules -->
        <div class="ddddocr-panel" data-panel="rules">
          <div class="ddddocr-card">
            <div class="ddddocr-card-header">
              <div class="ddddocr-card-title">${t('rules.saved')}</div>
              <div style="display: flex; gap: 8px;">
                <button class="ddddocr-btn ddddocr-btn-secondary ddddocr-btn-sm" id="exportRulesBtn">${t('common.export')}</button>
                <button class="ddddocr-btn ddddocr-btn-secondary ddddocr-btn-sm" id="importRulesBtn">${t('common.import')}</button>
              </div>
            </div>
            <div id="siteRulesList">${siteRulesHtml}</div>
          </div>
          <div class="ddddocr-card" id="editRuleCard" style="display: none;">
            <div class="ddddocr-card-title">${t('rules.edit')}</div>
            <div class="ddddocr-row-label">${t('rules.ruleId')}</div>
            <input type="text" class="ddddocr-input" id="editRuleKey" readonly>
            <input type="hidden" id="editRuleOriginalKey">
            <div class="ddddocr-row-label" style="margin-top: 12px;">${t('rules.captchaSelector')}</div>
            <input type="text" class="ddddocr-input" id="editRuleSelector" placeholder="${t('rules.captchaSelector.placeholder')}">
            <div class="ddddocr-row-label" style="margin-top: 12px;">${t('rules.inputSelector')}</div>
            <input type="text" class="ddddocr-input" id="editRuleInput" placeholder="${t('rules.inputSelector.placeholder')}">
            <div class="ddddocr-btn-group">
              <button class="ddddocr-btn ddddocr-btn-primary" id="saveEditRuleBtn">${t('rules.saveEdit')}</button>
              <button class="ddddocr-btn ddddocr-btn-secondary" id="cancelEditRuleBtn">${t('common.cancel')}</button>
            </div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('rules.bulk')}</div>
            <div class="ddddocr-row-label">${t('rules.ruleId')}</div>
            <input type="text" class="ddddocr-input" id="newRuleHostname" placeholder="${t('rules.ruleId.placeholder')}" style="margin-top: 0;">
            <div class="ddddocr-row-label" style="margin-top: 12px;">${t('rules.captchaSelector')}</div>
            <input type="text" class="ddddocr-input" id="newRuleSelector" placeholder="${t('rules.captchaSelector.placeholder')}">
            <div class="ddddocr-row-label" style="margin-top: 12px;">${t('rules.inputSelector')}</div>
            <input type="text" class="ddddocr-input" id="newRuleInputSelector" placeholder="${t('rules.inputSelector.placeholder')}">
            <button class="ddddocr-btn ddddocr-btn-primary" id="addSiteRuleBtn" style="margin-top: 16px;">${t('rules.bulkAdd')}</button>
          </div>
        </div>

        <!-- Statistics -->
        <div class="ddddocr-panel" data-panel="stats">
          ${statsHtml}
        </div>

        <!-- Arithmetic -->
        <div class="ddddocr-panel" data-panel="calculate">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('calc.arithmetic')}</div>
            ${this.renderSwitchRow('autoCalculate', t('calc.autoCalc'), t('calc.autoCalcHint'), config.autoCalculate)}
            <div id="calculateOptionsArea" style="display: ${config.autoCalculate ? 'block' : 'none'}">
              <div class="ddddocr-row-label" style="margin-top: 16px;">${t('calc.outputMode')}</div>
              <select class="ddddocr-select" data-key="calculateOutputMode">
                <option value="result" ${config.calculateOutputMode === 'result' ? 'selected' : ''}>${t('calc.outputResultExample')}</option>
                <option value="equation" ${config.calculateOutputMode === 'equation' ? 'selected' : ''}>${t('calc.outputEquationExample')}</option>
              </select>
              <div class="ddddocr-hint">${t('calc.outputHint')}</div>
            </div>
          </div>
          <div class="ddddocr-card" id="calculateRulesCard" style="display: ${config.autoCalculate ? 'block' : 'none'}">
            <div class="ddddocr-card-title">${t('calc.siteRules')}</div>
            <div id="calculateRulesList">${calcRulesHtml}</div>
            <div class="ddddocr-add-rule">
              <input type="text" class="ddddocr-input" id="newCalcRulePattern" placeholder="${t('calc.patternPlaceholder')}" style="margin-top:0">
              <select class="ddddocr-select" id="newCalcRuleMatchType" style="margin-top:0">
                <option value="wildcard">${t('calc.wildcard')}</option>
                <option value="regex">${t('calc.regexFull')}</option>
              </select>
              <select class="ddddocr-select" id="newCalcRuleOutputMode" style="margin-top:0">
                <option value="result">${t('calc.outputResult')}</option>
                <option value="equation">${t('calc.outputEquation')}</option>
              </select>
              <button class="ddddocr-btn ddddocr-btn-primary ddddocr-btn-sm" id="addCalcRuleBtn">${t('common.add')}</button>
            </div>
            <div class="ddddocr-hint">
              <b>${t('calc.wildcard')}:</b> ${t('calc.wildcardHint')}<br>
              <b>${t('calc.regex')}:</b> ${t('calc.regexHint')}
            </div>
          </div>
        </div>

        <!-- Model Management -->
        <div class="ddddocr-panel" data-panel="model">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('model.source')}</div>
            ${hasUploadedModel ? `<div class="ddddocr-badge">[${t('common.enabled')}] ${t('model.upload')} (${(uploadedModelSize / 1024 / 1024).toFixed(1)} MB)</div>` : ''}
            ${this.renderSwitchRow('useUploadedModel', t('model.source'), t('model.upload'), config.useUploadedModel)}
            ${this.renderSwitchRow('autoDownload', t('settings.detect.auto'), t('model.downloadDisabled'), config.autoDownload)}
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('model.upload')}</div>
            <div class="ddddocr-file-zone" id="modelZone">
              <input type="file" id="modelFile" accept=".onnx">
              <div class="ddddocr-file-icon">[ONNX]</div>
              <div class="ddddocr-file-text">${t('model.selectFiles')} common.onnx</div>
              <div class="ddddocr-file-name" id="modelName"></div>
            </div>
            <div class="ddddocr-file-zone" id="charsetsZone" style="margin-top: 12px;">
              <input type="file" id="charsetsFile" accept=".json">
              <div class="ddddocr-file-icon">[JSON]</div>
              <div class="ddddocr-file-text">${t('model.selectFiles')} charsets.json</div>
              <div class="ddddocr-file-name" id="charsetsName"></div>
            </div>
            <div class="ddddocr-btn-group">
              <button class="ddddocr-btn ddddocr-btn-primary" id="uploadBtn">${t('common.save')}</button>
              <button class="ddddocr-btn ddddocr-btn-danger" id="deleteModelBtn">${t('model.deleteTitle')}</button>
            </div>
          </div>
        </div>

        <!-- Site Whitelist -->
        <div class="ddddocr-panel" data-panel="whitelist">
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('whitelist.settings')}</div>
            ${this.renderSwitchRow('enableWhitelist', t('whitelist.title'), t('whitelist.settings'), config.enableWhitelist)}
            <div id="whitelistArea" style="display: ${config.enableWhitelist ? 'block' : 'none'}">
              <textarea class="ddddocr-textarea" data-key="whitelist" placeholder="example.com&#10;*.example.com&#10;sub.example.com">${(config.whitelist || []).join('\n')}</textarea>
              <div class="ddddocr-hint">${window.location.hostname}</div>
            </div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('blacklist.title')}</div>
            <div class="ddddocr-row-label">${t('blacklist.label')}</div>
            <textarea class="ddddocr-textarea" data-key="siteBlacklist" placeholder="${t('blacklist.placeholder')}">${(config.siteBlacklist || []).join('\n')}</textarea>
            <div class="ddddocr-hint">${t('blacklist.hint')}</div>
          </div>
          <div class="ddddocr-card">
            <div class="ddddocr-card-title">${t('config.importExport')}</div>
            <div class="ddddocr-btn-group">
              <button class="ddddocr-btn ddddocr-btn-secondary" id="exportBtn">${t('common.export')}</button>
              <button class="ddddocr-btn ddddocr-btn-secondary" id="importBtn">${t('common.import')}</button>
              <button class="ddddocr-btn ddddocr-btn-danger" id="resetBtn">${t('common.reset')}</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    document.body.appendChild(this.container);
    this.containerLocale = getCurrentLocale();
    this.applyTheme();
    this.setupThemeMediaQuery();
    this.renderAllChipGroups();
    this.bindEvents();
    this.bindChipEvents();
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
      return `<div class="ddddocr-empty">${t('calc.noRules')}</div>`;
    }
    return rules.map((rule, index) => `
      <div class="ddddocr-rule-item" data-index="${index}">
        <span class="ddddocr-rule-pattern">${escapeHtml(rule.pattern)}</span>
        <span class="ddddocr-rule-type">${rule.matchType === 'regex' ? t('calc.regex') : t('calc.wildcard')}</span>
        <span class="ddddocr-rule-output">${rule.outputMode === 'result' ? t('calc.outputResult') : t('calc.outputEquation')}</span>
        <button class="ddddocr-rule-delete btn-delete-calc-rule" data-index="${index}">×</button>
      </div>
    `).join('');
  }

  private renderSiteRules(): string {
    const rules = getSiteRules();
    const keys = Object.keys(rules);
    if (keys.length === 0) {
      return `<div class="ddddocr-empty">${t('rules.empty')}</div>`;
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
            ${rule.fullUrl ? `<div class="ddddocr-site-rule-badge">${t('rules.fullUrlMatch')}</div>` : ''}
          </div>
          <div class="ddddocr-site-rule-actions">
            <button class="ddddocr-rule-edit btn-edit-site-rule" data-key="${escapeHtml(key)}">${t('common.edit')}</button>
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
      rankHtml = `<div class="ddddocr-empty">${t('stats.empty')}</div>`;
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
                <span>${t('stats.avg', siteAvgTime)}</span>
                <span>${t('stats.last', lastTimeStr)}</span>
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
          <div class="ddddocr-stat-label">${t('stats.totalCount')}</div>
          <div class="ddddocr-stat-value">${stats.total}<span class="ddddocr-stat-unit">${t('common.times')}</span></div>
        </div>
        <div class="ddddocr-stat-card accent">
          <div class="ddddocr-stat-label">${t('stats.siteCount')}</div>
          <div class="ddddocr-stat-value">${sites.length}<span class="ddddocr-stat-unit">${t('common.items')}</span></div>
        </div>
        <div class="ddddocr-stat-card success">
          <div class="ddddocr-stat-label">${t('stats.avgTime')}</div>
          <div class="ddddocr-stat-value">${avgTime}<span class="ddddocr-stat-unit">ms</span></div>
        </div>
        <div class="ddddocr-stat-card warning">
          <div class="ddddocr-stat-label">${t('stats.lastUpdate')}</div>
          <div class="ddddocr-stat-value" style="font-size: 16px;">${lastUpdate}</div>
        </div>
      </div>
      <div class="ddddocr-card">
        <div class="ddddocr-card-header">
          <div class="ddddocr-card-title">${t('stats.ranking')}</div>
          <button class="ddddocr-btn ddddocr-btn-danger ddddocr-btn-sm" id="clearStatsBtn">${t('stats.clear')}</button>
        </div>
        <div class="ddddocr-rank-list" id="statsRankList">${rankHtml}</div>
      </div>
    `;
  }

  private renderAgreementSelectors(selectors: string[]): string {
    if (!selectors || selectors.length === 0) {
      return `<div class="ddddocr-empty" style="padding: 12px;">${t('settings.agreementSelector.empty')}</div>`;
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

    // 开关事件 — 实时保存
    this.container.querySelectorAll('.ddddocr-switch').forEach(sw => {
      sw.addEventListener('click', () => {
        sw.classList.toggle('on');
        const key = (sw as HTMLElement).dataset.key;
        const value = sw.classList.contains('on');
        if (key) {
          saveConfig({ [key]: value } as any);
          this.onConfigChange(getConfig());
        }
        if (key === 'enableWhitelist') {
          const area = this.container!.querySelector('#whitelistArea') as HTMLElement;
          if (area) area.style.display = value ? 'block' : 'none';
        }
        if (key === 'autoCalculate') {
          const optionsArea = this.container!.querySelector('#calculateOptionsArea') as HTMLElement;
          const rulesCard = this.container!.querySelector('#calculateRulesCard') as HTMLElement;
          if (optionsArea) optionsArea.style.display = value ? 'block' : 'none';
          if (rulesCard) rulesCard.style.display = value ? 'block' : 'none';
        }
      });
    });

    // 输入框 — 失焦时实时保存
    this.container.querySelectorAll('input[data-key]').forEach(input => {
      input.addEventListener('change', () => {
        const key = (input as HTMLInputElement).dataset.key;
        if (key) {
          saveConfig({ [key]: (input as HTMLInputElement).value.trim() } as any);
          this.onConfigChange(getConfig());
        }
      });
    });

    // 下拉选择 — 实时保存（含 theme/language 特殊处理）
    this.container.querySelectorAll('select[data-key]').forEach(select => {
      select.addEventListener('change', () => {
        const key = (select as HTMLSelectElement).dataset.key;
        const value = (select as HTMLSelectElement).value;
        if (!key) return;
        saveConfig({ [key]: value } as any);
        if (key === 'theme') {
          // 即时应用主题
          if (this.container) {
            const colors = getThemeColors(value as 'light' | 'dark' | 'auto');
            for (const [k, v] of Object.entries(colors)) {
              this.container.style.setProperty(k, v);
            }
          }
        }
        if (key === 'language') {
          // 即时切换 locale + 重建 UI
          if (value === 'auto') initLocale('auto');
          else setLocale(value as Locale);
          this.onConfigChange(getConfig());
          this.destroyContainer();
          this.createContainer().then(() => {
            this.isVisible = true;
            this.overlay?.classList.add('visible');
            this.container?.classList.add('visible');
            if (isMobile()) this.container?.classList.add('mobile');
          });
          return;
        }
        this.onConfigChange(getConfig());
      });
    });

    // textarea — 防抖实时保存
    let debounceTimer: number | null = null;
    this.container.querySelectorAll('textarea[data-key]').forEach(textarea => {
      textarea.addEventListener('input', () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          const key = (textarea as HTMLTextAreaElement).dataset.key;
          if (key) {
            const val = (textarea as HTMLTextAreaElement).value;
            saveConfig({ [key]: val.split('\n').filter(line => line.trim()) } as any);
            this.onConfigChange(getConfig());
          }
        }, 500);
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
        Dialog.show({ title: t('common.hint'), content: t('model.selectFiles'), icon: '' });
        return;
      }
      try {
        await saveUploadedModel(modelFile, charsetsFile);
        saveConfig({ useUploadedModel: true });
        Dialog.show({ title: t('common.success'), content: t('model.saved'), icon: '' });
      } catch (e) {
        Dialog.show({ title: t('common.error'), content: String(e), icon: '' });
      }
    });

    this.container?.querySelector('#deleteModelBtn')?.addEventListener('click', () => {
      Dialog.confirm({
        title: t('model.deleteTitle'),
        content: t('model.deleteConfirm'),
        onConfirm: async () => {
          await deleteUploadedModel();
          saveConfig({ useUploadedModel: false });
          Dialog.show({ title: t('common.success'), content: t('model.deleted'), icon: '' });
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
      Dialog.show({ title: t('common.hint'), content: t('settings.agreementSelector.enterSelector'), icon: '' });
      return;
    }
    const config = getConfig();
    const selectors: string[] = config.agreementSelectors || [];
    if (selectors.includes(selector)) {
      Dialog.show({ title: t('common.hint'), content: t('settings.agreementSelector.exists'), icon: '' });
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
      Dialog.show({ title: t('common.hint'), content: t('calc.enterPattern'), icon: '' });
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
      Dialog.show({ title: t('common.hint'), content: t('rules.selectorRequired'), icon: '' });
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
      Dialog.show({ title: t('common.hint'), content: t('rules.selectorRequired'), icon: '' });
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
      title: t('rules.deleteConfirm'),
      content: t('rules.deleteConfirmMsg', key),
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
        if (!Array.isArray(rules)) throw new Error(t('rules.formatError'));
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
        Dialog.show({ title: t('common.success'), content: t('rules.importedCount', rules.length), icon: '' });
      } catch {
        Dialog.show({ title: t('common.error'), content: t('rules.importFormatError'), icon: '' });
      }
    };
    input.click();
  }

  private clearStats(): void {
    Dialog.confirm({
      title: t('stats.clear'),
      content: t('stats.clearConfirm'),
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
        Dialog.show({ title: t('common.success'), content: t('config.importedRefresh'), icon: '' });
      } catch {
        Dialog.show({ title: t('common.error'), content: t('config.importError'), icon: '' });
      }
    };
    input.click();
  }

  private resetConfig(): void {
    Dialog.confirm({
      title: t('common.reset'),
      content: t('config.resetConfirmSimple'),
      onConfirm: () => {
        GM_setValue(CONFIG_KEY, DEFAULT_CONFIG);
        Dialog.show({ title: t('common.success'), content: t('config.resetDoneRefresh'), icon: '' });
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

  private renderKeywordChipGroupsHtml(): string {
    const i18nKeys: Record<ChipFieldKey, { titleKey: string; placeholderKey: string; hintKey: string }> = {
      customIncludeKeywords: { titleKey: 'settings.keywords.triggerTitle', placeholderKey: 'settings.keywords.triggerPlaceholder', hintKey: 'settings.keywords.triggerHint' },
      customExcludePatterns: { titleKey: 'settings.keywords.excludeTitle', placeholderKey: 'settings.keywords.excludePlaceholder', hintKey: 'settings.keywords.excludeHint' },
      customAgreementKeywords: { titleKey: 'settings.keywords.agreementTitle', placeholderKey: 'settings.keywords.agreementPlaceholder', hintKey: 'settings.keywords.agreementHint' },
      customInputExcludeKeywords: { titleKey: 'settings.keywords.inputExcludeTitle', placeholderKey: 'settings.keywords.inputExcludePlaceholder', hintKey: 'settings.keywords.inputExcludeHint' },
    };

    return (Object.keys(this.CHIP_META) as ChipFieldKey[]).map((field) => {
      const keys = i18nKeys[field];
      return `
        <div class="ddddocr-keyword-group" data-chip-field="${field}">
          <div class="ddddocr-keyword-header">
            <div class="ddddocr-row-label">${t(keys.titleKey)}</div>
            <div class="ddddocr-keyword-actions">
              <span class="ddddocr-keyword-subtitle">${t('settings.keywords.builtinDeletable')}</span>
              <button class="ddddocr-chip-reset" data-chip-field="${field}">${t('settings.keywords.resetDefault')}</button>
            </div>
          </div>
          <div class="ddddocr-chip-list" id="ddddocr-${field}-list"></div>
          <div class="ddddocr-chip-input-row">
            <input type="text" class="ddddocr-chip-input" id="ddddocr-${field}-input" placeholder="${t(keys.placeholderKey)}">
          </div>
          <div class="ddddocr-hint">${t(keys.hintKey)}</div>
        </div>
      `;
    }).join('');
  }

  private getEnabledBuiltinKeywords(field: ChipFieldKey, config: OCRConfig): string[] {
    const meta = this.CHIP_META[field];
    const disabled = new Set(((config as any)[meta.disabledKey] || []).map((item: string) => item.toLowerCase()));
    return meta.builtin.filter((item) => !disabled.has(item.toLowerCase()));
  }

  private renderChipList(field: ChipFieldKey, config: OCRConfig): void {
    const list = this.container?.querySelector(`#ddddocr-${field}-list`);
    if (!list) return;

    const builtinItems = this.getEnabledBuiltinKeywords(field, config).map((value) => ({ value, kind: 'builtin' as const }));
    const customItems = ((config as any)[field] || []).map((value: string) => ({ value, kind: 'custom' as const }));
    const items = [...builtinItems, ...customItems];

    if (items.length === 0) {
      list.innerHTML = `<div class="ddddocr-chip-empty">${t('settings.keywords.empty')}</div>`;
      return;
    }

    list.innerHTML = items.map((item) => `
      <span class="ddddocr-chip-item ${item.kind}">
        <span class="ddddocr-chip-text">${escapeHtml(item.value)}</span>
        <span class="ddddocr-chip-meta">${item.kind === 'builtin' ? t('settings.keywords.builtin') : t('settings.keywords.custom')}</span>
        <button type="button" class="ddddocr-chip-remove" data-chip-field="${field}" data-chip-kind="${item.kind}" data-chip-value="${escapeHtml(item.value)}">×</button>
      </span>
    `).join('');
  }

  private renderAllChipGroups(): void {
    const config = getConfig();
    (Object.keys(this.CHIP_META) as ChipFieldKey[]).forEach((field) => this.renderChipList(field, config));
  }

  private bindChipEvents(): void {
    if (!this.container) return;

    // Enter key to add keywords
    (Object.keys(this.CHIP_META) as ChipFieldKey[]).forEach((field) => {
      const input = this.container?.querySelector(`#ddddocr-${field}-input`) as HTMLInputElement | null;
      input?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();

        const value = input.value.trim();
        if (!value) return;

        const config = getConfig();
        const existing = new Set([
          ...((config as any)[field] || []).map((item: string) => item.toLowerCase()),
          ...this.CHIP_META[field].builtin.map((item) => item.toLowerCase()),
        ]);

        if (existing.has(value.toLowerCase())) {
          Dialog.show({ title: t('common.hint'), content: t('settings.keywords.exists'), icon: '' });
          return;
        }

        const current = (config as any)[field] || [];
        saveConfig({ [field]: [...current, value] } as any);
        input.value = '';
        this.renderAllChipGroups();
      });
    });

    // Click delegation for remove and reset buttons
    this.container.querySelector('#ddddocr-keyword-chip-groups')?.addEventListener('click', (event) => {
      this.handleChipClick(event);
    });
  }

  private handleChipClick(event: Event): void {
    const target = event.target as HTMLElement;

    // Handle remove button
    const removeBtn = target.closest('.ddddocr-chip-remove') as HTMLElement | null;
    if (removeBtn) {
      const field = removeBtn.dataset.chipField as ChipFieldKey;
      const kind = removeBtn.dataset.chipKind as 'builtin' | 'custom';
      const value = removeBtn.dataset.chipValue || '';
      const config = getConfig();

      if (kind === 'builtin') {
        const disabledKey = this.CHIP_META[field].disabledKey;
        const current = (config as any)[disabledKey] || [];
        saveConfig({ [disabledKey]: Array.from(new Set([...current, value])) } as any);
      } else {
        const current: string[] = (config as any)[field] || [];
        saveConfig({ [field]: current.filter((item: string) => item.toLowerCase() !== value.toLowerCase()) } as any);
      }

      this.renderAllChipGroups();
      return;
    }

    // Handle reset button
    const resetBtn = target.closest('.ddddocr-chip-reset') as HTMLElement | null;
    if (resetBtn) {
      const field = resetBtn.dataset.chipField as ChipFieldKey;
      saveConfig({
        [field]: [],
        [this.CHIP_META[field].disabledKey]: [],
      } as any);
      this.renderAllChipGroups();
    }
  }

  private destroyContainer(): void {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    if (this.container) { this.container.remove(); this.container = null; }
    this.containerLocale = '';
  }

  public async show(): Promise<void> {
    // 如果 locale 变了或没创建过，重新创建
    if (!this.container || this.containerLocale !== getCurrentLocale()) {
      this.destroyContainer();
      await this.createContainer();
    }
    this.applyTheme();
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