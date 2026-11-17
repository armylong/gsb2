import * as THREE from 'three';
import { makeBackTexture, makeClosedTexture, makeLabelSprite } from './textures';

export const PORTAL_WIDTH = 2.2;
export const PORTAL_HEIGHT = 3.2;

/** 门户局部系绕 Y 轴翻转 180°：从 src 口进入等价于从 dst 口正向走出 */
const FLIP = new THREE.Matrix4().makeRotationY(Math.PI);

export class Portal {
  readonly group = new THREE.Group();
  readonly width = PORTAL_WIDTH;
  readonly height = PORTAL_HEIGHT;
  /** 正面可视面：屏幕空间采样本门户的渲染目标 */
  readonly viewMesh: THREE.Mesh;
  /** 封闭面：在另一端画面里看到的本门户（单层可见，不递归） */
  readonly closedMesh: THREE.Mesh;
  /** 背面实心板：不可通行 */
  readonly backMesh: THREE.Mesh;
  readonly renderTarget: THREE.WebGLRenderTarget;
  /** 映射相机：主相机经本门户对映射后的位姿 */
  readonly virtualCamera: THREE.PerspectiveCamera;

  constructor(readonly label: string, frameColor: number, rtW: number, rtH: number) {
    this.renderTarget = new THREE.WebGLRenderTarget(rtW, rtH, { samples: 4 });
    // RT 直接存 sRGB，主画面 ShaderMaterial 原样输出，色彩与主场景一致
    this.renderTarget.texture.colorSpace = THREE.SRGBColorSpace;
    this.virtualCamera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);

    // 开口平面：局部原点在底边中心，正面朝 +Z
    const geo = new THREE.PlaneGeometry(this.width, this.height);
    geo.translate(0, this.height / 2, 0);

    const viewMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.renderTarget.texture } },
      vertexShader: /* glsl */ `
        varying vec4 vClip;
        void main() {
          vClip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = vClip;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec4 vClip;
        void main() {
          // 屏幕空间 UV：门内图像严格限制在矩形光栅化范围内，斜看也不越界
          vec2 uv = (vClip.xy / vClip.w) * 0.5 + 0.5;
          gl_FragColor = texture2D(map, uv);
        }
      `,
    });
    this.viewMesh = new THREE.Mesh(geo, viewMat);

    this.closedMesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ map: makeClosedTexture(this.label) }),
    );
    this.closedMesh.visible = false;

    this.backMesh = new THREE.Mesh(
      geo.clone(),
      new THREE.MeshBasicMaterial({ map: makeBackTexture(this.label) }),
    );
    this.backMesh.rotation.y = Math.PI;
    this.backMesh.position.z = -0.02;

    const frame = buildFrame(this.width, this.height, frameColor);
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, this.height + 0.3, 0),
      0.8, frameColor, 0.28, 0.16,
    );
    const tag = makeLabelSprite(`门户${this.label} · 正面`, '#ffffff');
    tag.position.set(0, this.height + 1.0, 0);

    this.group.add(this.viewMesh, this.closedMesh, this.backMesh, frame, arrow, tag);
  }

  setPose(x: number, z: number, rotYDeg: number): void {
    this.group.position.set(x, 0, z);
    this.group.rotation.set(0, THREE.MathUtils.degToRad(rotYDeg), 0);
    this.group.updateMatrixWorld(true);
  }

  get pose(): { x: number; z: number; ry: number } {
    return {
      x: this.group.position.x,
      z: this.group.position.z,
      ry: THREE.MathUtils.radToDeg(this.group.rotation.y),
    };
  }

  frontNormalWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.group.quaternion);
  }

  resize(w: number, h: number): void {
    this.renderTarget.setSize(w, h);
  }
}

