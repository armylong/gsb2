import { useCallback, useEffect, useState } from 'react';

interface Rule {
  id: number;
  pattern: string;
  type: 'delay' | 'fail-once' | 'fail-always';
  delayMs: number;
}

const TYPE_TEXT: Record<Rule['type'], string> = {
  delay: '延迟',
  'fail-once': '首次失败后恢复',
  'fail-always': '持续不可用',
};

export function FaultPanel({
  refreshKey,
  onChanged,
}: {
  refreshKey: number;
  onChanged: () => void;
}) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [throttle, setThrottle] = useState(0);
  const [throttleInput, setThrottleInput] = useState('0');
  const [segments, setSegments] = useState<string[]>([]);
  const [pattern, setPattern] = useState('');
  const [type, setType] = useState<Rule['type']>('delay');
  const [delayMs, setDelayMs] = useState('2000');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const res = await fetch('/api/faults');
    const data = await res.json();
    setRules(data.rules);
    setThrottle(data.throttleKbps);
    setThrottleInput(String(data.throttleKbps));
  }, []);

  useEffect(() => {
    void reload();
    fetch('/api/segments')
      .then((r) => r.json())
      .then((d) => setSegments(d.segments))
      .catch(() => setSegments([]));
  }, [reload, refreshKey]);

  const save = async (nextRules: Omit<Rule, 'id'>[], nextThrottle: number) => {
    const res = await fetch('/api/faults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: nextRules, throttleKbps: nextThrottle }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || '保存失败');
      return false;
    }
    setError('');
    await reload();
    onChanged();
    return true;
  };

  const toPlain = (list: Rule[]) =>
    list.map((r) => ({ pattern: r.pattern, type: r.type, delayMs: r.delayMs }));

  return (
    <div data-testid="fault-panel">
      {rules.length === 0 && Number(throttle) === 0 ? (
        <div className="hint">当前没有生效的故障规则，传输未限速。</div>
      ) : (
        <table className="req-table">
          <thead>
            <tr>
              <th>作用对象（路径包含）</th>
              <th>行为</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  <code>{r.pattern}</code>
                </td>
                <td>
                  {TYPE_TEXT[r.type]}
                  {r.type === 'delay' ? ` ${r.delayMs}ms` : ''}
                </td>
                <td>
                  <button
                    onClick={() =>
                      save(
                        toPlain(rules.filter((x) => x.id !== r.id)),
                        Number(throttle),
                      )
                    }
                  >
                    关闭
                  </button>
                </td>
              </tr>
            ))}
            {Number(throttle) > 0 && (
              <tr>
                <td>
                  <code>全部分片</code>
                </td>
                <td>限速 {throttle} kbps</td>
                <td>
                  <button onClick={() => save(toPlain(rules), 0)}>关闭</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <input
          data-testid="fault-pattern"
          list="segment-list"
          placeholder="作用对象，如 segment_005.ts 或 v2/"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          style={{ flex: 1 }}
        />
        <datalist id="segment-list">
          {segments.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <select
          data-testid="fault-type"
          value={type}
          onChange={(e) => setType(e.target.value as Rule['type'])}
        >
          <option value="delay">延迟</option>
          <option value="fail-once">首次失败后恢复</option>
          <option value="fail-always">持续不可用</option>
        </select>
        {type === 'delay' && (
          <input
            data-testid="fault-delay"
            type="number"
            min={100}
            step={100}
            value={delayMs}
            onChange={(e) => setDelayMs(e.target.value)}
            style={{ width: 90 }}
            title="延迟毫秒"
          />
        )}
        <button
          data-testid="fault-add"
          onClick={() => {
            if (!pattern.trim()) {
              setError('请填写规则作用对象');
              return;
            }
            void save(
              [...toPlain(rules), { pattern: pattern.trim(), type, delayMs: Number(delayMs) || 2000 }],
              Number(throttle),
            );
          }}
        >
          添加规则
        </button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <label>
          整体限速（kbps，仅作用于分片，0 为不限）：
          <input
            data-testid="throttle-input"
            type="number"
            min={0}
            step={100}
            value={throttleInput}
            onChange={(e) => setThrottleInput(e.target.value)}
            style={{ width: 100, marginLeft: 6 }}
          />
        </label>
        <button onClick={() => save(toPlain(rules), Number(throttleInput) || 0)}>应用限速</button>
        <button
          data-testid="fault-clear"
          onClick={async () => {
            await fetch('/api/faults', { method: 'DELETE' });
            await reload();
            onChanged();
          }}
        >
          清除全部故障
        </button>
      </div>
      {error && <div className="banner banner-error">{error}</div>}
      <div className="hint" style={{ marginTop: 8 }}>
        规则只影响之后的请求，不会修改素材文件；关闭规则后，后续请求立即恢复正常。
      </div>
    </div>
  );
}
