import type { Dir, LevelDef, Placement } from './types.js';

export function sid(x: number, y: number): string {
  return `slot-${x}-${y}`;
}

interface AsciiLevelConfig {
  id: string;
  name: string;
  subtitle: string;
  brief: string;
  hint: string;
  rows: string[];
  launcherFacing: Dir;
  inventory: { thin: number; wide: number };
  win: LevelDef['win'];
  samplePlacement?: Placement[];
  sampleNote?: string;
  sampleButtonLabel?: string;
}

const GATE_DIR: Record<string, Dir> = { '^': 'N', '>': 'E', v: 'S', '<': 'W' };

export function defineAsciiLevel(config: AsciiLevelConfig): LevelDef {
  const height = config.rows.length;
  const width = Math.max(...config.rows.map((r) => r.length));
  const slots: LevelDef['slots'] = [];
  const fixed: LevelDef['fixed'] = [];

  config.rows.forEach((row, y) => {
    const chars = [...row];
    for (let x = 0; x < width; x += 1) {
      const ch = chars[x] ?? ' ';
      if (ch === ' ' || ch === '#' || ch === '·') continue;
      const slotId = sid(x, y);
      slots.push({
        id: slotId,
        x,
        y,
        wideBase: ch === 'W',
        forbidden: ch === 'X',
      });

      if (ch === 'L') {
        fixed.push({ id: 'launcher', kind: 'launcher', slotId, facing: config.launcherFacing, label: '启动片' });
      } else if (ch === 'A') {
        fixed.push({ id: 'flag-a', kind: 'flag', slotId, flagId: 'flag-a', order: 1, label: 'A 旗' });
      } else if (ch === 'B') {
        fixed.push({ id: 'flag-b', kind: 'flag', slotId, flagId: 'flag-b', order: 2, label: 'B 旗' });
      } else if (ch === 'P') {
        fixed.push({ id: `post-${x}-${y}`, kind: 'post', slotId, label: '挡柱' });
      } else if (GATE_DIR[ch]) {
        const dir = GATE_DIR[ch] as Dir;
        fixed.push({
          id: `gate-${x}-${y}`,
          kind: 'gate',
          slotId,
          facing: dir,
          acceptDir: dir,
          label: '单向片',
        });
      }
    }
  });

  return {
    id: config.id,
    name: config.name,
    subtitle: config.subtitle,
    brief: config.brief,
    hint: config.hint,
    width,
    height,
    slots,
    fixed,
    inventory: config.inventory,
    win: config.win,
    samplePlacement: config.samplePlacement,
    sampleNote: config.sampleNote,
    sampleButtonLabel: config.sampleButtonLabel,
  };
}

const level1Rows = [
  '        ',
  '        ',
  '  P P   ',
  ' L.W.>A ',
  '   . .X ',
  '   ...B ',
  '        ',
];

export const level1: LevelDef = defineAsciiLevel({
  id: 'level-1-post-and-gate',
  name: '第 1 关 · 绕柱过街',
  subtitle: '教学：朝向、挡柱、单向片与时差',
  brief: '让 A 旗先倒、B 旗后倒，并保持至少 5 拍间隔。避开红色禁碰槽，最多使用 7 片。',
  hint: '启动片朝东；宽槽可以把力量分成东、南两路。朝北乱转会亲到挡柱，单向片只认从西侧向东的碰撞。',
  rows: level1Rows,
  launcherFacing: 'E',
  inventory: { thin: 8, wide: 2 },
  win: { requiredFlags: ['flag-a', 'flag-b'], minIntervalBeats: 5, maxPieces: 7 },
});

const level2Rows = [
  '         ',
  '   P     ',
  '  P.>A   ',
  ' L.W.B.  ',
  '    ...  ',
  '     X   ',
  '         ',
];

export const level2: LevelDef = defineAsciiLevel({
  id: 'level-2-early-flag',
  name: '第 2 关 · 太早倒下的 B 旗',
  subtitle: '陷阱：看起来接通的短路',
  brief: 'B 旗就在分叉口东边。直接接通会让 B 比 A 更早落地；绕南侧长路，并避开禁碰槽。最多 8 片。',
  hint: 'A 路经过单向片，需要三跳才碰旗。B 口的细片不要朝东；让它向南多绕四段。宽片若同时给出东、南两路，短路仍会抢先。',
  rows: level2Rows,
  launcherFacing: 'E',
  inventory: { thin: 9, wide: 2 },
  win: { requiredFlags: ['flag-a', 'flag-b'], minIntervalBeats: 5, maxPieces: 8 },
  sampleButtonLabel: '载入短路陷阱（会失败）',
  sampleNote: '故意提供的错误摆法：东侧短路让 B 旗第 20 拍落地，早于 A 旗第 23 拍。它不是通关解。',
  samplePlacement: [
    { slotId: sid(2, 3), type: 'thin', facing: 'E' },
    { slotId: sid(3, 3), type: 'wide', facing: 'N' },
    { slotId: sid(3, 2), type: 'thin', facing: 'E' },
    { slotId: sid(4, 3), type: 'thin', facing: 'E' },
  ],
});

