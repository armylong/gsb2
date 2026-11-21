import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createFilmMaterial, type FilmMaterial } from './material';

export interface Sample {
  name: string;
  mesh: THREE.Mesh;
  film: FilmMaterial;
}

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  samples: Sample[]; // [0] 弧面样片, [1] 平试片
  lightRig: THREE.Group; // 照明参考（方向光指示）
  keyLight: THREE.DirectionalLight;
}

export function buildScene(container: HTMLElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141518);

  const camera = new THREE.PerspectiveCamera(
    42,
    container.clientWidth / container.clientHeight,
    0.1,
    100,
  );
  camera.position.set(0, 1.6, 5.2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.55, 0);
  controls.enableDamping = true;

  // 环境：柔和半球光，避免背光面死黑
  scene.add(new THREE.HemisphereLight(0x8a93a5, 0x1a1b1e, 0.5));

  // 主方向光（用于高光参照；薄膜着色本身在 shader 内由 uLightDir 完成）
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  scene.add(keyLight);

  // 光源方向指示小球 + 连线
  const lightRig = new THREE.Group();
  const lampBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8 }),
  );
  const lampLineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 1),
  ]);
  const lampLine = new THREE.Line(
    lampLineGeom,
    new THREE.LineBasicMaterial({ color: 0x8a7f56, transparent: true, opacity: 0.6 }),
  );
  lightRig.add(lampBall);
  lightRig.add(lampLine);
  scene.add(lightRig);

  // 深色台面
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.9, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // ---- 样片 A：弧面样片（120° 圆柱面片，uv.x 沿弧向，供渐变膜厚使用）----
  const curvedFilm = createFilmMaterial();
  const curvedGeo = new THREE.CylinderGeometry(1.1, 1.1, 1.5, 96, 1, true, -Math.PI / 3, (2 * Math.PI) / 3);
  const curvedMesh = new THREE.Mesh(curvedGeo, curvedFilm.material);
  curvedMesh.position.set(-1.35, 0.75, 0);
  curvedMesh.name = 'sample-curved';
  scene.add(curvedMesh);

  // ---- 样片 B：平试片 ----
  const flatFilm = createFilmMaterial();
  const flatGeo = new THREE.BoxGeometry(1.7, 1.7, 0.06);
  const flatMesh = new THREE.Mesh(flatGeo, flatFilm.material);
  flatMesh.position.set(1.35, 0.86, 0);
  flatMesh.name = 'sample-flat';
  scene.add(flatMesh);

  // 支座（深色，区分样片本体）
  const standMat = new THREE.MeshStandardMaterial({ color: 0x232529, roughness: 0.8 });
  for (const x of [-1.35, 1.35]) {
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.12, 24), standMat);
    stand.position.set(x, 0.06, 0);
    scene.add(stand);
  }

  const samples: Sample[] = [
    { name: '弧面样片', mesh: curvedMesh, film: curvedFilm },
    { name: '平试片', mesh: flatMesh, film: flatFilm },
  ];

  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  return { renderer, scene, camera, controls, samples, lightRig, keyLight };
}
