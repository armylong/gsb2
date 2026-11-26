import type { ClickEvent } from '../core/types';
import { Timeline, barQuarters } from '../core/timeline';
import type { MetronomePlayer, PlayerState } from '../audio/player';

export interface TableSelection {
  barFrom: number;
  barTo: number;
}

interface TableOptions {
  getTimeline: () => Timeline;
  getPlayer: () => MetronomePlayer;
  getSelection: () => TableSelection | null;
  onSelection: (sel: TableSelection | null) => void;
  onLoop: (sel: TableSelection | null) => void;
}

const KIND_CLASS: Record<ClickEvent['kind'], string> = {
  downbeat: 'cell-downbeat',
  beat: 'cell-beat',
  sub: 'cell-sub',
};

const KIND_MARK: Record<ClickEvent['kind'], string> = {
  downbeat: '●',
  beat: '○',
  sub: '·',
};

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export class BeatTable {
  readonly el: HTMLElement;
  private opts: TableOptions;
  private dragFrom: number | null = null;
  private events: ClickEvent[] = [];

  constructor(opts: TableOptions) {
    this.opts = opts;
    this.el = document.createElement('section');
    this.el.className = 'beat-table-wrap';
    this.el.innerHTML = `
      <table class="beat-table">
        <thead><tr>
          <th class="col-bar">小节</th>
          <th class="col-meter">拍号</th>
          <th class="col-beats">拍点 / 分拍 (秒)</th>
          <th class="col-time">小节起点</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    this.bindEvents();
  }

  private get tbody(): HTMLElement {
    return this.el.querySelector('tbody')!;
  }

  private bindEvents(): void {
    this.el.addEventListener('mousedown', (e) => {
      const cell = (e.target as HTMLElement).closest('[data-bar]') as HTMLElement | null;
      if (!cell) return;
      // 不阻止默认行为: 内部按钮仍可聚焦/点击, 框选靠 window 上的 move/up 完成
      this.dragFrom = Number(cell.dataset.bar);
      this.opts.onSelection({ barFrom: this.dragFrom, barTo: this.dragFrom });
    });
    window.addEventListener('mousemove', (e) => {
      if (this.dragFrom === null) return;
      const cell = (e.target as HTMLElement).closest('[data-bar]') as HTMLElement | null;
      if (!cell) return;
      const b = Number(cell.dataset.bar);
      this.opts.onSelection({
        barFrom: Math.min(this.dragFrom, b),
        barTo: Math.max(this.dragFrom, b),
      });
    });
    window.addEventListener('mouseup', () => {
      this.dragFrom = null;
    });
    // 双击拍点 -> 跳播; 双击小节空白 -> 跳到小节头
    this.el.addEventListener('dblclick', (e) => {
      const beat = (e.target as HTMLElement).closest('[data-q]') as HTMLElement | null;
      if (beat) {
        this.opts.getPlayer().seek(Number(beat.dataset.q));
        return;
      }
      const bar = (e.target as HTMLElement).closest('[data-bar]') as HTMLElement | null;
      if (bar) this.opts.getPlayer().seek(this.opts.getTimeline().bars[Number(bar.dataset.bar)].qStart);
    });
  }

  render(): void {
    const tl = this.opts.getTimeline();
    this.events = tl.buildEvents();
    const sel = this.opts.getSelection();
    const rows: string[] = [];
    let lastSegIndex = -1;
    for (const bar of tl.bars) {
      const barEvents = this.events.filter((e) => e.barIndex === bar.index);
      const cells = barEvents
        .map((ev) => {
          return `<button type="button" class="beat-cell ${KIND_CLASS[ev.kind]}"
              data-q="${ev.q}" title="q=${ev.q}&#10;${ev.t.toFixed(4)}s&#10;双击跳播">
            <span class="mark">${KIND_MARK[ev.kind]}</span>
            <span class="beat-label">${ev.beatInBar}</span>
            <span class="beat-time">${ev.t.toFixed(3)}</span>
          </button>`;
        })
        .join('');
      const meter = `${bar.meter.numerator}/${bar.meter.denominator}`;
      const segFirst = bar.segmentIndex !== lastSegIndex;
      lastSegIndex = bar.segmentIndex;
      const segLabel = segFirst ? `<div class="seg-tag">${tl.spans[bar.segmentIndex].segment.label}</div>` : '';
      const inSel = sel && bar.index >= sel.barFrom && bar.index <= sel.barTo;
      rows.push(`<tr data-bar="${bar.index}" class="${inSel ? 'row-selected' : ''} ${bar.isPickup ? 'row-pickup' : ''}">
        <td class="col-bar">
          ${bar.isPickup ? '<span class="pickup-tag">弱起</span>' : bar.barNumber}
        </td>
        <td class="col-meter">${segLabel}<div>${meter}</div></td>
        <td class="col-beats"><div class="beat-row">${cells}</div></td>
        <td class="col-time">${fmt(tl.qToTime(bar.qStart))}</td>
      </tr>`);
    }
    this.tbody.innerHTML = rows.join('');
  }

  /** 播放头高亮: 只更新 class, 不重建 DOM */
  updatePlayhead(state: PlayerState): void {
    const tl = this.opts.getTimeline();
    this.el.querySelectorAll('.beat-cell.is-playing').forEach((n) => n.classList.remove('is-playing'));
    this.el.querySelectorAll('tr.is-current').forEach((n) => n.classList.remove('is-current'));
    const bar = tl.barAt(Math.min(state.q, Math.max(0, tl.totalQ - 1e-9)));
    const row = this.el.querySelector(`tr[data-bar="${bar.index}"]`);
    row?.classList.add('is-current');
    // 找当前时间之前最近的拍点
    let nearest: ClickEvent | undefined;
    for (const ev of this.events) {
      if (ev.q <= state.q + 1e-9) nearest = ev;
      else break;
    }
    if (nearest) {
      const cell = this.el.querySelector(`.beat-cell[data-q="${nearest.q}"]`);
      cell?.classList.add('is-playing');
    }
  }

  scrollToBar(barIndex: number): void {
    const row = this.el.querySelector(`tr[data-bar="${barIndex}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

export function meterCapacity(meter: { numerator: number; denominator: number }): number {
  return barQuarters(meter);
}
