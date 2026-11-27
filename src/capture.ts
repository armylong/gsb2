import * as THREE from 'three'

export interface ImpostorView {
  /** 捕获方位角(弧度, 道具本地空间) */
  angle: number
  colorTex: THREE.Texture
  /** RGBA 打包的正交深度 */
  depthTex: THREE.Texture
  /** 捕获相机在道具本地空间的 matrixWorld, 用于从 (uv, depth) 重建本地坐标 */
  capMatrix: THREE.Matrix4
}

export interface CaptureResult {
  views: ImpostorView[]
  /** 正交捕获视锥半径(世界单位) */
  radius: number
  /** 单个纹素对应的世界尺寸 */
  texel: number
  res: number
  near: number
  far: number
  /** 道具包围盒中心(本地空间) */
  center: THREE.Vector3
  thumbnails: HTMLCanvasElement[]
}

/**
 * 从 viewCount 个水平均布方向, 用正交相机为道具拍摄 颜色+深度 视图。
 * 光照固定在道具本地空间, 保证替身贴图与原物观感一致。
 */
export function captureViews(
  propFactory: () => THREE.Object3D,
  renderer: THREE.WebGLRenderer,
  viewCount: number,
  res: number,
): CaptureResult {
  const prop = propFactory()
  const scene = new THREE.Scene()
  scene.add(new THREE.AmbientLight(0xffffff, 0.55))
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(2, 3.5, 4)
  scene.add(key)
  scene.add(prop)

  const box = new THREE.Box3().setFromObject(prop)
  const center = box.getCenter(new THREE.Vector3())
  const radius = (box.getSize(new THREE.Vector3()).length() / 2) * 1.02
  const dist = radius * 2.5
  const near = dist - radius * 1.05
  const far = dist + radius * 1.05

  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  const views: ImpostorView[] = []
  const thumbnails: HTMLCanvasElement[] = []

  const prevClear = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()

  for (let i = 0; i < viewCount; i++) {
    const angle = (i / viewCount) * Math.PI * 2
    const dir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle))
    const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, near, far)
    cam.position.copy(center).addScaledVector(dir, dist)
    cam.up.set(0, 1, 0)
    cam.lookAt(center)
    cam.updateMatrixWorld()

    const rtColor = new THREE.WebGLRenderTarget(res, res, { depthBuffer: true })
    const rtDepth = new THREE.WebGLRenderTarget(res, res, { depthBuffer: true })

    // 颜色(带 alpha 轮廓掩码)
    renderer.setRenderTarget(rtColor)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.render(scene, cam)

    // 深度(RGBA 打包, 背景清成 1 = 远平面)
    scene.overrideMaterial = depthMat
    renderer.setRenderTarget(rtDepth)
    renderer.setClearColor(0xffffff, 1)
    renderer.clear()
    renderer.render(scene, cam)
    scene.overrideMaterial = null

    // 页面缩略图(readRenderTargetPixels 行序自下而上, 需翻转)
    const buf = new Uint8Array(res * res * 4)
    renderer.readRenderTargetPixels(rtColor, 0, 0, res, res, buf)
    const cv = document.createElement('canvas')
    cv.width = res
    cv.height = res
    const ctx = cv.getContext('2d')!
    const img = ctx.createImageData(res, res)
    for (let y = 0; y < res; y++) {
      const src = (res - 1 - y) * res * 4
      img.data.set(buf.subarray(src, src + res * 4), y * res * 4)
    }
    ctx.putImageData(img, 0, 0)
    thumbnails.push(cv)

    views.push({
      angle,
      colorTex: rtColor.texture,
      depthTex: rtDepth.texture,
      capMatrix: cam.matrixWorld.clone(),
    })
  }

  renderer.setRenderTarget(null)
  renderer.setClearColor(prevClear, prevAlpha)

  return { views, radius, texel: (radius * 2) / res, res, near, far, center, thumbnails }
}
