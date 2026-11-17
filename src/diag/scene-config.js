// 场景布局、参数预设与视角预设（纯数据，测试与 UI 共用）

export const GROUND_SIZE = 40;

// 物体分布：沿纵深排列，近处分体小物（看接触阴影/脱离），远处高塔（看远平面消失）
export const OBJECT_DEFS = [
  { id: 'box', kind: 'box', label: '立方体', position: [-6, 1, 4], size: [2, 2, 2], color: 0x6aa7ff },
  { id: 'sphere', kind: 'sphere', label: '球体', position: [-2.5, 1.1, 3], radius: 1.1, color: 0xffb35c },
  { id: 'cylinder', kind: 'cylinder', label: '圆柱', position: [1.5, 1.4, 4], radius: 0.9, height: 2.8, color: 0x7ddc87 },
  { id: 'cone', kind: 'cone', label: '圆锥', position: [5, 1.6, 3.5], radius: 1.3, height: 3.2, color: 0xd98cff },
  { id: 'torus', kind: 'torus', label: '圆环', position: [-5, 0.7, -1], radius: 1.1, tube: 0.42, color: 0xff7d9c },
  { id: 'small1', kind: 'box', label: '小方块 A', position: [-1.2, 0.35, -0.5], size: [0.7, 0.7, 0.7], color: 0x9fd3ff },
  { id: 'small2', kind: 'cylinder', label: '小圆柱 B', position: [0.4, 0.5, -1.4], radius: 0.35, height: 1, color: 0xb6f0bb },
  { id: 'capsule', kind: 'capsule', label: '斜坡块', position: [4, 0.75, -1.5], radius: 0.75, length: 1.5, color: 0xffe08a },
  { id: 'tower', kind: 'box', label: '远处高塔', position: [8, 5, -12], size: [2.5, 10, 2.5], color: 0x8fb4e8 },
  { id: 'pillar', kind: 'cylinder', label: '远处细柱', position: [-9, 3, -10], radius: 0.7, height: 6, color: 0xc9a27e },
];

// 包围球半径（与 three 几何体保持一致，供诊断引擎使用）
export function objectRadius(def) {
  switch (def.kind) {
    case 'box':
      return Math.hypot(...def.size) / 2;
    case 'sphere':
      return def.radius;
    case 'cylinder':
    case 'cone':
      return Math.hypot(def.radius, def.height / 2);
    case 'torus':
      return def.radius + def.tube;
    case 'capsule':
      return def.radius + def.length / 2;
    default:
      return 1;
  }
}

export const DEFAULT_PARAMS = {
  azimuth: -35, // 度，水平方向角
  elevation: 42, // 度，仰角
  orthoSize: 40,
  near: 18,
  far: 80,
  mapSize: 2048,
  bias: -0.0008,
  normalBias: 0.03,
};

// 控件元数据：key / 中文名 / 范围 / 步长 / 单位 / 分组
export const PARAM_META = [
  { key: 'orthoSize', label: '阴影覆盖范围', group: 'coverage', min: 4, max: 80, step: 0.5, unit: '单位' },
  { key: 'near', label: '阴影近平面 near', group: 'coverage', min: 0.5, max: 40, step: 0.5, unit: '单位' },
  { key: 'far', label: '阴影远平面 far', group: 'coverage', min: 10, max: 160, step: 1, unit: '单位' },
  { key: 'mapSize', label: '阴影贴图尺寸', group: 'resolution', min: 256, max: 4096, step: 256, unit: 'px', pow2: true },
  { key: 'bias', label: '深度偏移 bias', group: 'bias', min: -0.02, max: 0.002, step: 0.0001, unit: '', digits: 4 },
  { key: 'normalBias', label: '法向偏移 normalBias', group: 'bias', min: 0, max: 0.4, step: 0.005, unit: '单位', digits: 3 },
  { key: 'azimuth', label: '光源方位角', group: 'light', min: -90, max: 90, step: 1, unit: '°' },
  { key: 'elevation', label: '光源仰角', group: 'light', min: 10, max: 80, step: 1, unit: '°' },
];

// 现象预设：一键复现各类阴影问题
export const PARAM_PRESETS = [
  {
    id: 'baseline',
    label: '基线（较均衡）',
    params: { ...DEFAULT_PARAMS },
    note: '覆盖、偏移与清晰度的折中起点。',
  },
  {
    id: 'acne',
    label: '阴影条纹（bias≈0）',
    params: { ...DEFAULT_PARAMS, bias: 0, normalBias: 0, orthoSize: 56, mapSize: 512 },
    note: 'bias 归零且 texel 偏大，斜面与地面出现规则条纹。',
  },
  {
    id: 'peter',
    label: '阴影脱离（偏移过大）',
    params: { ...DEFAULT_PARAMS, bias: -0.012, normalBias: 0.25 },
    note: '小物体根部与阴影之间出现明显缝隙。',
  },
  {
    id: 'smallcover',
    label: '覆盖不足（正交框太小）',
    params: { ...DEFAULT_PARAMS, orthoSize: 10 },
    note: '框外物体阴影突然消失，地面覆盖区线框可直接看到。',
  },
  {
    id: 'farclip',
    label: '远处阴影消失（far 太小）',
    params: { ...DEFAULT_PARAMS, near: 14, far: 18 },
    note: '深度区间仅 4 单位，背光侧物体越过远平面，远处阴影被裁掉。',
  },
  {
    id: 'lowres',
    label: '低清晰度（大框+小贴图）',
    params: { ...DEFAULT_PARAMS, orthoSize: 60, mapSize: 512 },
    note: 'texel≈0.12，阴影边缘呈块状锯齿。',
  },
];

export const VIEW_PRESETS = [
  {
    id: 'perspective',
    label: '透视全景',
    position: [16, 12, 20],
    target: [0, 1.5, -3],
  },
  {
    id: 'contact',
    label: '接地特写',
    position: [2.2, 1.6, 4.2],
    target: [-0.6, 0.4, -1],
  },
  {
    id: 'far',
    label: '远眺（看远阴影）',
    position: [6, 5, 14],
    target: [4, 2.5, -11],
  },
  {
    id: 'top',
    label: '俯视（看覆盖区）',
    position: [0.5, 34, 0.5],
    target: [0, 0, 0],
  },
];

export const DEFAULT_VIEW = VIEW_PRESETS[0];

/** 由方位角/仰角计算指向光目标的方向向量 */
export function lightDirection(azimuthDeg, elevationDeg) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  return [ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)];
}
