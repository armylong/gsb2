import { CullFrame } from '../culling/cullController';
import { cameraPathAt, TOTAL_FRAMES } from '../scene/fixedPath';

export interface FrameRecord {
  frame: number;
  perMeshDrawn: number;
  perGroupDrawn: number;
  nativeDrawn: number | null;
  /** 按组策略下因组整体 out 被跳过的子对象数。 */
  skippedByGroup: number;
  groupStatus: Record<string, 'in' | 'intersect' | 'out'>;
  /** 每个 mesh 在逐物件策略下的判定，顺序与场景 meshes 一致；1=提交 0=剔除。 */
  perMeshMask: number[];
  /** 每个 mesh 在按组策略下是否提交。 */
  perGroupMask: number[];
  camera: ReturnType<typeof cameraPathAt>;
}

export interface CullReport {
  schemaVersion: 1;
  seed: number;
  totalFrames: number;
  generatedBy: 'browser' | 'headless';
  totals: {
    perMeshDrawn: number;
    perGroupDrawn: number;
    nativeDrawn: number | null;
    mismatchFrames: number;
    boundaryCrossingFrames: number;
  };
  frames: FrameRecord[];
}

export function createFrameRecord(
  frame: CullFrame,
  index: number,
  nativeDrawn: number | null,
  perMeshOrder: string[],
  perGroupOrder: string[],
): FrameRecord {
  const perMeshMask = new Array<number>(perMeshOrder.length).fill(0);
  const perGroupMask = new Array<number>(perGroupOrder.length).fill(0);
  const groupStatus: Record<string, 'in' | 'intersect' | 'out'> = {};

  for (const groupInfo of frame.groups) {
    groupStatus[groupInfo.groupEntity.id] = groupInfo.result.status;
    for (const member of groupInfo.members) {
      const meshIndex = perMeshOrder.indexOf(member.entity.id);
      const groupIndex = perGroupOrder.indexOf(member.entity.id);
      if (meshIndex >= 0) perMeshMask[meshIndex] = member.result.status === 'out' ? 0 : 1;
      if (groupIndex >= 0) perGroupMask[groupIndex] = member.drawn ? 1 : 0;
    }
  }

  return {
    frame: index,
    perMeshDrawn: frame.perMeshDrawn,
    perGroupDrawn: frame.perGroupDrawn,
    nativeDrawn,
    skippedByGroup: frame.skippedByGroupCount,
    groupStatus,
    perMeshMask,
    perGroupMask,
    camera: cameraPathAt(index),
  };
}

export function buildReport(
  seed: number,
  records: FrameRecord[],
  generatedBy: 'browser' | 'headless',
  nativeAvailable: boolean,
): CullReport {
  const totals = {
    perMeshDrawn: 0,
    perGroupDrawn: 0,
    nativeDrawn: 0 as number | null,
    mismatchFrames: 0,
    boundaryCrossingFrames: 0,
  };
  let nativeTotal = 0;
  for (const record of records) {
    totals.perMeshDrawn += record.perMeshDrawn;
    totals.perGroupDrawn += record.perGroupDrawn;
    if (record.nativeDrawn !== null) nativeTotal += record.nativeDrawn;
    if (record.perMeshDrawn !== record.perGroupDrawn) totals.mismatchFrames++;
    if (Object.values(record.groupStatus).includes('intersect')) {
      totals.boundaryCrossingFrames++;
    }
  }
  totals.nativeDrawn = nativeAvailable ? nativeTotal : null;
  return {
    schemaVersion: 1,
    seed,
    totalFrames: TOTAL_FRAMES,
    generatedBy,
    totals,
    frames: records,
  };
}

export function downloadReport(report: CullReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  anchor.href = url;
  anchor.download = `cull-report-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
