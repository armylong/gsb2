/**
 * HLR 引擎的 Node 测试（node --experimental-strip-types --test）。
 * 覆盖：焊接/折边提取、三视图取景、中部遮挡产生"实-虚-实"、视野框裁剪、
 * 同深稳定规则、输入顺序无关的确定性、开孔轮廓保留、SVG 往返一致性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '../src/hlr/math3d.ts';
import { v3, identityMat4 } from '../src/hlr/math3d.ts';
import type { RawPart } from '../src/hlr/geometry.ts';
import { buildWorld } from '../src/hlr/geometry.ts';
import type { ViewDescriptor } from '../src/hlr/view.ts';
import { standardViews } from '../src/hlr/view.ts';
import type { LineSegment } from '../src/hlr/hlr.ts';
import { runHLR } from '../src/hlr/hlr.ts';
import { serializeSvg, parseDrawingMeta, defaultSvgOptions } from '../src/hlr/svg.ts';

/** 六面体三角汤（12 三角形，36 顶点），尺寸 sx*sy*sz，中心在 origin。 */
function boxTriangles(sx: number, sy: number, sz: number): Vec3[] {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const c = [
    v3(-hx, -hy, -hz), v3(hx, -hy, -hz), v3(hx, hy, -hz), v3(-hx, hy, -hz),
    v3(-hx, -hy, hz), v3(hx, -hy, hz), v3(hx, hy, hz), v3(-hx, hy, hz)
  ];
  const faces: Array<[number, number, number, number]> = [
    [0, 1, 2, 3], // z-
    [5, 4, 7, 6], // z+
    [4, 0, 3, 7], // x-
    [1, 5, 6, 2], // x+
    [4, 5, 1, 0], // y-
    [3, 2, 6, 7]  // y+
  ];
  const out: Vec3[] = [];
  for (const [a, b, cc, d] of faces) {
    out.push(c[a], c[b], c[cc], c[a], c[cc], c[d]);
  }
  return out;
}

/** 共面剖分的四边形：四个三角拼一个矩形，含一条对角线（二面角 0，应被过滤）。 */
function coplanarSplitQuad(): Vec3[] {
  const p0 = v3(-1, -1, 0);
  const p1 = v3(1, -1, 0);
  const p2 = v3(1, 1, 0);
  const p3 = v3(-1, 1, 0);
  const pm = v3(0, 0, 0);
  return [p0, p1, pm, p1, p2, pm, p2, p3, pm, p3, p0, pm];
}

function part(id: string, positions: Vec3[], matrix = identityMat4()): RawPart {
  return { id, label: id, color: 0x333333, matrix, positions };
}

function frontView(): ViewDescriptor {
  return {
    name: 'front',
    eye: v3(0, 0, -20),
    target: v3(0, 0, 0),
    up: v3(0, 1, 0),
    halfHeight: 3,
    aspect: 1
  };
}

function segSummary(segs: LineSegment[]): string[] {
  return segs.map((s) => `${s.edgeId}:${s.kind}[${s.t0.toFixed(3)},${s.t1.toFixed(3)}]`).sort();
}

test('顶点焊接 + 折边提取：盒子 12 条边，共面对角线被过滤', () => {
  const mesh = buildWorld([part('box', boxTriangles(2, 2, 2))], 1);
  assert.equal(mesh.edges.length, 12, '立方体恰好 12 条折边');
  assert.equal(mesh.vertices.length, 8, '36 个三角汤顶点应焊接为 8 个');

  const meshFlat = buildWorld([part('q', coplanarSplitQuad())], 1);
  assert.equal(meshFlat.edges.length, 4, '共面剖分只留矩形 4 条边界，对角线被隐藏');

  // 阈值=0 时对角线仍被过滤（二面角恰好 0，规则是 dihedral < threshold 才剔除）
  const meshZero = buildWorld([part('q', coplanarSplitQuad())], 0);
  assert.equal(meshZero.edges.length, 4);
});

