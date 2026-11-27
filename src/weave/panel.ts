import type { WeaveState, YarnSpec } from './weaveMath';
import { setCell } from './weaveMath';
import { PRESETS, type Preset } from './presets';
import { exportMaps, downloadCanvas, type ExportResult } from './exporter';
import type { FabricScene, PickResult } from './scene';

type YarnKind = 'warp' | 'weft';

interface PendingPick {
  i: number;
  j: number;
}

export class Panel {
  private state: WeaveState;
  private selected: PendingPick | null = null;
  private lastExport: ExportResult | null = null;
  private paintValue = -1;

  constructor(
    private readonly root: HTMLElement,
    private readonly scene: FabricScene,
    initial: WeaveState,
  ) {
    this.state = initial;
    this.render();
  }

  getState(): WeaveState {
    return this.state;
  }

  // ---------- 主框架 ----------
  private render(): void {
    this.root.innerHTML = `
      <div class="section">
        <h2>预设组织</h2>
        <div class="preset-btns">
          ${PRESETS.map((p) => `<button data-preset="${p.id}">${p.label}</button>`).join('')}
        </div>
        <div class="preset-desc" id="preset-desc"></div>
      </div>

      <div class="section">
        <h2>组织格（点击/拖动切换）</h2>
        <div class="grid-wrap" id="grid-wrap"></div>
        <div class="legend">
          <span class="lg-w">经线上浮</span>
          <span class="lg-f">纬线上浮</span>
        </div>
        <div class="sub">行 = 纬线 j，列 = 经线 i；所有重复共用这一个循环</div>
      </div>

      <div class="section">
        <h2>拾取定位</h2>
        <div class="pick-info" id="pick-info">在布面上点击任意交叉点…</div>
      </div>

      <div class="section">
        <h2>经线参数（沿 Z 方向）</h2>
        <div id="warp-controls"></div>
      </div>

      <div class="section">
        <h2>纬线参数（沿 X 方向）</h2>
        <div id="weft-controls"></div>
      </div>

      <div class="section">
        <h2>重复与视图</h2>
        <div class="row">
          <label>X 重复</label>
          <input type="range" id="rep-x" min="1" max="8" step="1" value="${this.state.repsX}" />
          <span class="val" id="rep-x-val">${this.state.repsX}</span>
        </div>
        <div class="row">
          <label>Z 重复</label>
          <input type="range" id="rep-z" min="1" max="8" step="1" value="${this.state.repsZ}" />
          <span class="val" id="rep-z-val">${this.state.repsZ}</span>
        </div>
        <div class="checkline">
          <input type="checkbox" id="single-cycle" ${this.state.repsX === 1 && this.state.repsZ === 1 ? 'checked' : ''} />
          <label for="single-cycle" style="flex:1">只看一个循环</label>
        </div>
        <div class="checkline">
          <input type="checkbox" id="show-bounds" checked />
          <label for="show-bounds" style="flex:1">显示循环边界</label>
        </div>
        <div class="row" style="margin-top:8px">
          <button id="frame-btn" style="flex:1">重新取景</button>
        </div>
      </div>

      <div class="section">
        <h2>导出一个循环</h2>
        <div class="row">
          <label>图像尺寸</label>
          <select id="export-size" style="flex:1;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px">
            <option value="256">256 × 256</option>
            <option value="512" selected>512 × 512</option>
            <option value="1024">1024 × 1024</option>
          </select>
        </div>
        <button class="primary" id="export-btn" style="width:100%;margin-top:6px">生成俯视色图 + 灰度高度图</button>
        <div class="sub">色图与高度图同尺寸、逐像素对应，四边周期连续，可直接平铺</div>
      </div>

      <div class="section">
        <h2>核对清单</h2>
        <ul class="help">
          <li>切到「长浮线」预设，重复 ≥2 后看 <code>i=0</code> 经线在循环接缝处是否一根连续压过 4 根纬线、颜色不突变</li>
          <li>「粗细不均」预设下改半径/间距，交叉点不会空洞，导出高度图能看到两种线的高差</li>
          <li>旋转视角或改粗细后点布面，仍能回到对应组织格并显示第几次重复</li>
          <li>导出弹窗里的 2×2 平铺图：粉线两侧花纹、颜色必须严丝合缝</li>
        </ul>
      </div>
    `;

    this.buildGrid();
    this.buildYarnControls('warp');
    this.buildYarnControls('weft');
    this.bindEvents();
    this.updatePresetDesc(null);
  }

