import * as THREE from 'three';
import {
  DEPTH_BIAS,
  decalNormalMatrix,
  frozenDecalMatrix,
  projectionMatrix,
  projectorWorldMatrix,
  relativePose,
  snapshotTransform,
  type ProjectorParams,
  type TransformSnapshot,
} from './decalMath';
import type { TargetType } from './targets';
import { TARGET_LABELS } from './targets';

/** 一次已确认投射的完整记录(信息面板与现场导出都从这里取数)。 */
export interface ConfirmedDecal {
  targetType: TargetType;
  decalColor: string;
  projector: ProjectorParams;
  targetTransform: TransformSnapshot; // 确认时刻的目标变换
  // 运行时冻结量(不导出,可由 参数重算):
  relPose: THREE.Matrix4;
  decalMat: THREE.Matrix4;
  normalMat: THREE.Matrix3;
}

const DEPTH_SIZE = 1024;

function makeDepthRT(): THREE.WebGLRenderTarget {
  const depthTexture = new THREE.DepthTexture(DEPTH_SIZE, DEPTH_SIZE);
  const rt = new THREE.WebGLRenderTarget(DEPTH_SIZE, DEPTH_SIZE, {
    depthTexture,
    depthBuffer: true,
  });
  return rt;
}

/**
 * 贴花系统:把「预览(当前投影机参数)」与「已确认(冻结矩阵)」两个投射槽
 * 注入目标材质的片元着色器,并维护各自的投影机深度通道。
 *
 * 判定链(与 src/decalMath.ts 的纯函数一一对应):
 *   w<=0 丢弃(投影机后方) -> NDC xy∈[0,1](侧边裁切) -> 深度∈[0,1](近远截断)
 *   -> 视图法线 z>0(背面拒绝) -> 深度图比较(首表面规则,可开关)
 */
export class DecalSystem {
  readonly uniforms: Record<string, THREE.IUniform>;
  confirmed: ConfirmedDecal | null = null;

  private previewRT = makeDepthRT();
  private confirmRT = makeDepthRT();
  private previewCam = new THREE.PerspectiveCamera();
  private confirmCam = new THREE.PerspectiveCamera();
  private depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

  constructor(decalMap: THREE.Texture) {
    this.uniforms = {
      uDecalMap: { value: decalMap },
      uPrevColor: { value: new THREE.Color('#ff8c2a') },
      uConfColor: { value: new THREE.Color('#ff8c2a') },
      uFirstSurfaceOnly: { value: 1 },
      uDepthBias: { value: DEPTH_BIAS },
      uPrevMat: { value: new THREE.Matrix4() },
      uPrevNMat: { value: new THREE.Matrix3() },
      uPrevDepth: { value: this.previewRT.depthTexture },
      uPrevOn: { value: 1 },
      uConfMat: { value: new THREE.Matrix4() },
      uConfNMat: { value: new THREE.Matrix3() },
      uConfDepth: { value: this.confirmRT.depthTexture },
      uConfOn: { value: 0 },
      uDebugMode: { value: 0 }, // 0 正常;1 跳过深度比较;2 显示深度图;3 显示片元深度
    };
    // 两台深度相机的矩阵完全由代码驱动,不让 three 用 position/quaternion 重算
    this.previewCam.matrixAutoUpdate = false;
    this.previewCam.matrixWorldAutoUpdate = false;
    this.confirmCam.matrixAutoUpdate = false;
    this.confirmCam.matrixWorldAutoUpdate = false;
  }

