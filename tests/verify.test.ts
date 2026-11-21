import { describe, expect, it } from 'vitest';
import { CARDINALS, keyOf } from '../src/grid.ts';
import { Layout, buildLayout, type Edit } from '../src/layout.ts';
import { EXAMPLES, editOrders, exampleById, shuffleEdits } from '../src/examples.ts';
import { runChecks } from '../src/checks.ts';
import { SimulationSession, layoutToEdits } from '../src/session.ts';
import {
  DIFFUSION_RATIO,
  VENT_RATE,
  edgeAllows,
  runSignature,
  simulate,
  simulateRound,
  verifyRound,
  verifySequence,
  type AmountTable,
} from '../src/sim.ts';
import { UNIT_SCALE } from '../src/units.ts';

const sealed = exampleById('sealed-room');
const valve = exampleById('valve-reverse');
const dual = exampleById('dual-source');
const SEALED_BOX = { x0: 3, y0: 2, x1: 9, y1: 8 };

function sumState(state: AmountTable): { heat: number; fog: number } {
  let heat = 0;
  let fog = 0;
  for (const amounts of state.values()) {
    heat += amounts.heat;
    fog += amounts.fog;
  }
  return { heat, fog };
}

describe('布局规范化', () => {
  it('四种编辑顺序得到同一布局哈希与同一序列化', () => {
    for (const example of EXAMPLES) {
      const orders = editOrders(example.edits);
      const hashes = new Set(orders.map((order) => buildLayout(order.edits).hash()));
      const serialized = new Set(orders.map((order) => buildLayout(order.edits).serialize()));
      expect(hashes.size).toBe(1);
      expect(serialized.size).toBe(1);
    }
  });

  it('单向阀写入方向与端点顺序无关', () => {
    const forward = buildLayout([
      { kind: 'valve', a: '4,4', b: '5,4', allowAtoB: true },
    ]);
    const backward = buildLayout([
      { kind: 'valve', a: '5,4', b: '4,4', allowAtoB: false },
    ]);
    expect(forward.hash()).toBe(backward.hash());
    expect(edgeAllows(forward, '4,4', '5,4')).toBe(true);
    expect(edgeAllows(forward, '5,4', '4,4')).toBe(false);
    expect(edgeAllows(backward, '4,4', '5,4')).toBe(true);
  });

  it('删除再重建同一格回到同一哈希', () => {
    const a = buildLayout([
      { kind: 'cell', x: 5, y: 5, content: { kind: 'wall' } },
      { kind: 'cell', x: 5, y: 5, content: null },
      { kind: 'cell', x: 5, y: 5, content: { kind: 'vent', medium: 'both', open: true } },
    ]);
    const b = buildLayout([
      { kind: 'cell', x: 5, y: 5, content: { kind: 'vent', medium: 'both', open: true } },
    ]);
    expect(a.hash()).toBe(b.hash());
  });
});

