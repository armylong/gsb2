import { BuildSuccess, IntersectionParams } from './types';
import { validateParams } from './validate';
import { CheckResult } from './verify';

/** 导出文件结构：参数 + 道路网格 + 标线网格 + 统计，坐标与预览一致（世界坐标，米制单位）。 */
export function serializeExport(params: IntersectionParams, r: BuildSuccess): string {
  const data = {
    app: 'intersection-mesh-preview',
    version: 1,
    params,
    road: {
      positions: Array.from(r.positions),
      indices: Array.from(r.indices),
    },
    markings: {
      center: {
        positions: Array.from(r.centerMarkings.positions),
        indices: Array.from(r.centerMarkings.indices),
      },
      stop: {
        positions: Array.from(r.stopMarkings.positions),
        indices: Array.from(r.stopMarkings.indices),
      },
    },
    stats: {
      vertexCount: r.stats.vertexCount,
      triangleCount: r.stats.triangleCount,
      bboxMin: r.stats.bboxMin,
      bboxMax: r.stats.bboxMax,
    },
  };
  return JSON.stringify(data, null, 2);
}

/** 重新读取导出文本，核对规模与空间边界是否与文件内声明一致、数据是否有效。 */
export function verifyExportText(text: string): CheckResult[] {
  const checks: CheckResult[] = [];
  let data: ReturnType<typeof JSON.parse>;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return [{ name: '导出回读', ok: false, detail: `JSON 解析失败：${String(e)}` }];
  }

  const road = data?.road;
  const stats = data?.stats;
  const structureOk =
    data?.app === 'intersection-mesh-preview' &&
    Array.isArray(road?.positions) &&
    Array.isArray(road?.indices) &&
    Array.isArray(stats?.bboxMin) &&
    Array.isArray(stats?.bboxMax) &&
    data?.params != null;
  checks.push({
    name: '导出文件结构',
    ok: structureOk,
    detail: structureOk ? '包含参数、道路网格、标线与统计信息' : '文件结构不完整或缺少字段',
  });
  if (!structureOk) return checks;

  // 坐标有限性与索引有效性
  const pos: number[] = road.positions;
  const idx: number[] = road.indices;
  const finite = pos.every(Number.isFinite);
  const vCount = pos.length / 3;
  const idxValid = idx.every((i: number) => Number.isInteger(i) && i >= 0 && i < vCount);
  checks.push({
    name: '导出坐标与索引有效',
    ok: finite && idxValid && pos.length % 3 === 0 && idx.length % 3 === 0,
    detail:
      finite && idxValid
        ? `${vCount} 个顶点坐标均为有限值，${idx.length / 3} 个三角形索引均在范围内`
        : '存在非法坐标或越界索引',
  });

  // 规模核对
  const triCount = idx.length / 3;
  const countOk = vCount === stats.vertexCount && triCount === stats.triangleCount;
  checks.push({
    name: '回读规模核对',
    ok: countOk,
    detail: countOk
      ? `顶点 ${vCount}、三角形 ${triCount} 与导出统计一致`
      : `回读顶点 ${vCount}/${stats.vertexCount}、三角形 ${triCount}/${stats.triangleCount}`,
  });

  // 空间边界核对
  const bboxMin = [Infinity, Infinity, Infinity];
  const bboxMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      bboxMin[k] = Math.min(bboxMin[k], pos[i + k]);
      bboxMax[k] = Math.max(bboxMax[k], pos[i + k]);
    }
  }
  const eps = 1e-6;
  const bboxOk =
    bboxMin.every((v, k) => Math.abs(v - stats.bboxMin[k]) < eps) &&
    bboxMax.every((v, k) => Math.abs(v - stats.bboxMax[k]) < eps);
  checks.push({
    name: '回读空间边界核对',
    ok: bboxOk,
    detail: bboxOk
      ? `范围 X [${bboxMin[0].toFixed(2)}, ${bboxMax[0].toFixed(2)}]，Z [${bboxMin[2].toFixed(2)}, ${bboxMax[2].toFixed(2)}] 与导出统计一致`
      : '重新计算的包围盒与导出统计不一致',
  });

  // 参数合法性
  const paramErrors = validateParams(data.params);
  checks.push({
    name: '导出参数合法',
    ok: paramErrors.length === 0,
    detail: paramErrors.length === 0 ? '导出参数通过全部约束校验' : paramErrors.join('；'),
  });

  return checks;
}
