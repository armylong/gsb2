import * as THREE from 'three';
import { grainTangentAt, grainWeightAt, type GrainConfig, type GrainMode } from './grain';

export interface GrainMesh {
  mesh: THREE.Mesh;
  /** 环形纹圆心（物体局部空间） */
  grainCenter: THREE.Vector3;
  label: string;
}

/**
 * 点击检查：在物体表面拾取点，画一条跟随物体转动的纹路方向线。
 * marker 挂在 mesh 的父级（与 mesh 同级），用 mesh 局部坐标保存，
 * 每帧把 mesh 的世界矩阵拷给 marker，因此方向线严格跟着物体走。
 */
export class DirectionInspector {
  private readonly raycaster = new THREE.Raycaster();
  private readonly markers = new Map<THREE.Mesh, THREE.Group>();
  private visible = true;
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    for (const g of this.markers.values()) g.visible = v;
  }

  isVisible(): boolean {
    return this.visible;
  }

  clear(): void {
    for (const [mesh, g] of this.markers) {
      this.scene.remove(g);
      g.traverse((o) => {
        const line = o as THREE.Line;
        if (line.geometry) line.geometry.dispose();
      });
      this.markers.delete(mesh);
    }
  }

  /** 每帧同步 marker 的姿态到所属 mesh（纯矩阵拷贝，不触碰任何材质 uniform） */
  update(): void {
    for (const [mesh, group] of this.markers) {
      group.matrix.copy(mesh.matrixWorld);
      group.matrixAutoUpdate = false;
    }
  }

  pick(
    ndcX: number,
    ndcY: number,
    camera: THREE.Camera,
    targets: GrainMesh[],
    mode: GrainMode,
    angleOf: (mesh: THREE.Mesh) => number,
  ): string | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hits = this.raycaster.intersectObjects(
      targets.map((t) => t.mesh),
      false,
    );
    if (hits.length === 0) return null;
    const hit = hits[0];
    const target = targets.find((t) => t.mesh === hit.object);
    if (!target) return null;

    const mesh = target.mesh;
    const localPoint = mesh.worldToLocal(hit.point.clone());
    // 法线直接从几何属性取（与着色器 vGrainNormal 同源），插值到命中三角形
    const localNormal = new THREE.Vector3();
    const normalAttr = mesh.geometry.getAttribute('normal');
    if (normalAttr && hit.face) {
      const a = new THREE.Vector3().fromBufferAttribute(normalAttr, hit.face.a);
      const b = new THREE.Vector3().fromBufferAttribute(normalAttr, hit.face.b);
      const c = new THREE.Vector3().fromBufferAttribute(normalAttr, hit.face.c);
      if (hit.uv) {
        localNormal
          .addScaledVector(a, 1 - hit.uv.x - hit.uv.y)
          .addScaledVector(b, hit.uv.x)
          .addScaledVector(c, hit.uv.y)
          .normalize();
      } else {
        localNormal.copy(hit.face.normal).normalize();
      }
    } else {
      localNormal.set(0, 0, 1);
    }

    const config: GrainConfig = { mode, angle: angleOf(mesh), center: target.grainCenter };
    const tangent = grainTangentAt(config, localPoint, localNormal, new THREE.Vector3());
    const weight = grainWeightAt(config, localPoint, localNormal);

    const old = this.markers.get(mesh);
    if (old) {
      this.scene.remove(old);
      this.markers.delete(mesh);
    }

    const group = this.buildMarker(localPoint, tangent, localNormal, weight);
    group.visible = this.visible;
    this.scene.add(group);
    this.markers.set(mesh, group);

    const across = tangent.clone().cross(localNormal).normalize();
    return [
      `样板：${target.label}`,
      `局部坐标：(${localPoint.x.toFixed(3)}, ${localPoint.y.toFixed(3)}, ${localPoint.z.toFixed(3)})`,
      mode === 'circular'
        ? `距环心：${localPoint.distanceTo(target.grainCenter).toFixed(3)}，各向异性权重：${weight.toFixed(2)}`
        : '方向分布：直线纹',
      `纹路切向：(${tangent.x.toFixed(3)}, ${tangent.y.toFixed(3)}, ${tangent.z.toFixed(3)})`,
      `横过纹路：(${across.x.toFixed(3)}, ${across.y.toFixed(3)}, ${across.z.toFixed(3)})`,
    ].join('\n');
  }

  private buildMarker(point: THREE.Vector3, tangent: THREE.Vector3, normal: THREE.Vector3, weight: number): THREE.Group {
    const group = new THREE.Group();
    const lineLen = 0.34;

    // 纹路方向：青色双线（沿 +T / -T）
    const tGeom = new THREE.BufferGeometry().setFromPoints([
      point.clone().addScaledVector(tangent, -lineLen),
      point.clone().addScaledVector(tangent, lineLen),
    ]);
    const tLine = new THREE.Line(
      tGeom,
      new THREE.LineBasicMaterial({ color: 0x35e6e0, depthTest: true }),
    );

    // 横过纹路方向：黄色短线
    const across = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    const bGeom = new THREE.BufferGeometry().setFromPoints([
      point.clone().addScaledVector(across, -lineLen * 0.55),
      point.clone().addScaledVector(across, lineLen * 0.55),
    ]);
    const bLine = new THREE.Line(
      bGeom,
      new THREE.LineBasicMaterial({ color: 0xf5c542, depthTest: true }),
    );

    // 拾取点：白色小球，略微沿法线抬出避免 z-fighting
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    dot.position.copy(point).addScaledVector(normal, 0.012);

    group.add(tLine, bLine, dot);
    group.userData.weight = weight;
    return group;
  }
}

/**
 * 方向场示意网格：在弯曲样板表面按规则网格画一组短小切线，
 * 用于直观确认直线纹/环形纹的全局分布。仅做显示，不参与材质。
 */
export function buildFieldArrows(
  geometry: THREE.BufferGeometry,
  grainCenter: THREE.Vector3,
  mode: GrainMode,
  angle: number,
): THREE.Group {
  const group = new THREE.Group();
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const config: GrainConfig = { mode, angle, center: grainCenter };
  const points: THREE.Vector3[] = [];
  const step = Math.max(6, Math.floor(pos.count / 220));

  for (let i = 0; i < pos.count; i += step) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i);
    const n = new THREE.Vector3().fromBufferAttribute(nor, i);
    const w = grainWeightAt(config, p, n);
    if (w < 0.05) continue; // 环心处不画，避免方向不定的乱线
    const t = grainTangentAt(config, p, n, new THREE.Vector3());
    const len = 0.09;
    points.push(p.clone().addScaledVector(n, 0.008).addScaledVector(t, -len));
    points.push(p.clone().addScaledVector(n, 0.008).addScaledVector(t, len));
  }

  const g = new THREE.BufferGeometry().setFromPoints(points);
  const lines = new THREE.LineSegments(
    g,
    new THREE.LineBasicMaterial({ color: 0x7df0e8, transparent: true, opacity: 0.55 }),
  );
  group.add(lines);
  return group;
}
