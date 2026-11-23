import { Mapping, Sample, Zone, uid } from '../model/types';
import { cloneMapping } from './preset';

/** 所有编辑都走不可变更新，配合 React 状态与自动保存 */
export function withMapping(mapping: Mapping, fn: (draft: Mapping) => void): Mapping {
  const next = cloneMapping(mapping);
  fn(next);
  return next;
}

export function addZone(mapping: Mapping): Mapping {
  return withMapping(mapping, (m) => {
    const last = m.zones[m.zones.length - 1];
    const low = last ? Math.min(127, last.high + 1) : 1;
    const high = 127;
    m.zones.push({
      id: uid('z'),
      label: `区域 ${m.zones.length + 1}`,
      low,
      high,
      variants: [],
    });
  });
}

export function removeZone(mapping: Mapping, zoneId: string): Mapping {
  return withMapping(mapping, (m) => {
    m.zones = m.zones.filter((z) => z.id !== zoneId);
  });
}

export function updateZone(mapping: Mapping, zoneId: string, patch: Partial<Zone>): Mapping {
  return withMapping(mapping, (m) => {
    const z = m.zones.find((x) => x.id === zoneId);
    if (z) Object.assign(z, patch);
  });
}

export function addVariant(mapping: Mapping, zoneId: string, sampleId: string): Mapping {
  return withMapping(mapping, (m) => {
    const z = m.zones.find((x) => x.id === zoneId);
    z?.variants.push({ id: uid('v'), sampleId });
  });
}

export function removeVariant(mapping: Mapping, zoneId: string, variantId: string): Mapping {
  return withMapping(mapping, (m) => {
    const z = m.zones.find((x) => x.id === zoneId);
    if (z) z.variants = z.variants.filter((v) => v.id !== variantId);
  });
}

export function addSample(mapping: Mapping, sample: Sample): Mapping {
  return withMapping(mapping, (m) => {
    m.samples.push(sample);
  });
}

export function updateSample(mapping: Mapping, sampleId: string, patch: Partial<Sample>): Mapping {
  return withMapping(mapping, (m) => {
    const s = m.samples.find((x) => x.id === sampleId);
    if (s) Object.assign(s, patch);
  });
}

export function removeSample(mapping: Mapping, sampleId: string): Mapping {
  return withMapping(mapping, (m) => {
    m.samples = m.samples.filter((s) => s.id !== sampleId);
    for (const z of m.zones) z.variants = z.variants.filter((v) => v.sampleId !== sampleId);
  });
}
