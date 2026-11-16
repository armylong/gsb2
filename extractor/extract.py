"""抽取引擎：按规则在页/行上找候选，判定状态，记录来源位置。

状态语义：
- ok        恰好一个候选且格式校验通过（多值字段：至少一个有效候选）
- missing   没有找到任何候选
- multiple  单值字段找到多个候选——全部保留，绝不自动选第一个
- invalid   有候选但格式校验全部不通过
"""

import re
import uuid

from .validate import validate


def _in_region(line, page_no, match):
    """区域限定：page(1起) / line_range(页内行号,1起) / bbox(与行框相交)。"""
    page = match.get("page")
    if page and page_no != int(page):
        return False
    lr = match.get("line_range")
    if lr and not (int(lr[0]) <= line["line_no"] <= int(lr[1])):
        return False
    bbox = match.get("bbox")
    if bbox and line.get("bbox"):
        lb = line["bbox"]
        if lb[2] < bbox[0] or lb[0] > bbox[2] or lb[3] < bbox[1] or lb[1] > bbox[3]:
            return False
    return True


def _cand(value, page_no, line, context):
    return {
        "value": value.strip(),
        "page_no": page_no,
        "line_no": line["line_no"],
        "bbox": line.get("bbox"),
        "context": context.strip()[:200],
    }


def find_candidates(pages, match):
    """在所有页的行上按匹配方式收集候选，每个候选都带来源位置。"""
    method = match.get("method", "regex")
    pattern = match.get("pattern")
    rx = re.compile(pattern) if pattern else None
    keywords = match.get("keywords") or []
    cands = []
    for page in pages:
        lines = page["lines"]
        for idx, line in enumerate(lines):
            if not _in_region(line, page["page_no"], match):
                continue
            text = line["text"]
            if method in ("regex", "region"):
                if not rx:
                    continue
                for m in rx.finditer(text):
                    cands.append(_cand(m.group(0), page["page_no"], line, text))
            elif method == "keyword":
                for kw in keywords:
                    pos = text.find(kw)
                    if pos < 0:
                        continue
                    rest = text[pos + len(kw):].lstrip(" ：:：")
                    if rx:
                        # 优先在关键词之后的同行内容里找（可能多个），其次整行
                        hits = list(rx.finditer(rest)) or list(rx.finditer(text))
                        for m in hits:
                            cands.append(_cand(m.group(0), page["page_no"], line, text))
                    elif rest:
                        cands.append(_cand(rest, page["page_no"], line, text))
                    elif idx + 1 < len(lines) and lines[idx + 1]["text"].strip():
                        # 关键词独占一行时取下一行（版式变化常见）
                        nxt = lines[idx + 1]
                        cands.append(_cand(nxt["text"], page["page_no"], nxt, nxt["text"]))
                    break  # 一行只取一个关键词命中
    # 按 (值, 页, 行) 去重，保留首次出现
    seen, uniq = set(), []
    for c in cands:
        key = (c["value"], c["page_no"], c["line_no"])
        if key not in seen and c["value"]:
            seen.add(key)
            uniq.append(c)
    return uniq


def judge(field, candidates):
    """根据候选与校验结果给出字段状态与取值。"""
    kind = field.get("kind", "text")
    params = field.get("validate") or {}
    for c in candidates:
        ok, normalized = validate(kind, c["value"], params)
        c["valid"] = ok
        c["normalized"] = normalized
    multi = bool(field.get("multi"))
    if not candidates:
        return {"status": "missing", "value": None, "candidates": []}
    valid = [c for c in candidates if c["valid"]]
    if multi:
        if not valid:
            return {"status": "invalid", "value": None, "candidates": candidates}
        return {
            "status": "ok",
            "value": "；".join(c["normalized"] for c in valid),
            "candidates": candidates,
            "page_no": valid[0]["page_no"], "line_no": valid[0]["line_no"],
            "bbox": valid[0]["bbox"],
        }
    if len(candidates) > 1:
        # 多个候选：保留全部，不自动选择
        return {"status": "multiple", "value": None, "candidates": candidates}
    c = candidates[0]
    if not c["valid"]:
        return {
            "status": "invalid", "value": c["value"], "candidates": candidates,
            "page_no": c["page_no"], "line_no": c["line_no"], "bbox": c["bbox"],
        }
    return {
        "status": "ok", "value": c["normalized"], "candidates": candidates,
        "page_no": c["page_no"], "line_no": c["line_no"], "bbox": c["bbox"],
    }


def extract_document(conn, doc_id, config, version):
    """对单个文档执行整套规则，写入结果。返回 (run_id, results)。"""
    from . import storage as st

    pages = st.get_pages(conn, doc_id)
    results = []
    for field in config.get("fields", []):
        cands = find_candidates(pages, field.get("match") or {})
        r = judge(field, cands)
        r["field"] = field["name"]
        results.append(r)
    run_id = uuid.uuid4().hex[:12]
    st.replace_extractions(conn, doc_id, version, run_id, results)
    conn.commit()
    return run_id, results