  // ---------- 编辑格 ----------
  private buildGrid(): void {
    const wrap = this.root.querySelector('#grid-wrap')!;
    const { sizeW, sizeF, matrix } = this.state.model;
    let html = '<table class="grid"><tr><th></th>';
    for (let i = 0; i < sizeW; i++) html += `<th>i${i}</th>`;
    html += '</tr>';
    for (let j = 0; j < sizeF; j++) {
      html += `<tr><th>j${j}</th>`;
      for (let i = 0; i < sizeW; i++) {
        const on = matrix[i * sizeF + j] === 1;
        const sel = this.selected && this.selected.i === i && this.selected.j === j;
        html += `<td>
          <div class="cell ${on ? 'warp' : 'weft'} ${sel ? 'selected' : ''}"
               data-i="${i}" data-j="${j}" title="i${i} j${j}：${on ? '经线上浮' : '纬线上浮'}">
            ${on ? '经' : '纬'}
          </div></td>`;
      }
      html += '</tr>';
    }
    html += '</table>';
    wrap.innerHTML = html;

    const grid = wrap.querySelector('table')!;
    grid.addEventListener('pointerdown', (e) => {
      const cell = (e.target as HTMLElement).closest('.cell') as HTMLElement | null;
      if (!cell) return;
      e.preventDefault();
      const i = Number(cell.dataset.i);
      const j = Number(cell.dataset.j);
      const cur = this.state.model.matrix[i * this.state.model.sizeF + j];
      this.paintValue = cur === 1 ? 0 : 1;
      this.applyPaint(i, j);
      // 合成事件可能没有激活指针，setPointerCapture 会抛 InvalidStateError
      try {
        grid.setPointerCapture(e.pointerId);
      } catch {
        /* 非真实指针事件，忽略 */
      }
    });
    grid.addEventListener('pointermove', (e) => {
      if (this.paintValue < 0) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const cell = el?.closest('.cell') as HTMLElement | null;
      if (!cell) return;
      this.applyPaint(Number(cell.dataset.i), Number(cell.dataset.j));
    });
    const endPaint = () => {
      this.paintValue = -1;
    };
    grid.addEventListener('pointerup', endPaint);
    grid.addEventListener('pointercancel', endPaint);
  }

  private applyPaint(i: number, j: number): void {
    const { sizeF, matrix } = this.state.model;
    if (matrix[i * sizeF + j] === this.paintValue) return;
    setCell(this.state.model, i, j, this.paintValue);
    this.selected = { i, j };
    this.scene.updateState(this.state);
    this.buildGrid();
  }

  // ---------- 线材参数 ----------
  private buildYarnControls(kind: YarnKind): void {
    const spec = this.state.yarn[kind];
    const host = this.root.querySelector(`#${kind}-controls`)!;
    host.innerHTML = `
      <div class="row">
        <label>半径</label>
        <input type="range" data-kind="${kind}" data-key="radius" min="0.08" max="0.4" step="0.01" value="${spec.radius}" />
        <span class="val">${spec.radius.toFixed(2)}</span>
      </div>
      <div class="row">
        <label>间距</label>
        <input type="range" data-kind="${kind}" data-key="spacing" min="0.3" max="1.2" step="0.01" value="${spec.spacing}" />
        <span class="val">${spec.spacing.toFixed(2)}</span>
      </div>
      <div class="sub">颜色顺序（按循环内线号依次取色，循环接缝处不变色）</div>
      <div class="color-list" id="${kind}-colors"></div>
      <div class="row" style="margin-top:6px">
        <button data-add-color="${kind}" style="flex:1">＋ 添加颜色</button>
      </div>
    `;
    this.buildColorChips(kind);
  }

