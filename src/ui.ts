import { PRESETS, type ParamSet } from './params';
import type { SceneLab, Side } from './sceneLab';

function el(tag: string, cls = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function slider(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(2),
): void {
  const row = el('div', 'row');
  const lab = el('label');
  const name = el('span');
  name.textContent = label;
  const val = el('b');
  val.textContent = fmt(get());
  lab.append(name, val);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(get());
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    set(v);
    val.textContent = fmt(v);
  });
  row.append(lab, input);
  parent.append(row);
}

function checkbox(
  parent: HTMLElement,
  label: string,
  get: () => boolean,
  set: (v: boolean) => void,
): void {
  const wrap = el('label', 'check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  const span = el('span');
  span.textContent = label;
  wrap.append(input, span);
  parent.append(wrap);
}

export class Panel {
  private readonly root: HTMLElement;
  private readonly lab: SceneLab;
  private refreshProbe: (() => void) | null = null;

  constructor(root: HTMLElement, lab: SceneLab) {
    this.root = root;
    this.lab = lab;
    this.build();
    lab.setProbeListener(() => this.refreshProbe?.());
    // 手柄拖动结束后重建面板，让位置/角度滑块回读最新值
    lab.setTransformEndListener(() => this.build());
  }

  private build(): void {
    this.root.innerHTML = '';
    const h = el('h1');
    h.textContent = '长条灯板光照实验室';
    this.root.append(h);
    const hint = el('div', 'hint');
    hint.textContent = '拖动彩色手柄移动灯板，按 W/E/R 切换移动/旋转/缩放；点击圆柱或平板放置探针。';
    this.root.append(hint);

    this.buildSideSwitch();
    this.buildPresets();
    this.buildLightSection();
    this.buildMaterialSection();
    this.buildPointSection();
    this.buildCompareSection();
    this.buildProbeSection();
    this.buildHelp();
  }

  private side(): Side {
    return this.lab.active;
  }

  private params(): ParamSet {
    return this.lab.getParams(this.side());
  }

  private patch(p: Partial<ParamSet>): void {
    this.lab.updateParams(this.side(), p);
  }

  private buildSideSwitch(): void {
    const sec = el('div');
    const seg = el('div', 'seg');
    const btnA = document.createElement('button');
    btnA.textContent = 'A 组参数';
    const btnB = document.createElement('button');
    btnB.textContent = 'B 组参数';
    const sync = () => {
      const a = this.lab.active === 'A';
      btnA.classList.toggle('active', a);
      btnB.classList.toggle('active', !a);
    };
    btnA.addEventListener('click', () => {
      this.lab.setActiveSide('A');
      sync();
      this.build();
    });
    btnB.addEventListener('click', () => {
      this.lab.setActiveSide('B');
      sync();
      this.build();
    });
    sync();
    seg.append(btnA, btnB);

    const copy = document.createElement('button');
    copy.textContent = '⇄ 复制当前侧到另一侧';
    copy.style.width = '100%';
    copy.addEventListener('click', () => {
      this.lab.copyToOtherSide();
      this.build();
    });
    sec.append(seg, copy);
    this.root.append(sec);
  }

  private buildPresets(): void {
    const sec = el('div');
    sec.append(this.sectionTitle('测试摆位（应用到当前侧）'));
    const grid = el('div', 'grid2');
    for (const preset of PRESETS) {
      const b = document.createElement('button');
      b.textContent = preset.label;
      b.title = preset.desc;
      b.addEventListener('click', () => {
        this.lab.applyPreset(this.side(), preset.build());
        this.build();
      });
      grid.append(b);
    }
    sec.append(grid);
    const note = el('div', 'note');
    note.textContent =
      '窄灯条与宽灯板使用相同中心、相同面亮度(nits)：宽度只改变灯在表面上的张角，从而改变反射斑的形状与边缘软硬度。';
    sec.append(note);
    this.root.append(sec);
  }

  private buildLightSection(): void {
    const sec = el('div');
    sec.append(this.sectionTitle('长方形灯'));
    const p = this.params();
    slider(sec, '灯板宽度 (m)', 0.02, 2.5, 0.01, () => p.width, (v) => this.patch({ width: v }));
    slider(sec, '灯板高度 (m)', 0.02, 1.2, 0.01, () => p.height, (v) => this.patch({ height: v }));
    slider(
      sec,
      p.constantLuminance ? '面亮度 (nits, cd/m²)' : '参考面亮度 (nits)',
      2,
      800,
      1,
      () => p.luminance,
      (v) => this.patch({ luminance: v }),
      (v) => v.toFixed(0),
    );
    checkbox(
      sec,
      '改尺寸时保持面亮度不变（推荐：对比灯宽）',
      () => p.constantLuminance,
      (v) => {
        this.patch({ constantLuminance: v });
        this.build();
      },
    );
    checkbox(
      sec,
      '保持总光通量近似不变（面积变 → 面亮度反推）',
      () => !p.constantLuminance,
      (v) => {
        this.patch({ constantLuminance: !v });
        this.build();
      },
    );
    slider(
      sec,
      '位置 X (m)',
      -3,
      3,
      0.01,
      () => p.position[0],
      (v) => {
        const pos = [...p.position] as [number, number, number];
        pos[0] = v;
        this.patch({ position: pos });
      },
    );
    slider(
      sec,
      '位置 Y (m)',
      0.05,
      4,
      0.01,
      () => p.position[1],
      (v) => {
        const pos = [...p.position] as [number, number, number];
        pos[1] = v;
        this.patch({ position: pos });
      },
    );
    slider(
      sec,
      '位置 Z (m)',
      -3,
      3,
      0.01,
      () => p.position[2],
      (v) => {
        const pos = [...p.position] as [number, number, number];
        pos[2] = v;
        this.patch({ position: pos });
      },
    );
    slider(
      sec,
      '俯仰角 (°) — 转到背面看照明消失',
      -180,
      180,
      1,
      () => p.rotationDeg[0],
      (v) => {
        const r = [...p.rotationDeg] as [number, number, number];
        r[0] = v;
        this.patch({ rotationDeg: r });
      },
      (v) => v.toFixed(0),
    );
    slider(
      sec,
      '偏航角 (°)',
      -180,
      180,
      1,
      () => p.rotationDeg[1],
      (v) => {
        const r = [...p.rotationDeg] as [number, number, number];
        r[1] = v;
        this.patch({ rotationDeg: r });
      },
      (v) => v.toFixed(0),
    );
    slider(
      sec,
      '翻滚角 (°)',
      -180,
      180,
      1,
      () => p.rotationDeg[2],
      (v) => {
        const r = [...p.rotationDeg] as [number, number, number];
        r[2] = v;
        this.patch({ rotationDeg: r });
      },
      (v) => v.toFixed(0),
    );
    this.root.append(sec);
  }

  private buildMaterialSection(): void {
    const sec = el('div');
    sec.append(this.sectionTitle('材质（两侧共用）'));
    const p = this.params();
    slider(
      sec,
      '粗糙金属粗糙度（圆柱）',
      0.02,
      1,
      0.01,
      () => p.metalRoughness,
      (v) => this.patch({ metalRoughness: v }),
    );
    slider(
      sec,
      '哑光板粗糙度（平板）',
      0.02,
      1,
      0.01,
      () => p.plateRoughness,
      (v) => this.patch({ plateRoughness: v }),
    );
    slider(
      sec,
      '环境补光（避免背面全黑）',
      0,
      0.5,
      0.01,
      () => p.ambient,
      (v) => this.patch({ ambient: v }),
    );
    this.root.append(sec);
  }

  private buildPointSection(): void {
    const sec = el('div');
    sec.append(this.sectionTitle('点光源（同场参照）'));
    const p = this.params();
    checkbox(sec, '开启点光源', () => p.pointOn, (v) => this.patch({ pointOn: v }));
    slider(
      sec,
      '点光强度 (cd)',
      0.5,
      200,
      0.5,
      () => p.pointIntensity,
      (v) => this.patch({ pointIntensity: v }),
      (v) => v.toFixed(1),
    );
    const axes: [string, number][] = [
      ['点光 X', 0],
      ['点光 Y', 1],
      ['点光 Z', 2],
    ];
    for (const [name, idx] of axes) {
      slider(
        sec,
        `${name} (m)`,
        -4,
        4,
        0.05,
        () => p.pointPosition[idx],
        (v) => {
          const pos = [...p.pointPosition] as [number, number, number];
          pos[idx] = v;
          this.patch({ pointPosition: pos });
        },
      );
    }
    const note = el('div', 'note');
    note.textContent =
      '点光按平方反比衰减(decay=2)，探针结果中 “点光占比” 可直接对比两种光源在同一点的贡献。';
    sec.append(note);
    this.root.append(sec);
  }

  private buildCompareSection(): void {
    const sec = el('div');
    sec.append(this.sectionTitle('并排对比 / 镜头与曝光'));
    const seg = el('div', 'seg');
    const single = document.createElement('button');
    single.textContent = '单视图';
    const split = document.createElement('button');
    split.textContent = '分屏 A | B';
    const syncMode = () => {
      // 从 lab 状态回读由外部按钮维护；这里用 DOM 标记
      const on = split.classList.contains('active');
      single.classList.toggle('active', !on);
    };
    single.classList.add('active');
    single.addEventListener('click', () => {
      this.lab.setSplit(false);
      split.classList.remove('active');
      single.classList.add('active');
      syncMode();
    });
    split.addEventListener('click', () => {
      this.lab.setSplit(true);
      single.classList.remove('active');
      split.classList.add('active');
      syncMode();
    });
    seg.append(single, split);
    sec.append(seg);

    slider(
      sec,
      '曝光 (EV 倍率)',
      0.1,
      4,
      0.05,
      () => this.lab.getExposure(),
      (v) => this.lab.setExposure(v),
    );
    checkbox(
      sec,
      '锁定镜头（禁用轨道旋转/平移）',
      () => this.lab.isCameraLocked(),
      (v) => {
        this.lab.setCameraLocked(v);
        this.build();
      },
    );
    const note = el('div', 'note');
    note.textContent =
      '分屏时两侧强制同一相机、同一曝光；锁定镜头后再切换 A/B 调灯，画面只有光照差异，没有视角差异。';
    sec.append(note);
    this.root.append(sec);
  }

  private buildProbeSection(): void {
    const sec = el('div');
    sec.append(this.sectionTitle('表面探针'));
    const holder = el('div');
    sec.append(holder);
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清除探针';
    clearBtn.style.width = '100%';
    clearBtn.addEventListener('click', () => this.lab.clearProbe());
    sec.append(clearBtn);
    this.root.append(sec);

    this.refreshProbe = () => {
      holder.innerHTML = '';
      if (!this.lab.hasProbe()) {
        const empty = el('div', 'hint');
        empty.textContent = '点击圆柱（金属）或平板（哑光）上的任意一点放置探针。';
        holder.append(empty);
        return;
      }
      const renderOne = (side: Side, tagCls: string): void => {
        const r = this.lab.probeResult(side);
        if (!r) return;
        const head = el('div', 'metric');
        const tag = el('span', `tag ${tagCls}`);
        tag.textContent = `${side} 侧探针 · ${r.surfaceLabel}（roughness ${r.roughness.toFixed(2)}）`;
        head.append(tag);
        holder.append(head);
        this.metric(holder, '接收辐照度 E', r.irradiance.toFixed(3), '相对单位（含灯板+点光+环境）');
        this.metric(holder, '反射到镜头亮度 L', r.reflectedLuminance.toFixed(3), '漫反射 + 镜面反射合计');
        this.metric(holder, '├ 镜面分量', r.specularLuminance.toFixed(3));
        this.metric(holder, '└ 漫反射分量', r.diffuseLuminance.toFixed(3));
        this.metric(
          holder,
          '反射斑估计 长 × 短',
          `${r.spotLong.toFixed(3)} × ${r.spotShort.toFixed(3)} m`,
          '灯板张角 + 粗糙度模糊的几何估计',
        );
        this.metric(holder, '灯板立体角', r.solidAngle.toFixed(4), 'sr');
        this.metric(holder, '入射角 / 距离', `${r.incidenceDeg.toFixed(1)}° / ${r.distance.toFixed(2)} m`);
        this.metric(holder, '点光贡献占比', `${(r.pointShare * 100).toFixed(1)} %`);
      };
      renderOne('A', 'a');
      renderOne('B', 'b');

      const pA = this.lab.getParams('A');
      const note = el('div', 'note');
      const ra = this.lab.probeResult('A');
      const rb = this.lab.probeResult('B');
      if (ra && rb) {
        const dL = rb.reflectedLuminance / Math.max(ra.reflectedLuminance, 1e-6);
        note.textContent = `B/A 亮度比 ${dL.toFixed(2)}；长斑比 ${(rb.spotLong / Math.max(ra.spotLong, 1e-6)).toFixed(2)}，短斑比 ${(rb.spotShort / Math.max(ra.spotShort, 1e-6)).toFixed(2)}。当前粗糙度：金属 ${pA.metalRoughness.toFixed(2)} / 哑光 ${pA.plateRoughness.toFixed(2)}。`;
      }
      holder.append(note);
    };
    this.refreshProbe();
  }

  private buildHelp(): void {
    const sec = el('div');
    sec.append(this.sectionTitle('操作说明'));
    const lines = [
      'W 移动手柄 / E 旋转手柄 / R 缩放（灯板尺寸请用滑块，避免非均匀缩放）',
      '把俯仰角转到 ±180° 附近，发光面背向物体，可见照明变化（背面不发光）',
      '灯宽缩到 0.02m 或灯贴近平板时，内置 5cm 安全间距与近裁剪面保证画面稳定',
      '先在单视图调好 A 组，再复制到 B 组只改灯宽，然后分屏比较反射斑',
    ];
    for (const t of lines) {
      const d = el('div', 'hint');
      d.textContent = '· ' + t;
      sec.append(d);
    }
    this.root.append(sec);
  }

  private metric(parent: HTMLElement, k: string, v: string, sub = ''): void {
    const m = el('div', 'metric');
    const key = el('div', 'k');
    key.textContent = k;
    const val = el('div', 'v');
    val.textContent = v;
    m.append(key, val);
    if (sub) {
      const s = el('div', 'sub');
      s.textContent = sub;
      m.append(s);
    }
    parent.append(m);
  }

  private sectionTitle(t: string): HTMLElement {
    const h = el('h2');
    h.textContent = t;
    return h;
  }
}
