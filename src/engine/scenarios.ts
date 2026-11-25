import { colorName } from './colors.js';
import { PRIMARY } from './types.js';
import { Board, TurnReport } from './types.js';

export interface Scenario {
  id: string;
  name: string;
  brief: string;
  task: string;
  board: Board;
  /** 给玩家参考的预期轮数 */
  expectedRounds: number;
  check: (reports: TurnReport[]) => { complete: boolean; message: string };
}

const ORANGE = PRIMARY.R | PRIMARY.Y;

/** 某朵花在第几轮首次稳定为某颜色，找不到返回 null */
function firstStableRound(reports: TurnReport[], flowerId: string, color: number): number | null {
  for (const report of reports) {
    const detail = report.details.find((d) => d.flowerId === flowerId);
    if (detail?.stabilized && detail.afterColor === color) return report.round;
  }
  return null;
}

/**
 * 关卡 1：中间先变色，再帮边缘变色
 * 6×5 地图。fR 的红花花粉被挡在 p1 后面；移开挡板后中间花 fM 先变红，
 * 之后 fM 才作为新来源沿对角风把红花粉送到边缘花 fE。
 */
const level1Board: Board = {
  width: 6,
  height: 5,
  flowers: [
    { id: 'fR', x: 1, y: 1, color: PRIMARY.R, pendingColor: 0, progress: 0 },
    { id: 'fM', x: 3, y: 1, color: 0, pendingColor: 0, progress: 0 },
    { id: 'fE', x: 4, y: 2, color: 0, pendingColor: 0, progress: 0 },
  ],
  winds: [
    { id: 'w1', from: { x: 1, y: 1 }, dir: 'E', kind: 'gale' },
    { id: 'w2', from: { x: 3, y: 1 }, dir: 'SE', kind: 'breeze' },
    { id: 'w3', from: { x: 3, y: 1 }, dir: 'E', kind: 'breeze' },
  ],
  panels: [{ id: 'p1', x: 2, y: 1 }],
};

/**
 * 关卡 2：两种花粉同时到达
 * 两条疾风（各飞 2 格）在同一轮抵达 fT：红 + 黄 按位并为橙，
 * 与遍历顺序无关。中间格 (3,1)/(3,3) 可以放挡板拦截其中一路。
 */
const level2Board: Board = {
  width: 6,
  height: 5,
  flowers: [
    { id: 'fR', x: 2, y: 0, color: PRIMARY.R, pendingColor: 0, progress: 0 },
    { id: 'fY', x: 2, y: 4, color: PRIMARY.Y, pendingColor: 0, progress: 0 },
    { id: 'fT', x: 4, y: 2, color: 0, pendingColor: 0, progress: 0 },
  ],
  winds: [
    { id: 'wR', from: { x: 2, y: 0 }, dir: 'SE', kind: 'gale' },
    { id: 'wY', from: { x: 2, y: 4 }, dir: 'NE', kind: 'gale' },
  ],
  panels: [{ id: 'p1', x: 0, y: 0 }],
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'level1',
    name: '关卡 1：中间先变色，再帮边缘变色',
    brief: '红花的花粉被挡风板挡住。先让中间的白花稳定变红，它才能继续把红花粉传给边缘的白花。',
    task: '移动挡风板后等待若干轮，使中间花 fM 先变红，之后边缘花 fE 再变红（各需连续 3 轮同色）。',
    board: structuredClone(level1Board),
    expectedRounds: 6,
    check(reports) {
      const midRound = firstStableRound(reports, 'fM', PRIMARY.R);
      const edgeRound = firstStableRound(reports, 'fE', PRIMARY.R);
      if (midRound === null)
        return { complete: false, message: '中间花 fM 还未稳定为红色。' };
      if (edgeRound === null)
        return { complete: false, message: '中间花已变红，但边缘花 fE 还未稳定为红色。' };
      if (midRound >= edgeRound)
        return {
          complete: false,
          message: `顺序不对：fM 在第 ${midRound} 轮变红，fE 在第 ${edgeRound} 轮变红，需要中间花先变色。`,
        };
      return {
        complete: true,
        message: `完成：fM 第 ${midRound} 轮先变红，fE 第 ${edgeRound} 轮随后变红。`,
      };
    },
  },
  {
    id: 'level2',
    name: '关卡 2：两种花粉同时到达',
    brief: '红、黄两朵花的疾风在同一轮吹到 fT，混合成橙色。试着把挡板移到任意一条路径的中间格，观察来源减少后的变化。',
    task: '保持两条路径畅通，等待 fT 连续 3 轮收到混合花粉，稳定为橙色。',
    board: structuredClone(level2Board),
    expectedRounds: 3,
    check(reports) {
      const round = firstStableRound(reports, 'fT', ORANGE);
      if (round === null) {
        const last = reports[reports.length - 1];
        const detail = last?.details.find((d) => d.flowerId === 'fT');
        const incoming = detail ? colorName(detail.incomingColor) : '无';
        return { complete: false, message: `fT 尚未稳定为橙色（本轮收到：${incoming}）。` };
      }
      return { complete: true, message: `完成：fT 在第 ${round} 轮稳定为橙色（红 + 黄）。` };
    },
  },
];
