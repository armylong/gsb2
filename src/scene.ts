import * as THREE from 'three';

/**
 * 程序生成有限测试场景：
 * - 近 / 中 / 远三排带文字刻度的标记板（6 + 8 + 6 = 20）
 * - 少量明亮小圆点（15 个，其中 3 个可自动前后移动）
 * - 一块可点选的地面
 * 参与计数的场景物体共 35 个（<= 40），地面另计。
 */

export interface RowSpec {
  name: string;
  z: number;
  depth: number;
  color: number;
  count: number;
  xSpan: number;
  y: number;
}

export const ROWS: RowSpec[] = [
  { name: '近排', z: 2, depth: 8, color: 0xff8a5c, count: 6, xSpan: 5.0, y: 1.15 },
  { name: '中排', z: -4, depth: 14, color: 0x6ee7a8, count: 8, xSpan: 7.2, y: 1.45 },
  { name: '远排', z: -10, depth: 20, color: 0x6aa8ff, count: 6, xSpan: 9.0, y: 1.8 },
];

export interface MoverSpec {
  baseZ: number;
  amp: number;
  freq: number;
  phase: number;
}

export interface BuiltScene {
  scene: THREE.Scene;
  /** 可参与点选的对象（不含焦平面辅助物） */
  pickables: THREE.Object3D[];
  movers: THREE.Mesh[];
  boardGroups: THREE.Group[];
}

const BOARD_W = 0.95;
const BOARD_H = 0.62;

function makeLabelTexture(row: RowSpec, index: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 224;
  const ctx = canvas.getContext('2d')!;

  const cssColor = '#' + new THREE.Color(row.color).getHexString();

  // 背景
  ctx.fillStyle = '#10151c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = cssColor;
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);

  // 排名 + 序号
  ctx.fillStyle = cssColor;
  ctx.font = 'bold 56px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`${row.name} ${index + 1}`, 20, 16);

  // 深度读数
  ctx.fillStyle = '#f2f6fa';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText(`${row.depth.toFixed(1)} m`, 20, 82);

  // 刻度尺
  const rulerY = 168;
  const rulerX0 = 20;
  const rulerX1 = canvas.width - 20;
  ctx.strokeStyle = '#c9d4df';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(rulerX0, rulerY);
  ctx.lineTo(rulerX1, rulerY);
  ctx.stroke();

  const ticks = 10;
  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#9fb0c0';
  for (let i = 0; i <= ticks; i++) {
    const x = rulerX0 + ((rulerX1 - rulerX0) * i) / ticks;
    const long = i % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(x, rulerY);
    ctx.lineTo(x, rulerY - (long ? 26 : 14));
    ctx.stroke();
    if (long) ctx.fillText(String(i), x - 6, rulerY + 8);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 明亮圆点（HDR 色值，半浮点缓冲下能形成可辨认散景） */
function makeDot(radius: number, rgb: [number, number, number]): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 20, 14);
  const mat = new THREE.MeshBasicMaterial();
  mat.color.setRGB(rgb[0], rgb[1], rgb[2]);
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}

