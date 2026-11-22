import * as THREE from 'three';
import type { ParamSet } from './params';

/** 两个被测材质：粗糙金属（圆柱）与哑光板（平板） */
export class MaterialPair {
  readonly metal: THREE.MeshStandardMaterial;
  readonly plate: THREE.MeshStandardMaterial;

  constructor() {
    this.metal = new THREE.MeshStandardMaterial({
      color: '#b8bec8',
      metalness: 1.0,
      roughness: 0.35,
      envMapIntensity: 1.0,
    });
    this.plate = new THREE.MeshStandardMaterial({
      color: '#8a8f99',
      metalness: 0.0,
      roughness: 0.55,
      envMapIntensity: 0.6,
    });
  }

  apply(p: ParamSet): void {
    this.metal.roughness = p.metalRoughness;
    this.metal.color.set(p.metalColor);
    this.plate.roughness = p.plateRoughness;
    this.plate.color.set(p.plateColor);
  }
}
