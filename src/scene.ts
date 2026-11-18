import * as THREE from 'three';

/** 不对称文字标记板：文字 + 箭头 + 角标，镜中应呈现左右反转 */
function makeMarkerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f2ecdd';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, c.width - 10, c.height - 10);
  ctx.fillStyle = '#c03028';
  ctx.font = 'bold 84px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('FRONT →', 30, 108);
  ctx.fillStyle = '#1d3f8f';
  ctx.font = 'bold 72px monospace';
  ctx.fillText('012345', 30, 200);
  // 左上角不对称三角标记
  ctx.fillStyle = '#2a7a3a';
  ctx.beginPath();
  ctx.moveTo(24, 24);
  ctx.lineTo(84, 24);
  ctx.lineTo(24, 84);
  ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildScene(scene: THREE.Scene): void {
  // 地面
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x2c313a, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 60, 0x4a5668, 0x333c4a);
  const gridMat = grid.material as THREE.LineBasicMaterial;
  gridMat.transparent = true;
  gridMat.opacity = 0.45;
  grid.position.y = 0.001;
  scene.add(grid);

  // 彩色立柱（位置/高度/颜色各不相同，便于判断倒影中的对应关系）
  const addPillar = (mesh: THREE.Mesh, x: number, z: number, h: number) => {
    mesh.position.set(x, h / 2, z);
    scene.add(mesh);
  };
  const mat = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.7 });

  addPillar(new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.2, 0.8), mat(0xd64545)), -4, -2, 2.2);        // 红
  addPillar(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.6, 24), mat(0xe08a2e)), -2.5, 2.5, 1.6); // 橙
  addPillar(new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.7), mat(0x3fae5a)), 0, 2.5, 1.2);        // 绿（现场3 镜前）
  addPillar(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.8, 24), mat(0x3f7fd6)), 0, -2, 2.8); // 蓝（现场3 镜后）
  addPillar(new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.8, 0.9), mat(0x9a5fd0)), 3.5, 0.5, 1.8);      // 紫
  addPillar(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat(0xe6d24a)), 2, 3.8, 0.5);        // 黄（矮）

  // 不对称文字标记板（立在支架上，面向场景中心）
  const board = new THREE.Group();
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 1.2),
    new THREE.MeshStandardMaterial({ map: makeMarkerTexture(), roughness: 0.8 })
  );
  face.position.y = 1.5;
  board.add(face);
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.9, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x666c75 })
  );
  post.position.y = 0.45;
  board.add(post);
  board.position.set(3.2, 0, -3.2);
  board.rotation.y = -Math.PI / 4;
  scene.add(board);
}