test('正视单个盒子：12 边全部出图，前面轮廓为实线、背面边为虚线', () => {
  const mesh = buildWorld([part('box', boxTriangles(2, 2, 2))], 1);
  const result = runHLR(mesh, frontView(), 1);
  assert.equal(result.edgeRecords.length, 12);
  const visible = result.segments.filter((s) => s.kind === 'visible');
  const hidden = result.segments.filter((s) => s.kind === 'hidden');
  assert.equal(visible.length, 4, '正视看到前面 4 条轮廓实线');
  assert.equal(hidden.length, 8, '背面 8 条边（含深度方向 4 棱）应为虚线');
  // 实线全部属于 z=-1 的前面
  for (const s of visible) {
    const rec = result.edgeRecords.find((r) => r.edge.id === s.edgeId)!;
    assert.ok(Math.abs(rec.worldA.z + 1) < 1e-9 && Math.abs(rec.worldB.z + 1) < 1e-9);
  }
  // 视野框内的所有段都在 NDC 范围内
  for (const s of result.segments) {
    for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y1]]) {
      assert.ok(x >= -1 - 1e-9 && x <= 1 + 1e-9 && y >= -1 - 1e-9 && y <= 1 + 1e-9);
    }
  }
});

test('前景窄块只挡住长边中部：同一条边输出 实-虚-实 三段', () => {
  // 后板：宽 6、高 2、薄；前景块：宽 2、高 1，位于相机与板之间
  const plate = part('plate', boxTriangles(6, 2, 0.2));
  const blocker = part('blocker', boxTriangles(2, 1, 0.2), (() => {
    const m = identityMat4();
    m[14] = -1.5; // 沿 -Z 前移（相机在 -Z 侧）
    m[13] = 0.5;  // 略向上，使其覆盖板的顶部长边中间段
    return m;
  })());
  const mesh = buildWorld([plate, blocker], 1);
  const result = runHLR(mesh, frontView(), 1);

  // 找到被 blocker 遮挡且属于 plate 的隐藏段
  const hiddenMid = result.segments.find(
    (s) => s.kind === 'hidden' && s.partId === 'plate' && s.occluderPartIds.includes('blocker')
  );
  assert.ok(hiddenMid, '应有板边被前景块挡住的隐藏段');
  assert.ok(hiddenMid!.t0 > 0.05 && hiddenMid!.t1 < 0.95, '遮挡发生在边的中部而非端点');

  // 同一条物理边必须同时存在可见段（两头）
  const sameEdge = result.segments.filter((s) => s.edgeId === hiddenMid!.edgeId);
  const visEnds = sameEdge.filter((s) => s.kind === 'visible');
  assert.ok(visEnds.length >= 2, '被挡边的两头仍为实线');
  const ts = visEnds.map((s) => [s.t0, s.t1]).flat();
  assert.ok(Math.min(...ts) < 0.02, '第一段从头开始');
  assert.ok(Math.max(...ts) > 0.98, '最后一段到尾结束');
});

test('视野框裁剪：偏心取景框切过部分边，框外段不出图、交点落在框边界', () => {
  const mesh = buildWorld([part('box', boxTriangles(2, 2, 2))], 1);
  // 取景中心移到盒子左下角 (x=-0.75, y=-0.75)，半高 0.8：
  // 框覆盖世界 x∈[-1.55,0.05]、y∈[-1.55,0.05]，会截断右侧与上侧的边。
  const tight: ViewDescriptor = {
    ...frontView(),
    target: v3(-0.75, -0.75, 0),
    halfHeight: 0.8
  };
  const result = runHLR(mesh, tight, 1);
  assert.ok(result.segments.length > 0, '应有边与取景框相交');
  for (const s of result.segments) {
    assert.ok(Math.abs(s.x0) <= 1 + 1e-7 && Math.abs(s.x1) <= 1 + 1e-7);
    assert.ok(Math.abs(s.y0) <= 1 + 1e-7 && Math.abs(s.y1) <= 1 + 1e-7);
  }
  // 至少有一段是被框裁断的（端点贴在 ±1 边界）
  const clipped = result.segments.some(
    (s) =>
      [s.x0, s.x1, s.y0, s.y1].some((val) => Math.abs(Math.abs(val) - 1) < 1e-6)
  );
  assert.ok(clipped, '应存在被视野框裁断的段');
  // 完全在框外的边不产生任何段
  const allInside = result.segments.every(
    (s) => Math.max(Math.abs(s.x0), Math.abs(s.x1), Math.abs(s.y0), Math.abs(s.y1)) <= 1 + 1e-6
  );
  assert.ok(allInside);
});

