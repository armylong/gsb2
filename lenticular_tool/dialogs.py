"""本地校验窗口: 自检结果 + 图首/图中/图尾放大裁片。"""
from __future__ import annotations

from PySide6 import QtCore, QtGui, QtWidgets

from . import core
from .crops import render_spot_crop


class ValidationDialog(QtWidgets.QDialog):
    def __init__(self, bundle_provider, preset_loader, parent=None):
        """bundle_provider() 返回 dict:
        params, pitch, n, assign, layer, interlaced, height, width。
        preset_loader(key) 载入内置预设到主窗口。
        """
        super().__init__(parent)
        self._provider = bundle_provider
        self._load_preset = preset_loader
        self.setWindowTitle("本地校验 — 图首 / 图中 / 图尾")
        self.resize(1080, 760)

        root = QtWidgets.QVBoxLayout(self)

        top = QtWidgets.QHBoxLayout()
        top.addWidget(QtWidgets.QLabel("内置例子:"))
        for key, text in (("integer", "整数周期"),
                          ("half_pixel", "半像素偏移"),
                          ("fractional", "P=3.5 非整除"),
                          ("tilt", "小倾角串图")):
            b = QtWidgets.QPushButton(text)
            b.clicked.connect(lambda _=False, k=key: self._on_preset(k))
            top.addWidget(b)
        top.addStretch(1)
        self.crop_source = QtWidgets.QComboBox()
        self.crop_source.addItems(["来源彩色图层", "交错成品"])
        self.crop_source.currentIndexChanged.connect(self.refresh_spots)
        top.addWidget(self.crop_source)
        btn = QtWidgets.QPushButton("重新校验")
        btn.clicked.connect(self.refresh_all)
        top.addWidget(btn)
        root.addLayout(top)

        splitter = QtWidgets.QSplitter(QtCore.Qt.Orientation.Vertical)

        self.report = QtWidgets.QPlainTextEdit()
        self.report.setReadOnly(True)
        f = QtGui.QFont("Menlo")
        f.setStyleHint(QtGui.QFont.StyleHint.Monospace)
        f.setPointSize(11)
        self.report.setFont(f)
        self.report.setMinimumHeight(220)
        splitter.addWidget(self.report)

        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        self.spot_host = QtWidgets.QWidget()
        self.spot_layout = QtWidgets.QVBoxLayout(self.spot_host)
        self.spot_layout.setSpacing(10)
        scroll.setWidget(self.spot_host)
        splitter.addWidget(scroll)
        splitter.setSizes([260, 460])
        root.addWidget(splitter, 1)

        close = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.StandardButton.Close)
        close.rejected.connect(self.reject)
        close.accepted.connect(self.accept)
        close.button(QtWidgets.QDialogButtonBox.StandardButton.Close).clicked.connect(self.accept)
        root.addWidget(close)

        self.refresh_all()

    def _on_preset(self, key: str) -> None:
        self._load_preset(key)
        self.refresh_all()

    # ------------------------------------------------------------------
    def refresh_all(self) -> None:
        checks = core.run_self_checks()
        lines = ["== 数值自检 (python -m lenticular_tool.verify 可命令行复跑) =="]
        all_ok = True
        for c in checks:
            all_ok &= c.ok
            lines.append(f"[{'PASS' if c.ok else 'FAIL'}] {c.name}")
            if c.detail:
                lines.append(f"        {c.detail}")
        b = self._provider()
        p, pitch = b["params"], b["pitch"]
        h, w, n = b["height"], b["width"], b["n"]
        ep = core.edge_phases(h, w, pitch, p)
        lines.append("")
        lines.append("== 当前参数的相位 ==")
        lines.append(f"P(像素/镜条) = {pitch:.6f}   W = {w}   W/P = {w / pitch:.6f} 个周期")
        lines.append(f"左边缘相位={ep['left_edge']:.6f}  右边缘相位={ep['right_edge']:.6f}"
                     f"  总周期数={ep['total_periods']:.6f}")
        lines.append(f"首像素中心相位={ep['first_pixel_center']:.6f}  "
                     f"末像素中心相位={ep['last_pixel_center']:.6f}")
        if p.fit_right_edge:
            lines.append(f"右端相位锁定目标={p.right_edge_phase:.4f} (已微调周期)")
        lines.append("")
        lines.append("全部通过 ✅" if all_ok else "存在失败项 ❌")
        self.report.setPlainText("\n".join(lines))
        self.refresh_spots()

    # ------------------------------------------------------------------
    def refresh_spots(self) -> None:
        while self.spot_layout.count():
            item = self.spot_layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
        b = self._provider()
        p, pitch = b["params"], b["pitch"]
        h, wdt, n = b["height"], b["width"], b["n"]
        use_layer = self.crop_source.currentIndex() == 0
        arr = b["layer"] if use_layer else b["interlaced"]
        spots = core.spot_reports(h, wdt, n, p, pitch)
        for spot in spots:
            box = QtWidgets.QGroupBox()
            lay = QtWidgets.QVBoxLayout(box)
            counts = "  ".join(f"视角{i + 1}:{c}px" for i, c in enumerate(spot.counts))
            title = (f"{spot.title}  镜条#{spot.lens_index}  "
                     f"分界线 x={spot.boundary_left:.2f} .. {spot.boundary_right:.2f}  "
                     f"中心 x={spot.center_x:.1f}  片内首/末相位="
                     f"{spot.first_pixel_phase:.3f}/{spot.last_pixel_phase:.3f}  {counts}")
            lab_title = QtWidgets.QLabel(title)
            f = QtGui.QFont("Menlo")
            f.setPointSize(11)
            lab_title.setFont(f)
            lab_title.setWordWrap(True)
            lay.addWidget(lab_title)

            if spot.warnings:
                lab_warn = QtWidgets.QLabel("⚠ " + " ；".join(spot.warnings))
                lab_warn.setWordWrap(True)
                lab_warn.setStyleSheet("color:#b35400;")
                lay.addWidget(lab_warn)

            pix = render_spot_crop(arr, spot, p, pitch, n, scale=6)
            lab_img = QtWidgets.QLabel()
            lab_img.setPixmap(pix)
            lab_img.setAlignment(QtCore.Qt.AlignmentFlag.AlignLeft)
            lab_img.setMinimumHeight(pix.height() + 4)
            lay.addWidget(lab_img)
            self.spot_layout.addWidget(box)
        self.spot_layout.addStretch(1)