  private buildColorChips(kind: YarnKind): void {
    const spec: YarnSpec = this.state.yarn[kind];
    const host = this.root.querySelector(`#${kind}-colors`)!;
    host.innerHTML = spec.colors
      .map(
        (c, idx) => `
        <div class="color-chip" title="第 ${idx} 号线颜色">
          <input type="color" value="${c}" data-kind="${kind}" data-idx="${idx}" />
          <button data-del-color="${kind}" data-idx="${idx}" title="删除">×</button>
        </div>`,
      )
      .join('');

    host.querySelectorAll<HTMLInputElement>('input[type=color]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.kind as YarnKind;
        const idx = Number(inp.dataset.idx);
        this.state.yarn[k].colors[idx] = inp.value;
        this.scene.updateState(this.state);
      });
    });
    host.querySelectorAll<HTMLButtonElement>('button[data-del-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.delColor as YarnKind;
        const idx = Number(btn.dataset.idx);
        if (this.state.yarn[k].colors.length <= 1) return;
        this.state.yarn[k].colors.splice(idx, 1);
        this.scene.updateState(this.state);
        this.buildColorChips(k);
      });
    });
  }

  // ---------- 事件 ----------
  private bindEvents(): void {
    this.root.querySelectorAll<HTMLButtonElement>('button[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => this.applyPreset(btn.dataset.preset!));
    });

    this.root.querySelectorAll<HTMLInputElement>('input[type=range][data-kind]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const kind = inp.dataset.kind as YarnKind;
        const key = inp.dataset.key as 'radius' | 'spacing';
        this.state.yarn[kind][key] = Number(inp.value);
        inp.parentElement!.querySelector('.val')!.textContent = Number(inp.value).toFixed(2);
        this.scene.updateState(this.state);
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>('button[data-add-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.addColor as YarnKind;
        const pool = ['#c9504b', '#e8b64c', '#3f7d9e', '#5ba86a', '#8f6fd0', '#e8e2d4'];
        this.state.yarn[kind].colors.push(pool[this.state.yarn[kind].colors.length % pool.length]);
        this.scene.updateState(this.state);
        this.buildColorChips(kind);
      });
    });

    const repX = this.root.querySelector<HTMLInputElement>('#rep-x')!;
    const repZ = this.root.querySelector<HTMLInputElement>('#rep-z')!;
    repX.addEventListener('input', () => {
      this.state.repsX = Number(repX.value);
      this.root.querySelector('#rep-x-val')!.textContent = repX.value;
      this.syncSingleCycle();
      this.scene.updateState(this.state);
    });
    repZ.addEventListener('input', () => {
      this.state.repsZ = Number(repZ.value);
      this.root.querySelector('#rep-z-val')!.textContent = repZ.value;
      this.syncSingleCycle();
      this.scene.updateState(this.state);
    });

    this.root.querySelector<HTMLInputElement>('#single-cycle')!.addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      if (on) {
        this.state.repsX = 1;
        this.state.repsZ = 1;
      } else {
        this.state.repsX = 3;
        this.state.repsZ = 3;
      }
      repX.value = String(this.state.repsX);
      repZ.value = String(this.state.repsZ);
      this.root.querySelector('#rep-x-val')!.textContent = String(this.state.repsX);
      this.root.querySelector('#rep-z-val')!.textContent = String(this.state.repsZ);
      this.scene.updateState(this.state);
    });

    this.root.querySelector<HTMLInputElement>('#show-bounds')!.addEventListener('change', (e) => {
      this.scene.setBoundsVisible((e.target as HTMLInputElement).checked);
    });

    this.root.querySelector('#frame-btn')!.addEventListener('click', () => this.scene.frameCamera());
    this.root.querySelector('#export-btn')!.addEventListener('click', () => this.doExport());
  }

  private syncSingleCycle(): void {
    const box = this.root.querySelector<HTMLInputElement>('#single-cycle')!;
    box.checked = this.state.repsX === 1 && this.state.repsZ === 1;
  }

  private applyPreset(id: string): void {
    const preset = PRESETS.find((p) => p.id === id)!;
    this.state.model = {
      sizeW: preset.model.sizeW,
      sizeF: preset.model.sizeF,
      matrix: preset.model.matrix.slice(),
    };
    this.state.yarn = JSON.parse(JSON.stringify(preset.yarn));
    this.selected = null;
    this.scene.hideMarker();
    this.scene.updateState(this.state);
    this.render();
    this.updatePresetDesc(preset);
  }

  private updatePresetDesc(active: Preset | null): void {
    const el = this.root.querySelector('#preset-desc');
    if (!el) return;
    el.textContent = active ? active.desc : '';
  }

  // ---------- 拾取联动 ----------
  handlePick(pick: PickResult): void {
    this.selected = { i: pick.i, j: pick.j };
    this.buildGrid();
    const { sizeF } = this.state.model;
    const on = this.state.model.matrix[pick.i * sizeF + pick.j] === 1;
    this.root.querySelector('#pick-info')!.innerHTML = `
      命中组织格 <b>i${pick.i} / j${pick.j}</b>（${on ? '经线上浮' : '纬线上浮'}）<br/>
      实际位置：第 <b>${pick.repX}</b> 次 X 重复 × 第 <b>${pick.repZ}</b> 次 Z 重复
      （全局经线 g=${pick.globalW}，全局纬线 h=${pick.globalF}，均从 0 计）
    `;
  }

  pickMissed(): void {
    this.scene.hideMarker();
  }

  // ---------- 导出 ----------
  private doExport(): void {
    const size = Number(this.root.querySelector<HTMLSelectElement>('#export-size')!.value);
    this.lastExport = exportMaps(this.state, size);
    this.showExportModal(this.lastExport);
  }

  private showExportModal(res: ExportResult): void {
    const modal = document.querySelector('#modal')!;
    modal.classList.remove('hidden');
    modal.innerHTML = `
      <div class="modal-box">
        <h2>一个循环的导出图（${res.size} × ${res.size}，两张同尺寸）</h2>
        <div class="modal-imgs">
          <figure>
            <canvas id="exp-color"></canvas>
            <figcaption>俯视色图（sRGB）</figcaption>
          </figure>
          <figure>
            <canvas id="exp-height"></canvas>
            <figcaption>灰度高度图（越亮越高）</figcaption>
          </figure>
          <figure>
            <canvas id="exp-tiled"></canvas>
            <figcaption>色图 2×2 平铺核对（粉线 = 循环边）</figcaption>
          </figure>
        </div>
        <div class="modal-actions">
          <button id="dl-color">下载色图 PNG</button>
          <button id="dl-height">下载高度图 PNG</button>
          <button class="primary" id="close-modal">关闭</button>
        </div>
      </div>`;
    document.querySelector('#exp-color')!.replaceWith(res.colorCanvas);
    res.colorCanvas.id = 'exp-color';
    document.querySelector('#exp-height')!.replaceWith(res.heightCanvas);
    res.heightCanvas.id = 'exp-height';
    document.querySelector('#exp-tiled')!.replaceWith(res.tiledCanvas);
    res.tiledCanvas.id = 'exp-tiled';

    document.querySelector('#dl-color')!.addEventListener('click', () =>
      downloadCanvas(res.colorCanvas, 'weave-color.png'),
    );
    document.querySelector('#dl-height')!.addEventListener('click', () =>
      downloadCanvas(res.heightCanvas, 'weave-height.png'),
    );
    document.querySelector('#close-modal')!.addEventListener('click', () => {
      modal.classList.add('hidden');
      modal.innerHTML = '';
    });
  }
}
