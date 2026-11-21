/** 观察条件预设：完整描述一次可复现的观察（相机姿态 + 两块样片参数 + 照明）。 */

export interface SampleState {
  thicknessNm: number;
  gradientOn: boolean;
  gradientSpanNm: number;
  filmOn: boolean;
}

export interface ViewPreset {
  name: string;
  camera: { pos: [number, number, number]; target: [number, number, number] };
  light: { azimuthDeg: number; elevationDeg: number; fixed: boolean };
  samples: [SampleState, SampleState]; // [弧面, 平片]
}

const s = (thicknessNm: number, gradientOn = false, gradientSpanNm = 400, filmOn = true): SampleState => ({
  thicknessNm,
  gradientOn,
  gradientSpanNm,
  filmOn,
});

/** 内置对照片：同膜厚不同视角、同视角不同膜厚、渐变对照、底层对照。 */
export const BUILTIN_PRESETS: ViewPreset[] = [
  {
    name: '正视 · 双片 500nm',
    camera: { pos: [0, 1.1, 5.4], target: [0, 0.8, 0] },
    light: { azimuthDeg: 35, elevationDeg: 55, fixed: true },
    samples: [s(500), s(500)],
  },
  {
    name: '斜视 · 双片 500nm（同膜厚换角度）',
    camera: { pos: [4.6, 1.0, 1.6], target: [0, 0.8, 0] },
    light: { azimuthDeg: 35, elevationDeg: 55, fixed: true },
    samples: [s(500), s(500)],
  },
  {
    name: '正视 · 双片 350nm（同角度换膜厚）',
    camera: { pos: [0, 1.1, 5.4], target: [0, 0.8, 0] },
    light: { azimuthDeg: 35, elevationDeg: 55, fixed: true },
    samples: [s(350), s(350)],
  },
  {
    name: '正视 · 双片 700nm（同角度换膜厚）',
    camera: { pos: [0, 1.1, 5.4], target: [0, 0.8, 0] },
    light: { azimuthDeg: 35, elevationDeg: 55, fixed: true },
    samples: [s(700), s(700)],
  },
  {
    name: '弧面渐变 300→900nm · 平片 500nm',
    camera: { pos: [-2.2, 1.5, 4.6], target: [-0.6, 0.8, 0] },
    light: { azimuthDeg: 20, elevationDeg: 60, fixed: true },
    samples: [s(300, true, 600), s(500)],
  },
  {
    name: '裸基底对照（膜厚 0）',
    camera: { pos: [0, 1.1, 5.4], target: [0, 0.8, 0] },
    light: { azimuthDeg: 35, elevationDeg: 55, fixed: true },
    samples: [s(0, false, 400, false), s(0, false, 400, false)],
  },
];

const STORAGE_KEY = 'thin-film-viewer.presets.v1';

export function loadUserPresets(): ViewPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as ViewPreset[]) : [];
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: ViewPreset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}
