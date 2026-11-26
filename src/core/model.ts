/** 一个格子：0 = 空（占一拍的静音），1 = 打孔（鼓点） */
export type Cell = 0 | 1;

/** 一条固定长度的纸带：cells[路][列]，每列一拍，空位也占一拍 */
export interface StripDef {
  id: string;
  name: string;
  tracks: number;
  length: number;
  cells: Cell[][];
}

/** 卡槽里的一项：一段纸带（可倒向），或一枚返回标记 */
export type SlotEntry =
  | { kind: 'strip'; stripId: string; reversed: boolean }
  | { kind: 'return'; backTo: number };

export type Arrangement = SlotEntry[];

/** 展开后的一拍：每一路是否出声 */
export interface Beat {
  hits: boolean[];
}

export interface Puzzle {
  id: string;
  title: string;
  description: string;
  trackNames: string[];
  strips: StripDef[];
  /** 玩家手里有几枚返回标记可放 */
  returnTokens: number;
  /** 用纸限制：展开后总拍数上限（走纸长度有限） */
  maxBeats: number;
  /** 用纸限制：同一拍最多同时打几孔（打孔器力度有限） */
  maxSimultaneous: number;
  /** 目标鼓点序列（含空拍） */
  target: Beat[];
  /** 初始摆法 */
  initial: Arrangement;
  /** 一条可验证的提示 */
  hint: string;
}

/** 用 "X..X" 这样的行来写纸带，行 = 路，列 = 拍 */
export function stripFromStrings(id: string, name: string, rows: string[]): StripDef {
  const tracks = rows.length;
  const length = rows[0].length;
  const cells: Cell[][] = rows.map((row) => {
    if (row.length !== length) throw new Error(`纸带 ${id} 的各路长度不一致`);
    return [...row].map((ch): Cell => (ch === 'X' ? 1 : 0));
  });
  return { id, name, tracks, length, cells };
}

export function beatsFromStrings(rows: string[]): Beat[] {
  const length = rows[0].length;
  const beats: Beat[] = [];
  for (let c = 0; c < length; c++) {
    beats.push({ hits: rows.map((row) => row[c] === 'X') });
  }
  return beats;
}
