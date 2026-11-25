from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .canvas import ImageCanvas


class VersionPanel(QWidget):
    lockRoiRequested = Signal(str)
    clearRoiRequested = Signal(str)
    exportImageRequested = Signal(str)
    exportListRequested = Signal(str)
    sourceOverlayToggled = Signal(str, bool)

    def __init__(self, version_key: str, parent=None) -> None:
        super().__init__(parent)
        self.key = version_key
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        header = QHBoxLayout()
        self.title = QLabel(f"版本 {version_key}")
        font = self.title.font()
        font.setBold(True)
        font.setPointSize(font.pointSize() + 1)
        self.title.setFont(font)
        header.addWidget(self.title)
        header.addStretch(1)
        self.source_check = QCheckBox("来源着色")
        self.source_check.toggled.connect(lambda checked: self.sourceOverlayToggled.emit(self.key, checked))
        header.addWidget(self.source_check)
        layout.addLayout(header)

        self.canvas = ImageCanvas(version_key)
        layout.addWidget(self.canvas, 1)

        self.info = QLabel("导入图片后自动计算。在图上拖框可查询该区域由哪些帧贡献。")
        self.info.setWordWrap(True)
        self.info.setStyleSheet("color: #c8d1d9; padding: 4px; background: #1c242c; border-radius: 4px;")
        self.info.setMinimumHeight(42)
        layout.addWidget(self.info)

        buttons = QHBoxLayout()
        self.lock_roi_button = QPushButton("锁住当前选区")
        self.lock_roi_button.clicked.connect(lambda: self.lockRoiRequested.emit(self.key))
        buttons.addWidget(self.lock_roi_button)

        self.clear_roi_button = QPushButton("清除选区")
        self.clear_roi_button.clicked.connect(lambda: self.clearRoiRequested.emit(self.key))
        buttons.addWidget(self.clear_roi_button)

        self.export_image_button = QPushButton("导出叠图")
        self.export_image_button.clicked.connect(lambda: self.exportImageRequested.emit(self.key))
        buttons.addWidget(self.export_image_button)

        self.export_list_button = QPushButton("导出参与帧")
        self.export_list_button.clicked.connect(lambda: self.exportListRequested.emit(self.key))
        buttons.addWidget(self.export_list_button)
        layout.addLayout(buttons)
