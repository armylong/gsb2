/**
 * 内置验证：对已知尺寸的样例做侧切 / 斜切，对比解析解，
 * 并覆盖过顶点、贴面、完全不相交、破面等退化情形。
 * 浏览器页面与命令行（npm run verify）共用本模块。
 */
import { computeSection, checkMesh, type Plane, type SectionResult, type MeshCheck } from "./core/section";
import {
  buildMesh,
  SHELL_OUTER,
  SHELL_INNER,
  TORUS_MAJOR,
  TORUS_MINOR,
  type MeshKind,
} from "./meshes";

export interface VerifyRow {
  caseName: string;
  metric: string;
  actual: number;
  expected: number;
  tolerance: number;
  pass: boolean;
  note?: string;
}

export interface VerifyReport {
  rows: VerifyRow[];
  passCount: number;
  total: number;
}

const SQRT2 = Math.SQRT2;
const SQRT3 = Math.sqrt(3);
const PI = Math.PI;

function planeFromNormal(normal: [number, number, number], w: number): Plane {
  const l = Math.hypot(normal[0], normal[1], normal[2]);
  return { normal: { x: normal[0] / l, y: normal[1] / l, z: normal[2] / l }, w };
}

function numericRow(
  rows: VerifyRow[],
  caseName: string,
  metric: string,
  actual: number,
  expected: number,
  relTol: number,
  absTol = 1e-9
): void {
  const tolerance = Math.max(absTol, Math.abs(expected) * relTol);
  rows.push({
    caseName,
    metric,
    actual,
    expected,
    tolerance,
    pass: Math.abs(actual - expected) <= tolerance,
  });
}

function boolRow(rows: VerifyRow[], caseName: string, metric: string, condition: boolean, note?: string): void {
  rows.push({ caseName, metric, actual: condition ? 1 : 0, expected: 1, tolerance: 0, pass: condition, note });
}

function expectShellSideCut(): { area: number; perimeter: number } {
  const outer = SHELL_OUTER;
  const inner = SHELL_INNER;
  return {
    area: outer * outer - inner * inner,
    perimeter: 4 * outer + 4 * inner,
  };
}

function expectShellDiagonalCut(): { area: number; perimeter: number } {
  // 平面 x + y = 0 过中心，截面为矩形：边长 S 与 S√2
  const outer = SHELL_OUTER;
  const inner = SHELL_INNER;
  const areaOuter = outer * outer * SQRT2;
  const areaInner = inner * inner * SQRT2;
  const pOuter = 2 * (outer + outer * SQRT2);
  const pInner = 2 * (inner + inner * SQRT2);
  return { area: areaOuter - areaInner, perimeter: pOuter + pInner };
}

function expectShellBodyDiagonalCut(): { area: number; perimeter: number } {
  // 平面 x + y + z = 0 过立方体中心，垂直于体对角线：截面是正六边形。
  // 六边形顶点为 6 条棱的中点 (±S/2, 0, ∓S/2) 等；
  // 边长 a = S/√2，面积 = (3√3/2) a²，周长 = 6a。
  const outer = SHELL_OUTER;
  const inner = SHELL_INNER;
  const hex = (s: number) => {
    const a = s / SQRT2;
    return { area: (3 * SQRT3 / 2) * a * a, perimeter: 6 * a };
  };
  const ho = hex(outer);
  const hi = hex(inner);
  return { area: ho.area - hi.area, perimeter: ho.perimeter + hi.perimeter };
}

function expectTorusSideCut(): { area: number; perimeter: number } {
  // 平面 x = 0 切圆环：两个半径 r 的圆，圆心距 2R
  const R = TORUS_MAJOR;
  const r = TORUS_MINOR;
  void R;
  return { area: 2 * PI * r * r, perimeter: 2 * (2 * PI * r) };
}

