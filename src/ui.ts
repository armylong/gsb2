import { SceneApp, SceneSnapshot, Mode, PoseVerification } from './SceneApp';
import {
  ArmParams,
  JointAngles,
  Vec3,
  maxReach,
} from './kinematics';
import {
  DEFAULT_PARAMS,
  DEFAULT_ANGLES,
  DEFAULT_BASE,
  KNOWN_POSES,
  buildDemos,
} from './config';

const REASON_TEXT: Record<string, string> = {
  reached: '已到达（误差 ≤ 5 mm 容差）',
  'too-far': '未到达：目标超出连杆总长度',
  limited: '未到达：受关节角度限制',
  'near-axis': '未到达：目标位于底座轴线上，偏航无解',
  manual: '手动模式：关节角度由滑块直接设定，未运行 IK',
};

const fmt = (n: number, d = 3) =>
  (n >= 0 ? ' ' : '') + n.toFixed(d);

export function buildUI(
  panel: HTMLElement,
  scene: SceneApp
): void {
  let params: ArmParams = structuredClone(DEFAULT_PARAMS);

  const h = (tag: string, className = '') => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  };

  const section = (title: string, id?: string): HTMLElement => {
    const s = h('section', 'panel-section');
    if (id) s.dataset.section = id;
    const t = h('h3');
    t.textContent = title;
    s.appendChild(t);
    panel.appendChild(s);
    return s;
  };

  // ------------------------------------------------------------ status
  const secStatus = section('运行状态', 'status');
  const statusMode = h('div', 'status-line');
  const statusReach = h('div', 'status-line reach-ok');
  const endPos = h('div', 'mono');
  const targetPos = h('div', 'mono');
  const residualEl = h('div', 'mono');
  secStatus.append(statusMode, statusReach, endPos, targetPos, residualEl);

  // ------------------------------------------------------------ mode
  const secMode = section('控制模式', 'mode');
  const modeRow = h('div', 'btn-row');
  const btnFollow = h('button');
  btnFollow.textContent = '目标跟随（IK）';
  const btnManual = h('button');
  btnManual.textContent = '手动关节角度';
  modeRow.append(btnFollow, btnManual);
  secMode.appendChild(modeRow);

  // ------------------------------------------------------------ joints
  const secJoints = section('关节角度（局部，单位 °）', 'joints');
  const jointDefs: { key: keyof JointAngles; label: string; axis: string }[] = [
    { key: 'q1', label: 'J1 偏航', axis: '绕 Y 轴' },
    { key: 'q2', label: 'J2 肩部俯仰', axis: '绕局部 Z 轴' },
    { key: 'q3', label: 'J3 肘部俯仰', axis: '绕局部 Z 轴' },
    { key: 'q4', label: 'J4 腕部俯仰', axis: '绕局部 Z 轴' },
  ];
  const jointSliders = new Map<keyof JointAngles, HTMLInputElement>();
  const jointValues = new Map<keyof JointAngles, HTMLSpanElement>();
  const jointRangeLabels = new Map<keyof JointAngles, HTMLSpanElement>();

  for (const def of jointDefs) {
    const row = h('div', 'joint-row');
    const head = h('div', 'joint-head');
    const name = h('span');
    name.textContent = `${def.label}（${def.axis}）`;
    const val = h('span', 'val');
    const slider = h('input') as HTMLInputElement;
    slider.type = 'range';
    const rangeLabel = h('div', 'range-label');
    head.append(name, val);
    row.append(head, slider, rangeLabel);
    secJoints.appendChild(row);
    jointSliders.set(def.key, slider);
    jointValues.set(def.key, val);
    jointRangeLabels.set(def.key, rangeLabel);

    slider.addEventListener('input', () => {
      const a = scene.getSnapshot().angles;
      a[def.key] = parseFloat(slider.value);
      scene.setManualAngles(a); // dragging a joint explicitly enters manual mode
    });
  }

  function syncJointRanges(p: ArmParams): void {
    for (const def of jointDefs) {
      const lim = p.limits[def.key];
      const slider = jointSliders.get(def.key)!;
      slider.min = String(lim.min);
      slider.max = String(lim.max);
      slider.step = '0.5';
      jointRangeLabels.get(def.key)!.textContent = `范围 [${lim.min}°, ${lim.max}°]`;
    }
  }

  // ------------------------------------------------------------ arm params
  const secParams = section('连杆长度与关节范围', 'params');
  const lengthInputs = new Map<string, HTMLInputElement>();
  const totalLenLabel = h('div', 'hint');
  for (const key of ['link1', 'link2', 'link3'] as const) {
    const row = h('div', 'input-row');
    const label = h('label');
    label.textContent = `${key} 长度 (m)`;
    const input = h('input') as HTMLInputElement;
    input.type = 'number';
    input.step = '0.05';
    input.min = '0.1';
    input.max = '3';
    row.append(label, input);
    secParams.appendChild(row);
    lengthInputs.set(key, input);
  }
  secParams.appendChild(totalLenLabel);

  const limitInputs = new Map<string, HTMLInputElement>();
  for (const def of jointDefs) {
    const row = h('div', 'input-row');
    const label = h('label');
    label.textContent = `${def.key} 最小/最大 (°)`;
    const pair = h('div', 'pair');
    const minI = h('input') as HTMLInputElement;
    const maxI = h('input') as HTMLInputElement;
    minI.type = 'number';
    maxI.type = 'number';
    minI.step = '5';
    maxI.step = '5';
    pair.append(minI, maxI);
    row.append(label, pair);
    secParams.appendChild(row);
    limitInputs.set(`${def.key}.min`, minI);
    limitInputs.set(`${def.key}.max`, maxI);
  }
  const btnApplyParams = h('button', 'primary');
  btnApplyParams.textContent = '应用连杆/范围参数';
  secParams.appendChild(btnApplyParams);

  function fillParamInputs(p: ArmParams): void {
    (['link1', 'link2', 'link3'] as const).forEach((k) => {
      lengthInputs.get(k)!.value = String(p[k]);
    });
    jointDefs.forEach((def) => {
      limitInputs.get(`${def.key}.min`)!.value = String(p.limits[def.key].min);
      limitInputs.get(`${def.key}.max`)!.value = String(p.limits[def.key].max);
    });
    totalLenLabel.textContent = `当前总臂长 L1+L2+L3 = ${maxReach(p).toFixed(2)} m`;
  }

  btnApplyParams.addEventListener('click', () => {
    const next = structuredClone(params);
    (['link1', 'link2', 'link3'] as const).forEach((k) => {
      const n = parseFloat(lengthInputs.get(k)!.value);
      if (Number.isFinite(n) && n >= 0.1 && n <= 3) next[k] = n;
    });
    let valid = true;
    jointDefs.forEach((def) => {
      const lo = parseFloat(limitInputs.get(`${def.key}.min`)!.value);
      const hi = parseFloat(limitInputs.get(`${def.key}.max`)!.value);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        valid = false;
        return;
      }
      next.limits[def.key] = { min: lo, max: hi };
    });
    if (!valid) {
      alert('关节范围无效：最小值必须小于最大值');
      return;
    }
    params = next;
    syncJointRanges(params);
    scene.setParams(params);
  });

  // ------------------------------------------------------------ target
  const secTarget = section('目标位置（世界坐标，单位 m）', 'target');
  const targetInputs = new Map<'x' | 'y' | 'z', HTMLInputElement>();
  const targetRow = h('div', 'input-row');
  (['x', 'y', 'z'] as const).forEach((axis) => {
    const wrap = h('div', 'pair');
    const label = h('label');
    label.textContent = axis.toUpperCase();
    const input = h('input') as HTMLInputElement;
    input.type = 'number';
    input.step = '0.05';
    wrap.append(label, input);
    targetRow.appendChild(wrap);
    targetInputs.set(axis, input);
  });
  const btnSetTarget = h('button', 'primary');
  btnSetTarget.textContent = '设置目标';
  secTarget.append(targetRow, btnSetTarget);

  function readTargetInputs(): Vec3 | null {
    const t: Vec3 = { x: 0, y: 0, z: 0 };
    for (const axis of ['x', 'y', 'z'] as const) {
      const n = parseFloat(targetInputs.get(axis)!.value);
      if (!Number.isFinite(n)) return null;
      t[axis] = n;
    }
    return t;
  }
  btnSetTarget.addEventListener('click', () => {
    const t = readTargetInputs();
    if (t) scene.setTargetWorld(t);
  });
  targetRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSetTarget.click();
  });

  const planeHint = h('div', 'hint');
  planeHint.textContent = '提示：可直接在 3D 视图中拖动青色目标球；拖动机械臂底座可平移底座。';
  secTarget.appendChild(planeHint);

  const planeRow = h('div', 'input-row');
  const planeLabel = h('label');
  planeLabel.textContent = '目标拖动平面';
  const planeSelect = h('select') as HTMLSelectElement;
  planeSelect.innerHTML =
    '<option value="camera">平行屏幕（相机平面）</option><option value="ground">水平地面（固定高度）</option>';
  planeRow.append(planeLabel, planeSelect);
  secTarget.appendChild(planeRow);
  planeSelect.addEventListener('change', () =>
    scene.setDragPlaneMode(planeSelect.value as 'camera' | 'ground')
  );

  // ------------------------------------------------------------ base
  const secBase = section('底座变换（目标坐标始终为世界坐标）', 'base');
  const baseInputs = new Map<'x' | 'z' | 'yaw', HTMLInputElement>();
  const baseDefs: { key: 'x' | 'z' | 'yaw'; label: string; step: string }[] = [
    { key: 'x', label: '底座位置 X (m)', step: '0.05' },
    { key: 'z', label: '底座位置 Z (m)', step: '0.05' },
    { key: 'yaw', label: '底座整体旋转 Yaw (°)', step: '5' },
  ];
  for (const d of baseDefs) {
    const row = h('div', 'input-row');
    const label = h('label');
    label.textContent = d.label;
    const input = h('input') as HTMLInputElement;
    input.type = 'number';
    input.step = d.step;
    row.append(label, input);
    secBase.appendChild(row);
    baseInputs.set(d.key, input);
  }
  const btnApplyBase = h('button', 'primary');
  btnApplyBase.textContent = '应用底座变换';
  secBase.appendChild(btnApplyBase);
  btnApplyBase.addEventListener('click', () => {
    const snap = scene.getSnapshot();
    const x = parseFloat(baseInputs.get('x')!.value);
    const z = parseFloat(baseInputs.get('z')!.value);
    const yaw = parseFloat(baseInputs.get('yaw')!.value);
    if ([x, z, yaw].some((n) => !Number.isFinite(n))) return;
    scene.setBasePosition({ ...snap.base.position, x, z });
    scene.setBaseYaw(yaw);
  });

  // ------------------------------------------------------------ display
  const secDisplay = section('显示选项', 'display');
  const checkboxes: { id: string; label: string; fn: (v: boolean) => void; def: boolean }[] = [
    { id: 'ax-joint', label: '关节轴箭头', fn: (v) => scene.setJointAxesVisible(v), def: true },
    { id: 'ax-local', label: '底座局部坐标轴', fn: (v) => scene.setLocalAxesVisible(v), def: true },
    { id: 'ax-world', label: '世界坐标轴（原点）', fn: (v) => scene.setWorldAxesVisible(v), def: true },
    { id: 'labels', label: '文字标注', fn: (v) => scene.setLabelsVisible(v), def: true },
  ];
  for (const c of checkboxes) {
    const row = h('label', 'check-row');
    const cb = h('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = c.def;
    cb.addEventListener('change', () => c.fn(cb.checked));
    const span = h('span');
    span.textContent = c.label;
    row.append(cb, span);
    secDisplay.appendChild(row);
  }

  // ------------------------------------------------------------ known poses
  const secPoses = section('已知姿态验证（独立 FK 三方互验）', 'poses');
  const poseHint = h('div', 'hint');
  poseHint.textContent =
    '期望值由显式三角公式 FK 计算，实际值直接读取 three.js 世界矩阵，两者代码路径完全独立。';
  secPoses.appendChild(poseHint);
  const poseResult = h('div', 'pose-result');
  poseResult.style.display = 'none';
  for (const pose of KNOWN_POSES) {
    const b = h('button');
    b.dataset.poseId = pose.id;
    b.textContent = pose.name;
    b.title = pose.description;
    b.addEventListener('click', () => {
      const r: PoseVerification = scene.applyKnownPose(pose.angles, pose.base);
      poseResult.style.display = 'block';
      const vec = (p: Vec3) => `(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})`;
      poseResult.innerHTML = `
        <div class="pose-name">${pose.name}</div>
        <div class="hint">${pose.description}</div>
        <table>
          <tr><td>期望末端（显式三角 FK + 底座刚体变换）</td><td class="mono">${vec(r.expected)}</td></tr>
          <tr><td>组合 FK 结果（帧嵌套公式）</td><td class="mono">${vec(r.composed)}</td></tr>
          <tr><td>实际末端（three.js 场景图世界矩阵）</td><td class="mono">${vec(r.actual)}</td></tr>
          <tr><td>期望 vs 实际 误差</td><td class="mono">${r.errorExpectedActual.toExponential(2)} m</td></tr>
          <tr><td>组合 FK vs 实际 误差</td><td class="mono">${r.errorComposedActual.toExponential(2)} m</td></tr>
        </table>`;
      fillBaseInputs(scene.getSnapshot());
    });
    secPoses.appendChild(b);
  }
  secPoses.appendChild(poseResult);

  // ------------------------------------------------------------ demos
  const secDemos = section('演示入口', 'demos');
  const demos = buildDemos(maxReach(params));
  for (const d of demos) {
    const b = h('button');
    b.textContent = d.name;
    b.title = d.description;
    b.addEventListener('click', () => {
      if (d.id === 'cross-side') {
        scene.startCrossSide();
      } else {
        scene.setTargetWorld(d.target);
      }
    });
    secDemos.appendChild(b);
    const desc = h('div', 'hint');
    desc.textContent = d.description;
    secDemos.appendChild(desc);
  }
  const btnStopDemo = h('button');
  btnStopDemo.textContent = '停止跨侧脚本';
  btnStopDemo.addEventListener('click', () => scene.stopScripted());
  const btnReset = h('button', 'danger');
  btnReset.textContent = '一键回到初始状态';
  const demoRow = h('div', 'btn-row');
  demoRow.append(btnStopDemo, btnReset);
  secDemos.appendChild(demoRow);

  btnReset.addEventListener('click', () => {
    params = structuredClone(DEFAULT_PARAMS);
    fillParamInputs(params);
    syncJointRanges(params);
    scene.setParams(params);
    scene.setManualAngles({ ...DEFAULT_ANGLES });
    scene.setBasePosition({ ...DEFAULT_BASE.position });
    scene.setBaseYaw(DEFAULT_BASE.yawDeg);
    scene.setTargetWorld({ x: 1.2, y: 0.67, z: 0.35 });
    scene.setMode('follow' as Mode);
    fillBaseInputs(scene.getSnapshot());
    poseResult.style.display = 'none';
  });

  // ------------------------------------------------------------ snapshot sync
  function fillBaseInputs(snap: SceneSnapshot): void {
    const bx = baseInputs.get('x')!;
    const bz = baseInputs.get('z')!;
    const by = baseInputs.get('yaw')!;
    if (document.activeElement !== bx) bx.value = snap.base.position.x.toFixed(2);
    if (document.activeElement !== bz) bz.value = snap.base.position.z.toFixed(2);
    if (document.activeElement !== by) by.value = snap.base.yawDeg.toFixed(1);
  }

  function sync(snap: SceneSnapshot): void {
    statusMode.textContent =
      `模式：${snap.mode === 'follow' ? '目标跟随（IK，热启动保持上一姿态）' : '手动关节角度'}` +
      (snap.scriptedRunning ? '　｜　跨侧脚本运行中' : '');
    statusReach.textContent = REASON_TEXT[snap.reason] ?? snap.reason;
    statusReach.className =
      'status-line ' + (snap.reached ? 'reach-ok' : 'reach-bad');
    endPos.textContent = `当前末端（世界）: (${fmt(snap.endWorld.x)}, ${fmt(snap.endWorld.y)}, ${fmt(snap.endWorld.z)}) m`;
    targetPos.textContent = `目标位置（世界）: (${fmt(snap.targetWorld.x)}, ${fmt(snap.targetWorld.y)}, ${fmt(snap.targetWorld.z)}) m`;
    residualEl.textContent = `末端-目标距离（残余）: ${snap.residual.toFixed(4)} m`;

    for (const def of jointDefs) {
      const slider = jointSliders.get(def.key)!;
      const val = jointValues.get(def.key)!;
      val.textContent = `${snap.angles[def.key].toFixed(1)}°`;
      if (document.activeElement !== slider) {
        slider.value = String(snap.angles[def.key]);
      }
    }
    for (const axis of ['x', 'y', 'z'] as const) {
      const input = targetInputs.get(axis)!;
      if (document.activeElement !== input) {
        input.value = snap.targetWorld[axis].toFixed(2);
      }
    }
    fillBaseInputs(snap);

    btnFollow.classList.toggle('active', snap.mode === 'follow');
    btnManual.classList.toggle('active', snap.mode === 'manual');
  }

  btnFollow.addEventListener('click', () => scene.setMode('follow'));
  btnManual.addEventListener('click', () => scene.setMode('manual'));

  // initial population
  fillParamInputs(params);
  syncJointRanges(params);
  scene.onChange = sync;
  sync(scene.getSnapshot());
}
