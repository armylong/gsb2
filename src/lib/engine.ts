import type {
  AcceptedRevision,
  AuditRecord,
  CaptionEvent,
  CaptionState,
  CaptionWindow,
  ConfirmedCue,
  ReplaySnapshot,
  RejectReason,
  ScreenCaption,
} from './types';

const EPSILON = 1e-9;

interface OrderedEvent {
  event: CaptionEvent;
  index: number;
}

interface Reduction {
  accepted: Map<string, AcceptedRevision>;
  locked: Set<string>;
  finalArrival: Map<string, number>;
  acceptedCounts: Map<string, number>;
  rejectedCounts: Map<string, number>;
  pendingCounts: Map<string, number>;
  lastRejections: Map<string, { reason: RejectReason; arrival: number }>;
  firstSeen: Map<string, number>;
  audit: AuditRecord[];
  acceptedTotal: number;
  rejectedTotal: number;
  pendingTotal: number;
}

/** 到达顺序：先按 arrival，再按输入顺序稳定排序。引擎只按这个顺序消费事件。 */
export function orderByArrival(events: readonly CaptionEvent[]): OrderedEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.arrival - b.event.arrival || a.index - b.index);
}

/** 全部不同的到达时刻，供“上一投递/下一投递”与时间轴刻度使用。 */
function uniqueArrivals(events: readonly CaptionEvent[]): number[] {
  const arrivals = orderByArrival(events)
    .map(({ event }) => event.arrival)
    .sort((a, b) => a - b);
  return arrivals.filter(
    (value, index) => index === 0 || Math.abs(value - arrivals[index - 1]) > EPSILON,
  );
}

export function nextArrival(events: readonly CaptionEvent[], time: number): number | null {
  return uniqueArrivals(events).find((arrival) => arrival > time + EPSILON) ?? null;
}

export function previousArrival(events: readonly CaptionEvent[], time: number): number | null {
  const arrivals = uniqueArrivals(events);
  for (let index = arrivals.length - 1; index >= 0; index -= 1) {
    if (arrivals[index] < time - EPSILON) return arrivals[index];
  }
  return null;
}

/** 时间轴尾部多留几秒，方便观察最后一句结束后画面清空。 */
export function timelineEnd(events: readonly CaptionEvent[]): number {
  if (events.length === 0) return 1;
  let end = 0;
  for (const event of events) {
    end = Math.max(end, event.arrival, event.mediaEnd);
  }
  return Math.max(1, Math.round((end + 3) * 10) / 10);
}

function windowFor(revision: AcceptedRevision | null, presentationTime: number): CaptionWindow {
  if (!revision) return 'unavailable';
  if (presentationTime < revision.mediaStart - EPSILON) return 'upcoming';
  if (presentationTime >= revision.mediaEnd - EPSILON) return 'ended';
  return 'onscreen';
}

const bump = (map: Map<string, number>, key: string) => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

/**
 * 单次归约：只消费 arrival <= threshold 的投递，得到“截至 threshold 的接收状态”。
 *
 * 这是整个应用唯一的判定逻辑。画面、台账、导出都在不同 threshold 上重复调用它，
 * 而不是在上一帧状态上做增量修改，因此任意顺序拖动都不会残留未来的版本。
 */
