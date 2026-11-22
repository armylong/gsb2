/**
 * 应用主控制器：模型加载 -> 量化 -> 分析 -> 渲染/面板 -> 导出回读
 */
import type {
  AnalysisResult,
  AxisMeta,
  MeshModel,
  QuantBits,
  RangeMode,
} from './core/types';
import { AXES, AXIS_NAMES } from './core/types';
import { BUILTIN_MODELS } from './core/models';
import { parseOBJ } from './core/objParser';
import { quantizeModel, maxTheoreticalError } from './core/quant';
import { analyzeModel, bboxDiagonal } from './core/analyze';
import { buildExport, downloadExport, readImport, verifyImport } from './core/export';
import type { ImportedModel, ImportVerification } from './core/export';
import { MeshViewer } from './viewer/viewer';
import type { PickedVertex } from './viewer/viewer';
import { drawLegend } from './viewer/heat';
import type { HeatScale } from './viewer/heat';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

class App {
  private model: MeshModel | null = null;
  private analysis: AnalysisResult | null = null;
  private imported: ImportedModel | null = null;
  private viewer: MeshViewer;
  private heatScale: HeatScale = 'log';

  constructor() {
    this.viewer = new MeshViewer($('viewer'), { onPick: (p) => this.showPick(p) });
    this.bindUi();
    this.loadBuiltin(BUILTIN_MODELS[0].id);
  }

  // ---------------- UI 绑定 ----------------
  private bindUi() {
    const sel = $('modelSelect') as HTMLSelectElement;
    for (const m of BUILTIN_MODELS) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => this.loadBuiltin(sel.value));

