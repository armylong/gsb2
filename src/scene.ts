import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { faceNormal, FaceId, SceneSpec, stepFrontZ } from './geom';
import { PaintCell } from './project';

export interface SceneBundle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  imagePlane: THREE.Mesh;
  eyeMarker: THREE.Group;
  paintRoot: THREE.Group; // 各草稿的绘制网格挂在这里
  markerRoot: THREE.Group; // 点选标记
  occluders: THREE.Object3D[]; // 参与投影计算的网格
  resize: () => void;
}

const FACE_TINT: Record<FaceId, number> = { ground: 0xd8d4cc, stepTop: 0xc9c2b4, stepFront: 0xbfb7a6 };

export function setupScene(container: HTMLElement, spec: SceneSpec, targetCanvas: HTMLCanvasElement): SceneBundle {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2b3038);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
  camera.position.set(5, 5, 10);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, -2);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(4, 8, 6);
  scene.add(sun);

  // 地面(有限大,界外即"射出场景")
  const g = spec.ground;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(g.width, g.depth).rotateX(-Math.PI / 2).translate(g.cx, 0, g.cz),
    new THREE.MeshLambertMaterial({ color: FACE_TINT.ground }),
  );
  ground.name = 'ground';
  scene.add(ground);

  const grid = new THREE.GridHelper(1, 1, 0x888888, 0xaaaaaa);
  // 用线框网格按 1m 间距铺在地面上
  grid.geometry.dispose();
  grid.geometry = makeGroundGrid(g.width, g.depth, g.cx, g.cz);
  (grid.material as THREE.Material).opacity = 0.35;
  (grid.material as THREE.Material).transparent = true;
  scene.add(grid);

  // 台阶
  const s = spec.step;
  const step = new THREE.Mesh(
    new THREE.BoxGeometry(s.w, s.h, s.d).translate(s.cx, s.h / 2, s.cz),
    new THREE.MeshLambertMaterial({ color: FACE_TINT.stepFront }),
  );
  step.name = 'step';
  scene.add(step);
  const stepEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(step.geometry),
    new THREE.LineBasicMaterial({ color: 0x555049 }),
  );
  scene.add(stepEdges);

  // 立正的目标图:单位平面 + 缩放,改尺寸时边框一起变
  const tex = new THREE.CanvasTexture(targetCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const imagePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
  );
  imagePlane.name = 'targetImage';
  imagePlane.position.set(spec.image.cx, spec.image.cy, spec.image.cz);
  imagePlane.scale.set(spec.image.w, spec.image.h, 1);
  const imgFrame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
    new THREE.LineBasicMaterial({ color: 0xffffff }),
  );
  imagePlane.add(imgFrame);
  scene.add(imagePlane);

  // 观察点标记:红球 + 朝目标图中心的视线(lookAt 后 +z 指向目标)
  const eyeMarker = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 16), new THREE.MeshBasicMaterial({ color: 0xff3355 }));
  eyeMarker.add(ball);
  const sightGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
  const sight = new THREE.Line(sightGeo, new THREE.LineDashedMaterial({ color: 0xff3355, dashSize: 0.15, gapSize: 0.1 }));
  sight.computeLineDistances();
  eyeMarker.add(sight);
  scene.add(eyeMarker);

  const paintRoot = new THREE.Group();
  scene.add(paintRoot);
  const markerRoot = new THREE.Group();
  scene.add(markerRoot);

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  resize();

  return { scene, camera, renderer, controls, imagePlane, eyeMarker, paintRoot, markerRoot, occluders: [ground, step], resize };
}

function makeGroundGrid(width: number, depth: number, cx: number, cz: number): THREE.BufferGeometry {
  const pts: number[] = [];
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;
  const z0 = cz - depth / 2;
  const z1 = cz + depth / 2;
  for (let x = Math.ceil(x0); x <= x1; x++) pts.push(x, 0.002, z0, x, 0.002, z1);
  for (let z = Math.ceil(z0); z <= z1; z++) pts.push(x0, 0.002, z, x1, 0.002, z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/** 更新观察点标记位置与视线方向 */
export function updateEyeMarker(bundle: SceneBundle, eye: THREE.Vector3, lookAt: THREE.Vector3): void {
  bundle.eyeMarker.position.copy(eye);
  const dir = lookAt.clone().sub(eye);
  const len = dir.length();
  const sight = bundle.eyeMarker.children[1] as THREE.Line;
  const pos = sight.geometry.getAttribute('position') as THREE.BufferAttribute;
  pos.setXYZ(1, 0, 0, len);
  pos.needsUpdate = true;
  sight.computeLineDistances();
  bundle.eyeMarker.lookAt(lookAt);
}

/** 把投影结果做成贴在各面上的彩色网格(沿法线微抬避免 z-fighting) */
export function buildPaintGroup(cells: PaintCell[]): THREE.Group {
  const group = new THREE.Group();
  const byFace = new Map<FaceId, PaintCell[]>();
  for (const c of cells) {
    const arr = byFace.get(c.face) ?? [];
    arr.push(c);
    byFace.set(c.face, arr);
  }
  for (const [face, list] of byFace) {
    const n = faceNormal(face).multiplyScalar(0.004);
    const positions: number[] = [];
    const colors: number[] = [];
    const col = new THREE.Color();
    for (const c of list) {
      col.set(c.color);
      // 两个三角形: 0,1,2 与 0,2,3
      const idx = [0, 1, 2, 0, 2, 3];
      for (const k of idx) {
        const p = c.corners3[k];
        positions.push(p.x + n.x, p.y + n.y, p.z + n.z);
        colors.push(col.r, col.g, col.b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
    mesh.name = `paint-${face}`;
    group.add(mesh);
  }
  return group;
}

const MARKER_COLORS: Record<FaceId, number> = { ground: 0x22cc66, stepTop: 0x2266ff, stepFront: 0xff8800 };

/** 在落点放一个球形标记,并画一条从观察点出发的视线 */
export function addLandingMarker(markerRoot: THREE.Group, eye: THREE.Vector3, hit: THREE.Vector3, face: FaceId): void {
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 16, 12),
    new THREE.MeshBasicMaterial({ color: MARKER_COLORS[face], depthTest: false }),
  );
  ball.position.copy(hit).add(faceNormal(face).multiplyScalar(0.03));
  ball.renderOrder = 10;
  markerRoot.add(ball);
  const lineGeo = new THREE.BufferGeometry().setFromPoints([eye, hit]);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: MARKER_COLORS[face], transparent: true, opacity: 0.6 }));
  markerRoot.add(line);
}

export function faceTint(face: FaceId): number {
  return FACE_TINT[face];
}

export { stepFrontZ };
