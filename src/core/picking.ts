import type { AABB, Camera, EntityId } from './types';
import { pointInPolygon, project, screenToGround, silhouettePolygon } from './geometry';

export interface FaceHit {
  id: EntityId;
  /** 命中的可见表面：top / south（朝相机的南面）/ east（朝相机的东面）。 */
  face: 'top' | 'south' | 'east';
}

function boxFaces(box: AABB, cam: Camera): { face: FaceHit['face']; pts: { x: number; y: number }[] }[] {
  const p = (x: number, y: number, z: number) => {
    const sp = project({ x, y, z }, cam);
    return { x: sp.sx, y: sp.sy };
  };
  return [
    {
      face: 'top',
      pts: [
        p(box.minX, box.minY, box.maxZ),
        p(box.maxX, box.minY, box.maxZ),
        p(box.maxX, box.maxY, box.maxZ),
        p(box.minX, box.maxY, box.maxZ),
      ],
    },
    {
      // 南面：y = maxY，朝向相机
      face: 'south',
      pts: [
        p(box.minX, box.maxY, box.maxZ),
        p(box.maxX, box.maxY, box.maxZ),
        p(box.maxX, box.maxY, box.minZ),
        p(box.minX, box.maxY, box.minZ),
      ],
    },
    {
      // 东面：x = maxX，朝向相机
      face: 'east',
      pts: [
        p(box.maxX, box.minY, box.maxZ),
        p(box.maxX, box.maxY, box.maxZ),
        p(box.maxX, box.maxY, box.minZ),
        p(box.maxX, box.minY, box.minZ),
      ],
    },
  ];
}

/**
 * 可见表面拾取：按实际绘制顺序从“最前”往“最后”测试，
 * 先命中的实体即挡住后面的实体；只测试朝向相机的三个面。
 */
export function pickEntity(
  sx: number,
  sy: number,
  entities: { id: EntityId; box: AABB }[],
  drawOrder: EntityId[],
  cam: Camera,
): FaceHit | null {
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (let i = drawOrder.length - 1; i >= 0; i--) {
    const e = byId.get(drawOrder[i]);
    if (!e) continue;
    // 先用剪影粗筛
    if (!pointInPolygon(sx, sy, silhouettePolygon(e.box, cam))) continue;
    for (const f of boxFaces(e.box, cam)) {
      if (pointInPolygon(sx, sy, { pts: f.pts })) return { id: e.id, face: f.face };
    }
  }
  return null;
}

export function pickGroundCell(sx: number, sy: number, cam: Camera): { gx: number; gy: number } {
  const g = screenToGround(sx, sy, cam);
  return { gx: Math.floor(g.x), gy: Math.floor(g.y) };
}
