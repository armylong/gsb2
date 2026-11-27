import type { LevelDef } from './types';

// ---------------------------------------------------------------------------
// 第 1 关：绕道暂存
// 方向感知的轿厢堵门（BFS 标定）：
//   · 轿厢 5 格，靠门（索引 0，左门侧）落位。水平长画箱 P 先上车占 0-1，
//     小箱 S 后到落在 2；于是 P 到左门畅通、到右门被 S 挡；S 到右门畅通、
//     到左门被 P 挡——两箱各自只剩一个自由门，且互为对侧。
//   · S 的展柜在 2 层左门（共乘时 S 的左门被 P 封死）；P 的展柜在 4 层右门
//    （共乘时 P 的右门被 S 封死）。
//   · BFS 结果：含暂存的最短解 10 回合（在 2 层把 P 暂存到左站台，S 才能
//     进左门展柜，再取回 P）；禁用暂存位的最短解 12 回合。预算 11，使暂存
//     成为预算内唯一走法。
//   · 站台上 P 横在靠门 0-1，T、S 在其外侧，到门都得等 P 先挪。
// 1 层左侧低过梁只允许矮的水平画箱通过，演示过梁规则。
// ---------------------------------------------------------------------------
const level1: LevelDef = {
  id: 1,
  name: '第 1 关 · 绕道暂存',
  brief:
    '共乘的两个箱子各自只剩一个自由门，还偏偏是对侧；展柜又开在被堵的那侧。在楼层站台暂存长箱，死锁才解得开。',
  carSlots: 5,
  startFloor: 1,
  budget: 11,
  boxes: [
    { id: 'P', label: '水平长画箱 P', len: 2, horizontalOnly: true, height: 'low', color: '#c9774a' },
    { id: 'S', label: '小画箱 S', len: 1, horizontalOnly: false, height: 'tall', color: '#5b8dd9' },
    { id: 'T', label: '小画箱 T', len: 1, horizontalOnly: false, height: 'tall', color: '#6aa86a' },
  ],
  floors: [
    {
      id: 1,
      // 起点层双开门：左侧低过梁（无箱需通过，仅规则演示），右侧正常过梁
      doorMode: { kind: 'both' },
      L: { stageSlots: 2, caseSlots: 0, lintel: 'low' },
      R: { stageSlots: 4, caseSlots: 1, lintel: 'normal' },
    },
    {
      id: 2,
      // S 的展柜：只开左门（S 在轿厢的左门被 P 封死，必须先暂存 P）
      doorMode: { kind: 'fixed', side: 'L' },
      L: { stageSlots: 2, caseSlots: 1, lintel: 'normal' },
      R: { stageSlots: 2, caseSlots: 0, lintel: 'normal' },
    },
    {
      id: 3,
      // 双开门中转层：P 走自由的左门暂存到左站台，解开轿厢死锁
      doorMode: { kind: 'both' },
      L: { stageSlots: 3, caseSlots: 0, lintel: 'normal' },
      R: { stageSlots: 2, caseSlots: 0, lintel: 'normal' },
    },
    {
      id: 4,
      // P 的展柜：只开右门（共乘时 P 的右门被 S 封死）
      doorMode: { kind: 'fixed', side: 'R' },
      L: { stageSlots: 2, caseSlots: 0, lintel: 'normal' },
      R: { stageSlots: 2, caseSlots: 2, lintel: 'normal' },
    },
  ],
  initialPlacements: [
    // 右尽头站台 4 格：P 横在靠门 0-1，T 在 2，S 被堵在最里侧 3；
    // S 到门被 P 封死，T 在 P 外侧也需等 P 先挪
    { boxId: 'P', region: 'stage', floor: 1, side: 'R', index: 0 },
    { boxId: 'T', region: 'stage', floor: 1, side: 'R', index: 2 },
    { boxId: 'S', region: 'stage', floor: 1, side: 'R', index: 3 },
  ],
  goals: [
    { boxId: 'P', floor: 4, side: 'R' },
    { boxId: 'S', floor: 2, side: 'L' },
    { boxId: 'T', floor: 1, side: 'R' },
  ],
};

