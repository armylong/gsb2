import type { MaterialKind, MaterialParams } from './types';

/** 三类材料的默认参数。新建箱体时按材质克隆一份。 */
export function defaultMaterial(kind: MaterialKind): MaterialParams {
  switch (kind) {
    case 'penetrable':
      return {
        kind,
        resistance: 4,
        reflectLossRatio: 0,
        maxReflectAngleDeg: 0,
      };
    case 'reflective':
      return {
        kind,
        resistance: 0,
        reflectLossRatio: 0.2,
        maxReflectAngleDeg: 60,
      };
    case 'blocking':
      return {
        kind,
        resistance: 0,
        reflectLossRatio: 0,
        maxReflectAngleDeg: 0,
      };
  }
}

export const MATERIAL_LABELS: Record<MaterialKind, string> = {
  penetrable: '可穿透',
  reflective: '可反弹',
  blocking: '完全阻挡',
};
