import { DEFAULT_MESH_PARAMS, type MeshParams, type PinSpec, type SavedConfig, type Weights } from './types';

/**
 * 配置持久化。
 * 保存内容 = 网格生成参数 + 当前权重 + 固定测点;
 * 载入时按同一参数重建同一网格再施加同一权重, 画面应当完全一致。
 */
export function saveConfig(weights: Weights, pins: PinSpec[], meshParams: MeshParams): string {
  const config: SavedConfig = {
    version: 1,
    savedAt: new Date().toISOString(),
    meshParams,
    weights,
    pins,
  };
  return JSON.stringify(config, null, 2);
}

export function parseConfig(text: string): SavedConfig {
  const raw = JSON.parse(text) as SavedConfig;
  if (raw.version !== 1) throw new Error(`不支持的配置版本: ${raw.version}`);
  validateMeshParams(raw.meshParams);
  validateWeights(raw.weights);
  if (!Array.isArray(raw.pins)) throw new Error('pins 必须是数组');
  for (const p of raw.pins) {
    if ((p.part !== 'wall' && p.part !== 'lid') || !Number.isInteger(p.vertex)) {
      throw new Error('测点格式非法');
    }
  }
  return raw;
}

function validateMeshParams(p: MeshParams) {
  const d = DEFAULT_MESH_PARAMS;
  const keys = Object.keys(d) as (keyof MeshParams)[];
  for (const k of keys) {
    if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) {
      throw new Error(`网格参数 ${k} 非法`);
    }
  }
}

function validateWeights(w: Weights) {
  for (const part of ['wall', 'lid'] as const) {
    for (const t of ['bulge', 'dent', 'pinch'] as const) {
      if (typeof w[part][t] !== 'number') throw new Error(`权重 ${part}.${t} 非法`);
    }
  }
  if (typeof w.hingeDeg !== 'number' || typeof w.flex !== 'number') {
    throw new Error('铰链参数非法');
  }
}

export function downloadConfig(text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `soft-container-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
