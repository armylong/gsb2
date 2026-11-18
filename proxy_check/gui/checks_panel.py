"""核对结果面板: 检查项状态表 + 检查点证据列表(可双击跳转双画面)。"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QBrush
from PySide6.QtWidgets import (
    QGroupBox, QHeaderView, QLabel, QListWidget,
    QListWidgetItem, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from ..verification import Status, VerificationReport

_STATUS_COLOR = {
    Status.PASS: QColor("#0a7d23"),
    Status.WARN: QColor("#b06a00"),
    Status.FAIL: QColor("#c62828"),
    Status.INFO: QColor("#555555"),
    Status.PENDING: QColor("#8a6d00"),
}


class ChecksPanel(QWidget):
    jumpToFrame = Signal(int)

    def __init__(self):
        super().__init__()
        root = QVBoxLayout(self)

        self.overall = QLabel("尚未核对")
        font = self.overall.font()
        font.setBold(True)
        font.setPointSize(13)
        self.overall.setFont(font)
        root.addWidget(self.overall)

        info_box = QGroupBox("两份文件实际媒体信息")
        info_lay = QVBoxLayout(info_box)
        self.media_label = QLabel("—")
        self.media_label.setStyleSheet("font-family: monospace;")
        self.media_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse)
        info_lay.addWidget(self.media_label)
        root.addWidget(info_box)

        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["结果", "检查项", "说明 / 依据"])
        self.table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(0, 70)
        self.table.setColumnWidth(1, 200)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        root.addWidget(self.table, stretch=2)

        cp_box = QGroupBox("画面检查点证据(双击跳到该帧双画面对照)")
        cp_lay = QVBoxLayout(cp_box)
        self.cp_list = QListWidget()
        self.cp_list.itemDoubleClicked.connect(self._on_jump)
        cp_lay.addWidget(self.cp_list)
        root.addWidget(cp_box, stretch=1)

    def _on_jump(self, item: QListWidgetItem) -> None:
        frame = item.data(Qt.ItemDataRole.UserRole)
        if frame is not None:
            self.jumpToFrame.emit(int(frame))

    def show_report(self, report: VerificationReport) -> None:
        color = _STATUS_COLOR[report.overall]
        self.overall.setText(f"[{report.overall.value}] {report.conclusion}")
        self.overall.setStyleSheet(f"color: {color.name()};")

        s, p = report.source, report.proxy
        self.media_label.setText(
            f"原片  {s.resolution}  {s.frame_rate:g}fps  {s.nb_video_frames} 帧  "
            f"时长 {s.duration:.3f}s  音轨:{'有 ' + format(s.audio_duration, '.3f') + 's' if s.has_audio else '无'}\n"
            f"      sha256 {s.sha256[:16]}…  内容指纹 {s.content_digest[:16]}…\n"
            f"代理  {p.resolution}  {p.frame_rate:g}fps  {p.nb_video_frames} 帧  "
            f"时长 {p.duration:.3f}s  音轨:{'有 ' + format(p.audio_duration, '.3f') + 's' if p.has_audio else '无'}\n"
            f"      sha256 {p.sha256[:16]}…  内容指纹 {p.content_digest[:16]}…\n"
            f"      sidecar: {'存在' if report.has_sidecar else '缺失(待核对)'}"
        )

        self.table.setRowCount(len(report.checks))
        for row, c in enumerate(report.checks):
            st_item = QTableWidgetItem(c.status.value)
            st_item.setForeground(QBrush(_STATUS_COLOR[c.status]))
            f = st_item.font()
            f.setBold(True)
            st_item.setFont(f)
            self.table.setItem(row, 0, st_item)
            self.table.setItem(row, 1, QTableWidgetItem(c.name))
            self.table.setItem(row, 2, QTableWidgetItem(c.detail))
        self.table.resizeRowsToContents()

        self.cp_list.clear()
        for cp in report.checkpoints:
            item = QListWidgetItem(
                f"[{cp.status.value}] 源帧 {cp.source_index:4d} "
                f"(t={cp.source_time:6.3f}s) ↔ 代理帧 {cp.proxy_index:4d} "
                f"(t={cp.proxy_time:6.3f}s)  MAE={cp.mae:.4f}"
            )
            item.setForeground(_STATUS_COLOR[cp.status])
            item.setData(Qt.ItemDataRole.UserRole, cp.source_index)
            self.cp_list.addItem(item)

    def clear_report(self, text: str = "尚未核对") -> None:
        self.overall.setText(text)
        self.overall.setStyleSheet("")
        self.media_label.setText("—")
        self.table.setRowCount(0)
        self.cp_list.clear()
