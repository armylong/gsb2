import {
  CATCHUP_MAX_RECOVERABLE_GAP_SEC,
  RECOVERY_STABLE_SEC,
  SYNC_TOLERANCE_SEC,
} from '../core/config';
import { deriveState } from '../core/derive';
import { formatClock, formatMs, formatSec, frameFromPts } from '../core/format';
import { buildTimelineItems } from '../core/timeline';
import { HEALTH_LABEL } from '../core/labels';
import type {
  ActualRouteState,
  Cue,
  SimState,
  SwitchEvidence,
  SwitchRecord,
  TimelineItem,
} from '../core/types';
import type { LayoutRefs, SourceRefs } from './layout';

export interface ViewModel {
  selectedSwitchId: string | null;
  evidence: Map<string, SwitchEvidence>;
  mediaReady: boolean;
  loadError: string | null;
}

export function renderLists(
  refs: LayoutRefs,
  cues: Cue[],
  duration: number,
  selectedSwitchId: string | null,
): TimelineItem[] {
  const fullState = deriveState({ cues, duration, time: duration, scenarioId: 'manual' });
  const items = buildTimelineItems(cues, fullState);

  refs.markers.innerHTML = items
    .map(
      item => `
      <button type="button"
        class="timeline-marker ${item.category} ${item.tone}"
        style="left:${(item.at / duration) * 100}%"
        data-at="${item.at}"
        data-switch-id="${item.switchId ?? ''}"
        title="${formatClock(item.at)} · ${item.title}"></button>`,
    )
    .join('');

  refs.eventList.innerHTML = items
    .map(
      item => `
      <button type="button" class="event-item"
        data-at="${item.at}"
        data-switch-id="${item.switchId ?? ''}"
        data-key="${item.key}">
        <span class="event-time">${formatClock(item.at)}</span>
        <span class="event-dot ${item.tone}"></span>
        <span>
          <span class="event-title">${item.title}</span>
          ${item.detail ? `<div class="event-detail">${item.detail}</div>` : ''}
        </span>
      </button>`,
    )
    .join('');

  updateListSelection(refs, { time: 0 } as SimState, selectedSwitchId);
  return items;
}

export function updateListSelection(
  refs: LayoutRefs,
  state: SimState,
  selectedSwitchId: string | null,
): void {
  refs.markers.querySelectorAll<HTMLElement>('.timeline-marker').forEach(marker => {
    const at = Number(marker.dataset.at);
    marker.classList.toggle('future', at > state.time + 0.03);
    marker.classList.toggle('active-marker', marker.dataset.switchId === selectedSwitchId);
  });
  refs.eventList.querySelectorAll<HTMLElement>('.event-item').forEach(item => {
    const at = Number(item.dataset.at);
    item.classList.toggle('future', at > state.time + 0.03);
    item.classList.toggle('active', item.dataset.switchId === selectedSwitchId);
  });
}

function setClass(element: HTMLElement, tone: 'good' | 'warn' | 'bad' | ''): void {
  element.classList.remove('good', 'warn', 'bad');
  if (tone) element.classList.add(tone);
}

