export interface ValidationOptions {
  /** 允许的状态 id 上限, 防止 UI 卡死 */
  maxStates?: number;
  maxTransitions?: number;
  maxEventsPerState?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const EVENT_KINDS = new Set(['footstep', 'window-open', 'window-close', 'marker']);
const POSES = new Set(['idle', 'run', 'attack', 'hurt', 'victory']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 严格校验一份配置。缺失状态引用、非法时长、越界事件都会导致整体被拒绝,
 * 调用方据此保留已有配置。未知字段会被忽略, 但不会静默替换关键字段。
 */
export function validateConfig(
  raw: unknown,
  options: ValidationOptions = {},
): ValidationResult {
  const maxStates = options.maxStates ?? 24;
  const maxTransitions = options.maxTransitions ?? 64;
  const maxEvents = options.maxEventsPerState ?? 40;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['配置必须是一个 JSON 对象'], warnings };
  }
  if (raw.version !== 1) {
    errors.push('version 必须为 1');
  }
  if (!isNonEmptyString(raw.name)) {
    errors.push('name 必须是非空字符串');
  }
  if (!Array.isArray(raw.states) || raw.states.length === 0) {
    return { ok: false, errors: [...errors, 'states 必须是非空数组'], warnings };
  }
  if (raw.states.length > maxStates) {
    errors.push(`状态数量 ${raw.states.length} 超过上限 ${maxStates}`);
  }
  if (!Array.isArray(raw.transitions)) {
    errors.push('transitions 必须是数组');
  } else if (raw.transitions.length > maxTransitions) {
    errors.push(`过渡数量 ${raw.transitions.length} 超过上限 ${maxTransitions}`);
  }

  const stateIds = new Set<string>();
  const eventIds = new Set<string>();

  raw.states.forEach((stateRaw, stateIndex) => {
    const where = `states[${stateIndex}]`;
    if (!isPlainObject(stateRaw)) {
      errors.push(`${where} 必须是对象`);
      return;
    }
    if (!isNonEmptyString(stateRaw.id)) {
      errors.push(`${where}.id 必须是非空字符串`);
    } else if (stateIds.has(stateRaw.id)) {
      errors.push(`状态 id 重复: ${stateRaw.id}`);
    } else {
      stateIds.add(stateRaw.id);
    }
    if (!isNonEmptyString(stateRaw.name)) {
      errors.push(`${where}.name 必须是非空字符串`);
    }
    if (!isFiniteNumber(stateRaw.durationMs) || stateRaw.durationMs <= 0) {
      errors.push(`${where}.durationMs 必须是大于 0 的有限数值`);
    } else if (stateRaw.durationMs > 600_000) {
      errors.push(`${where}.durationMs 不能超过 600000`);
    }
    if (typeof stateRaw.loop !== 'boolean') {
      errors.push(`${where}.loop 必须是布尔值`);
    }
    if (typeof stateRaw.visual !== 'string' || !POSES.has(stateRaw.visual)) {
      errors.push(`${where}.visual 必须是 ${[...POSES].join(' / ')} 之一`);
    }
    if (!Array.isArray(stateRaw.events)) {
      errors.push(`${where}.events 必须是数组`);
      return;
    }
    if (stateRaw.events.length > maxEvents) {
      errors.push(`${where}.events 数量超过上限 ${maxEvents}`);
    }
    const duration = stateRaw.durationMs;
    stateRaw.events.forEach((eventRaw, eventIndex) => {
      const at = `${where}.events[${eventIndex}]`;
      if (!isPlainObject(eventRaw)) {
        errors.push(`${at} 必须是对象`);
        return;
      }
      if (!isNonEmptyString(eventRaw.id)) {
        errors.push(`${at}.id 必须是非空字符串`);
      } else if (eventIds.has(eventRaw.id)) {
        errors.push(`事件 id 重复: ${eventRaw.id}`);
      } else {
        eventIds.add(eventRaw.id);
      }
      if (!isNonEmptyString(eventRaw.name)) {
        errors.push(`${at}.name 必须是非空字符串`);
      }
      if (typeof eventRaw.kind !== 'string' || !EVENT_KINDS.has(eventRaw.kind)) {
        errors.push(`${at}.kind 必须是 ${[...EVENT_KINDS].join(' / ')} 之一`);
      }
      if (!isFiniteNumber(eventRaw.timeMs)) {
        errors.push(`${at}.timeMs 必须是有限数值`);
        return;
      }
      if (typeof duration !== 'number' || !Number.isFinite(duration)) return;
      if (eventRaw.timeMs < 0 || eventRaw.timeMs >= duration) {
        errors.push(
          `${at}.timeMs=${eventRaw.timeMs} 越界, 必须满足 0 <= timeMs < durationMs(${duration})`,
        );
      }
    });
  });

  if (!isNonEmptyString(raw.initialState)) {
    errors.push('initialState 必须是非空字符串');
  } else if (stateIds.size > 0 && !stateIds.has(raw.initialState)) {
    errors.push(`initialState 引用了不存在的状态: ${raw.initialState}`);
  }

