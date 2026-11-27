import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GUI from 'lil-gui'
import { buildProp } from './prop'
import { captureViews } from './capture'
import { SplatImpostor } from './impostor'

const VIEW_COUNT = 8 // 水平环拍视图数, 间隔 45°
const RES = 128 // 每个视图 颜色+深度 各 128²

// ---------- 渲染器 / 场景 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
renderer.setPixelRatio(devicePixelRatio)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x101318)

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

scene.add(new THREE.AmbientLight(0xffffff, 0.55))
const key = new THREE.DirectionalLight(0xffffff, 1.4)
key.position.set(2, 3.5, 4)
scene.add(key)
scene.add(new THREE.GridHelper(20, 20, 0x2c3a52, 0x1c2536))

// ---------- 1. 捕获固定方向的 颜色+深度 视图 ----------
const cap = captureViews(buildProp, renderer, VIEW_COUNT, RES)

// ---------- 场景布置: 原物(左) 与 替身(右) ----------
const realRig = new THREE.Group()
realRig.add(buildProp())
realRig.position.set(-2.2, 0, 0)
scene.add(realRig)

const impRig = new THREE.Group()
impRig.position.set(2.2, 0, 0)
const impostor = new SplatImpostor(cap)
impRig.add(impostor)

// 破洞高亮代理: 略缩小的紫红实体, 垫在 splat 之下, 哪里没盖住哪里露紫红
const proxy = buildProp()
const magenta = new THREE.MeshBasicMaterial({ color: 0xff2fd6 })
proxy.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = magenta
})
proxy.scale.setScalar(0.98)
impRig.add(proxy)
scene.add(impRig)

// 柱子 ×2: 一根挡在替身前方(验证挡住半边), 一根在替身背后(验证替身在柱前)
const pillarMat = new THREE.MeshLambertMaterial({ color: 0x8a94a6 })
const pillarFront = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 4.5, 20), pillarMat)
pillarFront.position.set(1.7, 2.25, 2.1)
const pillarBack = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 4.5, 20), pillarMat)
pillarBack.position.set(2.9, 2.25, -1.8)
scene.add(pillarFront, pillarBack)

// 标签
function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64
  const g = c.getContext('2d')!
  g.font = 'bold 40px sans-serif'
  g.fillStyle = '#dfe9ff'
  g.textAlign = 'center'
  g.fillText(text, 128, 44)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }))
  s.scale.set(1.6, 0.4, 1)
  return s
}
const labelReal = makeLabel('原物')
labelReal.position.set(-2.2, 3.0, 0)
const labelImp = makeLabel('替身')
labelImp.position.set(2.2, 3.0, 0)
scene.add(labelReal, labelImp)

// ---------- 缩略图条 ----------
const thumbsEl = document.getElementById('thumbs')!
const thumbDivs: HTMLDivElement[] = []
cap.thumbnails.forEach((cv, i) => {
  const div = document.createElement('div')
  div.className = 'thumb'
  div.appendChild(cv)
  const lab = document.createElement('div')
  lab.textContent = `视图${i} ${((i * 360) / VIEW_COUNT).toFixed(0)}°`
  div.appendChild(lab)
  thumbsEl.appendChild(div)
  thumbDivs.push(div)
})

// ---------- 预设机位 ----------
const impHome = new THREE.Vector3(2.2, cap.center.y, 0)
function setPreset(azDeg: number, elDeg: number, dist: number): void {
  const az = THREE.MathUtils.degToRad(azDeg)
  const el = THREE.MathUtils.degToRad(elDeg)
  controls.target.copy(impHome)
  camera.position.set(
    impHome.x + dist * Math.sin(az) * Math.cos(el),
    impHome.y + dist * Math.sin(el),
    impHome.z + dist * Math.cos(az) * Math.cos(el),
  )
  controls.update()
}

type HoleMode = '无' | '高亮缺失' | '膨胀填补'
const params = {
  rotY: 0,
  scale: 1,
  holeMode: '高亮缺失' as HoleMode,
  showReal: true,
  正视_视图0: () => setPreset(0, 8, 6.5),
  相邻视图中间_22_5度: () => setPreset(22.5, 8, 6.5),
  柱子遮挡验证: () => {
    controls.target.copy(impHome)
    camera.position.set(1.2, 1.6, 6.5)
    controls.update()
  },
  破洞观察位: () => setPreset(35, 25, 4.2),
}

const gui = new GUI({ title: '对照面板' })
const fRig = gui.addFolder('摆放(原物与替身同步)')
fRig.add(params, 'rotY', 0, 360, 1).name('方向 rotY°')
fRig.add(params, 'scale', 0.5, 2, 0.05).name('尺寸')
gui.add(params, 'holeMode', ['无', '高亮缺失', '膨胀填补']).name('破洞处理')
gui.add(params, 'showReal').name('显示原物')
const fCam = gui.addFolder('预设机位')
fCam.add(params, '正视_视图0')
fCam.add(params, '相邻视图中间_22_5度')
fCam.add(params, '柱子遮挡验证')
fCam.add(params, '破洞观察位')