function renderSource(
  sourceRefs: SourceRefs,
  state: SimState,
  actual: ActualRouteState,
): void {
  const source = state.sources[sourceRefs.card.dataset.sourceCard as 'A' | 'B'];
  sourceRefs.card.classList.toggle('on-air', state.output === source.id);
  sourceRefs.card.classList.toggle('locked', state.lock === source.id);

  const confirming = source.badSince !== null && !source.confirmedBad;
  sourceRefs.health.textContent =
    source.health === 'ok'
      ? HEALTH_LABEL.ok
      : `${HEALTH_LABEL[source.health]}${confirming ? '·确认中' : ''}`;
  sourceRefs.health.className = `source-state ${source.health}`;

  sourceRefs.pausedBadge.hidden = !actual.paused;
  sourceRefs.pausedBadge.textContent =
    source.health === 'offline' ? 'NO SIGNAL · 模拟掉线' : '已暂停 / 定格检查';

  sourceRefs.actual.textContent = `${actual.currentTime.toFixed(3)}s`;
  sourceRefs.pts.textContent = `${source.pts.toFixed(3)}s · F${String(frameFromPts(source.pts)).padStart(4, '0')}`;

  sourceRefs.gap.textContent = formatMs(source.gapSec * 1000);
  setClass(
    sourceRefs.gap,
    Math.abs(source.gapSec) > 0.5 ? 'bad' : Math.abs(source.gapSec) > SYNC_TOLERANCE_SEC ? 'warn' : 'good',
  );

  sourceRefs.rate.textContent = `${source.rate}× / r${actual.readyState}`;
  sourceRefs.rate.title = `实测 playbackRate=${actual.playbackRate}, networkState=${actual.networkState}, ${actual.videoWidth}x${actual.videoHeight}`;

  sourceRefs.stable.textContent = `${source.stableSec.toFixed(2)}s / ${RECOVERY_STABLE_SEC}s`;
  setClass(sourceRefs.stable, source.stableSec >= RECOVERY_STABLE_SEC ? 'good' : 'warn');

  sourceRefs.playState.textContent = actual.seeking
    ? 'seeking…'
    : actual.paused
      ? 'paused'
      : `playing ${actual.playbackRate}×`;
  setClass(sourceRefs.playState, actual.paused ? 'warn' : 'good');

  const cu = source.catchUp;
  if (cu?.active) {
    const ahead = cu.initialGapMs > 0;
    sourceRefs.catchup.textContent = cu.impossible
      ? ahead
        ? `无法快进消除正偏差：源超前 ${formatMs(cu.initialGapMs)}，请硬对齐`
        : `追不上：落后 ${formatMs(cu.initialGapMs)}，超过 ${CATCHUP_MAX_RECOVERABLE_GAP_SEC.toFixed(1)}s 可恢复范围，预计 ${cu.estimatedSec.toFixed(1)}s`
      : cu.late
        ? `已超过 ${cu.deadlineSec.toFixed(1)}s 窗口，仍在 ${cu.rate}× 追赶`
        : `${cu.rate}× 追赶中 · 差距 ${formatMs(cu.initialGapMs)} · 预计 ${cu.estimatedSec.toFixed(2)}s`;
    setClass(sourceRefs.catchup, cu.impossible || cu.late ? 'bad' : 'warn');
  } else if (cu?.mode === 'seek' && cu.completedAt !== undefined) {
    sourceRefs.catchup.textContent = `已硬对齐 ${formatMs(cu.initialGapMs)} @ ${formatSec(cu.completedAt)}`;
    setClass(sourceRefs.catchup, Math.abs(cu.initialGapMs) > CATCHUP_MAX_RECOVERABLE_GAP_SEC * 1000 ? 'warn' : 'good');
  } else if (cu && !cu.active && cu.completedAt !== undefined) {
    sourceRefs.catchup.textContent = cu.deadlineMissed
      ? `已追上，但超过 ${cu.deadlineSec.toFixed(1)}s 稳定窗口 @ ${formatSec(cu.completedAt)}`
      : `追赶完成 @ ${formatSec(cu.completedAt)}`;
    setClass(sourceRefs.catchup, cu.deadlineMissed ? 'bad' : 'good');
  } else {
    sourceRefs.catchup.textContent = '—';
    setClass(sourceRefs.catchup, '');
  }

  const alignment = source.lastAlignment;
  if (alignment) {
    sourceRefs.alignment.textContent = `${formatClock(alignment.at)} ${formatMs(alignment.deltaMs)} → ${alignment.toPts.toFixed(3)}s`;
    setClass(sourceRefs.alignment, Math.abs(alignment.deltaMs) > 1 ? 'warn' : 'good');
  }

  sourceRefs.buttons.stall.classList.toggle('active', source.health === 'stalled');
  sourceRefs.buttons.drop.classList.toggle('active', source.health === 'offline');
}

