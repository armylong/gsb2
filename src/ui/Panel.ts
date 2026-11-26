/**
 * 左侧控制面板: 场景预设、时间轴/检查区间、运动参数、障碍编辑、碰撞清单、导出。
 * 纯 DOM 构建, 所有写操作走 Store, 读操作订阅 Store 刷新。
 */
import { deg } from '../core/kinematics';
import { ALL_SCENARIOS } from '../core/scenarios';
import type { AppState } from '../state/store';
import { Store } from '../state/store';
import type { ViewMode } from '../three/Viewer';

export interface UIHandlers {
  onView: (v: ViewMode) => void;
  onExportSVG: (plane: 'top' | 'side') => void;
  onExportCSV: () => void;
}

const $ = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

function section(title: string): HTMLElement {
  const wrap = $('div', 'section');
  wrap.appendChild($('h3', undefined, title));
  return wrap;
}

function numberField(label: string, value: number, step: number, onChange: (v: number) => void): HTMLElement {
  const row = $('div', 'field-row');
  row.appendChild($('label', undefined, label));
  const input = $('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(Math.round(value * 100) / 100);
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) onChange(v);
  });
  row.appendChild(input);
  return row;
}

function slider(label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void) {
  const row = $('div', 'field-block');
  const head = $('div', 'field-head');
  head.appendChild($('label', undefined, label));
  const val = $('span', 'val', String(Math.round(value * 1000) / 1000));
  head.appendChild(val);
  const input = $('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = String(Math.round(v * 1000) / 1000);
    onChange(v);
  });
  row.appendChild(head);
  row.appendChild(input);
  return row;
}

export class Panel {
  private root: HTMLElement;
  private store: Store;
  private handlers: UIHandlers;
  private rangeMinInput?: HTMLInputElement;
  private rangeMaxInput?: HTMLInputElement;
  private eventList?: HTMLElement;
  private hud?: HTMLElement;
  private contactCard?: HTMLElement;

  constructor(root: HTMLElement, store: Store, handlers: UIHandlers) {
    this.root = root;
    this.store = store;
    this.handlers = handlers;
    this.build();
    store.subscribe((s) => this.refresh(s));
  }

