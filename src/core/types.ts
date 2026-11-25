export type BlendMode = 'alpha' | 'additive';
export type SceneKey = 'sparse' | 'interleaved' | 'dense';

export type Rgba = readonly [number, number, number, number];

export interface Sprite {
  readonly id: number;
  /** 背景精灵用 #编号；可拖动探针用 A/B/C… */
  readonly label: string;
  readonly textureIndex: number;
  readonly blend: BlendMode;
  readonly tint: Rgba;
  x: number;
  y: number;
  readonly w: number;
  readonly h: number;
  /** 0 = 最远处的层；数字越大越靠近观察者。 */
  layer: number;
  /** 同层内的稳定次序；与 layer 一起构成画家算法的排序键。 */
  readonly order: number;
  /** 只有少数互相重叠的探针可拖动、可改层。 */
  readonly draggable: boolean;
  /** 探针在场景中的序号（0..n-1），背景精灵为 null。 */
  readonly probeIndex: number | null;
}

export interface Scene {
  readonly key: SceneKey;
  readonly title: string;
  readonly subtitle: string;
  readonly seed: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** 层数，UI 中显示为 1..layerCount。 */
  readonly layerCount: number;
  readonly layerNames: readonly string[];
  readonly sprites: readonly Sprite[];
  readonly notes: readonly string[];
}

export interface SpriteStateSnapshot {
  id: number;
  x: number;
  y: number;
  layer: number;
}

export const BLEND_LABEL: Record<BlendMode, string> = {
  alpha: '普通透明',
  additive: '叠加发光',
};

export const BLEND_SHORT: Record<BlendMode, string> = {
  alpha: 'α',
  additive: '＋',
};

export const BLEND_COLOR: Record<BlendMode, string> = {
  alpha: '#5bd6ff',
  additive: '#ffb45c',
};
