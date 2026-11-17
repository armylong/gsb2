import {
  composeMatrix,
  frozenDecalMatrix,
  validateProjector,
  type ProjectorParams,
  type TransformSnapshot,
} from './decalMath';
import type { TargetType } from './targets';

/** 现场记录:可导出为 JSON、再载入恢复,几何关系与画面一致。 */
export interface SceneRecord {
  version: 1;
  target: {
    type: TargetType;
    color: string;
    transform: TransformSnapshot; // 当前(导出时刻)变换
  };
  projector: ProjectorParams; // 当前(预览)投影机参数
  decalColor: string;
  firstSurfaceOnly: boolean;
  confirmed: null | {
    targetType: TargetType;
    decalColor: string;
    projector: ProjectorParams; // 确认时刻的投影机参数
    targetTransform: TransformSnapshot; // 确认时刻的目标变换
  };
}

export function serializeScene(rec: SceneRecord): string {
  return JSON.stringify(rec, null, 2);
}

const TARGET_TYPES: TargetType[] = ['plane', 'box', 'sphere', 'doublePlane'];

function isVec3(a: unknown): a is [number, number, number] {
  return Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n));
}

function parseTransform(t: unknown, where: string): TransformSnapshot {
  const o = t as TransformSnapshot;
  if (!o || !isVec3(o.position) || !isVec3(o.rotationEuler) || !isVec3(o.scale)) {
    throw new Error(`${where}: 变换字段缺失或非法`);
  }
  return {
    position: [...o.position],
    rotationEuler: [...o.rotationEuler],
    scale: [...o.scale],
  };
}

function parseProjector(p: unknown, where: string): ProjectorParams {
  const o = p as ProjectorParams;
  if (!o || !isVec3(o.position) || !isVec3(o.lookAt)) {
    throw new Error(`${where}: 投影器位置/朝向缺失或非法`);
  }
  const proj: ProjectorParams = {
    position: [...o.position],
    lookAt: [...o.lookAt],
    fovDeg: Number(o.fovDeg),
    near: Number(o.near),
    far: Number(o.far),
  };
  const errs = validateProjector(proj);
  if (errs.length) throw new Error(`${where}: ${errs.join(';')}`);
  return proj;
}

export function parseScene(json: string): SceneRecord {
  let raw: SceneRecord;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('不是合法的 JSON');
  }
  if (!raw || raw.version !== 1) throw new Error('version 必须为 1');
  if (!TARGET_TYPES.includes(raw.target?.type)) throw new Error('未知目标类型');
  const rec: SceneRecord = {
    version: 1,
    target: {
      type: raw.target.type,
      color: String(raw.target.color ?? '#5a7a9e'),
      transform: parseTransform(raw.target.transform, 'target'),
    },
    projector: parseProjector(raw.projector, 'projector'),
    decalColor: String(raw.decalColor ?? '#ff8c2a'),
    firstSurfaceOnly: raw.firstSurfaceOnly !== false,
    confirmed: null,
  };
  if (raw.confirmed) {
    if (!TARGET_TYPES.includes(raw.confirmed.targetType)) {
      throw new Error('confirmed: 未知目标类型');
    }
    rec.confirmed = {
      targetType: raw.confirmed.targetType,
      decalColor: String(raw.confirmed.decalColor ?? rec.decalColor),
      projector: parseProjector(raw.confirmed.projector, 'confirmed.projector'),
      targetTransform: parseTransform(raw.confirmed.targetTransform, 'confirmed.targetTransform'),
    };
  }
  return rec;
}

/**
 * 由记录重算确认槽冻结矩阵的校验入口(verify 用):
 * 恢复时模型矩阵 = compose(targetTransform),冻结矩阵应与确认时刻一致。
 */
export function recomputeFrozenFromRecord(rec: SceneRecord) {
  if (!rec.confirmed) return null;
  const model = composeMatrix(rec.confirmed.targetTransform);
  return frozenDecalMatrix(rec.confirmed.projector, model);
}