  private build(): void {
    this.root.innerHTML = '';
    const title = $('h2', undefined, '展柜开门余量检查');
    this.root.appendChild(title);

    // 1. 场景预设
    const sc = section('1 · 场景样例');
    const sel = $('select') as HTMLSelectElement;
    for (const s of ALL_SCENARIOS) {
      const opt = $('option', undefined, s.name) as HTMLOptionElement;
      opt.value = s.id;
      sel.appendChild(opt);
    }
    sel.value = this.store.getState().scenarioId;
    sel.addEventListener('change', () => this.store.loadScenario(sel.value));
    sc.appendChild(sel);
    const desc = $('p', 'desc');
    desc.id = 'scenario-desc';
    sc.appendChild(desc);
    this.root.appendChild(sc);

    // 2. 时间轴与检查区间
    const time = section('2 · 时间轴 / 检查区间');
    const playRow = $('div', 'btn-row');
    const playBtn = $('button', undefined, '播放') as HTMLButtonElement;
    playBtn.id = 'play-btn';
    playBtn.addEventListener('click', () => this.store.setPlaying(!this.store.getState().playing));
    const resetBtn = $('button', undefined, '回到起点');
    resetBtn.addEventListener('click', () => {
      this.store.setPlaying(false);
      this.store.setT(0);
    });
    playRow.appendChild(playBtn);
    playRow.appendChild(resetBtn);
    time.appendChild(playRow);
    time.appendChild(slider('当前时刻 t', 0, 0, 1, 0.001, (v) => this.store.setT(v)));
    const tSlider = time.querySelector('input[type=range]') as HTMLInputElement;
    tSlider.id = 't-slider';

    const rangeWrap = $('div', 'range-wrap');
    rangeWrap.appendChild($('label', undefined, '检查区间 (收紧后扫掠与碰撞立即重算)'));
    const dual = $('div', 'dual-range');
    const minI = $('input') as HTMLInputElement;
    minI.type = 'range';
    minI.min = '0';
    minI.max = '1';
    minI.step = '0.005';
    const maxI = $('input') as HTMLInputElement;
    maxI.type = 'range';
    maxI.min = '0';
    maxI.max = '1';
    maxI.step = '0.005';
    minI.addEventListener('input', () => {
      const s = this.store.getState();
      this.store.setRange([Math.min(parseFloat(minI.value), s.range[1]), s.range[1]]);
    });
    maxI.addEventListener('input', () => {
      const s = this.store.getState();
      this.store.setRange([s.range[0], Math.max(parseFloat(maxI.value), s.range[0])]);
    });
    dual.appendChild(minI);
    dual.appendChild(maxI);
    rangeWrap.appendChild(dual);
    const rangeVal = $('div', 'val');
    rangeVal.id = 'range-val';
    rangeWrap.appendChild(rangeVal);
    time.appendChild(rangeWrap);
    this.rangeMinInput = minI;
    this.rangeMaxInput = maxI;

    time.appendChild(slider('播放全程用时 (秒, 仅影响播放)', this.store.getState().cycleSeconds, 1, 30, 0.5, (v) => this.store.setCycleSeconds(v)));
    const speedSlider = time.querySelectorAll('input[type=range]')[1] as HTMLInputElement;
    speedSlider.id = 'speed-slider';
    this.root.appendChild(time);

    // 3. 运动参数
    const motion = section('3 · 铰链与转动参数');
    const seqRow = $('div', 'field-row');
    seqRow.appendChild($('label', undefined, '转动顺序'));
    const seqSel = $('select') as HTMLSelectElement;
    for (const q of [
      ['simultaneous', '同时转动'],
      ['door-first', '先门后板'],
      ['tray-first', '先板后门'],
    ] as const) {
      const o = $('option', undefined, q[1]) as HTMLOptionElement;
      o.value = q[0];
      seqSel.appendChild(o);
    }
    seqSel.addEventListener('change', () => this.store.setSequence(seqSel.value as never));
    seqSel.id = 'seq-select';
    seqRow.appendChild(seqSel);
    motion.appendChild(seqRow);

    const s0 = this.store.getState();
    const doorStart = slider('门开合范围 起 (°)', deg(s0.mechanism.door.angleRange[0]), -180, 180, 1, (v) => {
      const m = this.store.getState().mechanism;
      this.store.setDoorAngleRange(v, deg(m.door.angleRange[1]));
    });
    doorStart.querySelector('input')!.id = 'door-start';
    doorStart.querySelector('.val')!.id = 'door-start-val';
    motion.appendChild(doorStart);
    const doorEnd = slider('门开合范围 止 (°)', deg(s0.mechanism.door.angleRange[1]), -180, 270, 1, (v) => {
      const m = this.store.getState().mechanism;
      this.store.setDoorAngleRange(deg(m.door.angleRange[0]), v);
    });
    doorEnd.querySelector('input')!.id = 'door-end';
    doorEnd.querySelector('.val')!.id = 'door-end-val';
    motion.appendChild(doorEnd);
    const trayStart = slider('托板翻角 起 (°)', deg(s0.mechanism.tray.angleRange[0]), -180, 180, 1, (v) => {
      const m = this.store.getState().mechanism;
      this.store.setTrayAngleRange(v, deg(m.tray.angleRange[1]));
    });
    trayStart.querySelector('input')!.id = 'tray-start';
    trayStart.querySelector('.val')!.id = 'tray-start-val';
    motion.appendChild(trayStart);
    const trayEnd = slider('托板翻角 止 (°)', deg(s0.mechanism.tray.angleRange[1]), -180, 270, 1, (v) => {
      const m = this.store.getState().mechanism;
      this.store.setTrayAngleRange(deg(m.tray.angleRange[0]), v);
    });
    trayEnd.querySelector('input')!.id = 'tray-end';
    trayEnd.querySelector('.val')!.id = 'tray-end-val';
    motion.appendChild(trayEnd);
    const pivot = s0.mechanism.door.pivot;
    motion.appendChild(numberField('铰链 X (mm)', pivot[0], 10, (v) => {
      const p = this.store.getState().mechanism.door.pivot;
      this.store.setDoorPivot([v, p[1], p[2]]);
    }));
    motion.appendChild(numberField('铰链 Y (mm)', pivot[1], 10, (v) => {
      const p = this.store.getState().mechanism.door.pivot;
      this.store.setDoorPivot([p[0], v, p[2]]);
    }));
    motion.appendChild(numberField('铰链 Z (mm)', pivot[2], 10, (v) => {
      const p = this.store.getState().mechanism.door.pivot;
      this.store.setDoorPivot([p[0], p[1], v]);
    }));
    this.root.appendChild(motion);

    // 4. 障碍
    const obs = section('4 · 箱形障碍 (选中后可在视图中拖拽)');
    const addBtn = $('button', undefined, '新增障碍');
    addBtn.addEventListener('click', () => this.store.addObstacle());
    obs.appendChild(addBtn);
    const obsList = $('div', 'obstacle-list');
    obsList.id = 'obstacle-list';
    obs.appendChild(obsList);
    this.root.appendChild(obs);

    // 5. 视图与扫掠
    const view = section('5 · 视图 / 扫掠显示');
    const viewRow = $('div', 'btn-row');
    for (const [v, label] of [
      ['perspective', '透视'],
      ['top', '俯视'],
      ['side', '侧视'],
    ] as const) {
      const b = $('button', undefined, label);
      b.dataset.view = v;
      b.addEventListener('click', () => this.handlers.onView(v));
      viewRow.appendChild(b);
    }
    view.appendChild(viewRow);
    const sweepRow = $('div', 'field-row');
    const cb = $('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = true;
    cb.id = 'sweep-toggle';
    cb.addEventListener('change', () => this.store.setShowSweep(cb.checked));
    sweepRow.appendChild(cb);
    sweepRow.appendChild($('label', undefined, '显示门板/托板扫掠范围'));
    view.appendChild(sweepRow);
    view.appendChild(slider('扫掠采样数', s0.sweepSamples, 8, 180, 2, (v) => this.store.setSweepSamples(v)));
    view.appendChild(slider('接触容差 (mm)', s0.contactTol, 0, 5, 0.1, (v) => {
      const s = this.store.getState();
      this.store.setTolerance(v, s.grazingTol);
    }));
    view.appendChild(slider('贴边/侵入分界 (mm)', s0.grazingTol, 0.1, 10, 0.1, (v) => {
      const s = this.store.getState();
      this.store.setTolerance(s.contactTol, v);
    }));
    this.root.appendChild(view);

    // 6. 碰撞清单
    const coll = section('6 · 碰撞时间清单 (点击回到该姿态)');
    this.eventList = $('div', 'event-list');
    this.eventList.id = 'event-list';
    coll.appendChild(this.eventList);
    this.root.appendChild(coll);

    // 7. 导出
    const exp = section('7 · 导出');
    const expRow = $('div', 'btn-row');
    const svgTop = $('button', undefined, '俯视检查图 SVG');
    svgTop.addEventListener('click', () => this.handlers.onExportSVG('top'));
    const svgSide = $('button', undefined, '侧视检查图 SVG');
    svgSide.addEventListener('click', () => this.handlers.onExportSVG('side'));
    const csvBtn = $('button', undefined, '碰撞清单 CSV');
    csvBtn.addEventListener('click', () => this.handlers.onExportCSV());
    expRow.append(svgTop, svgSide, csvBtn);
    exp.appendChild(expRow);
    this.root.appendChild(exp);

    this.hud = document.getElementById('hud') ?? undefined;
    this.contactCard = document.getElementById('contact-card') ?? undefined;
  }

  private refresh(s: AppState): void {
    // 场景描述
    const sc = ALL_SCENARIOS.find((x) => x.id === s.scenarioId);
    const desc = document.getElementById('scenario-desc');
    if (desc && sc) desc.textContent = sc.description;

    // 运动参数回显 (场景切换后同步, 正在拖动的控件不抢占)
    const seqSel = document.getElementById('seq-select') as HTMLSelectElement | null;
    if (seqSel && document.activeElement !== seqSel) seqSel.value = s.mechanism.sequence;
    const syncRange = (inputId: string, valId: string, value: number) => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      const valEl = document.getElementById(valId);
      if (input && document.activeElement !== input) input.value = String(value);
      if (valEl) valEl.textContent = String(Math.round(value * 1000) / 1000);
    };
    syncRange('door-start', 'door-start-val', deg(s.mechanism.door.angleRange[0]));
    syncRange('door-end', 'door-end-val', deg(s.mechanism.door.angleRange[1]));
    syncRange('tray-start', 'tray-start-val', deg(s.mechanism.tray.angleRange[0]));
    syncRange('tray-end', 'tray-end-val', deg(s.mechanism.tray.angleRange[1]));

    // 时间轴
    const tSlider = document.getElementById('t-slider') as HTMLInputElement | null;
    if (tSlider && document.activeElement !== tSlider) tSlider.value = String(s.t);
    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.textContent = s.playing ? '暂停' : '播放';
    if (this.rangeMinInput && document.activeElement !== this.rangeMinInput) {
      this.rangeMinInput.value = String(s.range[0]);
    }
    if (this.rangeMaxInput && document.activeElement !== this.rangeMaxInput) {
      this.rangeMaxInput.value = String(s.range[1]);
    }
    const rangeVal = document.getElementById('range-val');
    if (rangeVal) {
      rangeVal.textContent = `[${s.range[0].toFixed(3)}, ${s.range[1].toFixed(3)}]`;
    }

    // 障碍列表
    this.refreshObstacles(s);
    // 碰撞清单
    this.refreshEvents(s);
    // HUD
    if (this.hud) {
      const pose = this.store.currentPose();
      this.hud.innerHTML =
        `t=${s.t.toFixed(3)} · 门角=${deg(pose.doorAngle).toFixed(1)}° · 托板角=${deg(pose.trayAngle).toFixed(1)}°` +
        ` · 区间事件 ${s.events.length} 条 · 当前接触 ${s.liveContacts.length} 处`;
    }
    if (this.contactCard) {
      if (s.liveContacts.length === 0) {
        this.contactCard.classList.add('hidden');
      } else {
        this.contactCard.classList.remove('hidden');
        this.contactCard.innerHTML = s.liveContacts
          .map(
            (c) =>
              `<div class="contact ${c.kind}"><b>${c.kind === 'grazing' ? '贴边' : '进入障碍'}</b> · ` +
              `${c.obstacleName} / ${c.part === 'door' ? '门板' : '托板'} · 侵入 ${c.depth.toFixed(2)}mm<br>` +
              `<span>${c.label.obstacleFace} ｜ ${c.label.partSide}</span></div>`,
          )
          .join('');
      }
    }
  }

