/**
 * HUD —— 精简统计面板与按钮状态绑定
 */

import { MODE_LABELS, MODE_REPLACE, MODE_ADD, MODE_REMOVE } from '../core/SelectionStore.js';

const MODIFIER_HINT = {
  [MODE_REPLACE]: 'Shift 追加 / Ctrl·Alt 剔除',
  [MODE_ADD]: '追加模式',
  [MODE_REMOVE]: '剔除模式',
};

export class HUD {
  constructor() {
    this.el = {
      total: document.getElementById('stat-total'),
      visible: document.getElementById('stat-visible'),
      hidden: document.getElementById('stat-hidden'),
      selected: document.getElementById('stat-selected'),
      mode: document.getElementById('stat-mode'),
      lastAction: document.getElementById('last-action'),
      btnMove: document.getElementById('btn-move'),
      btnHide: document.getElementById('btn-hide'),
      btnRestore: document.getElementById('btn-undo-restore'),
      btnUndo: document.getElementById('btn-undo'),
      btnClear: document.getElementById('btn-clear'),
      btnResetView: document.getElementById('btn-reset-view'),
      modeButtons: {
        [MODE_REPLACE]: document.getElementById('mode-replace'),
        [MODE_ADD]: document.getElementById('mode-add'),
        [MODE_REMOVE]: document.getElementById('mode-remove'),
      },
    };
  }

  /** 刷新统计与按钮可用性 */
  update(model, selection, effectiveMode) {
    this.el.total.textContent = String(model.count);
    this.el.visible.textContent = String(model.visibleCount);
    this.el.hidden.textContent = String(model.hiddenCount);
    this.el.selected.textContent = String(selection.size);
    this.el.mode.textContent = `${MODE_LABELS[effectiveMode]}（${MODIFIER_HINT[effectiveMode]}）`;

    const hasSelection = selection.size > 0;
    this.el.btnMove.disabled = !hasSelection;
    this.el.btnHide.disabled = !hasSelection;
    this.el.btnClear.disabled = !hasSelection;
    this.el.btnUndo.disabled = !model.canUndoHide();
    this.el.btnRestore.disabled = model.hiddenCount === 0;

    for (const [mode, btn] of Object.entries(this.el.modeButtons)) {
      btn.classList.toggle('active', mode === selection.stickyMode);
      btn.setAttribute('aria-pressed', String(mode === selection.stickyMode));
    }
  }

  setMessage(text) {
    this.el.lastAction.textContent = text;
  }
}
