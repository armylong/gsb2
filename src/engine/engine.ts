import {
  ALL_RESOURCES,
  RECIPE_MAP,
  RESOURCE_META,
  addStock,
  containsStock,
  missingStock,
  stockAmount,
  stockTotal,
  subStock,
} from './recipes';
import type {
  NodeConfig,
  NodeCounters,
  NodeRuntime,
  ResourceId,
  SimConfig,
  SimEvent,
  SimState,
  Stock,
} from './types';
import { MAX_EVENTS, TICK_SECONDS } from './types';

// 深拷贝配置，保证引擎内部状态与 UI 编辑草稿互不影响。
export function cloneConfig(config: SimConfig): SimConfig {
  return JSON.parse(JSON.stringify(config)) as SimConfig;
}

function emptyInspection() {
  return { missing: {}, blockedBy: {}, blockedOutputs: {} };
}

function emptyCounters(): NodeCounters {
  return { consumed: {}, produced: {}, shipped: {}, delivered: {} };
}

/** 构造初始模拟状态（tick = 0，无在途）。 */
export function createSim(inputConfig: SimConfig): SimState {
  const config = validateConfig(cloneConfig(inputConfig));
  const nodes: Record<string, NodeRuntime> = {};
  const nodeCounters: Record<string, NodeCounters> = {};
  for (const cfg of config.nodes) {
    nodes[cfg.id] = {
      configId: cfg.id,
      stock: { ...cfg.initialStock },
      heldOutput: {},
      active: null,
      status: cfg.type === 'warehouse' ? 'warehouse' : 'idle',
      inspection: emptyInspection(),
    };
    nodeCounters[cfg.id] = emptyCounters();
  }
  const state: SimState = {
    tick: 0,
    config,
    nodes,
    shipments: [],
    ledger: emptyCounters(),
    nodeCounters,
    events: [],
    nextShipmentId: 1,
  };
  refreshAllInspections(state);
  return state;
}

export function validateConfig(config: SimConfig): SimConfig {
  const ids = new Set<string>();
  for (const n of config.nodes) {
    if (ids.has(n.id)) throw new Error(`节点 id 重复: ${n.id}`);
    ids.add(n.id);
    if (stockTotal(n.initialStock) > n.capacity) {
      throw new Error(`节点 ${n.name} 初始库存超过容量`);
    }
    if (n.type !== 'warehouse' && n.recipeId && !RECIPE_MAP[n.recipeId]) {
      throw new Error(`节点 ${n.name} 引用了不存在的配方 ${n.recipeId}`);
    }
  }
  const cids = new Set<string>();
  for (const c of config.connections) {
    if (cids.has(c.id)) throw new Error(`连接 id 重复: ${c.id}`);
    cids.add(c.id);
    if (!ids.has(c.from) || !ids.has(c.to)) throw new Error(`连接 ${c.id} 端点不存在`);
    if (c.from === c.to) throw new Error(`连接 ${c.id} 不能自环`);
    if (c.transportTicks < 1) throw new Error(`连接 ${c.id} 运输时间至少 1 tick`);
    if (c.maxInFlight < 1) throw new Error(`连接 ${c.id} 最大在途批次至少 1`);
  }
  return config;
}

function pushEvent(state: SimState, ev: Omit<SimEvent, 'tick'>) {
  state.events.push({ tick: state.tick, ...ev });
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}

/** 所有以 nodeId 为目的地的在途货物（含已移除连接上的在途货物）。 */
export function reservationsTo(state: SimState, nodeId: string): Stock {
  let acc: Stock = {};
  for (const s of state.shipments) {
    if (s.to === nodeId) acc = addStock(acc, s.cargo);
  }
  return acc;
}

/**
 * 目的地剩余可用空间 = 容量 - 自身库存 - 全部在途预留。
 * 发货按连接固定顺序逐批调用本函数，前一个来源的预留立即计入，
 * 因此两个来源不可能占走同一份空位。
 */
export function freeSpace(state: SimState, nodeId: string): number {
  const cfg = nodeConfig(state, nodeId);
  const rt = state.nodes[nodeId];
  const reserved = stockTotal(reservationsTo(state, nodeId));
  return cfg.capacity - stockTotal(rt.stock) - reserved;
}

export function nodeConfig(state: SimState, id: string): NodeConfig {
  const cfg = state.config.nodes.find((n) => n.id === id);
  if (!cfg) throw new Error(`节点不存在: ${id}`);
  return cfg;
}

function connectionInFlight(state: SimState, connectionId: string): number {
  return state.shipments.filter((s) => s.connectionId === connectionId).length;
}

// ================= 单 tick 推进（确定性：仅依赖 config 数组顺序与 shipment id 顺序） =================

