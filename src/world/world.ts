import * as THREE from 'three';
import { FogParams, boxMinMax } from '../fog/fog';

/** 可被点选 raycast 的物体都收集在这里（标签 sprite / 雾盒辅助物不收） */
export interface SceneWorld {
  group: THREE.Group;
  pickables: THREE.Object3D[];
  fogBoxHelper: THREE.LineSegments;
  fogBoxFaces: THREE.Mesh;
  updateFogBox: (params: FogParams) => void;
  sun: THREE.DirectionalLight;
}

function checkerTexture(label: string): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cells = 8;
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#e8e8e8' : '#3a3f47';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  ctx.fillStyle = 'rgba(20, 24, 30, 0.72)';
  ctx.fillRect(0, size - 44, size, 44);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size - 22);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeTextSprite(text: string, color = '#ffe9a8'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(15, 18, 24, 0.65)';
  ctx.roundRect(8, 24, 496, 80, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 0.55, 1);
  return sprite;
}

function addBox(
  pickables: THREE.Object3D[],
  parent: THREE.Group,
  size: [number, number, number],
  pos: [number, number, number],
  color: number,
  name: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 }),
  );
  mesh.position.set(...pos);
  mesh.name = name;
  parent.add(mesh);
  pickables.push(mesh);
  return mesh;
}

export function buildWorld(params: FogParams): SceneWorld {
  const group = new THREE.Group();
  group.name = 'world';
  const pickables: THREE.Object3D[] = [];

  // ---- 地面 ----
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0x6b7079, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.name = '地面';
  group.add(ground);
  pickables.push(ground);

  const grid = new THREE.GridHelper(30, 30, 0x2c3138, 0x454b54);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.55;
  grid.position.y = 0.01;
  group.add(grid);

  // ---- 后墙：用来观察「空背景遵守雾区边界」 ----
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 8),
    new THREE.MeshStandardMaterial({ color: 0x4a5563, roughness: 1 }),
  );
  wall.position.set(0, 4, -12);
  wall.name = '后墙（背景）';
  group.add(wall);
  pickables.push(wall);

  // ---- 门框：正好卡在默认雾盒正面（z = +4）----
  const frameColor = 0x8a5a2b;
  addBox(pickables, group, [0.35, 3.2, 0.35], [-1.6, 1.6, 4], frameColor, '门框·左柱');
  addBox(pickables, group, [0.35, 3.2, 0.35], [1.6, 1.6, 4], frameColor, '门框·右柱');
  addBox(pickables, group, [3.55, 0.35, 0.35], [0, 3.2, 4], frameColor, '门框·横梁');

  // ---- 三根柱子：雾前 / 雾内 / 雾后 ----
  addBox(pickables, group, [0.7, 3, 0.7], [-2.5, 1.5, 7], 0xb0554a, '柱子·雾前');
  addBox(pickables, group, [0.7, 3, 0.7], [-2.5, 1.5, 0], 0x6f9a6d, '柱子·雾内');
  addBox(pickables, group, [0.7, 3, 0.7], [-2.5, 1.5, -7], 0x5a78a8, '柱子·雾后');

  const labels: Array<[string, THREE.Vector3]> = [
    ['雾前', new THREE.Vector3(-2.5, 3.35, 7)],
    ['雾内', new THREE.Vector3(-2.5, 3.35, 0)],
    ['雾后', new THREE.Vector3(-2.5, 3.35, -7)],
  ];
  for (const [text, pos] of labels) {
    const sprite = makeTextSprite(text);
    sprite.position.copy(pos);
    group.add(sprite);
  }

  // ---- 同距离上下两块标记板：比高度衰减造成的明暗差 ----
  const boardLow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 1.6),
    new THREE.MeshStandardMaterial({ map: checkerTexture('下板 y=0.8'), roughness: 0.9 }),
  );
  boardLow.position.set(2.5, 0.8, 0);
  boardLow.name = '标记板·下';
  group.add(boardLow);
  pickables.push(boardLow);

  const boardHigh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 1.6),
    new THREE.MeshStandardMaterial({ map: checkerTexture('上板 y=2.4'), roughness: 0.9 }),
  );
  boardHigh.position.set(2.5, 2.4, 0);
  boardHigh.name = '标记板·上';
  group.add(boardHigh);
  pickables.push(boardHigh);

  const boardLabel = makeTextSprite('同距离上下板');
  boardLabel.position.set(2.5, 3.5, 0);
  group.add(boardLabel);

  // ---- 雾盒可视化：线框 + 半透明面（辅助物本身也会被雾正确处理）----
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const fogBoxHelper = new THREE.LineSegments(
    new THREE.EdgesGeometry(boxGeo),
    new THREE.LineBasicMaterial({ color: 0x7fd0ff, transparent: true, opacity: 0.9 }),
  );
  fogBoxHelper.name = '雾区边界';
  group.add(fogBoxHelper);

  const fogBoxFaces = new THREE.Mesh(
    boxGeo,
    new THREE.MeshBasicMaterial({
      color: 0x9fc8e8,
      transparent: true,
      opacity: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  fogBoxFaces.name = '雾区半透明面';
  group.add(fogBoxFaces);

  // ---- 灯光：一盏平行光 + 一个环境亮度 ----
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.1);
  sun.position.set(0, 6, 8);
  group.add(sun);
  group.add(sun.target);
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  group.add(ambient);

  const tmpMin = new THREE.Vector3();
  const tmpMax = new THREE.Vector3();

  function updateFogBox(p: FogParams): void {
    boxMinMax(p, tmpMin, tmpMax);
    fogBoxHelper.position.copy(p.boxCenter);
    fogBoxHelper.scale.copy(p.boxSize);
    fogBoxFaces.position.copy(p.boxCenter);
    fogBoxFaces.scale.copy(p.boxSize);
    fogBoxHelper.visible = p.showBounds;
    fogBoxFaces.visible = p.showBounds;
  }

  updateFogBox(params);
  return { group, pickables, fogBoxHelper, fogBoxFaces, updateFogBox, sun };
}
