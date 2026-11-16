import shutil

import pytest

from extractor import storage as st
from tests.conftest import read_doc


def test_text_pdf_and_txt_read_ok(env):
    conn = st.connect(env.db_path)
    try:
        for name in ("layoutA", "layoutB", "layoutC", "txt"):
            doc = read_doc(conn, env.doc_ids[name])
            assert doc["status"] == "ok", f"{name}: {doc['error']}"
            assert doc["page_count"] >= 1
        # 多页样例确实有 2 页
        assert read_doc(conn, env.doc_ids["layoutA"])["page_count"] == 2
    finally:
        conn.close()


def test_corrupt_file_failed_with_reason(env):
    conn = st.connect(env.db_path)
    try:
        doc = read_doc(conn, env.doc_ids["corrupt"])
        assert doc["status"] == "failed"
        assert doc["error"]  # 无法识别的文件必须有说明
    finally:
        conn.close()


def test_unsupported_type_failed(env, tmp_path):
    weird = tmp_path / "data.xyz"
    weird.write_bytes(b"whatever")
    conn = st.connect(env.db_path)
    try:
        doc_id = st.add_document(conn, "data.xyz", str(weird), ".xyz", "h")
        conn.commit()
        from extractor.ingest import ingest_document
        ok, err = ingest_document(conn, env.storage, doc_id)
        assert not ok and "不支持" in err
        assert read_doc(conn, doc_id)["status"] == "failed"
    finally:
        conn.close()


@pytest.mark.skipif(not shutil.which("tesseract"), reason="需要本地 tesseract")
def test_scanned_image_ocr(env):
    conn = st.connect(env.db_path)
    try:
        doc = read_doc(conn, env.doc_ids["scan"])
        assert doc["status"] == "ok", doc["error"]
        pages = st.get_pages(conn, env.doc_ids["scan"])
        assert pages[0]["source"] == "ocr"
        assert pages[0]["image_path"]  # 扫描页保留图像供回看
        text = pages[0]["text"]
        assert "HT-2026-018" in text.replace(" ", "")
    finally:
        conn.close()
