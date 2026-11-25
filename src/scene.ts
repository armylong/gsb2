/**
 * 场景预设与质量档位。
 * 默认房间 12m × 8m，内置：
 *  - 红墙亮角：左下角落被竖向隔板挡住灯光，但能看到一段被灯照亮的红墙；
 *  - 双层挡板暗角：右下角到灯之间有两道错开的竖向挡板。
 */
import type { QualitySpec, World } from './types.js';
import { hexToRgb } from './geometry.js';

export const QUALITY_SPECS: Record<'quick' | 'dense', QualitySpec> = {
  quick: {
    key: 'quick',
    label: '快预览',
    floorRays: 240,
    lampSamples: 16,
    grid: 0.25,
  },
  dense: {
    key: 'dense',
    label: '密集取样',
    floorRays: 540,
    lampSamples: 48,
    grid: 0.1,
  },
};

const W = (
  id: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  hex: string,
  enabled = true,
) => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, color: hexToRgb(hex), enabled });

/** 默认实验场景 */
export function createDefaultWorld(): World {
  const room = { x: 0, y: 0, w: 12, h: 8 };
  const offWhite = '#e8e2d6';
  const red = '#c0392b';
  const gray = '#9aa0a6';

  const walls = [
    // 外墙：长边拆成两段，便于单独开关/改色
    W('wall-top-1', 0, 0, 6, 0, offWhite),
    W('wall-top-2', 6, 0, 12, 0, offWhite),
    W('wall-right-1', 12, 0, 12, 4, offWhite),
    W('wall-right-2', 12, 4, 12, 8, offWhite),
    W('wall-bottom-1', 12, 8, 6, 8, offWhite),
    W('wall-bottom-2', 6, 8, 0, 8, offWhite),
    W('wall-left-1', 0, 8, 0, 4, offWhite),
    W('wall-left-2', 0, 4, 0, 0, offWhite),

    // 红墙（亮角的有色反光墙）：竖在亮角左侧，灯与亮角同在其 +x 侧，
    // 因此亮角看到的正是被灯照亮的迎光面（一次反射即带红调）。
    W('wall-red', 1.9, 7.2, 1.9, 2.0, red),

    // 亮角挡板：竖墙，从亮角看其角度区间只覆盖灯、不覆盖红墙，
    // 于是挡住灯的直射，却保留亮角→红墙迎光面的视线。
    W('wall-baffle-a', 3.9, 7.4, 3.9, 2.9, gray),

    // 暗角：两道加长、错位的竖向挡板，把右下角与灯隔开两层。
    W('wall-baffle-b1', 7.3, 7.2, 7.3, 1.6, gray),
    W('wall-baffle-b2', 9.5, 7.0, 9.5, 1.2, gray),
  ];

  return {
    room,
    walls,
    // 灯：房间上半部的一段水平线光源，长度可在画布上拖动端点调整
    lamp: {
      a: { x: 4.4, y: 0.9 },
      b: { x: 7.2, y: 0.9 },
      power: 60,
      color: { r: 1, g: 0.96, b: 0.88 },
    },
    samples: [
      { id: 'sample-red-corner', pos: { x: 3.0, y: 7.3 } }, // 红墙亮角
      { id: 'sample-dark-corner', pos: { x: 11.4, y: 7.4 } }, // 双层挡板暗角
      { id: 'sample-mid', pos: { x: 5.5, y: 4.5 } }, // 房间中部对照
      { id: 'sample-near-lamp', pos: { x: 5.8, y: 2.2 } }, // 灯附近
    ],
  };
}

/** 仅保留外墙、清空所有挡板的简化场景（用于教学对照） */
export function createEmptyWorld(): World {
  const base = createDefaultWorld();
  return {
    ...base,
    walls: base.walls.filter((w) => w.id.startsWith('wall-') && !w.id.includes('baffle') && w.id !== 'wall-red'),
    samples: [
      { id: 'sample-1', pos: { x: 2, y: 6 } },
      { id: 'sample-2', pos: { x: 10, y: 6 } },
    ],
  };
}
