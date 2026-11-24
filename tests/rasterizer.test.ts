import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectSharedEdges,
  rasterize,
  sameCoverage,
  SAMPLE_PATTERNS,
  type RasterInput,
  type Triangle,
  type Vec2,
} from "../src/rasterizer.js";

/** 两个共享斜边的三角形，斜边 y = -x + 14（穿过像素中心） */
function sharedEdgeScene(): RasterInput {
  const verts: Vec2[] = [
    { x: 6, y: 12 }, // 0 A
    { x: 12, y: 6 }, // 1 B
    { x: 6, y: 6 }, // 2 C
    { x: 12, y: 12 }, // 3 D
  ];
  const triangles: Triangle[] = [
    { id: "T1", label: "red", v: [0, 1, 2], color: { r: 1, g: 0, b: 0 } },
    { id: "T2", label: "blue", v: [0, 3, 1], color: { r: 0, g: 0, b: 1 } },
  ];
  return {
    gridW: 18,
    gridH: 18,
    verts,
    triangles,
    pattern: SAMPLE_PATTERNS["1"],
    rule: "topleft",
  };
}

test("左上规则：公共边上的采样点恰好归属一个三角形，无冲突无缺口", () => {
  const res = rasterize(sharedEdgeScene());
  assert.equal(res.stats.conflictPixels, 0, "不能有重复占用的采样点");
  assert.equal(res.stats.gapPixels, 0, "公共边上不能有漏掉的采样点");

  // 像素 (7,7) 的中心 (7.5,7.5) 正好在公共边上，必须被且仅被一个三角形覆盖
  const p77 = res.pixels.find((p) => p.px === 7 && p.py === 7)!;
  assert.equal(p77.samples[0].owners.length, 1);
  // 该边在 T1 的 B->C... 实际归属由边方向决定，但必须与交换次序后的结果一致
  const ownerOnEdge = p77.samples[0].owners[0];
  assert.ok(ownerOnEdge === "T1" || ownerOnEdge === "T2");
});

test("交换绘制次序不改变任何采样点的归属", () => {
  const input = sharedEdgeScene();
  const before = rasterize(input);
  const swapped = rasterize({
    ...input,
    triangles: [input.triangles[1], input.triangles[0]],
  });
  assert.ok(sameCoverage(before, swapped));
});

test("翻转顶点顺序（绕序）不改变覆盖", () => {
  const input = sharedEdgeScene();
  const before = rasterize(input);
  const flipped: Triangle[] = input.triangles.map((t) => ({
    ...t,
    v: [t.v[0], t.v[2], t.v[1]] as [number, number, number],
  }));
  const after = rasterize({ ...input, triangles: flipped });
  assert.ok(sameCoverage(before, after));
});

test("退化为线段的三角形不点亮任何像素", () => {
  const input = sharedEdgeScene();
  const degenerate: Triangle = {
    id: "T3",
    label: "line",
    v: [0, 1, 1], // 两个顶点重合 -> 面积为 0
    color: { r: 0, g: 1, b: 0 },
  };
  const base = rasterize(input);
  const withLine = rasterize({
    ...input,
    triangles: [...input.triangles, degenerate],
  });
  assert.deepEqual(withLine.stats.degenerate, ["T3"]);
  assert.ok(sameCoverage(base, withLine), "退化三角形必须贡献零覆盖");
  assert.equal(withLine.stats.perTriangleSamples["T3"] ?? 0, 0);
});

test("严格 e>0 规则在公共边上制造缺口", () => {
  const res = rasterize({ ...sharedEdgeScene(), rule: "strict" });
  assert.ok(res.stats.gapPixels > 0, "严格规则应当出现公共边漏采样");
});

test("全 e>=0 规则在公共边上制造重复占用（亮一道）", () => {
  const res = rasterize({ ...sharedEdgeScene(), rule: "inclusive" });
  assert.ok(res.stats.conflictPixels > 0, "全包含规则应当出现冲突采样点");
});

test("半像素平移：覆盖随相位变化但始终无冲突无缺口", () => {
  // 两个三角形拼成的四边形，共享对角线反向遍历（标准条带绕序 [0,1,2]+[2,3,0]）。
  // 非整数宽高 + 分数起点，0.125px 步进即可让边扫过像素中心；
  // 起点再偏 0.0625px，避开对角线恰好穿过采样中心的浮点共线情形。
  const rectVerts: Vec2[] = [
    { x: 4.5625, y: 4.5625 },
    { x: 12.25, y: 4.5625 },
    { x: 12.25, y: 9.25 },
    { x: 4.5625, y: 9.25 },
  ];
  const rectTris: Triangle[] = [
    { id: "R1", label: "a", v: [0, 1, 2], color: { r: 1, g: 0, b: 0 } },
    { id: "R2", label: "b", v: [2, 3, 0], color: { r: 0, g: 0, b: 1 } },
  ];
  const seen = new Set<number>();
  for (let k = 0; k < 8; k++) {
    const dy = k * 0.125;
    const shifted: Vec2[] = rectVerts.map((v) => ({ x: v.x, y: v.y + dy }));
    const res = rasterize({
      gridW: 18,
      gridH: 18,
      verts: shifted,
      triangles: rectTris,
      pattern: SAMPLE_PATTERNS["1"],
      rule: "topleft",
    });
    assert.equal(res.stats.conflictPixels, 0, `offset=${dy} 不应冲突`);
    assert.equal(res.stats.gapPixels, 0, `offset=${dy} 不应有缺口`);
    seen.add(res.stats.coveredPixels);
  }
  // 不同相位下覆盖像素数应当发生变化（这正是半像素问题的来源）
  assert.ok(seen.size > 1, "半像素平移应导致覆盖统计变化");
});

test("多点采样：覆盖率等于命中采样数比例，且公共边仍唯一归属", () => {
  const res = rasterize({
    ...sharedEdgeScene(),
    pattern: SAMPLE_PATTERNS["4"],
  });
  for (const p of res.pixels) {
    const hit = p.samples.filter((s) => s.owners.length > 0).length;
    assert.ok(Math.abs(p.coverage - hit / 4) < 1e-9);
    for (const s of p.samples) assert.ok(s.owners.length <= 1);
  }
  assert.equal(res.stats.conflictPixels, 0);
  assert.equal(res.stats.gapPixels, 0);
});

test("细三角形：宽 0.4px 时只在部分相位点亮，且单点模式覆盖率只取 0 或 1", () => {
  const verts: Vec2[] = [
    { x: 3, y: 3 },
    { x: 3.4, y: 3.05 },
    { x: 4, y: 9 },
  ];
  const triangles: Triangle[] = [
    { id: "thin", label: "t", v: [0, 1, 2], color: { r: 0, g: 1, b: 0 } },
  ];
  const lit = new Set<number>();
  for (let k = 0; k < 8; k++) {
    const shifted = verts.map((v) => ({ x: v.x + k * 0.125, y: v.y }));
    const res = rasterize({
      gridW: 18,
      gridH: 18,
      verts: shifted,
      triangles,
      pattern: SAMPLE_PATTERNS["1"],
      rule: "topleft",
    });
    for (const p of res.pixels) assert.ok(p.coverage === 0 || p.coverage === 1);
    lit.add(res.stats.coveredPixels);
  }
  assert.ok(lit.size > 1, "亚像素宽度的三角形对平移相位应当敏感");
});

test("collectSharedEdges 能识别共享边", () => {
  const input = sharedEdgeScene();
  const edges = collectSharedEdges(input.verts, input.triangles);
  assert.equal(edges.length, 1);
});
