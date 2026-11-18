import * as THREE from 'three';

/** 一个逻辑对象：可包含多个子网格，选择/描边以整体为单位。 */
export interface SceneObject {
  /** 1..N，同时作为 ID 缓冲中的标识，0 保留给背景。 */
  id: number;
  name: string;
  /** 所有子网格挂在这个 Group 下，布局变换也作用于它。 */
  group: THREE.Group;
  /** 参与拾取与 ID 渲染的实际网格。 */
  meshes: THREE.Mesh[];
  color: THREE.Color;
  hidden: boolean;
}

export type LayoutName = 'separated' | 'occlusion' | 'touch';

export type OutlineMode = 'visible' | 'hidden';
