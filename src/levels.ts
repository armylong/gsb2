/**
 * levels.ts — 预设关卡
 *
 * 每个关卡的数值性质都由 scripts/verify.ts 强制校验：
 * - trueWeights 必须落在 candidates 内，intendedPartition 在真实重量下等重；
 * - combo 关卡：给定的「证据称量」单独一步都不足以使答案分组必然，
 *   两步/多步联合后必然等重，且联合后仍保留多个完整可能；
 * - tight 关卡：maxWeighings 很小，走完给定称量后仍有大量可能。
 */
import type { LevelDef, Weighing } from './engine';

export interface LevelScript extends LevelDef {
  /** 验证/演示用的预期证据称量（0 基，outcome 会在校验时与 trueWeights 核对） */
  scriptedWeighings: Weighing[];
  /** 给玩家的分步提示 */
  hints: string[];
  /** 卡片上的玩法定位 */
  highlight: '入门' | '组合称量' | '限次未定';
}

export const LEVELS: LevelScript[] = [
  {
    id: 'first-balance',
    name: '初平之秤',
    tag: '入门',
    highlight: '入门',
    brief:
      '三只外形完全相同的编号包裹，重量只可能是 1、2、3 千克（允许同重）。' +
      '把它们分成两个总重相同的货架。先用天平试几次，再提交分组。',
    packageCount: 3,
    candidates: [1, 2, 3],
    trueWeights: [1, 2, 3],
    maxWeighings: 4,
    intendedPartition: { left: [2], right: [0, 1] },
    scriptedWeighings: [
      { left: [0], right: [1], outcome: -1 },
      { left: [1], right: [2], outcome: -1 },
    ],
    hints: [
      '先单称 ① 对 ②，再单称 ② 对 ③：如果两次都是一边轻，而候选只有 1、2、3，三只包裹的重量就被顺序锁死了。',
      '重量确定后，最重的 ③ 单独一架，① 和 ② 合放另一架。',
      '也可以直接把你打算提交的分组摆上天平称一次：若平衡，这条记录本身就保证了它必然等重。',
    ],
    designNote: '两次链式单称即可在三个候选中唯一排序，教学「记录会共同收缩可能性」。',
  },
  {
    id: 'combined-proof',
    name: '连环不等式',
    tag: '组合称量',
    highlight: '组合称量',
    brief:
      '五只编号包裹，重量候选为 1、2、3 千克（允许同重）。' +
      '线索藏在两次「组合对组合」的称量里——任何一次单独的结果都不足以证明答案，' +
      '必须把两条记录合在一起推理。你有 3 次确认机会。',
    packageCount: 5,
    candidates: [1, 2, 3],
    trueWeights: [1, 1, 1, 2, 3],
    maxWeighings: 3,
    intendedPartition: { left: [0, 1, 3], right: [2, 4] },
    scriptedWeighings: [
      // ②+④ (1+2=3) > ①+③ (1+1=2)
      { left: [1, 3], right: [0, 2], outcome: 1 },
      // ③+⑤ (1+3=4) > ②+④ (1+2=3)
      { left: [2, 4], right: [1, 3], outcome: 1 },
    ],
    hints: [
      '第一次：把 ②、④ 放左盘，①、③ 放右盘。记住哪边重。',
      '第二次：把 ③、⑤ 放左盘，②、④ 放右盘。',
      '在「可能性」面板查看：两条记录同时成立的完整重量组合只剩 7 种，① 必为 1、⑤ 必为 3，其余仍有悬念——但分组 ①②④ 对 ③⑤ 在全部 7 种下都等重。',
    ],
    designNote:
      '两条严格不等式形成 ①+③ < ②+④ < ③+⑤ 的夹逼；联合后目标分组在全部 7 个剩余分配下必然等重，单条均不成立。',
  },
  {
    id: 'two-shot-fog',
    name: '两称迷局',
    tag: '限次未定',
    highlight: '限次未定',
    brief:
      '四只编号包裹，重量候选为 1、2、3、4 千克（允许同重）。' +
      '天平只给你 2 次确认机会——确认才消耗次数，摆来摆去不消耗。' +
      '机会用尽时真相很可能仍未锁定；这时提交分组，系统会用反例告诉你它是否只是「碰巧」相等。',
    packageCount: 4,
    candidates: [1, 2, 3, 4],
    trueWeights: [1, 3, 2, 4],
    maxWeighings: 2,
    intendedPartition: { left: [1, 2], right: [0, 3] },
    scriptedWeighings: [
      { left: [0], right: [1], outcome: -1 },
      { left: [2], right: [3], outcome: -1 },
    ],
    hints: [
      '试试最自然的两次单称：① 对 ②，③ 对 ④。两次都会看到左轻。',
      '两次确认后次数耗尽，仍有 36 种完整重量组合同时成立——每个包裹都还有多个候选重量。',
      '此时提交 ②③ 对 ①④：真实重量下恰好都是 5，但系统会找出一个反例分配证明这并非必然。看完反例，点「重新开始」即可还原次数与记录再挑战。',
    ],
    designNote:
      'a<b 且 c<d 留下 36 个联合分配；真实等重划分 ②③|①④ 仅为 contingent-equal，必然收到反例。专门展示「用光次数仍不确定」与重开还原。',
  },
];
