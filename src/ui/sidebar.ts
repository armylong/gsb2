/**
 * 侧栏状态与交互：零件显隐、优先级、锁定、收起清单、视角切换。
 * 只负责 DOM，业务规则都在 main.ts 里统一执行。
 */

import type { AnchorDefinition, PartHandle } from '../scene/assembly';
import type { ViewPresetName } from '../scene/cameraDirector';
import type { AnchorState } from '../core/visibility';
import type { StowedLabel } from '../core/layout';

export interface SidebarState {
  anchors: readonly AnchorDefinition[];
  parts: readonly PartHandle[];
  priorityOf: (anchorId: string) => number;
  lockedOf: (anchorId: string) => boolean;
  stateOf: (anchorId: string) => AnchorState;
  selectedPartId?: string | null;
}

export interface SidebarCallbacks {
  onTogglePart(partId: string, visible: boolean): void;
  onSetPriority(anchorId: string, priority: number): void;
  onToggleLock(anchorId: string, locked: boolean): void;
  onFocusAnchor(anchorId: string): void;
  onViewChange(view: ViewPresetName): void;
  onArmAngle(degrees: number): void;
  onAutoSwing(enabled: boolean): void;
  onNarrowMode(enabled: boolean): void;
  onShowOccluded(enabled: boolean): void;
}

const STATE_LABEL: Record<AnchorState, string> = {
  visible: '可见',
  occluded: '被挡',
  behind: '背面',
};

const PRIORITY_LABEL: Record<number, string> = {
  1: '参考',
  2: '一般',
  3: '重要',
  4: '关键',
  5: '关键+',
};

export class Sidebar {
  private readonly partList: HTMLElement;
  private readonly anchorList: HTMLElement;
  private readonly hiddenList: HTMLElement;
  private readonly partCount: HTMLElement;
  private readonly anchorCount: HTMLElement;
  private readonly hiddenCount: HTMLElement;
  private readonly hudStats: HTMLElement;
  private readonly hudSelected: HTMLElement;
  private readonly armRange: HTMLInputElement;
  private readonly armValue: HTMLOutputElement;
  private readonly autoSwing: HTMLInputElement;
  private readonly narrowMode: HTMLInputElement;
  private readonly showOccluded: HTMLInputElement;

  constructor(
    private readonly callbacks: SidebarCallbacks,
  ) {
    this.partList = must('part-list');
    this.anchorList = must('anchor-list');
    this.hiddenList = must('hidden-list');
    this.partCount = must('part-count');
    this.anchorCount = must('anchor-count');
    this.hiddenCount = must('hidden-count');
    this.hudStats = must('hud-stats');
    this.hudSelected = must('hud-selected');
    this.armRange = mustInput('arm-range');
    this.armValue = mustOutput('arm-value');
    this.autoSwing = mustInput('auto-swing');
    this.narrowMode = mustInput('narrow-mode');
    this.showOccluded = mustInput('show-occluded');

    document.querySelectorAll<HTMLButtonElement>('#view-buttons button').forEach((button) => {
      button.addEventListener('click', () => {
        document
          .querySelectorAll('#view-buttons button')
          .forEach((b) => b.classList.toggle('active', b === button));
        this.callbacks.onViewChange(button.dataset.view as ViewPresetName);
      });
    });

    this.armRange.addEventListener('input', () => {
      const value = Number(this.armRange.value);
      this.armValue.value = `${value}°`;
      this.callbacks.onArmAngle(value);
    });
    this.autoSwing.addEventListener('change', () => {
      this.callbacks.onAutoSwing(this.autoSwing.checked);
    });
    this.narrowMode.addEventListener('change', () => {
      this.callbacks.onNarrowMode(this.narrowMode.checked);
    });
    this.showOccluded.addEventListener('change', () => {
      this.callbacks.onShowOccluded(this.showOccluded.checked);
    });
  }

  render(state: SidebarState): void {
    this.partCount.textContent = String(state.parts.length);
    this.anchorCount.textContent = String(state.anchors.length);

    this.renderParts(state);
    this.renderAnchors(state);
  }

  private renderParts(state: SidebarState): void {
    this.partList.replaceChildren();
    for (const part of state.parts) {
      const row = document.createElement('label');
      row.className = 'list-row part-row';
      row.classList.toggle('is-hidden-part', !part.visible);

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = part.visible;
      check.addEventListener('change', () => {
        this.callbacks.onTogglePart(part.id, check.checked);
      });

      const swatch = document.createElement('i');
      swatch.className = 'part-swatch';
      const material = part.materials[0];
      if (material) swatch.style.background = `#${material.color.getHexString()}`;

      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = part.name;

      const count = document.createElement('span');
      count.className = 'row-meta';
      count.textContent = `${state.anchors.filter((a) => a.partId === part.id).length}`;

      row.dataset.partId = part.id;
      row.classList.toggle('is-selected-part', state.selectedPartId === part.id);

      row.append(check, swatch, name, count);
      this.partList.append(row);
    }
  }

