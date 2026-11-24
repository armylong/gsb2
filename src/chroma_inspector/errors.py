class MediaError(Exception):
    """媒体无法打开、格式不支持或探测失败时抛出。"""


class UnsupportedPixelFormat(MediaError):
    """像素格式不在本工具支持的八位平面格式白名单内。"""


class RawParamError(MediaError):
    """原始 .yuv 文件缺少宽高/格式参数且无法从文件名推断。"""
