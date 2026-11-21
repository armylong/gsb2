import {
  FLEX_RANGE,
  HINGE_RANGE,
  PARTS,
  TARGETS,
  WEIGHT_RANGES,
  type PartId,
  type TargetId,
  type Weights,
} from './types';

export interface UiHooks {
  onWeightChange: (part: PartId, target: TargetId, value: number) => void;
  onHingeChange: (deg: number) => void;
  onFlexChange: (v: number) => void;
  onCapture: (slot: 0 | 1) => void;
  onPlay: () => void;
  onPause: () => void;
  onScrub: (t: number) => void;
  onSpeed: (v: number) => void;
  onToggleInfluence: (on: boolean) => void;
  onToggleSeam: (on: boolean) => void;
  onToggleLightHelper: (on: boolean) => void;
  onLightChange: (az: number, el: number) => void;
  onSave: () => void;
  onLoad: (file: File) => void;
  onReset: () => void;
}

export class ControlPanel {
  readonly root: HTMLElement;
  private hooks: UiHooks;
  private sliders = new Map<string, HTMLInputElement>();
  private valueLabels = new Map<string, HTMLElement>();
  private checkboxes = new Map<string, HTMLInputElement>();
  private timeline!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  constructor(root: HTMLElement, hooks: UiHooks) {
    this.root = root;
    this.hooks = hooks;
    this.build();
  }

  private build() {
    this.root.innerHTML = '';

    for (const part of PARTS) {
      const section = document.createElement('section');
      section.className = 'block';
      section.innerHTML = `<h3>${part.label} · 目标权重</h3>`;
      for (const target of TARGETS) {
        const [min, max] = WEIGHT_RANGES[part.id][target.id];
        const row = this.makeSlider(
          `${part.id}.${target.id}`,
          target.label,
          0,
          min,
          max,
          0.01,
          (v) => this.hooks.onWeightChange(part.id, target.id, v),
        );
        section.appendChild(row);
      }
      this.root.appendChild(section);
    }

    const hinge = document.createElement('section');
    hinge.className = 'block';
    hinge.innerHTML = '<h3>盖子开合(刚体铰链 + 软垂)</h3>';
    hinge.appendChild(
      this.makeSlider('hingeDeg', '开合角度', 0, HINGE_RANGE[0], HINGE_RANGE[1], 1, (v) =>
        this.hooks.onHingeChange(v),
      ),
    );
    hinge.appendChild(
      this.makeSlider('flex', '软垂幅度', 0, FLEX_RANGE[0], FLEX_RANGE[1], 0.01, (v) =>
        this.hooks.onFlexChange(v),
      ),
    );
    this.root.appendChild(hinge);

    const light = document.createElement('section');
    light.className = 'block';
    light.innerHTML = '<h3>斜照检查光</h3>';
    light.appendChild(this.makeSlider('lightAz', '方位角', 35, -180, 180, 1, () => this.emitLight()));
    light.appendChild(this.makeSlider('lightEl', '仰角', 55, 5, 90, 1, () => this.emitLight()));
    const influenceCb = this.makeCheckbox('influence', '影响区热图(多目标重叠=混色)', false, (on) =>
      this.hooks.onToggleInfluence(on),
    );
    const seamCb = this.makeCheckbox('seam', '接缝对齐连线', false, (on) => this.hooks.onToggleSeam(on));
    const lightCb = this.makeCheckbox('lightHelper', '显示光源方向', false, (on) =>
      this.hooks.onToggleLightHelper(on),
    );
    light.append(influenceCb, seamCb, lightCb);
    this.root.appendChild(light);

    const kf = document.createElement('section');
    kf.className = 'block';
    kf.innerHTML = '<h3>关键帧与时间轴</h3>';
    const capRow = document.createElement('div');
    capRow.className = 'btn-row';
    const capA = document.createElement('button');
    capA.textContent = '录为 A 帧';
    capA.onclick = () => this.hooks.onCapture(0);
    const capB = document.createElement('button');
    capB.textContent = '录为 B 帧';
    capB.onclick = () => this.hooks.onCapture(1);
    capRow.append(capA, capB);
    this.playBtn = document.createElement('button');
    this.playBtn.textContent = '▶ A↔B 往返播放';
    this.playBtn.onclick = () => {
      if (this.playBtn.dataset.playing === '1') this.hooks.onPause();
      else this.hooks.onPlay();
    };
    this.timeline = document.createElement('input');
    this.timeline.type = 'range';
    this.timeline.min = '0';
    this.timeline.max = '1';
    this.timeline.step = '0.001';
    this.timeline.value = '0';
    this.timeline.className = 'timeline';
    this.timeline.addEventListener('input', () => this.hooks.onScrub(Number(this.timeline.value)));
    const speed = this.makeSlider('speed', '播放速度 (t/秒)', 0.25, 0.02, 1.5, 0.01, (v) =>
      this.hooks.onSpeed(v),
    );
    kf.append(capRow, this.playBtn, this.timeline, speed);
    this.root.appendChild(kf);

    const io = document.createElement('section');
    io.className = 'block';
    io.innerHTML = '<h3>配置存取</h3>';
    const ioRow = document.createElement('div');
    ioRow.className = 'btn-row';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存 JSON';
    saveBtn.onclick = () => this.hooks.onSave();
    const loadBtn = document.createElement('button');
    loadBtn.textContent = '载入 JSON';
    loadBtn.onclick = () => document.getElementById('config-file')?.click();
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '重置全部';
    resetBtn.className = 'danger';
    resetBtn.onclick = () => this.hooks.onReset();
    ioRow.append(saveBtn, loadBtn, resetBtn);
    io.appendChild(ioRow);
    this.root.appendChild(io);
  }

