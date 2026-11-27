import { boards } from '../engine/boards';
import type { EventType, Puzzle, State } from '../engine/types';

/**
 * 三张盘：
 *  - tutorial：正向演示，一只一只走，示范「出口空着只能游 / 被占就退草」。
 *  - clean：纯回推训练。每个位置只有一种到达方式，候选只会在「谁动了」
 *    之间分叉，非常适合练倒推。
 *  - branch：终态草坪天然有「直游 / 被堵退草」两条解释，必须靠更早回合的
 *    记录与当时占位排除其中一条。
 */

const TUTORIAL_START: State = { a1: 'i1', a2: 'i3', a3: 'i4', a4: 'l3' };
const TUTORIAL_FINAL: State = { a1: 'i2', a2: 'i3', a3: 'l2', a4: 'l3' };

export const tutorial: Puzzle = {
  id: 'tutorial',
  mode: 'tutorial',
  board: boards.training,
  title: '教学 · 沿水道认路',
  subtitle: '先正向看一遍：出口空就只能游，被占就退草或原地等',
  intro:
    '巡护员先带你正着走一遍。每座岛只有一条固定方向的水道，水道尽头如果站着别人，' +
    '这只动物就只能停在原地，或者退到岛边那块空草坪。草坪没有出口，上去就结束。',
  coda: '看明白了：水道的方向是写死的，被占时多出来的选择只有「原地」和「退草」。',
  finalState: TUTORIAL_FINAL,
  events: ['island', 'wait', 'lawn'] as EventType[],
  startState: TUTORIAL_START,
  clue: { text: '清晨 #1 小龟在芦苇岛。', fixed: { a1: 'i1' } },
  expectedStart: TUTORIAL_START,
};

const CLEAN_START: State = { a1: 'i1', a2: 'i3', a3: 'i4', a4: 'l2' };
const CLEAN_FINAL: State = { a1: 'i3', a2: 'l1', a3: 'l3', a4: 'l2' };

export const clean: Puzzle = {
  id: 'clean',
  mode: 'reverse',
  board: boards.marsh,
  title: '第一张 · 窄石岛的回声',
  subtitle: '四个回合：岛、草、草、岛',
  intro:
    '太阳落山，小动物停在现在的位置。记录本上只留下每回合发生的是哪一类事，' +
    '没有写是谁。窄石岛有两条上游水道汇入，所以「谁游进了窄石岛」这一步，' +
    '得在两座上游岛之间挑。倒着把清晨的位置推回去。',
  coda: '只要每一步都能被正向规则重新走一遍，倒推出来的清晨就是真的。',
  finalState: CLEAN_FINAL,
  events: ['island', 'lawn', 'lawn', 'island'] as EventType[],
  clue: { text: '清晨 #1 小龟停在木桩岛。', fixed: { a1: 'i1' } },
  expectedStart: CLEAN_START,
};

const BRANCH_START: State = { a1: 'i1', a2: 'i2', a3: 'i3', a4: 'l1' };
const BRANCH_FINAL: State = { a1: 'i1', a2: 'l2', a3: 'i2', a4: 'l1' };

export const branch: Puzzle = {
  id: 'branch',
  mode: 'reverse',
  board: boards.fork,
  title: '第二张 · 东岸草坪的两种说法',
  subtitle: '三个回合：岛、岛、草',
  intro:
    '东岸草坪连着两条路：沙嘴岛的水道直接通向它，老柳岛被堵住时也会退到这片草。' +
    '终态里草坪上的那位，可能是游过来的，也可能是被堵后绕过来的。' +
    '两条解释都得先过得去正向规则，再被更早的记录筛掉一条。',
  coda: '同一个终态可以有好几种来路；事件顺序和当时的占位是唯一的裁判。',
  finalState: BRANCH_FINAL,
  events: ['island', 'island', 'lawn'] as EventType[],
  clue: { text: '清晨 #3 锦鲤在老柳岛。', fixed: { a3: 'i3' } },
  expectedStart: BRANCH_START,
};

export const puzzles = [tutorial, clean, branch];
export const puzzleById = Object.fromEntries(puzzles.map((p) => [p.id, p]));
