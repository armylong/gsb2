import * as THREE from 'three';
import { makeLabelSprite } from './textures';

/** 程序生成演示场景：地面、方位墙、立柱、彩色参照物 */
export function buildWorld(scene: THREE.Scene): void {
  // 光照
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(6, 14, 5);
  scene.add(sun);

  // 地面 + 网格
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const grid = new THREE.GridHelper(60, 60, 0x5a7ca0, 0x3a4552);
  grid.position.y = 0.01;
  const gm = grid.material as THREE.Material;
  gm.transparent = true;
  gm.opacity = 0.55;
  scene.add(grid);

  // 四面不同颜色的方位墙，便于判断方向关系
  const wallDefs: { txt: string; color: number; pos: [number, number, number]; ry: number }[] = [
    { txt: '北 N (-Z)', color: 0xa84444, pos: [0, 1.5, -14], ry: 0 },
    { txt: '南 S (+Z)', color: 0x44a866, pos: [0, 1.5, 14], ry: Math.PI },
    { txt: '东 E (+X)', color: 0x4466aa, pos: [14, 1.5, 0], ry: -Math.PI / 2 },
    { txt: '西 W (-X)', color: 0xa89044, pos: [-14, 1.5, 0], ry: Math.PI / 2 },
  ];
  for (const w of wallDefs) {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(28, 3, 0.3),
      new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.9 }),
    );
    wall.position.set(...w.pos);
    wall.rotation.y = w.ry;
    scene.add(wall);
    const tag = makeLabelSprite(w.txt, '#ffffff');
    tag.position.set(w.pos[0], 3.6, w.pos[2]);
    scene.add(tag);
  }

  // 立柱（带编号）
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x8a929c, roughness: 0.7 });
  const pillarPos: [number, number][] = [
    [-6, -6], [6, -6], [6, 6], [-6, 6], [0, -9], [-9, 0],
  ];
  pillarPos.forEach(([x, z], i) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 3.6, 20), pillarMat);
    p.position.set(x, 1.8, z);
    scene.add(p);
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.18, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x6a727c }),
    );
    cap.position.set(x, 3.7, z);
    scene.add(cap);
    const tag = makeLabelSprite(`P${i + 1}`, '#cfe3ff');
    tag.position.set(x, 4.4, z);
    scene.add(tag);
  });

  // 不同颜色的参照物（散布全场景，门内门外都能辨认方位）
  const refs: { make: () => THREE.Mesh; pos: [number, number, number]; label: string; color: string }[] = [
    {
      make: () => new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5),
        new THREE.MeshStandardMaterial({ color: 0xd04040 })),
      pos: [-3, 0.75, -8], label: '红方块', color: '#ff8080',
    },
    {
      make: () => new THREE.Mesh(new THREE.SphereGeometry(0.9, 32, 16),
        new THREE.MeshStandardMaterial({ color: 0x40c060 })),
      pos: [8, 0.9, -3], label: '绿球', color: '#80ffA0',
    },
    {
      make: () => new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.8, 24),
        new THREE.MeshStandardMaterial({ color: 0x4080e0 })),
      pos: [8, 0.9, 8], label: '蓝锥', color: '#80b0ff',
    },
    {
      make: () => new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.3, 16, 40),
        new THREE.MeshStandardMaterial({ color: 0xc050c0 })),
      pos: [-8, 1.1, 8], label: '紫环', color: '#ff90ff',
    },
    {
      make: () => new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x40c8c8 })),
      pos: [0, 0.5, 9.5], label: '青方块', color: '#80ffff',
    },
    {
      make: () => new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 16),
        new THREE.MeshStandardMaterial({ color: 0xe0a030 })),
      pos: [-9, 0.8, -2], label: '橙球', color: '#ffc060',
    },
  ];
  for (const r of refs) {
    const m = r.make();
    m.position.set(...r.pos);
    scene.add(m);
    const tag = makeLabelSprite(r.label, r.color);
    tag.position.set(r.pos[0], r.pos[1] + 1.6, r.pos[2]);
    scene.add(tag);
  }
}
