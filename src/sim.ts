import { GameMap, FOOTSTEP_INTENSITY, IMPACT_INTENSITY } from './map';
import { propagate, CellReach, Dir, OPPOSITE, DIR_CN } from './propagate';

export type SoundType = 'footstep' | 'impact';

export const SOUND_TYPE_INFO: Record<SoundType, { label: string; intensity: number }> = {
  footstep: { label: '脚步', intensity: FOOTSTEP_INTENSITY },
  impact: { label: '撞击', intensity: IMPACT_INTENSITY },
};

export interface SoundEvent {
  id: number;
  type: SoundType;
  /** 发出时刻 */
  t0: number;
  x: number;
  y: number;
  initialIntensity: number;
  /** 发出时的地图快照(之后的门/墙编辑不影响本事件) */
  mapSnapshot: GameMap;
  /** 每个格的到达信息(不可达为 null),发声时一次性算好,随时间逐步揭示 */
  reach: (CellReach | null)[];
}

export interface HeardRecord {
  eventId: number;
  /** 声音到达本 NPC 的时刻 */
  time: number;
  /** 到达时剩余强度 */
  intensity: number;
  /** 声音进入 NPC 所在格的行进方向;估计声源方位为其反方向 */
  entry: Dir | null;
}

export type MissReason = 'unreachable' | 'too-quiet';

export const MISS_REASON_CN: Record<MissReason, string> = {
  unreachable: '声音被墙阻断/强度耗尽,未传播到该格',
  'too-quiet': '到达时强度低于听觉阈值',
};

export class NPC {
  heard: HeardRecord[] = [];
  missed: { eventId: number; reason: MissReason }[] = [];
  /** 已判定过的事件(听到或错过),保证同一声音最多响应一次 */
  private resolved = new Set<number>();

  constructor(
    public readonly id: number,
    public readonly name: string,
    public x: number,
    public y: number,
    public threshold: number,
  ) {}

  isResolved(eventId: number): boolean {
    return this.resolved.has(eventId);
  }

  resolveHeard(rec: HeardRecord): void {
    this.resolved.add(rec.eventId);
    this.heard.push(rec);
  }

  resolveMissed(eventId: number, reason: MissReason): void {
    this.resolved.add(eventId);
    this.missed.push({ eventId, reason });
  }

  reset(): void {
    this.heard = [];
    this.missed = [];
    this.resolved.clear();
  }

  /**
   * 当前调查目标:在"听到过"的事件里取到达时刻最新者;
   * 同时到达取强度较大者;再并列取编号较小者(稳定规则)。
   */
  investigationTarget(): HeardRecord | null {
    let best: HeardRecord | null = null;
    for (const rec of this.heard) {
      if (
        best === null ||
        rec.time > best.time ||
        (rec.time === best.time && rec.intensity > best.intensity) ||
        (rec.time === best.time && rec.intensity === best.intensity && rec.eventId < best.eventId)
      ) {
        best = rec;
      }
    }
    return best;
  }
}

/** NPC 对某个事件的当前状态(用于页面解释"听到/没听到的原因") */
export type NpcEventStatus =
  | { kind: 'heard'; time: number; intensity: number; entry: Dir | null }
  | { kind: 'pending'; time: number; intensity: number }
  | { kind: 'too-quiet'; time: number; intensity: number }
  | { kind: 'unreachable' };

export class Sim {
  time = 0;
  events: SoundEvent[] = [];
  private pending: { time: number; type: SoundType; x: number; y: number }[] = [];
  private nextEventId = 1;

  constructor(
    public map: GameMap,
    public npcs: NPC[],
  ) {}

  npcIndex(npc: NPC): number {
    return npc.y * this.map.w + npc.x;
  }

  /** 立即发声:对当前地图做快照并预计算传播 */
  emit(type: SoundType, x: number, y: number): SoundEvent | null {
    if (!this.map.passable(x, y)) return null;
    const intensity0 = SOUND_TYPE_INFO[type].intensity;
    const snapshot = this.map.clone();
    const ev: SoundEvent = {
      id: this.nextEventId++,
      type,
      t0: this.time,
      x,
      y,
      initialIntensity: intensity0,
      mapSnapshot: snapshot,
      reach: propagate(snapshot, x, y, intensity0, this.time),
    };
    this.events.push(ev);
    this.processHearing();
    return ev;
  }

  /** 预约未来某时刻发声(预设示例用),发声时仍取当时的地图快照 */
  schedule(time: number, type: SoundType, x: number, y: number): void {
    this.pending.push({ time, type, x, y });
  }

  tick(): void {
    this.time++;
    const due = this.pending.filter((p) => p.time <= this.time);
    this.pending = this.pending.filter((p) => p.time > this.time);
    for (const p of due) this.emit(p.type, p.x, p.y);
    this.processHearing();
  }

  /** 检查所有 NPC 对所有未判定事件的听觉结果 */
  private processHearing(): void {
    for (const npc of this.npcs) {
      const ni = this.npcIndex(npc);
      for (const ev of this.events) {
        if (npc.isResolved(ev.id)) continue;
        const info = ev.reach[ni];
        if (!info) {
          npc.resolveMissed(ev.id, 'unreachable');
          continue;
        }
        if (info.time <= this.time) {
          if (info.intensity >= npc.threshold) {
            npc.resolveHeard({ eventId: ev.id, time: info.time, intensity: info.intensity, entry: info.entry });
          } else {
            npc.resolveMissed(ev.id, 'too-quiet');
          }
        }
      }
    }
  }

  /** NPC 对某事件的状态与原因 */
  npcEventStatus(npc: NPC, ev: SoundEvent): NpcEventStatus {
    const rec = npc.heard.find((r) => r.eventId === ev.id);
    if (rec) return { kind: 'heard', time: rec.time, intensity: rec.intensity, entry: rec.entry };
    const info = ev.reach[this.npcIndex(npc)];
    if (!info) return { kind: 'unreachable' };
    if (info.time > this.time) return { kind: 'pending', time: info.time, intensity: info.intensity };
    return { kind: 'too-quiet', time: info.time, intensity: info.intensity };
  }

  /** 重置:清空全部事件与 NPC 记录,旧事件不可能再通知 NPC;保留当前地图 */
  reset(): void {
    this.time = 0;
    this.events = [];
    this.pending = [];
    this.nextEventId = 1;
    for (const npc of this.npcs) npc.reset();
  }
}

/** 估计声源方位的中文描述(仅由进入方向推出,不给真实坐标) */
export function estimateDirText(entry: Dir | null): string {
  if (entry === null) return '就在本格';
  return `来自${DIR_CN[OPPOSITE[entry]]}方`;
}