  const transitionIds = new Set<string>();
  if (Array.isArray(raw.transitions)) {
    raw.transitions.forEach((transitionRaw, index) => {
      const where = `transitions[${index}]`;
      if (!isPlainObject(transitionRaw)) {
        errors.push(`${where} 必须是对象`);
        return;
      }
      if (!isNonEmptyString(transitionRaw.id)) {
        errors.push(`${where}.id 必须是非空字符串`);
      } else if (transitionIds.has(transitionRaw.id)) {
        errors.push(`过渡 id 重复: ${transitionRaw.id}`);
      } else {
        transitionIds.add(transitionRaw.id);
      }
      for (const key of ['from', 'to'] as const) {
        const ref = transitionRaw[key];
        if (!isNonEmptyString(ref)) {
          errors.push(`${where}.${key} 必须是非空字符串`);
        } else if (!stateIds.has(ref)) {
          errors.push(`${where}.${key} 引用了不存在的状态: ${ref}`);
        }
      }
      if (transitionRaw.from === transitionRaw.to && isNonEmptyString(transitionRaw.from)) {
        warnings.push(`${where} 自过渡(from === to), 会重启动作`);
      }
      if (!isFiniteNumber(transitionRaw.priority)) {
        errors.push(`${where}.priority 必须是有限数值`);
      }
      if (typeof transitionRaw.waitForProgress !== 'boolean') {
        errors.push(`${where}.waitForProgress 必须是布尔值`);
      }
      if (!isFiniteNumber(transitionRaw.progress)) {
        errors.push(`${where}.progress 必须是有限数值`);
      } else if (transitionRaw.progress < 0 || transitionRaw.progress > 1) {
        errors.push(`${where}.progress 必须在 [0, 1] 内`);
      } else if (transitionRaw.waitForProgress === true && transitionRaw.progress >= 1) {
        warnings.push(`${where}.progress = 1, 与等待动作结束等价`);
      }
      if (!isPlainObject(transitionRaw.conditions)) {
        errors.push(`${where}.conditions 必须是对象`);
        return;
      }
      const conditions = transitionRaw.conditions;
      if (conditions.speed !== null) {
        if (!isPlainObject(conditions.speed)) {
          errors.push(`${where}.conditions.speed 必须是对象或 null`);
        } else {
          const op = conditions.speed.op;
          if (op !== 'gte' && op !== 'lte') {
            errors.push(`${where}.conditions.speed.op 必须是 gte 或 lte`);
          }
          if (!isFiniteNumber(conditions.speed.value) || conditions.speed.value < 0) {
            errors.push(`${where}.conditions.speed.value 必须是非负有限数值`);
          }
        }
      }
      if (conditions.hurt !== null && typeof conditions.hurt !== 'boolean') {
        errors.push(`${where}.conditions.hurt 必须是布尔值或 null`);
      }
      if (typeof conditions.attackTrigger !== 'boolean') {
        errors.push(`${where}.conditions.attackTrigger 必须是布尔值`);
      }
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验并返回深拷贝后的配置; 失败时抛出带全部错误的 Error。 */
export function parseConfig(raw: unknown): { config: import('./types').MachineConfig; warnings: string[] } {
  const result = validateConfig(raw);
  if (!result.ok) {
    throw new ConfigValidationError(result.errors, result.warnings);
  }
  return {
    config: normalizeConfig(raw as Record<string, unknown>),
    warnings: result.warnings,
  };
}

export class ConfigValidationError extends Error {
  readonly errors: string[];
  readonly warnings: string[];
  constructor(errors: string[], warnings: string[] = []) {
    super(errors.join('; '));
    this.name = 'ConfigValidationError';
    this.errors = errors;
    this.warnings = warnings;
  }
}

function normalizeConfig(raw: Record<string, unknown>): import('./types').MachineConfig {
  const states = (raw.states as Array<Record<string, unknown>>).map((s) => ({
    id: s.id as string,
    name: s.name as string,
    durationMs: s.durationMs as number,
    loop: s.loop as boolean,
    visual: s.visual as import('./types').PoseKind,
    events: (s.events as Array<Record<string, unknown>>).map((e) => ({
      id: e.id as string,
      name: e.name as string,
      kind: e.kind as import('./types').EventKind,
      timeMs: e.timeMs as number,
    })),
  }));

  const transitions = (raw.transitions as Array<Record<string, unknown>>).map((t) => {
    const conditions = t.conditions as Record<string, unknown>;
    const speed = conditions.speed as Record<string, unknown> | null;
    return {
      id: t.id as string,
      from: t.from as string,
      to: t.to as string,
      priority: t.priority as number,
      waitForProgress: t.waitForProgress as boolean,
      progress: t.progress as number,
      conditions: {
        speed: speed
          ? { op: speed.op as 'gte' | 'lte', value: speed.value as number }
          : null,
        hurt: conditions.hurt as boolean | null,
        attackTrigger: conditions.attackTrigger as boolean,
      },
    };
  });

  return {
    version: 1,
    name: raw.name as string,
    initialState: raw.initialState as string,
    states,
    transitions,
  };
}
