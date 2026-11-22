/**
 * 锚点运行时：把「零件局部坐标」解析为世界坐标，投影到屏幕，并做遮挡判定。
 * 锚点跟随零件（包括摆臂这种会随父级转动的零件）由 localToWorld 自动完成。
 */

import * as THREE from 'three';
import type { AnchorDefinition, Assembly, PartHandle } from './assembly';
import { classifyVisibility, surfaceTolerance, type AnchorState } from '../core/visibility';

export interface AnchorRuntime {
  def: AnchorDefinition;
  part: PartHandle;
  local: THREE.Vector3;
  world: THREE.Vector3;
  screen: { x: number; y: number };
  /** 是否在镜头前方（可以投影出有意义的屏幕坐标）。 */
  inFront: boolean;
  state: AnchorState;
  partVisible: boolean;
}

export interface AnchorUpdateOptions {
  /** 跳过遮挡射线（例如只在需要时更新）。 */
  skipVisibility?: boolean;
}

const SCENE_SCALE = 12;

export class AnchorSystem {
  readonly runtimes: AnchorRuntime[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly index = new Map<string, AnchorRuntime>();
  private occluders: THREE.Mesh[] = [];

  private readonly cameraDir = new THREE.Vector3();
  private readonly toAnchor = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();

  constructor(private readonly assembly: Assembly) {
    for (const def of assembly.anchors) {
      const part = assembly.parts.get(def.partId);
      if (!part) {
        throw new Error(`标注 ${def.id} 引用了不存在的零件 ${def.partId}`);
      }
      this.runtimes.push({
        def,
        part,
        local: new THREE.Vector3(...def.local),
        world: new THREE.Vector3(),
        screen: { x: 0, y: 0 },
        inFront: false,
        state: 'behind',
        partVisible: true,
      });
      this.index.set(def.id, this.runtimes[this.runtimes.length - 1]);
    }
    this.syncOccluders();
  }

  find(anchorId: string): AnchorRuntime | undefined {
    return this.index.get(anchorId);
  }

  /** 零件显隐变化后重建遮挡体列表（隐藏的零件既不会遮挡，也不参与选择）。 */
  syncOccluders(): void {
    const meshes: THREE.Mesh[] = [];
    for (const part of this.assembly.parts.values()) {
      if (!part.visible) continue;
      meshes.push(...part.meshes);
    }
    this.occluders = meshes;
  }

  update(
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    options: AnchorUpdateOptions = {},
  ): void {
    camera.getWorldDirection(this.cameraDir);
    const cameraPos = camera.position;

    for (const runtime of this.runtimes) {
      runtime.partVisible = runtime.part.visible;
      runtime.world.copy(runtime.local);
      runtime.part.group.localToWorld(runtime.world);

      this.toAnchor.copy(runtime.world).sub(cameraPos);
      const viewDistance = this.toAnchor.length();
      const inFront =
        viewDistance > 1e-6 && this.toAnchor.dot(this.cameraDir) / viewDistance > 1e-4;
      runtime.inFront = inFront;

      if (inFront) {
        const ndc = runtime.world.clone().project(camera);
        runtime.screen.x = (ndc.x * 0.5 + 0.5) * width;
        runtime.screen.y = (-ndc.y * 0.5 + 0.5) * height;
      } else {
        runtime.screen.x = Number.NaN;
        runtime.screen.y = Number.NaN;
      }

      if (!inFront) {
        runtime.state = 'behind';
        continue;
      }

      if (options.skipVisibility) continue;

      runtime.state = this.castVisibility(cameraPos, runtime.world, viewDistance);
    }
  }

  /**
   * 单独判断一个锚点是否被遮挡。
   * 射线只延伸到锚点表面容差之前，因此「锚点正好贴在自己的表面」不会被
   * 自己的零件误判为遮挡，而镜头绕到背后时仍会先撞上实体外壳。
   */
  private castVisibility(
    cameraPos: THREE.Vector3,
    anchorWorld: THREE.Vector3,
    viewDistance: number,
  ): AnchorState {
    const tolerance = surfaceTolerance(viewDistance, SCENE_SCALE);
    const far = Math.max(0, viewDistance - tolerance);
    if (far <= 1e-6) return 'visible';

    this.raycaster.set(
      cameraPos,
      this.rayDirection.copy(anchorWorld).sub(cameraPos).normalize(),
    );
    this.raycaster.near = 0;
    this.raycaster.far = far;
    const hits = this.raycaster.intersectObjects(this.occluders, false);

    return classifyVisibility({
      cameraPosition: cameraPos,
      cameraForward: this.cameraDir,
      anchorPosition: anchorWorld,
      nearestHitDistance: hits.length > 0 ? hits[0].distance : null,
      tolerance,
    }).state;
  }

  /** 调试辅助：返回某个锚点到镜头的射线上的首个命中。 */
  probe(anchorId: string, camera: THREE.PerspectiveCamera): {
    distanceToAnchor: number;
    tolerance: number;
    hitDistance: number | null;
    hitPartId: string | null;
    hitPartName: string | null;
  } | null {
    const runtime = this.find(anchorId);
    if (!runtime) return null;
    const dir = runtime.world.clone().sub(camera.position);
    const dist = dir.length();
    const tolerance = surfaceTolerance(dist, SCENE_SCALE);
    this.raycaster.set(camera.position, dir.normalize());
    this.raycaster.near = 0;
    this.raycaster.far = Math.max(0, dist - tolerance);
    const hits = this.raycaster.intersectObjects(this.occluders, false);
    const hit = hits[0];
    return {
      distanceToAnchor: dist,
      tolerance,
      hitDistance: hit ? hit.distance : null,
      hitPartId: hit ? (hit.object.userData.partId as string) ?? null : null,
      hitPartName: hit ? (hit.object.parent?.name ?? null) : null,
    };
  }
}
