import { CARDINALS, compareKeys, inBounds, keyOf, parseKey } from './grid.ts';
import type { Layout } from './layout.ts';
import {
  MEDIA,
  addAmount,
  amountOf,
  setAmount,
  zeroAmounts,
  type Amounts,
  type Medium,
} from './units.ts';

/**
 * 每轮结算顺序固定为：来源注入 → 扩散 → 风口释放。
 * 全部量以整数 mHU / mFU 存储，所有乘法后向下取整，单格每轮转出比例之和 < 100%，
 * 因此不会出现负库存，且同样的输入永远得到同样的整数结果。
 */

/** 每个可通行方向每轮转出的千分比。热量比雾更易扩散。 */
export const DIFFUSION_RATIO: Record<Medium, number> = {
  heat: 200,
  fog: 120,
};

/** 开启的风口每轮最多向界外释放的量（m 单位）。 */
export const VENT_RATE: Record<Medium, number> = {
  heat: 2_000,
  fog: 1_200,
};

const RATIO_DEN = 1_000;

export type AmountTable = Map<string, Amounts>;

export interface Flow {
  readonly cell: string;
  readonly amount: number;
}

export interface CellLedger {
  readonly medium: Medium;
  readonly opening: number;
  readonly injected: number;
  readonly inflows: readonly Flow[];
  readonly outflows: readonly Flow[];
  readonly released: number;
  readonly closing: number;
}

export interface MediumTotals {
  readonly opening: number;
  readonly injected: number;
  readonly diffused: number;
  readonly released: number;
  readonly cleared: number;
  readonly inMap: number;
}

export interface RoundRecord {
  readonly round: number;
  readonly layoutHash: string;
  readonly layout: Layout;
  readonly state: AmountTable;
  readonly ledger: ReadonlyMap<string, Record<Medium, CellLedger>>;
  /** 因格子变成墙而被清除的量（只有在历史状态上改建时才可能非空）。 */
  readonly cleared: ReadonlyArray<{ cell: string; amounts: Amounts }>;
  readonly totals: Record<Medium, MediumTotals>;
}

export function cloneState(state: AmountTable): AmountTable {
  const next: AmountTable = new Map();
  for (const [key, amounts] of state) next.set(key, { ...amounts });
  return next;
}

export function stateAmount(state: AmountTable, key: string, medium: Medium): number {
  const amounts = state.get(key);
  return amounts ? amountOf(amounts, medium) : 0;
}

export function totalOfState(state: AmountTable, medium: Medium): number {
  let total = 0;
  for (const amounts of state.values()) total += amountOf(amounts, medium);
  return total;
}

/** 边是否允许介质通过：墙永远阻断；单向阀只放行一个方向。 */
export function edgeAllows(layout: Layout, from: string, to: string): boolean {
  const fromCell = layout.getCellByKey(from);
  const toCell = layout.getCellByKey(to);
  if (fromCell?.kind === 'wall' || toCell?.kind === 'wall') return false;
  const valve = layout.getValve(from, to);
  if (!valve) return true;
  return from === valve.a ? valve.allowAtoB : !valve.allowAtoB;
}

interface OutflowDraft {
  readonly from: string;
  readonly to: string;
  readonly medium: Medium;
  readonly amount: number;
}

