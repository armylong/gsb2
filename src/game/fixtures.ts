import { sid } from './levels.js';
import type { Placement } from './types.js';

export const level1Solution: Placement[] = [
  { slotId: sid(2, 3), type: 'thin', facing: 'E' },
  { slotId: sid(3, 3), type: 'wide', facing: 'E' },
  { slotId: sid(4, 3), type: 'thin', facing: 'E' },
  { slotId: sid(3, 4), type: 'thin', facing: 'S' },
  { slotId: sid(3, 5), type: 'thin', facing: 'E' },
  { slotId: sid(4, 5), type: 'thin', facing: 'E' },
  { slotId: sid(5, 5), type: 'thin', facing: 'E' },
];

export const level2Solution: Placement[] = [
  { slotId: sid(2, 3), type: 'thin', facing: 'E' },
  { slotId: sid(3, 3), type: 'wide', facing: 'N' },
  { slotId: sid(3, 2), type: 'thin', facing: 'E' },
  { slotId: sid(4, 3), type: 'thin', facing: 'S' },
  { slotId: sid(4, 4), type: 'thin', facing: 'E' },
  { slotId: sid(5, 4), type: 'thin', facing: 'E' },
  { slotId: sid(6, 4), type: 'thin', facing: 'N' },
  { slotId: sid(6, 3), type: 'thin', facing: 'W' },
];

/** 看似全线接通，但 B 旗会比 A 旗早倒。 */
export const level2EarlyFlagTrap: Placement[] = [
  { slotId: sid(2, 3), type: 'thin', facing: 'E' },
  { slotId: sid(3, 3), type: 'wide', facing: 'N' },
  { slotId: sid(3, 2), type: 'thin', facing: 'E' },
  { slotId: sid(4, 3), type: 'thin', facing: 'E' },
];

/** 错误朝向：让细片撞挡柱 / 从错误侧撞单向片。 */
export const level1BlockedOrientation: Placement[] = [
  { slotId: sid(2, 3), type: 'thin', facing: 'N' },
  { slotId: sid(3, 3), type: 'wide', facing: 'E' },
];
