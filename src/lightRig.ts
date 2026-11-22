import * as THREE from 'three';
import { effectiveLuminance, MIN_LIGHT_SIDE, type ParamSet } from './params';

const LIGHT_COLOR = 0xfff2dd;
/** 灯板中心距任何表面的最小距离，防止擦碰、穿模与近裁剪闪烁 */
const MIN_CLEARANCE = 0.05;

/**
 * 长方形灯板装置。
 * RectAreaLight 沿局部 -Z 发光；网格包含发光面（-Z 侧）与不透光背面（+Z 侧），
 * 旋转到背面时发光面背离物体，照明随之消失。
 */
export class LightRig {
  readonly group = new THREE.Group();
  readonly light: THREE.RectAreaLight;
  private readonly frame: THREE.Mesh;
  private readonly front: THREE.Mesh;
  private readonly back: THREE.Mesh;
  private readonly frontMat: THREE.MeshBasicMaterial;
  private readonly backMat: THREE.MeshBasicMaterial;
  private w = 0;
  private h = 0;

  constructor() {
    this.light = new THREE.RectAreaLight(LIGHT_COLOR, 120, 0.8, 0.12);
    this.group.add(this.light);

    this.frontMat = new THREE.MeshBasicMaterial({ color: LIGHT_COLOR, side: THREE.FrontSide });
    this.backMat = new THREE.MeshBasicMaterial({
      color: 0x2a2d33,
      side: THREE.FrontSide,
    });
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x3c4048,
      metalness: 0.7,
      roughness: 0.4,
    });
    this.frame = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), frameMat);
    this.front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.frontMat);
    this.front.rotation.y = Math.PI; // 面向 -Z，与发光方向一致
    this.front.position.z = -0.007;
    this.back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.backMat);
    this.back.position.z = 0.007;
    this.group.add(this.frame, this.front, this.back);
  }

  /** 灯板发光面在世界空间的四条边（用于探针积分） */
  worldCorners(): THREE.Vector3[] {
    const corners = [
      new THREE.Vector3(-this.w / 2, -this.h / 2, 0),
      new THREE.Vector3(this.w / 2, -this.h / 2, 0),
      new THREE.Vector3(this.w / 2, this.h / 2, 0),
      new THREE.Vector3(-this.w / 2, this.h / 2, 0),
    ];
    this.group.updateWorldMatrix(true, false);
    return corners.map((c) => c.applyMatrix4(this.group.matrixWorld));
  }

  apply(p: ParamSet): void {
    const w = Math.max(p.width, MIN_LIGHT_SIDE);
    const h = Math.max(p.height, MIN_LIGHT_SIDE);
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.light.width = w;
      this.light.height = h;
      this.frame.geometry.dispose();
      this.frame.geometry = new THREE.BoxGeometry(w + 0.02, h + 0.02, 0.014);
      [this.front, this.back].forEach((m) => {
        m.geometry.dispose();
        m.geometry = new THREE.PlaneGeometry(w, h);
      });
    }

    const lum = effectiveLuminance(p);
    this.light.intensity = lum; // nits (cd/m^2)
    // 发光面可视化亮度跟随设定，但不参与场景照明
    this.frontMat.color.set(LIGHT_COLOR).multiplyScalar(Math.min(2.5, 0.4 + lum / 100));

    this.group.position.set(
      p.position[0],
      Math.max(p.position[1], MIN_CLEARANCE),
      p.position[2],
    );
    this.group.rotation.set(
      THREE.MathUtils.degToRad(p.rotationDeg[0]),
      THREE.MathUtils.degToRad(p.rotationDeg[1]),
      THREE.MathUtils.degToRad(p.rotationDeg[2]),
    );
    this.group.updateMatrixWorld(true);
  }

  /** gizmo 拖动后把世界变换写回参数（含安全高度钳制） */
  writeBack(p: ParamSet): void {
    p.position = [this.group.position.x, Math.max(this.group.position.y, MIN_CLEARANCE), this.group.position.z];
    this.group.position.y = Math.max(this.group.position.y, MIN_CLEARANCE);
    p.rotationDeg = [
      THREE.MathUtils.radToDeg(this.group.rotation.x),
      THREE.MathUtils.radToDeg(this.group.rotation.y),
      THREE.MathUtils.radToDeg(this.group.rotation.z),
    ];
  }
}

/** 点光源参照：物理强度 candela，decay=2 平方反比衰减 */
export class PointRig {
  readonly light: THREE.PointLight;
  private readonly marker: THREE.Mesh;

  constructor() {
    this.light = new THREE.PointLight(0x9ecbff, 25, 0, 2);
    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x9ecbff }),
    );
    this.light.add(this.marker);
  }

  apply(p: ParamSet): void {
    this.light.visible = p.pointOn;
    this.light.intensity = p.pointIntensity;
    this.light.position.set(...p.pointPosition);
  }
}
