import * as THREE from 'three'
import type { CaptureResult } from './capture'

/**
 * 替身 = 每个捕获视图的纹素溅射点云(splat)。
 * 顶点着色器从 颜色+深度 重建道具本地坐标, 再随当前摆放变换到世界;
 * 每个 splat 写真实世界深度, 因此自遮挡、与柱子等场景物体的前后关系都正确。
 * 两个相邻视图各一片点云, 用逐点随机剔除做跨边界的连续混合。
 */

const VERT = /* glsl */ `
#include <packing>
attribute float rnd;
uniform sampler2D colorMap;
uniform sampler2D depthMap;
uniform mat4 capMatrix;
uniform float capNear;
uniform float capFar;
uniform float radius;
uniform float splatSize;    // 世界单位
uniform float pixelFactor;  // 屏幕像素系数
varying vec4 vColor;
varying float vRnd;
void main() {
  vRnd = rnd;
  vec2 uv = position.xy;
  vColor = texture2D(colorMap, uv);
  if (vColor.a < 0.5) {
    // 轮廓外纹素: 裁掉
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float z = unpackRGBAToDepth(texture2D(depthMap, uv));
  float viewZ = orthographicDepthToViewZ(z, capNear, capFar);
  vec3 pCam = vec3((uv.x * 2.0 - 1.0) * radius, (uv.y * 2.0 - 1.0) * radius, viewZ);
  vec3 local = (capMatrix * vec4(pCam, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = splatSize * pixelFactor / max(0.05, -mv.z);
}
`

const FRAG = /* glsl */ `
uniform float weight;
varying vec4 vColor;
varying float vRnd;
void main() {
  // 逐点随机剔除实现视图间连续交叉淡化(无透明排序问题, 深度照常写入)
  if (vRnd > weight) discard;
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  gl_FragColor = vec4(vColor.rgb, 1.0);
}
`

export class SplatImpostor extends THREE.Group {
  private matA: THREE.ShaderMaterial
  private matB: THREE.ShaderMaterial
  private ptsA: THREE.Points
  private ptsB: THREE.Points
  private baseSize: number

  constructor(private cap: CaptureResult, splatFill = 1.5) {
    super()
    const n = cap.res
    const pos = new Float32Array(n * n * 3)
    const rnd = new Float32Array(n * n)
    let k = 0
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        pos[k * 3] = (x + 0.5) / n
        pos[k * 3 + 1] = (y + 0.5) / n
        rnd[k] = Math.random()
        k++
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1))

    this.baseSize = cap.texel * splatFill
    const mk = () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          colorMap: { value: null },
          depthMap: { value: null },
          capMatrix: { value: new THREE.Matrix4() },
          capNear: { value: cap.near },
          capFar: { value: cap.far },
          radius: { value: cap.radius },
          splatSize: { value: this.baseSize },
          pixelFactor: { value: 1000 },
          weight: { value: 1 },
        },
      })
    this.matA = mk()
    this.matB = mk()
    this.ptsA = new THREE.Points(geo, this.matA)
    this.ptsB = new THREE.Points(geo, this.matB)
    // 包围体只是 uv 网格, 禁用视锥剔除
    this.ptsA.frustumCulled = false
    this.ptsB.frustumCulled = false
    this.add(this.ptsA, this.ptsB)
  }

  /** 指定当前使用的两个相邻视图及各自权重 */
  setViews(i: number, wi: number, j: number, wj: number): void {
    const set = (m: THREE.ShaderMaterial, idx: number, w: number) => {
      m.uniforms.colorMap.value = this.cap.views[idx].colorTex
      m.uniforms.depthMap.value = this.cap.views[idx].depthTex
      ;(m.uniforms.capMatrix.value as THREE.Matrix4).copy(this.cap.views[idx].capMatrix)
      m.uniforms.weight.value = w
    }
    set(this.matA, i, wi)
    set(this.matB, j, wj)
    this.ptsA.visible = wi > 0.002
    this.ptsB.visible = wj > 0.002
  }

  /** splat 尺寸倍数(摆放缩放 × 破洞膨胀填补) */
  setSplatScale(s: number): void {
    this.matA.uniforms.splatSize.value = this.baseSize * s
    this.matB.uniforms.splatSize.value = this.baseSize * s
  }

  setPixelFactor(f: number): void {
    this.matA.uniforms.pixelFactor.value = f
    this.matB.uniforms.pixelFactor.value = f
  }

  get splatCount(): number {
    return this.cap.res * this.cap.res
  }
}