test('确定性：打乱三角面与零件输入顺序，几何分段结果完全一致', () => {
  const plate = part('plate', boxTriangles(6, 2, 0.2));
  const blocker = part('blocker', boxTriangles(2, 1, 0.2), (() => {
    const m = identityMat4();
    m[14] = -1.5;
    m[13] = 0.5;
    return m;
  })());

  const mesh1 = buildWorld([plate, blocker], 1);
  const r1 = runHLR(mesh1, frontView(), 1);

  // 打乱每个零件的三角形顺序并交换零件次序
  const shuffled = (ps: Vec3[]): Vec3[] => {
    const tris: Vec3[][] = [];
    for (let i = 0; i < ps.length; i += 3) tris.push(ps.slice(i, i + 3));
    for (let i = tris.length - 1; i > 0; i--) {
      const j = Math.floor((Math.sin(i * 999) + 1) * 0.5 * (i + 1)) % (i + 1);
      [tris[i], tris[j]] = [tris[j], tris[i]];
    }
    return tris.flat();
  };
  const plate2 = part('plate', shuffled(plate.positions));
  const blocker2 = part('blocker', shuffled(blocker.positions), blocker.matrix);
  const mesh2 = buildWorld([blocker2, plate2], 1);
  const r2 = runHLR(mesh2, frontView(), 1);

  // 用世界坐标端点 + 虚实 + 参数区间做归一化比较，
  // 与零件次序、顶点基址、内部 id 编号都无关。
  const geoKey = (r: typeof r1): string[] =>
    r.segments
      .map((s) => {
        const rec = r.edgeRecords.find((e) => e.edge.id === s.edgeId)!;
        const pts = [rec.worldA, rec.worldB]
          .map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`)
          .sort()
          .join('|');
        return `${pts}#${s.kind}#${s.t0.toFixed(6)}#${s.t1.toFixed(6)}`;
      })
      .sort();
  assert.deepEqual(geoKey(r1), geoKey(r2));

  // 同一输入重复计算两次也必须逐字节一致（遍历顺序稳定）
  const r1b = runHLR(buildWorld([plate, blocker], 1), frontView(), 1);
  assert.deepEqual(segSummary(r1.segments), segSummary(r1b.segments));
});

test('同深稳定规则：边恰好躺在遮挡面平面上时判可见（tie 归边）', () => {
  // 板的前表面 z=-0.1；在该平面上放一条共面边，深度差为 0
  const mesh = buildWorld([part('plate', boxTriangles(4, 4, 0.2))], 1);
  const view: ViewDescriptor = { ...frontView(), halfHeight: 3 };
  const result = runHLR(mesh, view, 1);
  // 前表面四条轮廓边全部可见（没有因共面被误判成隐藏）
  const frontFaceEdges = result.edgeRecords.filter((r) => {
    const zA = r.worldA.z, zB = r.worldB.z;
    return Math.abs(zA + 0.1) < 1e-9 && Math.abs(zB + 0.1) < 1e-9;
  });
  assert.ok(frontFaceEdges.length >= 4);
  for (const rec of frontFaceEdges) {
    const segs = result.segments.filter((s) => s.edgeId === rec.edge.id);
    assert.ok(segs.every((s) => s.kind === 'visible'), `共面边 ${rec.edge.id} 不应被自身面遮挡`);
  }
});

