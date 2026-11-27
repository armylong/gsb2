namespace Adaptive {

  /** 类型与常量定义 */

  export type SectionId = 'calm' | 'lively';

  /** 一个小节被规划成的段落类型 */
  export type BarKind = 'main-calm' | 'main-lively' | 'fill-c2l' | 'fill-l2c';

  /** 请求日志里每条请求的最终状态 */
  export type RequestStatus =
    | 'pending'        // 挂起中, 等待目标小节
    | 'locked'         // 过门小节已被音频调度锁定(马上能听到)
    | 'effective'      // 转换已实际发生
    | 'superseded'     // 被更新的请求覆盖, 过门不会播放
    | 'same-target'    // 请求目标与当前段落相同, 无操作
    | 'merged'         // 过门已在播放, 请求并入当前过门, 不再新插过门
    | 'cleared';       // 从头开始时被清理

  export interface RequestEvent {
    type: 'request' | 'status';
    record: RequestRecord;
    superseded?: RequestRecord;
    /** 新请求使尚未发声的小节规划失效, Transport 需停掉已预排的声音 */
    invalidateFromBar?: number;
  }

  /** 一条场景切换请求的完整生命周期记录 */
  export interface RequestRecord {
    id: number;
    origin: 'user' | 'scenario';
    target: SectionId;
    sourceAtClick: SectionId;
    clickBeat: number;          // 点击时听到的拍位(浮点拍)
    clickBar: number;
    plannedFillBar: number | null;  // 预计过门生效的小节边界; null 表示无需过门
    actualFillBar: number | null;   // 实际过门发声的小节边界
    status: RequestStatus;
    note: string;
  }

  /** 一个小节的播放规划 */
  export interface BarPlan {
    bar: number;
    kind: BarKind;
    /** 触发该规划的请求(主段时为 null) */
    requestId: number | null;
  }

  export interface BarArrival {
    bar: number;
    kind: BarKind;
    record: RequestRecord | null;
    events: RequestEvent[];
  }

  /** 每小节拍数与 BPM, 两套音乐共用同一条节拍线 */
  export const BEATS_PER_BAR = 4;
  export const TEMPO_BPM = 96;
  export const SECONDS_PER_BEAT = 60 / TEMPO_BPM;
  export const SECONDS_PER_BAR = SECONDS_PER_BEAT * BEATS_PER_BAR;

  export function fillKind(from: SectionId): BarKind {
    return from === 'calm' ? 'fill-c2l' : 'fill-l2c';
  }

  export function mainKind(section: SectionId): BarKind {
    return section === 'calm' ? 'main-calm' : 'main-lively';
  }

  export function kindOf(section: SectionId): BarKind {
    return mainKind(section);
  }

  export function sectionOf(kind: BarKind): SectionId {
    return kind === 'main-lively' || kind === 'fill-c2l' ? 'lively' : 'calm';
  }

  export function isFill(kind: BarKind): boolean {
    return kind === 'fill-c2l' || kind === 'fill-l2c';
  }

  /** 过门结束后进入的目标段落 */
  export function fillTarget(kind: BarKind): SectionId {
    return kind === 'fill-c2l' ? 'lively' : 'calm';
  }
}
