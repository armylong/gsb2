import * as THREE from 'three';
import type { ProjectorParams } from './decalMath';

/**
 * 投射体与朝向辅助线:近端矩形(绿)、远端矩形(红)、四条棱(黄)、
 * 主轴方向线 + 箭头(青)。全部位于 layer 1,不进入贴花深度通道。
 */
export class ProjectorHelper extends THREE.Group {
  private lines: THREE.LineSegments;
  private axis: THREE.ArrowHelper;

  constructor() {
    super();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Array(8 * 2 * 3).fill(0), 3));
    const colors: number[] = [];
    const push = (c: THREE.Color, n: number) => {
      for (let i = 0; i < n; i++) colors.push(c.r, c.g, c.b);
    };
    // 线段顺序:近端矩形 4、远端矩形 4、棱 4(见 update)
    push(new THREE.Color(0x53d769), 4 * 2);
    push(new THREE.Color(0xe05555), 4 * 2);
    push(new THREE.Color(0xf0c040), 4 * 2);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true }),
    );
    this.lines.frustumCulled = false;
    this.add(this.lines);

    this.axis = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 0, 0),
      1,
      0x35c4d0,
      0.25,
      0.12,
    );
    this.add(this.axis);
    this.traverse((o) => o.layers.set(1));
  }

  update(p: ProjectorParams): void {
    this.position.fromArray(p.position);
    // 相机惯例:-Z 指向目标(Object3D.lookAt 是 +Z 指向目标,不能直接用来画视锥)
    const rot = new THREE.Matrix4().lookAt(
      new THREE.Vector3().fromArray(p.position),
      new THREE.Vector3().fromArray(p.lookAt),
      new THREE.Vector3(0, 1, 0),
    );
    this.quaternion.setFromRotationMatrix(rot);

    const tanH = Math.tan(THREE.MathUtils.degToRad(p.fovDeg) / 2);
    const hn = tanH * p.near;
    const hf = tanH * p.far;
    const rect = (h: number, z: number) => [
      [-h, -h, z], [h, -h, z],
      [h, -h, z], [h, h, z],
      [h, h, z], [-h, h, z],
      [-h, h, z], [-h, -h, z],
    ];
    const corners = (h: number, z: number) => [
      [-h, -h, z], [h, -h, z], [h, h, z], [-h, h, z],
    ];
    const pts: number[][] = [
      ...rect(hn, -p.near),
      ...rect(hf, -p.far),
    ];
    const cn = corners(hn, -p.near);
    const cf = corners(hf, -p.far);
    for (let i = 0; i < 4; i++) pts.push(cn[i], cf[i]);

    const attr = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    pts.forEach((pt, i) => attr.setXYZ(i, pt[0], pt[1], pt[2]));
    attr.needsUpdate = true;
    this.lines.geometry.computeBoundingSphere();

    const axisLen = p.far * 1.05;
    this.axis.setLength(axisLen, axisLen * 0.06 + 0.1, axisLen * 0.03 + 0.05);
  }
}