export function simulateRound(
  layout: Layout,
  previous: AmountTable,
  round: number,
): RoundRecord {
  const passable: string[] = [];
  for (let y = 0; y < layout.height; y += 1) {
    for (let x = 0; x < layout.width; x += 1) {
      if (layout.isPassable(x, y)) passable.push(keyOf(x, y));
    }
  }
  const passableSet = new Set(passable);

  const cleared: Array<{ cell: string; amounts: Amounts }> = [];
  for (const [key, amounts] of previous) {
    if (!passableSet.has(key) && (amounts.heat !== 0 || amounts.fog !== 0)) {
      cleared.push({ cell: key, amounts: { ...amounts } });
    }
  }
  cleared.sort((c1, c2) => compareKeys(c1.cell, c2.cell));

  const opening: AmountTable = new Map();
  for (const key of passable) {
    const prev = previous.get(key);
    opening.set(key, prev ? { ...prev } : zeroAmounts());
  }

  const ledger = new Map<string, Record<Medium, CellLedger>>();
  const mutableLedger = new Map<string, Record<Medium, CellLedger>>();
  for (const key of passable) {
    const opened = opening.get(key) ?? zeroAmounts();
    const entry: Record<Medium, CellLedger> = {
      heat: { medium: 'heat', opening: opened.heat, injected: 0, inflows: [], outflows: [], released: 0, closing: 0 },
      fog: { medium: 'fog', opening: opened.fog, injected: 0, inflows: [], outflows: [], released: 0, closing: 0 },
    };
    mutableLedger.set(key, entry);
    ledger.set(key, entry);
  }

  // 1) 来源注入
  const base: AmountTable = new Map();
  for (const key of passable) base.set(key, { ...(opening.get(key) ?? zeroAmounts()) });
  for (const { key, content } of layout.sortedCells()) {
    if (content.kind !== 'source' || !passableSet.has(key)) continue;
    const amounts = base.get(key);
    if (!amounts) continue;
    addAmount(amounts, content.medium, content.amount);
    const entry = mutableLedger.get(key);
    if (entry) entry[content.medium] = { ...entry[content.medium], injected: content.amount };
  }

  // 2) 扩散：所有格按同一份“注入后”快照计算转出，先收集后统一入账
  const drafts: OutflowDraft[] = [];
  for (const from of passable) {
    const { x, y } = parseKey(from);
    const amounts = base.get(from);
    if (!amounts) continue;
    for (const dir of CARDINALS) {
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      if (!inBounds(nx, ny, layout.width, layout.height)) continue;
      const to = keyOf(nx, ny);
      if (!passableSet.has(to) || !edgeAllows(layout, from, to)) continue;
      for (const medium of MEDIA) {
        const moved = Math.floor((amountOf(amounts, medium) * DIFFUSION_RATIO[medium]) / RATIO_DEN);
        if (moved > 0) drafts.push({ from, to, medium, amount: moved });
      }
    }
  }

  const inflowSums: AmountTable = new Map();
  const outflowSums: AmountTable = new Map();
  for (const key of passable) {
    inflowSums.set(key, zeroAmounts());
    outflowSums.set(key, zeroAmounts());
  }
  for (const draft of drafts) {
    addAmount(outflowSums.get(draft.from) ?? zeroAmounts(), draft.medium, draft.amount);
    addAmount(inflowSums.get(draft.to) ?? zeroAmounts(), draft.medium, draft.amount);
    const fromEntry = mutableLedger.get(draft.from);
    const toEntry = mutableLedger.get(draft.to);
    if (fromEntry) {
      fromEntry[draft.medium] = {
        ...fromEntry[draft.medium],
        outflows: [...fromEntry[draft.medium].outflows, { cell: draft.to, amount: draft.amount }],
      };
    }
    if (toEntry) {
      toEntry[draft.medium] = {
        ...toEntry[draft.medium],
        inflows: [...toEntry[draft.medium].inflows, { cell: draft.from, amount: draft.amount }],
      };
    }
  }
  for (const key of passable) {
    const entry = mutableLedger.get(key);
    if (!entry) continue;
    for (const medium of MEDIA) {
      entry[medium] = {
        ...entry[medium],
        inflows: [...entry[medium].inflows].sort((f1, f2) => compareKeys(f1.cell, f2.cell)),
        outflows: [...entry[medium].outflows].sort((f1, f2) => compareKeys(f1.cell, f2.cell)),
      };
    }
  }

  // 3) 风口释放
  const state: AmountTable = new Map();
  const released: Record<Medium, number> = { heat: 0, fog: 0 };
  for (const key of passable) {
    const baseAmounts = base.get(key) ?? zeroAmounts();
    const inSum = inflowSums.get(key) ?? zeroAmounts();
    const outSum = outflowSums.get(key) ?? zeroAmounts();
    const content = layout.getCellByKey(key);
    const vent = content?.kind === 'vent' && content.open ? content : null;
    const entry = mutableLedger.get(key);

    const closing = zeroAmounts();
    for (const medium of MEDIA) {
      let value = amountOf(baseAmounts, medium) - amountOf(outSum, medium) + amountOf(inSum, medium);
      if (value < 0) value = 0;
      let vented = 0;
      if (vent && (vent.medium === 'both' || vent.medium === medium)) {
        vented = Math.min(value, VENT_RATE[medium]);
        value -= vented;
        released[medium] += vented;
      }
      setAmount(closing, medium, value);
      if (entry) {
        entry[medium] = { ...entry[medium], released: vented, closing: value };
      }
    }
    if (closing.heat !== 0 || closing.fog !== 0) state.set(key, closing);
  }

  const totals: Record<Medium, MediumTotals> = {
    heat: { opening: 0, injected: 0, diffused: 0, released: 0, cleared: 0, inMap: 0 },
    fog: { opening: 0, injected: 0, diffused: 0, released: 0, cleared: 0, inMap: 0 },
  };
  for (const medium of MEDIA) {
    let openingTotal = 0;
    for (const amounts of opening.values()) openingTotal += amountOf(amounts, medium);
    let injected = 0;
    for (const entry of mutableLedger.values()) injected += entry[medium].injected;
    let diffused = 0;
    for (const draft of drafts) if (draft.medium === medium) diffused += draft.amount;
    let clearedTotal = 0;
    for (const item of cleared) clearedTotal += amountOf(item.amounts, medium);
    totals[medium] = {
      opening: openingTotal,
      injected,
      diffused,
      released: released[medium],
      cleared: clearedTotal,
      inMap: totalOfState(state, medium),
    };
  }

  return {
    round,
    layoutHash: layout.hash(),
    layout: layout.clone(),
    state,
    ledger,
    cleared,
    totals,
  };
}

