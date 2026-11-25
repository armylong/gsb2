import type { LevelDef } from './types';

/**
 * 内置关卡：顺路取件、但不能原路回来。
 *
 * 布局（canvas 网格坐标）：
 *
 *        A 家礁 h3 —— h2 礁径 —— B 北礁 h3
 *         \                        |
 *        h1 缓滩                h2 礁径
 *           \                     |
 *        C 中礁 h2 —— h0 退潮沟 —— D 低坪 h1（轻信片）
 *           \                     /
 *        h2 礁径            h2 绕行脊
 *             \               /
 *              E 南礁 h2 —— h2 —— F 高礁 h4（重信片）
 *
 * 关键点：
 * - C-D 是高程 0 的退潮沟，只在低潮窗口（约 t20–t34）能走，
 *   从 D 原路回 C 必须再花一次跨格时间，涨潮后沟先封 → 原路回不来；
 * - D-E 是高程 2 的绕行脊，潮水更大时才封，是退潮沟封掉后的回程；
 * - F 高礁放重信片，h1 缓滩 A-C 不能负重通过；负重回家只能走 h2 高路
 *   网络 F-D-B-A（或 F-E-C… 到 C 后同样被缓滩挡住，必须绕 D-B-A）。
 */
export const LEVEL: LevelDef = {
  name: '退潮沟与绕行脊',
  tidePeriod: 60,
  home: 'A',
  start: 'A',
  cells: [
    { id: 'A', name: '家礁', x: 1, y: 0, height: 3 },
    { id: 'B', name: '北礁', x: 4, y: 0, height: 3 },
    { id: 'C', name: '中礁', x: 1, y: 2, height: 2 },
    { id: 'D', name: '低坪', x: 4, y: 2, height: 1 },
    { id: 'E', name: '南礁', x: 1, y: 4, height: 2 },
    { id: 'F', name: '高礁', x: 4, y: 4, height: 4 },
  ],
  edges: [
    { a: 'A', b: 'B', height: 2, note: '礁径' },
    { a: 'A', b: 'C', height: 1, note: '缓滩（负重禁行）' },
    { a: 'B', b: 'D', height: 2, note: '礁径' },
    { a: 'C', b: 'D', height: 0, note: '退潮沟' },
    { a: 'C', b: 'E', height: 2, note: '礁径' },
    { a: 'D', b: 'E', height: 2, note: '绕行脊' },
    { a: 'E', b: 'F', height: 2, note: '礁径' },
    { a: 'D', b: 'F', height: 2, note: '绕行脊' },
  ],
  postcards: [
    { id: 'L1', kind: 'light', cell: 'D', label: '轻信片' },
    { id: 'H1', kind: 'heavy', cell: 'F', label: '重信片' },
  ],
};
