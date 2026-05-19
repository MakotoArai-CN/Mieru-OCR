import { CONSTANTS, DEFAULT_CONFIG, getThemeColors } from '@core/config';
import type { OCRConfig, CalculateRule, SiteRule } from '@core/types';
import { t, initLocale, setLocale, getCurrentLocale, translatePage } from '@core/i18n';
import type { Locale } from '@core/i18n';
import { Dialog } from './dialog';
import { saveUploadedModel, deleteUploadedModel, ModelCache } from './model-loader';
import { getConfig, saveConfig, getSiteRules, saveSiteRule, deleteSiteRule, statsManager } from './storage';
import { buildReport, downloadReport, clearLogs } from '@core/diagnostics';
import {
  getSubscriptions,
  addSubscription,
  deleteSubscription,
  refreshSubscription,
  updateSubscriptionMeta,
} from './subscription-manager';
import type { Subscription } from '@core/subscription';

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
    style.id = 'Mieru-settings-styles';
    style.textContent = `
.Mieru-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  z-index: 2147483646;
  display: none;
  animation: Mieru-fade 0.2s ease;
  -webkit-overflow-scrolling: touch;
}
.Mieru-overlay.visible { display: block; }

.Mieru-modal {
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
.Mieru-modal.visible {
  display: block;
  animation: Mieru-scale 0.3s ease;
}
.Mieru-modal.mobile {
  width: 100%;
  max-width: 100%;
  height: 100%;
  max-height: 100%;
  top: 0;
  left: 0;
  transform: none;
  border-radius: 0;
}

@keyframes Mieru-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes Mieru-scale {
  from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
.Mieru-modal.mobile.visible {
  animation: Mieru-slide-up 0.3s ease;
}
@keyframes Mieru-slide-up {
  from { opacity: 0; transform: translateY(100%); }
  to { opacity: 1; transform: translateY(0); }
}

.Mieru-header {
  background: rgba(255, 255, 255, 0.15);
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.15);
}
.Mieru-modal.mobile .Mieru-header {
  padding: 16px;
  position: sticky;
  top: 0;
  z-index: 10;
}

.Mieru-title {
  color: white;
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 10px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
.Mieru-modal.mobile .Mieru-title { font-size: 18px; }

.Mieru-close {
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
.Mieru-close:hover { background: rgb(242, 0, 105); }
.Mieru-close:active { background: rgba(255, 255, 255, 0.5); }
.Mieru-modal.mobile .Mieru-close { width: 44px; height: 44px; min-width: 44px; min-height: 44px; }

.Mieru-tabs {
  display: flex;
  background: rgba(255, 255, 255, 0.1);
  padding: 0 16px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.Mieru-tabs::-webkit-scrollbar { display: none; }
.Mieru-modal.mobile .Mieru-tabs { padding: 0 8px; position: sticky; top: 76px; z-index: 10; }

.Mieru-tab {
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
.Mieru-modal.mobile .Mieru-tab { padding: 12px 14px; font-size: 14px; min-height: 48px; }
.Mieru-tab:hover { color: white; }
.Mieru-tab.active { color: white; }
.Mieru-tab.active::after {
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

.Mieru-content {
  background: var(--bg-secondary);
  padding: 24px;
  max-height: calc(85vh - 180px);
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
}
.Mieru-modal.mobile .Mieru-content {
  padding: 16px;
  max-height: none;
  height: calc(100% - 140px);
  padding-bottom: 24px;
}
.Mieru-content::-webkit-scrollbar { width: 6px; }
.Mieru-content::-webkit-scrollbar-track { background: var(--border); border-radius: 3px; }
.Mieru-content::-webkit-scrollbar-thumb { background: #FFB6C1; border-radius: 3px; }
.Mieru-content::-webkit-scrollbar-thumb:hover { background: #FF69B4; }

.Mieru-panel { display: none; }
.Mieru-panel.active { display: block; }

.Mieru-card {
  background: var(--bg-primary);
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 2px 12px rgba(74, 144, 226, 0.08);
  border: 1px solid rgba(74, 144, 226, 0.06);
}
.Mieru-modal.mobile .Mieru-card { padding: 16px; border-radius: 12px; }

.Mieru-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.Mieru-card-title::before {
  content: '';
  width: 4px;
  height: 16px;
  background: #4A90E2;
  border-radius: 2px;
}

.Mieru-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
  gap: 12px;
}
.Mieru-modal.mobile .Mieru-row { padding: 16px 0; }
.Mieru-row:last-child { border-bottom: none; }

.Mieru-row-info { flex: 1; min-width: 0; }
.Mieru-row-label { font-size: 14px; color: var(--text-primary); font-weight: 500; }
.Mieru-modal.mobile .Mieru-row-label { font-size: 15px; }
.Mieru-row-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.Mieru-modal.mobile .Mieru-row-desc { font-size: 13px; }

.Mieru-switch {
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
.Mieru-modal.mobile .Mieru-switch { width: 56px; height: 32px; min-width: 56px; }
.Mieru-switch.on { background: #4A90E2; }
.Mieru-switch-knob {
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
.Mieru-modal.mobile .Mieru-switch-knob { width: 26px; height: 26px; }
.Mieru-switch.on .Mieru-switch-knob { transform: translateX(22px); }
.Mieru-modal.mobile .Mieru-switch.on .Mieru-switch-knob { transform: translateX(24px); }

.Mieru-input {
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
.Mieru-modal.mobile .Mieru-input { padding: 14px 16px; font-size: 16px; border-radius: 12px; }
.Mieru-input:focus { outline: none; border-color: #4A90E2; box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.15); }

.Mieru-select {
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
.Mieru-modal.mobile .Mieru-select { padding: 14px 16px; font-size: 16px; border-radius: 12px; }
.Mieru-select:focus { outline: none; border-color: #4A90E2; }

.Mieru-textarea {
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
.Mieru-modal.mobile .Mieru-textarea { padding: 14px 16px; font-size: 14px; min-height: 120px; border-radius: 12px; }
.Mieru-textarea:focus { outline: none; border-color: #4A90E2; box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.15); }

.Mieru-file-zone {
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
.Mieru-file-zone:hover { border-color: #4A90E2; background: rgba(74, 144, 226, 0.05); }
.Mieru-file-zone:active { background: rgba(74, 144, 226, 0.1); }
.Mieru-file-zone input { display: none; }
.Mieru-file-icon { font-size: 32px; margin-bottom: 8px; color: #4A90E2; }
.Mieru-file-text { font-size: 13px; color: var(--text-secondary); }
.Mieru-file-name { font-size: 12px; color: #4A90E2; margin-top: 8px; font-weight: 500; }

.Mieru-btn-group { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
.Mieru-btn {
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
.Mieru-modal.mobile .Mieru-btn { padding: 14px 20px; font-size: 15px; min-height: 48px; }
.Mieru-btn-primary { background: #4A90E2; color: white; }
.Mieru-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(74, 144, 226, 0.35); }
.Mieru-btn-primary:active { transform: translateY(0); }
.Mieru-btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); }
.Mieru-btn-secondary:hover { background: var(--border); }
.Mieru-btn-secondary:active { background: var(--bg-hover); }
.Mieru-btn-danger { background: #fee2e2; color: #dc2626; }
.Mieru-btn-danger:hover { background: #fecaca; }
.Mieru-btn-danger:active { background: #fca5a5; }
.Mieru-btn-sm { padding: 8px 14px; font-size: 12px; flex: none;}
.Mieru-modal.mobile .Mieru-btn-sm { padding: 10px 16px; font-size: 13px; min-height: 40px; }

.Mieru-hint {
  background: rgba(74, 144, 226, 0.08);
  border: 1px solid rgba(74, 144, 226, 0.15);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 12px;
}
.Mieru-modal.mobile .Mieru-hint { font-size: 13px; padding: 14px 16px; }

.Mieru-badge {
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

.Mieru-rule-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: 10px;
  margin-bottom: 8px;
  border: 1px solid rgba(74, 144, 226, 0.08);
}
.Mieru-modal.mobile .Mieru-rule-item { flex-wrap: wrap; padding: 14px; }
.Mieru-rule-item:last-child { margin-bottom: 0; }
.Mieru-rule-pattern { flex: 1; font-family: monospace; font-size: 13px; color: var(--text-primary); word-break: break-all; min-width: 0; }
.Mieru-rule-type { font-size: 11px; padding: 4px 8px; background: var(--border); border-radius: 4px; color: var(--text-secondary); white-space: nowrap; }
.Mieru-rule-output { font-size: 11px; padding: 4px 8px; background: #dbeafe; border-radius: 4px; color: #4A90E2; white-space: nowrap; }
.Mieru-rule-delete {
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
.Mieru-rule-edit {
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

.Mieru-empty { text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px; }

.Mieru-add-rule { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.Mieru-add-rule input { flex: 2; min-width: 120px; }
.Mieru-add-rule select { flex: 1; min-width: 80px; }
.Mieru-modal.mobile .Mieru-add-rule { flex-direction: column; }
.Mieru-modal.mobile .Mieru-add-rule input,
.Mieru-modal.mobile .Mieru-add-rule select { width: 100%; flex: none; }

/* 统计样式 */
.Mieru-stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.Mieru-modal.mobile .Mieru-stats-grid { grid-template-columns: 1fr; }

.Mieru-stat-card {
  background: linear-gradient(135deg, #4A90E2 0%, #357ABD 100%);
  border-radius: 12px;
  padding: 16px;
  color: white;
  position: relative;
  overflow: hidden;
}
.Mieru-stat-card::before {
  content: '';
  position: absolute;
  top: -50%;
  right: -50%;
  width: 100%;
  height: 100%;
  background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
  pointer-events: none;
}
.Mieru-stat-card.accent { background: linear-gradient(135deg, #FF69B4 0%, #FF1493 100%); }
.Mieru-stat-card.success { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
.Mieru-stat-card.warning { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }

.Mieru-stat-label { font-size: 12px; opacity: 0.9; margin-bottom: 6px; }
.Mieru-stat-value { font-size: 28px; font-weight: 700; line-height: 1; }
.Mieru-stat-unit { font-size: 14px; font-weight: 400; opacity: 0.8; margin-left: 4px; }

.Mieru-rank-list { max-height: 400px; overflow-y: auto; }
.Mieru-rank-item {
  display: flex;
  align-items: center;
  padding: 14px 12px;
  background: var(--bg-secondary);
  border-radius: 10px;
  margin-bottom: 8px;
  border: 1px solid rgba(74, 144, 226, 0.08);
  transition: all 0.2s;
}
.Mieru-rank-item:hover { background: var(--bg-tertiary); }
.Mieru-rank-item:last-child { margin-bottom: 0; }

.Mieru-rank-num {
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
.Mieru-rank-item:nth-child(1) .Mieru-rank-num { background: linear-gradient(135deg, #fbbf24, #f59e0b); color: white; }
.Mieru-rank-item:nth-child(2) .Mieru-rank-num { background: linear-gradient(135deg, #94a3b8, #64748b); color: white; }
.Mieru-rank-item:nth-child(3) .Mieru-rank-num { background: linear-gradient(135deg, #cd7f32, #b8860b); color: white; }

.Mieru-rank-info { flex: 1; min-width: 0; }
.Mieru-rank-host { font-size: 14px; font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.Mieru-rank-meta { font-size: 12px; color: var(--text-muted); margin-top: 4px; display: flex; gap: 12px; }
.Mieru-rank-count { font-size: 18px; font-weight: 700; color: #4A90E2; margin-left: 12px; flex-shrink: 0; }

.Mieru-progress-bar { height: 6px; background: var(--border); border-radius: 3px; margin-top: 8px; overflow: hidden; }
.Mieru-progress-fill { height: 100%; background: linear-gradient(90deg, #4A90E2, #FF69B4); border-radius: 3px; transition: width 0.3s ease; }

/* 站点规则样式 */
.Mieru-site-rule-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: 10px;
  margin-bottom: 10px;
  border: 1px solid rgba(74, 144, 226, 0.08);
}
.Mieru-site-rule-item:last-child { margin-bottom: 0; }
.Mieru-site-rule-info { flex: 1; min-width: 0; }
.Mieru-site-rule-key { font-size: 14px; font-weight: 500; color: var(--text-primary); word-break: break-all; margin-bottom: 4px; }
.Mieru-site-rule-selector { font-size: 12px; color: var(--text-secondary); font-family: monospace; word-break: break-all; }
.Mieru-site-rule-badge { font-size: 10px; padding: 2px 6px; background: #dbeafe; color: #4A90E2; border-radius: 4px; margin-top: 6px; display: inline-block; }
.Mieru-site-rule-actions { display: flex; gap: 4px; flex-shrink: 0; }

.Mieru-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.Mieru-card-header .Mieru-card-title { margin-bottom: 0; }

/* Chip keyword styles */
.Mieru-keyword-group {
  padding: 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 12px;
}
.Mieru-keyword-group:last-child { margin-bottom: 0; }
.Mieru-keyword-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.Mieru-keyword-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.Mieru-keyword-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}
.Mieru-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 38px;
}
.Mieru-chip-item {
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
.Mieru-chip-item.builtin { border-color: rgba(74, 144, 226, 0.35); }
.Mieru-chip-item.custom { border-color: rgba(255, 105, 180, 0.35); }
.Mieru-chip-text {
  color: var(--text-primary);
  word-break: break-all;
}
.Mieru-chip-meta {
  font-size: 11px;
  color: var(--text-muted);
}
.Mieru-chip-remove {
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
.Mieru-chip-remove:hover { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
.Mieru-chip-input-row { margin-top: 12px; }
.Mieru-chip-input {
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
.Mieru-chip-input:focus { outline: none; border-color: #4A90E2; box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.15); }
.Mieru-chip-reset {
  padding: 4px 10px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}
.Mieru-chip-reset:hover { border-color: #4A90E2; color: #4A90E2; }
.Mieru-chip-empty {
  width: 100%;
  text-align: center;
  padding: 12px;
  color: var(--text-muted);
  font-size: 12px;
}
`;
    if (!document.getElementById('Mieru-settings-styles')) {
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
    this.overlay.className = 'Mieru-overlay';

    this.container = document.createElement('div');
    this.container.className = 'Mieru-modal';
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
      <div class="Mieru-header">
        <div class="Mieru-title">${t('settings.title')}</div>
        <button class="Mieru-close">×</button>
      </div>
      <div class="Mieru-tabs">
        <button class="Mieru-tab active" data-tab="general">${t('settings.tab.general')}</button>
        <button class="Mieru-tab" data-tab="rules">${t('settings.tab.rules')}</button>
        <button class="Mieru-tab" data-tab="subscription">${t('settings.tab.subscription')}</button>
        <button class="Mieru-tab" data-tab="stats">${t('settings.tab.stats')}</button>
        <button class="Mieru-tab" data-tab="calculate">${t('settings.tab.calculate')}</button>
        <button class="Mieru-tab" data-tab="model">${t('settings.tab.model')}</button>
        <button class="Mieru-tab" data-tab="whitelist">${t('settings.tab.whitelist')}</button>
      </div>
      <div class="Mieru-content">
        <!-- General -->
        <div class="Mieru-panel active" data-panel="general">
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('settings.detect.title')}</div>
            ${this.renderSwitchRow('autoDetect', t('settings.detect.auto'), t('settings.detect.autoHint'), config.autoDetect)}
            ${this.renderSwitchRow('typewriterEffect', t('settings.typewriter'), t('settings.typewriter.hint'), config.typewriterEffect)}
            ${this.renderSwitchRow('autoCheckAgreement', t('settings.autoCheckAgreement'), t('settings.autoCheckAgreement.hint'), config.autoCheckAgreement)}
            ${this.renderSwitchRow('enableNotification', t('settings.notification'), t('settings.notification.hint'), config.enableNotification)}
            ${this.renderSwitchRow('autoSubmit', t('settings.autoSubmit'), t('settings.autoSubmit.hint'), config.autoSubmit ?? false)}
            ${this.renderSwitchRow('autoSolveOnRule', t('settings.autoSolveOnRule'), t('settings.autoSolveOnRule.hint'), config.autoSolveOnRule ?? true)}
            ${this.renderSwitchRow('preserveFocus', t('settings.preserveFocus'), t('settings.preserveFocus.hint'), config.preserveFocus ?? false)}
            ${this.renderSwitchRow('deepScan', t('settings.deepScan'), t('settings.deepScan.hint'), (config as any).deepScan ?? false)}
            ${this.renderSwitchRow('debugMode', t('settings.debugMode'), t('settings.debugMode.hint'), config.debugMode)}
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('diag.title')}</div>
            <div style="font-size: 12px; opacity: 0.75; margin-bottom: 10px;">${t('diag.hint')}</div>
            <div style="display: flex; gap: 10px; flex-wrap: wrap;">
              <button id="Mieru-diag-export" class="Mieru-btn Mieru-btn-primary">${t('diag.export')}</button>
              <button id="Mieru-diag-clear" class="Mieru-btn Mieru-btn-secondary">${t('diag.clear')}</button>
            </div>
            <div id="Mieru-diag-status" style="margin-top: 8px; font-size: 12px; opacity: 0.75; min-height: 1em;"></div>
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('settings.selectors')}</div>
            <div class="Mieru-row-label">${t('settings.captchaSelector')}</div>
            <input type="text" class="Mieru-input" data-key="captchaSelector" placeholder="img.captcha, #captchaImg" value="${escapeHtml(config.captchaSelector || '')}">
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('settings.inputSelector')}</div>
            <input type="text" class="Mieru-input" data-key="inputSelector" placeholder="input#code, .captcha-input" value="${escapeHtml(config.inputSelector || '')}">
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('settings.submitSelector')}</div>
            <input type="text" class="Mieru-input" data-key="submitSelector" placeholder="${t('settings.submitSelector.placeholder')}" value="${escapeHtml(config.submitSelector || '')}">
            <div class="Mieru-hint">${t('settings.captchaSelector.hint')}</div>
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('settings.agreementSelector')}</div>
            <div id="agreementSelectorsList">${agreementHtml}</div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <input type="text" class="Mieru-input" id="newAgreementSelector" placeholder="${t('settings.agreementSelector.placeholder')}" style="margin-top: 0; flex: 1;">
              <button class="Mieru-btn Mieru-btn-primary Mieru-btn-sm" id="addAgreementSelectorBtn">${t('common.add')}</button>
            </div>
            <div class="Mieru-hint">${t('settings.agreementSelector.hint')}</div>
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('settings.appearance')}</div>
            <div class="Mieru-row">
              <div class="Mieru-row-info">
                <div class="Mieru-row-label">${t('settings.theme')}</div>
              </div>
              <select class="Mieru-select" data-key="theme" style="margin-top:0; width: auto; min-width: 120px;">
                <option value="auto" ${config.theme === 'auto' ? 'selected' : ''}>${t('settings.theme.auto')}</option>
                <option value="light" ${config.theme === 'light' ? 'selected' : ''}>${t('settings.theme.light')}</option>
                <option value="dark" ${config.theme === 'dark' ? 'selected' : ''}>${t('settings.theme.dark')}</option>
              </select>
            </div>
            <div class="Mieru-row">
              <div class="Mieru-row-info">
                <div class="Mieru-row-label">${t('settings.language')}</div>
                <div class="Mieru-row-desc">${t('settings.language.hint')}</div>
              </div>
              <select class="Mieru-select" data-key="language" style="margin-top:0; width: auto; min-width: 120px;">
                <option value="auto" ${config.language === 'auto' ? 'selected' : ''}>${t('settings.language.auto')}</option>
                <option value="zh" ${config.language === 'zh' ? 'selected' : ''}>${t('settings.language.zh')}</option>
                <option value="ja" ${config.language === 'ja' ? 'selected' : ''}>${t('settings.language.ja')}</option>
                <option value="en" ${config.language === 'en' ? 'selected' : ''}>${t('settings.language.en')}</option>
              </select>
            </div>
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('settings.keywords.title')}</div>
            <div id="Mieru-keyword-chip-groups">
              ${this.renderKeywordChipGroupsHtml()}
            </div>
          </div>
        </div>

        <!-- Site Rules -->
        <div class="Mieru-panel" data-panel="rules">
          <div class="Mieru-card">
            <div class="Mieru-card-header">
              <div class="Mieru-card-title">${t('rules.saved')}</div>
              <div style="display: flex; gap: 8px;">
                <button class="Mieru-btn Mieru-btn-secondary Mieru-btn-sm" id="exportRulesBtn">${t('common.export')}</button>
                <button class="Mieru-btn Mieru-btn-secondary Mieru-btn-sm" id="importRulesBtn">${t('common.import')}</button>
              </div>
            </div>
            <div id="siteRulesList">${siteRulesHtml}</div>
          </div>
          <div class="Mieru-card" id="editRuleCard" style="display: none;">
            <div class="Mieru-card-title">${t('rules.edit')}</div>
            <div class="Mieru-row-label">${t('rules.ruleId')}</div>
            <input type="text" class="Mieru-input" id="editRuleKey" readonly>
            <input type="hidden" id="editRuleOriginalKey">
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('rules.captchaSelector')}</div>
            <input type="text" class="Mieru-input" id="editRuleSelector" placeholder="${t('rules.captchaSelector.placeholder')}">
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('rules.inputSelector')}</div>
            <input type="text" class="Mieru-input" id="editRuleInput" placeholder="${t('rules.inputSelector.placeholder')}">
            <div class="Mieru-btn-group">
              <button class="Mieru-btn Mieru-btn-primary" id="saveEditRuleBtn">${t('rules.saveEdit')}</button>
              <button class="Mieru-btn Mieru-btn-secondary" id="cancelEditRuleBtn">${t('common.cancel')}</button>
            </div>
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('rules.bulk')}</div>
            <div class="Mieru-row-label">${t('rules.ruleId')}</div>
            <input type="text" class="Mieru-input" id="newRuleHostname" placeholder="${t('rules.ruleId.placeholder')}" style="margin-top: 0;">
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('rules.captchaSelector')}</div>
            <input type="text" class="Mieru-input" id="newRuleSelector" placeholder="${t('rules.captchaSelector.placeholder')}">
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('rules.inputSelector')}</div>
            <input type="text" class="Mieru-input" id="newRuleInputSelector" placeholder="${t('rules.inputSelector.placeholder')}">
            <button class="Mieru-btn Mieru-btn-primary" id="addSiteRuleBtn" style="margin-top: 16px;">${t('rules.bulkAdd')}</button>
          </div>
        </div>

        <!-- Subscriptions -->
        <div class="Mieru-panel" data-panel="subscription">
          <div class="Mieru-card">
            <div class="Mieru-card-header">
              <div class="Mieru-card-title">${t('sub.title')}</div>
              <button class="Mieru-btn Mieru-btn-secondary Mieru-btn-sm" id="refreshAllSubsBtn">${t('sub.refreshAll')}</button>
            </div>
            <div id="subscriptionsList">${this.renderSubscriptions()}</div>
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('sub.add')}</div>
            <div class="Mieru-row-label">${t('sub.url')}</div>
            <input type="text" class="Mieru-input" id="newSubUrl" placeholder="${t('sub.urlPlaceholder')}">
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('sub.name')}</div>
            <input type="text" class="Mieru-input" id="newSubName" placeholder="${t('sub.namePlaceholder')}">
            <div class="Mieru-row-label" style="margin-top: 12px;">${t('sub.updateInterval')}</div>
            <select class="Mieru-select" id="newSubInterval">
              <option value="0">${t('sub.intervalNever')}</option>
              <option value="1">1</option>
              <option value="6">6</option>
              <option value="12">12</option>
              <option value="24" selected>24</option>
              <option value="72">72</option>
              <option value="168">168</option>
            </select>
            <button class="Mieru-btn Mieru-btn-primary" id="addSubBtn" style="margin-top: 16px;">${t('sub.add')}</button>
            <div class="Mieru-hint">${t('sub.hint')}</div>
          </div>
        </div>

        <!-- Statistics -->
        <div class="Mieru-panel" data-panel="stats">
          ${statsHtml}
        </div>

        <!-- Arithmetic -->
        <div class="Mieru-panel" data-panel="calculate">
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('calc.arithmetic')}</div>
            ${this.renderSwitchRow('autoCalculate', t('calc.autoCalc'), t('calc.autoCalcHint'), config.autoCalculate)}
            <div id="calculateOptionsArea" style="display: ${config.autoCalculate ? 'block' : 'none'}">
              <div class="Mieru-row-label" style="margin-top: 16px;">${t('calc.outputMode')}</div>
              <select class="Mieru-select" data-key="calculateOutputMode">
                <option value="result" ${config.calculateOutputMode === 'result' ? 'selected' : ''}>${t('calc.outputResultExample')}</option>
                <option value="equation" ${config.calculateOutputMode === 'equation' ? 'selected' : ''}>${t('calc.outputEquationExample')}</option>
              </select>
              <div class="Mieru-hint">${t('calc.outputHint')}</div>
            </div>
          </div>
          <div class="Mieru-card" id="calculateRulesCard" style="display: ${config.autoCalculate ? 'block' : 'none'}">
            <div class="Mieru-card-title">${t('calc.siteRules')}</div>
            <div id="calculateRulesList">${calcRulesHtml}</div>
            <div class="Mieru-add-rule">
              <input type="text" class="Mieru-input" id="newCalcRulePattern" placeholder="${t('calc.patternPlaceholder')}" style="margin-top:0">
              <select class="Mieru-select" id="newCalcRuleMatchType" style="margin-top:0">
                <option value="wildcard">${t('calc.wildcard')}</option>
                <option value="regex">${t('calc.regexFull')}</option>
              </select>
              <select class="Mieru-select" id="newCalcRuleOutputMode" style="margin-top:0">
                <option value="result">${t('calc.outputResult')}</option>
                <option value="equation">${t('calc.outputEquation')}</option>
              </select>
              <button class="Mieru-btn Mieru-btn-primary Mieru-btn-sm" id="addCalcRuleBtn">${t('common.add')}</button>
            </div>
            <div class="Mieru-hint">
              <b>${t('calc.wildcard')}:</b> ${t('calc.wildcardHint')}<br>
              <b>${t('calc.regex')}:</b> ${t('calc.regexHint')}
            </div>
          </div>
        </div>

        <!-- Model Management -->
        <div class="Mieru-panel" data-panel="model">
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('model.source')}</div>
            ${hasUploadedModel ? `<div class="Mieru-badge">[${t('common.enabled')}] ${t('model.upload')} (${(uploadedModelSize / 1024 / 1024).toFixed(1)} MB)</div>` : ''}
            ${this.renderSwitchRow('useUploadedModel', t('model.source'), t('model.upload'), config.useUploadedModel)}
            ${this.renderSwitchRow('autoDownload', t('settings.detect.auto'), t('model.downloadDisabled'), config.autoDownload)}
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('model.upload')}</div>
            <div class="Mieru-file-zone" id="modelZone">
              <input type="file" id="modelFile" accept=".onnx">
              <div class="Mieru-file-icon">[ONNX]</div>
              <div class="Mieru-file-text">${t('model.selectFiles')} common.onnx</div>
              <div class="Mieru-file-name" id="modelName"></div>
            </div>
            <div class="Mieru-file-zone" id="charsetsZone" style="margin-top: 12px;">
              <input type="file" id="charsetsFile" accept=".json">
              <div class="Mieru-file-icon">[JSON]</div>
              <div class="Mieru-file-text">${t('model.selectFiles')} charsets.json</div>
              <div class="Mieru-file-name" id="charsetsName"></div>
            </div>
            <div class="Mieru-btn-group">
              <button class="Mieru-btn Mieru-btn-primary" id="uploadBtn">${t('common.save')}</button>
              <button class="Mieru-btn Mieru-btn-danger" id="deleteModelBtn">${t('model.deleteTitle')}</button>
            </div>
          </div>
        </div>

        <!-- Site Whitelist -->
        <div class="Mieru-panel" data-panel="whitelist">
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('whitelist.settings')}</div>
            ${this.renderSwitchRow('enableWhitelist', t('whitelist.title'), t('whitelist.settings'), config.enableWhitelist)}
            <div id="whitelistArea" style="display: ${config.enableWhitelist ? 'block' : 'none'}">
              <textarea class="Mieru-textarea" data-key="whitelist" placeholder="example.com&#10;*.example.com&#10;sub.example.com">${(config.whitelist || []).join('\n')}</textarea>
              <div class="Mieru-hint">${window.location.hostname}</div>
            </div>
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('blacklist.title')}</div>
            <div class="Mieru-row-label">${t('blacklist.label')}</div>
            <textarea class="Mieru-textarea" data-key="siteBlacklist" placeholder="${t('blacklist.placeholder')}">${(config.siteBlacklist || []).join('\n')}</textarea>
            <div class="Mieru-hint">${t('blacklist.hint')}</div>
          </div>
          <div class="Mieru-card">
            <div class="Mieru-card-title">${t('config.importExport')}</div>
            <div class="Mieru-btn-group">
              <button class="Mieru-btn Mieru-btn-secondary" id="exportBtn">${t('common.export')}</button>
              <button class="Mieru-btn Mieru-btn-secondary" id="importBtn">${t('common.import')}</button>
              <button class="Mieru-btn Mieru-btn-danger" id="resetBtn">${t('common.reset')}</button>
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
      <div class="Mieru-row">
        <div class="Mieru-row-info">
          <div class="Mieru-row-label">${label}</div>
          <div class="Mieru-row-desc">${desc}</div>
        </div>
        <div class="Mieru-switch ${checked ? 'on' : ''}" data-key="${key}">
          <div class="Mieru-switch-knob"></div>
        </div>
      </div>
    `;
  }

  private renderCalculateRules(rules: CalculateRule[]): string {
    if (!rules || rules.length === 0) {
      return `<div class="Mieru-empty">${t('calc.noRules')}</div>`;
    }
    return rules.map((rule, index) => `
      <div class="Mieru-rule-item" data-index="${index}">
        <span class="Mieru-rule-pattern">${escapeHtml(rule.pattern)}</span>
        <span class="Mieru-rule-type">${rule.matchType === 'regex' ? t('calc.regex') : t('calc.wildcard')}</span>
        <span class="Mieru-rule-output">${rule.outputMode === 'result' ? t('calc.outputResult') : t('calc.outputEquation')}</span>
        <button class="Mieru-rule-delete btn-delete-calc-rule" data-index="${index}">×</button>
      </div>
    `).join('');
  }

  private renderSiteRules(): string {
    const rules = getSiteRules();
    const keys = Object.keys(rules);
    if (keys.length === 0) {
      return `<div class="Mieru-empty">${t('rules.empty')}</div>`;
    }
    return keys.map(key => {
      const rule = rules[key];
      const displayKey = key.length > 35 ? key.substring(0, 35) + '...' : key;
      const selectorDisplay = rule.selector.length > 40 ? rule.selector.substring(0, 40) + '...' : rule.selector;
      return `
        <div class="Mieru-site-rule-item" data-key="${escapeHtml(key)}">
          <div class="Mieru-site-rule-info">
            <div class="Mieru-site-rule-key">${escapeHtml(displayKey)}</div>
            <div class="Mieru-site-rule-selector">${escapeHtml(selectorDisplay)}</div>
            ${rule.fullUrl ? `<div class="Mieru-site-rule-badge">${t('rules.fullUrlMatch')}</div>` : ''}
          </div>
          <div class="Mieru-site-rule-actions">
            <button class="Mieru-rule-edit btn-edit-site-rule" data-key="${escapeHtml(key)}">${t('common.edit')}</button>
            <button class="Mieru-rule-delete btn-delete-site-rule" data-key="${escapeHtml(key)}">×</button>
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
      rankHtml = `<div class="Mieru-empty">${t('stats.empty')}</div>`;
    } else {
      sites.sort((a, b) => b[1].count - a[1].count);
      const topSites = sites.slice(0, 15);
      const maxCount = topSites[0]?.[1].count || 1;
      rankHtml = topSites.map(([hostname, siteStats], index) => {
        const siteAvgTime = siteStats.count > 0 ? Math.round(siteStats.totalTime / siteStats.count) : 0;
        const lastTimeStr = formatTime(siteStats.lastTime);
        const progressWidth = Math.round((siteStats.count / maxCount) * 100);
        return `
          <div class="Mieru-rank-item">
            <div class="Mieru-rank-num">${index + 1}</div>
            <div class="Mieru-rank-info">
              <div class="Mieru-rank-host">${escapeHtml(hostname)}</div>
              <div class="Mieru-rank-meta">
                <span>${t('stats.avg', siteAvgTime)}</span>
                <span>${t('stats.last', lastTimeStr)}</span>
              </div>
              <div class="Mieru-progress-bar">
                <div class="Mieru-progress-fill" style="width: ${progressWidth}%"></div>
              </div>
            </div>
            <div class="Mieru-rank-count">${siteStats.count}</div>
          </div>
        `;
      }).join('');
    }

    return `
      <div class="Mieru-stats-grid">
        <div class="Mieru-stat-card">
          <div class="Mieru-stat-label">${t('stats.totalCount')}</div>
          <div class="Mieru-stat-value">${stats.total}<span class="Mieru-stat-unit">${t('common.times')}</span></div>
        </div>
        <div class="Mieru-stat-card accent">
          <div class="Mieru-stat-label">${t('stats.siteCount')}</div>
          <div class="Mieru-stat-value">${sites.length}<span class="Mieru-stat-unit">${t('common.items')}</span></div>
        </div>
        <div class="Mieru-stat-card success">
          <div class="Mieru-stat-label">${t('stats.avgTime')}</div>
          <div class="Mieru-stat-value">${avgTime}<span class="Mieru-stat-unit">ms</span></div>
        </div>
        <div class="Mieru-stat-card warning">
          <div class="Mieru-stat-label">${t('stats.lastUpdate')}</div>
          <div class="Mieru-stat-value" style="font-size: 16px;">${lastUpdate}</div>
        </div>
      </div>
      <div class="Mieru-card">
        <div class="Mieru-card-header">
          <div class="Mieru-card-title">${t('stats.ranking')}</div>
          <button class="Mieru-btn Mieru-btn-danger Mieru-btn-sm" id="clearStatsBtn">${t('stats.clear')}</button>
        </div>
        <div class="Mieru-rank-list" id="statsRankList">${rankHtml}</div>
      </div>
    `;
  }

  private renderAgreementSelectors(selectors: string[]): string {
    if (!selectors || selectors.length === 0) {
      return `<div class="Mieru-empty" style="padding: 12px;">${t('settings.agreementSelector.empty')}</div>`;
    }
    return selectors.map((selector, index) => `
      <div class="Mieru-rule-item" data-agreement-index="${index}">
        <span class="Mieru-rule-pattern">${escapeHtml(selector)}</span>
        <button class="Mieru-rule-delete btn-delete-agreement" data-index="${index}">×</button>
      </div>
    `).join('');
  }

  private renderSubscriptions(): string {
    const subs = getSubscriptions();
    if (!subs || subs.length === 0) {
      return `<div class="Mieru-empty">${t('sub.empty')}</div>`;
    }
    const formatTime = (ts: number) => ts ? new Date(ts).toLocaleString() : '-';
    const statusText = (s: Subscription) => {
      switch (s.lastStatus) {
        case 'success': return `<span style="color: #10b981;">✓ ${t('sub.statusSuccess')}</span>`;
        case 'error': return `<span style="color: #ef4444;" title="${escapeHtml(s.lastError || '')}">✗ ${t('sub.statusError')}</span>`;
        case 'pending': return `<span style="color: #f59e0b;">⟳ ${t('sub.statusPending')}</span>`;
        default: return `<span style="color: #94a3b8;">${t('sub.statusNever')}</span>`;
      }
    };
    return subs.map((s) => {
      const ruleCount = s.cachedPackage ? Object.keys(s.cachedPackage.siteRules || {}).length : 0;
      const kwCount = s.cachedPackage ? (
        (s.cachedPackage.includeKeywords?.length || 0) +
        (s.cachedPackage.excludePatterns?.length || 0) +
        (s.cachedPackage.agreementKeywords?.length || 0) +
        (s.cachedPackage.inputExcludeKeywords?.length || 0)
      ) : 0;
      return `
        <div class="Mieru-site-rule-item" data-sub-id="${escapeHtml(s.id)}">
          <div class="Mieru-site-rule-info">
            <div class="Mieru-site-rule-key">${escapeHtml(s.name)}</div>
            <div class="Mieru-site-rule-selector">${escapeHtml(s.url)}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px; display: flex; gap: 12px; flex-wrap: wrap;">
              <span>${statusText(s)}</span>
              <span>${t('sub.lastUpdated')}: ${formatTime(s.lastUpdated)}</span>
              ${s.cachedPackage ? `<span>${t('sub.rulesCount', ruleCount, kwCount)}</span>` : ''}
            </div>
          </div>
          <div class="Mieru-site-rule-actions">
            <div class="Mieru-switch Mieru-switch-sm ${s.enabled ? 'on' : ''}" data-sub-toggle="${escapeHtml(s.id)}">
              <div class="Mieru-switch-knob"></div>
            </div>
            <button class="Mieru-rule-edit btn-refresh-sub" data-sub-id="${escapeHtml(s.id)}">${t('sub.refresh')}</button>
            <button class="Mieru-rule-delete btn-delete-sub" data-sub-id="${escapeHtml(s.id)}">×</button>
          </div>
        </div>
      `;
    }).join('');
  }

  private refreshSubscriptionsList(): void {
    const list = this.container?.querySelector('#subscriptionsList') as HTMLElement;
    if (list) list.innerHTML = this.renderSubscriptions();
    this.bindSubscriptionEvents();
  }

  private bindSubscriptionEvents(): void {
    if (!this.container) return;

    this.container.querySelectorAll('.btn-refresh-sub').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = (e.currentTarget as HTMLElement).dataset.subId;
        if (!id) return;
        Dialog.show({ title: t('common.hint'), content: t('sub.refreshing'), icon: '' });
        const result = await refreshSubscription(id);
        const sub = getSubscriptions().find((s) => s.id === id);
        if (result.success) {
          Dialog.show({ title: t('common.success'), content: t('sub.refreshSuccess', sub?.name || id), icon: '' });
        } else {
          Dialog.show({ title: t('common.error'), content: t('sub.refreshFailed', sub?.name || id, result.error || ''), icon: '' });
        }
        this.refreshSubscriptionsList();
        this.onConfigChange(getConfig());
      });
    });

    this.container.querySelectorAll('.btn-delete-sub').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = (e.currentTarget as HTMLElement).dataset.subId;
        if (!id) return;
        const sub = getSubscriptions().find((s) => s.id === id);
        Dialog.confirm({
          title: t('sub.delete'),
          content: t('sub.deleteConfirm', sub?.name || id),
          onConfirm: () => {
            deleteSubscription(id, true);
            this.refreshSubscriptionsList();
            this.onConfigChange(getConfig());
          },
        });
      });
    });

    this.container.querySelectorAll('[data-sub-toggle]').forEach((sw) => {
      sw.addEventListener('click', () => {
        const id = (sw as HTMLElement).dataset.subToggle;
        if (!id) return;
        sw.classList.toggle('on');
        const enabled = sw.classList.contains('on');
        updateSubscriptionMeta(id, { enabled });
      });
    });
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
    this.container.querySelector('.Mieru-close')?.addEventListener('click', () => this.hide());
    this.overlay.addEventListener('click', () => this.hide());

    // 标签切换
    this.container.querySelectorAll('.Mieru-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = (tab as HTMLElement).dataset.tab;
        if (tabName) this.switchTab(tabName);
      });
    });

    // 开关事件 — 实时保存
    this.container.querySelectorAll('.Mieru-switch').forEach(sw => {
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

    // 订阅
    this.container.querySelector('#addSubBtn')?.addEventListener('click', () => this.handleAddSubscription());
    this.container.querySelector('#refreshAllSubsBtn')?.addEventListener('click', () => this.handleRefreshAllSubs());
    this.bindSubscriptionEvents();

    // 统计
    this.container.querySelector('#clearStatsBtn')?.addEventListener('click', () => this.clearStats());

    // 模型上传
    this.bindModelEvents();

    // 配置导入导出
    this.container.querySelector('#exportBtn')?.addEventListener('click', () => this.exportConfig());
    this.container.querySelector('#importBtn')?.addEventListener('click', () => this.importConfig());
    this.container.querySelector('#resetBtn')?.addEventListener('click', () => this.resetConfig());
    this.container.querySelector('#Mieru-diag-export')?.addEventListener('click', () => this.exportDiagnosticReport());
    this.container.querySelector('#Mieru-diag-clear')?.addEventListener('click', () => this.clearDiagnosticLogs());
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

  private async handleAddSubscription(): Promise<void> {
    const urlInput = this.container?.querySelector('#newSubUrl') as HTMLInputElement;
    const nameInput = this.container?.querySelector('#newSubName') as HTMLInputElement;
    const intervalSelect = this.container?.querySelector('#newSubInterval') as HTMLSelectElement;
    const url = urlInput?.value.trim();
    const name = nameInput?.value.trim();
    const interval = parseInt(intervalSelect?.value || '24', 10);

    if (!url) {
      Dialog.show({ title: t('common.hint'), content: t('sub.url'), icon: '' });
      return;
    }

    try {
      const sub = addSubscription({ url, name: name || undefined, updateInterval: interval });
      urlInput.value = '';
      nameInput.value = '';
      this.refreshSubscriptionsList();

      // 立即拉取一次
      Dialog.show({ title: t('common.hint'), content: t('sub.refreshing'), icon: '' });
      const result = await refreshSubscription(sub.id);
      if (result.success) {
        Dialog.show({ title: t('common.success'), content: t('sub.refreshSuccess', result.pkg?.name || sub.name), icon: '' });
      } else {
        Dialog.show({ title: t('common.error'), content: t('sub.refreshFailed', sub.name, result.error || ''), icon: '' });
      }
      this.refreshSubscriptionsList();
      this.onConfigChange(getConfig());
    } catch (e) {
      Dialog.show({ title: t('common.error'), content: (e as Error).message || String(e), icon: '' });
    }
  }

  private async handleRefreshAllSubs(): Promise<void> {
    const subs = getSubscriptions();
    if (subs.length === 0) {
      Dialog.show({ title: t('common.hint'), content: t('sub.empty'), icon: '' });
      return;
    }
    Dialog.show({ title: t('common.hint'), content: t('sub.refreshing'), icon: '' });
    let success = 0, fail = 0;
    for (const sub of subs) {
      if (!sub.enabled) continue;
      const result = await refreshSubscription(sub.id);
      if (result.success) success++;
      else fail++;
    }
    this.refreshSubscriptionsList();
    this.onConfigChange(getConfig());
    Dialog.show({
      title: t('common.success'),
      content: `${t('sub.refreshSuccess', '')}: ${success} / ${success + fail}`,
      icon: '',
    });
  }

  private exportSiteRules(): void {
    const rules = getSiteRules();
    const exportData = Object.entries(rules).map(([key, rule]) => ({
      hostname: rule.hostname || key,
      selector: rule.selector,
      inputSelector: rule.inputSelector,
      fullUrl: rule.fullUrl,
    }));
    this.downloadJson(exportData, 'Mieru-rules.json');
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
    this.downloadJson(config, 'Mieru-config.json');
  }

  private setDiagStatus(text: string, isError = false): void {
    const el = this.container?.querySelector('#Mieru-diag-status') as HTMLElement | null;
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#dc2626' : '';
  }

  private async exportDiagnosticReport(): Promise<void> {
    const config = getConfig();
    this.setDiagStatus(t('diag.exporting'));
    try {
      const report = await buildReport(
        { includeLogs: true, includeEnv: true, includeSettings: true, includeStats: true },
        {
          appName: 'Mieru-OCR Userscript',
          appVersion: (typeof GM_info !== 'undefined' && GM_info?.script?.version) || '0.0.0',
          target: 'userscript',
          getSettings: async () => config,
          getStats: async () => statsManager.getStats(),
        },
      );
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `Mieru-diag-${stamp}.json`;
      downloadReport(report, filename);
      const count = report.logs?.length ?? 0;
      this.setDiagStatus(t('diag.exported', filename, String(count)));
    } catch (e) {
      this.setDiagStatus(t('diag.exportFailed', (e as Error).message), true);
    }
  }

  private clearDiagnosticLogs(): void {
    Dialog.confirm({
      title: t('diag.clear'),
      content: t('diag.clear'),
      onConfirm: async () => {
        try {
          await clearLogs();
          this.setDiagStatus(t('diag.cleared', '6'));
        } catch (e) {
          this.setDiagStatus(t('diag.clearFailed', (e as Error).message), true);
        }
      },
    });
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
    this.container.querySelectorAll('.Mieru-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.tab === tabName);
    });
    this.container.querySelectorAll('.Mieru-panel').forEach(panel => {
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
        <div class="Mieru-keyword-group" data-chip-field="${field}">
          <div class="Mieru-keyword-header">
            <div class="Mieru-row-label">${t(keys.titleKey)}</div>
            <div class="Mieru-keyword-actions">
              <span class="Mieru-keyword-subtitle">${t('settings.keywords.builtinDeletable')}</span>
              <button class="Mieru-chip-reset" data-chip-field="${field}">${t('settings.keywords.resetDefault')}</button>
            </div>
          </div>
          <div class="Mieru-chip-list" id="Mieru-${field}-list"></div>
          <div class="Mieru-chip-input-row">
            <input type="text" class="Mieru-chip-input" id="Mieru-${field}-input" placeholder="${t(keys.placeholderKey)}">
          </div>
          <div class="Mieru-hint">${t(keys.hintKey)}</div>
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
    const list = this.container?.querySelector(`#Mieru-${field}-list`);
    if (!list) return;

    const builtinItems = this.getEnabledBuiltinKeywords(field, config).map((value) => ({ value, kind: 'builtin' as const }));
    const customItems = ((config as any)[field] || []).map((value: string) => ({ value, kind: 'custom' as const }));
    const items = [...builtinItems, ...customItems];

    if (items.length === 0) {
      list.innerHTML = `<div class="Mieru-chip-empty">${t('settings.keywords.empty')}</div>`;
      return;
    }

    list.innerHTML = items.map((item) => `
      <span class="Mieru-chip-item ${item.kind}">
        <span class="Mieru-chip-text">${escapeHtml(item.value)}</span>
        <span class="Mieru-chip-meta">${item.kind === 'builtin' ? t('settings.keywords.builtin') : t('settings.keywords.custom')}</span>
        <button type="button" class="Mieru-chip-remove" data-chip-field="${field}" data-chip-kind="${item.kind}" data-chip-value="${escapeHtml(item.value)}">×</button>
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
      const input = this.container?.querySelector(`#Mieru-${field}-input`) as HTMLInputElement | null;
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
    this.container.querySelector('#Mieru-keyword-chip-groups')?.addEventListener('click', (event) => {
      this.handleChipClick(event);
    });
  }

  private handleChipClick(event: Event): void {
    const target = event.target as HTMLElement;

    // Handle remove button
    const removeBtn = target.closest('.Mieru-chip-remove') as HTMLElement | null;
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
    const resetBtn = target.closest('.Mieru-chip-reset') as HTMLElement | null;
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