import { Camera, Frustum } from 'three';
import {
  CullResult,
  CullStatus,
  PlaneName,
  classifySphere,
  updateFrustum,
} from '../culling/frustum';
import { GroupEntity, MeshEntity, SampleScene } from '../scene/sampleScene';

export type { CullStatus };

export type CullMode = 'per-mesh' | 'per-group' | 'native';

export interface EntityCullInfo {
  entity: MeshEntity;
  result: CullResult;
  /** 按组策略下，该实体是否被提交绘制（组 out 时整体跳过）。 */
  drawn: boolean;
  /** 按组策略下，所属组是否整体判定为 out，直接跳过了子筛选。 */
  skippedByGroup: boolean;
}

export interface GroupCullInfo {
  groupEntity: GroupEntity;
  result: CullResult;
  members: EntityCullInfo[];
  drawnCount: number;
}

export interface CullFrame {
  frustum: Frustum;
  mode: CullMode;
  groups: GroupCullInfo[];
  /** 逐物件策略：每个 mesh 独立判定后的应绘制数。 */
  perMeshDrawn: number;
  /** 按组策略：组 out 跳过、组 intersect 下钻后的应绘制数。 */
  perGroupDrawn: number;
  /** 场景摆件总数。 */
  totalMeshes: number;
  /** 按组策略中，组整体 out 而被跳过的子对象数。 */
  skippedByGroupCount: number;
  /** 组层级状态计数。 */
  groupStatusCount: Record<CullStatus, number>;
}

/**
 * 剔除控制器。
 *
 * 层级约定：
 * - layer 0：摆件 mesh（观察相机可见）
 * - layer 1：调试辅助体（仅总览相机可见）
 * 通过开关 mesh 的 layer 0 来模拟「是否提交绘制」，总览相机始终能在 layer 1
 * 看到包围体/视锥，不受剔除结果影响。
 */
export class CullController {
  mode: CullMode = 'per-mesh';

  constructor(private scene: SampleScene) {
    for (const entity of scene.meshes) {
      entity.mesh.layers.enable(0);
    }
  }

  setMode(mode: CullMode): void {
    this.mode = mode;
  }

  update(camera: Camera): CullFrame {
    camera.updateMatrixWorld(true);
    const frustum = updateFrustum(camera);

    const groups: GroupCullInfo[] = [];
    let perMeshDrawn = 0;
    let perGroupDrawn = 0;
    let skippedByGroupCount = 0;
    const groupStatusCount: Record<CullStatus, number> = { in: 0, intersect: 0, out: 0 };

    for (const groupEntity of this.scene.groups) {
      const groupResult = classifySphere(frustum, groupEntity.worldSphere);
      groupStatusCount[groupResult.status]++;

      const memberInfos: EntityCullInfo[] = [];
      let drawnCount = 0;

      for (const entity of groupEntity.members) {
        // 逐物件判定：无论组状态如何，每个 mesh 用自己的包围球独立判定。
        const meshResult = classifySphere(frustum, entity.worldSphere);
        if (meshResult.status !== 'out') perMeshDrawn++;

        // 按组判定：
        // - 组 out   -> 整组跳过，子对象不再筛选（也不提交绘制）
        // - 组 in    -> 组内全部提交
        // - 组 intersect -> 组只是局部可见，必须对每个子对象再做一次筛选，
        //                   保证跨过边界的成员不漏画、界外成员不白画
        const skippedByGroup = groupResult.status === 'out';
        let drawn: boolean;
        if (groupResult.status === 'out') {
          drawn = false;
        } else if (groupResult.status === 'in') {
          drawn = true;
        } else {
          drawn = meshResult.status !== 'out';
        }
        if (drawn) {
          drawnCount++;
          perGroupDrawn++;
        }
        if (skippedByGroup) skippedByGroupCount++;

        memberInfos.push({ entity, result: meshResult, drawn, skippedByGroup });
        this.applyLayer(entity, meshResult, drawn);
      }

      groups.push({
        groupEntity,
        result: groupResult,
        members: memberInfos,
        drawnCount,
      });
    }

    return {
      frustum,
      mode: this.mode,
      groups,
      perMeshDrawn,
      perGroupDrawn,
      totalMeshes: this.scene.meshes.length,
      skippedByGroupCount,
      groupStatusCount,
    };
  }

  private applyLayer(
    entity: MeshEntity,
    meshResult: CullResult,
    groupDrawn: boolean,
  ): void {
    if (this.mode === 'native') {
      // 原生对照：交给 Three.js 渲染器自身的 frustumCulled 机制，
      // 这里不碰 layer，由 render.info 统计真实提交数。
      entity.mesh.layers.enable(0);
      entity.mesh.frustumCulled = true;
      return;
    }
    entity.mesh.frustumCulled = false;
    const visible = this.mode === 'per-mesh' ? meshResult.status !== 'out' : groupDrawn;
    if (visible) {
      entity.mesh.layers.enable(0);
    } else {
      entity.mesh.layers.disable(0);
    }
  }
}

export function reasonText(result: CullResult): string {
  if (result.status === 'out') return `出界:${result.rejectedBy as PlaneName}`;
  if (result.status === 'intersect') return '边界交叉';
  return '完全可见';
}
