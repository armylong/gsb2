/** 全局共享类型与默认参数 */

export type SceneId = 'corner' | 'sphere' | 'cubes';
export type ViewMode = 'off' | 'on' | 'gray';
export type LayoutMode = ViewMode | 'split';
export type SmoothLevel = 'off' | 'standard' | 'high';

export interface SSAOParams {
  radius: number;
  intensity: number;
  depthBias: number;
  smooth: SmoothLevel;
  gap: number;
}

export interface AppState {
  scene: SceneId;
  layout: LayoutMode;
  leftMode: ViewMode;
  rightMode: ViewMode;
  split: number; // 0.15 ~ 0.85
  params: SSAOParams;
}

export const DEFAULT_STATE: AppState = {
  scene: 'sphere',
  layout: 'split',
  leftMode: 'off',
  rightMode: 'on',
  split: 0.5,
  params: {
    radius: 8,
    intensity: 1,
    depthBias: 0.02,
    smooth: 'standard',
    gap: 0.1,
  },
};

/** 固定验证观察点（所有场景共用的相机位姿，restoreViewpoint 也用它） */
export const VERIFY_VIEW = {
  position: [7.2, 5.4, 9.6] as const,
  target: [0, 1.2, 0] as const,
};

export const MODE_LABEL: Record<ViewMode, string> = {
  off: '关闭遮蔽（原始光照）',
  on: '开启遮蔽',
  gray: '遮蔽灰度图',
};
