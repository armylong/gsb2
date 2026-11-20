import {
  CHART_COLORS,
  addAxisLabels,
  addGrid,
  attachCrosshair,
  clearNode,
  createTooltip,
  formatLogTick,
  formatNumber,
  htmlEl,
  legendItem,
  linePath,
  logScale,
  niceLogTicks,
  svgEl,
} from './svg';
import {
  type DepthMode,
  type StorageModel,
  depthStepWorld,
  geometricSchedule,
} from '../core/depthMath';

export interface PrecisionCurveSeries {
  key: string;
  label: string;
  color: string;
  mode: DepthMode;
  model: StorageModel;
  dashed?: boolean;
}

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 280;
const PLOT = { x0: 84, x1: VIEW_WIDTH - 20, y0: 16, y1: VIEW_HEIGHT - 58 };

/**
 * 精度曲线：每个深度码点在世界空间里对应多长距离（越小越精细）。
 * x = 视角距离，y = 世界步长，双对数。
 * 一条曲线只承载一个含义，因此不做双轴。
 */
export function renderPrecisionChart(
  host: HTMLElement,
  options: {
    near: number;
    far: number;
    startDistance: number;
    endDistance: number;
    curves: readonly PrecisionCurveSeries[];
  },
): void {
  clearNode(host);
  const { near, far } = options;
  const distances = geometricSchedule(options.startDistance, options.endDistance, 160).filter(
    (z) => z > near && z < far,
  );
  if (distances.length < 2) return;

  const seriesData = options.curves.map((curve) => ({
    curve,
    points: distances.map((z) => ({
      x: z,
      y: depthStepWorld(z, near, far, curve.mode, curve.model),
    })),
  }));

  let minY = Number.POSITIVE_INFINITY;
  let maxY = 0;
  for (const data of seriesData) {
    for (const point of data.points) {
      if (!Number.isFinite(point.y) || point.y <= 0) continue;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (!Number.isFinite(minY) || maxY <= 0) return;
  const pad = Math.pow(maxY / minY, 0.06);
  const yDomain: [number, number] = [minY / pad, maxY * pad];
  const xDomain: [number, number] = [distances[0], distances[distances.length - 1]];

  const x = logScale(xDomain, [PLOT.x0, PLOT.x1]);
  const y = logScale(yDomain, [PLOT.y1, PLOT.y0]);

  const legend = htmlEl('div', 'chart-legend');
  for (const data of seriesData) {
    legend.appendChild(legendItem(data.curve.color, data.curve.label));
  }
  host.appendChild(legend);

  const wrapper = htmlEl('div');
  wrapper.style.position = 'relative';
  host.appendChild(wrapper);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
    role: 'img',
    'aria-label': '深度精度曲线：每个深度码点对应的世界距离',
  });

  const xTicks = niceLogTicks(xDomain[0], xDomain[1]);
  const yTicks = niceLogTicks(yDomain[0], yDomain[1]);
  addGrid(svg, x, y, xTicks, yTicks, PLOT);
  addAxisLabels(
    svg,
    xTicks,
    yTicks,
    x,
    y,
    PLOT,
    formatLogTick,
    formatLogTick,
    '视角距离 z',
    '每个码点 ≈ 世界距离',
  );

  for (const data of seriesData) {
    svg.appendChild(
      svgEl('path', {
        d: linePath(data.points, x, y),
        fill: 'none',
        stroke: data.curve.color,
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': data.curve.dashed ? '6 5' : 'none',
        'stroke-opacity': data.curve.dashed ? 0.8 : 1,
      }),
    );
  }

  const overlay = svgEl('rect', {
    x: PLOT.x0,
    y: PLOT.y0,
    width: PLOT.x1 - PLOT.x0,
    height: PLOT.y1 - PLOT.y0,
    fill: 'transparent',
    style: 'cursor: crosshair',
  });
  svg.appendChild(overlay);
  wrapper.appendChild(svg);

  const nearestAxis = (px: number): number | null => {
    if (px < PLOT.x0 - 12 || px > PLOT.x1 + 12) return null;
    const targetLog = Math.log(xDomain[0]) + ((px - PLOT.x0) / (PLOT.x1 - PLOT.x0)) *
      (Math.log(xDomain[1]) - Math.log(xDomain[0]));
    return Math.exp(targetLog);
  };

  const tooltip = createTooltip();
  attachCrosshair({
    svg,
    overlay,
    plot: PLOT,
    x,
    domainX: xDomain,
    tooltip,
    nearestX: nearestAxis,
    buildRows: (value) => ({
      title: `z = ${formatNumber(value, 4)}`,
      rows: seriesData.map((data) => ({
        label: data.curve.label,
        value: formatNumber(depthStepWorld(value, near, far, data.curve.mode, data.curve.model), 3),
        color: data.curve.color,
      })),
    }),
  });

  // 表格视图：每个数量级取代表点，保证不依赖悬停即可读值。
  const tableRows = geometricSchedule(xDomain[0], xDomain[1], 12).map((z) => ({
    z,
    values: seriesData.map((data) => depthStepWorld(z, near, far, data.curve.mode, data.curve.model)),
  }));
  const table = buildPrecisionTable(options.curves, tableRows);
  table.hidden = true;
  table.dataset.role = 'precision-table';
  host.appendChild(table);
  host.dataset.tableReady = '1';
}

function buildPrecisionTable(
  curves: readonly PrecisionCurveSeries[],
  rows: readonly { z: number; values: number[] }[],
): HTMLElement {
  const wrap = htmlEl('div', 'table-host');
  const table = htmlEl('table');
  const thead = htmlEl('thead');
  const headRow = htmlEl('tr');
  headRow.appendChild(htmlEl('th', undefined, 'z'));
  for (const curve of curves) headRow.appendChild(htmlEl('th', undefined, curve.label));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = htmlEl('tbody');
  for (const row of rows) {
    const tr = htmlEl('tr');
    tr.appendChild(htmlEl('td', undefined, formatNumber(row.z, 3)));
    for (const value of row.values) tr.appendChild(htmlEl('td', undefined, formatNumber(value, 3)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

export const PRECISION_COLORS = {
  directFixed: CHART_COLORS.direct,
  reversedFixed: CHART_COLORS.reversed,
  directF32: CHART_COLORS.series[2],
  reversedF32: CHART_COLORS.series[3],
} as const;
