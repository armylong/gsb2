import { describe, expect, it } from 'vitest';
import { Grid } from '../src/core/Grid';
import { labelComponents } from '../src/core/connectivity';

describe('4 邻接连通块标注', () => {
  it('对角接触不算相连：两个对角岩体被标为两个独立块', () => {
    // (0,0) 与 (1,1) 仅对角接触；底行接地
    const grid = Grid.fromRows(['#.', '.#', '##']);
    const labeling = labelComponents(grid);

    expect(labeling.count).toBe(2);
    expect(labeling.compIdAt[0][0]).not.toBe(labeling.compIdAt[1][1]);
    // (0,0) 悬空，不接地；(1,1) 经底行接地
    const floatingId = labeling.compIdAt[0][0];
    const groundedId = labeling.compIdAt[1][1];
    expect(labeling.grounded.has(floatingId)).toBe(false);
    expect(labeling.grounded.has(groundedId)).toBe(true);
    expect(labeling.sizes.get(floatingId)).toBe(1);
    expect(labeling.sizes.get(groundedId)).toBe(3);
  });

  it('补上对角缝中的一格后，两块合并为同一个接地块', () => {
    const grid = Grid.fromRows(['#.', '.#', '##']);
    grid.set(0, 1, 1); // 补上 (0,1)，4 邻接打通
    const labeling = labelComponents(grid);
    expect(labeling.count).toBe(1);
    expect(labeling.grounded.has(1)).toBe(true);
    expect(labeling.sizes.get(1)).toBe(5);
  });

  it('空洞（空格）不会被当作实心区域参与连通', () => {
    const grid = Grid.fromRows(['#.#', '...', '###']);
    const labeling = labelComponents(grid);
    // 顶部两个格互相断开、且与底行断开 -> 各自独立；底行一块
    expect(labeling.count).toBe(3);
    expect(labeling.sizes.get(labeling.compIdAt[0][0])).toBe(1);
    expect(labeling.sizes.get(labeling.compIdAt[0][2])).toBe(1);
    expect(labeling.grounded.has(labeling.compIdAt[2][0])).toBe(true);
  });

  it('细桥未断时桥上方结构保持接地（单格细桥支撑）', () => {
    // 顶部立柱 -> 单行桥 y3 -> 两端支腿 -> 地基 y5
    const grid = Grid.fromRows([
      '..#..',
      '..#..',
      '..#..',
      '#####',
      '#...#',
      '#####',
    ]);
    const labeling = labelComponents(grid);
    expect(labeling.count).toBe(1);
    expect(labeling.grounded.has(1)).toBe(true);
    expect(labeling.sizes.get(1)).toBe(3 + 5 + 2 + 5);
  });
});