function chooseFeedback(state: SimState, model: ViewModel): { tone: string; text: string } {
  if (model.loadError) return { tone: 'error', text: `媒体加载失败：${model.loadError}` };
  if (!model.mediaReady) return { tone: 'warn', text: '两段视频正在加载/缓冲；可先查看脚本与规则。' };

  const impossible = Object.values(state.sources).find(
    s => s.catchUp?.active && (s.catchUp.impossible || s.catchUp.late),
  );
  const missedDeadline = Object.values(state.sources).find(s => s.catchUp?.deadlineMissed && !s.catchUp.active);
  if (state.programState === 'no-source') {
    return {
      tone: 'error',
      text: '两路均不可用：节目 Canvas 保留最后帧并压暗，显示 NO SIGNAL。时间轴继续前进，恢复时刻由脚本确定性触发。',
    };
  }
  if (state.programState === 'locked-bad') {
    return {
      tone: 'error',
      text: `已锁定 ${state.lock} 路，但该路当前故障。按规则不自动切走；可检查两路状态后点“取消锁定”。`,
    };
  }
  if (impossible) {
    return {
      tone: 'error',
      text: `${impossible.id} 路差距 ${formatMs(impossible.catchUp?.initialGapMs ?? 0)}，${impossible.catchUp?.impossible ? '超过' : '已超过'} ${CATCHUP_MAX_RECOVERABLE_GAP_SEC.toFixed(1)}s 可追赶范围/2.5s 窗口，无法在稳定时限内追上；请硬对齐或切到另一路。`,
    };
  }
  if (missedDeadline?.catchUp) {
    return {
      tone: 'warn',
      text: `${missedDeadline.id} 路虽已追上，但用时超过 ${missedDeadline.catchUp.deadlineSec.toFixed(1)}s 稳定窗口；该次恢复不应被当作快速稳定恢复。`,
    };
  }
  if (state.programState === 'confirming' && state.output) {
    return {
      tone: 'warn',
      text: `${state.output} 路故障正在确认（掉线 450ms / 停顿 650ms），确认后才执行切换以避免抖动。`,
    };
  }
  const selected = state.switches.find(s => s.id === model.selectedSwitchId);
  if (selected?.nearby === false) {
    return { tone: 'warn', text: `切换时间差 ${formatMs(selected.deltaBeforeMs)} 超过 1s“邻近帧”阈值；已记录为非邻近切换并尝试对齐。` };
  }
  return { tone: 'good', text: '实际视频与确定性核心正在同步；可暂停并拖动到故障前后逐帧检查两路 currentTime、readyState 与画面帧号。' };
}

export function updateHud(
  refs: LayoutRefs,
  state: SimState,
  actual: Record<'A' | 'B', ActualRouteState>,
  model: ViewModel,
  playing: boolean,
): void {
  refs.playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
  refs.timeline.value = state.time.toFixed(2);
  refs.currentTime.textContent = formatClock(state.time);
  refs.durationTime.textContent = formatClock(state.duration);
  refs.timeline.max = state.duration.toFixed(2);
  refs.progress.style.width = `${(state.time / state.duration) * 100}%`;

  for (const id of ['A', 'B'] as const) {
    renderSource(refs.sources[id], state, actual[id]);
  }

  if (state.lock === 'auto' && state.output) {
    refs.onAirBadge.textContent = `ON AIR · ${state.output}`;
    refs.onAirBadge.className = 'onair';
  } else if (state.lock !== 'auto') {
    refs.onAirBadge.textContent = `LOCKED · ${state.lock}`;
    refs.onAirBadge.className = 'onair lock';
  } else {
    refs.onAirBadge.textContent = 'NO PROGRAM';
    refs.onAirBadge.className = 'onair off';
  }

  refs.banner.classList.toggle('hidden', state.programState !== 'no-source' && state.programState !== 'locked-bad');
  if (state.programState === 'no-source') {
    refs.bannerTitle.textContent = 'NO SIGNAL';
    refs.bannerText.textContent = '主路与备路先后不可用；没有可验证的健康帧。等待任一路恢复。';
  } else if (state.programState === 'locked-bad') {
    refs.bannerTitle.textContent = `${state.lock} 路锁定故障`;
    refs.bannerText.textContent = '自动切换已被手动锁定抑制；可取消锁定恢复自动选举。';
  }

  const outputPts = state.output ? state.sources[state.output].pts : state.lastOutput ? state.sources[state.lastOutput].pts : 0;
  refs.programClock.textContent = `TL ${formatClock(state.time)} / PTS ${outputPts.toFixed(3)}`;
  const outputActual = state.output ? actual[state.output] : state.lastOutput ? actual[state.lastOutput] : null;
  refs.programMeta.textContent = outputActual
    ? `实测 ${state.output ?? state.lastOutput} video.currentTime=${outputActual.currentTime.toFixed(3)}s · readyState=${outputActual.readyState} · ${outputActual.videoWidth}×${outputActual.videoHeight}`
    : '无实际视频元素状态';

  const feedback = chooseFeedback(state, model);
  refs.feedback.className = `feedback ${feedback.tone}`;
  refs.feedback.textContent = feedback.text;

  Object.entries(refs.lockButtons).forEach(([lock, button]) => {
    button.classList.toggle('active', state.lock === lock);
  });
  Object.entries(refs.scenarioButtons).forEach(([id, button]) => {
    button.classList.toggle('active', state.scenarioId === id);
  });

  updateListSelection(refs, state, model.selectedSwitchId);
  renderDetailBottom(refs, state);
}

