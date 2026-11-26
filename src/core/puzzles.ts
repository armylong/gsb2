import type { Puzzle } from './model';
import { beatsFromStrings, stripFromStrings } from './model';

const TRACKS = ['高鼓', '中鼓', '低鼓'];

/**
 * 第一关：倒带练习。
 * 三段纸带都要用上，B 段必须倒向插入。
 * 正确摆法：A → 、B ← 、C →
 */
const puzzle1: Puzzle = {
  id: 'reverse-101',
  title: '第一关 · 倒带练习',
  description:
    '三段纸带、三路孔。听一听目标节奏：有一段怎么放都不对——试试把它倒过来插。空位也占一拍。',
  trackNames: TRACKS,
  strips: [
    stripFromStrings('A', '纸带 A', ['X..X', '.X..', '..X.']),
    stripFromStrings('B', '纸带 B', ['..X.', '...X', '.X..']),
    stripFromStrings('C', '纸带 C', ['X..X', '..X.', 'X...']),
  ],
  returnTokens: 0,
  maxBeats: 12,
  maxSimultaneous: 2,
  target: beatsFromStrings([
    'X..X.X..X..X',
    '.X..X.....X.',
    '..X...X.X...',
  ]),
  initial: [
    { kind: 'strip', stripId: 'C', reversed: false },
    { kind: 'strip', stripId: 'B', reversed: false },
    { kind: 'strip', stripId: 'A', reversed: false },
  ],
  hint: 'B 段要倒向插入：倒向后它的第一拍是中鼓、最后一拍是空拍。可以单拍走到第 5 拍核对。',
};

/**
 * 第二关：再来一遍。
 * 目标曲是 D E F E F —— E、F 两小段要奏两遍，但每条纸带只能用一次，
 * 必须靠返回标记让读卡器回头。返回标记只重复一次，读到第二遍会继续前进。
 * 正确摆法：D → 、E → 、F → 、返回标记（指向第 2 槽）
 */
const puzzle2: Puzzle = {
  id: 'repeat-201',
  title: '第二关 · 再来一遍',
  description:
    '目标节奏里 E、F 两段出现了两次，可每条纸带只许用一次。把手里的返回标记放进卡槽，让读卡器回头重读那一小段。',
  trackNames: TRACKS,
  strips: [
    stripFromStrings('D', '纸带 D', ['X...', '.X..', '..X.']),
    stripFromStrings('E', '纸带 E', ['X..X', '.X.X', '....']),
    stripFromStrings('F', '纸带 F', ['....', 'X..X', '.XX.']),
  ],
  returnTokens: 1,
  maxBeats: 20,
  maxSimultaneous: 2,
  target: beatsFromStrings([
    'X...X..X....X..X....',
    '.X...X.XX..X.X.XX..X',
    '..X......XX......XX.',
  ]),
  initial: [
    { kind: 'strip', stripId: 'D', reversed: false },
    { kind: 'strip', stripId: 'E', reversed: false },
    { kind: 'strip', stripId: 'F', reversed: false },
  ],
  hint: '把返回标记放在最后，指向第 2 槽（E）：E、F 会再奏一遍，全曲恰好 20 拍。',
};

export const PUZZLES: Puzzle[] = [puzzle1, puzzle2];
