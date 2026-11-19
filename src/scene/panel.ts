import { END_REASON_LABELS } from '../sim/simulator';
import type { EndReason, ShotResult, TrajectorySegment } from '../sim/types';

const TYPE_LABELS: Record<TrajectorySegment['type'], string> = {
  flight: '空气飞行段',
  inside: '材料内部段',
  reflection: '反射节点(零长度)',
};

const TYPE_COLORS: Record<TrajectorySegment['type'], string> = {
  flight: '#66e08a',
  inside: '#ff7b54',
  reflection: '#ffd23f',
};

function fmt(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '∞';
  const s = v.toFixed(digits);
  return s.replace(/\.?0+$/, '') || '0';
}

function vec(v: { x: number; y: number; z: number }): string {
  return `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;
}

export class SidePanel {
  private readonly listEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly endEl: HTMLElement;
  private result: ShotResult | null = null;
  private selectedIndex: number | null = null;
  private onSelect: ((index: number | null) => void) | null = null;

  constructor() {
    this.listEl = document.getElementById('segment-list')!;
    this.detailEl = document.getElementById('segment-detail')!;
    this.endEl = document.getElementById('end-reason')!;
  }

  setSelectHandler(handler: (index: number | null) => void): void {
    this.onSelect = handler;
  }

  showResult(result: ShotResult): void {
    this.result = result;
    this.selectedIndex = null;
    this.renderList();
    this.renderDetail();
    this.renderEnd();
  }

  clear(): void {
    this.result = null;
    this.selectedIndex = null;
    this.listEl.innerHTML = '<p class="hint">尚未发射。调整参数后点击左侧 GUI 的「发射」。</p>';
    this.detailEl.innerHTML =
      '<p class="hint">点击场景中的弹道线段或上方列表查看起终点、长度与能量前后值。</p>';
    this.endEl.textContent = '—';
    this.endEl.className = 'end-reason hint';
  }

  select(index: number | null): void {
    if (!this.result) return;
    this.selectedIndex = index;
    this.renderList();
    this.renderDetail();
  }

  private renderList(): void {
    if (!this.result) return;
    this.listEl.innerHTML = '';
    for (const seg of this.result.segments) {
      const btn = document.createElement('button');
      btn.className = 'segment-item' + (seg.index === this.selectedIndex ? ' selected' : '');
      const contact = seg.endContact;
      btn.innerHTML =
        `<span class="seg-title" style="color:${TYPE_COLORS[seg.type]}">` +
        `#${seg.index} ${TYPE_LABELS[seg.type]}</span><br>` +
        `<span class="seg-sub">长度 ${fmt(seg.length)} · 能量 ${fmt(seg.energyBefore)} → ` +
        `${fmt(seg.energyAfter)}${contact ? ` · ${contact.kind}` : ''}</span>`;
      btn.addEventListener('click', () => {
        this.selectedIndex = seg.index;
        this.renderList();
        this.renderDetail();
        this.onSelect?.(seg.index);
      });
      this.listEl.appendChild(btn);
    }
  }

  private renderDetail(): void {
    if (!this.result) return;
    const seg = this.selectedIndex === null
      ? null
      : this.result.segments.find((s) => s.index === this.selectedIndex) ?? null;
    if (!seg) {
      this.detailEl.innerHTML =
        '<p class="hint">共 ' + this.result.segments.length + ' 段, 点击列表或场景线段查看。</p>';
      return;
    }
    const c = seg.endContact;
    const rows: [string, string][] = [
      ['类型', TYPE_LABELS[seg.type]],
      ['起点', vec(seg.start)],
      ['终点', vec(seg.end)],
      ['长度', fmt(seg.length)],
      ['能量(前)', fmt(seg.energyBefore)],
      ['能量(后)', fmt(seg.energyAfter)],
      [
        '能量变化',
        fmt(seg.energyBefore - seg.energyAfter),
      ],
      [
        '所属材料',
        seg.materialObjectId
          ? this.objectName(seg.materialObjectId)
          : '空气',
      ],
      ['终点交互', c ? `${c.kind} @ ${c.objectName}` : '无'],
      [
        '接触面法线',
        c?.normal ? vec(c.normal) : '无',
      ],
      [
        '入射角',
        c?.incidenceDeg !== null && c?.incidenceDeg !== undefined
          ? `${fmt(c.incidenceDeg, 3)}°`
          : '无',
      ],
    ];
    this.detailEl.innerHTML =
      '<table><tbody>' +
      rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') +
      '</tbody></table>';
  }

  private objectName(id: string): string {
    const seg = this.result?.segments.find((s) => s.materialObjectId === id);
    return seg?.endContact?.objectName ?? id;
  }

  private renderEnd(): void {
    if (!this.result) return;
    const r = this.result;
    const reason = r.endReason as EndReason;
    this.endEl.classList.remove('hint', 'warn', 'danger');
    // classList.add 不接受空字符串: target-hit 用默认样式, 其余按性质着色
    if (reason !== 'target-hit') {
      this.endEl.classList.add(
        reason === 'max-range' || reason === 'max-interactions' || reason === 'min-energy'
          ? 'warn'
          : 'danger',
      );
    }
    this.endEl.innerHTML =
      `<strong>${END_REASON_LABELS[reason]}</strong><br>` +
      `总路程(含材料内部): <strong>${fmt(r.totalDistance)}</strong> · ` +
      `交互次数: <strong>${r.interactionCount}/${r.params.maxInteractions}</strong> · ` +
      `剩余能量: <strong>${fmt(r.remainingEnergy)}</strong><br>` +
      `终点: ${vec(r.endPoint)}`;
  }
}
