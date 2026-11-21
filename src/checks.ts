import { keyOf } from './grid.ts';
import { buildLayout, type Edit, type Layout } from './layout.ts';
import { editOrders } from './examples.ts';
import { runSignature, simulate, verifyRound, type AmountTable, type RoundRecord } from './sim.ts';
import { amountOf, type Medium } from './units.ts';

export interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
}

function boxCells(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  layout: Layout,
  interiorOnly = false,
): string[] {
  const cells: string[] = [];
  for (let y = 0; y < layout.height; y += 1) {
    for (let x = 0; x < layout.width; x += 1) {
      const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
      const onEdge = x === x0 || x === x1 || y === y0 || y === y1;
      if (inside && (!interiorOnly || !onEdge)) cells.push(keyOf(x, y));
    }
  }
  return cells;
}

function sumState(records: RoundRecord[], cells: readonly string[], medium: Medium): number {
  let total = 0;
  for (const record of records) {
    for (const cell of cells) {
      const entry = record.ledger.get(cell);
      if (entry) total += amountOf({ heat: entry.heat.closing, fog: entry.fog.closing }, medium);
    }
  }
  return total;
}

function firstRoundWithRelease(records: RoundRecord[], medium: Medium): number | null {
  for (const record of records) {
    if (record.totals[medium].released > 0) return record.round;
  }
  return null;
}

function runSignatureOf(edits: readonly Edit[], rounds: number, initial: AmountTable): string {
  return runSignature(simulate(buildLayout(edits), rounds, initial));
}

/**
 * 四条可复核的断言：
 *  1. 密封房边界：去掉外部源后房外恒为 0；去掉内部源后房内恒为 0。
 *  2. 阀门反向：反向时零释放，翻向后有释放。
 *  3. 双源计量：两种介质分别进出，互不串账，关闭的风口零释放。
 *  4. 编辑顺序：同一布局按原序 / 反序 / 两种洗牌建立，逐轮签名完全一致。
 */
