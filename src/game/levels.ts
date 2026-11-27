import type { LevelSpec } from './types';

// 熟度统一用 0–12 整数刻度；温箱每拍 +档位值，凉架每拍 +1（更慢），炉内冻结。
// 每关都在文档（docs/LEVELS.md）里附带可逐步核对的通关顺序与反例。

export const LEVEL_1: LevelSpec = {
  id: 'L1',
  title: '第一关 · 熟悉温箱',
  brief:
    '三团面起点不同、合格窗口不同。温箱有两个槽位和 0/1/2 三档火力，凉架每拍只涨 1 刻度。' +
    '先规划哪团进箱、用哪档，再逐拍提交。',
  proofSlots: 2,
  ovenBakeTurns: 2,
  rackRate: 1,
  gearRates: { 0: 0, 1: 1, 2: 2 },
  maxDoneness: 12,
  doughs: [
    { id: 'A', name: 'A 团', startDoneness: 2, window: [5, 6], deadline: 9, startZone: 'bench' },
    { id: 'B', name: 'B 团', startDoneness: 1, window: [7, 9], deadline: 10, startZone: 'bench' },
    { id: 'C', name: 'C 团', startDoneness: 3, window: [6, 7], deadline: 8, startZone: 'bench' },
  ],
};

export const LEVEL_2: LevelSpec = {
  id: 'L2',
  title: '第二关 · 烤炉撞单',
  brief:
    '烤炉一次只烤一团，每团占炉 2 拍。三张订单的截止回合互相咬住：' +
    '谁先入炉、谁在温箱等档，顺序错一拍就会有人超时或夹生。',
  proofSlots: 2,
  ovenBakeTurns: 2,
  rackRate: 1,
  gearRates: { 0: 0, 1: 1, 2: 2 },
  maxDoneness: 12,
  doughs: [
    { id: 'A', name: 'A 团', startDoneness: 1, window: [4, 5], deadline: 6, startZone: 'bench' },
    { id: 'B', name: 'B 团', startDoneness: 4, window: [7, 9], deadline: 9, startZone: 'bench' },
    { id: 'C', name: 'C 团', startDoneness: 2, window: [6, 8], deadline: 10, startZone: 'bench' },
  ],
};

export const LEVELS: LevelSpec[] = [LEVEL_1, LEVEL_2];
