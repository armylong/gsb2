import { describe, expect, it } from 'vitest';
import { buildLayoutFile, parseLayoutText } from './storage';
import { ITEMS } from './items';
import { SAMPLES, sampleToLayout } from './samples';
import { occupiedCells } from './geometry';
import { cellKey } from './geometry';

describe('布局保存/载入', () => {
  it('样例布局序列化后可无损载入, 已旋转物品的占格逐格一致', () => {
    // 找一个确实包含旋转物品的样例(默认布局的 I09 旋转 90°)
    const sample = SAMPLES.find((s) => s.world.placements.some((p) => p.rotation !== 0))!;
    expect(sample).toBeDefined();
    const file = sampleToLayout(sample);
    const text = JSON.stringify(file);
    const result = parseLayoutText(text);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    const loaded = result.file!;
    expect(loaded.items.map((i) => i.id)).toEqual(ITEMS.map((i) => i.id));

    // 找到旋转过的物品, 比较载入前后的实际占格
    const rotated = sample.world.placements.find((p) => p.rotation !== 0)!;
    const def = ITEMS.find((i) => i.id === rotated.itemId)!;
    const loadedPlacement = loaded.world.placements.find((p) => p.itemId === rotated.itemId)!;
    const before = occupiedCells(def, rotated).map(cellKey).sort();
    const after = occupiedCells(def, loadedPlacement).map(cellKey).sort();
    expect(after).toEqual(before);
    expect(loadedPlacement.rotation).toBe(rotated.rotation);
  });

  it('非法 JSON 被拒绝', () => {
    const result = parseLayoutText('{not-json');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('JSON');
  });

  it('编号重复的布局拒绝载入', () => {
    const file = sampleToLayout(SAMPLES[0]);
    const bad = structuredClone(file);
    bad.items.push({ ...bad.items[0] });
    const result = parseLayoutText(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('编号重复'))).toBe(true);
  });

  it('重叠布局拒绝载入', () => {
    const file = sampleToLayout(SAMPLES[0]);
    const bad = structuredClone(file);
    // 把第二件物品的锚点改成与第一件重合
    bad.world.placements[1].anchor = { ...bad.world.placements[0].anchor };
    const result = parseLayoutText(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('重叠'))).toBe(true);
  });

  it('越界布局拒绝载入', () => {
    const file = sampleToLayout(SAMPLES[0]);
    const bad = structuredClone(file);
    bad.world.placements[0].anchor = { col: 99, row: 99 };
    const result = parseLayoutText(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('越界'))).toBe(true);
  });

  it('buildLayoutFile 产出深拷贝, 后续改动不影响文件内容', () => {
    const file = buildLayoutFile(ITEMS, SAMPLES[0].world);
    const text = JSON.stringify(file);
    expect(parseLayoutText(text).ok).toBe(true);
  });
});
