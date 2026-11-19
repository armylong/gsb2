import { describe, expect, it } from 'vitest';
import {
  createSim,
  step,
  stepN,
  verifyGlobalLedger,
  verifyNodeLedger,
  verifyCounterSum,
  freeSpace,
  reservationsTo,
} from './engine';
import {
  scenarioContention,
  scenarioFullWarehouse,
  scenarioSupplyShortage,
} from './scenarios';
import type { SimConfig, SimState, Stock } from './types';
import { ALL_RESOURCES, RECIPE_MAP, stockTotal } from './recipes';

/** 每个 tick 后三重账目必须全平，任何一步不平立即失败。 */
function assertLedgers(state: SimState) {
  const g = verifyGlobalLedger(state);
  expect(g.failures, g.failures.join('；')).toEqual([]);
  const n = verifyNodeLedger(state);
  expect(n.failures, n.failures.join('；')).toEqual([]);
  const s = verifyCounterSum(state);
  expect(s.failures, s.failures.join('；')).toEqual([]);
}

function runAndAudit(config: SimConfig, ticks: number): SimState {
  const state = createSim(config);
  for (let i = 0; i < ticks; i++) {
    step(state);
    assertLedgers(state);
  }
  return state;
}

function stockOf(state: SimState, nodeId: string): Stock {
  return state.nodes[nodeId].stock;
}

describe('1. 批次扣料：开工一次扣齐，原料不足不启动，完成生成整批产物', () => {
  it('采矿机整批产出，冶炼炉开工瞬间整笔扣料，库存不会出现扣一半', () => {
    const state = runAndAudit(scenarioSupplyShortage(), 40);
    // 炼铁炉每批消耗 2 铁矿石产出 1 铁锭；任何时刻铁矿石库存与消耗计数都应是整数批语义
    const n2 = state.nodes.n2;
    const consumedIronOre = state.nodeCounters.n2.consumed.ironOre ?? 0;
    expect(consumedIronOre % 2).toBe(0); // 每次扣 2，不可能出现奇数
    const producedIngot = state.nodeCounters.n2.produced.ironIngot ?? 0;
    expect(producedIngot).toBeGreaterThan(0);
    // 产出计数 = 批次数；每批恰好 1 铁锭
    expect(producedIngot).toBe(consumedIronOre / 2);
    // 正在加工的批次只有一个，且剩余 tick 在合法区间
    if (n2.active) {
      expect(n2.active.remainingTicks).toBeGreaterThan(0);
      expect(n2.active.remainingTicks).toBeLessThanOrEqual(n2.active.totalTicks);
    }
  });

  it('原料不足时节点进入 starved，不扣任何原料，且账目保持平衡', () => {
    // 独立小配置：装配台只有 1 铁锭，齿轮配方需要 2 -> 永远无法开工。
    // 不设任何外发连接，保证原料不会因物流离开本节点。
    const config: SimConfig = {
      nodes: [
        { id: 'asm', name: '齿轮台', type: 'assembler', x: 0, y: 0, recipeId: 'craft-gear', capacity: 10, initialStock: { ironIngot: 1 }, paused: false },
      ],
      connections: [],
    };
    const state = createSim(config);
    stepN(state, 20);
    expect(state.nodes.asm.status).toBe('starved');
    expect(state.nodeCounters.asm.consumed.ironIngot ?? 0).toBe(0);
    expect(stockOf(state, 'asm').ironIngot).toBe(1); // 原料原封不动
    assertLedgers(state);
  });
});

