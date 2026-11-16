"""规则集：字段定义、匹配方式、区域限定、多值字段，以及规则版本。

版本 = 配置内容的哈希。任何规则修改都会产生新版本号，
旧版本结果保留但不会被当作新规则的结果。
"""

import hashlib
import json

MATCH_METHODS = ("regex", "keyword", "region")
FIELD_KINDS = ("text", "date", "amount", "id")

DEFAULT_CONFIG = {
    "name": "采购合同默认规则",
    "fields": [
        {
            "name": "合同编号",
            "kind": "id",
            "match": {
                "method": "keyword",
                "keywords": ["合同编号", "协议编号", "编号"],
                "pattern": r"[A-Za-z]{2,4}-\d{4}-\d{3,4}",
            },
            "multi": False,
        },
        {
            "name": "签订日期",
            "kind": "date",
            "match": {
                "method": "keyword",
                "keywords": ["签订日期", "签署日期", "签约日期"],
                "pattern": r"\d{4}年\d{1,2}月\d{1,2}[日号]?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}",
            },
            "multi": False,
        },
        {
            "name": "合同总金额",
            "kind": "amount",
            "match": {
                "method": "keyword",
                "keywords": ["合同总金额", "总金额", "合同金额"],
                "pattern": r"[¥￥]?\s?\d[\d,]*(\.\d{1,2})?\s?元?",
            },
            "multi": False,
        },
        {
            "name": "付款批次",
            "kind": "text",
            "match": {
                "method": "keyword",
                "keywords": ["付款批次", "期数"],
                "pattern": r"第?[一二三四五六七八九十\d]+[期批]",
            },
            "multi": True,
        },
    ],
}


def version_of(config):
    blob = json.dumps(config, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:10]


def validate_config(config):
    """返回错误列表；空列表表示配置合法。"""
    errors = []
    if not isinstance(config, dict):
        return ["配置必须是 JSON 对象"]
    fields = config.get("fields")
    if not isinstance(fields, list) or not fields:
        return ["配置必须包含非空 fields 数组"]
    seen = set()
    for i, f in enumerate(fields):
        tag = f"fields[{i}]"
        name = f.get("name")
        if not name or not isinstance(name, str):
            errors.append(f"{tag}: 缺少字段名称 name")
            continue
        if name in seen:
            errors.append(f"{tag}: 字段名重复: {name}")
        seen.add(name)
        kind = f.get("kind", "text")
        if kind not in FIELD_KINDS:
            errors.append(f"{tag}({name}): kind 必须是 {FIELD_KINDS} 之一")
        match = f.get("match")
        if not isinstance(match, dict):
            errors.append(f"{tag}({name}): 缺少 match 对象")
            continue
        method = match.get("method")
        if method not in MATCH_METHODS:
            errors.append(f"{tag}({name}): method 必须是 {MATCH_METHODS} 之一")
        if method in ("regex", "keyword") and not match.get("pattern") and method == "regex":
            errors.append(f"{tag}({name}): regex 方式必须提供 pattern")
        if method == "keyword" and not match.get("keywords"):
            errors.append(f"{tag}({name}): keyword 方式必须提供 keywords")
        if method == "region" and not (match.get("page") or match.get("bbox") or match.get("line_range")):
            errors.append(f"{tag}({name}): region 方式必须给出 page/bbox/line_range 之一")
        pattern = match.get("pattern")
        if pattern:
            import re
            try:
                re.compile(pattern)
            except re.error as e:
                errors.append(f"{tag}({name}): pattern 不是合法正则: {e}")
        bbox = match.get("bbox")
        if bbox is not None and not (isinstance(bbox, list) and len(bbox) == 4):
            errors.append(f"{tag}({name}): bbox 必须是 [x0,y0,x1,y1]")
    return errors
