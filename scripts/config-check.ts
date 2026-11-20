import { serializeConfig, tryApplyConfig, tryApplyConfigText, saveToStorage, loadFromStorage } from '../src/engine/config-store';
import type { MachineConfig } from '../src/engine/types';
import type { ScenarioCheck } from '../src/engine/scenarios';

function check(label: string, pass: boolean, detail: string): ScenarioCheck {
  return { label, pass, detail };
}

function mutate(config: MachineConfig, fn: (raw: Record<string, unknown>) => void): unknown {
  const raw = JSON.parse(serializeConfig(config)) as Record<string, unknown>;
  fn(raw);
  return raw;
}

export function runConfigChecks(config: MachineConfig): { checks: ScenarioCheck[] } {
  const checks: ScenarioCheck[] = [];
  const before = serializeConfig(config);

  const cases: Array<{ label: string; raw: unknown }> = [
    {
      label: '缺失状态引用被拒绝',
      raw: mutate(config, (raw) => {
        (raw.transitions as Array<Record<string, unknown>>)[0].to = 'ghost';
      }),
    },
    {
      label: '非法时长(0)被拒绝',
      raw: mutate(config, (raw) => {
        (raw.states as Array<Record<string, unknown>>)[0].durationMs = 0;
      }),
    },
    {
      label: '越界事件时间被拒绝',
      raw: mutate(config, (raw) => {
        const states = raw.states as Array<Record<string, unknown>>;
        (states[0].events as Array<Record<string, unknown>>)[0].timeMs =
          states[0].durationMs as number;
      }),
    },
    {
      label: '非法 initialState 被拒绝',
      raw: mutate(config, (raw) => {
        raw.initialState = 'nope';
      }),
    },
    {
      label: '破坏的 JSON 被拒绝',
      raw: '{ "states": [',
      isText: true,
    } as { label: string; raw: unknown; isText?: boolean },
  ];

  for (const testCase of cases) {
    const result =
      'isText' in testCase && testCase.isText
        ? tryApplyConfigText(config, testCase.raw as string)
        : tryApplyConfig(config, testCase.raw);
    checks.push(
      check(
        testCase.label,
        result.applied === false &&
          result.config === config &&
          serializeConfig(result.config) === before,
        `应用于=${result.applied}, 错误: ${result.errors[0] ?? '无'}`,
      ),
    );
  }

  const valid = mutate(config, (raw) => {
    raw.name = '校验通过的新配置';
  });
  const applied = tryApplyConfig(config, valid);
  checks.push(
    check(
      '合法配置被接受且不影响旧配置',
      applied.applied && applied.config.name === '校验通过的新配置' && serializeConfig(config) === before,
      `应用于=${applied.applied}, 名称=${applied.config.name}`,
    ),
  );

  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  const saved = saveToStorage(storage, applied.config);
  const loaded = loadFromStorage(storage, config);
  checks.push(
    check(
      '保存后可载入一致的配置',
      saved.ok && loaded.applied && serializeConfig(loaded.config) === serializeConfig(applied.config),
      `保存=${saved.ok}, 载入=${loaded.applied}`,
    ),
  );

  return { checks };
}