export function runChecks(
  sealed: readonly Edit[],
  valve: readonly Edit[],
  dual: readonly Edit[],
  opts: { sealedBox: { x0: number; y0: number; x1: number; y1: number } },
): CheckResult[] {
  const results: CheckResult[] = [];

  // 1) 密封房边界
  {
    const roundCount = 20;
    const insideSources = sealed.filter(
      (edit) =>
        edit.kind === 'cell' &&
        edit.content?.kind === 'source' &&
        edit.x >= opts.sealedBox.x0 &&
        edit.x <= opts.sealedBox.x1 &&
        edit.y >= opts.sealedBox.y0 &&
        edit.y <= opts.sealedBox.y1,
    );
    const outsideSources = sealed.filter(
      (edit) =>
        edit.kind === 'cell' &&
        edit.content?.kind === 'source' &&
        !(
          edit.x >= opts.sealedBox.x0 &&
          edit.x <= opts.sealedBox.x1 &&
          edit.y >= opts.sealedBox.y0 &&
          edit.y <= opts.sealedBox.y1
        ),
    );
    const walls = sealed.filter((edit) => edit.kind === 'cell' && edit.content?.kind === 'wall');

    const onlyOutside = buildLayout([...walls, ...outsideSources]);
    const outsideRecords = simulate(onlyOutside, roundCount);
    const sealedInterior = boxCells(
      opts.sealedBox.x0,
      opts.sealedBox.y0,
      opts.sealedBox.x1,
      opts.sealedBox.y1,
      onlyOutside,
      true,
    );
    const leakIn =
      sumState(outsideRecords, sealedInterior, 'heat') + sumState(outsideRecords, sealedInterior, 'fog');

    const onlyInside = buildLayout([...walls, ...insideSources]);
    const insideRecords = simulate(onlyInside, roundCount);
    const allCells = boxCells(0, 0, onlyInside.width - 1, onlyInside.height - 1, onlyInside);
    const sealedRegion = new Set(boxCells(opts.sealedBox.x0, opts.sealedBox.y0, opts.sealedBox.x1, opts.sealedBox.y1, onlyInside));
    const outsideCells = allCells.filter((cell) => !sealedRegion.has(cell));
    const leakOut =
      sumState(insideRecords, outsideCells, 'heat') + sumState(insideRecords, outsideCells, 'fog');

    const balanced = insideRecords.every((record) => verifyRound(record).length === 0);
    const noVent = insideRecords.every((record) => record.totals.heat.released === 0 && record.totals.fog.released === 0);
    results.push({
      id: 'sealed-boundary',
      title: '密封房边界零穿透',
      passed: leakIn === 0 && leakOut === 0 && balanced && noVent,
      detail: `${roundCount} 轮后：外部源进房 ${leakIn} mU，内部源出房 ${leakOut} mU，风口释放 ${insideRecords.reduce(
        (sum, record) => sum + record.totals.heat.released + record.totals.fog.released,
        0,
      )} mU，账目${balanced ? '平衡' : '不平'}`,
    });
  }

  // 2) 阀门反向
  {
    const closed = simulate(buildLayout(valve), 20);
    const closedRelease = closed.reduce(
      (sum, record) => sum + record.totals.heat.released + record.totals.fog.released,
      0,
    );
    const flippedLayout = buildLayout(valve);
    flippedLayout.setValve(keyOf(6, 4), keyOf(7, 4), true);
    const flipped = simulate(flippedLayout, 20);
    const flippedRelease = flipped[flipped.length - 1]?.totals.heat.released ?? 0;
    const firstFlippedRelease = firstRoundWithRelease(flipped, 'heat');
    results.push({
      id: 'valve-direction',
      title: '单向阀反向阻断、翻向后恢复',
      passed: closedRelease === 0 && flippedRelease > 0 && firstFlippedRelease !== null,
      detail: `反向 20 轮释放 ${closedRelease} mHU；翻向后 20 轮末轮释放 ${flippedRelease} mHU，首次释放发生在第 ${firstFlippedRelease ?? '—'} 轮`,
    });
  }

  // 3) 双源计量
  {
    const roundCount = 20;
    const records = simulate(buildLayout(dual), roundCount);
    const heatReleased = records.reduce((sum, record) => sum + record.totals.heat.released, 0);
    const fogReleased = records.reduce((sum, record) => sum + record.totals.fog.released, 0);
    const closedVent = records.reduce((sum, record) => {
      const entry = record.ledger.get(keyOf(7, 5));
      return sum + (entry?.heat.released ?? 0) + (entry?.fog.released ?? 0);
    }, 0);

    // 只保留热源：雾的注入/存量/释放必须全为 0。
    const heatOnlyEdits = dual.filter(
      (edit) => !(edit.kind === 'cell' && edit.content?.kind === 'source' && edit.content.medium === 'fog'),
    );
    const heatOnly = simulate(buildLayout(heatOnlyEdits), 12);
    const fogTotals = heatOnly.reduce(
      (sum, record) => sum + record.totals.fog.injected + record.totals.fog.inMap + record.totals.fog.released,
      0,
    );
    const balanced = records.every((record) => verifyRound(record).length === 0);
    results.push({
      id: 'dual-accounting',
      title: '双源按介质分别计量',
      passed:
        heatReleased > 0 && fogReleased > 0 && closedVent === 0 && fogTotals === 0 && balanced,
      detail: `${roundCount} 轮：热量释放 ${heatReleased} mHU，雾释放 ${fogReleased} mFU；关闭风口释放 ${closedVent}；仅热源时雾总量 ${fogTotals}`,
    });
  }

  // 4) 编辑顺序无关
  {
    const cases = [
      { name: '密封房', edits: sealed, rounds: 10 },
      { name: '阀门反向', edits: valve, rounds: 10 },
      { name: '双源', edits: dual, rounds: 10 },
    ];
    const details: string[] = [];
    let passed = true;
    for (const item of cases) {
      const signatures = editOrders(item.edits).map((order) =>
        runSignatureOf(order.edits, item.rounds, new Map()),
      );
      const hashes = editOrders(item.edits).map((order) => buildLayout(order.edits).hash());
      const same = new Set(signatures).size === 1 && new Set(hashes).size === 1;
      passed &&= same;
      details.push(`${item.name}: ${same ? '一致' : '不一致'} (${hashes[0]})`);
    }
    results.push({
      id: 'edit-order',
      title: '编辑顺序无关',
      passed,
      detail: `${details.join('；')}（各 4 种编辑顺序，逐轮签名逐字节比较）`,
    });
  }

  return results;
}