// ---------- HUD ----------
const hud = document.getElementById('hud')!
const tmpBox = new THREE.Box3()
const tmpV = new THREE.Vector3()
function screenCoverage(obj: THREE.Object3D): number {
  tmpBox.setFromObject(obj)
  if (tmpBox.isEmpty()) return 0
  let minX = 1, maxX = -1, minY = 1, maxY = -1
  for (const x of [tmpBox.min.x, tmpBox.max.x])
    for (const y of [tmpBox.min.y, tmpBox.max.y])
      for (const z of [tmpBox.min.z, tmpBox.max.z]) {
        tmpV.set(x, y, z).project(camera)
        minX = Math.min(minX, tmpV.x); maxX = Math.max(maxX, tmpV.x)
        minY = Math.min(minY, tmpV.y); maxY = Math.max(maxY, tmpV.y)
      }
  const w = Math.max(0, Math.min(1, maxX) - Math.max(-1, minX))
  const h = Math.max(0, Math.min(1, maxY) - Math.max(-1, minY))
  return ((w * h) / 4) * 100
}

function updatePixelFactor(): void {
  const h = renderer.getDrawingBufferSize(new THREE.Vector2()).y
  impostor.setPixelFactor(h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))))
}
updatePixelFactor()
setPreset(0, 10, 8)

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  updatePixelFactor()
})

// ---------- 主循环 ----------
const centerW = new THREE.Vector3()
const tmpQ = new THREE.Quaternion()
const texKB = ((VIEW_COUNT * RES * RES * 4 * 2) / 1024).toFixed(0)

function animate(): void {
  requestAnimationFrame(animate)
  controls.update()

  // 摆放方向/尺寸同步作用于原物与替身
  const rot = THREE.MathUtils.degToRad(params.rotY)
  realRig.rotation.y = rot
  realRig.scale.setScalar(params.scale)
  impRig.rotation.y = rot
  impRig.scale.setScalar(params.scale)
  realRig.visible = params.showReal
  labelReal.visible = params.showReal

  // 在替身本地空间选最近的两个捕获视图, 余弦权重跨边界连续混合
  centerW.copy(cap.center).applyMatrix4(impRig.matrixWorld)
  impRig.getWorldQuaternion(tmpQ).invert()
  const local = tmpV.copy(camera.position).sub(centerW).normalize().applyQuaternion(tmpQ)
  let az = Math.atan2(local.x, local.z)
  if (az < 0) az += Math.PI * 2
  const step = (Math.PI * 2) / VIEW_COUNT
  const f = az / step
  const i0 = Math.floor(f) % VIEW_COUNT
  const frac = f - Math.floor(f)
  const i1 = (i0 + 1) % VIEW_COUNT
  const w1 = 0.5 - 0.5 * Math.cos(frac * Math.PI)
  const w0 = 1 - w1
  const dev = Math.min(frac, 1 - frac) * step // 距最近拍摄方向的角偏差
  const dev01 = dev / (step / 2)

  impostor.setViews(i0, w0, i1, w1)
  // 破洞处理: 膨胀填补按偏差放大 splat; 回到拍摄方向时偏差为 0, 尺寸精确复原, 无残留
  impostor.setSplatScale(params.scale * (params.holeMode === '膨胀填补' ? 1 + 1.4 * dev01 : 1))
  proxy.visible = params.holeMode === '高亮缺失'

  // 缩略图高亮当前视图
  thumbDivs.forEach((d, i) => {
    const w = i === i0 ? w0 : i === i1 ? w1 : 0
    d.style.outline = w > 0.01 ? `3px solid rgba(255, 200, 60, ${0.35 + 0.65 * w})` : '1px solid #333c4e'
  })

  const azDeg = THREE.MathUtils.radToDeg(az)
  const devDeg = THREE.MathUtils.radToDeg(dev)
  hud.textContent =
    `相机方位(替身本地): ${azDeg.toFixed(1)}°\n` +
    `使用视图: [${i0}] ${(w0 * 100).toFixed(0)}% + [${i1}] ${(w1 * 100).toFixed(0)}%   偏离拍摄方向: ${devDeg.toFixed(1)}° / ${THREE.MathUtils.radToDeg(step / 2).toFixed(1)}°\n` +
    `原物占屏(包围盒): ${screenCoverage(realRig).toFixed(2)}%   替身占屏: ${screenCoverage(proxy).toFixed(2)}%\n` +
    `替身开销: ${impostor.splatCount}×2 splats / 纹理 ${VIEW_COUNT}视图×${RES}²×8B ≈ ${texKB} KB\n` +
    `破洞处理: ${params.holeMode}${params.holeMode === '高亮缺失' ? ' (紫红=未拍到区域)' : ''}   逐帧重建, 回到拍摄方向无残留`

  renderer.render(scene, camera)
}
animate()
