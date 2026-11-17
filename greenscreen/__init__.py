"""本地绿幕抠像合成预览工具。

只处理单个前景视频 + 一张静态背景图，不做智能人物分割或
复杂透明材质恢复。GUI 预览与视频导出共用 :mod:`greenscreen.keying`
中的同一套处理函数，保证导出画面与预览一致。
"""

__version__ = "1.0.0"


class GreenScreenError(Exception):
    """本项目所有自定义异常的基类，消息面向最终用户（中文）。"""


class MediaError(GreenScreenError):
    """素材无法打开、格式不支持或缺少画面。"""


class ProcessingError(GreenScreenError):
    """单帧处理失败。"""


class ExportError(GreenScreenError):
    """导出失败或导出后回读校验失败。"""