    $('objFile').addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        this.setModel(parseOBJ(text, file.name.replace(/\.obj$/i, '')));
      } catch (err) {
        alert(`OBJ 解析失败：${(err as Error).message}`);
      }
      input.value = '';
    });

    document.querySelectorAll<HTMLInputElement>('input[name="rangeMode"]').forEach((r) =>
      r.addEventListener('change', () => this.reanalyze()),
    );
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const slider = $(`bits${axis}`) as HTMLInputElement;
      slider.addEventListener('input', () => {
        $(`bits${axis}Val`).textContent = slider.value;
        this.reanalyze();
      });
    }
    document.querySelectorAll<HTMLButtonElement>('button[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = b.dataset.preset!;
        for (const axis of ['X', 'Y', 'Z'] as const) {
          ($(`bits${axis}`) as HTMLInputElement).value = v;
          $(`bits${axis}Val`).textContent = v;
        }
        this.reanalyze();
      }),
    );

    const exag = $('exag') as HTMLInputElement;
    exag.addEventListener('input', () => {
      $('exagVal').textContent = `${exag.value}×`;
      this.viewer.setExaggeration(Number(exag.value));
    });
    $('wireframe').addEventListener('change', (e) =>
      this.viewer.setWireframe((e.target as HTMLInputElement).checked),
    );
    $('seamLines').addEventListener('change', (e) =>
      this.viewer.setSeamsVisible((e.target as HTMLInputElement).checked),
    );
    $('dupMarkers').addEventListener('change', (e) =>
      this.viewer.setDupsVisible((e.target as HTMLInputElement).checked),
    );
    document.querySelectorAll<HTMLInputElement>('input[name="heatScale"]').forEach((r) =>
      r.addEventListener('change', () => {
        this.heatScale = r.value as HeatScale;
        this.viewer.setHeatScale(this.heatScale);
        this.refreshLegend();
      }),
    );

    $('exportBtn').addEventListener('click', () => {
      if (this.model && this.analysis) downloadExport(buildExport(this.model, this.analysis));
    });
    $('importFile').addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      try {
        const imp = readImport(await file.text());
        this.imported = imp;
        const verification = verifyImport(imp, this.model ?? undefined);
        this.showImportResult(imp, verification);
      } catch (err) {
        alert(`回读失败：${(err as Error).message}`);
      }
      input.value = '';
    });
  }

  private loadBuiltin(id: string) {
    const built = BUILTIN_MODELS.find((m) => m.id === id)!;
    this.setModel(built.build());
  }

  private setModel(model: MeshModel) {
    this.model = model;
    this.imported = null;
    $('importCard').classList.add('hidden');
    $('modelInfo').innerHTML =
      `${model.vertexCount} 顶点 · ${model.triangleCount} 三角形 · ${model.chunks.length} 块<br>` +
      `包围盒对角线 ${fmt(modelDiagSafe(model))}`;
    this.reanalyze();
  }

  // ---------------- 量化 + 分析 ----------------
  private currentBits(): QuantBits {
    return {
      x: Number(($('bitsX') as HTMLInputElement).value),
      y: Number(($('bitsY') as HTMLInputElement).value),
      z: Number(($('bitsZ') as HTMLInputElement).value),
    };
  }

  private currentRangeMode(): RangeMode {
    return (document.querySelector<HTMLInputElement>('input[name="rangeMode"]:checked')!.value) as RangeMode;
  }

  private reanalyze() {
    if (!this.model) return;
    const settings = { bits: this.currentBits(), rangeMode: this.currentRangeMode() };
    const quant = quantizeModel(this.model.chunks, this.model.bbox, settings);
    this.analysis = analyzeModel(this.model, quant);
    this.viewer.setModel(this.model, this.analysis);
    this.refreshLegend();
    this.renderStats();
    this.renderSeams();
    this.renderSpecial();
  }

  private refreshLegend() {
    if (!this.analysis) return;
    drawLegend($('legend') as HTMLCanvasElement, this.analysis.stats.maxError, this.heatScale);
  }

  // ---------------- 右侧面板 ----------------
  private renderStats() {
    if (!this.model || !this.analysis) return;
    const a = this.analysis;
    const s = a.stats;
    const theo = maxTheoreticalError(a.quant);

    let html = `
      <div class="info-line">范围模式：<b>${a.quant.settings.rangeMode === 'global' ? '整件共用范围' : '各块单独范围'}</b></div>
      <table class="data">
        <tr><th>指标</th><th>数值</th></tr>
        <tr><td>最大误差</td><td class="num">${fmt(s.maxError)}</td></tr>
        <tr><td>平均 / RMS</td><td class="num">${fmt(s.meanError)} / ${fmt(s.rmsError)}</td></tr>
        <tr><td>p50 / p90 / p99</td><td class="num">${fmt(s.p50)} / ${fmt(s.p90)} / ${fmt(s.p99)}</td></tr>
        <tr><td>理论最大误差(半格)</td><td class="num">${fmt(theo)}</td></tr>
      </table>
      <h2 style="margin-bottom:4px">理论坐标数据量</h2>
      <table class="data">
        <tr><th>口径</th><th>bit</th><th>byte</th></tr>
        <tr><td>名义(设定位数)</td><td class="num">${a.nominalBits.toLocaleString()}</td><td class="num">${a.nominalBytes.toLocaleString()}</td></tr>
        <tr><td>有效(实际编码)</td><td class="num">${a.effectiveBits.toLocaleString()}</td><td class="num">${a.effectiveBytes.toLocaleString()}</td></tr>
      </table>
      <h2 style="margin-bottom:4px">每块有效精度</h2>
      <table class="data">
        <tr><th>块 / 轴</th><th>X</th><th>Y</th><th>Z</th><th>步长(max)</th></tr>`;

    for (const ch of a.quant.chunks) {
      const chunk = this.model.chunks.find((c) => c.id === ch.chunkId)!;
      const maxStep = Math.max(...ch.axes.map((m) => m.step));
      html += `<tr><td title="${esc(chunk.name)}">${esc(shortName(chunk.name))}</td>`;
      for (const ax of AXES) {
        const m = ch.axes[ax];
        html += `<td>${m.flat ? '<span class="pill flat">零厚</span>' : `<span class="num">${m.effectiveBits}</span><div class="info-line">/${m.bits}b</div>`}</td>`;
      }
      html += `<td class="num">${fmt(maxStep)}</td></tr>`;
    }
    html += '</table>';
    $('statBody').innerHTML = html;
  }

  private renderSeams() {
    if (!this.analysis) return;
    const a = this.analysis;
    const sep = a.separatedSeams;
    const verdict = sep.length === 0
      ? '<span class="pill ok">当前设定下未检测到张开的接缝</span>'
      : `<span class="pill bad">${sep.length} 对相邻边被量化分开</span>`;

    const rows = [...a.seamPairs]
      .sort((p, q) => Math.abs(q.gap) - Math.abs(p.gap))
      .slice(0, 40)
      .map((p) => {
        const isSep = sep.includes(p);
        return `<div class="row">
          块${p.chunkA}#v${p.vertexA} ↔ 块${p.chunkB}#v${p.vertexB}<br>
          原始间距 <span class="num">${fmt(p.originalDistance)}</span> →
          还原 <span class="num">${fmt(p.restoredDistance)}</span>
          <span class="${isSep ? 'bad' : 'warn'} num">Δ=${fmt(p.gap)} (${p.gapInSteps.toFixed(2)} 格)</span>
        </div>`;
      })
      .join('');

    $('seamBody').innerHTML = `
      <div>相邻顶点对：${a.seamPairs.length} ${verdict}</div>
      <div class="info-line">判定：|张开量| 同时超过一个量化步长与该缝原始间距（红=量化致裂，橙=可容忍）</div>
      <div class="scroll-list">${rows || '<div class="info-line">无相邻边界顶点（模型可能只有单块）</div>'}</div>`;
  }

  private renderSpecial() {
    if (!this.model || !this.analysis) return;
    const a = this.analysis;

    // 零厚度轴
    const flatPills: string[] = [];
    for (const ch of a.quant.chunks) {
      const chunk = this.model.chunks.find((c) => c.id === ch.chunkId)!;
      for (const ax of AXES) {
        if (ch.axes[ax].flat) {
          flatPills.push(
            `<span class="pill flat">${esc(shortName(chunk.name))} · ${AXIS_NAMES[ax]} 轴恒定=${fmt(ch.axes[ax].min)}</span>`,
          );
        }
      }
    }

    const dupHtml = a.duplicates
      .map(
        (d) => `<div class="row">
          块${d.chunkId}（${esc(shortName(this.model!.chunks.find((c) => c.id === d.chunkId)!.name))}）
          同位置顶点 ${d.vertices.length} 个：<span class="num">[${d.vertices.slice(0, 8).join(', ')}${d.vertices.length > 8 ? '…' : ''}]</span><br>
          坐标 <span class="num">(${d.position.map(fmt).join(', ')})</span>
        </div>`,
      )
      .join('');

    $('specialBody').innerHTML = `
      <div>${flatPills.length ? flatPills.join('') : '<span class="pill ok">无零厚度轴</span>'}</div>
      <div class="info-line" style="margin-top:6px">零厚度轴不分配编码、不产生误差，导出时该轴仅记录常量值。</div>
      <h2 style="margin-bottom:4px">同位置重复顶点（${a.duplicates.length} 组）</h2>
      <div class="scroll-list">${dupHtml || '<span class="pill ok">无重复顶点</span>'}</div>`;
  }

  // ---------------- 拾取卡片 ----------------
  private showPick(p: PickedVertex | null) {
    const card = $('pickCard');
    if (!p || !this.analysis) {
      card.classList.add('hidden');
      return;
    }
    const a = this.analysis;
    const ch = a.quant.chunks.find((c) => c.chunkId === p.chunkId)!;
    const codeRow = AXES.map((ax) => `${AXIS_NAMES[ax]}=${ch.quant.codes[p.vertex * 3 + ax]}`).join(' · ');
    const rows = AXES.map((ax) => {
      const o = p.original[ax];
      const r = p.restored[ax];
      return `<tr><td>${AXIS_NAMES[ax]}</td>
        <td class="num">${fmt(o)}</td>
        <td class="num">${fmt(r)}</td>
        <td class="num ${Math.abs(r - o) > 0 ? 'warn' : 'good'}">${fmt(r - o)}</td></tr>`;
    }).join('');

    // 该顶点是否参与接缝 / 属于重复组
    const seam = a.seamPairs.filter(
      (s) =>
        (s.chunkA === p.chunkId && s.vertexA === p.vertex) ||
        (s.chunkB === p.chunkId && s.vertexB === p.vertex),
    );
    const dup = a.duplicates.find(
      (d) => d.chunkId === p.chunkId && d.vertices.includes(p.vertex),
    );

    card.innerHTML = `
      <h3>顶点详情</h3>
      <table>
        <tr><td>所属块</td><td>${esc(p.chunkName)}（id ${p.chunkId}）</td></tr>
        <tr><td>顶点索引</td><td class="num">#${p.vertex}</td></tr>
        <tr><td>整数编码</td><td class="num">${codeRow}</td></tr>
      </table>
      <table class="data" style="margin-top:6px">
        <tr><th>轴</th><th>原坐标</th><th>还原坐标</th><th>差值</th></tr>
        ${rows}
      </table>
      <table style="margin-top:6px">
        <tr><td>空间距离</td><td class="num bad">${fmt(p.error)}</td></tr>
        <tr><td>占对角线</td><td class="num">${(p.error / a.modelDiagonal).toExponential(2)}</td></tr>
      </table>
      ${seam.length ? `<div class="warn" style="margin-top:6px">接缝顶点：与 ${seam.length} 个邻块顶点配对，最大张开 ${fmt(Math.max(...seam.map((s) => Math.abs(s.gap))))}</div>` : ''}
      ${dup ? `<div class="mag" style="margin-top:4px">同位置重复顶点组成员：[${dup.vertices.join(', ')}]</div>` : ''}`;
    card.classList.remove('hidden');
  }

  // ---------------- 回读卡片 ----------------
  private showImportResult(imp: ImportedModel, v: ImportVerification) {
    const card = $('importCard');
    const f = imp.file;
    const fc = v.fullComparison;
    const badProbes = v.probes.filter((p) => !p.decodeExact || !p.errorExact).length;

    card.innerHTML = `
      <h3>回读校验：${esc(f.sourceName)}</h3>
      <table>
        <tr><td>导出时间</td><td>${f.exportedAt.replace('T', ' ').slice(0, 19)}</td></tr>
        <tr><td>量化设定</td><td>${f.settings.bits.x}/${f.settings.bits.y}/${f.settings.bits.z} bit · ${f.settings.rangeMode === 'global' ? '整件范围' : '分块范围'}</td></tr>
        <tr><td>探针校验</td><td class="${v.allExact ? 'good' : 'bad'}">${v.probes.length} 个探针，${badProbes === 0 ? '坐标/误差逐位一致 ✓' : `${badProbes} 个不一致 ✗`}</td></tr>
      </table>
      <table class="data" style="margin-top:6px">
        <tr><th>校验和项</th><th>导出时值</th></tr>
        <tr><td>maxError</td><td class="num">${fmt(v.checksumEcho.maxError)}</td></tr>
        <tr><td>RMS / mean</td><td class="num">${fmt(v.checksumEcho.rmsError)} / ${fmt(v.checksumEcho.meanError)}</td></tr>
        <tr><td>接缝最大张开</td><td class="num">${fmt(v.checksumEcho.seamMaxGap)}（${v.checksumEcho.seamSeparatedCount} 对分开）</td></tr>
        <tr><td>数据量(名义/有效)</td><td class="num">${v.checksumEcho.nominalBytes.toLocaleString()} / ${v.checksumEcho.effectiveBytes.toLocaleString()} B</td></tr>
      </table>
      ${
        fc
          ? `<div class="${fc.maxErrorMatch && fc.rmsMatch && fc.seamGapMatch ? 'good' : 'bad'}" style="margin-top:6px">
               与当前源模型全量比对（${fc.vertexCount} 顶点）：<br>
               max/RMS/mean 一致：${fc.maxErrorMatch ? '✓' : '✗'} / ${fc.rmsMatch ? '✓' : '✗'} / ${fc.meanMatch ? '✓' : '✗'}<br>
               接缝张开一致：${fc.seamGapMatch ? '✓' : '✗'}（${fmt(fc.seamGapMax)}）
             </div>`
          : '<div class="info-line" style="margin-top:6px">当前模型与导出源不同，仅做文件内探针逐位校验；切换到导出时的模型可做全量比对。</div>'
      }
      <div style="margin-top:8px; display:flex; gap:6px">
        <button class="mini" id="loadRestoredBtn">载入回读还原模型到视口</button>
        <button class="mini" id="closeImportBtn">关闭</button>
      </div>`;
    card.classList.remove('hidden');

    $('closeImportBtn').addEventListener('click', () => card.classList.add('hidden'));
    $('loadRestoredBtn').addEventListener('click', () => {
      this.setModel(imp.restoredModel);
      card.classList.add('hidden');
    });
  }
}

function modelDiagSafe(m: MeshModel) {
  return bboxDiagonal(m.bbox);
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const av = Math.abs(v);
  if (av !== 0 && (av >= 1e5 || av < 1e-3)) return v.toExponential(3);
  return Number(v.toPrecision(7)).toString();
}

function shortName(name: string): string {
  return name.length > 12 ? name.slice(0, 11) + '…' : name;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

new App();
