import * as THREE from 'three';
import type { CameraSample } from '../core/types';
import { OverviewViewport } from './OverviewViewport';
import { CameraPreview } from './CameraPreview';

export interface OverviewCallbacks {
  onControlPointDrag: (index: number, position: THREE.Vector3) => void;
  onControlPointDragStart: () => void;
  onControlPointDragEnd: () => void;
  onTargetDrag: (position: THREE.Vector3) => void;
}

/** Structural interface satisfied by OverviewViewport. */
export interface IOverviewViewport {
  gizmo: {
    update(sample: CameraSample): void;
    setHeld(held: boolean): void;
  };
  updatePath(points: THREE.Vector3[], closed: boolean, dense: THREE.Vector3[]): void;
  updateTarget(p: THREE.Vector3): void;
  setTargetVisible(v: boolean): void;
  render(): void;
  resize(): void;
  dispose(): void;
}

/** Structural interface satisfied by CameraPreview. */
export interface ICameraPreview {
  applySample(s: CameraSample): void;
  render(): void;
  resize(): void;
  dispose(): void;
}

export interface ViewportFactory {
  createOverview(host: HTMLElement, cb: OverviewCallbacks): IOverviewViewport;
  createPreview(host: HTMLElement): ICameraPreview;
}

export const defaultViewportFactory: ViewportFactory = {
  createOverview(host, cb) {
    return new OverviewViewport(host, cb) as unknown as IOverviewViewport;
  },
  createPreview(host) {
    return new CameraPreview(host) as unknown as ICameraPreview;
  },
};
