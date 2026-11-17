import type { ProjectorParams, TransformSnapshot } from './decalMath';
import type { TargetType } from './targets';

/** 固定现场:一键载入预设参数,分别展示四类边界情况。 */
export interface Preset {
  id: string;
  label: string;
  description: string;
  targetType: TargetType;
  targetColor: string;
  targetTransform: TransformSnapshot;
  projector: ProjectorParams;
  decalColor: string;
  firstSurfaceOnly: boolean;
}

const identity = (): TransformSnapshot => ({
  position: [0, 0, 0],
  rotationEuler: [0, 0, 0],
  scale: [1, 1, 1],
});

export const PRESETS: Preset[] = [
  {
    id: 'side-clip',
    label: '① 侧边裁切',
    description:
      '投影机偏向立方体右上方,视锥左/下侧边界在正面中部把贴花沿直线裁断(贯穿纹理边界的斜纹被切开清晰可见),图案右侧越出立方体棱边的部分也不显示。',
    targetType: 'box',
    targetColor: '#5a7a9e',
    targetTransform: identity(),
    projector: { position: [0.4, 0.9, 4], lookAt: [1.1, 0.7, 0], fovDeg: 32, near: 1, far: 9 },
    decalColor: '#ff8c2a',
    firstSurfaceOnly: true,
  },
  {
    id: 'near-far-clip',
    label: '② 近远范围截断',
    description:
      '低面数曲面中心距离投影机约 4.0,近端 3.0 / 远端 3.8 只放行中间一段,贴花被近/远平面切成一个环带,带内可见文字与刻度碎片。',
    targetType: 'sphere',
    targetColor: '#7a9e5a',
    targetTransform: identity(),
    projector: { position: [0, 0.3, 4], lookAt: [0, 0, 0], fovDeg: 42, near: 3.0, far: 3.8 },
    decalColor: '#ffd23e',
    firstSurfaceOnly: true,
  },
  {
    id: 'backface-reject',
    label: '③ 背面拒绝',
    description:
      '投影机位于平面后方,平面法线背向投影机,默认接收规则(仅接收朝向投影器的表面)下不出现任何贴花;可移动投影器到 +Z 一侧对照。',
    targetType: 'plane',
    targetColor: '#9e7a5a',
    targetTransform: identity(),
    projector: { position: [0, 0.6, -4], lookAt: [0, 0, 0], fovDeg: 38, near: 1, far: 9 },
    decalColor: '#e05a8c',
    firstSurfaceOnly: true,
  },
  {
    id: 'front-back-occlusion',
    label: '④ 前后面遮挡',
    description:
      '同一目标的前后两个叠放面(前小后大)。首表面规则开启时,后层被前层挡住的区域不接收贴花,后层贴花出现一个方形缺口;关闭开关可对照后层也接收的效果(从侧面视角观察)。',
    targetType: 'doublePlane',
    targetColor: '#6a8a7a',
    targetTransform: identity(),
    projector: { position: [0, 0.4, 4], lookAt: [0, 0, 0], fovDeg: 34, near: 1, far: 10 },
    decalColor: '#4ac0e0',
    firstSurfaceOnly: true,
  },
];
