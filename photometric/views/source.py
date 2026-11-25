"""Tab 0 — pick a built-in scene, or load your own photographs."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QImage
from PySide6.QtWidgets import (QFileDialog, QHBoxLayout, QLabel, QListWidget,
                               QListWidgetItem, QPushButton, QVBoxLayout, QWidget)

from .. import synthesis, theme
from ..context import AppContext
from ..widgets.imageview import ImageView


def load_grayscale(path: str | Path) -> np.ndarray:
    """Read an image file as float grayscale in [0, 1]."""
    image = QImage(str(path))
    if image.isNull():
        raise OSError(f"无法读取图片：{path}")
    if image.width() != 0 and image.height() != 0:
        image = image.convertToFormat(QImage.Format.Format_Grayscale8)
        w, h = image.width(), image.height()
        ptr = image.constBits()
        arr = np.frombuffer(ptr, dtype=np.uint8, count=h * image.bytesPerLine())
        arr = arr.reshape(h, image.bytesPerLine())[:, :w].astype(np.float64)
    else:  # pragma: no cover - defensive
        raise OSError(f"图片尺寸为零：{path}")
    return arr / 255.0


class SourceView(QWidget):
    sceneRequested = Signal(str)
    filesLoaded = Signal(list)          # list of (name, image)
    solveRequested = Signal()

    def __init__(self, context: AppContext, parent=None):
        super().__init__(parent)
        self.ctx = context
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(10)

        header = QHBoxLayout()
        title = QLabel("图像与光照方向")
        title.setObjectName("Title")
        header.addWidget(title)
        header.addStretch(1)
        self.solve_btn = QPushButton("重新估计")
        self.solve_btn.setObjectName("Primary")
        self.solve_btn.clicked.connect(self.solveRequested.emit)
        header.addWidget(self.solve_btn)
        root.addLayout(header)

        body = QHBoxLayout()
        body.setSpacing(12)
        left = QVBoxLayout()
        left.setSpacing(8)
        left.addWidget(QLabel("内置合成场景"))
        self.scene_list = QListWidget()
        self.scene_list.setMaximumHeight(110)
        self.scene_list.setStyleSheet(
            f"QListWidget {{ background:{theme.PANEL}; border:1px solid {theme.BORDER}; "
            f"border-radius:6px; padding:4px; }} "
            f"QListWidget::item {{ padding:6px; border-radius:4px; }} "
            f"QListWidget::item:selected {{ background:{theme.ACCENT_DIM}; }}"
        )
        for key, label in synthesis.builtin_names():
            item = QListWidgetItem(label)
            item.setData(Qt.ItemDataRole.UserRole, key)
            self.scene_list.addItem(item)
        self.scene_list.itemClicked.connect(self._on_scene_clicked)
        left.addWidget(self.scene_list)

        load_row = QHBoxLayout()
        self.load_btn = QPushButton("载入自己的灰度图…")
        self.load_btn.clicked.connect(self._browse_files)
        load_row.addWidget(self.load_btn)
        load_row.addStretch(1)
        left.addLayout(load_row)

        self.description = QLabel("")
        self.description.setWordWrap(True)
        self.description.setObjectName("Muted")
        left.addWidget(self.description)

        self.info = QLabel("")
        self.info.setWordWrap(True)
        left.addWidget(self.info)

        left.addWidget(QLabel("全景预览"))
        self.preview = ImageView()
        self.preview.setMinimumSize(320, 300)
        self.preview.set_badge("图 1")
        left.addWidget(self.preview, 1)

        body.addLayout(left, 1)

        right = QVBoxLayout()
        right.setSpacing(8)
        title = QLabel("当前场景")
        title.setObjectName("Title")
        right.addWidget(title)
        self.scene_title = QLabel("—")
        self.scene_title.setStyleSheet("font-size:15px; font-weight:700;")
        right.addWidget(self.scene_title)
        self.scene_summary = QLabel("")
        self.scene_summary.setObjectName("Muted")
        self.scene_summary.setWordWrap(True)
        right.addWidget(self.scene_summary)
        right.addStretch(1)

        self.howto = QLabel(
            "使用方式\n\n"
            "1. 左侧选一个内置场景，或载入至少三张同视角、同尺寸的灰度照片。\n"
            "2. 在中间面板为每张图填写光方向（方位角、仰角），或直接拖动罗盘。\n"
            "3. 顶部面板会即时判定这组方向是否足以区分表面朝向。\n"
            "4. 按“重新估计”计算法线，其余标签页同步更新。\n\n"
            "约定：方位角从 +x 逆时针，仰角自像平面向上，90° 表示灯在镜头处。")
        self.howto.setWordWrap(True)
        self.howto.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
        right.addWidget(self.howto)
        right_host = QWidget()
        right_host.setLayout(right)
        right_host.setFixedWidth(290)
        body.addWidget(right_host)
        root.addLayout(body, 1)

        context.sceneChanged.connect(self.refresh)

    def _on_scene_clicked(self, item: QListWidgetItem) -> None:
        self.sceneRequested.emit(item.data(Qt.ItemDataRole.UserRole))

    def _browse_files(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择灰度图（至少三张）", str(Path.home()),
            "图片 (*.png *.jpg *.jpeg *.tif *.tiff *.bmp)")
        if not paths:
            return
        loaded = []
        for path in sorted(paths):
            try:
                gray = load_grayscale(path)
            except OSError:
                continue
            loaded.append((Path(path).stem, gray))
        if loaded:
            self.filesLoaded.emit(loaded)

    def refresh(self) -> None:
        scene = self.ctx.scene
        if scene is None:
            self.scene_title.setText("—")
            self.scene_summary.setText("")
            self.description.setText("")
            self.info.setText("")
            self.preview.set_image(None)
            return
        self.scene_title.setText(scene.title)
        self.scene_summary.setText(scene.summary())
        self.description.setText(scene.description)
        notes = "<br>".join(f"• {note}" for note in scene.notes)
        self.info.setText(
            f"<span style='color:{theme.MUTED}'>光照方向</span><br>"
            + "<br>".join(
                f"图 {i + 1}: 方位 {s.azimuth_deg:.0f}° · 仰角 {s.elevation_deg:.0f}°"
                for i, s in enumerate(scene.lights)
            )
            + (f"<br><br><span style='color:{theme.MUTED}'>场景说明</span><br>{notes}" if notes else "")
        )
        self.preview.set_gray(scene.images[0])
        self.preview.set_badge(f"图 1 / {scene.n_lights}")
