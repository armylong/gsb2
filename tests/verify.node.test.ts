/**
 * 一条可运行的验证命令：node --test tests/verify.node.test.ts
 * 不依赖 vitest，使用 Node 内置 test runner，直接跑真实 .ts 源码（Node ≥ 22.6）。
 * 覆盖四项需求：密封房边界、阀门反向、双源计量、编辑顺序一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EXAMPLES, editOrders, exampleById } from '../src/examples.ts';
import { buildLayout } from '../src/layout.ts';
import { keyOf } from '../src/grid.ts';
import { SimulationSession } from '../src/session.ts';
import { runChecks } from '../src/checks.ts';
import { VENT_RATE, runSignature, simulate, verifyRound, verifySequence } from '../src/sim.ts';
import { MEDIA } from '../src/units.ts';

const SEALED_BOX = { x0: 3, y0: 2, x1: 9, y1: 8 };

test('所有示例每一轮账目闭合（期初 + 注入 = 期末 + 释放）', () => {
  for (const example of EXAMPLES) {
    const records = simulate(buildLayout(example.edits), example.rounds);
    assert.equal(records.length, example.rounds);
    for (const record of records) {
      assert.deepEqual(verifyRound(record), [], `${example.id} 第 ${record.round} 轮账目不平`);
      for (const medium of MEDIA) {
        const t = record.totals[medium];
        assert.equal(t.opening + t.injected, t.inMap + t.released);
      }
    }
    assert.deepEqual(verifySequence(records), [], `${example.id} 跨轮账链不连续`);
  }
});

test('密封房：外部源进不来，内部源出不去', () => {
  const sealed = exampleById('sealed-room');
  const walls = sealed.edits.filter((edit) => edit.kind === 'cell' && edit.content?.kind === 'wall');
  const sources = sealed.edits.filter((edit) => edit.kind === 'cell' && edit.content?.kind === 'source');
  const inside = (x: number, y: number) =>
    x >= SEALED_BOX.x0 && x <= SEALED_BOX.x1 && y >= SEALED_BOX.y0 && y <= SEALED_BOX.y1;

  const onlyOutside = simulate(
    buildLayout([
      ...walls,
      ...sources.filter((edit) => edit.kind === 'cell' && !inside(edit.x, edit.y)),
    ]),
    20,
  );
  for (const record of onlyOutside) {
    for (const [key, entry] of record.ledger) {
      const [x, y] = key.split(',').map(Number) as [number, number];
      if (x > SEALED_BOX.x0 && x < SEALED_BOX.x1 && y > SEALED_BOX.y0 && y < SEALED_BOX.y1) {
        assert.equal(entry.heat.closing, 0, `外部热量渗入 ${key}`);
        assert.equal(entry.fog.closing, 0, `外部雾渗入 ${key}`);
      }
    }
  }

  const onlyInside = simulate(
    buildLayout([
      ...walls,
      ...sources.filter((edit) => edit.kind === 'cell' && inside(edit.x, edit.y)),
    ]),
    20,
  );
  for (const record of onlyInside) {
    assert.equal(record.totals.heat.released, 0);
    assert.equal(record.totals.fog.released, 0);
    for (const [key, entry] of record.ledger) {
      const [x, y] = key.split(',').map(Number) as [number, number];
      if (!inside(x, y)) {
        assert.equal(entry.heat.closing + entry.fog.closing, 0, `内部介质漏到 ${key}`);
      }
    }
  }
});

test('阀门反向：反向零释放，翻向后恢复释放', () => {
  const valve = exampleById('valve-reverse');
  const closed = simulate(buildLayout(valve.edits), 20);
  assert.equal(closed[19]!.totals.heat.released, 0);
  assert.equal(closed[19]!.totals.heat.inMap, 20 * 6_000);

  const flipped = buildLayout(valve.edits);
  flipped.setValve(keyOf(6, 4), keyOf(7, 4), true);
  const open = simulate(flipped, 20);
  assert.ok(open[19]!.totals.heat.released > 0);
  assert.ok(open.some((record) => record.totals.heat.released > 0));
});

test('双源：热量与雾分别释放到各自上限，关闭的风口为零', () => {
  const dual = exampleById('dual-source');
  const records = simulate(buildLayout(dual.edits), 20);
  const last = records[19]!;
  assert.equal(last.totals.heat.released, VENT_RATE.heat);
  assert.equal(last.totals.fog.released, VENT_RATE.fog);
  const closed = records.reduce((sum, record) => {
    const entry = record.ledger.get(keyOf(7, 5));
    return sum + (entry?.heat.released ?? 0) + (entry?.fog.released ?? 0);
  }, 0);
  assert.equal(closed, 0);
});

test('编辑顺序：原序 / 反序 / 两种洗牌得到同一哈希与同一逐轮签名', () => {
  for (const example of EXAMPLES) {
    const orders = editOrders(example.edits);
    const signatures = orders.map((order) =>
      runSignature(simulate(buildLayout(order.edits), 12)),
    );
    const hashes = orders.map((order) => buildLayout(order.edits).hash());
    assert.equal(new Set(hashes).size, 1, `${example.id} 布局哈希不一致`);
    assert.equal(new Set(signatures).size, 1, `${example.id} 逐轮签名不一致`);
  }
});

test('把有介质的格子封成墙：清除量入账，跨轮账链仍连续', () => {
  const session = SimulationSession.fromExampleId('sealed-room');
  session.advance(6);
  session.setViewRound(6);
  session.fork();
  const base = session.active();
  const target = [...base.baseState.entries()].find(([, amounts]) => amounts.heat > 0);
  assert.ok(target, '分叉起点应有热量存量');
  const [key] = target;
  const [x, y] = key.split(',').map(Number) as [number, number];
  session.updateLayout((layout) => layout.setCell(x, y, { kind: 'wall' }));
  session.advance(1);
  const record = session.active().records[0]!;
  assert.ok(record.cleared.some((item) => item.cell === key));
  assert.ok(record.totals.heat.cleared > 0);
  assert.deepEqual(session.ledgerErrors(), []);
  assert.deepEqual(verifySequence(session.allRecords()), []);
});

test('历史分叉：在旧轮次试验不影响父分支', () => {
  const session = SimulationSession.fromExampleId('dual-source');
  session.advance(10);
  const before = runSignature(session.active().records);
  session.setViewRound(4);
  const info = session.fork('测试分支');
  session.updateLayout((layout) => {
    layout.setCell(7, 5, { kind: 'vent', medium: 'both', open: true });
  });
  session.advance(6);
  const parent = session.branches.find((branch) => branch.id === info.fromBranch)!;
  assert.equal(runSignature(parent.records), before);
  assert.equal(parent.records.length, 10);
  assert.equal(session.tipRound(), 10);
  assert.notEqual(session.active().layout.hash(), parent.layout.hash());
});

test('程序内四条验证断言全部通过', () => {
  const [sealed, valve, dual] = EXAMPLES;
  const results = runChecks(sealed!.edits, valve!.edits, dual!.edits, { sealedBox: SEALED_BOX });
  for (const result of results) {
    assert.ok(result.passed, `${result.id}: ${result.detail}`);
  }
});