export function simulate(
  layout: Layout,
  rounds: number,
  initial: AmountTable = new Map(),
): RoundRecord[] {
  const records: RoundRecord[] = [];
  let state = cloneState(initial);
  for (let round = 1; round <= rounds; round += 1) {
    const record = simulateRound(layout, state, round);
    records.push(record);
    state = record.state;
  }
  return records;
}

/** 每轮账目必须闭合：期初 + 注入 + 流入 − 流出 − 释放 = 期末。 */
export function verifyRound(record: RoundRecord): string[] {
  const errors: string[] = [];
  for (const [key, entry] of record.ledger) {
    for (const medium of MEDIA) {
      const cell = entry[medium];
      const inflow = cell.inflows.reduce((sum, f) => sum + f.amount, 0);
      const outflow = cell.outflows.reduce((sum, f) => sum + f.amount, 0);
      const expected = cell.opening + cell.injected + inflow - outflow - cell.released;
      if (expected !== cell.closing) {
        errors.push(`${key}/${medium} 格子账目不平: ${expected} != ${cell.closing}`);
      }
      if (cell.closing < 0) errors.push(`${key}/${medium} 出现负库存`);
    }
  }
  for (const medium of MEDIA) {
    const total = record.totals[medium];
    // cleared 属于“上一轮存量中落在墙里、不再进入本轮结算”的部分，单独列出。
    if (total.opening + total.injected !== total.inMap + total.released) {
      errors.push(
        `${medium} 全局账目不平: 期初 ${total.opening} + 注入 ${total.injected} ≠ 存量 ${total.inMap} + 释放 ${total.released}`,
      );
    }
  }
  return errors;
}

