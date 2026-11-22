/**
 * 程序生成的装配样例（three.js 几何 + 刚体变换）。
 *
 * 三个不透明零件：
 *  A 开孔底板：带圆孔的挤出板，孔圈边和板折边都应出现在图上；
 *  B 前景遮挡块：位于相机与底板之间，正视图下只挡住底板一条长边的中间一截，
 *     该长边两端保持实线、被挡区间可切成虚线；
 *  C 旋转小方块：带平移+旋转，用来验证零件变换反映到出图。
 */

import * as THREE from 'three';
import type { RawPart } from '../hlr/geometry.ts';
import { fromThreeMatrix4, v3 } from '../hlr/math3d.ts';

export interface SamplePart {
  raw: RawPart;
  object: THREE.Object3D;
  geometry: THREE.BufferGeometry;
}

export interface SampleScene {
  parts: SamplePart[];
  group: THREE.Group;
}

function extractPositions(geometry: THREE.BufferGeometry): { x: number; y: number; z: number }[] {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position');
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < pos.count; i++) {
    out.push(v3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return out;
}

/** 带圆孔的板：THREE.Shape 开孔 + 挤出，孔壁由一圈三角面构成。 */
function makePlateGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const w = 4.4;
  const h = 2.6;
  shape.moveTo(-w / 2, -h / 2);
  shape.lineTo(w / 2, -h / 2);
  shape.lineTo(w / 2, h / 2);
  shape.lineTo(-w / 2, h / 2);
  shape.closePath();

  const hole = new THREE.Path();
  hole.absellipse(0, -0.15, 0.62, 0.62, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: 0.35,
    bevelEnabled: false,
    curveSegments: 36,
    steps: 1
  });
  geom.translate(0, 0, -0.175);
  geom.computeVertexNormals();
  return geom;
}

export function createSampleScene(): SampleScene {
  const group = new THREE.Group();
  const parts: SamplePart[] = [];

  // A 开孔底板（放在 z 靠后位置）
  const plateGeom = makePlateGeometry();
  const plate = new THREE.Mesh(
    plateGeom,
    new THREE.MeshStandardMaterial({ color: 0x9fc2e8, metalness: 0.1, roughness: 0.6 })
  );
  plate.position.set(0, 0, 0);
  plate.name = 'plate';
  group.add(plate);
  parts.push({
    raw: {
      id: 'A-plate',
      label: 'A 开孔底板',
      color: 0x9fc2e8,
      matrix: fromThreeMatrix4(plate.matrix),
      positions: extractPositions(plateGeom)
    },
    object: plate,
    geometry: plateGeom
  });

  // B 前景遮挡块：窄方块，正视图下覆盖底板顶部长边 (y=+1.3) 的中间一截，
  // 块的竖直范围 y∈[0.85, 1.75] 与顶边相交，但宽度 1.7 < 板宽 4.4，两端各露出 1.35。
  const blockerGeom = new THREE.BoxGeometry(1.7, 0.9, 0.5);
  const blocker = new THREE.Mesh(
    blockerGeom,
    new THREE.MeshStandardMaterial({ color: 0xe8a87c, metalness: 0.1, roughness: 0.55 })
  );
  blocker.position.set(0, 1.3, -0.95);
  blocker.name = 'blocker';
  group.add(blocker);
  parts.push({
    raw: {
      id: 'B-blocker',
      label: 'B 前景遮挡块',
      color: 0xe8a87c,
      matrix: fromThreeMatrix4(blocker.matrix),
      positions: extractPositions(blockerGeom)
    },
    object: blocker,
    geometry: blockerGeom
  });

  // C 旋转小方块：平移 + 绕 Y 轴旋转 32°，验证变换出图。
  // 放在相机一侧（-Z，比板的前表面 z=-0.175 更靠前），正视下自身棱边可见。
  const tiltedGeom = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  const tilted = new THREE.Mesh(
    tiltedGeom,
    new THREE.MeshStandardMaterial({ color: 0x9ed2a3, metalness: 0.1, roughness: 0.55 })
  );
  tilted.position.set(-1.35, -0.75, -0.75);
  // 绕 Y 旋转使深度棱在正视下产生 x 分量；再绕 Z 倾斜使正视投影出现斜向边
  tilted.rotation.y = THREE.MathUtils.degToRad(32);
  tilted.rotation.z = THREE.MathUtils.degToRad(18);
  tilted.name = 'tilted';
  group.add(tilted);
  parts.push({
    raw: {
      id: 'C-tilted',
      label: 'C 旋转小方块',
      color: 0x9ed2a3,
      matrix: fromThreeMatrix4(tilted.matrix),
      positions: extractPositions(tiltedGeom)
    },
    object: tilted,
    geometry: tiltedGeom
  });

  group.updateMatrixWorld(true);
  // 用 world matrix 重建一次 RawPart（保险：包含组层级变换时仍正确）
  for (const sp of parts) {
    sp.object.updateWorldMatrix(true, false);
    sp.raw.matrix = fromThreeMatrix4(sp.object.matrixWorld);
  }

  return { parts, group };
}
