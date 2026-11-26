import type { Dir, Level, MarkerKind, SideId } from './engine.js';

interface RawDoor {
  id: string;
  char: string;
  initiallyOpen: boolean;
  label: string;
}

interface RawMarker {
  id: string;
  char: string;
  kind: MarkerKind;
  doorId: string;
  label: string;
}

interface RawLevel {
  id: string;
  index: number;
  name: string;
  tagline: string;
  lesson: string;
  guidePhysicalCol: number;
  maps: Record<SideId, string[]>;
  doors: RawDoor[];
  markers: RawMarker[];
  replay: {
    win: string;
    dead?: string;
    deadNote?: string;
  };
}

function findChar(lines: string[], ch: string): { r: number; c: number } {
  for (let r = 0; r < lines.length; r += 1) {
    const c = lines[r]!.indexOf(ch);
    if (c >= 0) return { r, c };
  }
  throw new Error(`Missing character ${ch} in map:\n${lines.join('\n')}`);
}

function findAllChar(lines: string[], ch: string): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = [];
  lines.forEach((line, r) => {
    for (let c = 0; c < line.length; c += 1) {
      if (line[c] === ch) out.push({ r, c });
    }
  });
  return out;
}

function parseLevel(raw: RawLevel): Level {
  const first = raw.maps.inside[0];
  if (!first) throw new Error(`${raw.id}: empty inside map`);
  const cols = first.length;
  const rows = raw.maps.inside.length;

  for (const side of ['inside', 'outside'] as SideId[]) {
    const lines = raw.maps[side];
    if (lines.length !== rows) throw new Error(`${raw.id}: ${side} row count mismatch`);
    lines.forEach((line, r) => {
      if (line.length !== cols) {
        throw new Error(`${raw.id}: ${side} row ${r} has length ${line.length}, expected ${cols}`);
      }
    });
  }

  const walls = { inside: [], outside: [] } as Record<SideId, Array<{ r: number; c: number }>>;
  const start = {} as Record<SideId, { r: number; c: number }>;

  for (const side of ['inside', 'outside'] as SideId[]) {
    for (let r = 0; r < rows; r += 1) {
      const line = raw.maps[side][r]!;
      for (let c = 0; c < cols; c += 1) {
        const ch = line[c];
        if (ch === '#') walls[side].push({ r, c });
        if (ch === '@') start[side] = { r, c };
      }
    }
    if (!start[side]) throw new Error(`${raw.id}: missing @ start for ${side}`);
  }

  const doors = raw.doors.map((door) => ({
    id: door.id,
    initiallyOpen: door.initiallyOpen,
    label: door.label,
    at: {
      inside: findChar(raw.maps.inside, door.char),
      outside: findChar(raw.maps.outside, door.char),
    },
  }));

  const markers = raw.markers.map((marker) => ({
    id: marker.id,
    kind: marker.kind,
    doorId: marker.doorId,
    label: marker.label,
    at: {
      inside: findChar(raw.maps.inside, marker.char),
      outside: findChar(raw.maps.outside, marker.char),
    },
  }));

  const targets = (['inside', 'outside'] as SideId[]).map((side) => ({
    side,
    pos: findChar(raw.maps[side], 'T'),
    color: side === 'inside' ? '#f59e0b' : '#22d3ee',
    name: side === 'inside' ? '琥珀甲虫目标' : '青蓝甲虫目标',
  }));

  return {
    id: raw.id,
    index: raw.index,
    name: raw.name,
    tagline: raw.tagline,
    lesson: raw.lesson,
    rows,
    cols,
    start,
    walls,
    doors,
    markers,
    targets,
    guidePhysicalCol: raw.guidePhysicalCol,
    replay: raw.replay,
  };
}