  private refreshObstacles(s: AppState): void {
    const list = document.getElementById('obstacle-list');
    if (!list) return;
    list.innerHTML = '';
    for (const o of s.obstacles) {
      const card = $('div', 'obstacle-card' + (o.id === s.selectedObstacleId ? ' selected' : ''));
      const head = $('div', 'obstacle-head');
      const name = $('input') as HTMLInputElement;
      name.value = o.name;
      name.addEventListener('change', () => {
        o.name = name.value;
        this.store.rescan();
      });
      const selBtn = $('button', undefined, o.id === s.selectedObstacleId ? '取消选中' : '选中拖拽');
      selBtn.addEventListener('click', () => {
        this.store.selectObstacle(o.id === s.selectedObstacleId ? null : o.id);
      });
      const delBtn = $('button', 'danger', '删除');
      delBtn.addEventListener('click', () => this.store.removeObstacle(o.id));
      head.append(name, selBtn, delBtn);
      card.appendChild(head);
      const dims = $('div', 'dims');
      dims.append(
        numberField('中心X', o.center[0], 10, (v) => this.store.moveObstacle(o.id, [v, o.center[1], o.center[2]])),
        numberField('中心Y', o.center[1], 10, (v) => this.store.moveObstacle(o.id, [o.center[0], v, o.center[2]])),
        numberField('中心Z', o.center[2], 10, (v) => this.store.moveObstacle(o.id, [o.center[0], o.center[1], v])),
        numberField('尺寸X', o.size[0], 10, (v) => this.store.setObstacleSize(o.id, [v, o.size[1], o.size[2]])),
        numberField('尺寸Y', o.size[1], 10, (v) => this.store.setObstacleSize(o.id, [o.size[0], v, o.size[2]])),
        numberField('尺寸Z', o.size[2], 10, (v) => this.store.setObstacleSize(o.id, [o.size[0], o.size[1], v])),
      );
      card.appendChild(dims);
      list.appendChild(card);
    }
  }