function buildFrame(w: number, h: number, color: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.4, metalness: 0.1, emissive: color, emissiveIntensity: 0.25,
  });
  const t = 0.12;
  const d = 0.24;
  const sideGeo = new THREE.BoxGeometry(t, h + t, d);
  const left = new THREE.Mesh(sideGeo, mat);
  left.position.set(-(w / 2 + t / 2), h / 2, 0);
  const right = new THREE.Mesh(sideGeo, mat);
  right.position.set(w / 2 + t / 2, h / 2, 0);
  const top = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * t, t, d), mat);
  top.position.set(0, h + t / 2, 0);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * t, 0.05, d + 0.35), mat);
  sill.position.set(0, 0.025, 0);
  g.add(left, right, top, sill);
  return g;
}

/**
 * 门户对映射矩阵：世界系下一点/相机经 src 口映射到 dst 口外。
 * M = dstWorld · RotY(π) · srcWorld⁻¹
 */
export function portalTransform(src: Portal, dst: Portal, out: THREE.Matrix4): THREE.Matrix4 {
  _inv.copy(src.group.matrixWorld).invert();
  return out.copy(dst.group.matrixWorld).multiply(FLIP).multiply(_inv);
}

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _scl = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _plane = new THREE.Plane();

/**
 * 用映射相机把「从 dst 口向外看」的画面渲染进 src 的纹理。
 * - 映射相机位姿 = M · 主相机，随主相机和门户位姿逐帧更新；
 * - 斜投影近裁剪面贴在 dst 开口平面上，dst 出口背后的物体不会挡进门内视野；
 * - 本门户(src)在画面里显示为封闭面，dst 的开口面隐藏（单层可见，不递归）。
 */
export function updatePortalTexture(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  mainCamera: THREE.PerspectiveCamera,
  src: Portal,
  dst: Portal,
): void {
  const vcam = src.virtualCamera;
  vcam.fov = mainCamera.fov;
  vcam.aspect = mainCamera.aspect;
  vcam.near = 0.05;
  vcam.far = mainCamera.far;

  portalTransform(src, dst, _m);
  _m.multiply(mainCamera.matrixWorld);
  _m.decompose(vcam.position, vcam.quaternion, _scl);
  vcam.updateMatrixWorld(true);
  vcam.updateProjectionMatrix();

  // 斜投影：把 dst 开口平面变成映射相机的近裁剪面（Lengyel oblique projection）
  dst.frontNormalWorld(_n);
  dst.group.getWorldPosition(_p);
  _plane.setFromNormalAndCoplanarPoint(_n, _p);
  _plane.applyMatrix4(vcam.matrixWorldInverse);
  if (_plane.constant < 0) {
    _plane.normal.negate();
    _plane.constant = -_plane.constant;
  }
  if (_plane.constant > 1e-4) {
    applyObliqueNearPlane(vcam.projectionMatrix, _plane);
    vcam.projectionMatrixInverse.copy(vcam.projectionMatrix).invert();
  }

  // 可见性切换：dst 的开口面/背面板隐藏，src 显示封闭面
  src.viewMesh.visible = false;
  src.closedMesh.visible = true;
  dst.viewMesh.visible = false;
  dst.backMesh.visible = false;

  renderer.setRenderTarget(src.renderTarget);
  renderer.render(scene, vcam);
  renderer.setRenderTarget(null);

  src.viewMesh.visible = true;
  src.closedMesh.visible = false;
  dst.viewMesh.visible = true;
  dst.backMesh.visible = true;
}

/** Lengyel 斜近裁剪面：修改投影矩阵使近裁剪面与给定相机空间平面重合 */
function applyObliqueNearPlane(proj: THREE.Matrix4, plane: THREE.Plane): void {
  const e = proj.elements;
  const qx = (Math.sign(plane.normal.x) + e[8]) / e[0];
  const qy = (Math.sign(plane.normal.y) + e[9]) / e[5];
  const qz = -1;
  const qw = (1 + e[10]) / e[14];
  const cx = plane.normal.x;
  const cy = plane.normal.y;
  const cz = plane.normal.z;
  const cw = plane.constant;
  const s = 2 / (cx * qx + cy * qy + cz * qz + cw * qw);
  e[2] = cx * s;
  e[6] = cy * s;
  e[10] = cz * s + 1;
  e[14] = cw * s;
}