function reduceAt(events: readonly CaptionEvent[], threshold: number): Reduction {
  const accepted = new Map<string, AcceptedRevision>();
  const acceptedSeq = new Map<string, number>();
  const locked = new Set<string>();
  const finalArrival = new Map<string, number>();
  const receivedIds = new Set<string>();

  const acceptedCounts = new Map<string, number>();
  const rejectedCounts = new Map<string, number>();
  const pendingCounts = new Map<string, number>();
  const lastRejections = new Map<string, { reason: RejectReason; arrival: number }>();
  const firstSeen = new Map<string, number>();

  const audit: AuditRecord[] = [];
  let acceptedTotal = 0;
  let rejectedTotal = 0;
  let pendingTotal = 0;

  for (const { event, index } of orderByArrival(events)) {
    const received = event.arrival <= threshold + EPSILON;
    // 字幕清单按“最早一次投递”排序，未到达的字幕也占一行，便于核对。
    if (!firstSeen.has(event.captionId)) firstSeen.set(event.captionId, event.arrival);

    if (!received) {
      pendingTotal += 1;
      bump(pendingCounts, event.captionId);
      audit.push({
        index,
        event,
        received: false,
        verdict: 'pending',
        reason: null,
        acceptedSeqBefore: null,
        acceptedSeqAfter: null,
        effectiveText: null,
        effectiveFinal: locked.has(event.captionId),
        effectiveEventId: accepted.get(event.captionId)?.eventId ?? null,
      });
      continue;
    }

    const seqBefore = acceptedSeq.get(event.captionId) ?? null;
    const current = accepted.get(event.captionId) ?? null;
    let reason: RejectReason | null = null;

    if (receivedIds.has(event.id)) {
      // 同一事件被网络层重试：重复投递不能产生第二次接收结果。
      reason = 'duplicate-event';
    } else if (locked.has(event.captionId)) {
      // 已确认的字幕锁定，之后任何修订（无论序号）都不能改导出内容。
      reason = 'after-final';
    } else if (seqBefore !== null && event.seq < seqBefore) {
      // 乱序迟到的旧修订。
      reason = 'stale-revision';
    } else if (seqBefore !== null && event.seq === seqBefore) {
      // 同序号的结束标记可以只做确认：正文相同或留空时，视为对已生效版本的确认。
      const confirmsExisting =
        event.kind === 'final' &&
        current !== null &&
        current.kind !== 'final' &&
        (event.text.trim() === '' || event.text === current.text);
      if (!confirmsExisting) {
        // 同一序号换了个事件 id 重发，且内容不同：保留已生效版本。
        reason = 'duplicate-revision';
      }
    }

    receivedIds.add(event.id);

    if (reason) {
      rejectedTotal += 1;
      bump(rejectedCounts, event.captionId);
      lastRejections.set(event.captionId, { reason, arrival: event.arrival });
      audit.push({
        index,
        event,
        received: true,
        verdict: 'rejected',
        reason,
        acceptedSeqBefore: seqBefore,
        acceptedSeqAfter: seqBefore,
        effectiveText: current?.text ?? null,
        effectiveFinal: locked.has(event.captionId),
        effectiveEventId: current?.eventId ?? null,
      });
      continue;
    }

    // 结束标记如果没带文本，沿用上一版正文，但媒体边界以结束标记为准。
    const text = event.text.trim().length > 0 ? event.text : (current?.text ?? '');
    const revision: AcceptedRevision = {
      eventId: event.id,
      seq: event.seq,
      kind: event.kind,
      text,
      mediaStart: event.mediaStart,
      mediaEnd: event.mediaEnd,
      arrival: event.arrival,
    };
    const isConfirmationOnly = seqBefore !== null && event.seq === seqBefore;

    accepted.set(event.captionId, revision);
    acceptedSeq.set(event.captionId, event.seq);
    // “仅确认”不新增修订版本，但作为一次成功接收计入接收数。
    if (!isConfirmationOnly) bump(acceptedCounts, event.captionId);
    acceptedTotal += 1;

    if (event.kind === 'final') {
      locked.add(event.captionId);
      finalArrival.set(event.captionId, event.arrival);
    }

    audit.push({
      index,
      event,
      received: true,
      verdict: 'accepted',
      reason: null,
      acceptedSeqBefore: seqBefore,
      acceptedSeqAfter: event.seq,
      effectiveText: revision.text,
      effectiveFinal: locked.has(event.captionId),
      effectiveEventId: revision.eventId,
    });
  }

  return {
    accepted,
    locked,
    finalArrival,
    acceptedCounts,
    rejectedCounts,
    pendingCounts,
    lastRejections,
    firstSeen,
    audit,
    acceptedTotal,
    rejectedTotal,
    pendingTotal,
  };
}

