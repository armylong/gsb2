import { LevelDef } from './engine';

// 所有题面均由 scripts/validate.ts 调用同一套 solver 验证可解，
// 不存在手写内置解法；提示永远从当前局面实时搜索。

export const LEVELS: LevelDef[] = [
  {
    id: 'first-stamp',
    name: '第一印',
    subtitle: '滚动 · 辨色 · 盖印',
    brief:
      '方向键 / WASD 让方块朝该方向绕接触边滚 90°，认清贴地的是哪一面，再按空格盖印。虚线素格「可经过、不可留色」。',
    rows: [
      '########',
      '#@1....#',
      '#......#',
      '#..~~..#',
      '#...2..#',
      '########',
    ],
    slots: {
      '1': { need: 'Y', note: '起手向右一滚，黄面贴地' },
      '2': { need: 'R' },
    },
    startOri: 'RPGOYB', // 顶赤 贴地紫 北绿 南橙 东黄 西蓝
    stampedBlocks: true,
  },
  {
    id: 'bridge-seal',
    name: '断桥·封口',
    subtitle: '盖过的格不能再进入',
    brief:
      '盖下的印会干透，之后不能再次进入该格。中央断桥印一旦盖下就只能单向离开——先把左右两室的普通印安排好。菱形「封」格必须等普通目标全部盖对后才能落印，并且要留在最后。',
    rows: [
      '###########',
      '#1...#....#',
      '#..~.#....#',
      '#@...5..3.#',
      '#....#.~..#',
      '#4...#..6.#',
      '###########',
    ],
    slots: {
      '1': { need: 'R' },
      '4': { need: 'R' },
      '5': { need: 'P', note: '断桥格：盖印后不可再回头' },
      '3': { need: 'B' },
      '6': { need: 'Y', seal: true, note: '封口格，最后盖' },
    },
    startOri: 'RPGOYB',
    stampedBlocks: true,
  },
  {
    id: 'two-fates',
    name: '一转之差',
    subtitle: '起点方向不同，结局不同',
    brief:
      '同一张纸面、同样的四枚色印，只切换两种起手朝向（彼此仅差一个俯视 90° 转向）。两条路线都成立，但会迫使你用不同顺序处理两枚封口印，最后停在不同的封口格上。用「提示」从当前姿态逐格验证。',
    rows: [
      '######',
      '#1..3#',
      '#.@..#',
      '#2..4#',
      '######',
    ],
    slots: {
      '1': { need: 'B' },
      '2': { need: 'Y' },
      '3': { need: 'G', seal: true, note: '右上封口' },
      '4': { need: 'O', seal: true, note: '右下封口' },
    },
    startOri: 'RPGOYB',
    stampedBlocks: true,
    fork: true,
    forkNote:
      '甲：赤顶紫底、北绿东黄；乙：同一方块水平右转 90°（赤顶紫底不变，四侧色签换位）。求解器对两种起手给出的可行路线与最后封口格不同。',
    variants: [
      {
        id: 'pose-a',
        label: '朝向甲 · 北绿 / 东黄',
        ori: 'RPGOYB',
        note: '初始：顶赤、底紫、北绿、南橙、东黄、西蓝。',
      },
      {
        id: 'pose-b',
        label: '朝向乙 · 整体右转 90°',
        ori: 'RPBYGO',
        note: '由甲俯视顺时针转一格：顶赤、底紫不变，北蓝、南黄、东绿、西橙。',
      },
    ],
  },
];

export const DEFAULT_LEVEL_ID = LEVELS[0].id;

export function getLevel(id: string | null | undefined): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}
