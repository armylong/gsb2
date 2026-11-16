"""把各来源的原始记录归一到统一事件结构。"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Optional

from .timeutil import parse_time


@dataclass
class NormalizedEvent:
    event_id: str
    biz_time: str           # UTC ISO, 秒级
    biz_key: str
    amount: Optional[float]
    status: Optional[str]
    source: str
    source_file: str
    source_line: int
    content_hash: str = field(default="", compare=False)

    def finalize(self) -> "NormalizedEvent":
        payload = json.dumps(
            {
                "event_id": self.event_id,
                "biz_time": self.biz_time,
                "biz_key": self.biz_key,
                "amount": self.amount,
                "status": self.status,
            },
            sort_keys=True,
            ensure_ascii=False,
        )
        self.content_hash = hashlib.sha1(payload.encode("utf-8")).hexdigest()
        return self


def normalize_record(source_cfg: dict, raw: dict, source_file: str, line_no: int) -> NormalizedEvent:
    """把一条原始记录映射为统一事件。字段缺失或格式错误时抛 ValueError。"""
    mapping = source_cfg["mapping"]
    name = source_cfg["name"]

    def need(field: str) -> str:
        col = mapping[field]
        value = raw.get(col)
        if value is None or str(value).strip() == "":
            raise ValueError(f"缺少字段 {col!r}(映射到 {field})")
        return str(value).strip()

    event_id = need("event_id")
    biz_key = need("biz_key")
    biz_time = parse_time(need("biz_time"), source_cfg["time_formats"])

    amount = None
    amount_col = mapping.get("amount")
    if amount_col:
        raw_amount = raw.get(amount_col)
        if raw_amount is not None and str(raw_amount).strip() != "":
            try:
                amount = float(str(raw_amount).strip())
            except ValueError:
                raise ValueError(f"金额字段 {amount_col!r} 不是数字: {raw_amount!r}")

    status = None
    status_col = mapping.get("status")
    if status_col:
        raw_status = raw.get(status_col)
        if raw_status is not None and str(raw_status).strip() != "":
            status = str(raw_status).strip()

    return NormalizedEvent(
        event_id=event_id,
        biz_time=biz_time,
        biz_key=biz_key,
        amount=amount,
        status=status,
        source=name,
        source_file=source_file,
        source_line=line_no,
    ).finalize()
