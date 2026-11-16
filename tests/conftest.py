import json
import os
import shutil
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from extractor import rules as rulemod  # noqa: E402
from extractor import storage as st  # noqa: E402
from extractor.ingest import ingest_document  # noqa: E402
from sample_data.make_samples import generate  # noqa: E402


@pytest.fixture()
def env(tmp_path):
    """完整环境：样例文档已导入并读取，默认规则已设为当前版本。"""
    db_path = str(tmp_path / "app.db")
    storage = str(tmp_path / "data")
    os.makedirs(os.path.join(storage, "uploads"), exist_ok=True)
    st.init_db(db_path)
    samples = generate(str(tmp_path / "samples"))
    conn = st.connect(db_path)
    doc_ids = {}
    for name, path in samples.items():
        ext = os.path.splitext(path)[1].lower()
        dest = os.path.join(storage, "uploads", os.path.basename(path))
        shutil.copy(path, dest)
        doc_id = st.add_document(conn, f"{name}{ext}", dest, ext, st.sha1_file(dest))
        conn.commit()
        ingest_document(conn, storage, doc_id)
        doc_ids[name] = doc_id
    config = json.loads(json.dumps(rulemod.DEFAULT_CONFIG))
    version = rulemod.version_of(config)
    st.save_ruleset(conn, config["name"], version, json.dumps(config, ensure_ascii=False))
    conn.commit()
    conn.close()
    return SimpleNamespace(
        db_path=db_path, storage=storage, doc_ids=doc_ids,
        config=config, version=version, samples=samples,
    )


def read_doc(conn, doc_id):
    return conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
