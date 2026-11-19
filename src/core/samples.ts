import type { LayoutFile, Placement, Rotation, WorldState } from './types';
import { ITEMS } from './items';

export interface Sample {
  key: string;
  label: string;
  hint: string;
  world: WorldState;
}

const p = (
  itemId: string,
  bagId: string,
  col: number,
  row: number,
  rotation: Rotation = 0,
): Placement => ({ itemId, bagId, anchor: { col, row }, rotation });

const BAGS = {
  big: { id: 'bag-a', name: '大号背包 8×6', cols: 8, rows: 6 },
  small: { id: 'bag-b', name: '小号背包 6×5', cols: 6, rows: 5 },
};

/**
 * 默认综合布局(逐格核对无重叠/越界, 12 件物品全部已放置):
 * 大号背包 8 件 35 格, 小号背包 4 件 20 格, 共 55 个实占格。
 */
const defaultWorld: WorldState = {
  bags: [BAGS.big, BAGS.small],
  placements: [
    // bag-a 8×6
    p('I01', 'bag-a', 0, 0), // 行0 c0-3
    p('I06', 'bag-a', 5, 0), // 行0-1 c5-6
    p('I03', 'bag-a', 7, 0), // 竖条 c7 行0-2
    p('I02', 'bag-a', 0, 1), // 行1 c0-4
    p('I10', 'bag-a', 0, 2), // L: (0,2)(1,2)(2,2)(2,3)
    p('I12', 'bag-a', 3, 2), // 行2 c3-5
    p('I04', 'bag-a', 3, 3), // 2×3 矩形 c3-4 行3-5
    p('I05', 'bag-a', 5, 3), // 3×2 矩形 c5-7 行3-4
    // bag-b 6×5
    p('I11', 'bag-b', 0, 0), // 3×3 缺角
    p('I08', 'bag-b', 3, 0), // L 3×3
    p('I07', 'bag-b', 1, 3), // 小 L
    p('I09', 'bag-b', 3, 3, 1), // 瘦高 L 旋转 90°
  ],
};

/**
 * 窄缝旋转样例:
 * 左右两面墙把 col=3 夹成 1 格宽、5 格高的竖直窄缝(行0-4)。
 * 横条 I02 初始横躺在底行 (0,5), 横着上移必然撞墙;
 * 旋转 90° 变竖条后可锚定 (3,0) 沿窄缝放入。
 */
const narrowSlotWorld: WorldState = {
  bags: [BAGS.big, BAGS.small],
  placements: [
    // 左墙: 封死 cols0-2 行0-4
    p('I05', 'bag-a', 0, 0), // 3×2 行0-1 c0-2
    p('I04', 'bag-a', 0, 2), // 2×3 行2-4 c0-1
    p('I03', 'bag-a', 2, 2), // 竖条 (2,2)(2,3)(2,4)
    // 右墙: 每行在 cols4-7 至少留一个阻挡, 但不碰 col3
    p('I01', 'bag-a', 4, 0), // 行0 c4-7
    p('I06', 'bag-a', 4, 1), // (4,1)(5,1)(4,2)(5,2)
    p('I09', 'bag-a', 6, 1), // (6,1)(6,2)(6,3)(7,3)
    p('I12', 'bag-a', 5, 4), // 行4 c5-7
    // 主角: 横条底行横躺
    p('I02', 'bag-a', 0, 5),
    // 小号背包放其余 4 件
    p('I11', 'bag-b', 0, 0),
    p('I08', 'bag-b', 3, 0),
    p('I10', 'bag-b', 0, 3),
    p('I07', 'bag-b', 3, 3),
  ],
};

/**
 * L 形嵌放样例:
 * 大号背包顶部 (4,0) 处预留一个 L 形空腔, 占格恰好等于 I10 旋转 90° 后的形状
 * (空腔格: (4,2)(5,0)(5,1)(5,2))。I10 初始在小号背包 (0,0),
 * 旋转 90° 后拖到锚点 (4,0) 恰好嵌合; 朝向不对时无法落入。
 */
