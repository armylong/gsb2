import type {
  ObjReadbackReport,
  RegionInspection,
  ThickenedSolid,
  ValidationReport,
} from '../core/types';
import type { WallReport } from '../core/diagnostics';
import type { RegressionReport } from '../core/regression';
import type { PresetCheckReport } from '../core/presets';
import { escapeHtml, fmt, fmtVec } from './dom';

export function renderValidationSummary(solid: ThickenedSolid): string {
  const v = solid.validation;
  const tone = v.valid ? 'ok' : 'bad';
  const title = v.valid ? '通过' : '未通过';
  const items = v.messages.map((message) => `<li>${escapeHtml(message)}</li>`).join('');
  return `<div class="validation-summary ${tone}"><strong>检查结果: ${title}</strong>`
    + `<div>三角形 ${solid.triangleCount} · 顶点 ${solid.vertexCount} · 体积 ${fmt(solid.volume, 4)}</div>`
    + `<ul>${items}</ul></div>`;
}

export function renderMetrics(solid: ThickenedSolid): string {
  const v: ValidationReport = solid.validation;
  const metrics: Array<{ label: string; value: string; tone?: 'ok' | 'bad' | 'warn' }> = [
    { label: '闭合', value: v.topology.closed ? '是' : '否', tone: v.topology.closed ? 'ok' : 'bad' },
    { label: '流形', value: v.topology.manifold ? '是' : '否', tone: v.topology.manifold ? 'ok' : 'bad' },
    {
      label: '欧拉示性数',
      value: String(v.topology.eulerCharacteristic),
      tone: v.topology.eulerCharacteristic === 0 || v.topology.eulerCharacteristic === 2 ? 'ok' : 'warn',
    },
    { label: '边界边', value: String(v.topology.boundaryEdgeCount), tone: v.topology.boundaryEdgeCount === 0 ? 'ok' : 'bad' },
    {
      label: '反折 / 坍缩',
      value: String(v.foldedOffsetTriangles.length),
      tone: v.foldedOffsetTriangles.length === 0 ? 'ok' : 'bad',
    },
    {
      label: '穿插点对',
      value: String(v.intersectionTotal) + (v.intersectionsTruncated ? '+' : ''),
      tone: v.intersectionTotal === 0 ? 'ok' : 'bad',
    },
    {
      label: '问题侧壁',
      value: `${solid.sideWalls.filter((wall) => wall.problem).length} / ${solid.sideWalls.length}`,
      tone: solid.sideWalls.some((wall) => wall.problem) ? 'bad' : 'ok',
    },
    {
      label: '偏移层自相交',
      value: String(v.intersectionCounts.offsetOffset),
      tone: v.intersectionCounts.offsetOffset === 0 ? 'ok' : 'bad',
    },
  ];
  return metrics
    .map((metric) => `<div class="metric"><div class="label">${metric.label}</div>`
      + `<div class="value ${metric.tone ?? ''}">${metric.value}</div></div>`)
    .join('');
}