const sameBeatRows = [
  '        ',
  '  ...   ',
  'L.W..WA ',
  '   ...  ',
  '     B  ',
  '        ',
];

// Need verify ASCII coordinates against intended design; parser tests/debug will expose.
export const sameBeatSample: LevelDef = defineAsciiLevel({
  id: 'sample-same-beat-collision',
  name: '样例 A · 同拍相撞',
  subtitle: '两条等长路线在同一拍进入同一槽',
  brief: '可重复样例：两路在同一拍碰到同一片，只允许触发一次。',
  hint: '这是诊断样例，可直接载入固定摆法并导出记录。',
  rows: sameBeatRows,
  launcherFacing: 'E',
  inventory: { thin: 12, wide: 3 },
  win: { requiredFlags: ['flag-a', 'flag-b'], minIntervalBeats: 3, maxPieces: 20 },
  sampleNote: '对称两路均在第 18 拍到达 slot-4-2；记录中应有 1 个 triggered、1 个 merged-same-beat。',
  samplePlacement: [
    { slotId: sid(1, 2), type: 'thin', facing: 'E' },
    { slotId: sid(2, 2), type: 'wide', facing: 'N' },
    { slotId: sid(2, 1), type: 'thin', facing: 'E' },
    { slotId: sid(3, 1), type: 'thin', facing: 'E' },
    { slotId: sid(4, 1), type: 'thin', facing: 'S' },
    { slotId: sid(3, 2), type: 'thin', facing: 'S' },
    { slotId: sid(3, 3), type: 'thin', facing: 'E' },
    { slotId: sid(4, 3), type: 'thin', facing: 'N' },
    { slotId: sid(4, 2), type: 'thin', facing: 'E' },
    { slotId: sid(5, 2), type: 'wide', facing: 'E' },
    { slotId: sid(5, 3), type: 'thin', facing: 'S' },
  ],
});

const convergeRows = [
  '        ',
  '        ',
  'L.W..WA ',
  '  . ..  ',
  '  ...B  ',
  '        ',
];

export const convergeSample: LevelDef = defineAsciiLevel({
  id: 'sample-two-routes-one-slot',
  name: '样例 B · 两路合进同槽',
  subtitle: '短路先触发，长路撞上已躺下的片',
  brief: '可重复样例：两条路线汇入同一槽；后到路线不能再次触发。',
  hint: '这是诊断样例，可直接载入固定摆法并导出记录。',
  rows: convergeRows,
  launcherFacing: 'E',
  inventory: { thin: 12, wide: 3 },
  win: { requiredFlags: ['flag-a', 'flag-b'], minIntervalBeats: 3, maxPieces: 20 },
  sampleNote: '短路第 12 拍触发 slot-4-2，该片第 18 拍落地；长路第 24 拍到达，应记录 already-fallen。',
  samplePlacement: [
    { slotId: sid(1, 2), type: 'thin', facing: 'E' },
    { slotId: sid(2, 2), type: 'wide', facing: 'E' },
    // 短路：wide E -> 3,2 -> 4,2
    { slotId: sid(3, 2), type: 'thin', facing: 'E' },
    { slotId: sid(4, 2), type: 'thin', facing: 'E' },
    // 长路：wide S -> 2,3 -> 2,4 -> 3,4 -> 4,4 -> 4,3 -> 4,2
    { slotId: sid(2, 3), type: 'thin', facing: 'S' },
    { slotId: sid(2, 4), type: 'thin', facing: 'E' },
    { slotId: sid(3, 4), type: 'thin', facing: 'E' },
    { slotId: sid(4, 4), type: 'thin', facing: 'N' },
    { slotId: sid(4, 3), type: 'thin', facing: 'N' },
    // 下游双旗
    { slotId: sid(5, 2), type: 'wide', facing: 'E' },
    { slotId: sid(5, 3), type: 'thin', facing: 'S' },
  ],
});

export const MAIN_LEVELS: LevelDef[] = [level1, level2];
export const SAMPLE_LEVELS: LevelDef[] = [sameBeatSample, convergeSample];
export const LEVELS: LevelDef[] = [...MAIN_LEVELS, ...SAMPLE_LEVELS];

export function getLevel(id: string): LevelDef {
  const level = LEVELS.find((l) => l.id === id);
  if (!level) throw new Error(`Unknown level: ${id}`);
  return level;
}
