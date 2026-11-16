"""工作台核心数据模型 (全部为可 JSON 序列化的 dataclass)。

工程文件 = 这些对象的字典形式 + 格式魔数/版本号, 见 project.py。
所有时间戳统一使用 UTC ISO-8601 字符串。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any

from .safety import FORMAT_NAME, FORMAT_VERSION


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# 支持的文件大类
FILE_KINDS = (
    "request",      # HTTP 请求
    "response",     # HTTP 响应
    "log",          # 日志
    "config",       # 配置片段
    "note",         # 说明文档
    "other",        # 其他/未知
)

# 解析状态
PARSE_OK = "ok"
PARSE_FALLBACK = "fallback"   # 解码或结构解析失败, 已退化为原始文本
PARSE_BINARY = "binary"       # 二进制文件, 未保存正文
PARSE_TRUNCATED = "truncated"  # 超过体量限制, 内容被截断


@dataclass
class ParseResult:
    """单个文件的结构化解析结果。"""
    status: str = PARSE_OK
    parser: str = "text"                    # http/json/log/config/markdown/text/binary
    language: str = "text"                  # 供前端高亮: http/json/log/ini/yaml/markdown/text
    fields: dict[str, Any] = field(default_factory=dict)  # 结构化字段 (method/url/headers/...)
    error: str | None = None                # 解析失败原因 (退化时填写)
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ParseResult":
        return cls(
            status=d.get("status", PARSE_FALLBACK),
            parser=d.get("parser", "text"),
            language=d.get("language", "text"),
            fields=dict(d.get("fields") or {}),
            error=d.get("error"),
            truncated=bool(d.get("truncated", False)),
        )


@dataclass
class EvidenceFile:
    """一份证据文件 (请求/响应/日志/配置/说明/其他)。"""
    id: str
    package_id: str
    rel_path: str                       # 包内相对路径
    source_path: str                    # 导入时的来源绝对路径 (或 zip 路径)
    kind: str
    size_bytes: int
    sha256: str
    md5: str
    parse: ParseResult
    text: str | None = None             # 文本正文 (二进制为 None)
    text_truncated: bool = False
    duplicate_of: str | None = None     # 与哪个文件 sha256 完全相同
    duplicate_reason: str | None = None  # 例如 "sha256 与 f_xxx 完全一致"
    imported_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["parse"] = self.parse.to_dict()
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "EvidenceFile":
        return cls(
            id=d["id"],
            package_id=d["package_id"],
            rel_path=d["rel_path"],
            source_path=d.get("source_path", ""),
            kind=d.get("kind", "other"),
            size_bytes=int(d.get("size_bytes", 0)),
            sha256=d.get("sha256", ""),
            md5=d.get("md5", ""),
            parse=ParseResult.from_dict(d.get("parse") or {}),
            text=d.get("text"),
            text_truncated=bool(d.get("text_truncated", False)),
            duplicate_of=d.get("duplicate_of"),
            duplicate_reason=d.get("duplicate_reason"),
            imported_at=d.get("imported_at", utc_now()),
        )


@dataclass
class Package:
    """一个导入的复现包 (目录或 zip)。"""
    id: str
    name: str
    source_path: str
    source_type: str                    # directory / zip
    imported_at: str = field(default_factory=utc_now)
    import_error: str | None = None     # 整包读取失败时的原因
    file_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Package":
        return cls(
            id=d["id"],
            name=d["name"],
            source_path=d.get("source_path", ""),
            source_type=d.get("source_type", "directory"),
            imported_at=d.get("imported_at", utc_now()),
            import_error=d.get("import_error"),
            file_ids=list(d.get("file_ids") or []),
        )


@dataclass
class CorrelationGroup:
    """同一个实体 (时间/地址/编号) 在多份证据中的关联组。"""
    id: str
    entity_type: str                    # ip / url / timestamp / id
    value: str
    file_ids: list[str] = field(default_factory=list)
    occurrences: dict[str, int] = field(default_factory=dict)  # file_id -> 出现次数

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CorrelationGroup":
        return cls(
            id=d["id"],
            entity_type=d["entity_type"],
            value=d["value"],
            file_ids=list(d.get("file_ids") or []),
            occurrences=dict(d.get("occurrences") or {}),
        )


@dataclass
class ConclusionHistoryEntry:
    """结论的一次变更历史。"""
    changed_at: str
    old_value: str
    new_value: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ConclusionHistoryEntry":
        return cls(
            changed_at=d.get("changed_at", utc_now()),
            old_value=d.get("old_value", ""),
            new_value=d.get("new_value", ""),
        )


@dataclass
class Annotation:
    """人工复现标注。"""
    id: str
    title: str = ""
    steps: str = ""                     # 复现步骤
    expected: str = ""                  # 预期现象
    actual: str = ""                    # 实际现象
    conclusion: str = ""                # 结论
    linked_file_ids: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    conclusion_history: list[ConclusionHistoryEntry] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["conclusion_history"] = [h.to_dict() for h in self.conclusion_history]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Annotation":
        return cls(
            id=d["id"],
            title=d.get("title", ""),
            steps=d.get("steps", ""),
            expected=d.get("expected", ""),
            actual=d.get("actual", ""),
            conclusion=d.get("conclusion", ""),
            linked_file_ids=list(d.get("linked_file_ids") or []),
            created_at=d.get("created_at", utc_now()),
            updated_at=d.get("updated_at", utc_now()),
            conclusion_history=[
                ConclusionHistoryEntry.from_dict(h)
                for h in d.get("conclusion_history") or []
            ],
        )


@dataclass
class MaskRule:
    """单条脱敏规则。"""
    id: str
    name: str
    pattern: str                        # 正则字符串 (re 风格)
    enabled: bool = True
    builtin: bool = False
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MaskRule":
        return cls(
            id=d["id"],
            name=d.get("name", ""),
            pattern=d.get("pattern", ""),
            enabled=bool(d.get("enabled", True)),
            builtin=bool(d.get("builtin", False)),
            description=d.get("description", ""),
        )


@dataclass
class MaskSettings:
    """脱敏配置。"""
    rules: list[MaskRule] = field(default_factory=list)
    hide_by_default: bool = True        # 界面默认隐藏命中内容
    reveal_audit: list[dict[str, Any]] = field(default_factory=list)  # 原文查看审计

    def to_dict(self) -> dict[str, Any]:
        return {
            "rules": [r.to_dict() for r in self.rules],
            "hide_by_default": self.hide_by_default,
            "reveal_audit": list(self.reveal_audit),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> "MaskSettings":
        d = d or {}
        return cls(
            rules=[MaskRule.from_dict(r) for r in d.get("rules") or []],
            hide_by_default=bool(d.get("hide_by_default", True)),
            reveal_audit=list(d.get("reveal_audit") or []),
        )


@dataclass
class OpRecord:
    """操作记录 (工程内审计日志)。"""
    id: str
    time: str
    action: str
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "OpRecord":
        return cls(
            id=d["id"],
            time=d.get("time", utc_now()),
            action=d.get("action", ""),
            detail=d.get("detail", ""),
        )


@dataclass
class Project:
    """一个完整的证据工作台工程。"""
    format: str = FORMAT_NAME
    version: int = FORMAT_VERSION
    id: str = field(default_factory=lambda: new_id("proj"))
    name: str = "未命名工程"
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    packages: list[Package] = field(default_factory=list)
    files: list[EvidenceFile] = field(default_factory=list)
    correlations: list[CorrelationGroup] = field(default_factory=list)
    annotations: list[Annotation] = field(default_factory=list)
    mask_settings: MaskSettings = field(default_factory=MaskSettings)
    operations: list[OpRecord] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "version": self.version,
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "packages": [p.to_dict() for p in self.packages],
            "files": [f.to_dict() for f in self.files],
            "correlations": [c.to_dict() for c in self.correlations],
            "annotations": [a.to_dict() for a in self.annotations],
            "mask_settings": self.mask_settings.to_dict(),
            "operations": [o.to_dict() for o in self.operations],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Project":
        if not isinstance(d, dict):
            raise ValueError("工程文件内容不是 JSON 对象")
        if d.get("format") != FORMAT_NAME:
            raise ValueError(f"格式魔数不匹配: {d.get('format')!r}")
        if not isinstance(d.get("version"), int) or d["version"] > FORMAT_VERSION:
            raise ValueError(f"工程版本不受支持: {d.get('version')!r}")
        return cls(
            format=d["format"],
            version=int(d["version"]),
            id=d.get("id", new_id("proj")),
            name=d.get("name", "未命名工程"),
            created_at=d.get("created_at", utc_now()),
            updated_at=d.get("updated_at", utc_now()),
            packages=[Package.from_dict(p) for p in d.get("packages") or []],
            files=[EvidenceFile.from_dict(f) for f in d.get("files") or []],
            correlations=[CorrelationGroup.from_dict(c)
                          for c in d.get("correlations") or []],
            annotations=[Annotation.from_dict(a)
                         for a in d.get("annotations") or []],
            mask_settings=MaskSettings.from_dict(d.get("mask_settings")),
            operations=[OpRecord.from_dict(o) for o in d.get("operations") or []],
        )

    # ---- 便捷查询 ----
    def get_file(self, file_id: str) -> EvidenceFile | None:
        return next((f for f in self.files if f.id == file_id), None)

    def get_package(self, package_id: str) -> Package | None:
        return next((p for p in self.packages if p.id == package_id), None)

    def get_annotation(self, annotation_id: str) -> Annotation | None:
        return next((a for a in self.annotations if a.id == annotation_id), None)

    def log_op(self, action: str, detail: str = "") -> None:
        self.operations.append(
            OpRecord(id=new_id("op"), time=utc_now(), action=action, detail=detail)
        )
        self.updated_at = utc_now()
