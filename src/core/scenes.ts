import { mulberry32, pick, range, type Rng } from '../core/rng';
import type { BlendMode, Rgba, Scene, SceneKey, Sprite } from '../core/types';
import { TEXTURE_SPECS } from '../render/textures';

export const WORLD_W = 3600;
export const WORLD_H = 2400;

const LAYER_NAMES = ['天幕', '远景', '中景', '主景', '近景', '前景'] as const;

interface Palette {
  readonly rgb: readonly [number, number, number];
  readonly alpha: readonly [number, number];
}

const ALPHA_PALETTE: readonly Palette[] = [
  { rgb: [0.43, 0.83, 1.0], alpha: [0.3, 0.8] },
  { rgb: [0.78, 0.55, 1.0], alpha: [0.26, 0.72] },
  { rgb: [1.0, 0.62, 0.7], alpha: [0.24, 0.66] },
  { rgb: [0.55, 1.0, 0.72], alpha: [0.22, 0.62] },
  { rgb: [1.0, 0.95, 0.88], alpha: [0.18, 0.55] },
  { rgb: [0.42, 0.6, 1.0], alpha: [0.3, 0.75] },
];

const ADDITIVE_PALETTE: readonly Palette[] = [
  { rgb: [1.0, 0.78, 0.34], alpha: [0.12, 0.4] },
  { rgb: [1.0, 0.47, 0.22], alpha: [0.1, 0.34] },
  { rgb: [0.55, 0.9, 1.0], alpha: [0.1, 0.32] },
  { rgb: [0.82, 1.0, 0.55], alpha: [0.1, 0.3] },
];

interface SceneMeta {
  readonly title: string;
  readonly subtitle: string;
  readonly seed: number;
  readonly notes: readonly string[];
  readonly textureKeys: readonly string[];
  readonly clusterCount: number;
  readonly perCluster: readonly [number, number];
  readonly sizeRange: readonly [number, number];
  readonly additiveChance: number;
  readonly forcedAlternation: boolean;
}

export const SCENE_META: Record<SceneKey, SceneMeta> = {
  sparse: {
    title: '稀疏',
    subtitle: '少量大件铺在整张地图，重叠有限',
    seed: 0x5eed_0001,
    notes: [
      '贴合批量主要来自同层同混合的连续精灵；画面缩得很远时入镜数会快速上升。',
      '大多数相邻精灵不重叠，但仍要求两条路径覆盖结果逐像素一致。',
    ],
    textureKeys: ['glow', 'ring', 'card', 'eroded', 'disc'],
    clusterCount: 4,
    perCluster: [6, 10],
    sizeRange: [190, 380],
    additiveChance: 0.16,
    forcedAlternation: false,
  },
  interleaved: {
    title: '交叉混合',
    subtitle: '同层内两种混合交替出现，批次被频繁切段',
    seed: 0x5eed_0102,
    notes: [
      '同层里"普通透明 → 叠加发光 → 普通透明"的夹心会被切出三段批次；切段处保留原可见次序。',
      '把探针 B（叠加）拖进 A、C 所在的层，或直接移动层号，即可看到插入点两侧的批次被打断。',
    ],
    textureKeys: ['disc', 'glow', 'card', 'ring', 'spark', 'smoke'],
    clusterCount: 6,
    perCluster: [10, 15],
    sizeRange: [110, 280],
    additiveChance: 0.28,
    forcedAlternation: true,
  },
  dense: {
    title: '密集',
    subtitle: '上千片叠在一起，合批与剔除同时承压',
    seed: 0x5eed_0203,
    notes: [
      '密集场景里入镜数对相机非常敏感，合批次数也会随可见交替模式变化。',
      '逐像素比对的读回缓冲区就是这一侧 WebGL 实际写出的 RGBA 内容，不是截图差异。',
    ],
    textureKeys: ['glow', 'disc', 'ring', 'smoke', 'spark', 'card', 'eroded'],
    clusterCount: 10,
    perCluster: [24, 34],
    sizeRange: [80, 230],
    additiveChance: 0.22,
    forcedAlternation: false,
  },
};

export const PROBE_TEXTURES = ['disc', 'spark', 'card'] as const;
export const PROBE_LABELS = ['A', 'B', 'C'] as const;

function textureIndexFor(keys: readonly string[], key: string): number {
  const idx = TEXTURE_SPECS.findIndex((spec) => spec.key === key);
  if (idx < 0) throw new Error(`未知贴图: ${key}`);
  if (!keys.includes(key)) throw new Error(`场景未声明贴图: ${key}`);
  return idx;
}

function tintFor(rng: Rng, blend: BlendMode): Rgba {
  const palette = blend === 'additive' ? ADDITIVE_PALETTE : ALPHA_PALETTE;
  const entry = pick(rng, palette);
  const alpha = range(rng, entry.alpha[0], entry.alpha[1]);
  return [entry.rgb[0], entry.rgb[1], entry.rgb[2], alpha];
}

