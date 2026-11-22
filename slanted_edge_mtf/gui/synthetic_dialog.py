"""生成已知模糊斜边样例的参数对话框。"""

from __future__ import annotations

import numpy as np
from PySide6.QtWidgets import (QComboBox, QDialog, QDialogButtonBox,
                               QDoubleSpinBox, QFormLayout, QLabel)

from .. import synthetic


class SyntheticDialog(QDialog):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("生成合成斜边样例")
        form = QFormLayout(self)

        self.kind = QComboBox()
        self.kind.addItems([
            "标准模糊斜边(较陡 10°)",
            "标准模糊斜边(较平 35°)",
            "过锐振铃斜边",
            "双轮廓混叠",
            "低对比斜边",
            "边缘贴选区边界",
        ])
        self.kind.currentIndexChanged.connect(self._sync)
        form.addRow("样例类型", self.kind)

        self.sigma = QDoubleSpinBox()
        self.sigma.setRange(0.3, 8.0)
        self.sigma.setSingleStep(0.1)
        self.sigma.setValue(1.5)
        self.sigma.setSuffix(" px")
        form.addRow("高斯模糊 sigma", self.sigma)

        self.noise = QDoubleSpinBox()
        self.noise.setRange(0.0, 0.1)
        self.noise.setSingleStep(0.002)
        self.noise.setDecimals(4)
        self.noise.setValue(0.004)
        form.addRow("读出噪声 sigma", self.noise)

        self.info = QLabel()
        self.info.setWordWrap(True)
        self.info.setStyleSheet("color:#555;")
        form.addRow(self.info)

        btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        form.addRow(btns)
        self._sync()

    def _sync(self) -> None:
        k = self.kind.currentIndex()
        ring = k == 2
        s = self.sigma.value()
        theory = synthetic.gaussian_mtf50(s)
        txt = f"该 sigma 下理论 MTF50 ≈ {theory:.3f} 周期/像素"
        if ring:
            txt += "；含 unsharp-mask 过锐, 实测 MTF50 会被抬高并触发振铃提示"
        self.info.setText(txt)

    def build(self) -> tuple[np.ndarray, tuple | None, str]:
        """返回 (灰度图, 建议ROI或None, 描述)。"""
        k = self.kind.currentIndex()
        s, n = self.sigma.value(), self.noise.value()
        if k in (0, 1):
            ang = synthetic.STEEP_ANGLE if k == 0 else synthetic.SHALLOW_ANGLE
            img = synthetic.slanted_edge(angle_deg=ang, sigma_px=s,
                                         noise_sigma=n)
            return img, None, f"合成斜边 {ang:.0f}° sigma={s}"
        if k == 2:
            img = synthetic.slanted_edge(angle_deg=12, sigma_px=s,
                                         ringing=1.2, noise_sigma=n)
            return img, None, f"过锐振铃斜边 sigma={s} k=1.2"
        if k == 3:
            img = synthetic.double_edges(sigma_px=s, noise_sigma=n)
            return img, None, f"双轮廓斜边 sigma={s}"
        if k == 4:
            img = synthetic.slanted_edge(angle_deg=12, sigma_px=s,
                                         contrast=0.04, noise_sigma=max(n, 0.006))
            return img, None, f"低对比斜边 sigma={s} 对比=0.04"
        img, roi = synthetic.edge_near_border(sigma_px=s)
        return img, roi, f"贴边斜边 sigma={s}"
