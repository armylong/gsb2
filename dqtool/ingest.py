"""输入文件读取：CSV / JSON 数组 / NDJSON，流式产出记录，坏行标记为 corrupt。"""
import csv
import hashlib
import json
import os


def file_sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def record_content_hash(record):
    canon = json.dumps(record, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def detect_format(path, fmt=None):
    if fmt:
        return fmt
    ext = os.path.splitext(path)[1].lower()
    if ext == ".csv":
        return "csv"
    if ext in (".ndjson", ".jsonl"):
        return "ndjson"
    if ext == ".json":
        return "json"
    raise ValueError(f"cannot detect format of {path}; use --format csv|json|ndjson")


def iter_records(path, fmt=None):
    """产出 (line_no, record_dict|None, corrupt_reason|None)。
    文件级错误（无法打开、JSON 整体解析失败）抛异常，由 runner 记为 failed。"""
    fmt = detect_format(path, fmt)
    if fmt == "csv":
        yield from _iter_csv(path)
    elif fmt == "ndjson":
        yield from _iter_ndjson(path)
    elif fmt == "json":
        yield from _iter_json(path)
    else:
        raise ValueError(f"unknown format: {fmt}")


def _iter_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError("csv file has no header")
        for i, row in enumerate(reader, start=2):  # 第 1 行是表头
            if None in row:  # 列数多于表头
                yield i, None, f"row has extra fields: {row.get(None)}"
            elif any(v is None for v in row.values()):  # 列数不足
                yield i, None, "row has fewer fields than header"
            else:
                yield i, dict(row), None


def _iter_ndjson(path):
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                yield i, None, f"invalid json: {e}"
                continue
            if not isinstance(obj, dict):
                yield i, None, "json line is not an object"
                continue
            yield i, obj, None


def _iter_json(path):
    with open(path, encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            # 整个文件不是合法 JSON，退化为 NDJSON 逐行定位坏行
            yield from _iter_ndjson(path)
            return
    if not isinstance(data, list):
        raise ValueError("json input must be an array of objects")
    for i, obj in enumerate(data, start=1):
        if not isinstance(obj, dict):
            yield i, None, "json item is not an object"
        else:
            yield i, obj, None
