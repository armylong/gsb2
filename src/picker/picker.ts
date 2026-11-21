import * as THREE from 'three';
import { FogParams, boxMinMax, densityAt, hgPhase, opticalDepth, rayBox } from '../fog/fog';

export interface PickResult {
  objectName: string;
  surfaceDistance: number;
  rayHitsBox: boolean;
  enterDistance: number;
  leaveDistance: number;
  participatedLength: number;
  opticalThickness: number;
  transmittance: number;
  densityEnter: number;
  densityLeave: number;
  point: THREE.Vector3;
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();
const _enterPoint = new THREE.Vector3();
const _leavePoint = new THREE.Vector3();

/**
 * 画面点选：
 * - 用 Raycaster 找最近物体表面（空处打到后墙/远平面）
 * - 用与 shader 相同的 slab 求交 + 解析积分，读出进入/离开距离与实际参与长度
 * - 场景里画进入点(绿)、离开/表面截断点(红)，以及雾内射线(黄)
 */
export class Picker {
  private readonly markerGroup = new THREE.Group();
  private enterMarker: THREE.Mesh;
  private leaveMarker: THREE.Mesh;
  private segmentLine: THREE.Line;
  private lastResult: PickResult | null = null;

  constructor(private readonly scene: THREE.Scene) {
    const sphereGeo = new THREE.SphereGeometry(0.09, 16, 12);
    this.enterMarker = new THREE.Mesh(
      sphereGeo,
      new THREE.MeshBasicMaterial({ color: 0x45e08a, depthTest: false }),
    );
    this.leaveMarker = new THREE.Mesh(
      sphereGeo.clone(),
      new THREE.MeshBasicMaterial({ color: 0xff5d5d, depthTest: false }),
    );
    this.enterMarker.renderOrder = 999;
    this.leaveMarker.renderOrder = 999;
    this.enterMarker.visible = false;
    this.leaveMarker.visible = false;

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.segmentLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0xffd24a, depthTest: false }),
    );
    this.segmentLine.renderOrder = 998;
    this.segmentLine.visible = false;

    this.markerGroup.add(this.segmentLine, this.enterMarker, this.leaveMarker);
    this.markerGroup.name = 'pick-markers';
    scene.add(this.markerGroup);
  }

  get result(): PickResult | null {
    return this.lastResult;
  }

  /**
   * @param clientX 鼠标在 canvas 内的 CSS 像素坐标
   */
  pick(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.PerspectiveCamera,
    pickables: THREE.Object3D[],
    params: FogParams,
    farPlane: number,
  ): PickResult {
    _ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    _ray.setFromCamera(_ndc, camera);

    // 最近物体表面
    const hits = _ray.intersectObjects(pickables, false);
    const surface = hits.length > 0 ? hits[0] : null;
    const surfaceDistance = surface?.distance ?? farPlane;
    const objectName = surface?.object.name ?? '空背景（远平面）';
    const point = surface?.point.clone() ?? _ray.ray.origin.clone().addScaledVector(_ray.ray.direction, farPlane);

    boxMinMax(params, _min, _max);
    const boxHit = rayBox(_ray.ray.origin, _ray.ray.direction, _min, _max);

    let result: PickResult;
    if (!boxHit.hit) {
      result = {
        objectName,
        surfaceDistance,
        rayHitsBox: false,
        enterDistance: 0,
        leaveDistance: 0,
        participatedLength: 0,
        opticalThickness: 0,
        transmittance: 1,
        densityEnter: 0,
        densityLeave: 0,
        point,
      };
    } else {
      const tEnter = boxHit.enter;
      const tLeave = Math.min(boxHit.leave, surfaceDistance);
      const participated = Math.max(0, tLeave - tEnter);
      const tau =
        participated > 0
          ? opticalDepth(
              _ray.ray.origin,
              _ray.ray.direction,
              tEnter,
              tLeave,
              _min,
              params.density,
              params.falloff,
            )
          : 0;
      _enterPoint.copy(_ray.ray.origin).addScaledVector(_ray.ray.direction, tEnter);
      _leavePoint.copy(_ray.ray.origin).addScaledVector(_ray.ray.direction, tLeave);
      result = {
        objectName,
        surfaceDistance,
        rayHitsBox: true,
        enterDistance: tEnter,
        leaveDistance: boxHit.leave,
        participatedLength: participated,
        opticalThickness: tau,
        transmittance: Math.exp(-tau),
        densityEnter: densityAt(_enterPoint, _min, params.density, params.falloff),
        densityLeave: densityAt(_leavePoint, _min, params.density, params.falloff),
        point,
      };
    }

    this.lastResult = result;
    this.updateMarkers(result);
    return result;
  }

  /** 参数（密度/雾盒）变化后按上次点选位置重算，marker 与读数保持新鲜 */
  refresh(
    camera: THREE.PerspectiveCamera,
    pickables: THREE.Object3D[],
    params: FogParams,
    farPlane: number,
    rect: DOMRect,
    lastClient: { x: number; y: number } | null,
  ): PickResult | null {
    if (!lastClient) return this.lastResult;
    return this.pick(lastClient.x, lastClient.y, rect, camera, pickables, params, farPlane);
  }

  private updateMarkers(result: PickResult): void {
    if (!result.rayHitsBox || result.participatedLength <= 1e-4) {
      this.enterMarker.visible = false;
      this.leaveMarker.visible = false;
      this.segmentLine.visible = false;
      return;
    }
    this.enterMarker.visible = true;
    this.leaveMarker.visible = true;
    this.segmentLine.visible = true;
    this.enterMarker.position.copy(_enterPoint);
    this.leaveMarker.position.copy(_leavePoint);
    const pos = this.segmentLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, _enterPoint.x, _enterPoint.y, _enterPoint.z);
    pos.setXYZ(1, _leavePoint.x, _leavePoint.y, _leavePoint.z);
    pos.needsUpdate = true;
  }

  /** 供「方向对照」读数：当前视线与平行光的夹角及相位值 */
  static sunPhase(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, g: number): { angle: number; phase: number } {
    const viewDir = new THREE.Vector3();
    camera.getWorldDirection(viewDir);
    const cos = THREE.MathUtils.clamp(viewDir.dot(sunDir), -1, 1);
    return { angle: THREE.MathUtils.radToDeg(Math.acos(cos)), phase: hgPhase(cos, g) };
  }

  dispose(): void {
    this.scene.remove(this.markerGroup);
  }
}
