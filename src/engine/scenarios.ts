import type { SimConfig } from './types';

// 画布固定 1080×640，坐标在三个场景中手工排布，避免连线大面积重叠。

/**
 * 场景一：供给不足
 * 铁矿有限（初始 4 + 采矿机持续补矿但运输/加工节拍慢），
 * 装配台同时还需要齿轮链，齿轮断料时整线在装配台前 starving。
 */
export function scenarioSupplyShortage(): SimConfig {
  return {
    nodes: [
      { id: 'n1', name: '铁矿采矿机', type: 'miner', x: 90, y: 120, recipeId: 'mine-iron', capacity: 20, initialStock: { ironOre: 4 }, paused: false },
      { id: 'n2', name: '炼铁炉', type: 'smelter', x: 390, y: 120, recipeId: 'smelt-iron', capacity: 16, initialStock: {}, paused: false },
      { id: 'n3', name: '齿轮装配台', type: 'assembler', x: 690, y: 120, recipeId: 'craft-gear', capacity: 14, initialStock: {}, paused: false },
      { id: 'n4', name: '电机装配台', type: 'assembler', x: 690, y: 360, recipeId: 'craft-motor', capacity: 14, initialStock: { ironIngot: 2, gear: 1, copperIngot: 1 }, paused: false },
      { id: 'n5', name: '铜矿采矿机', type: 'miner', x: 90, y: 360, recipeId: 'mine-copper', capacity: 20, initialStock: { copperOre: 4 }, paused: false },
      { id: 'n6', name: '炼铜炉', type: 'smelter', x: 390, y: 360, recipeId: 'smelt-copper', capacity: 16, initialStock: {}, paused: false },
      { id: 'n7', name: '成品仓库', type: 'warehouse', x: 960, y: 360, recipeId: null, capacity: 30, initialStock: {}, paused: false },
    ],
    connections: [
      { id: 'c1', from: 'n1', to: 'n2', transportTicks: 4, maxInFlight: 2, enabled: true },
      { id: 'c2', from: 'n2', to: 'n3', transportTicks: 4, maxInFlight: 2, enabled: true },
      { id: 'c3', from: 'n3', to: 'n4', transportTicks: 3, maxInFlight: 2, enabled: true },
      { id: 'c4', from: 'n2', to: 'n4', transportTicks: 5, maxInFlight: 2, enabled: true },
      { id: 'c5', from: 'n5', to: 'n6', transportTicks: 4, maxInFlight: 2, enabled: true },
      { id: 'c6', from: 'n6', to: 'n4', transportTicks: 5, maxInFlight: 2, enabled: true },
      { id: 'c7', from: 'n4', to: 'n7', transportTicks: 3, maxInFlight: 2, enabled: true },
    ],
  };
}

/**
 * 场景二：下游满仓
 * 成品仓库容量只有 6，两条生产线同时向它发货，仓库很快被填满，
 * 随后装配台 blocked（待出库）、冶炼炉的发货预留也开始排队。
 */
export function scenarioFullWarehouse(): SimConfig {
  return {
    nodes: [
      { id: 'n1', name: '铁矿采矿机', type: 'miner', x: 80, y: 110, recipeId: 'mine-iron', capacity: 20, initialStock: { ironOre: 6 }, paused: false },
      { id: 'n2', name: '炼铁炉', type: 'smelter', x: 340, y: 110, recipeId: 'smelt-iron', capacity: 16, initialStock: { ironOre: 4 }, paused: false },
      { id: 'n3', name: '齿轮装配台', type: 'assembler', x: 610, y: 110, recipeId: 'craft-gear', capacity: 12, initialStock: { ironIngot: 4 }, paused: false },
      { id: 'n4', name: '铜矿采矿机', type: 'miner', x: 80, y: 420, recipeId: 'mine-copper', capacity: 20, initialStock: { copperOre: 6 }, paused: false },
      { id: 'n5', name: '炼铜炉', type: 'smelter', x: 340, y: 420, recipeId: 'smelt-copper', capacity: 16, initialStock: { copperOre: 4 }, paused: false },
      { id: 'n6', name: '电路板装配台', type: 'assembler', x: 610, y: 420, recipeId: 'craft-circuit', capacity: 12, initialStock: { copperIngot: 4 }, paused: false },
      { id: 'n7', name: '成品仓库（容量6）', type: 'warehouse', x: 920, y: 270, recipeId: null, capacity: 6, initialStock: {}, paused: false },
    ],
    connections: [
      { id: 'c1', from: 'n1', to: 'n2', transportTicks: 3, maxInFlight: 2, enabled: true },
      { id: 'c2', from: 'n2', to: 'n3', transportTicks: 3, maxInFlight: 2, enabled: true },
      { id: 'c3', from: 'n3', to: 'n7', transportTicks: 4, maxInFlight: 2, enabled: true },
      { id: 'c4', from: 'n4', to: 'n5', transportTicks: 3, maxInFlight: 2, enabled: true },
      { id: 'c5', from: 'n5', to: 'n6', transportTicks: 3, maxInFlight: 2, enabled: true },
      { id: 'c6', from: 'n6', to: 'n7', transportTicks: 4, maxInFlight: 2, enabled: true },
    ],
  };
}