export function step(state: SimState): SimState {
  state.tick += 1;
  phaseDeliver(state);
  phaseProcess(state);
  phaseShip(state);
  refreshAllInspections(state);
  return state;
}

/** 推进 n 个 tick。 */
export function stepN(state: SimState, n: number): SimState {
  for (let i = 0; i < n; i++) step(state);
  return state;
}

// ---- 阶段 1：到货。按 shipment id（即发货先后）依次入库 ----
function phaseDeliver(state: SimState) {
  const arrived = state.shipments.filter((s) => s.arriveAt === state.tick);
  if (arrived.length === 0) return;

  // 同一 tick 可能有多批货物到达同一节点。先按目的地汇总本 tick 到货量，
  // 对照“库存 + 尚未到达的在途预留”一次性校验：发货时的预留保证这里必然通过。
  const arrivalsByTarget = new Map<string, Stock>();
  for (const ship of arrived) {
    const cur = arrivalsByTarget.get(ship.to) ?? {};
    arrivalsByTarget.set(ship.to, addStock(cur, ship.cargo));
  }
  for (const [nodeId, arriving] of arrivalsByTarget) {
    const cfg = nodeConfig(state, nodeId);
    let reserved = 0;
    for (const s of state.shipments) {
      if (s.to === nodeId && s.arriveAt !== state.tick) reserved += stockTotal(s.cargo);
    }
    const need = stockTotal(arriving);
    const available = cfg.capacity - stockTotal(state.nodes[nodeId].stock) - reserved;
    if (available < need) {
      // 断言保护：发货阶段的容量预留使此分支不可达，若到达说明预留逻辑被破坏。
      throw new Error(
        `内部错误：节点 ${nodeId} 预留空间被破坏，本 tick 到货 ${need} 件但仅剩 ${available} 格`,
      );
    }
  }

  // 校验通过后顺序入库；入库过程中不再逐批重算空间（同 tick 到达批共享同一份预留）。
  for (const ship of arrived) {
    const target = state.nodes[ship.to];
    target.stock = addStock(target.stock, ship.cargo);
    state.nodeCounters[ship.to].delivered = addStock(
      state.nodeCounters[ship.to].delivered,
      ship.cargo,
    );
    state.ledger.delivered = addStock(state.ledger.delivered, ship.cargo);
    pushEvent(state, {
      type: 'deliver',
      connectionId: ship.connectionId,
      nodeId: ship.to,
      detail: `到货入库 ${describeStock(ship.cargo)}`,
      stock: { ...ship.cargo },
    });
  }
  state.shipments = state.shipments.filter((s) => s.arriveAt !== state.tick);
}

// ---- 阶段 2：加工。节点按 config.nodes 的固定顺序竞争，先到先得 ----
function phaseProcess(state: SimState) {
  for (const cfg of state.config.nodes) {
    if (cfg.type === 'warehouse') continue;
    const rt = state.nodes[cfg.id];

    // 待出库产物优先尝试入库（暂停节点也照常腾挪，只是不加工）。
    if (stockTotal(rt.heldOutput) > 0) {
      tryDepositHeld(state, cfg.id);
      if (stockTotal(rt.heldOutput) > 0) {
        rt.status = cfg.paused ? 'paused' : 'blocked';
        continue;
      }
    }

    if (cfg.paused) {
      rt.status = 'paused';
      continue;
    }

    if (rt.active) {
      rt.active.remainingTicks -= 1;
      if (rt.active.remainingTicks > 0) {
        rt.status = 'processing';
        continue;
      }
      // 本批次完成：使用开工时快照的配方，与当前配置解耦。
      const recipe = rt.active.recipeSnapshot;
      rt.active = null;
      state.nodeCounters[cfg.id].produced = addStock(
        state.nodeCounters[cfg.id].produced,
        recipe.outputs,
      );
      state.ledger.produced = addStock(state.ledger.produced, recipe.outputs);
      if (freeSpace(state, cfg.id) >= stockTotal(recipe.outputs)) {
        rt.stock = addStock(rt.stock, recipe.outputs);
        rt.status = 'idle';
        pushEvent(state, {
          type: 'complete',
          nodeId: cfg.id,
          detail: `「${recipe.name}」完成，产物入库 ${describeStock(recipe.outputs)}`,
          stock: { ...recipe.outputs },
        });
      } else {
        // 输出空间不足：产物保持待出库，不丢弃、不再次消耗原料。
        rt.heldOutput = { ...recipe.outputs };
        rt.status = 'blocked';
        pushEvent(state, {
          type: 'blocked',
          nodeId: cfg.id,
          detail: `「${recipe.name}」完成但输出空间不足，产物待出库 ${describeStock(recipe.outputs)}`,
          stock: { ...recipe.outputs },
        });
      }
      continue;
    }

    tryStart(state, cfg.id);
  }
}