test('三视图都能出图且变换反映到投影：旋转盒子后正视宽度变化', () => {
  const mesh = buildWorld([part('box', boxTriangles(2, 2, 2))], 1);
  const views = standardViews(mesh, 1);
  assert.deepEqual(views.map((v) => v.name), ['front', 'top', 'iso']);
  for (const v of views) {
    const r = runHLR(mesh, v, 1);
    assert.ok(r.segments.length >= 12, `${v.name} 视图应出图`);
  }

  // 绕 Y 旋转 90° 的盒子（几何对称看不出差异，改用平移验证变换生效）
  const moved = identityMat4();
  moved[12] = 5; // x+5
  const meshMoved = buildWorld([part('box', boxTriangles(2, 2, 2), moved)], 1);
  const rMoved = runHLR(meshMoved, frontView(), 1);
  const xs = rMoved.segments.flatMap((s) => [s.x0, s.x1]);
  assert.ok(Math.min(...xs) > 0.5, '平移到 +X 的零件投影应整体偏右');
});

test('折边阈值变动：低阈值保留更多边，高阈值只剩边界边，边 id 保持稳定', () => {
  // 用两个相邻、夹角 30° 的面构造折边
  const fold = (() => {
    const ps: Vec3[] = [];
    const face = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => {
      ps.push(a, b, c, a, c, d);
    };
    face(v3(-1, 0, 0), v3(1, 0, 0), v3(1, 0, -1), v3(-1, 0, -1));
    const ang = (Math.PI / 180) * 30;
    const rot = (p: Vec3): Vec3 =>
      v3(p.x, p.y * Math.cos(ang) - p.z * Math.sin(ang), p.y * Math.sin(ang) + p.z * Math.cos(ang));
    face(rot(v3(-1, 0, 0)), rot(v3(1, 0, 0)), rot(v3(1, 0, -1)), rot(v3(-1, 0, -1)));
    return ps;
  })();

  const low = buildWorld([part('fold', fold)], 1);
  const high = buildWorld([part('fold', fold)], 45);
  assert.ok(low.edges.length > high.edges.length, '30° 折边在阈值 1° 保留、45° 被剔除');
  const highIds = new Set(high.edges.map((e) => e.id));
  for (const e of high.edges) {
    assert.ok(low.edgeById.has(e.id), '高阈值保留的边在低阈值结果里必须是同一 id');
  }
  for (const id of highIds) assert.ok(low.edgeById.has(id));
});

test('SVG 往返：导出文本含元数据，解析后视图/阈值/分段与重算一致', () => {
  const plate = part('plate', boxTriangles(6, 2, 0.2));
  const m = identityMat4();
  m[14] = -1.5;
  m[13] = 0.5;
  const blocker = part('blocker', boxTriangles(2, 1, 0.2), m);
  const mesh = buildWorld([plate, blocker], 1);
  const result = runHLR(mesh, frontView(), 1);
  const opts = defaultSvgOptions(800, 600);
  const text = serializeSvg(result, opts, [{ id: 'plate', label: '板', color: 1 }, { id: 'blocker', label: '块', color: 2 }]);
  assert.ok(text.includes('<metadata'));
  assert.ok(text.includes('stroke-dasharray="7 5"'), '隐藏段必须是虚线');

  const meta = parseDrawingMeta(text);
  assert.equal(meta.thresholdDeg, 1);
  assert.deepEqual(meta.view.eye, frontView().eye);

  // 用同样输入重算，逐段比对
  const live = runHLR(buildWorld([plate, blocker], 1), meta.view, meta.thresholdDeg);
  const eps = 1e-6;
  assert.equal(meta.segments.length, live.segments.length);
  const close = (a: { edgeId: string; kind: string; t0: number; t1: number }, b: typeof a): boolean =>
    a.edgeId === b.edgeId && a.kind === b.kind &&
    Math.abs(a.t0 - b.t0) < eps && Math.abs(a.t1 - b.t1) < eps;
  for (const s of meta.segments) {
    assert.ok(live.segments.some((l) => close(s, l)), `往返段缺失: ${JSON.stringify(s)}`);
  }
});

test('关闭虚线时 SVG 只含可见段，元数据同步', () => {
  const mesh = buildWorld([part('box', boxTriangles(2, 2, 2))], 1);
  const result = runHLR(mesh, frontView(), 1);
  const opts = { ...defaultSvgOptions(), showHidden: false };
  const text = serializeSvg(result, opts);
  const meta = parseDrawingMeta(text);
  assert.ok(meta.segments.every((s) => s.kind === 'visible'));
  assert.ok(!text.includes('stroke-dasharray'));
});
