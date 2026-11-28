import { parseScript } from '../core/script-format';
import type { VerificationScript } from '../core/script';

/**
 * 只用于测试的辅助操作串：验证“墨量刚好”的边界与其他规则组合。
 * 第一条：先用四枚肘三格与十字之外的组合把铁锈耗到只剩 3 格，再验证整次拒绝。
 */
export const ACCESSORY_SCRIPTS: VerificationScript[] = [
  parseScript(`@name 边界 · 铁锈刚好耗尽
@level four-corner-flower
@about 逐步消耗铁锈，检查最后一格与整次拒绝。

stamp hook rust at A1 rot 0 flip 0 cost 4 ink 12 status playing
stamp hook rust at F1 rot 0 flip 1 cost 4 ink 8 status playing
stamp hook rust at A6 rot 2 flip 1 cost 4 ink 4 status playing
stamp hook rust at F6 rot 2 flip 0 cost 4 ink 0 status playing
stamp hook rust at C3 rot 0 flip 0 reject ink
stamp plus indigo at C3 rot 0 flip 0 cost 5 ink 0 status solved
`),
];
