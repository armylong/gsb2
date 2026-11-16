"""配置加载与校验.

配置文件为 JSON, 示例见 examples/config.json:

{
  "db": "eventreplay.db",
  "window": "1d",
  "sources": [
    {
      "name": "pay",
      "path": "data/pay/*.csv",
      "format": "csv",
      "mapping": {
        "event_id": "order_id",
        "biz_time": "pay_time",
        "biz_key": "merchant",
        "amount": "amount",
        "status": "state"
      },
      "time_formats": ["%Y-%m-%d %H:%M:%S", "iso"]
    }
  ]
}

mapping 中 event_id/biz_time/biz_key 必填, amount/status 可选。
format 支持 csv 与 jsonl。path 支持 glob, 相对路径相对于配置文件所在目录。
"""

from __future__ import annotations

import json
import os

REQUIRED_FIELDS = ("event_id", "biz_time", "biz_key")
OPTIONAL_FIELDS = ("amount", "status")
SUPPORTED_FORMATS = ("csv", "jsonl")


class ConfigError(ValueError):
    pass


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    base = os.path.dirname(os.path.abspath(path))
    cfg["_base_dir"] = base

    if not isinstance(cfg.get("sources"), list) or not cfg["sources"]:
        raise ConfigError("配置缺少非空 sources 列表")
    cfg.setdefault("window", "1d")
    cfg.setdefault("db", os.path.join(base, "eventreplay.db"))

    seen = set()
    for i, src in enumerate(cfg["sources"]):
        where = f"sources[{i}]"
        name = src.get("name")
        if not name:
            raise ConfigError(f"{where} 缺少 name")
        if name in seen:
            raise ConfigError(f"来源名称重复: {name}")
        seen.add(name)
        if not src.get("path"):
            raise ConfigError(f"{where} 缺少 path")
        fmt = src.get("format")
        if fmt not in SUPPORTED_FORMATS:
            raise ConfigError(f"{where} format 必须是 {SUPPORTED_FORMATS} 之一")
        mapping = src.get("mapping") or {}
        for field in REQUIRED_FIELDS:
            if not mapping.get(field):
                raise ConfigError(f"{where} mapping 缺少必填字段 {field}")
        for field in OPTIONAL_FIELDS:
            mapping.setdefault(field, None)
        src["mapping"] = mapping
        src.setdefault("time_formats", ["iso"])
        if not isinstance(src["time_formats"], list) or not src["time_formats"]:
            raise ConfigError(f"{where} time_formats 必须是非空列表")
    return cfg
