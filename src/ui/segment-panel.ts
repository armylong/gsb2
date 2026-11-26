import type { Segment, TempoMode, TimbreName } from '../core/types';
import { barQuarters } from '../core/timeline';
import { store } from './state';

function numField(label: string, value: number, attrs: string): string {
  return `<label class="field">
    <span>${label}</span>
    <input type="number" ${attrs} value="${value}" />
  </label>`;
}

function segmentCard(s: Segment, index: number, total: number): string {
  const capacity = barQuarters(s.meter);
  const tempoBody =
    s.mode === 'ramp'
      ? `<div class="field-row">
           ${numField('起始 BPM', s.bpmStart, `data-k="bpmStart" min="20" max="400" step="1"`)}
           ${numField('结束 BPM', s.bpmEnd, `data-k="bpmEnd" min="20" max="400" step="1"`)}
         </div>
         <div class="ramp-hint">线性渐变: BPM 随四分音符坐标线性变化</div>`
      : numField('BPM', s.bpmStart, `data-k="bpmStart" min="20" max="400" step="0.1"`);

  return `<article class="seg-card" data-seg="${s.id}">
    <header class="seg-card-head">
      <span class="seg-index">#${index + 1}</span>
      <input class="seg-name" data-k="label" value="${s.label}" />
      <span class="seg-buttons">
        <button type="button" data-act="up" ${index === 0 ? 'disabled' : ''} title="上移">↑</button>
        <button type="button" data-act="down" ${index === total - 1 ? 'disabled' : ''} title="下移">↓</button>
        <button type="button" data-act="del" ${total <= 1 ? 'disabled' : ''} title="删除">✕</button>
      </span>
    </header>
    <div class="field-row">
      <label class="field"><span>拍号分子</span>
        <input type="number" data-k="num" min="1" max="32" step="1" value="${s.meter.numerator}" />
      </label>
      <label class="field"><span>拍号分母</span>
        <select data-k="den">
          ${[2, 4, 8, 16].map((d) => `<option value="${d}" ${d === s.meter.denominator ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </label>
      ${numField('小节数', s.bars, `data-k="bars" min="1" max="200" step="1"`)}
    </div>
    <div class="field-row">
      ${numField('弱起拍数', s.pickupBeats, `data-k="pickupBeats" min="0" max="${capacity}" step="1"`)}
      <label class="field"><span>每拍分拍</span>
        <select data-k="subdivision">
          ${[1, 2, 3, 4, 6, 8].map((n) => `<option value="${n}" ${n === s.subdivision ? 'selected' : ''}>${n}${n === 1 ? ' (不分)' : ''}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>速度模式</span>
        <select data-k="mode">
          <option value="constant" ${s.mode === 'constant' ? 'selected' : ''}>恒定</option>
          <option value="ramp" ${s.mode === 'ramp' ? 'selected' : ''}>渐变</option>
        </select>
      </label>
    </div>
    <div class="pickup-hint">该拍号满小节 = ${capacity} 个四分音符${s.pickupBeats > 0 ? `, 当前弱起 ${s.pickupBeats} 拍` : ''}</div>
    ${tempoBody}
  </article>`;
}

export class SegmentPanel {
  readonly el: HTMLElement;

  constructor() {
    this.el = document.createElement('section');
    this.el.className = 'panel segment-panel';
    this.el.innerHTML = `
      <h2>段落 (从小节位置标拍号 / 速度 / 重拍)</h2>
      <div class="seg-list"></div>
      <button type="button" class="btn" data-act="add">＋ 在末尾添加段落</button>`;
    this.bind();
  }

  private get list(): HTMLElement {
    return this.el.querySelector('.seg-list')!;
  }

  private bind(): void {
    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
      if (!btn) return;
      const card = btn.closest('[data-seg]') as HTMLElement | null;
      const id = card?.dataset.seg;
      if (btn.dataset.act === 'add') {
        store.addSegment();
        return;
      }
      if (!id) return;
      if (btn.dataset.act === 'del') store.removeSegment(id);
      if (btn.dataset.act === 'up') store.moveSegment(id, -1);
      if (btn.dataset.act === 'down') store.moveSegment(id, 1);
    });

    this.el.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement | HTMLSelectElement;
      const key = input.dataset.k;
      const card = input.closest('[data-seg]') as HTMLElement | null;
      if (!key || !card) return;
      const id = card.dataset.seg!;
      const raw = input.value;
      store.updateSegment(id, (s) => {
        switch (key) {
          case 'label':
            s.label = raw;
            break;
          case 'num':
            s.meter.numerator = clampInt(raw, 1, 32);
            break;
          case 'den':
            s.meter.denominator = Number(raw);
            break;
          case 'bars':
            s.bars = clampInt(raw, 1, 200);
            break;
          case 'pickupBeats':
            s.pickupBeats = clampInt(raw, 0, barQuarters(s.meter));
            break;
          case 'subdivision':
            s.subdivision = Number(raw);
            break;
          case 'mode':
            s.mode = raw as TempoMode;
            if (s.mode === 'constant') s.bpmEnd = s.bpmStart;
            break;
          case 'bpmStart':
            s.bpmStart = clampNum(raw, 20, 400);
            if (s.mode === 'constant') s.bpmEnd = s.bpmStart;
            break;
          case 'bpmEnd':
            s.bpmEnd = clampNum(raw, 20, 400);
            break;
        }
      });
      // fullRender 会重建面板 DOM, 拦截冒泡避免上层委托读到失效节点
      e.stopPropagation();
    });
  }

  render(): void {
    const segs = store.project.segments;
    this.list.innerHTML = segs.map((s, i) => segmentCard(s, i, segs.length)).join('');
  }
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampNum(raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export const TIMBRE_OPTIONS: { value: TimbreName; label: string }[] = [
  { value: 'sine', label: '正弦 (经典节拍器)' },
  { value: 'triangle', label: '三角波 (明亮)' },
  { value: 'noise', label: '噪声 (木鱼/敲击)' },
];