export function renderIssueList(
  solid: ThickenedSolid,
  wallReport: WallReport,
): string {
  const parts: string[] = [];
  const v = solid.validation;

  if (v.foldedOffsetTriangles.length > 0) {
    const flipped = v.foldedOffsetTriangles.filter((issue) => issue.reason === 'flipped').length;
    const collapsed = v.foldedOffsetTriangles.length - flipped;
    parts.push(`<div class="issue"><strong>偏移层反折</strong>: 共 ${v.foldedOffsetTriangles.length} 个三角形 `
      + `(反折 ${flipped}, 坍缩 ${collapsed})。偏移面折回原始面一侧, 是"另一面网格插出来"的直接来源。`);
    for (const issue of v.foldedOffsetTriangles.slice(0, 4)) {
      parts.push(`<div class="issue"><span>源三角形 #${issue.sourceTriangle} · ${issue.reason === 'flipped' ? '反折' : '坍缩'} · 法线偏差 ${fmt(issue.angleDeg, 1)}° · 面积比 ${fmt(issue.areaRatio, 3)}</span>`
        + `<div class="meta">位置 ${fmtVec(issue.centroid)}</div>`
        + `<button type="button" data-focus-fold="${issue.sourceTriangle}">定位此三角形</button></div>`);
    }
    if (v.foldedOffsetTriangles.length > 4) {
      parts.push(`<div class="issue warn">其余 ${v.foldedOffsetTriangles.length - 4} 个反折三角形未逐条列出, 视图中已用红点标记。</div>`);
    }
  }

  if (v.intersectionTotal > 0) {
    const c = v.intersectionCounts;
    parts.push(`<div class="issue"><strong>穿插</strong>: 共 ${v.intersectionTotal} 对三角形相交 `
      + `(偏移-偏移 ${c.offsetOffset}, 偏移-侧壁 ${c.offsetSide}, 侧壁-侧壁 ${c.sideSide}, 原始-偏移 ${c.originalOffset})。`);
    for (const issue of v.intersections.slice(0, 3)) {
      const kinds: Record<string, string> = { original: '原始层', offset: '偏移层', side: '侧壁' };
      const detail = `${kinds[issue.aKind]} #${issue.aKind === 'side' ? `边 ${issue.aEdgeId}` : issue.aSourceTriangle}`
        + ` × ${kinds[issue.bKind]} #${issue.bKind === 'side' ? `边 ${issue.bEdgeId}` : issue.bSourceTriangle}`;
      const focus = issue.aKind !== 'side' && issue.aSourceTriangle >= 0
        ? `data-focus-fold="${issue.aSourceTriangle}"`
        : issue.aEdgeId >= 0 ? `data-focus-wall="${issue.aEdgeId}"` : '';
      parts.push(`<div class="issue"><span>${detail}</span><div class="meta">位置 ${fmtVec(issue.point)}</div>`
        + (focus ? `<button type="button" ${focus}>定位</button>` : '') + `</div>`);
    }
    if (v.intersections.length > 3) {
      parts.push(`<div class="issue warn">仅列出前 3 处, 其余位置在视图中以红点显示${v.intersectionsTruncated ? ' (已达上限)' : ''}。</div>`);
    }
  }

  if (wallReport.problem.length > 0) {
    parts.push(`<div class="issue warn"><strong>问题侧壁</strong>: ${wallReport.problem.length} 段 `
      + `(外缘 ${wallReport.problemOuter}, 孔 ${wallReport.problemHole}; `
      + `翻转 ${wallReport.byReason.flipped}, 相交 ${wallReport.byReason.intersects}, 退化 ${wallReport.byReason.degenerate})。`
      + `<div class="meta">点击边号可在视图中高亮它对应的原始边</div><div>`
      + wallReport.problem.slice(0, 24).map((wall) => `<span class="wall-chip" data-focus-wall="${wall.edgeId}">边 ${wall.edgeId}</span>`).join('')
      + `</div></div>`);
  }

  if (parts.length === 0) {
    parts.push('<div class="issue ok">未发现问题三角形或侧壁, 偏移层与侧壁均正常。</div>');
  }

  return parts.join('');
}

