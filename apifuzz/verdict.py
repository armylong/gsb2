"""判定（verdict）枚举与语义。

- REJECTED            服务按声明正常拒绝（4xx 且结构符合契约）
- OK                  正常接受（2xx 且结构符合契约）
- SERVER_ERROR        服务异常（5xx / 框架错误页）
- CONTRACT_VIOLATION  违反接口声明（状态码可接受但响应结构不符，或 4xx 结构不符）
- STATE_VIOLATION     数据被意外修改（后置条件不满足）
- TRANSPORT_ERROR     连接失败、超时等传输层问题
- SCOPE_BLOCKED       目标超出允许范围，客户端直接拦截（不计入失败分组）
- INDETERMINATE       无法判断（前置条件不满足等）
"""
from __future__ import annotations

VERDICTS = frozenset({
    "REJECTED",
    "OK",
    "SERVER_ERROR",
    "CONTRACT_VIOLATION",
    "STATE_VIOLATION",
    "TRANSPORT_ERROR",
    "SCOPE_BLOCKED",
    "INDETERMINATE",
})

ANOMALY_VERDICTS = frozenset({
    "SERVER_ERROR",
    "CONTRACT_VIOLATION",
    "STATE_VIOLATION",
    "TRANSPORT_ERROR",
    "INDETERMINATE",
})
