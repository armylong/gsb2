"""人工确认、备注、关闭。结论挂在 finding 上，重跑不会覆盖。"""
from .db import now_iso


def _get(conn, finding_id):
    row = conn.execute("SELECT * FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
    if row is None:
        raise ValueError(f"no such finding: {finding_id}")
    return row


def _current_hash(conn, finding):
    row = conn.execute(
        "SELECT content_hash FROM records WHERE run_id=? AND record_key=?",
        (finding["last_seen_run"], finding["record_key"])).fetchone()
    return row["content_hash"] if row else None


def triage(conn, finding_id, action, note=None, by=None):
    """action: confirm|close|reopen|note|ack"""
    f = _get(conn, finding_id)
    now = now_iso()
    if action in ("confirm", "close"):
        manual = "confirmed" if action == "confirm" else "closed"
        conn.execute(
            "UPDATE findings SET manual_status=?, triaged_at=?, triaged_by=?,"
            " record_hash_at_triage=?, data_changed=0, note = CASE WHEN ?!='' THEN ? ELSE note END"
            " WHERE finding_id=?",
            (manual, now, by, _current_hash(conn, f), note or "", note or "", finding_id))
    elif action == "reopen":
        conn.execute(
            "UPDATE findings SET manual_status=NULL, triaged_at=?, triaged_by=? WHERE finding_id=?",
            (now, by, finding_id))
    elif action == "note":
        if not note:
            raise ValueError("note action requires note text")
        conn.execute("UPDATE findings SET note=? WHERE finding_id=?", (note, finding_id))
    elif action == "ack":
        # 确认“数据已变化”提示：以当前数据哈希重新锚定人工结论
        conn.execute(
            "UPDATE findings SET data_changed=0, record_hash_at_triage=? WHERE finding_id=?",
            (_current_hash(conn, f), finding_id))
    else:
        raise ValueError(f"unknown triage action: {action}")
    conn.commit()
    return _get(conn, finding_id)


def list_findings(conn, dataset=None, manual_status=None, only_open=False):
    sql = "SELECT * FROM findings WHERE 1=1"
    args = []
    if dataset:
        sql += " AND dataset=?"
        args.append(dataset)
    if manual_status == "none":
        sql += " AND manual_status IS NULL"
    elif manual_status:
        sql += " AND manual_status=?"
        args.append(manual_status)
    if only_open:
        sql += " AND last_status='fail'"
    sql += " ORDER BY finding_id"
    return [dict(r) for r in conn.execute(sql, tuple(args))]
