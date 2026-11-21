/** 介质单位与整数计量基础。所有量都存成千分之一单位（mHU / mFU）的整数。 */

export type Medium = 'heat' | 'fog';
export const MEDIA: readonly Medium[] = ['heat', 'fog'];

/** 1 单位 = 1000 内部刻度。 */
export const UNIT_SCALE = 1000;

export const MEDIUM_LABEL: Record<Medium, string> = {
  heat: '热量',
  fog: '雾',
};

export const MEDIUM_UNIT: Record<Medium, string> = {
  heat: 'HU',
  fog: 'FU',
};

export interface Amounts {
  heat: number;
  fog: number;
}

export function zeroAmounts(): Amounts {
  return { heat: 0, fog: 0 };
}

export function amountOf(amounts: Amounts, medium: Medium): number {
  return medium === 'heat' ? amounts.heat : amounts.fog;
}

export function setAmount(amounts: Amounts, medium: Medium, value: number): void {
  if (medium === 'heat') amounts.heat = value;
  else amounts.fog = value;
}

export function addAmount(amounts: Amounts, medium: Medium, delta: number): void {
  setAmount(amounts, medium, amountOf(amounts, medium) + delta);
}