/**
 * 跨轮连续性：把连续几轮当成一条账链检查。
 *  - 每轮内部账目闭合（期初 + 注入 + 流入 − 流出 − 释放 = 期末）
 *  - 上一轮期末 = 本轮期初（对仍可通行的格子）
 *  - 因改建变成墙的格子：其上一轮期末应全部记入本轮 cleared
 *  - 整条链上：总注入 = 当前存量 + 累计释放 + 累计清除
 */
export function verifySequence(records: readonly RoundRecord[]): string[] {
  const errors: string[] = [];
  for (const record of records) errors.push(...verifyRound(record));

  for (let i = 1; i < records.length; i += 1) {
    const previous = records[i - 1]!;
    const current = records[i]!;
    const clearedByCell = new Map(current.cleared.map((item) => [item.cell, item.amounts]));
    for (const [key, entry] of current.ledger) {
      const before = previous.state.get(key);
      for (const medium of MEDIA) {
        const previousClosing = before ? amountOf(before, medium) : 0;
        if (entry[medium].opening !== previousClosing) {
          errors.push(
            `R${previous.round}→R${current.round} ${key}/${medium} 期初不连续: 上轮期末 ${previousClosing} ≠ 本轮期初 ${entry[medium].opening}`,
          );
        }
      }
    }
    for (const [key, amounts] of clearedByCell) {
      const before = previous.state.get(key);
      for (const medium of MEDIA) {
        const previousClosing = before ? amountOf(before, medium) : 0;
        if (amountOf(amounts, medium) !== previousClosing) {
          errors.push(
            `R${current.round} ${key}/${medium} 清除量 ${amountOf(amounts, medium)} ≠ 上轮期末 ${previousClosing}`,
          );
        }
      }
    }
  }

  for (const medium of MEDIA) {
    let injected = 0;
    let released = 0;
    let cleared = 0;
    for (const record of records) {
      injected += record.totals[medium].injected;
      released += record.totals[medium].released;
      cleared += record.totals[medium].cleared;
    }
    const first = records[0];
    const last = records[records.length - 1];
    // 链首的期初存量是外部带入的；链首清除量也来自链外状态，不重复计入。
    const inheritedInventory = first ? first.totals[medium].opening : 0;
    const clearedAfterStart = cleared - (first ? first.totals[medium].cleared : 0);
    const inMap = last ? last.totals[medium].inMap : 0;
    if (inheritedInventory + injected !== inMap + released + clearedAfterStart) {
      errors.push(
        `${medium} 全程账目不平: 链首期初 ${inheritedInventory} + 注入 ${injected} ≠ 存量 ${inMap} + 释放 ${released} + 链中清除 ${clearedAfterStart}`,
      );
    }
  }
  return errors;
}

/** 一轮的完整规范签名（含布局哈希、格级账目），用于比较两次演算。 */
export function roundSignature(record: RoundRecord): string {
  const lines: string[] = [`round=${record.round}`, `layout=${record.layoutHash}`];
  for (const medium of MEDIA) {
    const t = record.totals[medium];
    lines.push(
      `${medium}:open=${t.opening};inj=${t.injected};diff=${t.diffused};rel=${t.released};clr=${t.cleared};in=${t.inMap}`,
    );
  }
  for (const item of record.cleared) {
    lines.push(`cleared:${item.cell}:${item.amounts.heat}/${item.amounts.fog}`);
  }
  for (const key of [...record.ledger.keys()].sort(compareKeys)) {
    const entry = record.ledger.get(key);
    if (!entry) continue;
    for (const medium of MEDIA) {
      const cell = entry[medium];
      lines.push(
        `${key}/${medium}:${cell.opening},${cell.injected},` +
          `${cell.inflows.map((f) => `${f.cell}+${f.amount}`).join('|')},` +
          `${cell.outflows.map((f) => `${f.cell}-${f.amount}`).join('|')},` +
          `${cell.released},${cell.closing}`,
      );
    }
  }
  return lines.join('\n');
}

export function runSignature(records: readonly RoundRecord[]): string {
  return records.map(roundSignature).join('\n---\n');
}

