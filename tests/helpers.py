"""测试数据构造工具: 在临时目录里生成多来源事件文件与配置。"""

from __future__ import annotations

import json
import os


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


def make_config(base, sources, window="1d", db_name="test.db"):
    cfg = {
        "db": os.path.join(base, db_name),
        "window": window,
        "sources": sources,
    }
    path = os.path.join(base, "config.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    return path


def pay_source(glob_path):
    return {
        "name": "pay",
        "path": glob_path,
        "format": "csv",
        "mapping": {
            "event_id": "order_id",
            "biz_time": "pay_time",
            "biz_key": "merchant",
            "amount": "amount",
            "status": "state",
        },
        "time_formats": ["%Y-%m-%d %H:%M:%S", "iso"],
    }


def refund_source(glob_path):
    return {
        "name": "refund",
        "path": glob_path,
        "format": "jsonl",
        "mapping": {
            "event_id": "rid",
            "biz_time": "ts",
            "biz_key": "shop",
            "amount": "amt",
            "status": "result",
        },
        "time_formats": ["iso", "epoch"],
    }
