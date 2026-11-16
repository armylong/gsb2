"""字段格式校验：日期、金额、编号、纯文本。

每个校验函数返回 (ok, normalized)。格式错误绝不静默通过，
也不做"取第一个候选"之类的隐式选择——那是抽取层的状态判断职责。
"""

import re
from datetime import datetime

_DATE_FORMATS = ["%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日", "%Y年%m月%d号"]

_AMOUNT_RE = re.compile(r"^-?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^-?\d+(\.\d{1,2})?$")

_DEFAULT_ID_RE = r"^[A-Za-z0-9][A-Za-z0-9_\-./]{1,39}$"


def validate_date(value):
    s = (value or "").strip()
    # 允许“2024年3月5日”这类单数字月日
    m = re.fullmatch(r"(\d{4})年(\d{1,2})月(\d{1,2})[日号]?", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return True, datetime(y, mo, d).date().isoformat()
        except ValueError:
            return False, s
    for fmt in _DATE_FORMATS:
        try:
            return True, datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return False, s


def validate_amount(value):
    s = (value or "").strip()
    cleaned = s
    for token in ("人民币", "￥", "¥", "元整", "元", " ", ","):
        cleaned = cleaned.replace(token, "")
    if not _AMOUNT_RE.match(cleaned.replace(",", "")):
        return False, s
    try:
        return True, f"{float(cleaned.replace(',', '')):.2f}"
    except ValueError:
        return False, s


def validate_id(value, pattern=None):
    s = (value or "").strip()
    rx = pattern or _DEFAULT_ID_RE
    try:
        if re.fullmatch(rx, s):
            return True, s
    except re.error:
        return False, s
    return False, s


def validate(kind, value, params=None):
    """kind: text | date | amount | id。params 可含 id_pattern。"""
    params = params or {}
    if kind == "date":
        return validate_date(value)
    if kind == "amount":
        return validate_amount(value)
    if kind == "id":
        return validate_id(value, params.get("id_pattern"))
    return True, (value or "").strip()