const lFitWorld: WorldState = {
  bags: [BAGS.big, BAGS.small],
  placements: [
    // bag-a (8×6): 顶部预留 L 形空腔(锚点 4,0, 格 (4,2)(5,0)(5,1)(5,2))
    p('I11', 'bag-a', 0, 0), // 左上 3×3 缺角
    p('I03', 'bag-a', 3, 0), // 竖条 (3,0)(3,1)(3,2), 空腔左界
    p('I06', 'bag-a', 6, 0), // (6,0)(7,0)(6,1)(7,1), 空腔右界
    p('I04', 'bag-a', 0, 3), // 2×3 c0-1 行3-5
    p('I05', 'bag-a', 2, 3), // 3×2 c2-4 行3-4
    p('I09', 'bag-a', 5, 3, 1), // 旋转 L: (5,3)(6,3)(7,3)(5,4)
    p('I01', 'bag-a', 2, 5), // 底行 c2-5
    // bag-b (6×5): 待嵌入的 I10 在左上角, 其余 4 件见下
    p('I10', 'bag-b', 0, 0), // (0,0)(1,0)(2,0)(2,1)
    p('I02', 'bag-b', 3, 0, 1), // 旋转 90° 竖条 (3,0..3,4)
    p('I12', 'bag-b', 4, 0, 1), // 旋转 90° 竖条 (4,0..4,2)
    p('I08', 'bag-b', 0, 2), // (0,2)(1,2)(2,2)(2,3)(2,4)
    p('I07', 'bag-b', 4, 3), // 小 L (4,3)(4,4)(5,4)
  ],
};

/**
 * 交换失败回滚样例(同一静态布局上的三个尝试):
 * (a) bag-b 的 I01 拖到 bag-a 锚点 (0,0), 同时压到 I04+I05 两件 => 拒绝;
 * (b) bag-b 的 I02 旋转 90° 竖到 bag-a (7,0), 只撞 I11 一件, 但 I11 以原朝向
 *     放回 I02 的原锚点 (0,4) 会与底行区域冲突 => 整次回滚;
 * (c) bag-b 的 I03 旋转 90° 变横条, 拖到 bag-a (0,3) 与 I12 一对一交换,
 *     I12 横条回到 I03 原锚点 (0,0) 两侧都合法 => 成功。
 */
const swapFailWorld: WorldState = {
  bags: [BAGS.big, BAGS.small],
  placements: [
    // bag-a (8×6): 7 件固定角色
    p('I04', 'bag-a', 0, 0), // 2x3 行0-2 c0-1
    p('I05', 'bag-a', 2, 0), // 3x2 行0-1 c2-4
    p('I11', 'bag-a', 5, 0), // 3x3 缺角, 锚 (5,0)
    p('I12', 'bag-a', 0, 3), // 横条 (0,3)(1,3)(2,3), 成功交换对象
    p('I08', 'bag-a', 3, 2), // L3x3 锚 (3,2), 远离 I12 保证交换只撞一件
    p('I09', 'bag-a', 6, 3), // 瘦 L 锚 (6,3)
    p('I10', 'bag-a', 0, 4), // L (0,4)(1,4)(2,4)(2,5), 完整在界内
    // bag-b (6×5): 左侧 col0 行0-2 留给 I03 竖条, 同锚横条 (0,0..2,0) 也空闲
    p('I03', 'bag-b', 0, 0), // 竖条 (0,0)(0,1)(0,2), 成功交换主角
    p('I01', 'bag-b', 0, 3), // 横条 (0,3..3,3), 不挡 I12 回 (0,0)
    p('I06', 'bag-b', 1, 1), // 2x2 (1,1)(2,1)(1,2)(2,2)
    p('I07', 'bag-b', 4, 1), // 小 L (4,1)(4,2)(5,2)
    p('I02', 'bag-b', 0, 4), // 横条 (0,4..4,4), 回滚交换主角
  ],
};

export const SAMPLES: Sample[] = [
  {
    key: 'default',
    label: '默认综合布局',
    hint: '12 件物品分布在两个背包。试试按住物品任意实占格拖动, R 键旋转, Esc 取消。',
    world: defaultWorld,
  },
  {
    key: 'narrow-slot',
    label: '样例1 · 窄缝旋转',
    hint: '两面墙之间是 col=3 的 1 格宽竖缝。横条 I02 横着上移会标红碰撞; 按 R 旋转 90° 后锚定 (3,0) 可沿窄缝放入, 抓取格始终停在鼠标下。',
    world: narrowSlotWorld,
  },
  {
    key: 'l-fit',
    label: '样例2 · L形嵌放',
    hint: '大号背包顶部有一个 L 形空腔(锚点 (4,0))。把小号背包的 I10 按 R 旋转 90° 拖过去恰好嵌合; L 形包围盒的虚线空缺格允许与别的物品相邻。',
    world: lFitWorld,
  },
  {
    key: 'swap-fail',
    label: '样例3 · 交换失败回滚',
    hint: 'I01 拖去压两件物品会被拒; I02 旋转后与 I11 交换会因对方回不去而整次回滚; I03 与 I12 一对一交换则成功。每次结果都可撤销。',
    world: swapFailWorld,
  },
];

export function sampleToLayout(sample: Sample): LayoutFile {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    items: ITEMS,
    world: sample.world,
  };
}
