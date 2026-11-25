import { describe, expect, it } from 'vitest';
import {
  directionOf,
  edgeKey,
  isAdjacent,
  isOppositeCrossing,
  parseEdge,
  pathEdgeKeys,
  vKey,
} from '../src/game/geometry';

describe('geometry 格边与方向', () => {
  it('格边键无向且可解析', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 1, y: 3 };
    expect(edgeKey(a, b)).toBe(edgeKey(b, a));
    const [p, q] = parseEdge(edgeKey(a, b));
    expect([p, q]).toEqual([a, b]);
  });

  it('只有曼哈顿距离 1 才算相邻', () => {
    expect(isAdjacent({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(true);
    expect(isAdjacent({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });

  it('对边穿过判定：水平一对 + 垂直一对才合法', () => {
    const ok = new Map([
      ['red', ['L', 'R'] as Array<'L' | 'R' | 'U' | 'D'>],
      ['blue', ['U', 'D'] as Array<'L' | 'R' | 'U' | 'D'>],
    ]);
    expect(isOppositeCrossing(ok)).toBe(true);
    const corner = new Map([
      ['red', ['L', 'D'] as Array<'L' | 'R' | 'U' | 'D'>],
      ['blue', ['R', 'U'] as Array<'L' | 'R' | 'U' | 'D'>],
    ]);
    expect(isOppositeCrossing(corner)).toBe(false);
    const three = new Map([
      ['red', ['L', 'R'] as Array<'L' | 'R' | 'U' | 'D'>],
      ['blue', ['U'] as Array<'L' | 'R' | 'U' | 'D'>],
      ['green', ['D'] as Array<'L' | 'R' | 'U' | 'D'>],
    ]);
    expect(isOppositeCrossing(three)).toBe(false);
  });

  it('方向与路径格边', () => {
    expect(directionOf({ x: 2, y: 2 }, { x: 2, y: 3 })).toBe('D');
    expect(vKey({ x: 3, y: 4 })).toBe('3,4');
    const keys = pathEdgeKeys([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(keys).toHaveLength(2);
  });
});