export function renderRegionReport(inspection: RegionInspection): string {
  const rows: Array<[string, string]> = [
    ['三角形 / 顶点', `${inspection.triangleCount} / ${inspection.vertexCount}`],
    ['名义厚度', fmt(inspection.nominalThickness, 4)],
    ['配对间距', `${fmt(inspection.pairedDistanceMin, 4)} ~ ${fmt(inspection.pairedDistanceMax, 4)}`],
    ['实测间隙 min / 均值 / max', `${fmt(inspection.measuredMin, 4)} / ${fmt(inspection.measuredMean, 4)} / ${fmt(inspection.measuredMax, 4)}`],
    ['法线偏差 均值 / max', `${fmt(inspection.meanNormalDeviationDeg, 1)}° / ${fmt(inspection.maxNormalDeviationDeg, 1)}°`],
    ['面积比 min / max', `${fmt(inspection.areaRatioMin, 3)} / ${fmt(inspection.areaRatioMax, 3)}`],
    ['翻转三角形', String(inspection.flippedTriangleCount)],
    ['已标记问题三角形', String(inspection.problemTriangleCount)],
    ['源法线 / 偏移法线', `${fmtVec(inspection.baseNormal)} / ${fmtVec(inspection.topNormal)}`],
  ];
  const warning = inspection.flippedTriangleCount > 0 || inspection.measuredMin < inspection.nominalThickness * 0.35
    ? '<div class="issue"><strong>该区域厚度不足</strong>: 实测间隙明显小于名义厚度, 偏移面已贴近或穿入原始面。</div>'
    : '';
  return warning + `<dl class="kv">${rows.map(([k, val]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd>`).join('')}</dl>`;
}

export function renderObjReport(report: ObjReadbackReport): string {
  const tone = report.valid ? 'ok' : 'bad';
  const rows: Array<[string, string]> = [
    ['顶点 / 三角形', `${report.vertexCount} / ${report.triangleCount}`],
    ['闭合', report.topology.closed ? '是' : '否'],
    ['流形', report.topology.manifold ? '是' : '否'],
    ['边界边', String(report.topology.boundaryEdgeCount)],
    ['欧拉示性数', String(report.topology.eulerCharacteristic)],
    ['穿插点对', String(report.intersectionPairs)],
    ['包围盒中心', report.bbox ? fmtVec(report.bbox.center) : '—'],
    ['分组', report.groups.join(', ') || '—'],
  ];
  return `<div class="validation-summary ${tone}"><strong>读回复核: ${report.valid ? '通过' : '未通过'}</strong>`
    + `<ul>${report.messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></div>`
    + `<dl class="kv">${rows.map(([k, val]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd>`).join('')}</dl>`;
}

export function renderRegression(report: RegressionReport): string {
  const tone = report.pass ? 'ok' : 'bad';
  const rows: Array<[string, string]> = [
    ['源网格指纹', report.steps[0]?.sourceHash ?? '—'],
    ['原始层顶点最大偏差', report.sourceLayerVertexMaxDelta.toExponential(2)],
    ['恢复后与初始三角形数', `${report.restoredTriangleCount} / ${report.referenceTriangleCount}`],
    ['偏移层最大差异', report.offsetLayerMaxDelta.toExponential(2)],
  ];
  const steps = report.steps.map((step) => `<li>${escapeHtml(step.label)}: 厚度 ${fmt(step.thickness, 3)}, `
    + `源网格未变 ${step.sourceLayerIntact ? '✓' : '✗'}</li>`).join('');
  return `<div class="validation-summary ${tone}"><strong>回归: ${report.pass ? '通过' : '失败'}</strong>`
    + `<ul>${report.messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}${steps}</ul>`
    + `<dl class="kv">${rows.map(([k, val]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd>`).join('')}</dl></div>`;
}

export function renderPresetCheck(report: PresetCheckReport): string {
  const tone = report.pass ? 'ok' : 'bad';
  const rows = report.results.map((result) => `
    <div class="issue ${result.matchesExpectation ? '' : 'warn'}" style="border-color:${result.matchesExpectation ? 'rgba(79,195,161,.35)' : 'rgba(255,180,84,.4)'};background:${result.matchesExpectation ? 'rgba(79,195,161,.05)' : 'rgba(255,180,84,.07)'};color:${result.matchesExpectation ? '#c7f0e4' : '#ffe4c2'}">
      <strong>${escapeHtml(result.preset.label)}</strong> · 预期${result.preset.expectValid ? '有效' : '无效'} / 实际${result.valid ? '有效' : '无效'}
      <div class="meta">闭合 ${result.closed ? '是' : '否'} · 流形 ${result.manifold ? '是' : '否'} · 反折 ${result.foldedTriangles} · 穿插 ${result.intersectionTotal} · 问题侧壁 ${result.problemWalls}</div>
      <div class="meta">${escapeHtml(result.summary)}</div>
    </div>`).join('');
  return `<div class="validation-summary ${tone}"><strong>内置参数: ${report.pass ? '全部符合预期' : '存在偏差'}</strong>`
    + `<ul>${report.messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></div>${rows}`;
}
