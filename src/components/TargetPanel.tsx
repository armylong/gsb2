import { useEffect, useState } from 'react';
import type { SimState, TargetConfig } from '../engine/types';
import { formatMs } from '../engine/simulator';

function TargetField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  function commit() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function TargetPanel({
  target,
  state,
  onChange,
  onReset,
}: {
  target: TargetConfig;
  state: SimState;
  onChange: (target: TargetConfig) => void;
  onReset: () => void;
}) {
  const fields: { key: keyof TargetConfig; label: string; min: number; max: number; step?: number }[] = [
    { key: 'maxHp', label: '最大生命', min: 1, max: 100000, step: 50 },
    { key: 'baseAttack', label: '基础攻击', min: 0, max: 100000, step: 10 },
    { key: 'initialShield', label: '初始护盾', min: 0, max: 100000, step: 10 },
  ];

  const hpPct = Math.max(0, Math.min(100, (state.hp / state.maxHp) * 100));

  return (
    <div className="card target-card">
      <div className="card-head">
        <h2>测试目标</h2>
        <button className="ghost small" onClick={onReset}>
          恢复示例配置
        </button>
      </div>
      <div className="target-figure">
        <div className="figure">
          {state.hp}
          <span className="figure-unit">/ {state.maxHp} 生命</span>
        </div>
        <div className={`target-state ${state.dead ? 'dead' : ''}`}>
          {state.dead ? `已死亡 @ ${formatMs(state.deadAt ?? state.time)}` : '存活'}
        </div>
      </div>
      <svg className="hp-bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={`生命 ${state.hp} / ${state.maxHp}`}>
        <rect className="hp-track" x="0" y="0" width="100" height="8" rx="4" />
        <rect className="hp-fill" x="0" y="0" width={hpPct} height="8" rx="4" />
      </svg>
      <div className="stat-strip">
        <div>
          <span className="muted">有效攻击</span>
          <strong>{state.attack.effectiveAttack}</strong>
        </div>
        <div>
          <span className="muted">护盾</span>
          <strong>{state.shieldTotal}</strong>
        </div>
        <div>
          <span className="muted">累计扣血</span>
          <strong>{state.damageTaken}</strong>
        </div>
      </div>
      <div className="attack-composition">
        <span className="label">攻击组成</span>
        <code>
          ({state.attack.baseAttack} + {state.attack.flatBonus}) × {(1 + state.attack.pctBonus / 100).toFixed(2)} ={' '}
          <strong>{state.attack.effectiveAttack}</strong>
        </code>
        <span className="muted">固定值先加，百分比后乘，移除后按剩余效果重算</span>
      </div>
      <div className="field-grid">
        {fields.map((field) => (
          <TargetField
            key={field.key}
            label={field.label}
            value={target[field.key]}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(value) => onChange({ ...target, [field.key]: value })}
          />
        ))}
      </div>
    </div>
  );
}
