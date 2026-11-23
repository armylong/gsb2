import { Mapping, MAX_VELOCITY, MIN_VELOCITY } from '../model/types';
import { addVariant, addZone, removeVariant, removeZone, updateZone } from '../state/edits';

interface Props {
  mapping: Mapping;
  onChange: (m: Mapping) => void;
  sampleStates: Record<string, { status: string; reason?: string }>;
}

const COLORS = ['var(--zone-a)', 'var(--zone-b)', 'var(--zone-c)', '#b58be0'];

export function ZoneEditor({ mapping, onChange, sampleStates }: Props) {
  const sorted = [...mapping.zones].sort((a, b) => a.low - b.low);

  return (
    <div className="panel">
      <h2>区域与变体</h2>
      {sorted.map((z, zi) => (
        <div className="zone-card" key={z.id} style={{ borderLeft: `3px solid ${COLORS[zi % COLORS.length]}` }}>
          <div className="zone-head">
            <input
              value={z.label}
              onChange={(e) => onChange(updateZone(mapping, z.id, { label: e.target.value }))}
              style={{ width: 110 }}
              aria-label="区域名称"
            />
            <span className="muted mono">
              {z.low}..{z.high}
            </span>
            <span className="spacer" />
            <span className="badge">{z.variants.length} 条变体</span>
            <button className="tiny danger" onClick={() => onChange(removeZone(mapping, z.id))}>
              删区域
            </button>
          </div>

          <div className="row">
            <label className="field" style={{ flex: 1, marginBottom: 4 }}>
              <span>下界 low（含）</span>
              <input
                type="number"
                min={MIN_VELOCITY}
                max={MAX_VELOCITY}
                value={z.low}
                onChange={(e) => onChange(updateZone(mapping, z.id, { low: Number(e.target.value) }))}
              />
            </label>
            <label className="field" style={{ flex: 1, marginBottom: 4 }}>
              <span>上界 high（含）</span>
              <input
                type="number"
                min={MIN_VELOCITY}
                max={MAX_VELOCITY}
                value={z.high}
                onChange={(e) => onChange(updateZone(mapping, z.id, { high: Number(e.target.value) }))}
              />
            </label>
          </div>

          {z.variants.map((v, vi) => {
            const st = sampleStates[v.sampleId];
            return (
              <div className="variant-row" key={v.id}>
                <span className="idx">#{vi}</span>
                <select
                  value={v.sampleId}
                  onChange={(e) =>
                    onChange(
                      updateZone(mapping, z.id, {
                        variants: z.variants.map((x) => (x.id === v.id ? { ...x, sampleId: e.target.value } : x)),
                      }),
                    )
                  }
                >
                  {mapping.samples.length === 0 && <option value="">（素材库为空）</option>}
                  {mapping.samples.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {st && <span className={`badge ${st.status}`} title={st.reason}>{st.status}</span>}
                <button className="tiny danger" onClick={() => onChange(removeVariant(mapping, z.id, v.id))}>
                  ×
                </button>
              </div>
            );
          })}

          <div className="row" style={{ marginTop: 6 }}>
            <button className="tiny" onClick={() => onChange(addVariant(mapping, z.id, mapping.samples[0]?.id ?? ''))} disabled={mapping.samples.length === 0}>
              + 加一条轮换变体
            </button>
          </div>
        </div>
      ))}
      <button onClick={() => onChange(addZone(mapping))}>+ 加区域（可与相邻区域设置交叉范围）</button>
    </div>
  );
}
