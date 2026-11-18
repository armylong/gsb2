"""播放视图: 单画面切换 / 并排, 显示两边真实帧号与 PTS。"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QSizePolicy, QVBoxLayout, QWidget,
)

from .state import AppState


class AspectCanvas(QLabel):
    """按 16:9 决定高度的画面画布, 避免 pane 拉伸后出现大块黑边。"""

    def hasHeightForWidth(self) -> bool:
        return True

    def heightForWidth(self, w: int) -> int:
        return int(w * 9 / 16)


class VideoPane(QFrame):
    """一路视频的画面 + 帧信息标签。"""

    def __init__(self, title: str):
        super().__init__()
        self.setFrameShape(QFrame.Shape.Box)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(6, 6, 6, 6)

        self.title = QLabel(title)
        self.title.setStyleSheet("font-weight: bold;")
        self.canvas = AspectCanvas()
        self.canvas.setMinimumSize(240, 135)
        self.canvas.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.canvas.setStyleSheet("background: black;")
        self.canvas.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self.info = QLabel("—")
        self.info.setStyleSheet("font-family: monospace;")
        self.warn_badge = QLabel("")
        self.warn_badge.setStyleSheet("color: #b00; font-weight: bold;")

        lay.addWidget(self.title)
        lay.addWidget(self.canvas)
        lay.addWidget(self.info)
        lay.addWidget(self.warn_badge)
        lay.addStretch(1)

    def show_blank(self, text: str = "未加载") -> None:
        self.canvas.clear()
        self.canvas.setStyleSheet("background: #222; color: #aaa;")
        self.canvas.setText(text)
        self.info.setText("—")
        self.warn_badge.setText("")

    def show_frame(self, jpeg_bytes, frame_no: int, pts: float,
                   fps: float, total: int) -> None:
        pix = QPixmap()
        pix.loadFromData(jpeg_bytes, "JPEG")
        # 随画布缩放但保持 16:9, 平滑缩放。
        target = self.canvas.size()
        if target.width() > 0 and target.height() > 0:
            pix = pix.scaled(
                target,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
        self.canvas.setPixmap(pix)
        self.canvas.setStyleSheet("background: black;")
        self.info.setText(
            f"帧 {frame_no:4d}/{total - 1}   PTS {pts:7.3f}s   "
            f"显示时间 {frame_no / fps:7.3f}s   {fps:g}fps"
        )

    def set_badge(self, text: str, color: str = "#b00") -> None:
        self.warn_badge.setText(text)
        self.warn_badge.setStyleSheet(f"color: {color}; font-weight: bold;")


class PlayerView(QWidget):
    checkpointRequested = Signal(int)  # 跳到某个原片帧号

    def __init__(self, state: AppState):
        super().__init__()
        self.state = state
        outer = QVBoxLayout(self)

        panes = QHBoxLayout()
        self.source_pane = VideoPane("原片")
        self.proxy_pane = VideoPane("360p 代理")
        panes.addWidget(self.source_pane, stretch=1)
        panes.addWidget(self.proxy_pane, stretch=1)
        outer.addLayout(panes, stretch=1)

        self.switch_hint = QLabel()
        self.switch_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        outer.addWidget(self.switch_hint)

    def render(self) -> None:
        st = self.state
        if not st.ready or st.player is None:
            self.source_pane.show_blank("原片未加载")
            self.proxy_pane.show_blank("代理未加载")
            self.switch_hint.setText("")
            return

        player = st.player
        src_ref = player.source_ref()
        dst_ref = player.proxy_ref()
        sm, pm = st.source, st.proxy

        self.source_pane.show_frame(
            sm.frames[src_ref.index], src_ref.index,
            player.source_pts(), sm.info.frame_rate, sm.info.nb_video_frames)
        self.proxy_pane.show_frame(
            pm.frames[dst_ref.index], dst_ref.index,
            player.proxy_pts(), pm.info.frame_rate, pm.info.nb_video_frames)

        err = player.frame_error()
        self.switch_hint.setText(
            f"当前源帧位置: {src_ref.index}   两边 PTS 差: {err*1000:.1f} ms"
            f"（≤ 一个源帧 {1000 / sm.info.frame_rate:.1f} ms）"
        )

        # 检查点命中高亮。
        self._update_checkpoint_badges(src_ref.index, dst_ref.index)

        # 单画面模式: 隐藏另一路, 但位置(帧号)不变。
        if st.view_mode == "single":
            show_src = st.show_source_in_single
            self.source_pane.setVisible(show_src)
            self.proxy_pane.setVisible(not show_src)
        else:
            self.source_pane.setVisible(True)
            self.proxy_pane.setVisible(True)

    def _update_checkpoint_badges(self, src_idx: int, dst_idx: int) -> None:
        report = self.state.report
        if report is None:
            self.source_pane.set_badge("")
            self.proxy_pane.set_badge("")
            return
        hit = next((cp for cp in report.checkpoints
                    if cp.source_index == src_idx), None)
        if hit is None:
            self.source_pane.set_badge("")
            self.proxy_pane.set_badge("")
            return
        color = {"PASS": "#0a7d23", "WARN": "#b06a00",
                 "FAIL": "#b00", "INFO": "#555",
                 "PENDING": "#555"}[hit.status.value]
        msg = f"检查点 MAE={hit.mae:.4f} [{hit.status.value}]"
        self.source_pane.set_badge(msg, color)
        self.proxy_pane.set_badge(msg, color)