export function runAllVerifications(): VerifyReport {
  const rows: VerifyRow[] = [];

  // ---------- 封闭性检查 ----------
  const shellCheck = checkMesh(buildMesh("shell").data);
  const torusCheck = checkMesh(buildMesh("torus").data);
  boolRow(rows, "封闭性检查", "方壳边界边数为 0", shellCheck.isClosed, `边 ${shellCheck.edgeCount} / 三角面 ${shellCheck.triangleCount}`);
  boolRow(rows, "封闭性检查", "环体边界边数为 0", torusCheck.isClosed, `边 ${torusCheck.edgeCount} / 三角面 ${torusCheck.triangleCount}`);

  // ---------- 用例 1：方壳侧切（x = 0），精确解 ----------
  const shell = buildMesh("shell").data;
  const side = computeSection(shell, planeFromNormal([1, 0, 0], 0));
  const e1 = expectShellSideCut();
  numericRow(rows, "方壳侧切 x=0", "面积", side.sectionArea, e1.area, 1e-9);
  numericRow(rows, "方壳侧切 x=0", "总周长", side.totalPerimeter, e1.perimeter, 1e-9);
  boolRow(rows, "方壳侧切 x=0", "恰好 1 外环 + 1 内环", side.loops.length === 2 && side.loops.filter((l) => l.depth === 0).length === 1 && side.loops.filter((l) => l.depth === 1).length === 1);
  boolRow(rows, "方壳侧切 x=0", "无未闭合链", side.openChains.length === 0);

  // ---------- 用例 2：方壳斜切（x + y = 0，30°/45° 型平面，过中心） ----------
  const diag = computeSection(shell, planeFromNormal([1, 1, 0], 0));
  const e2 = expectShellDiagonalCut();
  numericRow(rows, "方壳斜切 x+y=0", "面积", diag.sectionArea, e2.area, 1e-9);
  numericRow(rows, "方壳斜切 x+y=0", "总周长", diag.totalPerimeter, e2.perimeter, 1e-9);
  boolRow(rows, "方壳斜切 x+y=0", "2 个闭合环", diag.loops.length === 2 && diag.openChains.length === 0);

  // ---------- 用例 3：方壳体对角线斜切（x + y + z = 0），经过 8 条棱的中点 ----------
  const body = computeSection(shell, planeFromNormal([1, 1, 1], 0));
  const e3 = expectShellBodyDiagonalCut();
  numericRow(rows, "方壳体斜切 x+y+z=0", "面积", body.sectionArea, e3.area, 1e-9);
  numericRow(rows, "方壳体斜切 x+y+z=0", "总周长", body.totalPerimeter, e3.perimeter, 1e-9);

  // ---------- 用例 4：环体侧切（x = 0），两个圆截面，含离散误差 ----------
  const torus = buildMesh("torus").data;
  const torusCut = computeSection(torus, planeFromNormal([1, 0, 0], 0));
  const e4 = expectTorusSideCut();
  numericRow(rows, "环体侧切 x=0", "面积", torusCut.sectionArea, e4.area, 6e-4);
  numericRow(rows, "环体侧切 x=0", "总周长", torusCut.totalPerimeter, e4.perimeter, 6e-4);
  boolRow(rows, "环体侧切 x=0", "2 个外环（两截管）", torusCut.loops.length === 2 && torusCut.loops.every((l) => l.depth === 0));

  // ---------- 退化情形：贴面 / 过顶点 / 完全不相交，结果必须稳定 ----------
  const tangent = computeSection(shell, planeFromNormal([1, 0, 0], SHELL_OUTER / 2));
  boolRow(rows, "贴面 x=2（与外表面重合）", "无截面线段、不报错", tangent.loops.length === 0 && tangent.segmentCount === 0 && tangent.openChains.length === 0, `面积=${tangent.sectionArea.toExponential(2)}`);

  const corner = computeSection(shell, planeFromNormal([1, 1, 1], (SHELL_OUTER / 2) * SQRT3));
  boolRow(rows, "过角点 x+y+z=2√3", "无截面线段、不报错", corner.loops.length === 0 && corner.segmentCount === 0, `面积=${corner.sectionArea.toExponential(2)}`);

  const miss = computeSection(shell, planeFromNormal([1, 0, 0], 5));
  boolRow(rows, "完全切不到 x=5", "面积与环均为 0", miss.loops.length === 0 && miss.sectionArea === 0 && miss.totalPerimeter === 0);

  // 贴面后向实体内部平移到 w=1：外盒实体区被切穿、同时切到内腔（内腔壁在 1.5），
  // 应稳定得到"外环 + 内环"两个闭合环
  const nearFace = computeSection(shell, planeFromNormal([1, 0, 0], 1));
  boolRow(rows, "贴面内移至 w=1", "稳定得到 2 个环", nearFace.loops.length === 2 && nearFace.openChains.length === 0, `环数=${nearFace.loops.length}`);

  // ---------- 破面：给出未闭合边与位置 ----------
  // 切平面必须真正穿过破口：方壳破口在顶面 z=2，用斜平面 x + 3z = 5.4；
  // 环体破口在管底外侧，用斜平面 x - 1.5z = 2 切过下管区域。
  const brokenCases: { kind: MeshKind; cut: Plane; name: string }[] = [
    // 斜平面 x + 3z = 5.4：过顶面 z=2 的破口区域（该处 x≈-0.6），截面在破口处断开。
    // 注意直接给定单位法向与 w，不要再做归一化（否则 w 会被多除一次模长）。
    {
      kind: "brokenShell",
      cut: (() => {
        const l = Math.hypot(1, 0, 3);
        return { normal: { x: 1 / l, y: 0, z: 3 / l }, w: 5.4 / l };
      })(),
      name: "破面方壳（顶面挖洞）",
    },
    // 斜平面 x - 1.5z = 2：切过环管底部外侧的破口
    { kind: "brokenTorus", cut: planeFromNormal([1, 0, -1.5], 2), name: "破面环体（管底挖洞）" },
  ];
  for (const bc of brokenCases) {
    const built = buildMesh(bc.kind);
    const check = checkMesh(built.data);
    boolRow(rows, `破面检测·${bc.name}`, "检测到边界边", !check.isClosed && check.boundaryEdges.length > 0, `${check.boundaryEdges.length} 条边界边`);
    const cut = computeSection(built.data, bc.cut);
    boolRow(rows, `破面检测·${bc.name}`, "截交出现未闭合链", cut.openChains.length > 0, `${cut.openChains.length} 条未闭合链`);
  }

  const passCount = rows.filter((r) => r.pass).length;
  return { rows, passCount, total: rows.length };
}

/** 供 UI 展示用：附带一次破面网格的检查详情 */
export function describeBrokenMesh(kind: MeshKind): { check: MeshCheck; cut: SectionResult } {
  const built = buildMesh(kind);
  return {
    check: checkMesh(built.data),
    cut: computeSection(built.data, planeFromNormal([1, 0, 0], 0)),
  };
}
