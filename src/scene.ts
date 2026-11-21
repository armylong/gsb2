import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BuiltMeshes, PartMesh } from './meshBuilder';
import { targetFalloff } from './meshBuilder';
import type { MorphResult } from './morphEngine';
import type { PartId, TargetId, Weights } from './types';

const TARGET_IDS: TargetId[] = ['bulge', 'dent', 'pinch'];

const TARGET_TINT: Record<TargetId, THREE.Color> = {
  bulge: new THREE.Color(0xff5d5d),
  dent: new THREE.Color(0x4f8cff),
  pinch: new THREE.Color(0x35d07f),
};

export interface PickedVertex {
  part: PartId;
  vertex: number;
}

export class LabScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly wallMesh: THREE.Mesh;
  readonly lidMesh: THREE.Mesh;
  /** 斜照主光, 可从 UI 调方位 */
  readonly keyLight: THREE.DirectionalLight;
  private meshes: Record<PartId, THREE.Mesh>;
  private parts: Record<PartId, PartMesh>;
  private flipOverlay: THREE.Mesh;
  private pinGroup = new THREE.Group();
  private seamGroup = new THREE.Group();
  private lightHelper: THREE.DirectionalLightHelper;
  private influenceMode = false;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pinSprites = new Map<string, THREE.Object3D>();
  onPick?: (p: PickedVertex) => void;

  constructor(container: HTMLElement, built: BuiltMeshes) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x14171c);
    this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.05, 100);
    this.camera.position.set(2.6, 2.1, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.7, 0);

    // ---- 灯光: 一盏斜照主光 + 弱环境/半球补光 ----
    this.keyLight = new THREE.DirectionalLight(0xfff2dd, 2.4);
    this.setLightAzimuthElevation(35, 55);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    const s = 2.2;
    this.keyLight.shadow.camera.left = -s;
    this.keyLight.shadow.camera.right = s;
    this.keyLight.shadow.camera.top = s;
    this.keyLight.shadow.camera.bottom = -s;
    this.scene.add(this.keyLight);
    this.scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x2a2520, 0.55));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    this.lightHelper = new THREE.DirectionalLightHelper(this.keyLight, 0.4, 0xffe08a);
    this.lightHelper.visible = false;
    this.scene.add(this.lightHelper);

    // ---- 地面 ----
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(3, 64),
      new THREE.MeshStandardMaterial({ color: 0x20242b, roughness: 0.95, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.001;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // ---- 两个部件 ----
    const wallMat = this.makeMaterial(0xc9b48c);
    const lidMat = this.makeMaterial(0x9db8d8);
    this.wallMesh = new THREE.Mesh(built.wall.geometry, wallMat);
    this.lidMesh = new THREE.Mesh(built.lid.geometry, lidMat);
    this.wallMesh.castShadow = this.lidMesh.castShadow = true;
    this.wallMesh.receiveShadow = this.lidMesh.receiveShadow = true;
    this.meshes = { wall: this.wallMesh, lid: this.lidMesh };
    this.parts = { wall: built.wall, lid: built.lid };
    this.scene.add(this.wallMesh, this.lidMesh);

    // ---- 翻面覆盖层(非索引三角, 每帧同步位置) ----
    this.flipOverlay = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.flipOverlay.renderOrder = 2;
    this.scene.add(this.flipOverlay);

    this.scene.add(this.pinGroup, this.seamGroup);
    this.prepareInfluenceColors();

    // 点击拾取: 区分拖拽与点选
    let downX = 0;
    let downY = 0;
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
      this.handleClick(e);
    });

    window.addEventListener('resize', () => this.resize(container));
  }

  private makeMaterial(color: number): THREE.MeshStandardMaterial {
    // 双面: 内压翻转后仍可见, 配合翻面覆盖层检查
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
      flatShading: false,
      vertexColors: false,
    });
  }

  /** 斜光方位角/仰角(度) */
  setLightAzimuthElevation(azimuthDeg: number, elevationDeg: number) {
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const len = 4;
    this.keyLight.position.set(
      len * Math.cos(el) * Math.cos(az),
      len * Math.sin(el),
      len * Math.cos(el) * Math.sin(az),
    );
    this.lightHelper?.update();
  }

  setLightHelperVisible(v: boolean) {
    this.lightHelper.visible = v;
  }

  private resize(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** 预生成影响区顶点色(只依赖权重, 权重变化时刷新) */
  private prepareInfluenceColors() {
    for (const part of ['wall', 'lid'] as PartId[]) {
      const mesh = this.parts[part];
      const n = mesh.base.length / 3;
      const colors = new Float32Array(n * 3);
      mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
  }

  setInfluenceMode(on: boolean, weights: Weights) {
    this.influenceMode = on;
    for (const part of ['wall', 'lid'] as PartId[]) {
      const mat = this.meshes[part].material as THREE.MeshStandardMaterial;
      mat.vertexColors = on;
      // 切换 vertexColors 定义会改变 shader, 必须请求重编译否则热图不显示
      mat.needsUpdate = true;
    }
    if (on) this.updateInfluenceColors(weights);
  }

  /** 影响区热图: 颜色=参与目标的混合色, 亮度=加权作用强度; 多目标重叠处混色即共同影响区 */
  updateInfluenceColors(weights: Weights) {
    if (!this.influenceMode) return;
    for (const part of ['wall', 'lid'] as PartId[]) {
      const mesh = this.parts[part];
      const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const n = mesh.base.length / 3;
      const w = part === 'wall' ? weights.wall : weights.lid;
      for (let k = 0; k < n; k++) {
        const u = mesh.params[k * 2];
        const v = mesh.params[k * 2 + 1];
        // 无影响区保持中性亮灰, 受光时仍可看出曲面
        const blend = new THREE.Color(0.55, 0.56, 0.6);
        let energy = 0;
        for (const t of TARGET_IDS) {
          const f = targetFalloff(part, t, u, v) * Math.abs(w[t]);
          if (f <= 0) continue;
          blend.lerp(TARGET_TINT[t], Math.min(f, 1));
          energy += f;
        }
        // 影响越强越饱和明亮; 无影响顶点仍保留基础亮度
        const gain = 0.75 + Math.min(energy, 1.5) * 0.45;
        attr.setXYZ(
          k,
          Math.min(blend.r * gain, 1),
          Math.min(blend.g * gain, 1),
          Math.min(blend.b * gain, 1),
        );
      }
      attr.needsUpdate = true;
    }
  }

  /** 重建翻面覆盖层: 红=已翻转, 橙=濒临翻转 */
  updateFlipOverlay(result: MorphResult) {
    const geo = this.flipOverlay.geometry;
    // 空几何不设置任何 attribute, 避免触发 NaN 包围球警告
    const totalFaces = result.invertedFaces.wall.length + result.invertedFaces.lid.length
      + result.strainedFaces.wall.length + result.strainedFaces.lid.length;
    this.flipOverlay.visible = totalFaces > 0;
    if (totalFaces === 0) {
      this.clearOverlayAttributes(geo);
      return;
    }
    const positions: number[] = [];
    const colors: number[] = [];
    const red = new THREE.Color(0xff2d2d);
    const orange = new THREE.Color(0xffa51e);

    for (const part of ['wall', 'lid'] as PartId[]) {
      const mesh = this.parts[part];
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const index = mesh.geometry.getIndex()!;
      const mark = (face: number, c: THREE.Color) => {
        for (const off of [0, 1, 2]) {
          const vi = index.getX(face * 3 + off);
          positions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
          colors.push(c.r, c.g, c.b);
        }
      };
      result.strainedFaces[part].forEach((f) => mark(f, orange));
      result.invertedFaces[part].forEach((f) => mark(f, red));
    }
    this.clearOverlayAttributes(geo);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
  }

  private clearOverlayAttributes(geo: THREE.BufferGeometry) {
    if (geo.getAttribute('position')) geo.deleteAttribute('position');
    if (geo.getAttribute('color')) geo.deleteAttribute('color');
  }

  /** 接缝两侧对应点连线(闭合时), 用来肉眼核对对齐 */
  updateSeamMarkers(show: boolean, gap: number) {
    this.seamGroup.clear();
    this.seamGroup.visible = show;
    if (!show || gap < 0) return;
    const wallPos = this.parts.wall.geometry.attributes.position as THREE.BufferAttribute;
    const lidPos = this.parts.lid.geometry.attributes.position as THREE.BufferAttribute;
    const wallRing = this.parts.wall.ringSize;
    const lidRing = this.parts.lid.ringSize;
    const wallTop = wallPos.count - wallRing;
    const lidRim = lidPos.count - lidRing;
    for (let i = 0; i < wallRing; i += 4) {
      const a = new THREE.Vector3().fromBufferAttribute(wallPos, wallTop + i);
      const b = new THREE.Vector3().fromBufferAttribute(lidPos, lidRim + i);
      const lineGeo = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x00ffd0 }));
      this.seamGroup.add(line);
    }
  }

  /** 钉住的测点: 小球 + 编号 */
  syncPins(pins: PickedVertex[]) {
    this.pinGroup.clear();
    this.pinSprites.clear();
    pins.forEach((p, i) => {
      const mesh = this.parts[p.part];
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const v = new THREE.Vector3().fromBufferAttribute(pos, p.vertex);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 12, 12),
        new THREE.MeshBasicMaterial({ color: p.part === 'wall' ? 0xffd166 : 0x80e1ff }),
      );
      sphere.position.copy(v);
      sphere.userData = { pinIndex: i };
      this.pinGroup.add(sphere);
      this.pinSprites.set(`${p.part}:${p.vertex}`, sphere);
    });
  }

  /** 每帧跟随变形更新测点位置 */
  updatePinPositions(pins: PickedVertex[]) {
    pins.forEach((p, i) => {
      const obj = this.pinGroup.children[i];
      if (!obj) return;
      const mesh = this.parts[p.part];
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      obj.position.fromBufferAttribute(pos, p.vertex);
    });
  }

  private handleClick(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([this.wallMesh, this.lidMesh], false);
    if (hits.length === 0) return;
    const hit = hits[0];
    const part: PartId = hit.object === this.wallMesh ? 'wall' : 'lid';
    // 取距离命中面最近的顶点
    const mesh = this.parts[part];
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const index = mesh.geometry.getIndex()!;
    const face = hit.faceIndex!;
    let best = index.getX(face * 3);
    let bestD = Infinity;
    for (const off of [0, 1, 2]) {
      const vi = index.getX(face * 3 + off);
      const d = hit.point.distanceTo(new THREE.Vector3().fromBufferAttribute(pos, vi));
      if (d < bestD) {
        bestD = d;
        best = vi;
      }
    }
    this.onPick?.({ part, vertex: best });
  }

  render() {
    this.controls.update();
    this.lightHelper.update();
    this.renderer.render(this.scene, this.camera);
  }

  get domElement() {
    return this.renderer.domElement;
  }
}