describe('随机布局的账目不变量', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('随机布局连续 20 轮的逐格与跨轮账目都闭合', () => {
    const random = mulberry32(0x5eed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    for (let trial = 0; trial < 40; trial += 1) {
      const layout = new Layout(10, 8);
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 10; x += 1) {
          const roll = random();
          if (roll < 0.12) layout.setCell(x, y, { kind: 'wall' });
          else if (roll < 0.18)
            layout.setCell(x, y, {
              kind: 'source',
              medium: pick(['heat', 'fog'] as const),
              amount: 500 + Math.floor(random() * 8_000),
            });
          else if (roll < 0.26)
            layout.setCell(x, y, {
              kind: 'vent',
              medium: pick(['heat', 'fog', 'both'] as const),
              open: random() < 0.5,
            });
        }
      }
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 9; x += 1) {
          if (random() < 0.3) layout.setValve(keyOf(x, y), keyOf(x + 1, y), random() < 0.5);
        }
      }
      const records = simulate(layout, 20);
      expect(verifySequence(records), `trial ${trial}`).toEqual([]);
    }
  });

  it('冲突无关的随机编辑集：四种顺序得到同一哈希与同一演算签名', () => {
    const random = mulberry32(0xc0ffee);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const shuffle = (edits: Edit[]): Edit[] => {
      const arr = [...edits];
      for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      return arr;
    };
    for (let trial = 0; trial < 25; trial += 1) {
      const usedCells = new Set<string>();
      const usedEdges = new Set<string>();
      const edits: Edit[] = [];
      let guard = 0;
      while (edits.length < 30 && guard < 500) {
        guard += 1;
        if (random() < 0.65) {
          const x = Math.floor(random() * 10);
          const y = Math.floor(random() * 8);
          const key = keyOf(x, y);
          if (usedCells.has(key)) continue;
          usedCells.add(key);
          const roll = random();
          edits.push({
            kind: 'cell',
            x,
            y,
            content:
              roll < 0.3
                ? null
                : roll < 0.55
                  ? { kind: 'wall' }
                  : roll < 0.75
                    ? { kind: 'source', medium: pick(['heat', 'fog'] as const), amount: 1_000 }
                    : { kind: 'vent', medium: pick(['heat', 'fog', 'both'] as const), open: random() < 0.5 },
          });
        } else {
          const x = Math.floor(random() * 9);
          const y = Math.floor(random() * 8);
          const edge = [keyOf(x, y), keyOf(x + 1, y)].sort().join('|');
          if (usedEdges.has(edge)) continue;
          usedEdges.add(edge);
          edits.push({ kind: 'valve', a: keyOf(x, y), b: keyOf(x + 1, y), allowAtoB: random() < 0.5 });
        }
      }
      const orders = [edits, shuffle(edits), [...edits].reverse(), shuffle(shuffle(edits))];
      const layouts = orders.map((order) => buildLayout(order));
      expect(new Set(layouts.map((layout) => layout.hash())).size, `trial ${trial}`).toBe(1);
      expect(new Set(layouts.map((layout) => runSignature(simulate(layout, 8)))).size).toBe(1);
    }
  });
});

