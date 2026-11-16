"""同步工具的异常类型。"""


class SyncError(Exception):
    """所有可预期同步错误的基类。"""


class ConfigError(SyncError):
    """配置文件本身不合法。"""


class BlockedError(SyncError):
    """同步被显式阻塞(序号缺口、内容冲突、修改不存在的记录等)。

    detail 是一个结构化字典, 至少包含 reason/message, 并尽量带上
    file/line/seq/txn_id 等具体定位信息。
    """

    def __init__(self, detail):
        self.detail = detail
        super().__init__(f"[{detail.get('reason')}] {detail.get('message')}")