function toConfirmed(reduction: Reduction): ConfirmedCue[] {
  return [...reduction.locked]
    .flatMap((captionId) => {
      const revision = reduction.accepted.get(captionId);
      if (!revision) return [];
      return [
        {
          captionId,
          seq: revision.seq,
          text: revision.text,
          start: revision.mediaStart,
          end: revision.mediaEnd,
          confirmedAt: reduction.finalArrival.get(captionId) ?? revision.arrival,
        } satisfies ConfirmedCue,
      ];
    })
    .sort((a, b) => a.start - b.start || a.captionId.localeCompare(b.captionId));
}

/**
 * 纯函数快照。
 *
 * 只做一次归约，阈值是回放时刻 time：截至此刻收到的投递决定台账与导出。
 * 显示延迟只把呈现时钟向后平移（presentationTime = time - delay）：
 * 观众看到的是 delay 秒之前的媒体画面，配上“到此刻为止”已确认的最新文本。
 * 于是延迟天然成为吸收迟到修订的缓冲，而不是把修正再推后一截。
 */
export function buildSnapshot(
  events: readonly CaptionEvent[],
  time: number,
  delay = 0,
): ReplaySnapshot {
  const replayTime = Math.max(0, Number.isFinite(time) ? time : 0);
  const displayDelay = Math.max(0, Number.isFinite(delay) ? delay : 0);
  const presentationTime = replayTime - displayDelay;

  // 接收判定以回放时刻为阈值；显示延迟只平移呈现时钟，不改变“截至此刻收到了什么”。
  const received = reduceAt(events, replayTime);

  const captionIds = [...received.firstSeen.keys()].sort(
    (a, b) =>
      (received.firstSeen.get(a) ?? 0) - (received.firstSeen.get(b) ?? 0) || a.localeCompare(b),
  );

  const captions: CaptionState[] = captionIds.map((captionId) => {
    const revision = received.accepted.get(captionId) ?? null;
    return {
      captionId,
      accepted: revision,
      final: received.locked.has(captionId),
      finalArrival: received.finalArrival.get(captionId) ?? null,
      acceptedCount: received.acceptedCounts.get(captionId) ?? 0,
      rejectedCount: received.rejectedCounts.get(captionId) ?? 0,
      pendingCount: received.pendingCounts.get(captionId) ?? 0,
      lastRejection: received.lastRejections.get(captionId) ?? null,
      window: windowFor(revision, presentationTime),
    } satisfies CaptionState;
  });

  const screen: ScreenCaption[] = captions
    .filter((caption) => caption.window === 'onscreen' && caption.accepted !== null)
    .map((caption) => {
      const revision = caption.accepted as AcceptedRevision;
      return {
        captionId: caption.captionId,
        eventId: revision.eventId,
        seq: revision.seq,
        final: caption.final,
        text: revision.text,
        mediaStart: revision.mediaStart,
        mediaEnd: revision.mediaEnd,
        acceptedAt: revision.arrival,
      } satisfies ScreenCaption;
    })
    .sort((a, b) => a.mediaStart - b.mediaStart || a.captionId.localeCompare(b.captionId));

  return {
    time: replayTime,
    delay: displayDelay,
    presentationTime,
    audit: received.audit,
    captions,
    screen,
    confirmed: toConfirmed(received),
    stats: {
      totalEvents: events.length,
      receivedCount: received.acceptedTotal + received.rejectedTotal,
      acceptedCount: received.acceptedTotal,
      rejectedCount: received.rejectedTotal,
      pendingCount: received.pendingTotal,
      confirmedCount: received.locked.size,
    },
  };
}