export function buildScene(): BuiltScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e12);
  scene.fog = new THREE.Fog(0x0b0e12, 38, 90);

  // 灯光（标记板边框 / 地面使用标准材质）
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a2028, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(6, 10, 8);
  scene.add(dir);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // 地面与网格
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(70, 46),
    new THREE.MeshStandardMaterial({ color: 0x171c23, roughness: 0.95, metalness: 0.0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, -4);
  ground.userData.kind = 'ground';
  scene.add(ground);

  const grid = new THREE.GridHelper(44, 44, 0x3a4756, 0x232c36);
  grid.position.set(0, 0.01, -4);
  scene.add(grid);

  const pickables: THREE.Object3D[] = [ground];
  const boardGroups: THREE.Group[] = [];

  // 三排标记板
  for (const row of ROWS) {
    for (let i = 0; i < row.count; i++) {
      const t = row.count === 1 ? 0.5 : i / (row.count - 1);
      const x = (t - 0.5) * row.xSpan;
      const y = row.y + (i % 2 === 0 ? 0.12 : -0.06);

      const group = new THREE.Group();
      group.position.set(x, y, row.z);
      group.userData.kind = 'board';
      group.userData.rowName = row.name;
      group.userData.index = i + 1;
      group.userData.planeDepth = row.depth;

      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.07),
        new THREE.MeshStandardMaterial({ color: row.color, roughness: 0.5, metalness: 0.15 }),
      );
      group.add(frame);

      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(BOARD_W * 0.88, BOARD_H * 0.86),
        new THREE.MeshBasicMaterial({ map: makeLabelTexture(row, i) }),
      );
      label.position.z = 0.041;
      group.add(label);

      scene.add(group);
      boardGroups.push(group);
      pickables.push(group);
    }
  }

  // 明亮圆点：[x, y, z, radius, HDR rgb]
  const dotDefs: Array<[number, number, number, number, [number, number, number]]> = [
    // 前景（相机与近排之间）
    [-1.7, 2.3, 5.6, 0.1, [3.2, 1.4, 0.8]],
    [1.25, 1.0, 5.9, 0.085, [1.2, 2.6, 3.4]],
    [2.45, 2.7, 4.9, 0.11, [3.4, 3.0, 1.4]],
    [-2.7, 0.75, 4.6, 0.08, [2.8, 1.2, 3.2]],
    // 近排与中排之间
    [-3.4, 2.5, -0.6, 0.09, [3.0, 2.2, 1.0]],
    [3.55, 1.9, -1.2, 0.1, [1.0, 3.0, 2.2]],
    [0.35, 3.0, -2.4, 0.075, [2.6, 2.6, 3.4]],
    // 中排与远排之间
    [-4.3, 2.8, -6.6, 0.1, [3.3, 1.8, 1.1]],
    [4.45, 2.3, -7.1, 0.095, [1.1, 2.0, 3.3]],
    [0.0, 3.4, -8.0, 0.08, [2.9, 3.1, 2.0]],
    [-1.1, 0.85, -6.1, 0.07, [3.4, 1.3, 1.6]],
    [2.1, 3.1, -8.6, 0.09, [1.6, 3.2, 2.8]],
    // 远排之后（后景）
    [-3.2, 2.6, -13.2, 0.1, [3.1, 2.4, 1.3]],
    [3.1, 3.3, -14.6, 0.09, [1.5, 2.3, 3.4]],
    [0.6, 1.6, -15.6, 0.11, [3.3, 3.3, 2.6]],
  ];

  const movers: THREE.Mesh[] = [];
  const moverIndex = new Set([0, 6, 13]);

  dotDefs.forEach((def, i) => {
    const [x, y, z, r, rgb] = def;
    const dot = makeDot(r, rgb);
    dot.position.set(x, y, z);
    dot.userData.kind = 'dot';
    dot.userData.name = `亮点 ${i + 1}`;
    scene.add(dot);
    pickables.push(dot);

    if (moverIndex.has(i)) {
      dot.userData.mover = {
        baseZ: z,
        amp: 1.1 + i * 0.08,
        freq: 0.35 + i * 0.07,
        phase: i * 1.7,
      } satisfies MoverSpec;
      movers.push(dot);
    }
  });

  return { scene, pickables, movers, boardGroups };
}

/** 更新自动移动测试物体（沿世界 z 轴往复，深度仍按相机朝向解释） */
export function updateMovers(movers: THREE.Mesh[], time: number, enabled: boolean): void {
  if (!enabled) return;
  for (const m of movers) {
    const spec = m.userData.mover as MoverSpec;
    m.position.z = spec.baseZ + Math.sin(time * spec.freq * Math.PI * 2 + spec.phase) * spec.amp;
  }
}