  private renderAnchors(state: SidebarState): void {
    this.anchorList.replaceChildren();
    for (const anchor of state.anchors) {
      const priority = state.priorityOf(anchor.id);
      const locked = state.lockedOf(anchor.id);
      const anchorState = state.stateOf(anchor.id);

      const row = document.createElement('div');
      row.className = 'list-row anchor-row';
      row.classList.toggle('is-locked', locked);
      row.classList.toggle('is-occluded', anchorState === 'occluded');
      row.classList.toggle('is-behind', anchorState === 'behind');
      row.dataset.anchorId = anchor.id;

      const code = document.createElement('span');
      code.className = 'anchor-code';
      code.textContent = anchor.code;

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'anchor-name';
      name.textContent = anchor.title;
      name.title = `${anchor.title} · ${STATE_LABEL[anchorState]}`;
      name.addEventListener('click', () => this.callbacks.onFocusAnchor(anchor.id));

      const stateDot = document.createElement('span');
      stateDot.className = `state-dot state-${anchorState}`;
      stateDot.title = STATE_LABEL[anchorState];

      const lock = document.createElement('button');
      lock.type = 'button';
      lock.className = 'icon-btn lock-btn';
      lock.textContent = locked ? '🔒' : '🔓';
      lock.title = locked ? '取消锁定' : '锁定（空间不足时优先保留）';
      lock.addEventListener('click', () => {
        this.callbacks.onToggleLock(anchor.id, !locked);
      });

      const priorityGroup = document.createElement('span');
      priorityGroup.className = 'priority-group';
      for (let p = 1; p <= 5; p += 1) {
        const pip = document.createElement('button');
        pip.type = 'button';
        pip.className = 'priority-pip';
        pip.classList.toggle('active', p <= priority);
        pip.title = `优先级 ${p} · ${PRIORITY_LABEL[p]}`;
        pip.setAttribute('aria-label', `优先级 ${p}`);
        pip.addEventListener('click', () => this.callbacks.onSetPriority(anchor.id, p));
        priorityGroup.append(pip);
      }

      row.append(code, name, stateDot, lock, priorityGroup);
      this.anchorList.append(row);
    }
  }

  setHidden(stowed: readonly StowedLabel[], names: (id: string) => string): void {
    this.hiddenCount.textContent = String(stowed.length);
    this.hiddenList.replaceChildren();
    if (stowed.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '暂无收起的标注';
      this.hiddenList.append(empty);
      return;
    }
    for (const item of stowed) {
      const row = document.createElement('div');
      row.className = 'list-row hidden-row';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = names(item.id);
      const reason = document.createElement('span');
      reason.className = 'row-meta';
      reason.textContent = '空间不足';
      row.append(name, reason);
      this.hiddenList.append(row);
    }
  }

  setStats(text: string): void {
    this.hudStats.textContent = text;
  }

  setSelectedPart(text: string, state: AnchorState | null = null): void {
    this.hudSelected.textContent = text;
    this.hudSelected.dataset.state = state ?? '';
  }

  /** 遮挡状态变化时只更新状态角标，避免整张列表每帧重建。 */
  setSelectedState(state: AnchorState | null): void {
    this.hudSelected.dataset.state = state ?? '';
  }

  /** 每帧同步列表里的可见/被挡小圆点（不重建 DOM）。 */
  updateAnchorStates(stateOf: (anchorId: string) => AnchorState): void {
    this.anchorList.querySelectorAll<HTMLElement>('.anchor-row').forEach((row) => {
      const id = row.dataset.anchorId;
      if (!id) return;
      const state = stateOf(id);
      row.classList.toggle('is-occluded', state === 'occluded');
      row.classList.toggle('is-behind', state === 'behind');
      const dot = row.querySelector<HTMLElement>('.state-dot');
      if (dot) dot.className = `state-dot state-${state}`;
    });
  }

  setArmValue(degrees: number): void {
    this.armRange.value = String(Math.round(degrees));
    this.armValue.value = `${Math.round(degrees)}°`;
  }

  setViewActive(view: ViewPresetName): void {
    document.querySelectorAll<HTMLButtonElement>('#view-buttons button').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === view);
    });
  }

  setAutoSwing(enabled: boolean): void {
    this.autoSwing.checked = enabled;
  }

  setNarrowMode(enabled: boolean): void {
    this.narrowMode.checked = enabled;
  }

  setShowOccluded(enabled: boolean): void {
    this.showOccluded.checked = enabled;
  }
}

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少 #${id}`);
  return element;
}

function mustInput(id: string): HTMLInputElement {
  const element = must(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} 不是 input`);
  return element;
}

function mustOutput(id: string): HTMLOutputElement {
  const element = must(id);
  if (!(element instanceof HTMLOutputElement)) throw new Error(`#${id} 不是 output`);
  return element;
}

export { STATE_LABEL, PRIORITY_LABEL };
