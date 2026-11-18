"""主窗口的应用状态: 严格区分"当前这一对"与历史结果。

关键约束: 任何新一轮加载/生成/核对开始前先 reset,
失败时旧代理与旧结论不会残留在界面上冒充成功。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from PySide6.QtCore import QByteArray
from PySide6.QtGui import QImage

from ..ffmedia import MediaInfo
from ..player import PlayerModel
from ..verification import VerificationReport


@dataclass
class LoadedMedia:
    info: MediaInfo
    frames: list[QByteArray]          # JPEG 字节, 序号即帧号
    audio_file: str | None            # 抽出的临时音频路径
    raw_images: list[QImage] = field(default_factory=list)


@dataclass
class AppState:
    source: LoadedMedia | None = None
    proxy: LoadedMedia | None = None
    player: PlayerModel | None = None
    report: VerificationReport | None = None
    # 界面模式: single(切换查看) / side(并排)
    view_mode: str = "side"
    show_source_in_single: bool = True
    worker_active: bool = False

    def reset_pair(self) -> None:
        """换一对文件或新一轮失败时调用, 清空全部派生状态。"""
        self.source = None
        self.proxy = None
        self.player = None
        self.report = None
        self.view_mode = "side"
        self.show_source_in_single = True

    def reset_proxy_side(self) -> None:
        """代理生成失败: 只清代理, 原片保留, 但旧结论必须作废。"""
        self.proxy = None
        self.report = None
        if self.player is not None:
            self.player.pause()
        self.player = None

    @property
    def ready(self) -> bool:
        return self.source is not None and self.proxy is not None

    def pair_key(self) -> tuple[str, str]:
        """当前打开的一对文件的唯一键(绝对路径+sha256)。"""
        if not self.ready:
            return ("", "")
        return (
            f"{self.source.info.path}|{self.source.info.sha256}",
            f"{self.proxy.info.path}|{self.proxy.info.sha256}",
        )

    def source_name(self) -> str:
        return Path(self.source.info.path).name if self.source else "-"

    def proxy_name(self) -> str:
        return Path(self.proxy.info.path).name if self.proxy else "-"
