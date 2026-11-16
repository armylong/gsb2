"""配置加载与来源表/字段映射。

配置为 JSON, 示例见 examples/config.example.json, 结构::

    {
      "snapshot_dir": "snapshot",
      "changes_dir": "changes",
      "target_db": "target/target.db",
      "tables": {
        "customer": {
          "target_table": "customer",
          "key": ["id"],
          "columns": {"id": {"target": "id", "type": "INTEGER"}, ...}
        },
        "order": { ... }
      }
    }

所有相对路径都相对配置文件所在目录解析。
"""

import json
import os

from .errors import ConfigError

_ALLOWED_TYPES = {"TEXT", "INTEGER", "REAL", "BLOB"}
_REQUIRED_TOP = ("snapshot_dir", "changes_dir", "target_db", "tables")


class TableMapping:
    def __init__(self, source_name, raw):
        self.source_name = source_name
        self.target_table = raw.get("target_table", source_name)
        key = raw.get("key")
        if not isinstance(key, list) or not key or not all(isinstance(k, str) for k in key):
            raise ConfigError(f"表 {source_name} 的 key 必须是非空字符串数组")
        self.key = list(key)
        columns = raw.get("columns")
        if not isinstance(columns, dict) or not columns:
            raise ConfigError(f"表 {source_name} 的 columns 必须是非空对象")
        # source_col -> (target_col, declared_type)
        self.columns = {}
        for src_col, spec in columns.items():
            spec = spec or {}
            target_col = spec.get("target", src_col)
            col_type = str(spec.get("type", "TEXT")).upper()
            if col_type not in _ALLOWED_TYPES:
                raise ConfigError(
                    f"表 {source_name}.{src_col} 的类型 {col_type} 不支持, "
                    f"可选: {sorted(_ALLOWED_TYPES)}"
                )
            self.columns[src_col] = (target_col, col_type)
        missing = [k for k in self.key if k not in self.columns]
        if missing:
            raise ConfigError(f"表 {source_name} 的主键列 {missing} 未出现在 columns 中")

    @property
    def target_key(self):
        return [self.columns[k][0] for k in self.key]

    def target_column(self, source_col):
        return self.columns[source_col][0]

    def column_type(self, source_col):
        return self.columns[source_col][1]


class Config:
    def __init__(self, raw, base_dir):
        for field in _REQUIRED_TOP:
            if field not in raw:
                raise ConfigError(f"配置缺少必填字段: {field}")
        self.base_dir = base_dir
        self.snapshot_dir = _resolve(base_dir, raw["snapshot_dir"])
        self.changes_dir = _resolve(base_dir, raw["changes_dir"])
        self.target_db = _resolve(base_dir, raw["target_db"])
        tables = raw["tables"]
        if not isinstance(tables, dict) or not tables:
            raise ConfigError("tables 必须是非空对象")
        self.mappings = {}
        for name, spec in tables.items():
            if not isinstance(spec, dict):
                raise ConfigError(f"表 {name} 的配置必须是对象")
            self.mappings[name] = TableMapping(name, spec)
        # 目标表名不允许重复
        names = [m.target_table for m in self.mappings.values()]
        if len(set(names)) != len(names):
            raise ConfigError("多个来源表映射到了同一个目标表名")

    def mapping_for(self, source_table):
        return self.mappings.get(source_table)

    @classmethod
    def load(cls, path):
        path = os.path.abspath(path)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
        except FileNotFoundError:
            raise ConfigError(f"配置文件不存在: {path}")
        except json.JSONDecodeError as exc:
            raise ConfigError(f"配置文件不是合法 JSON: {exc}") from exc
        if not isinstance(raw, dict):
            raise ConfigError("配置顶层必须是 JSON 对象")
        return cls(raw, os.path.dirname(path))


def _resolve(base_dir, value):
    if not isinstance(value, str) or not value:
        raise ConfigError(f"路径配置必须是非空字符串: {value!r}")
    if os.path.isabs(value):
        return os.path.abspath(value)
    return os.path.abspath(os.path.join(base_dir, value))
