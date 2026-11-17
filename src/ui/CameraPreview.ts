import * as THREE from 'three';
import type { CameraSample } from '../core/types';
import { createGround, createLights, createReferenceObjects } from './scene';

/**
 * First-person preview: renders exactly what the moving camera sees, using the
 * position + quaternion produced by the stateless evaluator. Also draws a
 * small on-screen up-axis cue so camera roll is visible during review.
 */
export class CameraPreview {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private readonly scene = new THREE.Scene();
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
    this.scene.background = new THREE.Color(0x0b0f15);
    this.scene.fog = new THREE.Fog(0x0b0f15, 45, 95);
    this.scene.add(createLights());
    this.scene.add(createGround());
    this.scene.add(createReferenceObjects());

    window.addEventListener('resize', this.resize);
    this.resize();
  }

  /** Apply the evaluated pose. Both overview and preview read the same sample. */
  applySample(s: CameraSample): void {
    this.camera.position.copy(s.position);
    this.camera.quaternion.copy(s.quaternion);
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
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
