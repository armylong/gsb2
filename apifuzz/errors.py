"""工具内部使用的异常类型。"""


class FuzzError(Exception):
    """基础异常。"""


class ConfigError(FuzzError):
    """配置文件不合法。"""


class ScopeViolation(FuzzError):
    """请求目标或跳转目标超出允许访问的本机范围。"""


class BudgetExhausted(FuzzError):
    """请求次数 / 并发 / 总耗时预算耗尽。"""


class CleanupFailure(FuzzError):
    """清理步骤失败，必须停止该接口的后续测试。"""


class SetupFailure(FuzzError):
    """环境准备步骤失败，相关用例无法判定。"""