  private refreshEvents(s: AppState): void {
    if (!this.eventList) return;
    this.eventList.innerHTML = '';
    if (s.events.length === 0) {
      this.eventList.appendChild($('p', 'empty', '当前检查区间内无碰撞事件'));
      return;
    }
    for (const e of s.events) {
      const row = $('button', 'event-row ' + e.kind) as HTMLButtonElement;
      row.innerHTML =
        `<span class="tag">${e.kind === 'grazing' ? '贴边' : '侵入'}</span>` +
        `${e.obstacleName} / ${e.part === 'door' ? '门板' : '托板'}` +
        `<span class="times">接触 ${(e.enterT * 100).toFixed(1)}% → 分开 ${(e.exitT * 100).toFixed(1)}%` +
        ` · 最深 ${e.maxDepth.toFixed(1)}mm</span>`;
      row.title = `${e.enterLabel.obstacleFace}\n${e.enterLabel.partSide}`;
      row.addEventListener('click', () => this.store.jumpToT(e.enterT));
      this.eventList.appendChild(row);
      // 最深姿态的二级跳转
      const deep = $('button', 'event-sub') as HTMLButtonElement;
      deep.textContent = `↳ 跳到最大侵入姿态 t=${e.maxDepthT.toFixed(3)}`;
      deep.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.store.jumpToT(e.maxDepthT);
      });
      this.eventList.appendChild(deep);
    }
  }
}