/**
 * 场景三：两线抢料
 * 两台炼铁炉共用同一个铁矿仓库，按节点表顺序（n3 先于 n4）稳定竞争；
 * 仓库清空后其中一台必然 starving。下游两条电机装配线继续放大争抢效果。
 */
export function scenarioContention(): SimConfig {
  return {
    nodes: [
      { id: 'n1', name: '铁矿采矿机 A', type: 'miner', x: 70, y: 90, recipeId: 'mine-iron', capacity: 20, initialStock: { ironOre: 2 }, paused: false },
      { id: 'n2', name: '铁矿共享仓库', type: 'warehouse', x: 320, y: 270, recipeId: null, capacity: 24, initialStock: { ironOre: 6 }, paused: false },
      { id: 'n3', name: '炼铁炉 A（优先）', type: 'smelter', x: 580, y: 110, recipeId: 'smelt-iron', capacity: 14, initialStock: {}, paused: false },
      { id: 'n4', name: '炼铁炉 B', type: 'smelter', x: 580, y: 430, recipeId: 'smelt-iron', capacity: 14, initialStock: {}, paused: false },
      { id: 'n5', name: '齿轮装配台', type: 'assembler', x: 820, y: 110, recipeId: 'craft-gear', capacity: 12, initialStock: {}, paused: false },
      { id: 'n6', name: '电机装配台 A', type: 'assembler', x: 990, y: 110, recipeId: 'craft-motor', capacity: 12, initialStock: { copperIngot: 4, gear: 2 }, paused: false },
      { id: 'n7', name: '电机装配台 B', type: 'assembler', x: 820, y: 430, recipeId: 'craft-motor', capacity: 12, initialStock: { copperIngot: 4, gear: 2 }, paused: false },
      { id: 'n8', name: '铜矿采矿机', type: 'miner', x: 70, y: 470, recipeId: 'mine-copper', capacity: 20, initialStock: { copperOre: 8 }, paused: false },
    ],
    connections: [
      { id: 'c1', from: 'n1', to: 'n2', transportTicks: 3, maxInFlight: 2, enabled: true },
      { id: 'c2', from: 'n2', to: 'n3', transportTicks: 2, maxInFlight: 2, enabled: true },
      { id: 'c3', from: 'n2', to: 'n4', transportTicks: 2, maxInFlight: 2, enabled: true },
      { id: 'c4', from: 'n3', to: 'n5', transportTicks: 3, maxInFlight: 2, enabled: true },
      { id: 'c5', from: 'n5', to: 'n6', transportTicks: 2, maxInFlight: 2, enabled: true },
      { id: 'c6', from: 'n3', to: 'n7', transportTicks: 4, maxInFlight: 2, enabled: true },
      { id: 'c7', from: 'n4', to: 'n7', transportTicks: 4, maxInFlight: 2, enabled: true },
      { id: 'c8', from: 'n8', to: 'n6', transportTicks: 6, maxInFlight: 2, enabled: true },
      { id: 'c9', from: 'n8', to: 'n7', transportTicks: 6, maxInFlight: 2, enabled: true },
    ],
  };
}

export const SCENARIOS: { key: string; name: string; description: string; build: () => SimConfig }[] = [
  { key: 'shortage', name: '供给不足', description: '采矿节拍跟不上装配，观察缺料 starving 如何沿链传播。', build: scenarioSupplyShortage },
  { key: 'full', name: '下游满仓', description: '成品仓容量仅 6，观察容量预留、待出库与两来源不抢同一空位。', build: scenarioFullWarehouse },
  { key: 'contention', name: '两线抢料', description: '两台炼铁炉共用共享矿仓，按固定顺序竞争，结果可复现。', build: scenarioContention },
];
