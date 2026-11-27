import * as THREE from 'three';

export interface Environment {
  scene: THREE.Scene;
  /** 带转动 + 缩放动画的父级架子，牌挂在它下面 */
  shelf: THREE.Group;
  /** 能挡牌的物体（墙体、隔断、架子本体），点选时参与遮挡判定 */
  occluders: THREE.Object3D[];
  update: (elapsed: number) => void;
}

/** 在物体上打遮挡标记，点选逻辑靠它区分墙和牌。 */
export function markOccluder(obj: THREE.Object3D): THREE.Object3D {
  obj.userData.occluder = true;
  return obj;
}

function box(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      metalness: 0.05,
      transparent: true,
      opacity: 0.92,
    }),
  );
  mesh.position.set(x, y, z);
  return markOccluder(mesh) as THREE.Mesh;
}

export function createEnvironment(): Environment {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10141b);
  scene.fog = new THREE.Fog(0x10141b, 45, 110);

  const occluders: THREE.Object3D[] = [];

  // 灯光：牌用 MeshBasic 不受光，环境物体用标准材质需要光
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(8, 14, 6);
  scene.add(dir);

  // 地面
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(28, 20),
    new THREE.MeshStandardMaterial({ color: 0x232a36, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(28, 28, 0x3a4658, 0x222b39);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.55;
  grid.position.y = 0.01;
  scene.add(grid);

  // 三面墙（正面敞开，方便相机移出房间看远景/背后）
  const wallColor = 0x3d4a5e;
  const backWall = box(28, 9, 0.4, wallColor, 0, 4.5, -9);
  const leftWall = box(0.4, 9, 20, wallColor, -14, 4.5, 0);
  const rightWall = box(0.4, 9, 20, wallColor, 14, 4.5, 0);
  scene.add(backWall, leftWall, rightWall);
  occluders.push(backWall, leftWall, rightWall);

  // 室内隔断：制造“半遮挡”姿态
  const partition = box(0.4, 4.4, 7, 0x4a5a72, 3.4, 2.2, -3.5);
  scene.add(partition);
  occluders.push(partition);

  // 世界坐标轴（角落小参考）
  const axes = new THREE.AxesHelper(1.6);
  axes.position.set(-12.6, 0.05, 8.6);
  scene.add(axes);

  // ---- 父级架子：持续绕 Y 转动 + 周期性缩放 ----
  const shelf = new THREE.Group();
  shelf.position.set(7.5, 0, 1.5);
  scene.add(shelf);

  const metal = new THREE.MeshStandardMaterial({
    color: 0x8fa3bd,
    roughness: 0.5,
    metalness: 0.4,
  });

  const post = markOccluder(
    new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 3.6, 16), metal),
  ) as THREE.Mesh;
  post.position.y = 1.8;
  const base = markOccluder(
    new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 0.18, 24), metal),
  ) as THREE.Mesh;
  base.position.y = 0.09;
  const beam = markOccluder(
    new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.14, 0.14), metal),
  ) as THREE.Mesh;
  beam.position.set(0, 3.35, 0);
  shelf.add(post, base, beam);
  occluders.push(post, base, beam);

  let shelfAnim = true;
  const update = (elapsed: number): void => {
    if (!shelfAnim) return;
    shelf.rotation.y = Math.sin(elapsed * 0.45) * 0.75;
    shelf.scale.setScalar(1 + Math.sin(elapsed * 0.8) * 0.12);
    shelf.rotation.z = Math.sin(elapsed * 0.33) * 0.04;
  };

  return {
    scene,
    shelf,
    occluders,
    update,
  };
}
