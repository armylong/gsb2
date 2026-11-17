import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CameraGizmo,
  createGround,
  createLights,
  createReferenceObjects,
  PathLine,
  TargetMarker,
} from './scene';

export interface OverviewCallbacks {
  onControlPointDrag: (index: number, position: THREE.Vector3) => void;
  onControlPointDragStart: () => void;
  onControlPointDragEnd: () => void;
  onTargetDrag: (position: THREE.Vector3) => void;
}

/**
 * Top-down / orbit overview: shows ground, references, the editable path with
 * control-point handles, the look target and the live camera gizmo.
 * Control points and the target are draggable via raycasting against a drag
 * plane; OrbitControls rotates the view otherwise.
 */
export class OverviewViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly scene = new THREE.Scene();
  private readonly pathLine = new PathLine();
  private readonly targetMarker = new TargetMarker();
  readonly gizmo = new CameraGizmo();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly dragPlane = new THREE.Plane();
  private readonly dragOffset = new THREE.Vector3();
  private dragging: { kind: 'point' | 'target'; index?: number } | null = null;
  private readonly cb: OverviewCallbacks;
  private readonly container: HTMLElement;
  private frame = 0;

  constructor(container: HTMLElement, cb: OverviewCallbacks) {
    this.container = container;
    this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
    this.camera.position.set(26, 22, 28);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 3, 0);

    this.scene.background = new THREE.Color(0x0a0d11);
    this.scene.add(createLights());
    this.scene.add(createGround());
    this.scene.add(createReferenceObjects());
    this.scene.add(this.pathLine.object);
    this.scene.add(this.targetMarker.object);
    this.scene.add(this.gizmo.object);

    this.bindEvents();
    this.resize();
  }

  private bindEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('resize', this.resize);
  }

  private setPointer(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const targetHits = this.raycaster.intersectObject(this.targetMarker.object, false);
    if (targetHits.length > 0) {
      this.dragging = { kind: 'target' };
      this.controls.enabled = false;
      // Drag on a camera-facing plane through the target.
      const normal = new THREE.Vector3();
      this.camera.getWorldDirection(normal);
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, this.targetMarker.object.position);
      const hit = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(this.dragPlane, hit);
      this.dragOffset.copy(this.targetMarker.object.position).sub(hit);
      this.renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }

    const hits = this.raycaster.intersectObjects(this.pathLine.controlPointMeshes, false);
    if (hits.length > 0) {
      const mesh = hits[0].object as THREE.Mesh;
      this.dragging = { kind: 'point', index: mesh.userData.index as number };
      this.controls.enabled = false;
      this.cb.onControlPointDragStart();
      const normal = new THREE.Vector3();
      this.camera.getWorldDirection(normal);
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, mesh.position);
      const hit = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(this.dragPlane, hit);
      this.dragOffset.copy(mesh.position).sub(hit);
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) {
      // Hover cursor feedback.
      this.setPointer(e);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const over =
        this.raycaster.intersectObjects(this.pathLine.controlPointMeshes, false).length > 0 ||
        this.raycaster.intersectObject(this.targetMarker.object, false).length > 0;
      this.renderer.domElement.style.cursor = over ? 'grab' : '';
      return;
    }
    this.setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, hit)) return;
    hit.add(this.dragOffset);
    if (this.dragging.kind === 'point' && this.dragging.index !== undefined) {
      this.cb.onControlPointDrag(this.dragging.index, hit);
    } else {
      this.cb.onTargetDrag(hit);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.dragging?.kind === 'point') this.cb.onControlPointDragEnd();
    this.dragging = null;
    this.controls.enabled = true;
    try {
      this.renderer.domElement.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  updatePath(points: THREE.Vector3[], closed: boolean, dense: THREE.Vector3[]): void {
    this.pathLine.update(points, closed, dense);
  }

  updateTarget(p: THREE.Vector3): void {
    this.targetMarker.setPosition(p);
  }

  setTargetVisible(v: boolean): void {
    this.targetMarker.object.visible = v;
  }

  resize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frame++;
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
