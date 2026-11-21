import { fnv1a } from './rng';
import type { Placement } from './generator';
import type { TerrainStyle } from './terrain';
import type { VegType } from './vegetation';

export interface SaveData {
  version: 1;
  seed: string;
  terrainStyle: TerrainStyle;
  types: VegType[];
  placements: Placement[];
}

export function serialize(
  seed: string,
  terrainStyle: TerrainStyle,
  types: VegType[],
  placements: Placement[],
): string {
  const data: SaveData = { version: 1, seed, terrainStyle, types, placements };
  return JSON.stringify(data, null, 2);
}

export function deserialize(json: string): SaveData {
  const data = JSON.parse(json) as SaveData;
  if (data.version !== 1) throw new Error(`不支持的存档版本: ${data.version}`);
  if (typeof data.seed !== 'string' || !Array.isArray(data.placements)) {
    throw new Error('存档格式不正确');
  }
  return data;
}

/** 放置结果的稳定哈希，用于验证同种子复现与存档一致性 */
export function placementsHash(placements: Placement[]): string {
  const s = placements
    .map((p) => `${p.x},${p.y},${p.type},${p.pinned ? 1 : 0}`)
    .sort()
    .join(';');
  return fnv1a(s).toString(16);
}
