import { Piece, PieceKind, Pt, DirSet, allDirs, World } from './engine';

/** 构件模板: 面板里选择后在画布上点击放置 */
export interface PieceTemplate {
  kind: PieceKind;
  label: string;
  baseCells: Pt[];
  weight: number;
  capacity: number;
  bearing: DirSet;
  color: string;
  desc: string;
}

export const TEMPLATES: Record<PieceKind, PieceTemplate> = {
  foundation: {
    kind: 'foundation',
    label: '地基',
    baseCells: [{ x: 0, y: 0 }],
    weight: 0,
    capacity: Infinity,
    // 地基自身接地, 不需要任何邻居支撑; 它支撑别人由别人的 bearing 决定
    bearing: { north: false, south: false, west: false, east: false },
    color: '#8b7355',
    desc: '与地面接触即接地, 承重无限, 可移除',
  },
  pillar: {
    kind: 'pillar',
    label: '支柱',
    baseCells: [{ x: 0, y: 0 }],
    weight: 2,
    capacity: 12,
    // 只接受来自下方(south)的支撑
    bearing: { north: false, south: true, west: false, east: false },
    color: '#6b8e9e',
    desc: '只接受竖向支撑(被下方托住), 可托住任何接受南向支撑的构件',
  },
  deck: {
    kind: 'deck',
    label: '梁',
    baseCells: [{ x: 0, y: 0 }],
    weight: 4,
    capacity: 60,
    bearing: { north: false, south: true, west: false, east: false },
    color: '#b08968',
    desc: '长度可调的水平多格构件, 自重 = 单格自重 × 长度, 接受下方支撑',
  },
  block: {
    kind: 'block',
    label: '砖',
    baseCells: [{ x: 0, y: 0 }],
    weight: 2,
    capacity: 30,
    bearing: allDirs(),
    color: '#9a8c98',
    desc: '四方向都能接受支撑, 可拼成闭合承重环',
  },
};

let seq = 0;
export function nextId(kind: PieceKind): string {
  seq += 1;
  return `${kind}-${seq}`;
}

/** 按模板生成构件; length 用于桥面多格, rotate 切换水平/竖直 */
export function makePiece(
  tpl: PieceTemplate,
  origin: Pt,
  length = 1,
  rotate = false,
  overrides: Partial<Piece> = {},
): Piece {
  let cells: Pt[];
  if (tpl.kind === 'deck' && length > 1) {
    cells = Array.from({ length }, (_, i) =>
      rotate ? { x: origin.x, y: origin.y + i } : { x: origin.x + i, y: origin.y },
    );
  } else {
    cells = tpl.baseCells.map((c) =>
      rotate ? { x: origin.x - c.y, y: origin.y + c.x } : { x: origin.x + c.x, y: origin.y + c.y },
    );
  }
  const weight = tpl.kind === 'deck' ? tpl.weight * length : tpl.weight;
  return {
    id: nextId(tpl.kind),
    kind: tpl.kind,
    name: tpl.label,
    cells,
    weight,
    capacity: tpl.capacity,
    bearing: { ...tpl.bearing },
    color: tpl.color,
    ...overrides,
  };
}

export const GRID_W = 14;
export const GRID_H = 10;
export const GROUND_Y = 9; // 该行绘制地面; 构件格子 y 范围 0..8

function foundation(x: number, y: number): Piece {
  return makePiece(TEMPLATES.foundation, { x, y });
}
function pillar(x: number, y: number, capacity = 12): Piece {
  return makePiece(TEMPLATES.pillar, { x, y }, 1, false, { capacity });
}
function deck(x: number, y: number, length: number, capacity = 60): Piece {
  return makePiece(TEMPLATES.deck, { x, y }, length, false, { capacity });
}
function block(x: number, y: number): Piece {
  return makePiece(TEMPLATES.block, { x, y });
}

export interface Preset {
  id: string;
  title: string;
  brief: string;
  /** 建议在预览里拆除的构件 id 前缀匹配(供 main 提示用) */
  removalHint: string;
  build: () => Piece[];
}

/**
 * 预设一 · 桥面
 * 两座"地基+墩座"桥台 + 两根支柱共同托住 11 格桥面, 四个支撑顶端都与桥面(y=6)直接相邻。
 * 桥面自重 44, 四条竖向支撑链各分担 11;
 * 支柱容量 24: 拆掉一根后, 剩下的构件仍成接地链 → 不掉, 仅负载重分配。
 */