function tryDepositHeld(state: SimState, nodeId: string) {
  const rt = state.nodes[nodeId];
  if (stockTotal(rt.heldOutput) === 0) return;
  if (freeSpace(state, nodeId) >= stockTotal(rt.heldOutput)) {
    rt.stock = addStock(rt.stock, rt.heldOutput);
    pushEvent(state, {
      type: 'deliver',
      nodeId,
      detail: `待出库产物腾出空间后入库 ${describeStock(rt.heldOutput)}`,
      stock: { ...rt.heldOutput },
    });
    rt.heldOutput = {};
  }
}

function tryStart(state: SimState, nodeId: string) {
  const cfg = nodeConfig(state, nodeId);
  const rt = state.nodes[nodeId];
  if (!cfg.recipeId) {
    rt.status = 'idle';
    return;
  }
  const recipe = RECIPE_MAP[cfg.recipeId];
  if (!recipe || recipe.nodeType !== cfg.type) {
    rt.status = 'idle';
    return;
  }
  // 开工判定：原料一次扣齐，不足则整个批次不启动（不会出现扣一半）。
  if (!containsStock(rt.stock, recipe.inputs)) {
    rt.status = 'starved';
    pushEvent(state, {
      type: 'starved',
      nodeId,
      detail: `缺料无法开工：缺 ${describeStock(missingStock(rt.stock, recipe.inputs))}`,
      stock: missingStock(rt.stock, recipe.inputs),
    });
    return;
  }
  rt.stock = subStock(rt.stock, recipe.inputs);
  state.nodeCounters[nodeId].consumed = addStock(
    state.nodeCounters[nodeId].consumed,
    recipe.inputs,
  );
  state.ledger.consumed = addStock(state.ledger.consumed, recipe.inputs);
  // 配方快照：运行中修改配方不影响已开工的批次。
  rt.active = {
    recipeId: recipe.id,
    recipeSnapshot: JSON.parse(JSON.stringify(recipe)),
    remainingTicks: recipe.durationTicks,
    totalTicks: recipe.durationTicks,
  };
  rt.status = 'processing';
  pushEvent(state, {
    type: 'start',
    nodeId,
    detail: `开工「${recipe.name}」，扣料 ${describeStock(recipe.inputs) || '无（采矿）'}`,
    stock: { ...recipe.inputs },
  });
}

// ---- 阶段 3：发货。连接按 config.connections 的固定顺序分配空间 ----
function phaseShip(state: SimState) {
  for (const conn of state.config.connections) {
    if (!conn.enabled) continue; // 停用的连接：只停止新发货，在途货物照旧送达
    const sourceCfg = nodeConfig(state, conn.from);
    if (sourceCfg.paused) continue; // 暂停节点不作为来源发新货
    if (connectionInFlight(state, conn.id) >= conn.maxInFlight) continue;

    const source = state.nodes[conn.from];
    // 一条连接每 tick 至多发出一个批次，批内可含多种资源。
    // 资源顺序固定（ALL_RESOURCES），同一批次内多资源竞争也有稳定次序。
    const cargo: Stock = {};
    let used = 0;
    for (const res of ALL_RESOURCES) {
      const available = stockAmount(source.stock, res) - (cargo[res] ?? 0);
      if (available <= 0) continue;
      // 每次尝试都重算剩余空间：本连接前面的资源、以及更早在本 tick 发货的
      // 其他连接的预留都立即生效，空位不会被重复占用。
      const free = freeSpace(state, conn.to) - used;
      if (free <= 0) continue;
      const qty = Math.min(available, free);
      cargo[res] = qty;
      used += qty;
    }
    if (used === 0) continue;

    source.stock = subStock(source.stock, cargo);
    const ship = {
      id: state.nextShipmentId++,
      connectionId: conn.id,
      from: conn.from,
      to: conn.to,
      cargo,
      departAt: state.tick,
      arriveAt: state.tick + conn.transportTicks,
      transportTicks: conn.transportTicks,
    };
    state.shipments.push(ship);
    state.nodeCounters[conn.from].shipped = addStock(
      state.nodeCounters[conn.from].shipped,
      cargo,
    );
    state.ledger.shipped = addStock(state.ledger.shipped, cargo);
    pushEvent(state, {
      type: 'ship',
      nodeId: conn.from,
      connectionId: conn.id,
      detail: `发货 ${describeStock(cargo)} → ${nodeConfig(state, conn.to).name}`,
      stock: { ...cargo },
    });
  }
}

// ================= 状态解释（点击节点时展示真实阻塞原因） =================

