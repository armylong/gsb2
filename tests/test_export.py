import csv
import io

from extractor import storage as st
from extractor.export import export_anomalies, export_confirmed
from extractor.extract import extract_document


def _rows(csv_text):
    return list(csv.DictReader(io.StringIO(csv_text.lstrip("﻿"))))


def test_export_confirmed_traceable(env):
    conn = st.connect(env.db_path)
    try:
        for name in ("layoutA", "layoutB"):
            extract_document(conn, env.doc_ids[name], env.config, env.version)
        # 修正一条，确认修正结果也进入已确认导出
        st.add_correction(conn, env.doc_ids["layoutA"], "合同编号",
                          "HT-2026-018", "HT-2026-018X", "李四")
        conn.commit()
        rows = _rows(export_confirmed(conn, env.version))
        assert rows
        no = [r for r in rows
              if r["文件名"] == "layoutA.pdf" and r["字段"] == "合同编号"][0]
        assert no["有效值"] == "HT-2026-018X"
        assert no["是否人工修正"] == "是"
        assert no["修正人"] == "李四"
        # 可追溯：文档 ID、页码、规则版本都在
        assert no["文档ID"] == str(env.doc_ids["layoutA"])
        assert no["页码"] == "1"
        assert no["规则版本"] == env.version
    finally:
        conn.close()


def test_export_anomalies(env):
    conn = st.connect(env.db_path)
    try:
        extract_document(conn, env.doc_ids["layoutA"], env.config, env.version)
        extract_document(conn, env.doc_ids["layoutC"], env.config, env.version)
        rows = _rows(export_anomalies(conn, env.version))
        # layoutC 的合同编号是多候选，应进异常清单
        hit = [r for r in rows
               if r["文件名"] == "layoutC.pdf" and r["字段"] == "合同编号"]
        assert len(hit) == 1
        assert hit[0]["状态"] == "multiple"
        # layoutA 全部正常，不应出现在异常清单
        assert not [r for r in rows if r["文件名"] == "layoutA.pdf"]
        # 人工修正后从异常清单消失
        st.add_correction(conn, env.doc_ids["layoutC"], "合同编号",
                          None, "HT-2026-018", "王五")
        conn.commit()
        rows2 = _rows(export_anomalies(conn, env.version))
        assert not [r for r in rows2
                    if r["文件名"] == "layoutC.pdf" and r["字段"] == "合同编号"]
    finally:
        conn.close()
