import { useEffect, useState, type ReactNode } from 'react';
import { engine } from '../state/useEngine';
import { LedgerEntry } from '../model/ledger';
import { BLOCK_REASON_TEXT } from '../model/mapping';

type AnyEntry = LedgerEntry<Record<string, unknown>>;

const KIND_TEXT: Record<string, string> = {
  'engine-init': '引擎初始化',
  'sample-status': '素材状态',
  'sample-preview': '素材独奏',
  'trigger-started': '触发·已播出',
  'trigger-blocked': '触发·被拦下',
  'voice-ended': '声音结束',
  release: '松键',
  'stop-all': '全部停止',
  'rotation-reset': '重置轮转',
  'replay-start': '序列重放开始',
  'replay-done': '序列重放完成',
};

function fmtTime(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/** 事件台账视图：每次触发恰好一条 started/blocked，声音结束另记 ended，可逐条审计 */
export function EventLog() {
  const [entries, setEntries] = useState<AnyEntry[]>([]);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setEntries(engine.events.recent(80) as AnyEntry[]), 250);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>事件台账（追加式，不可改写）</h2>
        <span className="spacer" />
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自动刷新
        </label>
        <button className="tiny" onClick={() => setEntries(engine.events.recent(80) as AnyEntry[])}>
          刷新
        </button>
        <button className="tiny danger" onClick={() => { engine.events.clear(); setEntries([]); }}>
          清空视图
        </button>
      </div>
      <div className="log-scroll">
        <table className="log">
          <thead>
            <tr>
              <th>#</th>
              <th>时间</th>
              <th>事件</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.seq}>
                <td className="mono">{e.seq}</td>
                <td className="mono">{fmtTime(e.at)}</td>
                <td>
                  <span className={`badge ${e.kind === 'trigger-blocked' ? 'error' : e.kind === 'trigger-started' ? 'ready' : 'idle'}`}>
                    {KIND_TEXT[e.kind] ?? e.kind}
                  </span>
                </td>
                <td>{renderDetail(e)}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={4} className="muted">暂无事件</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderDetail(e: AnyEntry): ReactNode {
  const p = e.payload;
  switch (e.kind) {
    case 'trigger-started': {
      const layers = (p.layers as Array<Record<string, unknown>>) ?? [];
      return (
        <div>
          <span className="mono">v={String(p.velocity)} press=#{String(p.pressId)} voice=#{String(p.voiceId)}</span>
          <div>
            {layers.map((l, i) => (
              <span key={i} className="chip-layer">
                变体#{String(l.variantIndex)} {String(l.sampleId)} · w={String(l.weight)} · g={String(l.gain)}
              </span>
            ))}
          </div>
        </div>
      );
    }
    case 'trigger-blocked': {
      const blocked = (p.blocked as Array<Record<string, unknown>>) ?? [];
      return (
        <div>
          <span className="mono">v={String(p.velocity)} press=#{String(p.pressId)}</span>
          {blocked.map((b, i) => (
            <div key={i} style={{ color: 'var(--err)' }}>
              ✗ {BLOCK_REASON_TEXT[b.reason as keyof typeof BLOCK_REASON_TEXT] ?? String(b.reason)}：{String(b.detail ?? '')}
            </div>
          ))}
        </div>
      );
    }
    case 'voice-ended':
      return (
        <span>
          voice=#{String(p.voiceId)} press=#{String(p.pressId)} ·{' '}
          <span className={p.reason === 'natural' ? 'muted' : ''}>
            {p.reason === 'natural' ? '自然播完' : p.reason === 'stolen' ? '超出并发上限被结束（偷旧声）' : '松键/手动结束'}
          </span>
        </span>
      );
    case 'sample-status':
      return (
        <span>
          {String(p.sampleId)} → <b>{String(p.status)}</b>
          {p.reason ? `（${String(p.reason)}）` : ''}
        </span>
      );
    case 'release':
      return <span>press=#{String(p.pressId)} 停掉 voice {String(p.voiceIds)}</span>;
    case 'rotation-reset':
      return <span>计数器归零；仍在响的声音 {String(p.activeVoices)} 条不受影响</span>;
    case 'replay-start':
    case 'replay-done':
      return <span>{String(p.count)} 步</span>;
    default:
      return <span className="muted">{JSON.stringify(p)}</span>;
  }
}
