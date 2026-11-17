import { ReqEntry } from '../playerController';

const STATUS_TEXT: Record<ReqEntry['status'], string> = {
  pending: '等待中',
  ok: '成功',
  retrying: '失败后重试中',
  error: '已失败',
};

export function RequestLog({ requests }: { requests: ReqEntry[] }) {
  const shown = [...requests].slice(-15).reverse();
  if (shown.length === 0) {
    return <div className="hint">暂无请求。加载清单并开始播放后，这里会列出每个分片的归属清晰度、内容区间、耗时与结果。</div>;
  }
  return (
    <table className="req-table" data-testid="request-log">
      <thead>
        <tr>
          <th>#</th>
          <th>清晰度</th>
          <th>内容区间</th>
          <th>状态</th>
          <th>尝试</th>
          <th>耗时</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.id} className={`req-${r.status}`}>
            <td>{r.sn}</td>
            <td>{r.levelLabel}</td>
            <td>
              {r.rangeStart.toFixed(1)}–{r.rangeEnd.toFixed(1)}s
            </td>
            <td>
              {STATUS_TEXT[r.status]}
              {r.error ? <span className="err-detail">（{r.error}）</span> : null}
            </td>
            <td>{r.attempt}</td>
            <td>{r.endTs != null ? `${Math.round(r.endTs - r.startTs)}ms` : '…'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
