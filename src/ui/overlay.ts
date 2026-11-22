/**
 * DOM 标签层 + SVG 引线层。
 *
 * 三维场景只负责渲染实体和锚点位置；标签本身是 HTML，便于选择、远距离
 * 可读性更好，也能让避让算法直接使用真实的像素尺寸。
 */

import type { AnchorRuntime } from '../scene/anchors';
import type { LabelPlacement } from '../core/layout';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface OverlayCallbacks {
  onSelectPart(partId: string, anchorId: string): void;
  onToggleLock(anchorId: string, locked: boolean): void;
}

interface LabelElements {
  root: HTMLDivElement;
  title: HTMLSpanElement;
  detail: HTMLSpanElement;
  code: HTMLSpanElement;
  priority: HTMLSpanElement;
  lockButton: HTMLButtonElement;
  width: number;
  height: number;
  lastX: number;
  lastY: number;
}

interface LeaderElements {
  line: SVGLineElement;
  dot: SVGCircleElement;
  halo: SVGCircleElement;
}

export class LabelOverlay {
  private readonly labels = new Map<string, LabelElements>();
  private readonly leaders = new Map<string, LeaderElements>();
  private selectedPartId: string | null = null;
  private selectedAnchorId: string | null = null;
  /** 用户实际锁定状态；不要用定义里的默认值覆盖它。 */
  private readonly lockedIds = new Set<string>();
  private hostWidth = 1;
  private hostHeight = 1;

  constructor(
    private readonly host: HTMLElement,
    private readonly labelsRoot: HTMLElement,
    private readonly svg: SVGSVGElement,
    private readonly callbacks: OverlayCallbacks,
  ) {}

  createLabels(
    anchors: readonly AnchorRuntime[],
    getPartName: (partId: string) => string,
  ): void {
    for (const anchor of anchors) {
      const def = anchor.def;
      const root = document.createElement('div');
      root.className = 'label';
      root.dataset.anchorId = def.id;
      root.dataset.partId = def.partId;
      root.setAttribute('role', 'button');
      root.tabIndex = 0;
      root.title = `${def.code} ${def.title}\n${def.detail}\n零件：${getPartName(def.partId)}`;

      const code = document.createElement('span');
      code.className = 'label-code';
      code.textContent = def.code;

      const body = document.createElement('span');
      body.className = 'label-body';

      const titleRow = document.createElement('span');
      titleRow.className = 'label-title-row';

      const title = document.createElement('span');
      title.className = 'label-title';
      title.textContent = def.title;

      const priority = document.createElement('span');
      priority.className = 'label-priority';

      titleRow.append(title, priority);

      const detail = document.createElement('span');
      detail.className = 'label-detail';
      detail.textContent = def.detail;

      body.append(titleRow, detail);

      const lockButton = document.createElement('button');
      lockButton.type = 'button';
      lockButton.className = 'label-lock';
      lockButton.textContent = '🔒';
      lockButton.title = '锁定此标注';
      lockButton.addEventListener('pointerdown', (event) => event.stopPropagation());
      lockButton.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.onToggleLock(def.id, !this.lockedIds.has(def.id));
      });

      root.append(code, body, lockButton);

