"""导出：已确认结果与异常清单，每行都可追溯到文档与页码。"""

import csv
import io

from . import storage as st

HEADER = [
    "文档ID", "文件名", "字段", "有效值", "状态", "是否人工修正",
    "修正人", "修正时间", "页码", "行号", "规则版本", "抽取时间",
]


def _rows(conn, version, only_confirmed=False, anomalies_only=False):
    docs = conn.execute("SELECT * FROM documents ORDER BY id").fetchall()
    out = []
    for doc in docs:
        for r in st.effective_results(conn, doc["id"], version):
            confirmed = r["corrected"] or r["status"] == "ok"
            is_anomaly = (not r["corrected"]) and r["status"] != "ok"
            if only_confirmed and not confirmed:
                continue
            if anomalies_only and not is_anomaly:
                continue
            corr = r["correction"] or {}
            out.append([
                doc["id"], doc["filename"], r["field"],
                r["effective_value"] or "",
                "已人工修正" if r["corrected"] else r["status"],
                "是" if r["corrected"] else "否",
                corr.get("operator", ""), corr.get("created_at", ""),
                r["page_no"] if r["page_no"] is not None else "",
                r["line_no"] if r["line_no"] is not None else "",
                r["ruleset_version"], r["created_at"],
            ])
    return out


def _to_csv(rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(HEADER)
    w.writerows(rows)
    return "﻿" + buf.getvalue()  # BOM 便于 Excel 打开


def export_confirmed(conn, version):
    """已确认结果：机器 ok 或经人工修正的字段。"""
    return _to_csv(_rows(conn, version, only_confirmed=True))


def export_anomalies(conn, version):
    """异常清单：缺失 / 多候选 / 格式错误，且未经人工修正。"""
    return _to_csv(_rows(conn, version, anomalies_only=True))
