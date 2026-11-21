import type { SampleId } from './samples';
import type { SurfaceAnchor } from './types';

export const SCHEMA_VERSION = 1;

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov?: number;
}

export interface SavedWaypoint {
  id: string;
  name: string;
  anchor: SurfaceAnchor;
}

export interface SavedAnnotation {
  schemaVersion: number;
  sampleId: SampleId;
  savedAt: string;
  camera: CameraState;
  waypoints: SavedWaypoint[];
  /** 用户拖动过的网格顶点（相对程序生成形状的偏移） */
  vertexOffsets: Record<string, [number, number, number]>;
  /** 模型自身的旋转（欧拉角，弧度）。注意它和相机是两回事。 */
  modelRotation: [number, number, number];
  selectedWaypointId: string | null;
}

export interface SaveInput {
  sampleId: SampleId;
  camera: CameraState;
  waypoints: SavedWaypoint[];
  vertexOffsets: Record<string, [number, number, number]>;
  modelRotation?: [number, number, number];
  selectedWaypointId: string | null;
}

export function createSave(input: SaveInput): SavedAnnotation {
  return {
    schemaVersion: SCHEMA_VERSION,
    sampleId: input.sampleId,
    savedAt: new Date().toISOString(),
    camera: {
      position: [...input.camera.position] as [number, number, number],
      target: [...input.camera.target] as [number, number, number],
      up: [...input.camera.up] as [number, number, number],
      fov: input.camera.fov,
    },
    waypoints: input.waypoints.map((wp) => ({
      id: wp.id,
      name: wp.name,
      anchor: { tri: wp.anchor.tri, bary: [...wp.anchor.bary] as [number, number, number] },
    })),
    vertexOffsets: { ...input.vertexOffsets },
    modelRotation: input.modelRotation
      ? ([...input.modelRotation] as [number, number, number])
      : [0, 0, 0],
    selectedWaypointId: input.selectedWaypointId,
  };
}

export interface ValidationResult {
  ok: boolean;
  value?: SavedAnnotation;
  errors: string[];
  droppedWaypoints: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(isNum);

/**
 * 读取存档时的健壮性校验：
 * - 版本号、样例 id、相机字段必须合法；
 * - 非法锚点直接丢弃（返回 droppedWaypoints 计数），不让坏数据污染路线。
 */
export function parseSave(raw: unknown): ValidationResult {
  const errors: string[] = [];
  let droppedWaypoints = 0;

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['存档不是对象'], droppedWaypoints: 0 };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`不支持的存档版本: ${String(obj.schemaVersion)}`);
  }
  if (obj.sampleId !== 'curved-holey' && obj.sampleId !== 'twin-islands') {
    errors.push('未知的样例 id');
  }
  const camera = obj.camera as Record<string, unknown> | undefined;
  if (!camera || !isVec3(camera.position) || !isVec3(camera.target) || !isVec3(camera.up)) {
    errors.push('相机数据缺失或格式错误');
  }
  if (!Array.isArray(obj.waypoints)) {
    errors.push('waypoints 不是数组');
  }

  if (errors.length > 0) {
    return { ok: false, errors, droppedWaypoints: 0 };
  }

  const waypoints: SavedWaypoint[] = [];
  for (const rawWp of obj.waypoints as unknown[]) {
    if (typeof rawWp !== 'object' || rawWp === null) {
      droppedWaypoints++;
      continue;
    }
    const wp = rawWp as Record<string, unknown>;
    const anchor = wp.anchor as Record<string, unknown> | undefined;
    if (
      typeof wp.id !== 'string' ||
      !anchor ||
      !isNum(anchor.tri) ||
      !Array.isArray(anchor.bary) ||
      anchor.bary.length !== 3 ||
      !anchor.bary.every(isNum)
    ) {
      droppedWaypoints++;
      continue;
    }
    waypoints.push({
      id: wp.id,
      name: typeof wp.name === 'string' ? wp.name : `P${waypoints.length + 1}`,
      anchor: {
        tri: anchor.tri,
        bary: [anchor.bary[0], anchor.bary[1], anchor.bary[2]],
      },
    });
  }

  const vertexOffsets: Record<string, [number, number, number]> = {};
  const rawOffsets = obj.vertexOffsets;
  if (rawOffsets && typeof rawOffsets === 'object') {
    for (const [key, value] of Object.entries(rawOffsets as Record<string, unknown>)) {
      if (/^\d+$/.test(key) && isVec3(value)) vertexOffsets[key] = value;
    }
  }

  const cam = obj.camera as Record<string, unknown>;
  const annotation: SavedAnnotation = {
    schemaVersion: SCHEMA_VERSION,
    sampleId: obj.sampleId as SampleId,
    savedAt: typeof obj.savedAt === 'string' ? obj.savedAt : new Date(0).toISOString(),
    camera: {
      position: cam.position as [number, number, number],
      target: cam.target as [number, number, number],
      up: cam.up as [number, number, number],
      fov: isNum(cam.fov) ? cam.fov : undefined,
    },
    waypoints,
    vertexOffsets,
    modelRotation: isVec3(obj.modelRotation)
      ? (obj.modelRotation as [number, number, number])
      : [0, 0, 0],
    selectedWaypointId: typeof obj.selectedWaypointId === 'string' ? obj.selectedWaypointId : null,
  };

  return { ok: true, value: annotation, errors: [], droppedWaypoints };
}

export function serializeSave(annotation: SavedAnnotation): string {
  return JSON.stringify(annotation, null, 2);
}

export function deserializeSave(text: string): ValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`JSON 解析失败: ${(err as Error).message}`], droppedWaypoints: 0 };
  }
  return parseSave(raw);
}
