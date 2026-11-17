/**
 * poses.ts —— 固定核对姿态
 *
 * 六个主轴朝向(从 ±X/±Y/±Z 看向原点)+ 默认透视 + 跨面边缘反射 +
 * 物体旋转前后对照。切换姿态时由 main.ts 同步更新相机、物体、检查点与高亮。
 */

import { vnorm, type Vec3 } from './facemath';

export interface Pose {
  id: string;
  label: string;
  hint: string;
  cameraPos: Vec3;
  /** 默认 (0,1,0),±Y 轴视图自动切换 */
  cameraUp: Vec3;
  /** 物体欧拉角(弧度,XYZ 顺序) */
  objectEuler: Vec3;
  /** 该姿态要放置的检查点(物体局部坐标 + 局部法线),空数组表示保持现状 */
  checkpoints: { localPoint: Vec3; localNormal: Vec3; note: string }[];
}

const AXIS_DIST = 5.2;

export const POSES: Pose[] = [
  {
    id: 'default',
    label: '默认透视',
    hint: '透视总览,环境固定、相机可自由转动',
    cameraPos: [4.2, 3.0, 4.6],
    cameraUp: [0, 1, 0],
    objectEuler: [0, 0, 0],
    checkpoints: [],
  },
  {
    id: 'view-px',
    label: '轴视 +X',
    hint: '从 +X 朝原点看,正对 +X 面中心',
    cameraPos: [AXIS_DIST, 0, 0],
    cameraUp: [0, 1, 0],
    objectEuler: [0, 0, 0],
    checkpoints: [],
  },
  {
    id: 'view-nx',
    label: '轴视 -X',
    cameraPos: [-AXIS_DIST, 0, 0],
    cameraUp: [0, 1, 0],
    hint: '从 -X 朝原点看,正对 -X 面中心',
    objectEuler: [0, 0, 0],
    checkpoints: [],
  },
  {
    id: 'view-py',
    label: '轴视 +Y',
    hint: '从上方俯视,+Y 面;相机上方向改用 -Z 保持约定',
    cameraPos: [0, AXIS_DIST, 0.001],
    cameraUp: [0, 0, -1],
    objectEuler: [0, 0, 0],
    checkpoints: [],
  },
  {
    id: 'view-ny',
    label: '轴视 -Y',
    hint: '从下方仰视 -Y 面;相机上方向改用 +Z',
    cameraPos: [0, -AXIS_DIST, 0.001],
    cameraUp: [0, 0, 1],
    objectEuler: [0, 0, 0],
    checkpoints: [],
  },
  {
    id: 'view-pz',
    label: '轴视 +Z',
    hint: '从 +Z 朝原点看,正对 +Z 面(展开图中心面)',
    cameraPos: [0, 0, AXIS_DIST],
    cameraUp: [0, 1, 0],
    objectEuler: [0, 0, 0],
    checkpoints: [],
  },
  {
    id: 'view-nz',
    label: '轴视 -Z',
    hint: '从 -Z 朝原点看,正对 -Z 面',
    cameraPos: [0, 0, -AXIS_DIST],
    cameraUp: [0, 1, 0],
    objectEuler: [0, 0, 0],
    checkpoints: [],
  },
  {
    id: 'seam',
    label: '跨面边缘反射',
    hint: '检查点反射方向指向 -X/-Z 共享棱附近,展开图同步高亮该棱两侧',
    cameraPos: [3.6, 0.55, 3.6],
    cameraUp: [0, 1, 0],
    objectEuler: [0, 0, 0],
    checkpoints: [
      {
        // 切角斜面上的点,法线 (1,0,1)/√2;低机位下入射近水平,
        // 反射 R 的 x、z 分量都为负且量级接近 —— 落在 -X/-Z 共享棱附近
        localPoint: [0.86, 0.2, -0.66],
        localNormal: vnorm([1, 0, 1]),
        note: '切角斜面:反射指向 -X/-Z 共享棱',
      },
    ],
  },
  {
    id: 'rotate-a',
    label: '旋转对照·前',
    hint: '记录当前检查点读数,再切到"旋转对照·后"比较',
    cameraPos: [3.2, 2.2, 4.0],
    cameraUp: [0, 1, 0],
    objectEuler: [0, 0, 0],
    checkpoints: [
      { localPoint: [0.86, 0.2, -0.66], localNormal: vnorm([1, 0, 1]), note: '对照前:斜面检查点' },
      { localPoint: [0, 0.9, 0], localNormal: [0, 1, 0], note: '对照前:顶面检查点' },
    ],
  },
  {
    id: 'rotate-b',
    label: '旋转对照·后',
    hint: '物体绕 Y 转 45°,相机不动;反射方向与命中面应随之变化',
    cameraPos: [3.2, 2.2, 4.0],
    cameraUp: [0, 1, 0],
    objectEuler: [0, Math.PI / 4, 0],
    checkpoints: [
      { localPoint: [0.86, 0.2, -0.66], localNormal: vnorm([1, 0, 1]), note: '对照后:同一斜面点' },
      { localPoint: [0, 0.9, 0], localNormal: [0, 1, 0], note: '对照后:同一点(顶面法线世界不变)' },
    ],
  },
];

export function poseById(id: string): Pose {
  return POSES.find((p) => p.id === id) ?? POSES[0];
}
