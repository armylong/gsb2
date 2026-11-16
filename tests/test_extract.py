import json
import os

from extractor import storage as st
from extractor.extract import extract_document


def _extract(env, doc_name):
    conn = st.connect(env.db_path)
    try:
        _, results = extract_document(
            conn, env.doc_ids[doc_name], env.config, env.version)
        return {r["field"]: r for r in results}
    finally:
        conn.close()


def test_layout_a_all_fields_ok_with_location(env):
    res = _extract(env, "layoutA")
    assert res["合同编号"]["status"] == "ok"
    assert res["合同编号"]["value"] == "HT-2026-018"
    # 来源位置：页码、行号、坐标都要在
    assert res["合同编号"]["page_no"] == 1
    assert res["合同编号"]["line_no"] > 0
    assert res["合同编号"]["bbox"]
    assert res["签订日期"]["value"] == "2026-03-15"
    assert res["签订日期"]["page_no"] == 2
    assert res["合同总金额"]["value"] == "128500.00"
    assert res["付款批次"]["status"] == "ok"
    assert "第一期" in res["付款批次"]["value"]
    assert "第二期" in res["付款批次"]["value"]


def test_layout_b_variant_labels(env):
    """版式变化：不同标签措辞与日期/金额写法也能命中。"""
    res = _extract(env, "layoutB")
    assert res["合同编号"]["status"] == "ok"
    assert res["合同编号"]["value"] == "HT-2026-018"
    assert res["签订日期"]["value"] == "2026-03-15"
    assert res["合同总金额"]["value"] == "128500.00"


def test_layout_c_duplicate_candidates_not_autopicked(env):
    """重复候选：状态 multiple，保留全部候选，绝不自动选第一个。"""
    res = _extract(env, "layoutC")
    no = res["合同编号"]
    assert no["status"] == "multiple"
    assert no["value"] is None
    assert len(no["candidates"]) >= 3  # 两页页眉 + 正文
    pages = {c["page_no"] for c in no["candidates"]}
    assert pages == {1, 2}
    # 其他字段不受影响
    assert res["合同总金额"]["status"] == "ok"


def test_missing_and_invalid(env, tmp_path):
    # 构造：一个字段不存在（missing），一个日期格式错误（invalid）
    bad = tmp_path / "bad.txt"
    bad.write_text("采购合同\n合同编号：HT-2026-018\n签订日期：2026年13月40日\n", encoding="utf-8")
    conn = st.connect(env.db_path)
    try:
        doc_id = st.add_document(conn, "bad.txt", str(bad), ".txt", "h")
        conn.commit()
        from extractor.ingest import ingest_document
        assert ingest_document(conn, env.storage, doc_id)[0]
        config = json.loads(json.dumps(env.config))
        config["fields"].append({
            "name": "不存在的字段", "kind": "text",
            "match": {"method": "keyword", "keywords": ["绝不存在的关键词"]},
            "multi": False,
        })
        _, results = extract_document(conn, doc_id, config, "v_test")
        by = {r["field"]: r for r in results}
        assert by["签订日期"]["status"] == "invalid"
        assert by["签订日期"]["value"] == "2026年13月40日"  # 原样保留供核对
        assert by["不存在的字段"]["status"] == "missing"
        assert by["合同编号"]["status"] == "ok"
    finally:
        conn.close()


def test_region_restriction(env):
    """region 方式：限定页码后，页眉编号不再干扰。"""
    conn = st.connect(env.db_path)
    try:
        config = json.loads(json.dumps(env.config))
        for f in config["fields"]:
            if f["name"] == "合同编号":
                f["match"]["page"] = 1  # 只看第 1 页
        _, results = extract_document(
            conn, env.doc_ids["layoutC"], config, "v_region")
        no = {r["field"]: r for r in results}["合同编号"]
        # 第 1 页仍有页眉+正文两处 -> 仍 multiple，但候选都来自第 1 页
        assert all(c["page_no"] == 1 for c in no["candidates"])
    finally:
        conn.close()
