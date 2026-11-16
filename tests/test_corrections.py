import json

from extractor import rules as rulemod
from extractor import storage as st
from extractor.extract import extract_document


def test_correction_recorded_and_survives_reextract(env):
    conn = st.connect(env.db_path)
    try:
        doc_id = env.doc_ids["layoutA"]
        extract_document(conn, doc_id, env.config, env.version)

        # 人工修正：保留原值、修正值、操作者、时间
        st.add_correction(conn, doc_id, "合同编号", "HT-2026-018", "HT-2026-018X", "张三")
        conn.commit()
        corr = conn.execute(
            "SELECT * FROM corrections WHERE document_id=?", (doc_id,)).fetchone()
        assert corr["original_value"] == "HT-2026-018"
        assert corr["corrected_value"] == "HT-2026-018X"
        assert corr["operator"] == "张三"
        assert corr["created_at"]

        # 规则变更 -> 新版本 -> 重新抽取
        config2 = json.loads(json.dumps(env.config))
        config2["name"] = "采购合同规则v2"
        v2 = rulemod.version_of(config2)
        assert v2 != env.version
        st.save_ruleset(conn, config2["name"], v2, json.dumps(config2, ensure_ascii=False))
        extract_document(conn, doc_id, config2, v2)

        # 修正不丢，且优先于新抽取的机器值
        results = {r["field"]: r for r in st.effective_results(conn, doc_id, v2)}
        no = results["合同编号"]
        assert no["corrected"] is True
        assert no["effective_value"] == "HT-2026-018X"
        assert no["value"] == "HT-2026-018"  # 机器值仍在，未覆盖修正
    finally:
        conn.close()


def test_old_version_results_not_mistaken_for_new(env):
    """规则版本变化后，旧结果与新结果并存但严格按版本区分。"""
    conn = st.connect(env.db_path)
    try:
        doc_id = env.doc_ids["layoutA"]
        extract_document(conn, doc_id, env.config, env.version)
        config2 = json.loads(json.dumps(env.config))
        config2["name"] = "v2"
        v2 = rulemod.version_of(config2)
        extract_document(conn, doc_id, config2, v2)
        versions = {r["ruleset_version"] for r in conn.execute(
            "SELECT DISTINCT ruleset_version FROM extractions WHERE document_id=?",
            (doc_id,))}
        assert versions == {env.version, v2}
        old = st.effective_results(conn, doc_id, env.version)
        new = st.effective_results(conn, doc_id, v2)
        assert all(r["ruleset_version"] == env.version for r in old)
        assert all(r["ruleset_version"] == v2 for r in new)
    finally:
        conn.close()