const RAW_LEVELS: RawLevel[] = [
  {
    id: 'mirror-first-steps',
    index: 0,
    name: '第一扇窗：方向与镜像列',
    tagline: '同一枚方向键，在两张各自的视图里都按屏幕方向走。',
    lesson:
      '按 → 时，两只甲虫都在自己的视图里向右；但窗外一侧是水平镜像，所以它们的物理横向其实相反。金色竖带是同一物理列 P2：在内侧是第 3 列，在外侧却画在第 5 列。沿 R D D D D 可回放入门。',
    guidePhysicalCol: 2,
    maps: {
      inside: [
        '#######',
        '#@....#',
        '#..#..#',
        '#.S...#',
        '#.D#..#',
        '#.T...#',
        '#######',
      ],
      outside: [
        '#######',
        '#..@..#',
        '#.#..##',
        '#...S.#',
        '#..#D.#',
        '#...T.#',
        '#######',
      ],
    },
    doors: [{ id: 'glass-door', char: 'D', initiallyOpen: false, label: '镜像门对' }],
    markers: [
      { id: 'teach-switch', char: 'S', kind: 'toggle', doorId: 'glass-door', label: '共鸣标记' },
    ],
    replay: { win: 'RDDDD' },
  },
  {
    id: 'one-side-held',
    index: 1,
    name: '第二扇窗：让一侧被墙拦住',
    tagline: '方向相同，但地形不同；被堵住的一只留下，另一只继续改写列差。',
    lesson:
      '两只出发在同一视图列。先 D D 到走廊，再连按 R：外侧甲虫会被第 4 列的墙挡住并留在共鸣点，内侧甲虫独自向右，直到两只同时踩上 P5 镜像标记。门从下一步才开启。回放：D D R R R R D D。',
    guidePhysicalCol: 5,
    maps: {
      inside: [
        '#######',
        '#@.#..#',
        '#..#..#',
        '#....S#',
        '#.#..D#',
        '#..#.T#',
        '#######',
      ],
      outside: [
        '#######',
        '#@....#',
        '#..#..#',
        '#S#...#',
        '#D#...#',
        '#T#...#',
        '#######',
      ],
    },
    doors: [{ id: 'side-door', char: 'D', initiallyOpen: false, label: '两侧门对' }],
    markers: [
      { id: 'meet-switch', char: 'S', kind: 'toggle', doorId: 'side-door', label: '相遇标记' },
    ],
    replay: { win: 'DDRRRRDD' },
  },
  {
    id: 'spent-key-deadend',
    index: 2,
    name: '第三扇窗：一次消耗错时机',
    tagline: '一次性钥匙标记只会在首次同时踩中时翻转；用错顺序会留下可诊断的死局。',
    lesson:
      'K 标记首次同时踩中后会熄灭并反转门对，站住不重复触发。若门在甲虫脚下关闭，离开不检查门；只有下一次进入该格时才检查。可用正确回放与“错误消耗”演示对照，再按 U 撤销或 H 求真实状态下的下一步。',
    guidePhysicalCol: 3,
    maps: {
      inside: [
        '#######',
        '#..@..#',
        '#.#...#',
        '#..K..#',
        '#..D..#',
        '###T###',
        '#######',
      ],
      outside: [
        '#######',
        '#..@..#',
        '#...#.#',
        '#..K..#',
        '#..D..#',
        '###T###',
        '#######',
      ],
    },
    doors: [{ id: 'key-door', char: 'D', initiallyOpen: true, label: '钥匙门对' }],
    markers: [
      { id: 'only-key', char: 'K', kind: 'once', doorId: 'key-door', label: '钥匙印记' },
    ],
    replay: {
      win: 'DLDDDRD',
      dead: 'DD',
      deadNote: '两只在 K 上首次会合，钥匙被消耗并把门反转成关闭。',
    },
  },
];

export const LEVELS: Level[] = RAW_LEVELS.map(parseLevel);

export function getLevel(id: string): Level {
  const level = LEVELS.find((item) => item.id === id);
  if (!level) throw new Error(`Unknown level: ${id}`);
  return level;
}

export function dirLabel(dir: Dir | null): string {
  if (!dir) return '无';
  return { up: '↑', down: '↓', left: '←', right: '→' }[dir];
}