describe('每轮结算与计量', () => {
  it('所有示例的每一轮账目都闭合', () => {
    for (const example of EXAMPLES) {
      const records = simulate(buildLayout(example.edits), example.rounds);
      for (const record of records) {
        expect(verifyRound(record)).toEqual([]);
        for (const medium of ['heat', 'fog'] as const) {
          const t = record.totals[medium];
          expect(t.opening + t.injected).toBe(t.inMap + t.released);
        }
      }
    }
  });

  it('跨轮连续：上轮期末 = 本轮期初，全程注入 = 存量 + 释放 + 清除', () => {
    for (const example of EXAMPLES) {
      const records = simulate(buildLayout(example.edits), example.rounds);
      expect(verifySequence(records)).toEqual([]);
    }
  });

  it('把已积存介质的位置改成墙时，量记入 cleared 且全程账目仍平', () => {
    // 会话层改布局会从起点重演，所以用一轮“带存量开局”的结算直接验证清除账。
    const layout = buildLayout([
      { kind: 'cell', x: 5, y: 5, content: { kind: 'wall' } },
      { kind: 'cell', x: 6, y: 5, content: { kind: 'source', medium: 'heat', amount: 3_000 } },
    ]);
    const state: AmountTable = new Map([
      [keyOf(5, 5), { heat: 4_200, fog: 700 }],
    ]);
    const record = simulateRound(layout, state, 1);
    expect(record.totals.heat.cleared).toBe(4_200);
    expect(record.totals.fog.cleared).toBe(700);
    expect(record.cleared).toEqual([
      { cell: keyOf(5, 5), amounts: { heat: 4_200, fog: 700 } },
    ]);
    expect(record.totals.heat.inMap).toBe(3_000);
    expect(verifyRound(record)).toEqual([]);
    expect(verifySequence([record])).toEqual([]);
  });

  it('从历史分叉后把有介质的格子封成墙，首个新轮次记入清除', () => {
    const session = SimulationSession.fromExampleId('sealed-room');
    session.advance(6);
    session.setViewRound(6);
    session.fork();
    const base = session.active();
    const target = [...base.baseState.entries()].find(([, amounts]) => amounts.heat > 0);
    expect(target).toBeDefined();
    const [key] = target!;
    const [x, y] = key.split(',').map(Number) as [number, number];
    session.updateLayout((layout) => layout.setCell(x, y, { kind: 'wall' }));
    session.advance(1);
    const record = session.active().records[0]!;
    expect(record.cleared.some((item) => item.cell === key)).toBe(true);
    expect(session.ledgerErrors()).toEqual([]);
  });

  it('每个格子同时满足期初 + 注入 + 流入 − 流出 − 释放 = 期末', () => {
    const records = simulate(buildLayout(dual.edits), 16);
    for (const record of records) {
      for (const [, entry] of record.ledger) {
        for (const medium of ['heat', 'fog'] as const) {
          const cell = entry[medium];
          const inflow = cell.inflows.reduce((sum, f) => sum + f.amount, 0);
          const outflow = cell.outflows.reduce((sum, f) => sum + f.amount, 0);
          expect(cell.opening + cell.injected + inflow - outflow - cell.released).toBe(cell.closing);
          expect(cell.closing).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('单价整数刻度：源注入量就是每轮固定增量', () => {
    const layout = buildLayout([{ kind: 'cell', x: 5, y: 5, content: { kind: 'source', medium: 'heat', amount: 6_000 } }]);
    const records = simulate(layout, 5);
    expect(records.map((record) => record.totals.heat.injected)).toEqual([6_000, 6_000, 6_000, 6_000, 6_000]);
    // 只有单格时无法扩散（没有相邻格），存量线性增长
    expect(records[4]!.totals.heat.inMap).toBe(30_000);
  });

  it('扩散按千分比向下取整，热量比雾扩散快', () => {
    expect(DIFFUSION_RATIO.heat).toBeGreaterThan(DIFFUSION_RATIO.fog);
    const layout = buildLayout([
      { kind: 'cell', x: 5, y: 5, content: { kind: 'source', medium: 'heat', amount: 1_000 } },
      { kind: 'cell', x: 6, y: 5, content: { kind: 'source', medium: 'fog', amount: 1_000 } },
    ]);
    const record = simulateRound(layout, new Map(), 1);
    const east = record.ledger.get(keyOf(6, 5));
    expect(east?.heat.inflows).toEqual([{ cell: keyOf(5, 5), amount: 200 }]);
    const west = record.ledger.get(keyOf(5, 5));
    expect(west?.fog.inflows).toEqual([{ cell: keyOf(6, 5), amount: 120 }]);
  });

  it('同步扩散：同一轮内所有格使用同一份快照，不受遍历顺序影响', () => {
    const layout = buildLayout([
      { kind: 'cell', x: 4, y: 4, content: { kind: 'source', medium: 'heat', amount: 10_000 } },
    ]);
    const record = simulateRound(layout, new Map(), 1);
    const center = record.ledger.get(keyOf(4, 4))!;
    // 四面各转出 20%，中心保留 20%（无墙、无阀）
    expect(center.heat.outflows.map((flow) => flow.amount)).toEqual([2_000, 2_000, 2_000, 2_000]);
    expect(center.heat.closing).toBe(10_000 - 8_000);
  });

  it('风口先扩散后释放：释放量取扩散后的存量，关闭时零释放', () => {
    const closed = buildLayout([
      { kind: 'cell', x: 5, y: 5, content: { kind: 'vent', medium: 'heat', open: false } },
    ]);
    expect(
      simulateRound(closed, new Map([[keyOf(5, 5), { heat: 9_000, fog: 9_000 }]]), 1).totals.heat.released,
    ).toBe(0);

    const open = buildLayout([
      { kind: 'cell', x: 5, y: 5, content: { kind: 'vent', medium: 'heat', open: true } },
    ]);
    const record = simulateRound(open, new Map([[keyOf(5, 5), { heat: 9_000, fog: 9_000 }]]), 1);
    const cell = record.ledger.get(keyOf(5, 5))!;
    // 四邻各分走 20%（邻格为空，没有回填），扩散后本格剩 1800；
    // 风口释放发生在扩散之后，因此只能释放这 1800，而不是上限 2000。
    expect(cell.heat.outflows).toHaveLength(4);
    expect(cell.heat.outflows.map((flow) => flow.amount)).toEqual([1_800, 1_800, 1_800, 1_800]);
    expect(record.totals.heat.released).toBe(1_800);
    expect(record.totals.fog.released).toBe(0);
    expect(cell.heat.closing).toBe(0);
    expect(VENT_RATE.heat).toBe(2_000);
    // 雾风口开启时，热量完全不受影响
    const fogOpen = buildLayout([
      { kind: 'cell', x: 5, y: 5, content: { kind: 'vent', medium: 'fog', open: true } },
    ]);
    const fogRecord = simulateRound(fogOpen, new Map([[keyOf(5, 5), { heat: 9_000, fog: 9_000 }]]), 1);
    expect(fogRecord.totals.heat.released).toBe(0);
    expect(fogRecord.totals.fog.released).toBe(VENT_RATE.fog);
  });

  it('墙阻断所有方向，风口可通行但不漏到界外', () => {
    const walled = buildLayout([
      { kind: 'cell', x: 5, y: 5, content: { kind: 'source', medium: 'heat', amount: 5_000 } },
      ...CARDINALS.map((dir) => ({
        kind: 'cell' as const,
        x: 5 + dir.dx,
        y: 5 + dir.dy,
        content: { kind: 'wall' as const },
      })),
    ]);
    const record = simulateRound(walled, new Map(), 1);
    expect(record.totals.heat.diffused).toBe(0);
    expect(record.totals.heat.inMap).toBe(5_000);
  });
});

describe('边界：密封房', () => {
  it('外部源不会渗入密封房，内部源不会漏出', () => {
    const layout = buildLayout(sealed.edits);
    const records = simulate(layout, 25);
    const insideSources = sealed.edits.filter(
      (edit) => edit.kind === 'cell' && edit.content?.kind === 'source' && edit.x <= SEALED_BOX.x1,
    );
    const outsideSources = sealed.edits.filter(
      (edit) => edit.kind === 'cell' && edit.content?.kind === 'source' && edit.x > SEALED_BOX.x1,
    );
    const walls = sealed.edits.filter((edit) => edit.kind === 'cell' && edit.content?.kind === 'wall');

    const onlyOutside = simulate(buildLayout([...walls, ...outsideSources]), 25);
    for (const record of onlyOutside) {
      for (let y = SEALED_BOX.y0; y <= SEALED_BOX.y1; y += 1) {
        for (let x = SEALED_BOX.x0; x <= SEALED_BOX.x1; x += 1) {
          const entry = record.ledger.get(keyOf(x, y));
          if (!entry) continue;
          expect(entry.fog.closing).toBe(0);
          expect(entry.heat.closing).toBe(0);
        }
      }
    }

    const onlyInside = simulate(buildLayout([...walls, ...insideSources]), 25);
    for (const record of onlyInside) {
      for (const [key, entry] of record.ledger) {
        const [x, y] = key.split(',').map(Number) as [number, number];
        const inside = x > SEALED_BOX.x0 && x < SEALED_BOX.x1 && y > SEALED_BOX.y0 && y < SEALED_BOX.y1;
        if (!inside) {
          expect(entry.heat.closing).toBe(0);
          expect(entry.fog.closing).toBe(0);
        }
      }
    }
    expect(records.length).toBe(25);
  });

  it('密封房内热量与雾各自只由自己的源累积', () => {
    const layout = buildLayout(sealed.edits);
    const records = simulate(layout, 10);
    const final = records[9]!;
    // 内部热源 6 HU/轮 + 外部雾源 4 HU/轮... 这里只核对热量的注入来源固定为房内热源
    expect(final.totals.heat.injected).toBe(6_000);
    expect(final.totals.fog.injected).toBe(8_000);
    expect(final.totals.heat.released).toBe(0);
    expect(final.totals.fog.released).toBe(0);
    const sums = sumState(final.state);
    expect(sums.heat).toBe(60_000);
    expect(sums.fog).toBe(80_000);
  });
});

describe('边界：阀门反向', () => {
  it('反向阀阻断热量出房，翻向后恢复通行并释放', () => {
    const closed = simulate(buildLayout(valve.edits), 20);
    expect(closed[19]!.totals.heat.released).toBe(0);
    expect(closed[19]!.totals.heat.inMap).toBe(120_000);
    expect(closed[19]!.ledger.get(keyOf(9, 4))?.heat.closing).toBe(0);

    const flipped = buildLayout(valve.edits);
    flipped.setValve(keyOf(6, 4), keyOf(7, 4), true);
    const records = simulate(flipped, 20);
    const firstRelease = records.find((record) => record.totals.heat.released > 0);
    expect(firstRelease).toBeDefined();
    expect(records[19]!.totals.heat.released).toBeGreaterThan(0);
    // 通路打通后，阀门两端应当互相交换热量
    const door = records[19]!.ledger.get(keyOf(7, 4));
    expect(door?.heat.inflows.some((flow) => flow.cell === keyOf(6, 4))).toBe(true);
  });

  it('单向阀只改方向，不改变系统总注入', () => {
    const a = simulate(buildLayout(valve.edits), 12);
    const flipped = buildLayout(valve.edits);
    flipped.setValve(keyOf(6, 4), keyOf(7, 4), true);
    const b = simulate(flipped, 12);
    const injA = a.reduce((sum, record) => sum + record.totals.heat.injected, 0);
    const injB = b.reduce((sum, record) => sum + record.totals.heat.injected, 0);
    expect(injA).toBe(injB);
    for (const record of [...a, ...b]) expect(verifyRound(record)).toEqual([]);
  });
});

describe('双源计量', () => {
  it('两种介质分别释放，关闭的双介质风口零释放', () => {
    const records = simulate(buildLayout(dual.edits), 20);
    const last = records[19]!;
    expect(last.totals.heat.released).toBe(VENT_RATE.heat);
    expect(last.totals.fog.released).toBe(VENT_RATE.fog);
    const closedVent = records.reduce((sum, record) => {
      const entry = record.ledger.get(keyOf(7, 5));
      return sum + (entry?.heat.released ?? 0) + (entry?.fog.released ?? 0);
    }, 0);
    expect(closedVent).toBe(0);
  });

  it('仅保留热源时，雾的注入 / 存量 / 释放都为 0', () => {
    const heatOnly = dual.edits.filter(
      (edit) => !(edit.kind === 'cell' && edit.content?.kind === 'source' && edit.content.medium === 'fog'),
    );
    const records = simulate(buildLayout(heatOnly), 15);
    for (const record of records) {
      expect(record.totals.fog.injected).toBe(0);
      expect(record.totals.fog.inMap).toBe(0);
      expect(record.totals.fog.released).toBe(0);
    }
  });

  it('热与雾的扩散系数不同，因此同轮到达距离不同', () => {
    const layout = buildLayout(dual.edits);
    const record = simulate(layout, 4)[3]!;
    expect(record.totals.heat.diffused).not.toBe(record.totals.fog.diffused);
  });
});

describe('验证命令背后的四条断言', () => {
  it('runChecks 全部通过', () => {
    const results = runChecks(sealed.edits, valve.edits, dual.edits, { sealedBox: SEALED_BOX });
    for (const result of results) {
      expect(result.passed, `${result.id}: ${result.detail}`).toBe(true);
    }
  });
});

describe('会话层：历史查看与分叉', () => {
  it('从历史轮次分叉不改变父分支', () => {
    const session = SimulationSession.fromExampleId('dual-source');
    session.advance(10);
    const parentSignature = runSignature(session.active().records);
    session.setViewRound(4);
    const info = session.fork('试验 A');
    expect(info.round).toBe(4);
    session.updateLayout((layout) => {
      layout.setCell(7, 5, { kind: 'vent', medium: 'both', open: true });
    });
    session.advance(6);
    expect(session.tipRound()).toBe(10);
    const parent = session.branches.find((branch) => branch.id === info.fromBranch)!;
    expect(runSignature(parent.records)).toBe(parentSignature);
    expect(parent.records.length).toBe(10);
  });

  it('在分支起点编辑不需要分叉，在中途编辑才分叉', () => {
    const session = SimulationSession.fromExampleId('sealed-room');
    session.advance(6);
    session.setViewRound(6);
    expect(session.editNeedsFork()).toBe(false);
    session.setViewRound(3);
    expect(session.editNeedsFork()).toBe(true);
    session.setViewRound(0);
    expect(session.editNeedsFork()).toBe(false);
    session.setViewRound(6);
    session.fork();
    expect(session.editNeedsFork()).toBe(false);
    session.advance(2);
    expect(session.editNeedsFork()).toBe(false);
    session.setViewRound(7);
    expect(session.editNeedsFork()).toBe(true);
    session.setViewRound(6);
    expect(session.editNeedsFork()).toBe(false);
  });

  it('分叉分支可查看继承的旧轮次，且与父分支逐轮一致', () => {
    const session = SimulationSession.fromExampleId('dual-source');
    session.advance(8);
    const parentRecords = [...session.active().records];
    session.setViewRound(5);
    session.fork();
    for (let round = 1; round <= 5; round += 1) {
      expect(session.recordAt(round)).toBe(parentRecords[round - 1]);
    }
    expect(session.allRecords()).toHaveLength(5);
    expect(session.hasInheritedHistory()).toBe(true);
    session.advance(3);
    expect(session.tipRound()).toBe(8);
    expect(session.allRecords()).toHaveLength(8);
    // 继承的轮次只读：不会因为新试验被改写
    expect(session.recordAt(2)).toBe(parentRecords[1]);
    // 第 6 轮起是本分支自己的演算
    expect(session.recordAt(6)).not.toBe(parentRecords[5]);
  });

  it('在分叉轮改建后，继承轮次仍按分叉时布局结算', () => {
    const session = SimulationSession.fromExampleId('sealed-room');
    session.advance(6);
    session.setViewRound(3);
    session.fork();
    expect(session.recordAt(3)?.layoutHash).toBe(session.active().layout.hash());
    session.updateLayout((layout) => layout.setCell(6, 4, { kind: 'wall' }));
    // 分叉之后没有新轮次：继承轮次与当前布局不同，但仍可读且账目闭合
    expect(session.recordAt(3)?.layoutHash).not.toBe(session.active().layout.hash());
    expect(verifyRound(session.recordAt(3)!)).toEqual([]);
    session.advance(2);
    // 新轮次使用新布局
    expect(session.recordAt(4)?.layoutHash).toBe(session.active().layout.hash());
    // 分叉前最后一轮的布局哈希 = 分叉时快照
    expect(session.active().inherited[2]?.layoutHash).not.toBe(session.recordAt(4)?.layoutHash);
  });

  it('分叉后的前缀与被复制的那一轮完全一致', () => {
    const session = SimulationSession.fromExampleId('sealed-room');
    session.advance(8);
    const parent = session.active();
    const forkedAt = 5;
    session.setViewRound(forkedAt);
    session.fork();
    const child = session.active();
    expect(child.baseRound).toBe(forkedAt);
    const parentState = parent.records[forkedAt - 1]!.state;
    for (const [key, amounts] of parentState) {
      expect(child.baseState.get(key)).toEqual(amounts);
    }
  });

  it('布局改动后从 baseState 重演，结果只取决于布局与起点', () => {
    const session = SimulationSession.fromExampleId('valve-reverse');
    session.advance(8);
    session.updateLayout((layout) => layout.setCell(8, 8, { kind: 'wall' }));
    session.advance(4);
    const signatureA = runSignature(session.active().records);

    const replayed = new SimulationSession(exampleById('valve-reverse'));
    replayed.advance(8);
    replayed.updateLayout((layout) => layout.setCell(8, 8, { kind: 'wall' }));
    replayed.advance(4);
    expect(runSignature(replayed.active().records)).toBe(signatureA);
  });

  it('自检报告编辑顺序一致，且没有账目错误', () => {
    const session = SimulationSession.fromExampleId('dual-source');
    session.advance(6);
    const check = session.selfCheck(6);
    expect(check.identical).toBe(true);
    expect(check.orders).toHaveLength(4);
    expect(check.ledgerErrors).toEqual([]);
  });

  it('layoutToEdits 往返后布局哈希不变', () => {
    for (const example of EXAMPLES) {
      const layout = buildLayout(example.edits);
      const rebuilt = buildLayout(layoutToEdits(layout));
      expect(rebuilt.hash()).toBe(layout.hash());
    }
  });

  it('洗牌函数是可复现的', () => {
    const first = shuffleEdits(dual.edits, 123);
    const second = shuffleEdits(dual.edits, 123);
    expect(first).toEqual(second);
    expect(buildLayout(first).hash()).toBe(buildLayout(dual.edits).hash());
  });

  it('分叉视图下的编辑不会污染父分支的布局', () => {
    const session = SimulationSession.fromExampleId('sealed-room');
    session.advance(4);
    const parent = session.active();
    const parentHash = parent.layout.hash();
    session.setViewRound(2);
    session.fork();
    session.updateLayout((layout) => layout.setCell(3, 2, null));
    expect(session.active().layout.hash()).not.toBe(parentHash);
    expect(parent.layout.hash()).toBe(parentHash);
  });
});

describe('单位换算', () => {
  it('1 单位 = 1000 内部刻度', () => {
    expect(UNIT_SCALE).toBe(1000);
    const edits: Edit[] = [
      { kind: 'cell', x: 3, y: 3, content: { kind: 'source', medium: 'fog', amount: 4_000 } },
    ];
    const record = simulateRound(buildLayout(edits), new Map(), 1);
    expect(record.totals.fog.injected).toBe(4 * UNIT_SCALE);
  });
});
