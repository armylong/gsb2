import type { SceneModel } from './types';
import { rotation, translation, multiply } from '../geometry/matrix';
import {
  blobPath,
  holedSquarePath,
  maskPlateAPath,
  maskPlateBPath,
  overlappingCirclesPath,
  starPath,
} from '../samples/paths';

export function defaultScene(): SceneModel {
  return {
    contentMatrix: multiply(translation(-30, 30), rotation(-0.12)),
    shapes: [
      {
        id: 'blob',
        label: '曲线图形 (nonzero)',
        path: blobPath(),
        rule: 'nonzero',
        color: '#3b82f6',
        z: 1,
      },
      {
        id: 'star',
        label: '自交五角星 (evenodd)',
        path: starPath(120, -90, 78),
        rule: 'evenodd',
        color: '#f59e0b',
        z: 2,
      },
      {
        id: 'overlap',
        label: '重叠双圆 (evenodd)',
        path: overlappingCirclesPath(),
        rule: 'evenodd',
        color: '#8b5cf6',
        z: 3,
      },
    ],
    masks: {
      A: {
        key: 'A',
        label: '父遮罩 A',
        path: maskPlateAPath(),
        rule: 'nonzero',
        matrix: translation(-20, 0),
        color: '#0ea5e9',
      },
      B: {
        key: 'B',
        label: '子遮罩 B',
        path: maskPlateBPath(),
        rule: 'nonzero',
        // B 的局部坐标 -> A 的局部坐标; 初始带位移和旋转, 验证嵌套跟随
        matrix: multiply(translation(130, -70), rotation(0.4)),
        color: '#f97316',
      },
    },
  };
}

/**
 * 填充规则陷阱样例: 方块的外框和内孔同方向。
 * - nonzero: 内孔被重新填满(实心方块)
 * - evenodd: 内孔仍然镂空
 * 一键切换规则就能看到差异, 用于核对实现是否正确。
 */
export function trapScene(): SceneModel {
  const scene = defaultScene();
  scene.shapes = [
    {
      id: 'trap',
      label: '同向内孔方块 (切换规则看变化)',
      path: holedSquarePath(true),
      rule: 'nonzero',
      color: '#ef4444',
      z: 1,
    },
  ];
  scene.contentMatrix = translation(-60, 0);
  scene.masks.A.matrix = translation(0, 0);
  scene.masks.B.matrix = multiply(translation(150, -90), rotation(0.35));
  return scene;
}