      const select = () => this.callbacks.onSelectPart(def.partId, def.id);
      root.addEventListener('click', (event) => {
        event.stopPropagation();
        select();
      });
      root.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select();
        }
      });

      this.labelsRoot.append(root);

      const leaderGroup = document.createElementNS(SVG_NS, 'g');
      const halo = document.createElementNS(SVG_NS, 'circle');
      halo.setAttribute('r', '7');
      halo.setAttribute('class', 'leader-halo');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('r', '3.4');
      dot.setAttribute('class', 'leader-dot');
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'leader-line');
      leaderGroup.append(line, halo, dot);
      this.svg.append(leaderGroup);

      this.labels.set(def.id, {
        root,
        title,
        detail,
        code,
        priority,
        lockButton,
        width: 0,
        height: 0,
        lastX: Number.NaN,
        lastY: Number.NaN,
      });
      this.leaders.set(def.id, { line, dot, halo });
    }
    this.measure(this.hostWidth, this.hostHeight);
  }

  /** 读取标签的实际像素尺寸；宽度受窗口限制。 */
  measure(hostWidth: number, hostHeight: number): void {
    this.hostWidth = hostWidth;
    this.hostHeight = hostHeight;
    this.svg.setAttribute('width', String(hostWidth));
    this.svg.setAttribute('height', String(hostHeight));
    this.svg.setAttribute('viewBox', `0 0 ${hostWidth} ${hostHeight}`);
    this.labelsRoot.style.width = `${hostWidth}px`;
    this.labelsRoot.style.height = `${hostHeight}px`;

    for (const label of this.labels.values()) {
      label.root.style.visibility = 'hidden';
      label.width = Math.ceil(label.root.offsetWidth);
      label.height = Math.ceil(label.root.offsetHeight);
    }
  }

  elementFor(anchorId: string): HTMLElement | null {
    return this.labels.get(anchorId)?.root ?? null;
  }

  getSize(anchorId: string): { width: number; height: number } | null {
    const label = this.labels.get(anchorId);
    if (!label || label.width <= 0) return null;
    return { width: label.width, height: label.height };
  }

  setPriority(anchorId: string, priority: number): void {
    const label = this.labels.get(anchorId);
    if (label) label.priority.textContent = `P${priority}`;
  }

  setLocked(anchorId: string, locked: boolean): void {
    if (locked) this.lockedIds.add(anchorId);
    else this.lockedIds.delete(anchorId);
    const label = this.labels.get(anchorId);
    if (!label) return;
    label.root.classList.toggle('is-locked', locked);
    label.lockButton.title = locked ? '取消锁定' : '锁定此标注';
  }

  isLocked(anchorId: string): boolean {
    return this.lockedIds.has(anchorId);
  }

  setSelected(partId: string | null, anchorId: string | null): void {
    this.selectedPartId = partId;
    this.selectedAnchorId = anchorId;
    for (const [id, label] of this.labels) {
      label.root.classList.toggle('is-selected-anchor', id === anchorId);
    }
  }

  /**
   * 每帧刷新标签位置与引线。
   * @param placed 已排布的标签
   * @param displayed 需要显示锚点圆点的锚点（含被收起的）
   * @param stowed 被收起的锚点 id
   */
  update(
    runtimes: readonly AnchorRuntime[],
    placed: ReadonlyMap<string, LabelPlacement>,
    stowed: ReadonlySet<string>,
    showOccluded: boolean,
  ): void {
    for (const runtime of runtimes) {
      const id = runtime.def.id;
      const label = this.labels.get(id);
      const leader = this.leaders.get(id);
      if (!label || !leader) continue;

      const placement = placed.get(id);
      const isStowed = stowed.has(id);
      const occluded = runtime.state === 'occluded';
      const emphasize = runtime.state === 'visible' || (occluded && showOccluded);
      const shouldShow = Boolean(placement) && emphasize;

      if (!shouldShow) {
        if (label.root.style.visibility !== 'hidden') {
          label.root.style.visibility = 'hidden';
        }
        label.root.classList.remove('is-occluded', 'is-stowed');
        leader.line.style.display = 'none';

        // 被收起、但在镜头前方的锚点仍留一个小圆点，提示「这里还有一条说明」。
        const dotOnly = isStowed && emphasize && runtime.inFront && runtime.partVisible;
        leader.dot.style.display = dotOnly ? '' : 'none';
        leader.halo.style.display = dotOnly ? '' : 'none';
        if (dotOnly) {
          const color = this.lockedIds.has(id)
            ? 'var(--leader-locked)'
            : occluded
              ? 'var(--leader-occluded)'
              : 'var(--leader-stowed)';
          leader.halo.setAttribute('cx', String(runtime.screen.x));
          leader.halo.setAttribute('cy', String(runtime.screen.y));
          leader.dot.setAttribute('cx', String(runtime.screen.x));
          leader.dot.setAttribute('cy', String(runtime.screen.y));
          leader.dot.setAttribute('fill', color);
          leader.dot.classList.toggle('is-occluded', occluded);
          leader.dot.classList.toggle('is-stowed', true);
          leader.halo.classList.toggle('is-occluded', occluded);
        }
        continue;
      }

      if (placement) {
        const x = Math.round(placement.rect.x);
        const y = Math.round(placement.rect.y);
        if (x !== label.lastX || y !== label.lastY) {
          label.root.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          label.lastX = x;
          label.lastY = y;
        }
        label.root.style.visibility = 'visible';
      }

      const isSelectedPart = this.selectedPartId !== null && runtime.def.partId === this.selectedPartId;
      const locked = this.lockedIds.has(id);
      label.root.classList.toggle('is-occluded', occluded);
      label.root.classList.toggle('is-stowed', false);
      label.root.classList.toggle('is-selected-part', isSelectedPart);
      label.root.classList.toggle(
        'is-selected-anchor',
        id === this.selectedAnchorId,
      );

      const dotVisible = runtime.inFront && runtime.partVisible;
      const lineColor = locked
        ? 'var(--leader-locked)'
        : occluded
          ? 'var(--leader-occluded)'
          : 'var(--leader-visible)';

      if (placement && dotVisible) {
        leader.line.style.display = '';
        leader.line.setAttribute('x1', String(runtime.screen.x));
        leader.line.setAttribute('y1', String(runtime.screen.y));
        leader.line.setAttribute('x2', String(placement.attach.x));
        leader.line.setAttribute('y2', String(placement.attach.y));
        leader.line.setAttribute('stroke', lineColor);
        leader.line.classList.toggle('is-occluded', occluded);
        leader.line.classList.toggle('is-locked', locked);
      } else {
        leader.line.style.display = 'none';
      }

      leader.halo.style.display = dotVisible ? '' : 'none';
      leader.dot.style.display = dotVisible ? '' : 'none';
      leader.halo.setAttribute('cx', String(runtime.screen.x));
      leader.halo.setAttribute('cy', String(runtime.screen.y));
      leader.dot.setAttribute('cx', String(runtime.screen.x));
      leader.dot.setAttribute('cy', String(runtime.screen.y));
      leader.dot.setAttribute('fill', lineColor);
      leader.dot.classList.toggle('is-occluded', occluded);
      leader.halo.classList.toggle('is-occluded', occluded);
      leader.dot.classList.toggle('is-stowed', isStowed);
    }
  }

  setEmptyMessage(message: string | null): void {
    const empty = this.host.parentElement?.querySelector<HTMLElement>('#stage-empty');
    if (!empty) return;
    empty.textContent = message ?? '';
    empty.hidden = !message;
  }
}
