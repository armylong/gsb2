import { formatPercent, formatSignedPercent, type MipChain, type LevelStats } from '../core/mips.ts';

function stat(label: string, value: string, tone?: 'bad' | 'good' | 'muted'): string {
  return `<div class="stat ${tone ? `stat--${tone}` : ''}"><span>${label}</span><strong>${value}</strong></div>`;
}

function histogramSvg(level: LevelStats, cutoff: number): string {
  const max = Math.max(1, ...level.histogram);
  const cutoffPercent = (cutoff / 256) * 100;
  const bars = level.histogram
    .map((count, bin) => {
      const left = bin * 16;
      const right = bin === 15 ? 256 : left + 16;
      const height = Math.max(count === 0 ? 2 : 4, (count / max) * 100);
      let state = 'hist-bar--below';
      if (left >= cutoff) state = 'hist-bar--above';
      else if (right > cutoff) state = 'hist-bar--partial';
      return `<div class="hist-bar ${state}" style="height:${height.toFixed(1)}%" title="alpha ${left}–${Math.min(255, right - 1)}: ${count} 像素"></div>`;
    })
    .join('');

  return `
    <div class="hist" role="img" aria-label="第 ${level.level} 层 alpha 直方图">
      <div class="hist-bars">${bars}</div>
      <div class="hist-cutoff" style="left:${cutoffPercent.toFixed(2)}%" title="裁切阈值 ${cutoff}"></div>
    </div>
    <div class="hist-labels"><span>0</span><span>α</span><span>255</span></div>
  `;
}

function levelCard(chain: MipChain, level: LevelStats, selectedLevel: number, currentLevel: number): string {
  const loss = level.clippedVsTarget > 0.0001;
  const deltaTone = level.deltaRatio < -0.0005 ? 'bad' : level.deltaRatio > 0.0005 ? 'good' : 'muted';
  const clipped = chain.mode === 'ordinary'
    ? stat('相对整数目标的裁切缺口', `${level.clippedVsTarget.toFixed(0)} 个本层像素`, loss ? 'bad' : 'good')
    : stat('面积再生目标', `${level.targetCount} / ${level.texels}`, 'good');

  return `
    <button
      type="button"
      class="level-card level-card--${chain.mode} ${level.level === selectedLevel ? 'is-selected' : ''} ${level.level === currentLevel ? 'is-current' : ''}"
      data-level="${level.level}"
      aria-pressed="${level.level === selectedLevel}"
    >
      <div class="level-head">
        <strong>L${level.level}</strong>
        <span>${level.width}×${level.height}</span>
        <span class="pass-badge ${loss ? 'pass-badge--loss' : ''}">通过 ${level.passCount}/${level.texels} · ${formatPercent(level.passRatio)}</span>
      </div>
      ${histogramSvg(level, chain.cutoff)}
      <div class="stat-grid">
        ${stat('原图通过比例', formatPercent(level.sourcePassRatio, 2), 'muted')}
        ${stat('连续期望', `${level.expectedCount.toFixed(2)} 像素`, 'muted')}
        ${stat('最近整数目标', `${level.targetCount} 像素`, 'muted')}
        ${stat('实际比例差', formatSignedPercent(level.deltaRatio, 2), deltaTone)}
        ${stat('等效原图面积差', `${level.equivalentSourceDelta >= 0 ? '+' : ''}${level.equivalentSourceDelta.toFixed(1)} px`, deltaTone)}
        ${clipped}
        ${stat('小图整数量化残差', `${level.quantizationResidual >= 0 ? '+' : ''}${level.quantizationResidual.toFixed(2)} 像素`, 'muted')}
      </div>
    </button>
  `;
}

export function renderChainPanel(
  element: HTMLElement,
  chain: MipChain,
  selectedLevel: number,
  currentLevel: number,
): void {
  element.innerHTML = `
    <div class="chain-summary chain-summary--${chain.mode}">
      <div>
        <h3>${chain.mode === 'ordinary' ? '普通 box 缩小层' : '面积目标再生层'}</h3>
        <p>${chain.mode === 'ordinary'
          ? '直接平均 alpha；RGB 已做透明底加权，因此这里诊断的是裁切/密度，不是脏边。'
          : '按原图通过面积做分位再生，强制最近整数数量的本层像素越过同一阈值。'}</p>
      </div>
      <div class="summary-figures">
        <span>原图通过 <strong>${chain.sourcePassCount}</strong> px</span>
        <span>比例 <strong>${formatPercent(chain.sourcePassRatio, 2)}</strong></span>
        <span>首次少叶层级 <strong>${chain.firstLossLevel === null ? '无' : `L${chain.firstLossLevel}`}</strong></span>
      </div>
    </div>
    <div class="level-list">
      ${chain.levels.map((level) => levelCard(chain, level, selectedLevel, currentLevel)).join('')}
    </div>
  `;
}

export function highlightCurrentLevel(element: HTMLElement, level: number): void {
  for (const card of element.querySelectorAll<HTMLElement>('.level-card')) {
    card.classList.toggle('is-current', Number(card.dataset.level) === level);
  }
}