describe('2. 满仓等待：输出空间不足时产物待出库，不丢弃也不重复消耗', () => {
  it('仓库填满后装配台 blocked，产物保留在 heldOutput，恢复空间后自动入库', () => {
    // 完全静态、数学确定的最小配置：
    // - 装配台容量 2，初始 4 铁锭（两批料，4 <= 容量合法）；
    // - 批1：扣2铁锭(余2) -> 完成1齿轮入库(库存 2铁+1齿=3件？不，容量2)。
    // 因此容量必须能容纳过程库存：取容量 4，初始 4 铁锭；
    // - 批1完成：库存 2铁+1齿(3件)；批2扣2铁 -> 库存 1齿(1件)，完成1齿 -> 2齿(2件)；
    // - 无外发连接，齿轮锁死；外部供料仓再补 2 铁锭，批3完成时库存已 2 齿轮占 2 格，
    //   新齿轮无处安放 -> heldOutput/blocked。所有补料走真实物流，守恒不破。
    const config: SimConfig = {
      nodes: [
        // 容量 8：齿轮在节点内累积到 8 件才 blocked，且 blocked 时自身仍保留可腾挪空间；
        // 零位仓库容量 0，齿轮全程无法外发，确定性地堆满节点。
        { id: 'a', name: '齿轮台A', type: 'assembler', x: 0, y: 0, recipeId: 'craft-gear', capacity: 8, initialStock: { ironIngot: 4 }, paused: false },
        { id: 'b', name: '齿轮台B', type: 'assembler', x: 0, y: 0, recipeId: 'craft-gear', capacity: 8, initialStock: { ironIngot: 4 }, paused: false },
        { id: 'feed', name: '供料仓', type: 'warehouse', x: 0, y: 0, recipeId: null, capacity: 20, initialStock: { ironIngot: 16 }, paused: false },
        { id: 'w', name: '零位仓库', type: 'warehouse', x: 0, y: 0, recipeId: null, capacity: 0, initialStock: {}, paused: false },
      ],
      connections: [
        { id: 'cf1', from: 'feed', to: 'a', transportTicks: 1, maxInFlight: 4, enabled: true },
        { id: 'cf2', from: 'feed', to: 'b', transportTicks: 1, maxInFlight: 4, enabled: true },
        { id: 'c1', from: 'a', to: 'w', transportTicks: 2, maxInFlight: 2, enabled: true },
        { id: 'c2', from: 'b', to: 'w', transportTicks: 2, maxInFlight: 2, enabled: true },
      ],
    };
    const state = createSim(config);
    // 持续运行直到出现 blocked（齿轮在节点内累积到容量上限即触发）
    let sawBlocked = false;
    for (let i = 0; i < 80; i++) {
      step(state);
      assertLedgers(state);
      // 零位仓库红线：库存与在途预留必须始终为 0
      expect(stockTotal(state.nodes.w.stock)).toBe(0);
      expect(stockTotal(reservationsTo(state, 'w'))).toBe(0);
      if (state.events.some((e) => e.type === 'blocked')) sawBlocked = true;
      if (sawBlocked) break;
    }
    expect(sawBlocked).toBe(true);

    // blocked 节点的产物必须完整保存在 heldOutput 中，且不会并行开新批次
    for (const cfg of state.config.nodes) {
      const rt = state.nodes[cfg.id];
      if (rt.status === 'blocked') {
        expect(stockTotal(rt.heldOutput)).toBeGreaterThan(0);
        expect(rt.active).toBeNull();
      }
    }

    // 恢复路径：blocked 节点自身库存已满、held 齿轮等待自身空位。
    // 给该节点扩容（等价于下游取货腾出/扩容工位），held 产物下一 tick 即回收入库；
    // 同时给零位仓库扩容，使回收后的齿轮可经连接发走。
    const blockedNode = state.config.nodes.find((c) => state.nodes[c.id].status === 'blocked');
    expect(blockedNode).toBeDefined();
    if (!blockedNode) throw new Error('应当存在 blocked 节点');
    const rt = state.nodes[blockedNode.id];
    const heldQty = stockTotal(rt.heldOutput);
    const beforeProduced = state.nodeCounters[blockedNode.id].produced.gear ?? 0;
    blockedNode.capacity += 4; // 腾出自身空间
    state.config.nodes.find((n) => n.id === 'w')!.capacity = 10; // 打通下游
    step(state);
    // heldOutput 清空，且 produced 计数不增加（没有重复生产/重复消耗）
    expect(stockTotal(rt.heldOutput)).toBe(0);
    expect(state.nodeCounters[blockedNode.id].produced.gear ?? 0).toBe(beforeProduced);
    // 产物实体仍在：要么在节点自身库存，要么已发货在途/入库，总量不少于 heldQty
    const stillAround =
      stockTotal(rt.stock) +
      state.shipments
        .filter((s) => s.from === blockedNode.id)
        .reduce((a, s) => a + stockTotal(s.cargo), 0) +
      stockTotal(state.nodes.w.stock);
    expect(stillAround).toBeGreaterThanOrEqual(heldQty);
    assertLedgers(state);
  });

  it('待出库期间不会再次开工，因此原料绝不被同一批产物消耗两次', () => {
    const config = scenarioFullWarehouse();
    const state = createSim(config);
    let everBlocked = false;
    for (let i = 0; i < 80; i++) {
      step(state);
      assertLedgers(state);
      for (const cfg of state.config.nodes) {
        const rt = state.nodes[cfg.id];
        if (rt.status === 'blocked') {
          everBlocked = true;
          expect(rt.active).toBeNull(); // 待出库时不会并行开新批次
        }
      }
    }
    expect(everBlocked).toBe(true);
  });
});

