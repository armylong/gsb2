/** 深色单主题下的图表配色，与 app.css 的 CSS 变量一一对应。 */
export const CHART_COLORS = {
  surface: '#1a1a19',
  textPrimary: '#f0efec',
  textSecondary: '#c3c2b7',
  textMuted: '#898781',
  gridline: '#2c2c2a',
  baseline: '#383835',
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const,
  direct: '#3987e5',
  reversed: '#d95926',
  contested: '#d03b3b',
  warning: '#fab219',
} as const;

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

export function htmlEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clearNode(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export type Scale = (value: number) => number;

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export function logScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const d0 = Math.log10(Math.max(domain[0], Number.MIN_VALUE));
  const d1 = Math.log10(Math.max(domain[1], Number.MIN_VALUE));
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => {
    const v = Math.log10(Math.max(value, Number.MIN_VALUE));
    return r0 + ((v - d0) / span) * (r1 - r0);
  };
}

export function niceLogTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(Math.max(min, Number.MIN_VALUE)));
  const hi = Math.ceil(Math.log10(Math.max(max, Number.MIN_VALUE)));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) ticks.push(Math.pow(10, e));
  return ticks.filter((t) => t >= min * 0.999 && t <= max * 1.001);
}

export function niceLinearTicks(min: number, max: number, count = 5): number[] {
  const span = max - min || 1;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** 科学计数/紧凑数字格式化。 */
/** 对数轴刻度：整数优先，小于 1 用 10 的幂，避免 "100.00" 这类噪声。 */
export function formatLogTick(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const exp = Math.round(Math.log10(value));
  if (Math.abs(Math.log10(value) - exp) < 1e-9) {
    if (exp >= 0 && exp <= 4) return String(Math.round(value));
    return `1e${exp}`;
  }
  if (value >= 0.01 && value < 1000) return value.toPrecision(2).replace(/\.?0+$/, '');
  return value.toExponential(1);
}

export function formatNumber(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-3) {
    const exp = Math.floor(Math.log10(abs));
    const mantissa = value / Math.pow(10, exp);
    return `${mantissa.toFixed(Math.max(0, digits - 1))}e${exp}`;
  }
  if (abs >= 1000) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(2);
  return value.toFixed(digits);
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDistance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '未触发';
  return formatNumber(value, 4);
}

/** 生成折线路径（跳过非有限值）。 */
export function linePath(
  points: readonly { x: number; y: number }[],
  x: Scale,
  y: Scale,
): string {
  let path = '';
  let pen = false;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      pen = false;
      continue;
    }
    const px = x(point.x);
    const py = y(point.y);
    path += `${pen ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`;
    pen = true;
  }
  return path;
}

export interface TooltipHandle {
  node: HTMLDivElement;
  show: (html: HTMLElement, clientX: number, clientY: number) => void;
  hide: () => void;
  destroy: () => void;
}

/**
 * 图表浮层。用 DOM 节点拼装，名称等外部字符串一律走 textContent（不用 innerHTML）。
 */
