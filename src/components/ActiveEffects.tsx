import type {
  AttackBuffInstance,
  EffectInstance,
  PeriodicDamageInstance,
  ShieldInstance,
  SimState,
  SimulationResult,
} from '../engine/types';
import { formatMs } from '../engine/simulator';
import { KIND_CLASS, KIND_LABEL, KIND_ORDER } from '../ui';

export function ActiveEffects({
  state,
  onSelectEffect,
  selectedKey,
  result,
  onSeek,
}: {
  state: SimState;
  onSelectEffect: (key: string | null) => void;
  selectedKey: string | null;
  result: SimulationResult;
  onSeek: (time: number) => void;
}) {
  const active = state.effects.filter((effect) => effect.status === 'active');
  const futures = result.lifetimes.filter((row) => row.start > state.time);
  const upcoming = futures
    .slice()
    .sort((a, b) => a.start - b.start)
    .slice(0, 3);
  return (
    <div className="card">
      <div className="card-head">
        <h2>生效效果 · {formatMs(state.time)}</h2>
        <span className="muted">{active.length} 项</span>
      </div>
      {active.length === 0 && <p className="muted">该时刻没有生效中的效果。</p>}
      {upcoming.length > 0 && (
        <p className="muted tiny upcoming">
          接下来：
          {upcoming.map((row, index) => (
            <button key={row.key} className="upcoming-item" onClick={() => onSeek(row.start)} title="跳到该效果的起点">
              {index > 0 ? ' · ' : ''}
              {formatMs(row.start)} {row.label}
            </button>
          ))}
        </p>
      )}
      <div className="effect-groups">
        {KIND_ORDER.map((kind) => {
          const list = active.filter((effect) => effect.kind === kind);
          if (list.length === 0) return null;
          return (
            <div key={kind} className="effect-group">
              <h3 className={KIND_CLASS[kind]}>
                <span className="swatch" /> {KIND_LABEL[kind]}
              </h3>
              {list.map((effect) => (
                <EffectRow
                  key={effect.id}
                  effect={effect}
                  selected={selectedKey === effect.id}
                  onSelect={() => onSelectEffect(selectedKey === effect.id ? null : effect.id)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EffectRow({ effect, selected, onSelect }: { effect: EffectInstance; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`effect-row ${KIND_CLASS[effect.kind]} ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className="effect-source">{effect.source}</span>
      <EffectDetail effect={effect} />
    </button>
  );
}

function EffectDetail({ effect }: { effect: EffectInstance }) {
  if (effect.kind === 'attackBuff') {
    const instance = effect as AttackBuffInstance;
    const stacks = instance.stacks.filter((stack) => stack.removedAt === undefined);
    return (
      <span className="effect-detail">
        <span className="stacks">
          {stacks.map((stack, index) => (
            <span key={stack.id} className="stack-chip" title={`+${stack.attackFlat} 固定 / +${stack.attackPct}%`}>
              {index + 1} · {formatMs(stack.expiresAt)} 到期
            </span>
          ))}
        </span>
      </span>
    );
  }
  if (effect.kind === 'periodicDamage') {
    const instance = effect as PeriodicDamageInstance;
    return (
      <span className="effect-detail">
        每 {formatMs(instance.intervalMs)} · {instance.tickDamage} 点 · 下一跳 <strong>{formatMs(instance.nextTickAt)}</strong> · 到期{' '}
        {formatMs(instance.expiresAt)}
      </span>
    );
  }
  const shield = effect as ShieldInstance;
  return (
    <span className="effect-detail">
      吸收 {Math.round(shield.remaining)} / {Math.round(shield.absorb)} · 到期 {formatMs(shield.expiresAt)}
    </span>
  );
}
