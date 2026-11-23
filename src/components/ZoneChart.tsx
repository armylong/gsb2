import { useMemo } from 'react';
import { MAX_VELOCITY, MIN_VELOCITY, Mapping } from '../model/types';
import { coveringZones, crossfadeWeights } from '../model/mapping';

const COLORS = ['var(--zone-a)', 'var(--zone-b)', 'var(--zone-c)', '#b58be0'];

/** 力度轴上的区域覆盖与交叉区示意，交叉区用渐变表示等功率混合 */
export function ZoneChart({ mapping, velocity }: { mapping: Mapping; velocity: number }) {
  const zones = useMemo(() => [...mapping.zones].sort((a, b) => a.low - b.low), [mapping.zones]);
  const hits = coveringZones(mapping, velocity);
  const weights = crossfadeWeights(hits, velocity);
  const pct = (v: number): number => ((v - MIN_VELOCITY) / (MAX_VELOCITY - MIN_VELOCITY)) * 100;

  return (
    <div className="panel">
      <h2>力度映射与交叉区</h2>
      <div style={{ position: 'relative', height: 64, margin: '6px 0 4px' }}>
        {zones.map((z, i) => {
          const left = pct(z.low);
          const width = pct(z.high) - left;
          const color = COLORS[i % COLORS.length];
          return (
            <div
              key={z.id}
              style={{
                position: 'absolute',
                left: `${left}%`,
                width: `${width}%`,
                top: 18,
                height: 22,
                background: `repeating-linear-gradient(45deg, ${color}55, ${color}55 6px, ${color}33 6px, ${color}33 12px)`,
                border: `1px solid ${color}`,
                borderRadius: 6,
              }}
              title={`${z.label} ${z.low}..${z.high}`}
            />
          );
        })}
        {/* 当前力度游标 */}
        <div
          style={{
            position: 'absolute',
            left: `${pct(velocity)}%`,
            top: 8,
            bottom: 0,
            width: 2,
            background: '#fff',
          }}
        />
        <span
          className="mono"
          style={{ position: 'absolute', left: `${pct(velocity)}%`, top: 0, transform: 'translateX(-50%)', fontSize: 10 }}
        >
          {velocity}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted)', fontSize: 10 }}>
        <span>1</span>
        <span>32</span>
        <span>64</span>
        <span>96</span>
        <span>127</span>
      </div>

      <div style={{ marginTop: 10 }}>
        {hits.length === 0 && <span className="muted">当前力度没有命中任何区域，触发会被拦下并记入日志</span>}
        {hits.map((z, i) => (
          <span key={z.id} className="chip-layer">
            {z.label} · 权重 {weights[i].toFixed(3)} · 变体数 {z.variants.length}
          </span>
        ))}
      </div>
    </div>
  );
}