function deltaCard(title: string, value: string, tone: 'good' | 'warn' | 'bad' | ''): string {
  return `<div class="delta-card"><div class="k">${title}</div><div class="v ${tone}">${value}</div></div>`;
}

export function renderDetail(
  refs: LayoutRefs,
  state: SimState,
  model: ViewModel,
  allRecords: SwitchRecord[] = state.switches,
): void {
  const record =
    allRecords.find(s => s.id === model.selectedSwitchId) ?? state.switches[state.switches.length - 1];
  if (!record) {
    refs.detail.innerHTML = '<div class="hint">暂无切换记录。</div>';
    return;
  }
  const evidence = model.evidence.get(record.id);
  const coreTone = Math.abs(record.deltaBeforeMs ?? 0) > 1000 ? 'bad' : Math.abs(record.deltaBeforeMs ?? 0) > SYNC_TOLERANCE_SEC * 1000 ? 'warn' : 'good';
  const actualTone = Math.abs(evidence?.actualDeltaBeforeMs ?? 0) > 250 ? 'warn' : 'good';

  refs.detail.innerHTML = `
    <div class="switch-detail" data-switch-detail="${record.id}">
      <div><strong>${record.title}</strong> <span class="hint">@ ${formatClock(record.at)} · ${record.id}</span></div>
      <div class="hint">${record.rule}</div>
      <div class="delta-grid">
        ${deltaCard('核心模拟 Δ前', formatMs(record.deltaBeforeMs), coreTone)}
        ${deltaCard('核心对齐 Δ后', formatMs(record.deltaAfterMs), 'good')}
        ${deltaCard('实测 video Δ前', evidence ? formatMs(evidence.actualDeltaBeforeMs) : '待播放采集', evidence ? actualTone : '')}
        ${deltaCard('实测 seek 后 Δ', evidence?.settled ? formatMs(evidence.actualDeltaAfterMs) : evidence ? 'seek 中…' : '未采集', evidence?.settled ? 'good' : 'warn')}
      </div>
      <div class="detail-row"><div class="k">from → to</div><div>${record.from ?? '—'} → ${record.to ?? '无输出'}</div></div>
      <div class="detail-row"><div class="k">目标 PTS</div><div>${formatSec(record.targetPts, 3)}；from 最后有效 ${formatSec(record.fromPts, 3)}；to 切换前 ${formatSec(record.toPtsBefore, 3)}</div></div>
      <div class="detail-row"><div class="k">邻近帧判定</div><div class="${record.nearby === false ? 'bad' : 'good'}">${record.nearby === false ? '超过 1s，不算邻近帧' : '在 1s 邻近阈值内'}</div></div>
      ${record.simultaneousRecovery ? '<div class="feedback info">已识别为同一时刻双路恢复；按并列规则选举 A。</div>' : ''}
      ${evidence ? `<div class="hint" data-evidence-occurrences="${evidence.occurrences}">已从真实 &lt;video&gt; 采集 ${evidence.occurrences} 次复现；before=${evidence.actualToBefore?.toFixed(3) ?? '—'}s, after=${evidence.actualToAfter?.toFixed(3) ?? '—'}s</div>` : ''}
      <button type="button" class="primary" data-reproduce-at="${Math.max(0, record.at - 0.85).toFixed(2)}">从该切换前 0.85s 复现</button>
    </div>`;
}

function renderDetailBottom(refs: LayoutRefs, state: SimState): void {
  const rows = (['A', 'B'] as const)
    .map(id => {
      const s = state.sources[id];
      return `<tr>
        <td><strong>${id}</strong> ${s.role}</td>
        <td>${HEALTH_LABEL[s.health]}${s.confirmedBad ? '(已确认)' : s.badSince ? '(确认中)' : ''}</td>
        <td>${formatMs(s.gapSec * 1000)}</td>
        <td>${s.stableSec.toFixed(2)}s</td>
        <td>${s.catchUp?.active ? `${s.catchUp.rate}×` : s.rate === 1 ? '1×' : `${s.rate}×`}</td>
      </tr>`;
    })
    .join('');
  refs.detailBottom.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px">
      <thead><tr style="color:var(--muted)"><th style="text-align:left;padding:5px">路由</th><th style="text-align:left">健康</th><th style="text-align:left">差值</th><th style="text-align:left">稳定</th><th style="text-align:left">速率</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="hint">当前选举输出：<strong style="color:#a7f3d0">${state.output ?? 'null（NO SIGNAL）'}</strong>；锁定模式：<strong>${state.lock}</strong>；节目状态：<strong>${state.programState}</strong>。</div>
  `;
}
