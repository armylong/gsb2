"""Sample gallery dialog: one-click load and restore of generated still lifes."""

from __future__ import annotations

import numpy as np
from PySide6 import QtCore, QtGui, QtWidgets

from matting.samples import SAMPLES, generate_sample, sample_thumbnail


class SampleCard(QtWidgets.QFrame):
    activated = QtCore.Signal(str)

    def __init__(self, key: str, parent=None):
        super().__init__(parent)
        self.key = key
        spec = SAMPLES[key]
        self.setObjectName("SampleCard")
        self.setFrameShape(QtWidgets.QFrame.StyledPanel)
        self.setCursor(QtCore.Qt.PointingHandCursor)
        self.setToolTip("点击加载该样例（框选、笔迹与选择题图会一并恢复）")

        sample = generate_sample(key)
        thumb = sample_thumbnail(sample, 230)
        rgb = np.ascontiguousarray(thumb[:, :, ::-1])
        h, w = rgb.shape[:2]
        qimg = QtGui.QImage(rgb.data, w, h, 3 * w, QtGui.QImage.Format_RGB888).copy()
        pix = QtGui.QPixmap.fromImage(qimg)

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(6)
        image_label = QtWidgets.QLabel()
        image_label.setPixmap(pix)
        image_label.setAlignment(QtCore.Qt.AlignCenter)
        layout.addWidget(image_label)

        title = QtWidgets.QLabel(spec.title)
        title.setStyleSheet("font-weight: 600; font-size: 14px;")
        layout.addWidget(title)

        desc = QtWidgets.QLabel(spec.description)
        desc.setWordWrap(True)
        desc.setStyleSheet("color: #555;")
        layout.addWidget(desc)

        meta = QtWidgets.QLabel(f"{spec.width}×{spec.height} · {len(spec.fg_lines)} 笔前景 · "
                                f"{len(spec.bg_lines)} 笔背景")
        meta.setStyleSheet("color: #888; font-size: 11px;")
        layout.addWidget(meta)

    def mousePressEvent(self, event: QtGui.QMouseEvent) -> None:
        if event.button() == QtCore.Qt.LeftButton:
            self.activated.emit(self.key)
        super().mousePressEvent(event)


class SampleGallery(QtWidgets.QDialog):
    sample_chosen = QtCore.Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("生成样例（内置，无需外部素材）")
        self.setMinimumWidth(760)
        layout = QtWidgets.QVBoxLayout(self)

        intro = QtWidgets.QLabel(
            "以下静物图由程序即时生成，并附带参考透明度：前背景颜色相近、带内部孔洞、"
            "细窄连接和柔和边缘。点击任一样例，会加载图片并恢复它自带的选框与笔迹。"
        )
        intro.setWordWrap(True)
        layout.addWidget(intro)

        row = QtWidgets.QHBoxLayout()
        row.setSpacing(14)
        for key in SAMPLES:
            card = SampleCard(key)
            card.activated.connect(self._choose)
            row.addWidget(card)
        layout.addLayout(row)

        buttons = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Close)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def _choose(self, key: str) -> None:
        self.sample_chosen.emit(key)
        self.accept()