  private emitLight() {
    const az = Number(this.sliders.get('lightAz')!.value);
    const el = Number(this.sliders.get('lightEl')!.value);
    this.hooks.onLightChange(az, el);
  }

  private makeSlider(
    key: string,
    label: string,
    initial: number,
    min: number,
    max: number,
    step: number,
    onInput: (v: number) => void,
  ): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    const head = document.createElement('span');
    head.className = 'slider-head';
    const name = document.createElement('span');
    name.textContent = label;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = initial.toFixed(2);
    head.append(name, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.dataset.key = key;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    input.addEventListener('input', () => {
      val.textContent = Number(input.value).toFixed(2);
      onInput(Number(input.value));
    });
    wrap.append(head, input);
    this.sliders.set(key, input);
    this.valueLabels.set(key, val);
    return wrap;
  }

  private makeCheckbox(key: string, label: string, initial: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
    const cb = document.createElement('label');
    cb.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.key = key;
    input.checked = initial;
    input.addEventListener('change', () => onChange(input.checked));
    cb.append(input, document.createTextNode(label));
    this.checkboxes.set(key, input);
    return cb;
  }

  /** 外部状态变化时回显滑杆(播放/载入/重置) */
  syncWeights(w: Weights) {
    for (const part of PARTS) {
      for (const t of TARGETS) {
        this.setSlider(`${part.id}.${t.id}`, w[part.id][t.id]);
      }
    }
    this.setSlider('hingeDeg', w.hingeDeg);
    this.setSlider('flex', w.flex);
  }

  setSlider(key: string, v: number) {
    const input = this.sliders.get(key);
    const label = this.valueLabels.get(key);
    if (!input) return;
    input.value = String(v);
    if (label) label.textContent = v.toFixed(2);
  }

  setTimeline(t: number) {
    this.timeline.value = String(t);
  }

  setPlaying(playing: boolean) {
    this.playBtn.dataset.playing = playing ? '1' : '0';
    this.playBtn.textContent = playing ? '⏸ 暂停' : '▶ A↔B 往返播放';
  }

  get influenceOn() {
    return this.checkboxes.get('influence')!.checked;
  }
  get seamOn() {
    return this.checkboxes.get('seam')!.checked;
  }
}