  /** 注入目标材质。所有目标共用同一份 uniforms,程序缓存键固定。 */
  inject(material: THREE.MeshStandardMaterial): void {
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vDecalPos;\nvarying vec3 vDecalNormal;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvDecalPos = position;\nvDecalNormal = normal;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uDecalMap;
uniform vec3 uPrevColor;
uniform vec3 uConfColor;
uniform float uFirstSurfaceOnly;
uniform float uDepthBias;
uniform mat4 uPrevMat; uniform mat3 uPrevNMat; uniform sampler2D uPrevDepth; uniform float uPrevOn;
uniform mat4 uConfMat; uniform mat3 uConfNMat; uniform sampler2D uConfDepth; uniform float uConfOn;
uniform float uDebugMode;
varying vec3 vDecalPos;
varying vec3 vDecalNormal;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  // 槽 1:实时预览(当前投影机参数)
  if (uPrevOn > 0.5) {
    vec4 clip = uPrevMat * vec4(vDecalPos, 1.0);
    if (clip.w > 0.0) {
      vec3 ndc = clip.xyz / clip.w;
      vec2 uv = ndc.xy * 0.5 + 0.5;
      float depth01 = ndc.z * 0.5 + 0.5;
      vec3 vn = normalize(uPrevNMat * vDecalNormal);
      if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))
          && depth01 >= 0.0 && depth01 <= 1.0 && vn.z > 0.0) {
        if (uDebugMode > 1.5) {
          float stored = texture2D(uPrevDepth, uv).r;
          diffuseColor.rgb = uDebugMode > 2.5 ? vec3(depth01) : vec3(stored);
        } else {
        bool pass = true;
        if (uFirstSurfaceOnly > 0.5 && uDebugMode < 0.5) {
          float stored = texture2D(uPrevDepth, uv).r;
          if (depth01 > stored + uDepthBias) pass = false;
        }
        if (pass) {
          vec4 tex = texture2D(uDecalMap, uv);
          diffuseColor.rgb = mix(diffuseColor.rgb, uPrevColor, tex.a * 0.85);
        }
        }
      }
    }
  }
  // 槽 2:已确认投射(冻结矩阵,贴花随目标)
  if (uConfOn > 0.5) {
    vec4 clip = uConfMat * vec4(vDecalPos, 1.0);
    if (clip.w > 0.0) {
      vec3 ndc = clip.xyz / clip.w;
      vec2 uv = ndc.xy * 0.5 + 0.5;
      float depth01 = ndc.z * 0.5 + 0.5;
      vec3 vn = normalize(uConfNMat * vDecalNormal);
      if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))
          && depth01 >= 0.0 && depth01 <= 1.0 && vn.z > 0.0) {
        bool pass = true;
        if (uFirstSurfaceOnly > 0.5) {
          float stored = texture2D(uConfDepth, uv).r;
          if (depth01 > stored + uDepthBias) pass = false;
        }
        if (pass) {
          vec4 tex = texture2D(uDecalMap, uv);
          diffuseColor.rgb = mix(diffuseColor.rgb, uConfColor, tex.a);
        }
      }
    }
  }
}`,
        );
    };
    material.customProgramCacheKey = () => 'decal-target-v1';
  }

  /**
   * 每帧调用:更新预览矩阵、已确认槽的随动相机,并渲染两条深度通道。
   * @param target 当前目标网格(其 matrixWorld 必须已是最新)
   */
  update(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    target: THREE.Object3D,
    projector: ProjectorParams,
  ): void {
    // --- 预览槽:投影机当前参数 ---
    const proj = projectionMatrix(projector);
    const world = projectorWorldMatrix(projector);
    this.previewCam.projectionMatrix.copy(proj);
    this.previewCam.projectionMatrixInverse.copy(proj).invert();
    this.previewCam.matrixWorld.copy(world);
    this.previewCam.matrixWorldInverse.copy(world).invert();

    (this.uniforms.uPrevMat.value as THREE.Matrix4)
      .copy(proj).multiply(this.previewCam.matrixWorldInverse).multiply(target.matrixWorld);
    const vm = new THREE.Matrix4()
      .copy(this.previewCam.matrixWorldInverse).multiply(target.matrixWorld);
    (this.uniforms.uPrevNMat.value as THREE.Matrix3)
      .setFromMatrix4(vm.invert().transpose());

    // --- 已确认槽:虚拟投影机随目标刚体随动(含非均匀缩放的剪切) ---
    if (this.confirmed) {
      const c = this.confirmed;
      this.confirmCam.matrixWorld.copy(target.matrixWorld).multiply(c.relPose);
      this.confirmCam.matrixWorldInverse.copy(this.confirmCam.matrixWorld).invert();
      this.confirmCam.projectionMatrix.copy(
        projectionMatrix(c.projector),
      );
      this.confirmCam.projectionMatrixInverse
        .copy(this.confirmCam.projectionMatrix).invert();
      (this.uniforms.uConfMat.value as THREE.Matrix4).copy(c.decalMat);
      (this.uniforms.uConfNMat.value as THREE.Matrix3).copy(c.normalMat);
    }

    // --- 深度通道(仅 layer 0,即目标本体;辅助线在 layer 1) ---
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.depthMaterial;
    const prevTarget = renderer.getRenderTarget();

    renderer.setRenderTarget(this.previewRT);
    renderer.render(scene, this.previewCam);
    if (this.confirmed) {
      renderer.setRenderTarget(this.confirmRT);
      renderer.render(scene, this.confirmCam);
    }

    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
  }

  /** 确认投射:冻结矩阵,贴花从此固定在目标上。 */
  confirm(target: THREE.Object3D, targetType: TargetType, projector: ProjectorParams, color: string): void {
    const model = target.matrixWorld.clone();
    this.confirmed = {
      targetType,
      decalColor: color,
      projector: structuredClone(projector),
      targetTransform: snapshotTransform(target),
      relPose: relativePose(projector, model),
      decalMat: frozenDecalMatrix(projector, model),
      normalMat: decalNormalMatrix(projector, model),
    };
    (this.uniforms.uConfColor.value as THREE.Color).set(color);
    this.uniforms.uConfOn.value = 1;
  }

  /** 从现场记录恢复已确认投射(由记录参数重算冻结矩阵)。 */
  restoreConfirmed(record: {
    targetType: TargetType;
    decalColor: string;
    projector: ProjectorParams;
    targetTransform: TransformSnapshot;
  }): void {
    const model = (function () {
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(...record.targetTransform.rotationEuler, 'XYZ'),
      );
      return new THREE.Matrix4().compose(
        new THREE.Vector3(...record.targetTransform.position),
        q,
        new THREE.Vector3(...record.targetTransform.scale),
      );
    })();
    this.confirmed = {
      targetType: record.targetType,
      decalColor: record.decalColor,
      projector: structuredClone(record.projector),
      targetTransform: structuredClone(record.targetTransform),
      relPose: relativePose(record.projector, model),
      decalMat: frozenDecalMatrix(record.projector, model),
      normalMat: decalNormalMatrix(record.projector, model),
    };
    (this.uniforms.uConfColor.value as THREE.Color).set(record.decalColor);
    this.uniforms.uConfOn.value = 1;
  }

  clear(): void {
    this.confirmed = null;
    this.uniforms.uConfOn.value = 0;
  }

  /** 信息面板文本。 */
  confirmedInfo(): string {
    const c = this.confirmed;
    if (!c) return '(尚无已确认的投射)';
    const f = (n: number) => n.toFixed(3);
    const v = (a: readonly number[]) => `(${a.map(f).join(', ')})`;
    return [
      `目标: ${TARGET_LABELS[c.targetType]}`,
      `贴花颜色: ${c.decalColor}`,
      `确认时投影器:`,
      `  位置 ${v(c.projector.position)}  朝向点 ${v(c.projector.lookAt)}`,
      `  张角 ${c.projector.fovDeg}°  近端 ${c.projector.near}  远端 ${c.projector.far}`,
      `确认时目标变换:`,
      `  位置 ${v(c.targetTransform.position)}`,
      `  旋转 ${v(c.targetTransform.rotationEuler)} (rad)`,
      `  缩放 ${v(c.targetTransform.scale)}`,
    ].join('\n');
  }
}

