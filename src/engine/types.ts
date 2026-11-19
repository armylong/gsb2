// 模拟引擎的核心类型。引擎与 React/Canvas 完全解耦，纯数据 + 纯函数，
// 所有时间以整数 tick 推进（1 tick = 0.5 秒），不使用任何随机源。

export type ResourceId =
  | 'ironOre'
  | 'copperOre'
  | 'ironIngot'
  | 'copperIngot'
  | 'gear'
  | 'circuit'
  | 'motor';

export type NodeType = 'miner' | 'smelter' | 'assembler' | 'warehouse';

export type NodeStatus =
  | 'idle' // 空闲（可开工，通常只在极短瞬间出现）
  | 'processing' // 加工中
  | 'starved' // 缺料，无法开工
  | 'blocked' // 已完成，等待自身输出空间
  | 'paused' // 手动暂停
  | 'warehouse'; // 仓库（不加工）

/** 每种资源 -> 数量。库存、在途、账目统一用这个结构。 */
export type Stock = Partial<Record<ResourceId, number>>;

export interface Recipe {
  id: string;
  name: string;
  /** 一次开工所需原料，开工瞬间整笔扣齐。 */
  inputs: Stock;
  /** 加工完成后一次生成的整批产物。 */
  outputs: Stock;
  /** 加工时长，单位 tick。 */
  durationTicks: number;
  /** 适用的节点类型。 */
  nodeType: NodeType;
}

export interface NodeConfig {
  id: string;
  name: string;
  type: NodeType;
  x: number;
  y: number;
  /** 当前选用配方（仓库忽略此字段）。 */
  recipeId: string | null;
  /** 库存总容量（所有资源合计件数）。 */
  capacity: number;
  /** 初始库存。 */
  initialStock: Stock;
  /** 手动暂停：不加工、不作为来源发新货，在途与到货不受影响。 */
  paused: boolean;
}

export interface ConnectionConfig {
  id: string;
  from: string;
  to: string;
  /** 运输时间，单位 tick（至少 1）。 */
  transportTicks: number;
  /** 最大在途批次数（同一连接上同时允许存在的货物批数）。 */
  maxInFlight: number;
  /** UI 层移除连接时置 false：只停止新发货，已发出的货物继续送到原目标。 */
  enabled: boolean;
}

export interface SimConfig {
  nodes: NodeConfig[];
  connections: ConnectionConfig[];
}

/** 一个在途批次：发货瞬间已离开来源库存，并在目的地预留了等量空间。 */
export interface Shipment {
  id: number;
  connectionId: string;
  from: string;
  to: string;
  cargo: Stock;
  /** 计划到达 tick。 */
  arriveAt: number;
  /** 用于 Canvas 插值渲染。 */
  departAt: number;
  transportTicks: number;
}

/** 正在加工的批次；配方在开工时快照，运行中改配方不影响本批次。 */
export interface ActiveBatch {
  recipeId: string;
  recipeSnapshot: Recipe;
  remainingTicks: number;
  totalTicks: number;
}

/** 节点当前为什么缺料 / 被谁挡住，供点击查看。 */
export interface NodeInspection {
  /** 缺料明细：资源 -> 缺少数量（需求 - 现有）。 */
  missing: Stock;
  /** 输出被挡住时，占用自身空间的下游预留来源（节点 id -> 件数）。 */
  blockedBy: Record<string, number>;
  /** blocked 时具体放不下的产物。 */
  blockedOutputs: Stock;
}

export interface NodeRuntime {
  configId: string;
  stock: Stock;
  /** 已完成但因自身空间不足尚未入库的产物（绝不丢弃、绝不重复扣料）。 */
  heldOutput: Stock;
  active: ActiveBatch | null;
  status: NodeStatus;
  inspection: NodeInspection;
}

export interface LedgerCounters {
  /** 累计开工消耗的原料（按资源）。 */
  consumed: Stock;
  /** 累计加工完成产出的产物（按资源，含已入库与待出库）。 */
  produced: Stock;
  /** 累计从节点库存发出的货物（按资源）。 */
  shipped: Stock;
  /** 累计到货进入节点库存的货物（按资源）。 */
  delivered: Stock;
}

/** 每个节点各自维护一套四栏计数器，用于按节点核对资源账。 */
export type NodeCounters = LedgerCounters;

export type SimEventType =
  | 'start' // 开工扣料
  | 'complete' // 加工完成（产物可能立即入库或进入待出库）
  | 'ship' // 发货
  | 'deliver' // 到货
  | 'blocked' // 完成但输出空间不足
  | 'starved'; // 尝试开工但缺料

export interface SimEvent {
  tick: number;
  type: SimEventType;
  nodeId?: string;
  connectionId?: string;
  detail: string;
  stock?: Stock;
}

export interface SimState {
  tick: number;
  config: SimConfig;
  nodes: Record<string, NodeRuntime>;
  shipments: Shipment[];
  /** 全局累计（各节点计数器之和的便捷汇总）。 */
  ledger: LedgerCounters;
  /** 节点 id -> 四栏计数器，随每个 tick 实时维护。 */
  nodeCounters: Record<string, NodeCounters>;
  events: SimEvent[];
  nextShipmentId: number;
}

export const TICK_SECONDS = 0.5;
export const MAX_EVENTS = 400;
