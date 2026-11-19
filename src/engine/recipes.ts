import type { Recipe, ResourceId, Stock } from './types';

export const RESOURCE_META: Record<ResourceId, { name: string; color: string }> = {
  ironOre: { name: '铁矿石', color: '#b08968' },
  copperOre: { name: '铜矿石', color: '#d97941' },
  ironIngot: { name: '铁锭', color: '#9aa5b1' },
  copperIngot: { name: '铜锭', color: '#e09f3e' },
  gear: { name: '齿轮', color: '#7f8c8d' },
  circuit: { name: '电路板', color: '#2a9d8f' },
  motor: { name: '电机', color: '#6a4c93' },
};

export const ALL_RESOURCES = Object.keys(RESOURCE_META) as ResourceId[];

/**
 * 固定配方目录。时长单位为 tick（1 tick = 0.5s）。
 * 采矿机配方无输入，模拟矿点持续供矿。
 */
export const RECIPES: Recipe[] = [
  {
    id: 'mine-iron',
    name: '开采铁矿石',
    nodeType: 'miner',
    inputs: {},
    outputs: { ironOre: 2 },
    durationTicks: 4,
  },
  {
    id: 'mine-copper',
    name: '开采铜矿石',
    nodeType: 'miner',
    inputs: {},
    outputs: { copperOre: 2 },
    durationTicks: 4,
  },
  {
    id: 'smelt-iron',
    name: '冶炼铁锭',
    nodeType: 'smelter',
    inputs: { ironOre: 2 },
    outputs: { ironIngot: 1 },
    durationTicks: 6,
  },
  {
    id: 'smelt-copper',
    name: '冶炼铜锭',
    nodeType: 'smelter',
    inputs: { copperOre: 2 },
    outputs: { copperIngot: 1 },
    durationTicks: 6,
  },
  {
    id: 'craft-gear',
    name: '加工齿轮',
    nodeType: 'assembler',
    inputs: { ironIngot: 2 },
    outputs: { gear: 1 },
    durationTicks: 8,
  },
  {
    id: 'craft-circuit',
    name: '加工电路板',
    nodeType: 'assembler',
    inputs: { copperIngot: 2 },
    outputs: { circuit: 1 },
    durationTicks: 8,
  },
  {
    id: 'craft-motor',
    name: '装配电机',
    nodeType: 'assembler',
    inputs: { ironIngot: 1, copperIngot: 1, gear: 1 },
    outputs: { motor: 1 },
    durationTicks: 12,
  },
];

export const RECIPE_MAP: Record<string, Recipe> = Object.fromEntries(
  RECIPES.map((r) => [r.id, r]),
);

export function recipesForNodeType(type: Recipe['nodeType']): Recipe[] {
  return RECIPES.filter((r) => r.nodeType === type);
}

// ---- 纯库存运算（不修改入参） ----

export function stockAmount(stock: Stock, res: ResourceId): number {
  return stock[res] ?? 0;
}

export function stockTotal(stock: Stock): number {
  return ALL_RESOURCES.reduce((sum, r) => sum + (stock[r] ?? 0), 0);
}

export function addStock(target: Stock, delta: Stock): Stock {
  const out: Stock = { ...target };
  for (const res of ALL_RESOURCES) {
    const v = (out[res] ?? 0) + (delta[res] ?? 0);
    if (v !== 0) out[res] = v;
    else delete out[res];
  }
  return out;
}

export function subStock(target: Stock, delta: Stock): Stock {
  const neg: Stock = {};
  for (const res of ALL_RESOURCES) {
    if (delta[res]) neg[res] = -delta[res]!;
  }
  return addStock(target, neg);
}

/** target 是否至少包含 required 的每一种资源。 */
export function containsStock(target: Stock, required: Stock): boolean {
  return ALL_RESOURCES.every((r) => (target[r] ?? 0) >= (required[r] ?? 0));
}

/** 计算 required 相对 target 的缺口（只包含不足的资源）。 */
export function missingStock(target: Stock, required: Stock): Stock {
  const out: Stock = {};
  for (const res of ALL_RESOURCES) {
    const need = required[res] ?? 0;
    const gap = need - (target[res] ?? 0);
    if (gap > 0) out[res] = gap;
  }
  return out;
}

export function formatStock(stock: Stock): string {
  const parts = ALL_RESOURCES.filter((r) => stock[r]).map(
    (r) => `${RESOURCE_META[r].name}×${stock[r]}`,
  );
  return parts.length ? parts.join('，') : '空';
}
