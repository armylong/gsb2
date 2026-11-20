import {
  CHART_COLORS,
  addAxisLabels,
  addGrid,
  attachCrosshair,
  clearNode,
  createTooltip,
  formatLogTick,
  formatNumber,
  formatPercent,
  htmlEl,
  legendItem,
  linePath,
  logScale,
  niceLogTicks,
  svgEl,
} from './svg';
import { GAP_LABELS } from '../core/labScene';
import type { ScanResult, TileOnset } from '../core/scan';

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 300;
const PLOT = { x0: 86, x1: VIEW_WIDTH - 20, y0: 16, y1: VIEW_HEIGHT - 60 };

export type ScanChartMode = 'direct' | 'reversed';

export interface ScanPanelInput {
  mode: ScanChartMode;
  result: ScanResult;
  /** 同一扫描配置下另一模式的结果，用于标出建议值 */
  reference?: { result: ScanResult; mode: ScanChartMode } | null;
}

export function renderScanChart(host: HTMLElement, input: ScanPanelInput): void {
  clearNode(host);
  const { result } = input;
  if (result.steps.length < 2) return;

  const distances = result.steps.map((s) => s.distance);
  const xDomain: [number, number] = [distances[0], distances[distances.length - 1]];
  let maxRatio = 0;
  for (const step of result.steps) for (const ratio of step.ratios) if (ratio > maxRatio) maxRatio = ratio;
  const yMax = Math.max(maxRatio * 1.15, 0.004);
  const x = logScale(xDomain, [PLOT.x0, PLOT.x1]);
  const y = (value: number) => PLOT.y1 - (Math.min(value, yMax) / yMax) * (PLOT.y1 - PLOT.y0);

  const legend = htmlEl('div', 'chart-legend');
  for (let i = 0; i < GAP_LABELS.length; i++) {
    legend.appendChild(legendItem(CHART_COLORS.series[i], `相对间距 ${GAP_LABELS[i]}`));
  }
  legend.appendChild(legendItem(CHART_COLORS.warning, '判定阈值', true));
  host.appendChild(legend);

  const wrapper = htmlEl('div');
  wrapper.style.position = 'relative';
  host.appendChild(wrapper);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
    role: 'img',
    'aria-label': '争抢像素比例随相机距离的变化',
  });

  const xTicks = niceLogTicks(xDomain[0], xDomain[1]);
  const yTicks = niceRatioTicks(yMax);
  addGrid(svg, x, y, xTicks, yTicks, PLOT);
  addAxisLabels(
    svg,
    xTicks,
    yTicks,
    x,
    y,
    PLOT,
    formatLogTick,
    (v) => formatPercent(v, 2),
    '相机距离 z',
    '争抢像素占比',
  );

  // 阈值参考线：实线细线，不用虚线（避免被读成“预测”）。
  const threshold = result.config.overlapThreshold;
  const ty = y(threshold);
  svg.appendChild(
    svgEl('line', {
      x1: PLOT.x0,
      x2: PLOT.x1,
      y1: ty,
      y2: ty,
      stroke: CHART_COLORS.warning,
      'stroke-width': 1,
      'stroke-opacity': 0.75,
    }),
  );
  const thresholdLabel = svgEl('text', {
    x: PLOT.x1,
    y: ty - 5,
    fill: CHART_COLORS.warning,
    'font-size': 10,
    'text-anchor': 'end',
    'font-family': 'var(--font-mono)',
  });
  thresholdLabel.textContent = `阈值 ${formatPercent(threshold, 2)}`;
  svg.appendChild(thresholdLabel);

  for (let i = 0; i < GAP_LABELS.length; i++) {
    const points = result.steps.map((step) => ({ x: step.distance, y: step.ratios[i] }));
    svg.appendChild(
      svgEl('path', {
        d: linePath(points, x, y),
        fill: 'none',
        stroke: CHART_COLORS.series[i],
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
  }

  // 起点标记：竖线 + 实心点（2px 表面色描边环，避免与折线糊在一起）。
  const onsetPoints: { onset: TileOnset; x: number; color: string }[] = [];
  for (const onset of result.onsets) {
    if (onset.measured === null) continue;
    const color = CHART_COLORS.series[onset.index];
    const px = x(onset.measured);
    svg.appendChild(
      svgEl('line', {
        x1: px,
        x2: px,
        y1: PLOT.y0,
        y2: PLOT.y1,
        stroke: color,
        'stroke-width': 1,
        'stroke-opacity': 0.45,
      }),
    );
    const py = y(threshold);
    svg.appendChild(
      svgEl('circle', {
        cx: px,
        cy: py,
        r: 4.5,
        fill: color,
        stroke: CHART_COLORS.surface,
        'stroke-width': 2,
      }),
    );
    onsetPoints.push({ onset, x: px, color });
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

  const tooltip = createTooltip();
  attachCrosshair({
    svg,
    overlay,
    plot: PLOT,
    x,
    domainX: xDomain,
    tooltip,
    nearestX: (px) => {
      if (px < PLOT.x0 - 12 || px > PLOT.x1 + 12) return null;
      const targetLog =
        Math.log(xDomain[0]) +
        ((px - PLOT.x0) / (PLOT.x1 - PLOT.x0)) * (Math.log(xDomain[1]) - Math.log(xDomain[0]));
      return Math.exp(targetLog);
    },
    buildRows: (value) => {
      let bestStep = result.steps[0];
      let bestDelta = Math.abs(Math.log(bestStep.distance / value));
      for (const step of result.steps) {
        const delta = Math.abs(Math.log(step.distance / value));
        if (delta < bestDelta) {
          bestDelta = delta;
          bestStep = step;
        }
      }
      return {
        title: `z = ${formatNumber(bestStep.distance, 4)}`,
        rows: bestStep.ratios.map((ratio, index) => ({
          label: `间距 ${GAP_LABELS[index]}`,
          value: `${formatPercent(ratio, 3)} (${bestStep.contestedPx[index]}px)`,
          color: CHART_COLORS.series[index],
        })),
      };
    },
  });

  // 直接标注起点（选择性：最多 5 个，全部是“极值/阈值事件”，不算每点标注）。
  const summary = htmlEl('div', 'chart-legend');
  summary.style.marginTop = '6px';
  for (const point of onsetPoints) {
    const label = htmlEl(
      'span',
      'chart-legend__item',
      `#${point.onset.index + 1} 起点 z≈${formatNumber(point.onset.measured ?? 0, 3)}`,
    );
    const key = htmlEl('span', 'chart-legend__key');
    key.style.background = point.color;
    label.prepend(key);
    summary.appendChild(label);
  }
  host.appendChild(summary);

  host.dataset.onsetCount = String(onsetPoints.length);
  buildScanTable(host, result);
}

function niceRatioTicks(max: number): number[] {
  const candidates = [0, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  const filtered = candidates.filter((v) => v === 0 || v <= max * 0.92);
  return filtered.length > 1 ? filtered : [0, max / 2];
}

function buildScanTable(host: HTMLElement, result: ScanResult): HTMLElement {
  const wrap = htmlEl('div', 'table-host');
  const table = htmlEl('table');
  const thead = htmlEl('thead');
  const head = htmlEl('tr');
  head.appendChild(htmlEl('th', undefined, 'z'));
  for (const label of GAP_LABELS) head.appendChild(htmlEl('th', undefined, `争抢 ${label}`));
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = htmlEl('tbody');
  for (const step of result.steps) {
    const tr = htmlEl('tr');
    tr.appendChild(htmlEl('td', undefined, formatNumber(step.distance, 4)));
    for (const ratio of step.ratios) {
      tr.appendChild(htmlEl('td', undefined, formatPercent(ratio, 3)));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.hidden = true;
  wrap.dataset.role = 'scan-table';
  host.appendChild(wrap);
  return wrap;
}
