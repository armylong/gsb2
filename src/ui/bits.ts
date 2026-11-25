import { PLATE_MAP, PLATES } from '../game/plates';
import type { BandId, PlateId } from '../game/types';
import { h } from './dom';

export const BAND_STYLE: Record<BandId, { color: string; short: string }> = {
  G: { color: PLATE_MAP.cang.color, short: 'G4 低' },
  C: { color: PLATE_MAP.qing.color, short: 'C5 清' },
  Dn: { color: PLATE_MAP.shang.color, short: 'D5 近邻' },
  E: { color: PLATE_MAP.quan.color, short: 'E5 泉' },
  E6: { color: PLATE_MAP.sui.color, short: 'E6 高叠' },
};

export function bandChip(band: BandId): HTMLElement {
  const meta = BAND_STYLE[band];
  return h(
    'span.chip',
    { title: bandLabel(band) },
    h('i.dot', { style: `background:${meta.color}` }),
    meta.short,
  );
}

export function bandLabel(band: BandId): string {
  return PLATES.find((p) => p.band === band)?.bandLabel ?? band;
}

/** 组合卡片 / 答案丸里的三片铃片行。 */
export function comboPlateLines(ids: PlateId[]): HTMLElement {
  return h(
    'div.combo-plates',
    null,
    ids.map((id) => {
      const p = PLATE_MAP[id];
      return h(
        'span.combo-plate-line',
        null,
        h('i.dot', { style: `background:${p.color}` }),
        h('span', { text: p.name }),
      );
    }),
  );
}

export function answerPill(id: PlateId): HTMLElement {
  const p = PLATE_MAP[id];
  return h(
    'span.answer-pill',
    null,
    h('i.dot', { style: `background:${p.color}` }),
    `${p.name} · ${p.pitchLabel.split(' · ')[0]}`,
  );
}

/** 细指纹 -> 公开声学读数（不直接报名字，供玩家与试听栏对照）。 */
export function fineReadout(fineCode: string): string {
  const plate = PLATES.find((p) => p.fineCode === fineCode);
  if (!plate) return fineCode;
  return `${plate.pitchLabel} · 余音 ${plate.decay.toFixed(2)}s · ${plate.decayWord}`;
}
