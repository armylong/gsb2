import { clamp } from '../domain/mapping';
import type { Direction, PlannerCommand, ScrubAtom, ScrubOptions, ScrubRoute, StopCommand } from '../domain/types';

let atomSequence = 0;
let routeSequence = 0;

export function bufferOffsetForAtom(atom: ScrubAtom, bufferDuration: number): number {
  if (atom.direction === 1) return clamp(atom.sourceTime, 0, Math.max(0, bufferDuration - 0.001));
  return clamp(bufferDuration - atom.sourceTime, 0, Math.max(0, bufferDuration - 0.001));
}

export function scrubRateForVelocity(velocitySourcePerSec: number, sensitivity: number): number {
  const speed = Math.abs(velocitySourcePerSec);
  return clamp(0.9 + sensitivity * Math.min(10, speed) * 0.1, 0.9, 3.2);
}

export class ScrubPlanner {
  readonly route: ScrubRoute;
  private readonly durationSec: number;
  private readonly observationSec: number;
  private readonly sensitivity: number;
  private readonly throttleSec: number;
  private readonly origin: number;

  private active: ScrubAtom | null = null;
  private direction: Direction = 1;
  private lastObservedNow: number;
  private lastObservedTime: number;
  private lastStartNow: number | null = null;
  private lastStartTime: number | null = null;
  private velocity = 0;

  constructor(nowSec: number, sourceTime: number, options: ScrubOptions, routeInit?: Partial<ScrubRoute>) {
    this.durationSec = Math.max(0.01, options.durationSec);
    this.observationSec = clamp(options.observationSec, 0.05, 1.5);
    this.sensitivity = clamp(options.sensitivity, 0.25, 3);
    this.throttleSec = options.throttleSec ?? 0.055;
    this.origin = nowSec;
    this.lastObservedNow = nowSec;
    this.lastObservedTime = clamp(sourceTime, 0, this.durationSec);
    this.route = {
      id: routeInit?.id ?? `route-${++routeSequence}-${Date.now().toString(36)}`,
      name: routeInit?.name ?? `路线 ${routeSequence}`,
      docId: routeInit?.docId ?? 'unknown',
      createdAt: routeInit?.createdAt ?? Date.now(),
      duration: 0,
      atoms: [],
      pointerEvents: routeInit?.pointerEvents ?? [],
      validation: routeInit?.validation,
    };
  }

  ingest(nowSec: number, rawSourceTime: number): PlannerCommand[] {
    const sourceTime = clamp(rawSourceTime, 0, this.durationSec);
    const commands: PlannerCommand[] = [];
    const dt = Math.max(0, nowSec - this.lastObservedNow);
    if (dt > 0.00001) {
      this.velocity = (sourceTime - this.lastObservedTime) / dt;
    }

    let nextDirection = this.direction;
    if (sourceTime > this.lastObservedTime + 1e-7) nextDirection = 1;
    else if (sourceTime < this.lastObservedTime - 1e-7) nextDirection = -1;
    const directionChanged = nextDirection !== this.direction;
    this.direction = nextDirection;

    if (this.active) {
      const endAbsolute = this.origin + this.active.at + this.active.duration;
      if (nowSec >= endAbsolute) this.active = null;
    }

    const jumpThreshold = clamp(this.observationSec * 1.25, 0.18, 0.65);
    const jumpReferenceTime = this.lastStartTime ?? this.lastObservedTime;
    const jumped = Math.abs(sourceTime - jumpReferenceTime) > jumpThreshold;
    const throttleElapsed = this.lastStartNow === null || nowSec - this.lastStartNow >= this.throttleSec;
    const positionChanged = this.lastStartTime === null || Math.abs(sourceTime - this.lastStartTime) > 1e-7;
    const shouldStart =
      positionChanged &&
      (!this.active || directionChanged || jumped || (throttleElapsed && positionChanged));

    if (shouldStart) {
      if (this.active) commands.push(this.finalizeActive(nowSec, 0.035));
      commands.push({ type: 'start', atom: this.createAtom(nowSec, sourceTime, this.direction, jumped) });
    }

    this.lastObservedNow = nowSec;
    this.lastObservedTime = sourceTime;
    return commands;
  }

  release(nowSec: number): PlannerCommand[] {
    if (!this.active) return [];
    return [this.finalizeActive(nowSec, 0.085)];
  }

  private createAtom(nowSec: number, sourceTime: number, direction: Direction, jumped: boolean): ScrubAtom {
    const preRoll = clamp(this.observationSec * 0.18, 0.012, 0.06);
    const rate = scrubRateForVelocity(this.velocity, this.sensitivity);
    let atomSourceTime: number;
    let availableOutput: number;

    if (direction === 1) {
      atomSourceTime = clamp(sourceTime - preRoll, 0, this.durationSec);
      availableOutput = Math.max(0, (this.durationSec - atomSourceTime) / rate);
    } else {
      atomSourceTime = clamp(sourceTime + preRoll, 0, this.durationSec);
      availableOutput = Math.max(0, atomSourceTime / rate);
    }

    const duration = Math.max(0.025, Math.min(this.observationSec, Math.max(0.025, availableOutput)));
    const atom: ScrubAtom = {
      id: `atom-${++atomSequence}`,
      at: Math.max(0, nowSec - this.origin),
      duration,
      sourceTime: atomSourceTime,
      direction,
      rate,
      gain: 0.92,
      fadeIn: 0.008,
      fadeOut: Math.min(0.07, duration * 0.35, Math.max(0.012, availableOutput * 0.45)),
      jumped,
    };

    this.active = atom;
    this.lastStartNow = nowSec;
    this.lastStartTime = sourceTime;
    this.route.atoms.push(atom);
    this.route.duration = Math.max(this.route.duration, atom.at + atom.duration);
    return atom;
  }

  private finalizeActive(nowSec: number, fadeOut: number): StopCommand {
    const atom = this.active;
    if (!atom) throw new Error('No active scrub atom');
    const startAbsolute = this.origin + atom.at;
    const elapsed = Math.max(0.018, nowSec - startAbsolute);
    atom.fadeOut = Math.min(fadeOut, Math.max(0.012, atom.duration * 0.45));
    atom.duration = Math.max(0.03, elapsed + atom.fadeOut);
    this.route.duration = this.route.atoms.reduce((max, item) => Math.max(max, item.at + item.duration), 0);
    this.active = null;
    return { type: 'stop', id: atom.id, duration: atom.duration, fadeOut: atom.fadeOut };
  }
}

export function planScriptedRoute(
  docId: string,
  name: string,
  durationSec: number,
  points: Array<{ atSec: number; time: number }>,
  options?: Partial<ScrubOptions>,
): ScrubRoute {
  const first = points[0] ?? { atSec: 0, time: 0 };
  const planner = new ScrubPlanner(first.atSec, first.time, {
    durationSec,
    observationSec: options?.observationSec ?? 0.32,
    sensitivity: options?.sensitivity ?? 1,
    throttleSec: options?.throttleSec ?? 0.07,
  }, { docId, name, validation: true });

  for (let i = 1; i < points.length; i += 1) {
    planner.ingest(points[i].atSec, points[i].time);
  }
  planner.release((points.at(-1)?.atSec ?? 0) + 0.09);
  return planner.route;
}