export function createTooltip(): TooltipHandle {
  const node = htmlEl('div', 'chart-tooltip');
  node.hidden = true;
  document.body.appendChild(node);
  const show = (content: HTMLElement, clientX: number, clientY: number): void => {
    clearNode(node);
    node.appendChild(content);
    node.hidden = false;
    // 浮层挂在 body 上、position: fixed，因此直接用视口坐标。
    node.style.left = `${clientX}px`;
    node.style.top = `${clientY}px`;
  };
  const hide = (): void => {
    node.hidden = true;
  };
  const destroy = (): void => {
    node.remove();
  };
  return { node, show, hide, destroy };
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

export function tooltipContent(title: string, rows: readonly TooltipRow[]): HTMLElement {
  const wrapper = htmlEl('div');
  const heading = htmlEl('div', 'chart-tooltip__label', title);
  heading.style.marginBottom = '4px';
  wrapper.appendChild(heading);
  for (const row of rows) {
    const line = htmlEl('div', 'chart-tooltip__row');
    const label = htmlEl('span', 'chart-tooltip__label');
    if (row.color) {
      const key = htmlEl('span', 'chart-tooltip__key');
      key.style.background = row.color;
      label.appendChild(key);
    }
    label.appendChild(document.createTextNode(row.label));
    const value = htmlEl('span', 'chart-tooltip__value', row.value);
    line.append(label, value);
    wrapper.appendChild(line);
  }
  return wrapper;
}

export function legendItem(color: string, label: string, dot = false): HTMLElement {
  const item = htmlEl('span', 'chart-legend__item');
  const key = htmlEl('span', `chart-legend__key${dot ? ' chart-legend__key--dot' : ''}`);
  key.style.background = color;
  item.append(key, document.createTextNode(label));
  return item;
}

export function addGrid(
  parent: SVGElement,
  x: Scale,
  y: Scale,
  xTicks: readonly number[],
  yTicks: readonly number[],
  plot: { x0: number; x1: number; y0: number; y1: number },
): void {
  for (const tick of yTicks) {
    const py = y(tick);
    parent.appendChild(
      svgEl('line', {
        x1: plot.x0,
        x2: plot.x1,
        y1: py,
        y2: py,
        stroke: CHART_COLORS.gridline,
        'stroke-width': 1,
        'shape-rendering': 'crispEdges',
      }),
    );
  }
  for (const tick of xTicks) {
    const px = x(tick);
    parent.appendChild(
      svgEl('line', {
        x1: px,
        x2: px,
        y1: plot.y0,
        y2: plot.y1,
        stroke: CHART_COLORS.gridline,
        'stroke-width': 1,
        'shape-rendering': 'crispEdges',
      }),
    );
  }
}

export function addAxisLabels(
  parent: SVGElement,
  xTicks: readonly number[],
  yTicks: readonly number[],
  x: Scale,
  y: Scale,
  plot: { x0: number; x1: number; y0: number; y1: number },
  xFormat: (v: number) => string,
  yFormat: (v: number) => string,
  xLabel: string,
  yLabel: string,
): void {
  for (const tick of xTicks) {
    const text = svgEl('text', {
      x: x(tick),
      y: plot.y1 + 16,
      fill: CHART_COLORS.textMuted,
      'font-size': 10,
      'text-anchor': 'middle',
      'font-family': 'var(--font-mono)',
    });
    text.textContent = xFormat(tick);
    parent.appendChild(text);
  }
  for (const tick of yTicks) {
    const text = svgEl('text', {
      x: plot.x0 - 8,
      y: y(tick) + 3,
      fill: CHART_COLORS.textMuted,
      'font-size': 10,
      'text-anchor': 'end',
      'font-family': 'var(--font-mono)',
    });
    text.textContent = yFormat(tick);
    parent.appendChild(text);
  }
  const xTitle = svgEl('text', {
    x: (plot.x0 + plot.x1) / 2,
    y: plot.y1 + 34,
    fill: CHART_COLORS.textSecondary,
    'font-size': 10,
    'text-anchor': 'middle',
  });
  xTitle.textContent = xLabel;
  parent.appendChild(xTitle);
  const yTitleX = Math.max(10, plot.x0 - 58);
  const yTitle = svgEl('text', {
    x: yTitleX,
    y: (plot.y0 + plot.y1) / 2,
    fill: CHART_COLORS.textSecondary,
    'font-size': 10,
    'text-anchor': 'middle',
    transform: `rotate(-90 ${yTitleX} ${(plot.y0 + plot.y1) / 2})`,
  });
  yTitle.textContent = yLabel;
  parent.appendChild(yTitle);
  parent.appendChild(
    svgEl('line', {
      x1: plot.x0,
      x2: plot.x1,
      y1: plot.y1,
      y2: plot.y1,
      stroke: CHART_COLORS.baseline,
      'stroke-width': 1,
    }),
  );
}

/** 在 SVG 上挂一个跟随最近 X 的十字准线。 */
export function attachCrosshair(options: {
  svg: SVGSVGElement;
  overlay: SVGRectElement;
  plot: { x0: number; x1: number; y0: number; y1: number };
  x: Scale;
  domainX: readonly [number, number];
  tooltip: TooltipHandle;
  nearestX: (px: number) => number | null;
  buildRows: (value: number) => { title: string; rows: TooltipRow[] };
}): void {
  const { svg, overlay, plot, tooltip } = options;
  const hairline = svgEl('line', {
    y1: plot.y0,
    y2: plot.y1,
    stroke: CHART_COLORS.textSecondary,
    'stroke-width': 1,
    'stroke-opacity': 0.55,
    visibility: 'hidden',
    'pointer-events': 'none',
  });
  svg.appendChild(hairline);

  overlay.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = (event.clientX - rect.left) * (svg.viewBox.baseVal.width / rect.width);
    const nearest = options.nearestX(scaleX);
    if (nearest === null) {
      hairline.setAttribute('visibility', 'hidden');
      tooltip.hide();
      return;
    }
    const px = options.x(nearest);
    hairline.setAttribute('x1', String(px));
    hairline.setAttribute('x2', String(px));
    hairline.setAttribute('visibility', 'visible');
    const { title, rows } = options.buildRows(nearest);
    tooltip.show(tooltipContent(title, rows), event.clientX, event.clientY);
  });
  overlay.addEventListener('pointerleave', () => {
    hairline.setAttribute('visibility', 'hidden');
    tooltip.hide();
  });
}