function refreshAllInspections(state: SimState) {
  for (const cfg of state.config.nodes) {
    const rt = state.nodes[cfg.id];
    const inspection = emptyInspection();

    if (cfg.type !== 'warehouse' && cfg.recipeId) {
      const recipe = RECIPE_MAP[cfg.recipeId];
      if (recipe && recipe.nodeType === cfg.type) {
        inspection.missing = missingStock(rt.stock, recipe.inputs);
      }
    }
    if (stockTotal(rt.heldOutput) > 0) {
      inspection.blockedOutputs = { ...rt.heldOutput };
    }
    const bySource: Record<string, number> = {};
    for (const s of state.shipments) {
      if (s.to !== cfg.id) continue;
      bySource[s.from] = (bySource[s.from] ?? 0) + stockTotal(s.cargo);
    }
    inspection.blockedBy = bySource;
    rt.inspection = inspection;
  }
}

export function describeStock(stock: Stock): string {
  const parts = ALL_RESOURCES.filter((r) => stock[r]).map(
    (r) => `${RESOURCE_META[r].name}×${stock[r]}`,
  );
  return parts.join('，');
}

// ================= 账目核对 =================

export interface LedgerCheckResult {
  ok: boolean;
  failures: string[];
}

/**
 * 全局守恒（对每种资源）：
 * 初始总量 + 累计产出 - 累计消耗 = 各节点库存 + 待出库 + 在途。
 * 发货/到货只是节点间转移，在全局守恒式中抵消。
 */
export function verifyGlobalLedger(state: SimState): LedgerCheckResult {
  const failures: string[] = [];
  const initial: Stock = {};
  for (const cfg of state.config.nodes) {
    for (const k of Object.keys(cfg.initialStock) as ResourceId[]) {
      initial[k] = (initial[k] ?? 0) + (cfg.initialStock[k] ?? 0);
    }
  }
  let inTransit: Stock = {};
  for (const s of state.shipments) inTransit = addStock(inTransit, s.cargo);

  for (const res of ALL_RESOURCES) {
    const lhs =
      (initial[res] ?? 0) +
      (state.ledger.produced[res] ?? 0) -
      (state.ledger.consumed[res] ?? 0);
    let rhs = inTransit[res] ?? 0;
    for (const cfg of state.config.nodes) {
      const rt = state.nodes[cfg.id];
      rhs += stockAmount(rt.stock, res) + stockAmount(rt.heldOutput, res);
    }
    if (lhs !== rhs) {
      failures.push(
        `${RESOURCE_META[res].name} 全局账目不平：初始${initial[res] ?? 0}+产出${
          state.ledger.produced[res] ?? 0
        }-消耗${state.ledger.consumed[res] ?? 0}=${lhs}，实际库存+待出库+在途=${rhs}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * 节点守恒（对每个节点、每种资源）：
 * 初始 + 到货 + 自产 - 开工消耗 - 发货 = 当前库存 + 待出库。
 * 计数器在每个资源流转变更点实时维护，不依赖会被截断的事件日志。
 */
export function verifyNodeLedger(state: SimState): LedgerCheckResult {
  const failures: string[] = [];
  for (const cfg of state.config.nodes) {
    const rt = state.nodes[cfg.id];
    const c = state.nodeCounters[cfg.id];
    for (const res of ALL_RESOURCES) {
      const lhs =
        (cfg.initialStock[res] ?? 0) +
        (c.delivered[res] ?? 0) +
        (c.produced[res] ?? 0) -
        (c.consumed[res] ?? 0) -
        (c.shipped[res] ?? 0);
      const rhs = stockAmount(rt.stock, res) + stockAmount(rt.heldOutput, res);
      if (lhs !== rhs) {
        failures.push(
          `节点「${cfg.name}」的 ${RESOURCE_META[res].name} 账目不平：账面 ${lhs} vs 库存+待出库 ${rhs}`,
        );
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/** 全局计数器应等于各节点计数器之和（防止重复记账/漏记账）。 */
export function verifyCounterSum(state: SimState): LedgerCheckResult {
  const failures: string[] = [];
  for (const key of ['consumed', 'produced', 'shipped', 'delivered'] as const) {
    let sum: Stock = {};
    for (const cfg of state.config.nodes) {
      sum = addStock(sum, state.nodeCounters[cfg.id][key]);
    }
    for (const res of ALL_RESOURCES) {
      if ((sum[res] ?? 0) !== (state.ledger[key][res] ?? 0)) {
        failures.push(
          `${key}.${RESOURCE_META[res].name} 全局计数与节点计数之和不一致`,
        );
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

export function tickToSeconds(tick: number): number {
  return tick * TICK_SECONDS;
}