function buildBridge(): Piece[] {
  const ps: Piece[] = [];
  // 桥台: 地基(y=8) + 墩座(y=7) + 墩座(y=6), 顶端托住桥面
  const abut = (x: number) => {
    ps.push(foundation(x, 8));
    for (const y of [7, 6]) {
      ps.push(makePiece(TEMPLATES.block, { x, y }, 1, false, {
        name: '墩',
        capacity: 30,
        bearing: { north: false, south: true, west: false, east: false },
        color: TEMPLATES.foundation.color,
      }));
    }
  };
  abut(1);
  abut(11);
  // 两格高支柱 y=6..7 + 地基 y=8, 顶端同样在 y=6
  ps.push(foundation(4, 8));
  ps.push(makePiece(TEMPLATES.pillar, { x: 4, y: 6 }, 1, false, {
    capacity: 24,
    cells: [{ x: 4, y: 6 }, { x: 4, y: 7 }],
  }));
  ps.push(foundation(8, 8));
  ps.push(makePiece(TEMPLATES.pillar, { x: 8, y: 6 }, 1, false, {
    capacity: 24,
    cells: [{ x: 8, y: 6 }, { x: 8, y: 7 }],
  }));
  // 桥面 y=5, x=1..11, 与四个支撑顶端(y=6)直接相邻
  ps.push(deck(1, 5, 11, 60));
  return ps;
}

/**
 * 预设二 · 双支柱
 * 桥面自重 24, 两根支柱(容量各 16)均分, 每柱 12 → 站立但逼近上限(琥珀色)。
 * 拆掉一根: 拓扑预览标出桥面"失去一条支撑边但仍站立";
 * 真实结算中另一柱负载 24 > 16 超载断裂 → 桥面级联掉落。
 */
function buildTwinPillars(): Piece[] {
  const ps: Piece[] = [];
  ps.push(foundation(5, 8), foundation(8, 8));
  ps.push(pillar(5, 7, 16), pillar(8, 7, 16));
  ps.push(deck(4, 6, 6, 40)); // x=4..9, 自重 24
  return ps;
}

/**
 * 预设三 · 闭合悬空结构
 * 12 块砌块拼成 4×4 闭合承重环, 四方向互撑; 环仅经 (2,6) 砌块 + 支柱 + 地基一个锚点接地。
 * 右上角 2×2 漂浮块与任何构件都不接触 → 开局即悬空(红色)。
 * 拆除锚点支柱: 承重环失去唯一条接地链, 环内虽互撑但无地基 → 整环悬空掉落。
 */
function buildRing(): Piece[] {
  const ps: Piece[] = [];
  for (let x = 2; x <= 5; x++) {
    ps.push(block(x, 2));
    ps.push(block(x, 5));
  }
  for (let y = 3; y <= 4; y++) {
    ps.push(block(2, y));
    ps.push(block(5, y));
  }
  // 锚点链: 环底 (2,5) → 砌块 (2,6) → 支柱 (2,7) → 地基 (2,8)
  ps.push(block(2, 6));
  ps.push(pillar(2, 7, 30));
  ps.push(foundation(2, 8));
  // 完全无依的 2×2 漂浮块
  ps.push(block(10, 2), block(11, 2), block(10, 3), block(11, 3));
  return ps;
}

export const PRESETS: Preset[] = [
  {
    id: 'bridge',
    title: '预设一 · 桥面',
    brief:
      '桥台+双支柱托住长桥面。拆除任一支柱: 预览只标出桥面失去一条支撑边(仍站立), 结算同样不掉, 负载在剩余支撑间重分配。',
    removalHint: 'pillar',
    build: buildBridge,
  },
  {
    id: 'twin',
    title: '预设二 · 双支柱',
    brief:
      '两柱均分桥面负载(各 12/16, 琥珀预警)。拆一根: 预览认为桥面仍有支撑而站立, 真实结算另一柱超载断裂, 桥面级联掉落 —— 预览与结算出现差异。',
    removalHint: 'pillar',
    build: buildTwinPillars,
  },
  {
    id: 'ring',
    title: '预设三 · 闭合悬空结构',
    brief:
      '闭合承重环仅一个锚点接地, 另有开局即悬空的 2×2 漂浮块。拆除锚点支柱: 承重环无地基→整环悬空; 对比拓扑预览与真实结算。',
    removalHint: 'pillar',
    build: buildRing,
  },
];

export function loadPreset(world: World, preset: Preset) {
  world.reset(preset.build());
}

export function freshWorld(): World {
  return new World(GROUND_Y, GRID_W);
}
