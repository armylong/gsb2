import { add, cross, dot, normalize, scale, segmentIntersect, sub, vec, type Vec2 } from '../vec';
import type { GateEvent, GateSpec } from './types';

/**
 * 路线由一串"门"组成。每扇门是一条与航段方向垂直的线段，中心在浮标上。
 * 船依次穿门才算推进；侧别（左舷/右舷受风侧）按浮标相对航段方向判定。
 */
export interface CourseDef {
  id: string;
  name: string;
  description: string;
  gates: GateSpec[];
  startPos: Vec2;
  startHeading: number;
  /** 推荐的默认帆索位置（0 收满 ~ 1 松满）。 */
  defaultSheet: number;
}

export interface GateCheckResult {
  event: GateEvent | null;
  /** 擦边：进入浮标附近但没正经穿门。 */
  grazing: boolean;
}

export class CourseTracker {
  readonly course: CourseDef;
  nextIndex = 0;
  events: GateEvent[] = [];
  finished = false;
  finishTime: number | null = null;
  wrongOrderCount = 0;
  wrongSideCount = 0;
  grazingCount = 0;

  constructor(course: CourseDef) {
    this.course = course;
  }

  reset(): void {
    this.nextIndex = 0;
    this.events = [];
    this.finished = false;
    this.finishTime = null;
    this.wrongOrderCount = 0;
    this.wrongSideCount = 0;
    this.grazingCount = 0;
  }

  get progress(): number {
    return this.nextIndex;
  }

  /**
   * 检查一次位移（prev -> cur）是否与门线相交。
   * 仅当前期望的门可以"正确通过"；穿到后面的门记逆序。
   */
  check(prev: Vec2, cur: Vec2, time: number): GateCheckResult {
    let grazing = false;

    for (let i = 0; i < this.course.gates.length; i++) {
      const gate = this.course.gates[i];
      const leg = normalize(gate.legDir);
      const across = vec(-leg.y, leg.x); // 门线方向
      const a = sub(gate.center, scale(across, gate.halfWidth));
      const b = add(gate.center, scale(across, gate.halfWidth));
      const hit = segmentIntersect(prev, cur, a, b);
      if (!hit.hit) continue;

      // 必须沿航段方向穿过（dot 为正），反向穿越不算
      const travel = sub(cur, prev);
      if (dot(travel, leg) <= 0) continue;

      const side = this.sideOf(gate, hit.point);
      const sideLabel = side === 1 ? 'starboard' : side === -1 ? 'port' : 'none';
      const reasons: string[] = [];
      let ok = true;

      if (i !== this.nextIndex) {
        ok = false;
        this.wrongOrderCount++;
        reasons.push(
          i < this.nextIndex ? '顺序错误：这扇门已经过过了' : '顺序错误：提前通过了后面的门',
        );
      }
      if (gate.requiredSide && sideLabel !== gate.requiredSide && sideLabel !== 'none') {
        ok = false;
        this.wrongSideCount++;
        reasons.push(
          `侧别错误：要求从${gate.requiredSide === 'port' ? '左舷' : '右舷'}侧过，实际为${
            sideLabel === 'port' ? '左舷' : '右舷'
          }侧`,
        );
      }

      const event: GateEvent = {
        index: i,
        label: gate.label,
        ok,
        reasons,
        side: sideLabel,
        t: time,
      };
      this.events.push(event);

      if (ok) {
        this.nextIndex = i + 1;
        if (this.nextIndex >= this.course.gates.length) {
          this.finished = true;
          this.finishTime = time;
        }
      }
      return { event, grazing: false };
    }

    // 擦边检测：离某个还没过的浮标很近地掠过（小于 1.6 倍门宽的侧向距离）
    if (!this.finished) {
      for (let i = this.nextIndex; i < this.course.gates.length; i++) {
        const gate = this.course.gates[i];
        if (!gate.buoyId && gate.requiredSide === null) continue;
        const leg = normalize(gate.legDir);
        const rel = sub(cur, gate.center);
        const along = dot(rel, leg);
        const lateral = Math.abs(cross(rel, leg));
        if (Math.abs(along) < gate.halfWidth * 1.1 && lateral > gate.halfWidth && lateral < gate.halfWidth * 1.9) {
          grazing = true;
          this.grazingCount++;
          break;
        }
      }
    }

    return { event: null, grazing };
  }

  /**
   * 穿越点在航段的哪一侧：
   * cross(legDir, point-center) > 0 => 右舷侧 (+1)，否则左舷侧 (-1)。
   */
  private sideOf(gate: GateSpec, point: Vec2): 1 | -1 | 0 {
    const leg = normalize(gate.legDir);
    const c = cross(leg, sub(point, gate.center));
    if (Math.abs(c) < 1e-6) return 0;
    return c > 0 ? 1 : -1;
  }
}
