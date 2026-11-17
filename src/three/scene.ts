import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BoneName } from '../core/types';
import type { ProceduralCharacter } from './character';

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  raycaster: THREE.Raycaster;
  dispose: () => void;
  /** 注册关节点击回调 */
  onPick: (cb: (name: BoneName) => void) => void;
}

export function createScene(canvas: HTMLCanvasElement, character: ProceduralCharacter): SceneContext {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef2f6);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
  camera.position.set(1.6, 1.35, 2.2);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.85, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.6;
  controls.maxDistance = 8;

  // 光照
  const hemi = new THREE.HemisphereLight(0xffffff, 0x9fb4c8, 1.1);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(2.5, 4, 2);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.left = -3;
  dir.shadow.camera.right = 3;
  dir.shadow.camera.top = 3;
  dir.shadow.camera.bottom = -3;
  scene.add(dir);

  // 地面网格
  const grid = new THREE.GridHelper(20, 40, 0x94a3b8, 0xc7d2de);
  grid.position.y = 0.001;
  scene.add(grid);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.ShadowMaterial({ opacity: 0.18 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(character.root);

  // 关节拾取：射线与不可见拾取球求交
  const raycaster = new THREE.Raycaster();
  const pickTargets = [...character.pickMeshes.values()];
  let pickCb: ((name: BoneName) => void) | null = null;
  const pointer = new THREE.Vector2();

  const onPointerDown = (event: PointerEvent) => {
    if (!pickCb) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickTargets, false);
    if (hits.length > 0) {
      const name = hits[0].object.userData.boneName as BoneName;
      pickCb(name);
    }
  };
  canvas.addEventListener('pointerdown', onPointerDown);

  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  return {
    renderer,
    scene,
    camera,
    controls,
    raycaster,
    onPick: (cb) => {
      pickCb = cb;
    },
    dispose: () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
}
