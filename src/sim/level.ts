import type { World } from './types.js';

/**
 * 试验场布局(画布 960x600, y 向下):
 *  - floor    地面(不可抓)
 *  - pillar   高墙, 供贴墙滑落; 顶角可抓
 *  - main     主平台, 两顶角可抓
 *  - narrow   窄平台(仅比角色宽一点), 两顶角可抓
 *  - lowceiling 低顶平台, 顶角可抓, 但正上方有 obstacle 挡住翻身空间
 *  - obstacle 顶部障碍(不可抓), 与 lowceiling 之间净空 < 角色身高
 *  - crate    不可抓的箱子, 供"下落走离"样例
 */
export function createWorld(): World {
  return {
    spawn: { x: 60, y: 510 },
    platforms: [
      { id: 'floor',      x: 0,   y: 560, w: 960, h: 40,  grabbable: false },
      { id: 'pillar',     x: 120, y: 200, w: 32,  h: 360, grabbable: true },
      { id: 'main',       x: 320, y: 380, w: 140, h: 20,  grabbable: true },
      { id: 'narrow',     x: 540, y: 300, w: 52,  h: 20,  grabbable: true },
      { id: 'lowceiling', x: 700, y: 420, w: 120, h: 20,  grabbable: true },
      { id: 'obstacle',   x: 700, y: 330, w: 120, h: 60,  grabbable: false },
      { id: 'crate',      x: 380, y: 480, w: 90,  h: 80,  grabbable: false },
    ],
  };
}