// ---------------------------------------------------------------------------
// 第 2 关：交替站台
// 2 层两侧门按回合交替（偶数回合左门、奇数回合右门），S 的展柜在 2 层左侧。
// 交替门的可验证性质（validate 脚本断言）：
//   · 关门拍：门关闭的那一侧，任何搬箱动作都被引擎拒绝、状态不变，无法靠
//     动画速度穿门（结算顺序固定：先判门、再落箱、最后翻门）；
//   · 等待是最便宜的奇偶翻转：等待 1 回合即可换门，而移动到邻层再回来至少
//     2 回合。直觉路线（轿厢从 2 层下 1 层接 S、原车返回）到达时恰是关门拍，
//     玩家会自然遇到一次必须等待的局面。
// 3 层只开右门、4 层只开右门，是 P、T 的展柜层。
// ---------------------------------------------------------------------------
const level2: LevelDef = {
  id: 2,
  name: '第 2 关 · 交替站台',
  brief:
    '2 层的门左右轮流开。直觉路线到达时左门恰好关着——等一拍只花 1 回合，跑上跑下凑奇偶更贵。',
  carSlots: 4,
  startFloor: 2,
  budget: 18,
  boxes: [
    { id: 'P', label: '水平长画箱 P', len: 2, horizontalOnly: true, height: 'low', color: '#c9774a' },
    { id: 'S', label: '小画箱 S', len: 1, horizontalOnly: false, height: 'tall', color: '#5b8dd9' },
    { id: 'T', label: '小画箱 T', len: 1, horizontalOnly: false, height: 'tall', color: '#6aa86a' },
  ],
  floors: [
    {
      id: 1,
      doorMode: { kind: 'both' },
      // 起点层：S 独占左站台；右侧低过梁预留给后面送达的 P
      L: { stageSlots: 2, caseSlots: 0, lintel: 'normal' },
      R: { stageSlots: 3, caseSlots: 2, lintel: 'low' },
    },
    {
      id: 2,
      doorMode: { kind: 'alternating' },
      // S 的展柜在左侧；左门偶数回合开，S 到达时是奇数回合，必须等一拍
      L: { stageSlots: 2, caseSlots: 1, lintel: 'normal' },
      R: { stageSlots: 2, caseSlots: 0, lintel: 'normal' },
    },
    {
      // S 入柜之后才会到达的楼层（P、T 起点），只开右门
      id: 3,
      doorMode: { kind: 'fixed', side: 'R' },
      L: { stageSlots: 2, caseSlots: 0, lintel: 'normal' },
      R: { stageSlots: 3, caseSlots: 1, lintel: 'normal' },
    },
    {
      id: 4,
      doorMode: { kind: 'fixed', side: 'R' },
      L: { stageSlots: 2, caseSlots: 0, lintel: 'normal' },
      R: { stageSlots: 2, caseSlots: 0, lintel: 'normal' },
    },
  ],
  initialPlacements: [
    // S 独占起点层，第一个被处理；P、T 在 3 层，S 不入柜、不经过 2 层就到不了
    { boxId: 'S', region: 'stage', floor: 1, side: 'L', index: 0 },
    // T 靠门（0），长箱 P 在外侧（1-2），T 可先行入柜
    { boxId: 'T', region: 'stage', floor: 3, side: 'R', index: 0 },
    { boxId: 'P', region: 'stage', floor: 3, side: 'R', index: 1 },
  ],
  goals: [
    { boxId: 'S', floor: 2, side: 'L' }, // 必须经交替门左侧
    { boxId: 'P', floor: 1, side: 'R' }, // 低过梁，仅矮的 P 可入
    { boxId: 'T', floor: 3, side: 'R' },
  ],
};

export const LEVELS: LevelDef[] = [level1, level2];
