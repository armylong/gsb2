import type { Marker } from '../core/types';
import { Timeline } from '../core/timeline';
import { planExport, renderExport, type ExportPlan } from '../core/render';
import { encodeWav } from '../core/wav';
import { store } from './state';
import type { TableSelection } from './table';

const SAMPLE_RATES = [44100, 48000, 96000];

const MARKER_LABEL: Record<Marker['kind'], string> = {
  zero: '零点',
  'segment-start': '新段首拍',
  'last-beat': '最后一拍',
  'selection-end': '选区结束(不发声)',
  'count-in': '预备拍开始',
};

export class ExportPanel {
  readonly el: HTMLElement;
  private sampleRate = 48000;
  private countIn = true;

  constructor(
    private getTimeline: () => Timeline,
    private getSelection: () => TableSelection | null,
  ) {
    this.el = document.createElement('section');
    this.el.className = 'panel export-panel';
    this.el.innerHTML = `
      <h2>导出 WAV (按小节框选)</h2>
      <div class="field-row">
        <label class="field"><span>起始小节</span><input type="number" min="0" data-k="barFrom" /></label>
        <label class="field"><span>结束小节</span><input type="number" min="0" data-k="barTo" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>采样率</span>
          <select data-k="sampleRate">
            ${SAMPLE_RATES.map((r) => `<option value="${r}" ${r === this.sampleRate ? 'selected' : ''}>${r} Hz</option>`).join('')}
          </select>
        </label>
        <label class="switch-row field">
          <input type="checkbox" data-k="countIn" ${this.countIn ? 'checked' : ''} />
          <span>带一小节预备拍</span>
        </label>
      </div>
      <div class="export-actions">
        <button type="button" class="btn" data-act="use-selection">使用表格框选</button>
        <button type="button" class="btn" data-act="preview">预览拍点 / 标记</button>
        <button type="button" class="btn btn-primary" data-act="export">导出 WAV</button>
      </div>
      <div class="export-summary" data-role="summary"></div>
      <div class="marker-preview" data-role="markers"></div>`;
    this.bind();
  }

  private input(k: string): HTMLInputElement | HTMLSelectElement {
    return this.el.querySelector(`[data-k="${k}"]`)!;
  }

  private currentRange(): { barFrom: number; barTo: number } | null {
    const tl = this.getTimeline();
    const barFrom = Number(this.input('barFrom').value);
    const barTo = Number(this.input('barTo').value);
    if (!Number.isFinite(barFrom) || !Number.isFinite(barTo)) return null;
    const lo = Math.max(0, Math.min(barFrom, barTo));
    const hi = Math.min(tl.bars.length - 1, Math.max(barFrom, barTo));
    if (lo > hi) return null;
    return { barFrom: lo, barTo: hi };
  }

  private buildPlan(): ExportPlan | null {
    const range = this.currentRange();
    if (!range) return null;
    return planExport(this.getTimeline(), store.project, {
      sampleRate: this.sampleRate,
      barFrom: range.barFrom,
      barTo: range.barTo,
      countIn: this.countIn,
    });
  }

  private bind(): void {
    this.el.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (target.dataset.k === 'sampleRate') this.sampleRate = Number(target.value);
      if (target.dataset.k === 'countIn') this.countIn = (target as HTMLInputElement).checked;
    });
    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
      if (!btn) return;
      if (btn.dataset.act === 'use-selection') {
        const sel = this.getSelection();
        if (sel) {
          (this.input('barFrom') as HTMLInputElement).value = String(sel.barFrom);
          (this.input('barTo') as HTMLInputElement).value = String(sel.barTo);
        }
      }
      if (btn.dataset.act === 'preview') this.preview();
      if (btn.dataset.act === 'export') this.export();
    });
  }

  private preview(): void {
    const plan = this.buildPlan();
    const summary = this.el.querySelector('[data-role="summary"]')!;
    const markersEl = this.el.querySelector('[data-role="markers"]')!;
    if (!plan) {
      summary.innerHTML = '<p class="warn">请先填写有效的小节范围</p>';
      markersEl.innerHTML = '';
      return;
    }
    const sr = this.sampleRate;
    summary.innerHTML = `
      <dl class="summary-grid">
        <dt>发声点数</dt><dd>${plan.hits.length} (整拍 ${plan.hits.filter((h) => h.kind !== 'sub').length} + 分拍 ${plan.hits.filter((h) => h.kind === 'sub').length})</dd>
        <dt>选区时长</dt><dd>${plan.selectionDuration.toFixed(4)} s</dd>
        <dt>预备拍</dt><dd>${plan.countInDuration > 0 ? plan.countInDuration.toFixed(4) + ' s' : '无'}</dd>
        <dt>文件总长</dt><dd>${plan.totalDuration.toFixed(4)} s (+ 尾部衰减留白)</dd>
      </dl>`;
    const markerRows = plan.markers
      .map((m) => {
        const sample = Math.round(m.t * sr);
        return `<tr class="marker-row marker-${m.kind}">
          <td>${MARKER_LABEL[m.kind]}</td>
          <td class="mono">${m.t.toFixed(5)} s</td>
          <td class="mono">sample ${sample}</td>
          <td class="mono">q=${m.q}</td>
        </tr>`;
      })
      .join('');
    const hitRows = plan.hits
      .map((h) => `<tr class="hit-row">
          <td>${h.inCountIn ? '预备' : h.barIndex}</td>
          <td>${h.beatInBar}</td>
          <td class="kind-${h.kind}">${h.kind}</td>
          <td class="mono">${h.tInFile.toFixed(5)}</td>
          <td class="mono">${h.sample}</td>
        </tr>`)
      .join('');
    markersEl.innerHTML = `
      <h3>关键标记 (导出前核对零点 / 段首 / 末拍)</h3>
      <table class="marker-table"><thead><tr><th>类型</th><th>秒</th><th>采样位置</th><th>q 坐标</th></tr></thead>
        <tbody>${markerRows}</tbody></table>
      <details><summary>全部 ${plan.hits.length} 个发声点</summary>
        <table class="marker-table hit-table"><thead><tr><th>小节</th><th>拍</th><th>类型</th><th>秒</th><th>sample</th></tr></thead>
        <tbody>${hitRows}</tbody></table>
      </details>`;
  }

  private export(): void {
    const range = this.currentRange();
    const summary = this.el.querySelector('[data-role="summary"]')!;
    if (!range) {
      summary.innerHTML = '<p class="warn">请先填写有效的小节范围</p>';
      return;
    }
    const rendered = renderExport(this.getTimeline(), store.project, {
      sampleRate: this.sampleRate,
      barFrom: range.barFrom,
      barTo: range.barTo,
      countIn: this.countIn,
    });
    const wav = encodeWav(rendered.pcm, this.sampleRate);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `beat-sheet-bar${range.barFrom}-${range.barTo}${this.countIn ? '-countin' : ''}.wav`;
    a.click();
    URL.revokeObjectURL(url);
    this.preview();
    summary.insertAdjacentHTML(
      'afterbegin',
      `<p class="ok">已导出 ${a.download} (${(wav.byteLength / 1024).toFixed(1)} KiB)</p>`,
    );
  }

  /** 表格框选变化时同步输入框 */
  syncSelection(sel: TableSelection | null): void {
    if (!sel) return;
    (this.input('barFrom') as HTMLInputElement).value = String(sel.barFrom);
    (this.input('barTo') as HTMLInputElement).value = String(sel.barTo);
  }
}