function makeSprite(
  id: number,
  label: string,
  textureIndex: number,
  blend: BlendMode,
  tint: Rgba,
  x: number,
  y: number,
  w: number,
  h: number,
  layer: number,
  order: number,
  draggable: boolean,
  probeIndex: number | null,
): Sprite {
  return { id, label, textureIndex, blend, tint, x, y, w, h, layer, order, draggable, probeIndex };
}

function buildProbes(startId: number, textureKeys: readonly string[]): Sprite[] {
  const specs = [
    {
      label: 'A',
      texture: 'disc',
      blend: 'alpha' as const,
      tint: [0.6, 0.92, 1, 0.62] as Rgba,
      x: WORLD_W / 2 - 120,
      y: WORLD_H / 2 - 60,
      w: 470,
      h: 470,
      layer: LAYER_NAMES.length - 1,
    },
    {
      label: 'B',
      texture: 'spark',
      blend: 'additive' as const,
      tint: [1, 0.72, 0.3, 0.34] as Rgba,
      x: WORLD_W / 2 + 40,
      y: WORLD_H / 2 + 30,
      w: 430,
      h: 430,
      layer: LAYER_NAMES.length - 1,
    },
    {
      label: 'C',
      texture: 'card',
      blend: 'alpha' as const,
      tint: [1, 0.48, 0.72, 0.5] as Rgba,
      x: WORLD_W / 2 - 440,
      y: WORLD_H / 2 - 260,
      w: 520,
      h: 520,
      layer: LAYER_NAMES.length - 1,
    },
  ];
  const texIdx = (key: string) => textureIndexFor(textureKeys, key);
  return specs.map((spec, i) =>
    makeSprite(
      startId + i,
      spec.label,
      texIdx(spec.texture),
      spec.blend,
      spec.tint,
      spec.x,
      spec.y,
      spec.w,
      spec.h,
      spec.layer,
      10_000 + i * 1_000,
      true,
      i,
    ),
  );
}

export function buildScene(key: SceneKey): Scene {
  const meta = SCENE_META[key];
  const rng = mulberry32(meta.seed);
  const textureKeys = TEXTURE_SPECS.map((s) => s.key);
  const sprites: Sprite[] = [];
  const orders = LAYER_NAMES.map(() => 0);
  let nextId = 1;

  for (let layer = 0; layer < LAYER_NAMES.length; layer++) {
    // 层越靠前景，团簇越集中在画面中部。
    const layerT = layer / (LAYER_NAMES.length - 1);
    for (let c = 0; c < meta.clusterCount; c++) {
      const spreadX = range(rng, 0.18, 0.82) * WORLD_W;
      const spreadY = range(rng, 0.18, 0.82) * WORLD_H;
      const pullToCenter = layerT * 0.22;
      const centerX = spreadX * (1 - pullToCenter) + (WORLD_W / 2) * pullToCenter;
      const centerY = spreadY * (1 - pullToCenter) + (WORLD_H / 2) * pullToCenter;
      const count = Math.round(range(rng, meta.perCluster[0], meta.perCluster[1]));
      for (let i = 0; i < count; i++) {
        const blendRoll = rng();
        const forcedAdditive = meta.forcedAlternation && orders[layer]! % 3 === 1;
        const blend: BlendMode =
          forcedAdditive || blendRoll < meta.additiveChance ? 'additive' : 'alpha';
        const texKey = pick(rng, meta.textureKeys);
        const textureIndex = textureIndexFor(textureKeys, texKey);
        const w = range(rng, meta.sizeRange[0], meta.sizeRange[1]);
        const h = w * range(rng, 0.72, 1.25);
        const jitterX = (rng() + rng() + rng() - 1.5) * w * 1.45;
        const jitterY = (rng() + rng() + rng() - 1.5) * h * 1.45;
        const x = Math.min(WORLD_W - w * 0.5, Math.max(-w * 0.5, centerX + jitterX));
        const y = Math.min(WORLD_H - h * 0.5, Math.max(-h * 0.5, centerY + jitterY));
        sprites.push(
          makeSprite(
            nextId,
            `#${nextId}`,
            textureIndex,
            blend,
            tintFor(rng, blend),
            x,
            y,
            w,
            h,
            layer,
            orders[layer]!++,
            false,
            null,
          ),
        );
        nextId++;
      }
    }
  }

  const probes = buildProbes(nextId, textureKeys);
  for (const probe of probes) sprites.push(probe);

  return {
    key,
    title: meta.title,
    subtitle: meta.subtitle,
    seed: meta.seed,
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    layerCount: LAYER_NAMES.length,
    layerNames: LAYER_NAMES,
    sprites,
    notes: meta.notes,
  };
}

/** 克隆所有精灵的坐标/层可变状态，用于在 UI 中拖动而不破坏固定种子基线。 */
export function snapshotSprites(scene: Scene): Sprite[] {
  return scene.sprites.map((s) => ({ ...s }));
}
