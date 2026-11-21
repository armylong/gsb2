import { keyOf } from './grid.ts';
import { SOURCE_DEFAULT_AMOUNT, type Edit } from './layout.ts';

export interface ExampleDef {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** 标准编辑序列；顺序本身不参与布局，只用于“不同编辑顺序”测试。 */
  readonly edits: readonly Edit[];
  readonly rounds: number;
  readonly expects: readonly string[];
  readonly focus: ReadonlyArray<{ x: number; y: number; label: string }>;
}

const wall = (x: number, y: number): Edit => ({ kind: 'cell', x, y, content: { kind: 'wall' } });
const source = (
  x: number,
  y: number,
  medium: 'heat' | 'fog',
  amount = SOURCE_DEFAULT_AMOUNT[medium],
): Edit => ({ kind: 'cell', x, y, content: { kind: 'source', medium, amount } });
const vent = (x: number, y: number, medium: 'heat' | 'fog' | 'both', open: boolean): Edit => ({
  kind: 'cell',
  x,
  y,
  content: { kind: 'vent', medium, open },
});
const valve = (a: string, b: string, allowAtoB: boolean): Edit => ({
  kind: 'valve',
  a,
  b,
  allowAtoB,
});

/** 画矩形墙；skip 里的格子留空作为门洞。 */
function rectWalls(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  skip: readonly string[] = [],
): Edit[] {
  const skipSet = new Set(skip);
  const out: Edit[] = [];
  for (let x = x0; x <= x1; x += 1) {
    for (const y of [y0, y1]) {
      const key = keyOf(x, y);
      if (!skipSet.has(key)) out.push(wall(x, y));
    }
  }
  for (let y = y0 + 1; y < y1; y += 1) {
    for (const x of [x0, x1]) {
      const key = keyOf(x, y);
      if (!skipSet.has(key)) out.push(wall(x, y));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1) 密封房：四面墙完全封闭，无风口。内部两个源，外部一个源。          */
/* ------------------------------------------------------------------ */
const sealedRoom: Edit[] = [
  ...rectWalls(3, 2, 9, 8),
  source(4, 3, 'fog'),
  source(8, 7, 'heat'),
  source(13, 5, 'fog'),
];

/* ------------------------------------------------------------------ */
/* 2) 阀门反向：房间唯一门洞装单向阀，默认朝内（阻挡外出）。            */
/* ------------------------------------------------------------------ */
const valveReverse: Edit[] = [
  ...rectWalls(2, 2, 6, 6, [keyOf(6, 4)]),
  source(3, 4, 'heat'),
  vent(9, 4, 'heat', true),
  // 门洞 (6,4)-(7,4)：只允许 7,4 -> 6,4，即“反向”把热量锁在房里。
  valve(keyOf(6, 4), keyOf(7, 4), false),
];

/* ------------------------------------------------------------------ */
/* 3) 双源：热与雾同轮推进；两个开启风口 + 一个关闭的雾风口。          */
/* ------------------------------------------------------------------ */
const dualSource: Edit[] = [
  // 预留两个边界风口的位置，避免与墙编辑写同一格（否则编辑顺序会真的改变布局）。
  ...rectWalls(2, 2, 13, 9, [keyOf(4, 2), keyOf(11, 9)]),
  source(4, 3, 'heat'),
  source(11, 8, 'fog'),
  // 开启的风口紧贴源，能稳定达到各自的释放上限。
  vent(4, 2, 'heat', true),
  vent(11, 9, 'fog', true),
  // 房间中央关闭的双介质风口：开启前零释放。
  vent(7, 5, 'both', false),
];

export const EXAMPLES: readonly ExampleDef[] = [
  {
    id: 'sealed-room',
    name: '密封房',
    summary:
      '四面墙完全封闭，内部一雾一热，外部再放一个雾源；验证密封边界零外泄、两个源各自计量。',
    edits: sealedRoom,
    rounds: 10,
    expects: [
      '热量与雾分别按 HU / FU 结算，互不串账',
      '没有风口，整体释放量始终为 0',
      '密封房边界零穿透：只有房内源时，房外所有格子恒为 0',
    ],
    focus: [
      { x: 4, y: 3, label: '房内雾源' },
      { x: 8, y: 7, label: '房内热源' },
      { x: 13, y: 5, label: '房外雾源' },
    ],
  },
  {
    id: 'valve-reverse',
    name: '阀门反向',
    summary:
      '房间唯一门洞装单向阀，默认朝内（阻挡外出）；验证反向时出口零释放，翻向后热量才流向走廊风口。',
    edits: valveReverse,
    rounds: 12,
    expects: [
      '默认方向：门洞热流为 0，风口释放为 0',
      '把门洞阀门翻向后：热量穿过门洞并到达风口释放',
      '单向阀只改方向，不改总量',
    ],
    focus: [
      { x: 3, y: 4, label: '房内热源' },
      { x: 6, y: 4, label: '单向阀门洞' },
      { x: 9, y: 4, label: '走廊尽头风口' },
    ],
  },
  {
    id: 'dual-source',
    name: '双源 + 可开关风口',
    summary:
      '热源与雾源分居房间两端，各有一个紧贴源的开启风口，中央另有一个关闭的双介质风口；验证两种介质同轮推进、分别释放，关闭的风口零释放。',
    edits: dualSource,
    rounds: 14,
    expects: [
      '热量与雾分别注入、分别扩散、分别释放',
      '两个开启的风口各自达到释放上限 2 HU / 1.2 FU',
      '关闭的双介质风口释放量恒为 0',
    ],
    focus: [
      { x: 4, y: 3, label: '左侧热源' },
      { x: 11, y: 8, label: '右侧雾源' },
      { x: 4, y: 2, label: '开启的热风口' },
      { x: 11, y: 9, label: '开启的雾风口' },
      { x: 7, y: 5, label: '关闭的双介质风口' },
    ],
  },
];

export function exampleById(id: string): ExampleDef {
  const found = EXAMPLES.find((example) => example.id === id);
  if (!found) throw new Error(`未知示例: ${id}`);
  return found;
}

/** 确定性洗牌（xorshift），用于验证编辑顺序不影响结果。 */
export function shuffleEdits(edits: readonly Edit[], seed: number): Edit[] {
  const out = [...edits];
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    const tmp = out[i];
    const other = out[j];
    if (tmp === undefined || other === undefined) continue;
    out[i] = other;
    out[j] = tmp;
  }
  return out;
}

/** 固定几套编辑顺序：原序、反序、两种固定洗牌。 */
export function editOrders(
  edits: readonly Edit[],
): Array<{ name: string; edits: Edit[] }> {
  return [
    { name: '原序', edits: [...edits] },
    { name: '反序', edits: [...edits].reverse() },
    { name: '洗牌 0x9e37', edits: shuffleEdits(edits, 0x9e37) },
    { name: '洗牌 0x51ed', edits: shuffleEdits(edits, 0x51ed) },
  ];
}