describe('3. 容量预留：发货即占空位，两个来源不可能占同一份空间', () => {
  it('任意 tick 任意节点：库存 + 在途预留 ≤ 容量', () => {
    const state = createSim(scenarioFullWarehouse());
    for (let i = 0; i < 100; i++) {
      step(state);
      for (const cfg of state.config.nodes) {
        const rt = state.nodes[cfg.id];
        const occupied = stockTotal(rt.stock) + stockTotal(reservationsTo(state, cfg.id));
        expect(
          occupied,
          `tick ${state.tick} 节点 ${cfg.name} 占用 ${occupied} 超过容量 ${cfg.capacity}`,
        ).toBeLessThanOrEqual(cfg.capacity);
        expect(freeSpace(state, cfg.id)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('两个来源同时向仅剩 1 格的仓库发货时，只有一个能发出', () => {
    // 手工构造：仓库容量 1 且为空，两个来源各有货，各有一条连接
    const config: SimConfig = {
      nodes: [
        { id: 'a', name: '来源A', type: 'warehouse', x: 0, y: 0, recipeId: null, capacity: 10, initialStock: { gear: 3 }, paused: false },
        { id: 'b', name: '来源B', type: 'warehouse', x: 0, y: 0, recipeId: null, capacity: 10, initialStock: { gear: 3 }, paused: false },
        { id: 'w', name: '小仓库', type: 'warehouse', x: 0, y: 0, recipeId: null, capacity: 1, initialStock: {}, paused: false },
      ],
      connections: [
        { id: 'ca', from: 'a', to: 'w', transportTicks: 3, maxInFlight: 5, enabled: true },
        { id: 'cb', from: 'b', to: 'w', transportTicks: 3, maxInFlight: 5, enabled: true },
      ],
    };
    const state = createSim(config);
    step(state); // 一个 tick 内两条连接依次尝试发货
    const toW = state.shipments.filter((s) => s.to === 'w');
    expect(toW).toHaveLength(1); // 只有一条连接抢到
    // 连接顺序 ca 在前，稳定地由 A 抢到
    expect(toW[0].connectionId).toBe('ca');
    expect(freeSpace(state, 'w')).toBe(0);
    // 再走一个 tick，B 仍然发不出（没有空位）
    step(state);
    expect(state.shipments.filter((s) => s.to === 'w')).toHaveLength(1);
    assertLedgers(state);
  });

  it('在途批次受 maxInFlight 限制，超出的货物继续留在来源库存', () => {
    // 临时配方：采矿机每 tick 产 1 铁矿石，使来源每 tick 都有新货可发。
    const fastMine = {
      id: 'mine-iron-fast',
      name: '快速采矿(测试)',
      nodeType: 'miner' as const,
      inputs: {},
      outputs: { ironOre: 1 } as Stock,
      durationTicks: 1,
    };
    RECIPE_MAP[fastMine.id] = fastMine;
    const config: SimConfig = {
      nodes: [
        { id: 'm', name: '采矿机', type: 'miner', x: 0, y: 0, recipeId: fastMine.id, capacity: 50, initialStock: { ironOre: 2 }, paused: false },
        { id: 'w', name: '大库', type: 'warehouse', x: 0, y: 0, recipeId: null, capacity: 100, initialStock: {}, paused: false },
      ],
      connections: [
        { id: 'c1', from: 'm', to: 'w', transportTicks: 8, maxInFlight: 2, enabled: true },
      ],
    };
    const state = createSim(config);
    step(state); // 第 1 批
    expect(state.shipments).toHaveLength(1);
    step(state); // 第 2 批，达到 maxInFlight=2
    expect(state.shipments).toHaveLength(2);
    const inFlightAtCap = state.shipments.length;
    // 后续 tick 采矿机仍在产货，但在途额度已满：批次数量不再增长，新货积压在来源
    const stockBefore = state.nodes.m.stock.ironOre ?? 0;
    step(state);
    step(state);
    expect(state.shipments).toHaveLength(inFlightAtCap);
    expect(state.nodes.m.stock.ironOre ?? 0).toBeGreaterThanOrEqual(stockBefore);
    stepN(state, 14); // 越过到达时刻后批次可继续流动，账目仍守恒
    assertLedgers(state);
    delete RECIPE_MAP[fastMine.id];
  });
});

describe('4. 连接移除：只停止新发货，在途货物仍送达原目标', () => {
  it('停用连接后在途货物数量不减、全部按 arriveAt 入库，账目守恒', () => {
    const config = scenarioSupplyShortage();
    const state = createSim(config);
    stepN(state, 6); // 制造若干在途货物
    const inFlightBefore = state.shipments.filter((s) => s.connectionId === 'c1');
    expect(inFlightBefore.length).toBeGreaterThan(0);
    const expectedCargoTotal = inFlightBefore.reduce((a, s) => a + stockTotal(s.cargo), 0);
    const targetStockBefore = stockTotal(state.nodes.n2.stock);

    // 移除（停用）c1：铁矿采矿机 -> 炼铁炉
    const conn = state.config.connections.find((c) => c.id === 'c1')!;
    conn.enabled = false;
    const shipmentsAtRemoval = state.shipments.length;

    // 停用之后没有任何新的 c1 货物产生：n1 的发货量在停用后不再增长
    const shippedByN1After = state.nodeCounters.n1.shipped.ironOre ?? 0;
    stepN(state, 25);
    expect(state.nodeCounters.n1.shipped.ironOre ?? 0).toBe(shippedByN1After);

    // 停用瞬间的在途批次全部送达（当前在途数 ≤ 停用时刻，且 n2 收到了对应货物）
    expect(state.shipments.length).toBeLessThanOrEqual(shipmentsAtRemoval);
    const deliveredGrowth =
      stockTotal(state.nodes.n2.stock) - targetStockBefore +
      (state.nodeCounters.n2.consumed.ironOre ?? 0);
    // n2 期间还可能自产消耗，宽松断言：至少收到过停用前那批货物
    expect(deliveredGrowth).toBeGreaterThanOrEqual(expectedCargoTotal);
    assertLedgers(state);
  });

  it('暂停节点不取消已发出的运输，货物照常到达', () => {
    const config = scenarioSupplyShortage();
    const state = createSim(config);
    stepN(state, 5);
    const incoming = state.shipments.filter((s) => s.to === 'n2').length;
    expect(incoming).toBeGreaterThan(0);
    // 暂停上游与下游双方
    state.config.nodes.find((n) => n.id === 'n1')!.paused = true;
    state.config.nodes.find((n) => n.id === 'n2')!.paused = true;
    const n2StockBefore = stockTotal(state.nodes.n2.stock);
    stepN(state, 10);
    // 货物仍送达 n2
    expect(stockTotal(state.nodes.n2.stock)).toBeGreaterThan(n2StockBefore);
    // 暂停期间 n1 没有新发货
    const shippedNow = state.nodeCounters.n1.shipped.ironOre ?? 0;
    stepN(state, 3);
    expect(state.nodeCounters.n1.shipped.ironOre ?? 0).toBe(shippedNow);
    assertLedgers(state);
  });
});

describe('5. 确定性：相同配置相同时长，逐 tick 结果完全一致', () => {
  it('三个场景分别重放两次，深比较整个 SimState', () => {
    for (const build of [scenarioSupplyShortage, scenarioFullWarehouse, scenarioContention]) {
      const a = runAndAudit(build(), 120);
      const b = runAndAudit(build(), 120);
      expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
    }
  });

  it('不同推进方式（逐 tick vs 一次多 tick）结果一致', () => {
    const a = createSim(scenarioContention());
    for (let i = 0; i < 50; i++) step(a);
    const b = createSim(scenarioContention());
    stepN(b, 50);
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
  });
});

describe('6. 稳定优先级：两线抢料按节点/连接表顺序分配，可复现', () => {
  it('共享矿仓场景下炼铁炉 A 始终先于 B 获得原料', () => {
    const s1 = runAndAudit(scenarioContention(), 80);
    const s2 = runAndAudit(scenarioContention(), 80);
    const consumedA = s1.nodeCounters.n3.consumed.ironOre ?? 0;
    const consumedB = s1.nodeCounters.n4.consumed.ironOre ?? 0;
    // 矿有限：A 不会比 B 少（表顺序 n3 在 n4 之前，每次竞争 A 先选）
    expect(consumedA).toBeGreaterThanOrEqual(consumedB);
    expect(consumedA).toBeGreaterThan(0);
    // 两次运行计数完全相同
    expect(s2.nodeCounters.n3.consumed).toEqual(s1.nodeCounters.n3.consumed);
    expect(s2.nodeCounters.n4.consumed).toEqual(s1.nodeCounters.n4.consumed);
  });

  it('同一份原料不会被两台设备同时扣走（出库总量守恒）', () => {
    const state = runAndAudit(scenarioContention(), 100);
    const n2 = state.nodes.n2;
    // 共享仓库：初始 + 到货 = 两台炉子的发货 + 剩余库存（节点守恒已逐 tick 校验，
    // 这里再对单资源显式断言一次）
    const initial = 6;
    const delivered = state.nodeCounters.n2.delivered.ironOre ?? 0;
    const shipped = state.nodeCounters.n2.shipped.ironOre ?? 0;
    expect(initial + delivered - shipped).toBe(n2.stock.ironOre ?? 0);
  });
});

describe('7. 每种资源的库存/在途/加工消耗账目', () => {
  it('长模拟后对全部 7 种资源核对全局与节点守恒', () => {
    const state = runAndAudit(scenarioContention(), 150);
    for (const res of ALL_RESOURCES) {
      // 全局：初始 + 产出 - 消耗 = 库存 + 待出库 + 在途
      const initial = state.config.nodes.reduce(
        (a, n) => a + (n.initialStock[res] ?? 0),
        0,
      );
      let inTransit = 0;
      let onHand = 0;
      for (const cfg of state.config.nodes) {
        const rt = state.nodes[cfg.id];
        onHand += (rt.stock[res] ?? 0) + (rt.heldOutput[res] ?? 0);
      }
      for (const ship of state.shipments) inTransit += ship.cargo[res] ?? 0;
      const lhs =
        initial + (state.ledger.produced[res] ?? 0) - (state.ledger.consumed[res] ?? 0);
      expect(lhs, `资源 ${res} 全局守恒`).toBe(onHand + inTransit);

      // 发货总量 = 到货总量 + 当前在途（运输中没有损耗）
      const shipped = state.ledger.shipped[res] ?? 0;
      const delivered = state.ledger.delivered[res] ?? 0;
      expect(shipped, `资源 ${res} 发货=到货+在途`).toBe(delivered + inTransit);
    }
    expect(verifyGlobalLedger(state).ok).toBe(true);
    expect(verifyNodeLedger(state).ok).toBe(true);
  });
});
