import * as THREE from 'three';

/**
 * 程序生成的测试网格，全部在本地构造、无外部资源。
 * 每个模型都同时包含水平面、竖直面和斜面/曲面，方便检查转角接合。
 * 非索引（或按面拆分）顶点 + computeVertexNormals => 硬边面法线；
 * 弯面 (bend) 保留共享顶点以获得平滑法线，观察连续权重过渡。
 */

type V3 = [number, number, number];

interface Builder {
  positions: number[];
  pushQuad(a: V3, b: V3, c: V3, d: V3): void;
  build(): THREE.BufferGeometry;
}

function createBuilder(): Builder {
  const positions: number[] = [];
  function tri(a: V3, b: V3, c: V3) {
    positions.push(...a, ...b, ...c);
  }
  return {
    positions,
    pushQuad(a, b, c, d) {
      tri(a, b, c);
      tri(a, c, d);
    },
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    },
  };
}

const X0 = -2;
const X1 = 2;
const BOTTOM = -0.6;

/**
 * 斜坡台：沿 z 方向依次为
 *   z=-3..-1 水平底面 (y=0)
 *   z=-1.. 1 45° 斜面 (升至 y=2)
 *   z= 1.. 3 水平顶面 (y=2)
 * 两侧竖直侧壁 + 端盖 + 底盖，形成封闭实体。
 */
export function createRampGeometry(): THREE.BufferGeometry {
  const b = createBuilder();
  // 顶部轮廓站点 (z, y)
  const top: Array<[number, number]> = [
    [-3, 0],
    [-1, 0],
    [1, 2],
    [3, 2],
  ];

  // 顶面（含水平段与斜面），法线朝上
  for (let i = 0; i < top.length - 1; i++) {
    const [z0, y0] = top[i];
    const [z1, y1] = top[i + 1];
    // 翻面绕序：法线 (0, +Δz, -Δy)，斜面段即 (0,+.707,-.707) 朝外
    b.pushQuad([X0, y0, z0], [X0, y1, z1], [X1, y1, z1], [X1, y0, z0]);
  }
  // 底面（法线 -Y）
  b.pushQuad([X0, BOTTOM, -3], [X1, BOTTOM, -3], [X1, BOTTOM, 3], [X0, BOTTOM, 3]);
  // 右侧壁 (x=+2, 法线 +X) 与左侧壁 (x=-2, 法线 -X)
  for (let i = 0; i < top.length - 1; i++) {
    const [z0, y0] = top[i];
    const [z1, y1] = top[i + 1];
    b.pushQuad([X1, y0, z0], [X1, BOTTOM, z0], [X1, BOTTOM, z1], [X1, y1, z1]);
    b.pushQuad([X0, y0, z0], [X0, y1, z1], [X0, BOTTOM, z1], [X0, BOTTOM, z0]);
  }
  // 侧壁与底盖之间、端盖处补齐：右侧/左侧轮廓最后一段到端角
  // 端盖 z=+3（法线 +Z）
  b.pushQuad([X0, BOTTOM, 3], [X1, BOTTOM, 3], [X1, 2, 3], [X0, 2, 3]);
  // 端盖 z=-3（法线 -Z）
  b.pushQuad([X0, 0, -3], [X1, 0, -3], [X1, BOTTOM, -3], [X0, BOTTOM, -3]);

  const g = b.build();
  g.name = 'ramp';
  return g;
}

/**
 * 凹转角：三块板组成的室内墙角
 *   地板 y=0 (法线 +Y)、墙 x=0 (法线 +X)、墙 z=0 (法线 +Z)
 * 三个轴各占一板，交线处就是典型的轴界面。
 */
export function createCornerGeometry(): THREE.BufferGeometry {
  const b = createBuilder();
  const S = 3;
  // 地板
  b.pushQuad([0, 0, 0], [0, 0, S], [S, 0, S], [S, 0, 0]);
  // 墙 x=0
  b.pushQuad([0, 0, 0], [0, S, 0], [0, S, S], [0, 0, S]);
  // 墙 z=0
  b.pushQuad([0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0]);
  const g = b.build();
  g.name = 'corner';
  return g;
}

/**
 * 四分之一圆弯面：水平地面平滑过渡到竖直墙，
 * 轴线沿 x，截面在 z-y 平面，共享顶点 => 平滑法线，
 * 可观察权重从 Y 轴连续过渡到 Z 轴的全过程。
 */
export function createBendGeometry(segments = 24): THREE.BufferGeometry {
  // 截面路径 (z, y)：平底 → 圆弧（圆心 (-1,1)，半径 1）→ 竖直尾
  const path: Array<[number, number]> = [];
  path.push([-3, 0], [-1, 0]);
  for (let i = 1; i <= segments; i++) {
    const phi = -Math.PI / 2 + (Math.PI / 2) * (i / segments);
    path.push([-1 + Math.cos(phi), 1 + Math.sin(phi)]);
  }
  path.push([0, 2]);

  // 共享顶点的索引网格，保证弯面法线平滑
  const positions: number[] = [];
  for (const [z, y] of path) {
    positions.push(X0, y, z, X1, y, z);
  }
  const indices: number[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = i * 2;
    const b1 = a + 1;
    const c = a + 3;
    const d = a + 2;
    // 绕序保证平滑法线指向弯面外侧（+Y 平滑扫到 +Z）
    indices.push(a, c, b1, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);

  // 两端封盖（x=±2），用 2D 三角化
  const poly = path.concat([
    [0, 0],
    [-3, 0],
  ]);
  const tris = THREE.ShapeUtils.triangulateShape(
    poly.map(([z, y]) => new THREE.Vector2(z, y)),
    [],
  );
  const cap = (x: number, flip: boolean) => {
    const base = positions.length / 3;
    for (const [z, y] of poly) positions.push(x, y, z);
    for (const t of tris) {
      const [i, j, k] = t.map((v) => base + v);
      if (flip) indices.push(i, k, j);
      else indices.push(i, j, k);
    }
  };
  cap(X0, false);
  cap(X1, true);

  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.name = 'bend';
  return g;
}

/** 参考立方体：凸转角，三个轴权重在棱线处对切 */
export function createBoxGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(3, 3, 3);
  g.computeVertexNormals();
  g.name = 'box';
  return g;
}

export const GEOMETRY_FACTORIES = {
  ramp: createRampGeometry,
  corner: createCornerGeometry,
  bend: createBendGeometry,
  box: createBoxGeometry,
} as const;

export type GeometryName = keyof typeof GEOMETRY_FACTORIES;
