"""核心数据结构。"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional

from .verdict import VERDICTS, ANOMALY_VERDICTS


@dataclass
class Case:
    """一条模糊测试输入。

    rule:        生成规则标识（写入报告，便于追溯输入生成规则）
    path:        被修改的 JSON 路径，如 ``profile.geo``；整体异常用 ``$``
    raw_body:    为 True 时 body 是字符串（畸形 JSON 用），否则是可 JSON 序列化对象
    depends_on:  依赖前置步骤返回值时，路径模板中的占位符来源
    """

    case_id: str
    endpoint: str
    rule: str
    path: str
    body: Any
    raw_body: bool = False
    url_params: Dict[str, Any] = field(default_factory=dict)
    headers: Dict[str, str] = field(default_factory=dict)
    expectations: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Evidence:
    """一次 HTTP 请求 / 响应的完整证据。"""

    method: str
    url: str
    request_headers: Dict[str, str]
    request_body: Any
    status: Optional[int]
    response_headers: Dict[str, str]
    response_body: Any
    error: Optional[str]
    elapsed_ms: int
    redirected: bool = False
    redirect_chain: List[str] = field(default_factory=list)
    scope_blocked: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class CaseResult:
    """一条用例的执行结果。"""

    case: Case
    verdict: str
    evidence: Evidence
    fingerprint: Optional[str]
    precondition_ok: bool
    postcondition: Optional[Dict[str, Any]] = None
    note: Optional[str] = None
    reduction: Optional[Dict[str, Any]] = None

    def __post_init__(self) -> None:
        if self.verdict not in VERDICTS:
            raise ValueError(f"未知判定: {self.verdict}")

    def is_anomaly(self) -> bool:
        return self.verdict in ANOMALY_VERDICTS
