import type { Dir, SymbolDef } from './types';

// 28 对无序旗位组合中取 20 个符号：启 / 止 + 八字数据符 + 十个复核数字
const ALL_PAIRS: Array<readonly [Dir, Dir]> = [];
for (let a = 0 as Dir; a < 8; a = (a + 1) as Dir) {
  for (let b = (a + 1) as Dir; b < 8; b = (b + 1) as Dir) {
    ALL_PAIRS.push([a, b] as const);
  }
}

const START_PAIR: readonly [Dir, Dir] = [1, 7]; // 双旗斜上，起势
const END_PAIR: readonly [Dir, Dir] = [3, 5]; // 双旗斜下，收势
const reserved = new Set([START_PAIR.join(','), END_PAIR.join(',')]);
const restPairs = ALL_PAIRS.filter((p) => !reserved.has(p.join(',')));

const DATA_LABELS = ['风', '林', '火', '山', '云', '雁', '关', '月'];

function buildSymbols(): SymbolDef[] {
  const list: SymbolDef[] = [
    { id: 'start', label: '启', pair: START_PAIR, kind: 'start', hint: '消息开头' },
    { id: 'end', label: '止', pair: END_PAIR, kind: 'end', hint: '消息结尾' },
  ];
  DATA_LABELS.forEach((label, i) => {
    list.push({
      id: `d${i}`,
      label,
      pair: restPairs[i],
      kind: 'data',
      dataIndex: i,
      hint: `数据符 ${label}（编号 ${i}）`,
    });
  });
  for (let d = 0; d <= 9; d++) {
    list.push({
      id: `c${d}`,
      label: String(d),
      pair: restPairs[8 + d],
      kind: 'check',
      digit: d,
      hint: `复核数字 ${d}`,
    });
  }
  return list;
}

export const SYMBOLS: SymbolDef[] = buildSymbols();

export const SYMBOL_MAP: Record<string, SymbolDef> = Object.fromEntries(
  SYMBOLS.map((s) => [s.id, s]),
);

const PAIR_LOOKUP = new Map<string, string>();
for (const s of SYMBOLS) {
  const key = [...s.pair].sort((a, b) => a - b).join(',');
  PAIR_LOOKUP.set(key, s.id);
}

export function pairKey(dirs: readonly [Dir, Dir]): string {
  return [...dirs].sort((a, b) => a - b).join(',');
}

/** 由两面旗的方向（顺序无关）查符号；不在字母表内返回 null */
export function symbolFromDirs(a: Dir, b: Dir): string | null {
  return PAIR_LOOKUP.get(pairKey([a, b])) ?? null;
}

export function symbolLabel(id: string | null | undefined): string {
  if (!id) return '？';
  return SYMBOL_MAP[id]?.label ?? '？';
}

// ---- 消息结构：启 + 4 个数据符 + 1 位复核数 + 止，共 7 拍 ----

export const FRAME_LEN = 7;
export const SLOT_ROLES = ['start', 'data', 'data', 'data', 'data', 'check', 'end'] as const;

/** 简单复核规则：四个数据符编号之和 mod 10，应等于复核位数字 */
export function checksumOf(dataIds: string[]): number | null {
  let sum = 0;
  for (const id of dataIds) {
    const s = SYMBOL_MAP[id];
    if (!s || s.kind !== 'data' || s.dataIndex === undefined) return null;
    sum += s.dataIndex;
  }
  return sum % 10;
}

export interface VerifyResult {
  ok: boolean;
  reason: string | null;
  text: string;
}

export function verifyFrame(values: Array<string | null>): VerifyResult {
  const text = values.map((v) => symbolLabel(v)).join(' ');
  if (values.length !== FRAME_LEN) {
    return { ok: false, reason: `长度应为 ${FRAME_LEN} 拍`, text };
  }
  if (values[0] !== 'start') return { ok: false, reason: '缺少开头「启」', text };
  if (values[6] !== 'end') return { ok: false, reason: '缺少结尾「止」', text };
  for (let i = 1; i <= 4; i++) {
    const s = values[i] ? SYMBOL_MAP[values[i] as string] : undefined;
    if (!s || s.kind !== 'data') {
      return { ok: false, reason: `第 ${i + 1} 拍必须是数据符`, text };
    }
  }
  const check = values[5] ? SYMBOL_MAP[values[5] as string] : undefined;
  if (!check || check.kind !== 'check' || check.digit === undefined) {
    return { ok: false, reason: '第 6 拍必须是复核数字', text };
  }
  const expected = checksumOf(values.slice(1, 5) as string[]);
  if (expected === null) return { ok: false, reason: '数据符无效', text };
  if (expected !== check.digit) {
    return {
      ok: false,
      reason: `复核不符：数据编号和 mod 10 = ${expected}，收条复核位却是 ${check.digit}`,
      text,
    };
  }
  return { ok: true, reason: null, text };
}

/** 某个值是否允许进入该槽位（防止把下一条的「启」挪来补数据槽） */
export function valueFitsRole(slot: number, value: string | null): boolean {
  if (!value) return true; // 空证据不违反角色，只是缺
  const s = SYMBOL_MAP[value];
  if (!s) return false;
  return s.kind === SLOT_ROLES[slot];
}

/** 剧本主消息：启 风 山 月 关 6 止（编号 0+3+7+6=16 → 6） */
export const CANONICAL_MESSAGE: string[] = [
  'start',
  'd0',
  'd3',
  'd7',
  'd6',
  'c6',
  'end',
];

export const CANONICAL_TEXT = CANONICAL_MESSAGE.map(symbolLabel).join(' ');
