/**
 * 误差趋势图：固定保留比例档位下的 max / RMS 采样误差。
 * 纯 SVG + HTML 表格，无外部图表库。
 * 颜色取自经 dataviz 校验的暗色面板蓝 #3987e5 / 橙 #d95926；
 * 两条线带直接图例与表格视图，标识不只依赖颜色。
 */

export interface TrendRow {
  ratio: number; // 保留比例（1 = 不简化参照）
  triangles: number;
  max: number;
  rms: number;
  reached: boolean;
  reference?: boolean; // true = 不简化零误差参照
}

const COLOR_MAX = '#d95926';
const COLOR_RMS = '#3987e5';
const INK_MUTED = '#898781';
const GRID = '#2c2c2a';
const INK = '#f0efec';
const INK_2 = '#c3c2b7';

export function renderTrend(container: HTMLElement, rows: TrendRow[], currentRatio: number): void {
  if (rows.length === 0) {
    container.innerHTML = '<p class="muted">暂无趋势数据</p>';
    return;
  }
  const width = 320;
  const height = 150;
  const padL = 44;
  const padR = 10;
  const padT = 12;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const ratios = rows.map((r) => r.ratio);
  const minX = Math.min(...ratios);
  const maxX = Math.max(...ratios);
  const maxY = Math.max(rows[0].max, ...rows.map((r) => r.max)) || 1;
  const xOf = (ratio: number) =>
    padL + ((ratio - minX) / Math.max(1e-9, maxX - minX)) * plotW;
  const yOf = (value: number) => padT + plotH - (value / maxY) * plotH;

  const pathFor = (key: 'max' | 'rms') =>
    rows
      .map((r, i) => `${i === 0 ? 'M' : 'L'} ${xOf(r.ratio).toFixed(1)} ${yOf(r[key]).toFixed(1)}`)
      .join(' ');

  const yTicks = 4;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const value = (maxY / yTicks) * i;
    const y = yOf(value);
    return `
      <line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="${GRID}" stroke-width="1"/>
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="${INK_MUTED}">${value.toFixed(3)}</text>`;
  }).join('');

  const xLabels = rows
    .map(
      (r) =>
        `<text x="${xOf(r.ratio).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="9" fill="${INK_MUTED}">${Math.round(r.ratio * 100)}%</text>`,
    )
    .join('');

  const dots = (key: 'max' | 'rms', color: string) =>
    rows
      .map(
        (r) =>
          `<circle cx="${xOf(r.ratio).toFixed(1)}" cy="${yOf(r[key]).toFixed(1)}" r="3" fill="${color}" stroke="#1a1a19" stroke-width="1">
             <title>保留 ${Math.round(r.ratio * 100)}% · ${key === 'max' ? '最大' : 'RMS'} ${r[key].toExponential(2)}</title>
           </circle>`,
      )
      .join('');

  const currentMark = (() => {
    const x = xOf(currentRatio);
    return `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${padT + plotH}" stroke="${INK_2}" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`;
  })();

  container.innerHTML = `
    <div class="trend-legend">
      <span class="legend-item"><span class="dot" style="background:${COLOR_MAX}"></span>最大距离 max</span>
      <span class="legend-item"><span class="dot" style="background:${COLOR_RMS}"></span>均方根 RMS</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" class="trend-svg" role="img" aria-label="误差随保留比例变化趋势">
      ${gridLines}
      ${currentMark}
      <path d="${pathFor('max')}" fill="none" stroke="${COLOR_MAX}" stroke-width="2"/>
      <path d="${pathFor('rms')}" fill="none" stroke="${COLOR_RMS}" stroke-width="2"/>
      ${dots('max', COLOR_MAX)}
      ${dots('rms', COLOR_RMS)}
      ${xLabels}
      <text x="${padL}" y="${height - 0.5}" font-size="9" fill="${INK_MUTED}"></text>
    </svg>
    <table class="trend-table">
      <thead>
        <tr><th>保留比例</th><th>实际面数</th><th>max</th><th>RMS</th><th>达标</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr${Math.abs(r.ratio - currentRatio) < 1e-9 ? ' class="current"' : ''}>
            <td>${r.reference ? '不简化' : Math.round(r.ratio * 100) + '%'}</td>
            <td>${r.triangles.toLocaleString()}</td>
            <td style="color:${COLOR_MAX}">${r.max.toExponential(3)}</td>
            <td style="color:${COLOR_RMS}">${r.rms.toExponential(3)}</td>
            <td>${r.reference ? '—' : r.reached ? '是' : '否'}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <p class="muted small">纵轴为采样距离（归一化坐标单位）。虚线为当前选择的比例；数值与上方读数采用同一固定采样规则。</p>
    <span style="display:none">${INK}</span>`;
}
