import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { Plane } from './reflectMath';

export const MIRROR_WIDTH = 4;
export const MIRROR_HEIGHT = 2.5;
const FRAME_T = 0.14;   // 镜框厚度（宽出镜面部分）
const FRAME_D = 0.12;   // 镜框进深（略凸出镜面，保证斜看时镜框能遮挡倒影边缘）

function makeLabelTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = fg;
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 镜子装配体：Reflector 反射面（正面，+Z 朝向）+ 镜框 + 封闭背板 + 正面标识。
 * 本地坐标系：镜面在 z=0 平面，法线 +Z，中心在原点。
 */
export class MirrorRig extends THREE.Group {
  readonly reflector: Reflector;
  private readonly placeholder: THREE.Mesh;
  private readonly normalArrow: THREE.ArrowHelper;
  private reflectionOn = true;

  constructor(textureWidth: number, textureHeight: number) {
    super();

    // 反射面（成熟组件：three 官方 Reflector，内置斜近裁剪面，镜后几何不会进入倒影）
    this.reflector = new Reflector(new THREE.PlaneGeometry(MIRROR_WIDTH, MIRROR_HEIGHT), {
      clipBias: 0.003,
      textureWidth,
      textureHeight,
      color: 0xcfd8dc,
    });
    this.add(this.reflector);

    // 反射关闭时的替代面板（对照用）
    this.placeholder = new THREE.Mesh(
      new THREE.PlaneGeometry(MIRROR_WIDTH, MIRROR_HEIGHT),
      new THREE.MeshStandardMaterial({ color: 0x8a939c, roughness: 0.85, metalness: 0.05 })
    );
    this.placeholder.visible = false;
    this.add(this.placeholder);

    // 镜框（四条边，前后均凸出镜面）
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x39424d, roughness: 0.55, metalness: 0.3 });
    const addFrame = (w: number, h: number, x: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, FRAME_D), frameMat);
      m.position.set(x, y, 0);
      this.add(m);
    };
    addFrame(MIRROR_WIDTH + 2 * FRAME_T, FRAME_T, 0, MIRROR_HEIGHT / 2 + FRAME_T / 2);
    addFrame(MIRROR_WIDTH + 2 * FRAME_T, FRAME_T, 0, -MIRROR_HEIGHT / 2 - FRAME_T / 2);
    addFrame(FRAME_T, MIRROR_HEIGHT, -MIRROR_WIDTH / 2 - FRAME_T / 2, 0);
    addFrame(FRAME_T, MIRROR_HEIGHT, MIRROR_WIDTH / 2 + FRAME_T / 2, 0);

    // 封闭背板（从背面看镜子时显示）
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(MIRROR_WIDTH + 2 * FRAME_T, MIRROR_HEIGHT + 2 * FRAME_T, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x4a3b2c, roughness: 0.9 })
    );
    back.position.z = -(FRAME_D / 2 + 0.025);
    this.add(back);
    const backLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 0.55),
      new THREE.MeshBasicMaterial({ map: makeLabelTexture('BACK · 背板', '#4a3b2c', '#d8c9a8') })
    );
    backLabel.position.set(0, 0, -(FRAME_D / 2 + 0.051));
    backLabel.rotation.y = Math.PI;
    this.add(backLabel);

    // 正面标识（镜框上沿）
    const frontLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.4),
      new THREE.MeshBasicMaterial({ map: makeLabelTexture('FRONT · 正面', '#39424d', '#ffe08a') })
    );
    frontLabel.position.set(0, MIRROR_HEIGHT / 2 + FRAME_T / 2, FRAME_D / 2 + 0.001);
    this.add(frontLabel);

    // 法线箭头（辅助线，放在 layer 1：主相机可见，反射相机不可见，不会进入镜中）
    this.normalArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0.01), 1.4, 0xffd54f, 0.22, 0.12
    );
    this.normalArrow.traverse((o) => o.layers.set(1));
    this.add(this.normalArrow);

    // 底边贴地
    this.position.y = MIRROR_HEIGHT / 2 + FRAME_T;
  }

  /** 设置镜子位姿：地面平移 (x, z) + 绕竖轴旋转（度） */
  setPose(x: number, z: number, rotYDeg: number): void {
    this.position.set(x, MIRROR_HEIGHT / 2 + FRAME_T, z);
    this.rotation.y = THREE.MathUtils.degToRad(rotYDeg);
  }

  /** 当前镜面（世界坐标） */
  getPlane(): Plane {
    return {
      point: this.reflector.getWorldPosition(new THREE.Vector3()),
      normal: new THREE.Vector3(0, 0, 1).applyQuaternion(this.getWorldQuaternion(new THREE.Quaternion())).normalize(),
    };
  }

  setReflectionEnabled(on: boolean): void {
    this.reflectionOn = on;
    this.reflector.visible = on;
    this.placeholder.visible = !on;
  }

  isReflectionEnabled(): boolean {
    return this.reflectionOn;
  }

  /** 窗口尺寸变化后同步反射渲染目标分辨率，避免镜内图像被拉伸 */
  setTextureSize(w: number, h: number): void {
    const rt = (this.reflector as unknown as { getRenderTarget?: () => THREE.WebGLRenderTarget }).getRenderTarget?.();
    rt?.setSize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  }
}
