import { describe, expect, it } from 'vitest';
import { Grid } from '../src/core/Grid';
import { World } from '../src/core/World';
import { circleCells, rectCells, clipToBounds } from '../src/core/shapes';

/** 统计当前所有格的归属，断言每格只归属一个对象。 */
function assertUniqueOwnership(world: World): void {
  const seen = new Set<number>();
  let total = 0;
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const owner = world.ownerAt(x, y);
      if (owner.kind === 'empty') continue;
      total++;
      const key = y * world.width + x;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  }
  expect(total).toBe(world.totalCells);
}

describe('细桥支撑与切断', () => {
  function bridgeWorld(): World {
    // 顶部立柱由 1 格细桥 (2,3) 撑住；桥两端经支腿接地
    return new World(
      Grid.fromRows([
        '..#..',
        '..#..',
        '..#..',
        '#####',
        '#...#',
        '#####',
      ]),
    );
  }

  it('未断开的细桥仍能支撑上方：全部静态、接地、无碎片', () => {
    const world = bridgeWorld();
    expect(world.fragments).toHaveLength(0);
    expect(world.labeling.count).toBe(1);
    expect(world.labeling.grounded.has(1)).toBe(true);
    assertUniqueOwnership(world);
  });

  it('挖断桥后失去桥支撑的上方立柱整体转出，桥的两段仍经支腿接地', () => {
    const world = bridgeWorld();
    const before = world.totalCells;
    const result = world.edit([{ x: 2, y: 3 }], 'dig');

    expect(result.removed).toBe(1);
    expect(world.fragments).toHaveLength(1);
    const fragment = world.fragments[0];
    // 桥点挖除后，上方立柱 (2,0..2) 失去唯一支撑 -> 3 格整体转出；
    // 桥行左右两段分别经左右支腿接地，仍是静态格
    expect(fragment.size).toBe(3);
    expect(fragment.cells).toEqual([
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
    // 转出后这些位置不再是静态格
    for (const c of fragment.cells) {
      expect(world.grid.isSolid(c.x, c.y)).toBe(false);
    }
    // 剩余静态：桥两段 4 + 两支腿 2 + 地基 5 = 11 格；
    // 两支腿经完整底行连为同一个接地块
    expect(world.staticCount).toBe(11);
    expect(world.labeling.count).toBe(1);
    for (const id of world.labeling.sizes.keys()) {
      expect(world.labeling.grounded.has(id)).toBe(true);
    }
    expect(world.totalCells).toBe(before - 1);
    expect(world.transitions.filter((t) => t.kind === 'detach')).toHaveLength(1);
    assertUniqueOwnership(world);
  });

  it('挖在无关位置不改变支撑判断', () => {
    const world = bridgeWorld();
    world.edit([{ x: 0, y: 0 }], 'dig'); // 本来就是空
    expect(world.fragments).toHaveLength(0);
    expect(world.labeling.count).toBe(1);
  });
});

describe('对角分离', () => {
  it('挖掉细柱后仅对角接触的岩体转出，对角邻居不受影响', () => {
    // 程序化构造 8x8：
    // 左块 (1..2, 2..3) + 左腿 (1,4..6)，落在底行左段 (0..2)；
    // 右块 (3..4, 0..1)，其左下角 (3,1) 与左块右上角 (2,2) 仅对角；
    // 右腿 (4,2..6) 从右块 (4,1) 向下直连右地基；底行 x=3 断开。
    const grid = new Grid(8, 8);
    for (let x = 0; x <= 2; x++) grid.set(x, 7, 1); // 左地基
    for (let x = 4; x <= 7; x++) grid.set(x, 7, 1); // 右地基（x=3 断开）
    // 左块与左腿
    for (const [x, y] of [
      [1, 2], [2, 2], [1, 3], [2, 3], [1, 4], [1, 5], [1, 6],
    ]) grid.set(x, y, 1);
    // 右块 (3..4,0..1) 与右腿 (4,2..6)
    for (const [x, y] of [
      [3, 0], [4, 0], [3, 1], [4, 1], [4, 2], [4, 3], [4, 4], [4, 5], [4, 6],
    ]) grid.set(x, y, 1);

    const world = new World(grid);
    expect(world.labeling.count).toBe(2);
    expect(world.fragments).toHaveLength(0);

    // 挖掉右腿 (4,2..6)，右块 4 格整体转出
    world.edit(
      [
        { x: 4, y: 2 },
        { x: 4, y: 3 },
        { x: 4, y: 4 },
        { x: 4, y: 5 },
        { x: 4, y: 6 },
      ],
      'dig',
    );
    expect(world.fragments).toHaveLength(1);
    expect(world.fragments[0].size).toBe(4);
    // 左块仍静态接地
    expect(world.ownerAt(1, 2)).toMatchObject({ kind: 'static' });
    expect(world.labeling.grounded.has(world.labeling.compIdAt[2][1])).toBe(true);
    assertUniqueOwnership(world);
  });

  it('对角缝补土可把两个静态块合并', () => {
    // 两个对角格各自独立，均不接地 -> 构造时各自成为碎片
    const world = new World(
      Grid.fromRows([
        '#....',
        '.#...',
        '.....',
        '.....',
        '.....',
        '#####',
      ]),
    );
    expect(world.fragments).toHaveLength(2);
    world.edit([{ x: 0, y: 1 }], 'fill'); // 补土只作用静态格，碎片仍在
    // 碎片落地并入后整体与地基连通
    world.settle();
    expect(world.fragments).toHaveLength(0);
    expect(world.labeling.count).toBe(1);
    expect(world.labeling.grounded.has(1)).toBe(true);
  });
});

describe('同一次切割多块同时转出', () => {
  it('一次矩形挖除切断三根柱子，三个碎片全部识别且互不遗漏', () => {
    const world = new World(
      Grid.fromRows([
        '###.###.###',
        '###.###.###',
        '.#...#...#.',
        '.#...#...#.',
        '.#...#...#.',
        '###########',
      ]),
    );
    expect(world.fragments).toHaveLength(0);

    // 矩形横扫三根柱子的同一行
    const cut = rectCells({ x0: 0, y1: 3, x1: 10, y0: 3 });
    const result = world.edit(cut, 'dig');

    expect(result.removed).toBe(3); // 只挖到三个实心柱格
    expect(world.fragments).toHaveLength(3);
    expect(world.fragments.map((f) => f.size).sort()).toEqual([7, 7, 7]);
    const detaches = world.transitions.filter((t) => t.kind === 'detach');
    expect(detaches).toHaveLength(3);
    // 三个碎片 id 两两不同，格子集合互不相交
    const ids = new Set(world.fragments.map((f) => f.id));
    expect(ids.size).toBe(3);
    const allCells = world.fragments.flatMap((f) => f.cells);
    expect(new Set(allCells.map((c) => c.y * world.width + c.x)).size).toBe(
      allCells.length,
    );
    assertUniqueOwnership(world);
  });
});

describe('碎片竖直下落与并入', () => {
  it('碎片保持原形逐格下落，接触静态格停住并整体并入，不穿透不重叠', () => {
    // 顶块 (1..3, 0..1) 由中柱 (2,2..4) 支撑；右侧有台阶 (4,4)
    const world = new World(
      Grid.fromRows([
        '.###.',
        '.###.',
        '..#..',
        '..#..',
        '..#.#',
        '#####',
      ]),
    );
    world.edit([{ x: 2, y: 3 }], 'dig');
    expect(world.fragments).toHaveLength(1);
    const fragment = world.fragments[0];
    // 顶块 6 格 + 柱子残段 (2,2) 1 格 = 7 格整体转出
    expect(fragment.size).toBe(7);
    const shape = fragment.cells.map((c) => ({ ...c }));

    // 逐格下落：每一步 drop 增加 1，中途不与任何静态格重叠
    let steps = 0;
    while (world.fragments.length > 0) {
      world.step();
      steps++;
      expect(steps).toBeLessThan(50);
      for (const f of world.fragments) {
        for (const c of f.cells) {
          const y = c.y + f.drop;
          if (Number.isInteger(y)) {
            expect(world.grid.isSolid(c.x, y)).toBe(false);
          }
        }
      }
    }

    // 并入后：形状保持（每列的格数与相对顺序不变），全部成为静态格
    expect(world.fragments).toHaveLength(0);
    const merged = world.transitions.filter((t) => t.kind === 'merge');
    expect(merged).toHaveLength(1);
    expect(merged[0].size).toBe(shape.length);
    const columns = new Map<number, number[]>();
    for (const c of shape) {
      const arr = columns.get(c.x) ?? [];
      arr.push(c.y);
      columns.set(c.x, arr);
    }
    for (const [x, origYs] of columns) {
      const landedYs = merged[0].cells.filter((m) => m.x === x).map((m) => m.y);
      expect(landedYs.length).toBe(origYs.length);
      // 整列平移：落地 y 与原始 y 的差值为同一常数，且只向下移动
      const deltas = landedYs.map((ly, i) => ly - origYs[i]!);
      expect(new Set(deltas).size).toBe(1);
      expect(deltas[0]).toBeGreaterThanOrEqual(0);
      for (const ly of landedYs) expect(world.grid.isSolid(x, ly)).toBe(true);
    }
    // 并入后重新标注，全部接地
    expect(world.labeling.grounded.has(1)).toBe(true);
    assertUniqueOwnership(world);
  });

  it('碎片落到地图底界也能停住', () => {
    // 悬空单格，下方全空（底行除外）
    const world = new World(
      Grid.fromRows([
         '.#.',
         '...',
         '...',
         '###',
       ]),
    );
    expect(world.fragments).toHaveLength(1);
    world.settle();
    expect(world.fragments).toHaveLength(0);
    expect(world.grid.isSolid(1, 2)).toBe(true); // 落在底行之上
    assertUniqueOwnership(world);
  });

  it('多个碎片下落时先落地者成为后者的静态支撑，互不占格', () => {
    // 两个高度不同的悬空块同时转出
    const world = new World(
      Grid.fromRows([
         '#.#',
         '#.#',
         '...',
         '.#.',
         '...',
         '###',
       ]),
    );
    // (0,0..1) 与 (2,0..1) 均悬空；(1,3) 悬空
    expect(world.fragments.length).toBeGreaterThanOrEqual(3);
    world.settle();
    expect(world.fragments).toHaveLength(0);
    // 没有任何格被重复写入：静态格总数 == 现存总格
    expect(world.staticCount).toBe(world.totalCells);
    expect(world.labeling.count).toBe(1);
    assertUniqueOwnership(world);
  });
});

describe('格数守恒与编辑规则', () => {
  it('除明确挖除/补入外总格数守恒（完整编辑-下落-并入序列）', () => {
    const world = new World(
      Grid.fromRows([
        '###.###',
        '###.###',
        '.#...#.',
        '.#...#.',
        '.#...#.',
        '#######',
      ]),
    );
    let expected = world.totalCells;

    const track = (removed: number, added: number) => {
      expected = expected - removed + added;
      expect(world.totalCells).toBe(expected);
    };

    let r = world.edit(rectCells({ x0: 0, y0: 3, x1: 6, y1: 3 }), 'dig');
    track(r.removed, r.added);
    world.settle();
    track(0, 0); // 纯下落并入不改变总格数

    r = world.edit(circleCells({ cx: 1.5, cy: 4.5, radius: 1 }), 'dig');
    track(r.removed, r.added);
    world.settle();
    track(0, 0);

    const fill = world.edit(rectCells({ x0: 3, y0: 2, x1: 3, y1: 4 }), 'fill');
    expect(fill.added).toBeGreaterThan(0);
    track(0, fill.added);
    expect(world.totalCells).toBe(expected);
  });

  it('超出地图的操作只作用于有效部分', () => {
    const world = new World(Grid.fromRows(['###', '###', '###']));
    const raw = rectCells({ x0: -2, y0: -2, x1: 1, y1: 1 });
    const clipped = clipToBounds(raw, world.width, world.height);
    expect(clipped).toHaveLength(4); // 只有 (0,0)(0,1)(1,0)(1,1)
    const result = world.edit(raw, 'dig');
    expect(result.removed).toBe(4);
    expect(result.affected).toHaveLength(4);
    expect(world.staticCount).toBe(5);
  });

  it('挖除只影响实心格、补土只影响空格（空洞不被当作实心）', () => {
    // 两个对角格：(1,1) 经底行接地保持静态，(0,0) 悬空成为碎片
    const world = new World(Grid.fromRows(['#.', '.#', '##']));
    expect(world.fragments.length).toBe(1);
    expect(world.fragments[0].cells).toEqual([{ x: 0, y: 0 }]);
    world.settle();
    // 落到底界后重新成为静态
    const digEmpty = world.edit([{ x: 0, y: 0 }], 'dig');
    expect(digEmpty.removed).toBe(0); // 空格挖除无效果
    const fillSolid = world.edit([{ x: 0, y: world.height - 1 }], 'fill');
    expect(fillSolid.added).toBe(0); // 实心格补土无效果
    const fillEmpty = world.edit([{ x: 0, y: 0 }], 'fill');
    expect(fillEmpty.added).toBe(1);
  });

  it('编辑不作用于下落中的碎片格', () => {
    const world = new World(
      Grid.fromRows([
        '.#.',
        '...',
        '...',
        '###',
      ]),
    );
    expect(world.fragments).toHaveLength(1);
    const f = world.fragments[0];
    const target = { x: f.cells[0].x, y: f.cells[0].y };
    const result = world.edit([target], 'dig');
    expect(result.removed).toBe(0);
    expect(world.fragments).toHaveLength(1);
    const fill = world.edit([target], 'fill');
    expect(fill.added).toBe(0);
  });
});

describe('暂停编辑与继续运行', () => {
  it('暂停后修改地形立即重判连通性，继续运行不残留旧支撑判断', () => {
    const world = new World(
      Grid.fromRows([
        '###',
        '.#.',
        '.#.',
        '###',
      ]),
    );
    expect(world.fragments).toHaveLength(0);

    // “暂停状态”下编辑（不调用 step）：立即转出
    world.edit([{ x: 1, y: 2 }], 'dig');
    expect(world.fragments).toHaveLength(1);
    const fragmentId = world.fragments[0].id;

    // 再挖一格也不会复用旧标注：碎片仍是同一块，静态结构保持接地
    world.edit([{ x: 0, y: 0 }], 'dig');
    expect(world.fragments.map((f) => f.id)).toContain(fragmentId);
    expect(world.labeling.grounded.has(world.labeling.compIdAt[3][0])).toBe(true);

    // “继续运行”：基于当前网格下落并入，无报错、无残留
    const steps = world.settle();
    expect(steps).toBeGreaterThan(0);
    expect(world.fragments).toHaveLength(0);
    expect(world.staticCount).toBe(world.totalCells);
  });
});
