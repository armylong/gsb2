import type { ColorId, InkDef } from './types';

/** 两色叠印时的键：当前颜色|本次墨色。 */
export function mixKey(below: ColorId, above: ColorId): string {
  return `${below}|${above}`;
}

/**
 * 生成一组完整的叠色表，保证纸白、同色重复与任意两墨的先后顺序都有定义。
 */
export function buildMix(
  paper: ColorId,
  inks: InkDef[],
  pairs: { below: string; above: string; result: ColorId }[],
): Record<string, ColorId> {
  const mix: Record<string, ColorId> = {};
  for (const ink of inks) {
    mix[mixKey(paper, ink.color)] = ink.color;
    mix[mixKey(ink.color, ink.color)] = ink.color;
  }
  for (const pair of pairs) {
    mix[mixKey(pair.below, pair.above)] = pair.result;
  }
  return mix;
}
