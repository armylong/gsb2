/** 导入 JSON 时的宽松输入形状；校验后再变成 CaptionEvent。 */
export type CaptionEventDraft = Omit<CaptionEvent, 'note'> & { note?: string };

/** 一条字幕事件：同一个 captionId 可以有多条修订，最终以 final 结束。 */
export interface CaptionEvent {
  /** 每次投递的唯一事件 id；网络重试可能让同一条事件被接收两次（本样例数据中保持唯一）。 */
  id: string;
  /** 同一条字幕的稳定标识，也是导出 WebVTT 时的 cue 边界。 */
  captionId: string;
  /** 同一 captionId 内严格递增的修订序号。 */
  seq: number;
  /** revision = 修订；final = 结束/确认标记。 */
  kind: 'revision' | 'final';
  text: string;
  /** 该版本对应的媒体区间（秒）。 */
  mediaStart: number;
  mediaEnd: number;
  /** 事件到达本机回放时钟的时间（秒）。 */
  arrival: number;
  /** 样例注释，用来说明这次投递为什么值得核对。 */
  note?: string;
}

export type Verdict = 'accepted' | 'rejected' | 'pending';

export type RejectReason =
  | 'duplicate-event'
  | 'duplicate-revision'
  | 'stale-revision'
  | 'after-final';

export interface AuditRecord {
  /** 输入数组中的原始下标，用于稳定渲染重复 id 的投递。 */
  index: number;
  event: CaptionEvent;
  received: boolean;
  verdict: Verdict;
  reason: RejectReason | null;
  acceptedSeqBefore: number | null;
  acceptedSeqAfter: number | null;
  /** 处理完这次接收后，该字幕真正生效的文本。待到达时为 null。 */
  effectiveText: string | null;
  effectiveFinal: boolean;
  effectiveEventId: string | null;
}

export type CaptionWindow = 'onscreen' | 'upcoming' | 'ended' | 'unavailable';

export interface AcceptedRevision {
  eventId: string;
  seq: number;
  kind: 'revision' | 'final';
  text: string;
  mediaStart: number;
  mediaEnd: number;
  arrival: number;
}

export interface CaptionState {
  captionId: string;
  accepted: AcceptedRevision | null;
  final: boolean;
  finalArrival: number | null;
  acceptedCount: number;
  rejectedCount: number;
  pendingCount: number;
  lastRejection: { reason: RejectReason; arrival: number } | null;
  /** 相对“呈现时刻”（回放时刻 - 显示延迟）的窗口状态。 */
  window: CaptionWindow;
}

export interface ScreenCaption {
  captionId: string;
  eventId: string;
  seq: number;
  final: boolean;
  text: string;
  mediaStart: number;
  mediaEnd: number;
  acceptedAt: number;
}

export interface ConfirmedCue {
  captionId: string;
  seq: number;
  text: string;
  start: number;
  end: number;
  confirmedAt: number;
}

export interface ReplayStats {
  totalEvents: number;
  receivedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  pendingCount: number;
  confirmedCount: number;
}

export interface ReplaySnapshot {
  /** 回放时钟：用于判断“哪些事件已经接收”。 */
  time: number;
  /** 字幕显示延迟（秒）。 */
  delay: number;
  /** 呈现时钟 = time - delay，用于判断哪一句在画面上。 */
  presentationTime: number;
  audit: AuditRecord[];
  captions: CaptionState[];
  screen: ScreenCaption[];
  confirmed: ConfirmedCue[];
  stats: ReplayStats;
}

export interface Checkpoint {
  id: string;
  /** 跳到该回放时刻进行核对。 */
  at: number;
  title: string;
  detail: string;
  /** 在该回放时刻、按 delay（缺省 0 秒）的纯函数快照进行评估。 */
  delay?: number;
  verify: (snapshot: ReplaySnapshot) => boolean;
}

export interface Scenario {
  id: string;
  name: string;
  kicker: string;
  description: string;
  events: CaptionEvent[];
  checkpoints: Checkpoint[];
}
