"""代理核对工具的领域异常。"""


class ProxyCheckError(Exception):
    """所有可预期业务错误的基类, GUI 会直接展示 message。"""


class MediaProbeError(ProxyCheckError):
    """ffprobe 无法解析媒体或媒体不符合约束。"""


class FFmpegError(ProxyCheckError):
    """ffmpeg 转码/抽帧失败。"""


class ValidationError(ProxyCheckError):
    """导入素材不满足约束(时长/分辨率/CFR/容器)。"""
