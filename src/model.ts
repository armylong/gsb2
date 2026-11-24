// 基础模型:格子、方向、颜色位、棋子、棋盘

export const Dir = { N: 0, E: 1, S: 2, W: 3 } as const;
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
export const DIR_NAME = ['上', '右', '下', '左'];

// 颜色位:红绿蓝三原色,按位叠加
export const RED = 1, GREEN = 2, BLUE = 4;

export const MASK_NAME: Record<number, string> = {
  0: '无', 1: '红', 2: '绿', 3: '黄(红+绿)', 4: '蓝',
  5: '品红(红+蓝)', 6: '青(绿+蓝)', 7: '白(红+绿+蓝)',
};

export const MASK_CSS: Record<number, string> = {
  1: '#ff5252', 2: '#4ade60', 3: '#ffd840', 4: '#5a8dff',
  5: '#ff5af0', 6: '#40e0d0', 7: '#f5f5f5',
};

export type PieceType = 'emitter' | 'mirror' | 'splitter' | 'blocker' | 'receiver';

export interface Piece {
  type: PieceType;
  /** emitter: 朝向 0..3;mirror/splitter: 0='/', 1='\';receiver/blocker: 无意义 */
  rot: number;
  /** emitter: 发出的颜色位;receiver: 要求的颜色组合位 */
  color: number;
}

export const PIECE_NAME: Record<PieceType, string> = {
  emitter: '发光块', mirror: '镜面', splitter: '分束块', blocker: '挡板', receiver: '接收板',
};

export class Board {
  pieces = new Map<string, Piece>();
  constructor(public w: number, public h: number) {}

  static key(x: number, y: number): string { return `${x},${y}`; }

  get(x: number, y: number): Piece | undefined { return this.pieces.get(Board.key(x, y)); }

  set(x: number, y: number, p: Piece): void { this.pieces.set(Board.key(x, y), p); }

  delete(x: number, y: number): void { this.pieces.delete(Board.key(x, y)); }

  clear(): void { this.pieces.clear(); }

  serialize(): string { return JSON.stringify([...this.pieces.entries()]); }

  restore(data: string): void {
    this.pieces = new Map(JSON.parse(data) as [string, Piece][]);
  }
}
