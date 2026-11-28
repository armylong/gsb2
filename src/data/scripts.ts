import { parseScript } from '../core/script-format';
import type { VerificationScript } from '../core/script';
import flowerSource from '../../operations/four-corner-flower.ops.txt?raw';
import heartSource from '../../operations/guarded-heart.ops.txt?raw';

/**
 * 两份可执行、可核对的操作串。文本文件是唯一事实来源：
 * `operations/*.ops.txt` 可以直接阅读、修改，再由应用解析并逐步验证。
 */
export const FLOWER_SCRIPT: VerificationScript = parseScript(flowerSource);
export const HEART_SCRIPT: VerificationScript = parseScript(heartSource);

export const SCRIPTS: VerificationScript[] = [FLOWER_SCRIPT, HEART_SCRIPT];

export function scriptsForLevel(levelId: string): VerificationScript[] {
  return SCRIPTS.filter((s) => s.levelId === levelId);
}

export { flowerSource, heartSource };
