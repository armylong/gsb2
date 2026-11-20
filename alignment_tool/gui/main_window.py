"""平移对齐工具主窗口。

布局
----
左侧控制面板：合成参数 / 导入 / 估计与人工修正 / 残差与可信度 / 导出
右侧显示区  ：参考图 | 移动图 | 对齐/残差/叠加 三视图 + 相位相关面
"""

from __future__ import annotations

import cv2
import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ..estimator import EstimateResult, cross_phase_surface, estimate_shift
from ..geometry import FILL_VALUE, residual_stats, warp_align
from ..io_utils import export_bundle, load_gray
from ..synthetic import TEXTURE_TYPES, make_pair
from .image_view import ImageView, to_qpixmap


def _spin(minv: float, maxv: float, value: float, step: float, decimals: int = 3):
    s = QDoubleSpinBox()
    s.setRange(minv, maxv)
    s.setValue(value)
    s.setSingleStep(step)
    s.setDecimals(decimals)
    return s


class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("亚像素平移对齐工具  (Phase Correlation + ECC)")
        self.resize(1280, 860)

        self.ref: np.ndarray | None = None
        self.moving: np.ndarray | None = None
        self.true_dx = self.true_dy = 0.0
        self.est: EstimateResult | None = None
        self._last_dir = "."

        self._build_ui()
        self.on_generate()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        root.addWidget(splitter)
        splitter.addWidget(self._build_controls())
        splitter.addWidget(self._build_views())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([360, 920])

    def _build_controls(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)

        # ---- 1. 合成配对图
        g_gen = QGroupBox("1. 生成 / 导入配对图")
        form = QFormLayout(g_gen)
        self.cmb_kind = QComboBox()
        self.cmb_kind.addItems(TEXTURE_TYPES)
        self.cmb_kind.setCurrentText("blobs")
        self.sp_w = QSpinBox(); self.sp_w.setRange(64, 2048); self.sp_w.setValue(320)
        self.sp_h = QSpinBox(); self.sp_h.setRange(64, 2048); self.sp_h.setValue(256)
        self.sp_dx = _spin(-20, 20, 0.7, 0.1)
        self.sp_dy = _spin(-20, 20, -0.4, 0.1)
        self.sp_bright = _spin(-80, 80, 10.0, 1.0)
        self.sp_contrast = _spin(0.5, 2.0, 1.0, 0.05, 2)
        self.sp_noise = _spin(0, 50, 3.0, 0.5)
        self.sp_seed = QSpinBox(); self.sp_seed.setRange(0, 10_0000); self.sp_seed.setValue(0)
        form.addRow("纹理类型", self.cmb_kind)
        form.addRow("宽 / 高", self._row(self.sp_w, self.sp_h))
        form.addRow("真值 dx (右+)", self.sp_dx)
        form.addRow("真值 dy (下+)", self.sp_dy)
        form.addRow("亮度增量", self.sp_bright)
        form.addRow("对比度", self.sp_contrast)
        form.addRow("噪声 σ", self.sp_noise)
        form.addRow("随机种子", self.sp_seed)
        btn_gen = QPushButton("生成配对图")
        btn_gen.clicked.connect(self.on_generate)
        form.addRow(btn_gen)

        btn_import_ref = QPushButton("导入参考图…")
        btn_import_mov = QPushButton("导入移动图…")
        btn_import_ref.clicked.connect(lambda: self.on_import("ref"))
        btn_import_mov.clicked.connect(lambda: self.on_import("moving"))
        form.addRow(self._row(btn_import_ref, btn_import_mov))
        self.lbl_size = QLabel("尺寸: -")
        self.lbl_size.setStyleSheet("color:#9aa0a6;")
        form.addRow(self.lbl_size)
        layout.addWidget(g_gen)

        # ---- 2. 估计与人工修正
        g_est = QGroupBox("2. 位移估计与人工修正")
        eform = QFormLayout(g_est)
        self.chk_hann = QCheckBox("汉宁窗（抑制频谱泄漏）"); self.chk_hann.setChecked(True)
        self.chk_ecc = QCheckBox("ECC 精修与交叉验证"); self.chk_ecc.setChecked(True)
        eform.addRow(self.chk_hann)
        eform.addRow(self.chk_ecc)
        btn_est = QPushButton("估计位移")
        btn_est.clicked.connect(self.on_estimate)
        eform.addRow(btn_est)

        self.sp_manual_dx = _spin(-30, 30, 0.0, 0.1)
        self.sp_manual_dy = _spin(-30, 30, 0.0, 0.1)
        eform.addRow("当前 dx (右+)", self.sp_manual_dx)
        eform.addRow("当前 dy (下+)", self.sp_manual_dy)
        for s in (self.sp_manual_dx, self.sp_manual_dy):
            s.valueChanged.connect(self.on_manual_change)

        btn_n1 = QPushButton("dx -0.1")
        btn_p1 = QPushButton("dx +0.1")
        btn_n2 = QPushButton("dy -0.1")
        btn_p2 = QPushButton("dy +0.1")
        for b, target, delta in (
            (btn_n1, "x", -0.1), (btn_p1, "x", 0.1),
            (btn_n2, "y", -0.1), (btn_p2, "y", 0.1),
        ):
            b.clicked.connect(lambda _=False, t=target, d=delta: self._nudge(t, d))
        eform.addRow(self._row(btn_n1, btn_p1))
        eform.addRow(self._row(btn_n2, btn_p2))

        self.lbl_move = QLabel("移动量: dx=+0.000  dy=+0.000 px")
        self.lbl_move.setStyleSheet("font-weight:bold; color:#8ab4f8;")
        eform.addRow(self.lbl_move)
        self.lbl_true = QLabel("真值: -（导入图无真值）")
        self.lbl_true.setStyleSheet("color:#9aa0a6;")
        eform.addRow(self.lbl_true)
        layout.addWidget(g_est)

        # ---- 3. 残差与可信度
        g_res = QGroupBox("3. 残差（仅实际重叠区）与可信度")
        rform = QFormLayout(g_res)
        self.lbl_valid = QLabel("-")
        self.lbl_mae = QLabel("-")
        self.lbl_rmse = QLabel("-")
        self.lbl_rmse2 = QLabel("-")
        self.lbl_mean = QLabel("-")
        for lbl in (self.lbl_valid, self.lbl_mae, self.lbl_rmse,
                    self.lbl_rmse2, self.lbl_mean):
            lbl.setStyleSheet("color:#e8eaed;")
        rform.addRow("有效/填充像素", self.lbl_valid)
        rform.addRow("MAE", self.lbl_mae)
        rform.addRow("RMSE", self.lbl_rmse)
        rform.addRow("亮度校正 RMSE", self.lbl_rmse2)
        rform.addRow("残差均值(亮暗)", self.lbl_mean)

        self.lbl_conf = QLabel("可信度: -")
        self.lbl_conf.setStyleSheet("font-weight:bold; font-size:14px;")
        rform.addRow(self.lbl_conf)
        self.txt_reasons = QTextEdit()
        self.txt_reasons.setReadOnly(True)
        self.txt_reasons.setFixedHeight(120)
        rform.addRow("判定依据 / 候选峰", self.txt_reasons)
        layout.addWidget(g_res)

        # ---- 4. 导出
        g_out = QGroupBox("4. 导出")
        oform = QFormLayout(g_out)
        self.edt_out = QLineEdit("tmp/gui_out")
        oform.addRow("输出目录", self.edt_out)
        btn_export = QPushButton("导出对齐图/掩码/残差/叠加")
        btn_export.clicked.connect(self.on_export)
        oform.addRow(btn_export)
        layout.addWidget(g_out)
        layout.addStretch(1)
        return panel

    def _build_views(self) -> QWidget:
        box = QWidget()
        grid = QGridLayout(box)
        self.view_ref = ImageView("参考图 ref")
        self.view_mov = ImageView("移动图 moving（含边缘填充）")
        self.view_align = ImageView("对齐图 aligned（填充区已标出）")
        self.view_res = ImageView("残差图（仅重叠区统计）")
        self.view_overlay = ImageView("红绿叠加（对齐良好时呈黄/灰）")
        self.view_phase = ImageView("相位相关面（亮斑=候选峰）")
        positions = [
            (0, 0, self.view_ref), (0, 1, self.view_mov),
            (1, 0, self.view_align), (1, 1, self.view_res),
            (2, 0, self.view_overlay), (2, 1, self.view_phase),
        ]
        for r, c, v in positions:
            grid.addWidget(v, r, c)
        for r in range(3):
            grid.setRowStretch(r, 1)
        for c in range(2):
            grid.setColumnStretch(c, 1)
        return box

    @staticmethod
    def _row(a, b) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(a)
        lay.addWidget(b)
        return w

    # ------------------------------------------------------------ 业务逻辑
    def on_generate(self) -> None:
        pair = make_pair(
            size=(self.sp_w.value(), self.sp_h.value()),
            kind=self.cmb_kind.currentText(),
            seed=self.sp_seed.value(),
            dx=self.sp_dx.value(),
            dy=self.sp_dy.value(),
            brightness=self.sp_bright.value(),
            contrast=self.sp_contrast.value(),
            noise_sigma=self.sp_noise.value(),
        )
        self.ref, self.moving = pair.ref, pair.moving
        self.true_dx, self.true_dy = pair.dx, pair.dy
        self.est = None
        self.lbl_true.setText(f"真值: dx={pair.dx:+.3f}  dy={pair.dy:+.3f} px")
        self.lbl_size.setText(f"尺寸: {self.ref.shape[1]}×{self.ref.shape[0]}  "
                              f"填充值={FILL_VALUE}")
        self.sp_manual_dx.setValue(pair.dx)
        self.sp_manual_dy.setValue(pair.dy)
        self._refresh_views()
        self.on_estimate()

    def on_import(self, which: str) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择灰度图像", self._last_dir,
            "图像 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)",
        )
        if not path:
            return
        self._last_dir = path
        try:
            img = load_gray(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导入失败", str(exc))
            return
        if which == "ref":
            self.ref = img
        else:
            self.moving = img
        if self.ref is not None and self.moving is not None and self.ref.shape != self.moving.shape:
            QMessageBox.warning(
                self, "尺寸不一致",
                f"参考图 {self.ref.shape[::-1]} 与移动图 {self.moving.shape[::-1]} 尺寸不同，\n"
                "本工具仅支持同尺寸配对，请重新导入。",
            )
            if which == "ref":
                self.ref = None
            else:
                self.moving = None
            return
        self.true_dx = self.true_dy = 0.0
        self.lbl_true.setText("真值: -（导入图无真值）")
        if self.ref is not None:
            self.lbl_size.setText(f"尺寸: {self.ref.shape[1]}×{self.ref.shape[0]}  "
                                  f"填充值={FILL_VALUE}")
        if self.ref is not None and self.moving is not None:
            self.sp_manual_dx.setValue(0.0)
            self.sp_manual_dy.setValue(0.0)
            self._refresh_views()
            self.on_estimate()

    def on_estimate(self) -> None:
        if self.ref is None or self.moving is None:
            return
        self.est = estimate_shift(
            self.ref, self.moving,
            use_hann=self.chk_hann.isChecked(),
            use_ecc=self.chk_ecc.isChecked(),
        )
        # 程序化控件信号 -> 人工修正流程统一走 on_manual_change
        self.sp_manual_dx.blockSignals(True)
        self.sp_manual_dy.blockSignals(True)
        self.sp_manual_dx.setValue(self.est.dx)
        self.sp_manual_dy.setValue(self.est.dy)
        self.sp_manual_dx.blockSignals(False)
        self.sp_manual_dy.blockSignals(False)
        self._refresh_views()

    def _nudge(self, target: str, delta: float) -> None:
        spin = self.sp_manual_dx if target == "x" else self.sp_manual_dy
        spin.setValue(spin.value() + delta)

    def on_manual_change(self) -> None:
        if self.ref is None or self.moving is None:
            return
        self._refresh_views()

    def _current_shift(self) -> tuple[float, float]:
        return self.sp_manual_dx.value(), self.sp_manual_dy.value()

    def _refresh_views(self) -> None:
        if self.ref is None or self.moving is None:
            return
        dx, dy = self._current_shift()
        self.lbl_move.setText(f"移动量: dx={dx:+.3f}  dy={dy:+.3f} px")

        aligned = warp_align(self.moving, dx, dy)
        stats = residual_stats(self.ref, aligned, dx, dy)

        # 对齐图：填充区用红色描出
        align_color = np.stack([aligned] * 3, axis=-1)
        align_color[stats.fill_mask] = (0, 0, 255)  # BGR 红

        # 残差彩色图
        abs_d = np.abs(stats.residual)
        norm = np.zeros_like(self.ref)
        if abs_d.max() > 0:
            norm = np.clip(abs_d / abs_d.max() * 255, 0, 255).astype(np.uint8)
        res_color = cv2.applyColorMap(norm, cv2.COLORMAP_JET)
        res_color[stats.fill_mask] = 0

        # 红绿叠加
        overlay = np.zeros((self.ref.shape[0], self.ref.shape[1], 3), np.uint8)
        overlay[..., 2] = self.ref
        overlay[..., 1] = aligned
        overlay[stats.fill_mask] = (0, 0, 255)

        # 相位相关面
        surface = cross_phase_surface(self.ref, self.moving, self.chk_hann.isChecked())
        shifted = np.fft.fftshift(surface)
        vis = np.clip((shifted - shifted.min()) /
                      max(shifted.max() - shifted.min(), 1e-12) * 255, 0, 255).astype(np.uint8)
        vis = cv2.applyColorMap(vis, cv2.COLORMAP_HOT)

        self.view_ref.set_image(self.ref)
        self.view_mov.set_image(self.moving)
        self.view_align.set_image(align_color)
        self.view_res.set_image(res_color)
        self.view_overlay.set_image(overlay)
        self.view_phase.set_image(vis)

        # 残差数字
        self.lbl_valid.setText(f"{stats.n_valid} / {stats.n_filled}（填充，不统计）")
        self.lbl_mae.setText(f"{stats.mae:.3f}")
        self.lbl_rmse.setText(f"{stats.rmse:.3f}")
        self.lbl_rmse2.setText(f"{stats.rmse_corrected:.3f}")
        self.lbl_mean.setText(f"{stats.mean_diff:+.3f}（正=移动图更亮）")

        if self.est is not None:
            color = {"high": "#34a853", "medium": "#fbbc04", "low": "#ea4335"}.get(
                self.est.level, "#9aa0a6")
            self.lbl_conf.setText(
                f"可信度: {self.est.confidence:.2f} / {self.est.level.upper()}  "
                f"({self.est.method})")
            self.lbl_conf.setStyleSheet(
                f"font-weight:bold; font-size:14px; color:{color};")
            lines = [f"纹理分={self.est.texture_score:.3f}  "
                     f"各向异性={self.est.anisotropy:.3f}  "
                     f"次峰/主峰={self.est.peak_ratio:.3f}  "
                     f"响应={self.est.response:.3f}"]
            if self.est.ecc_available:
                lines.append(f"ECC: dx={self.est.ecc_dx:+.3f} dy={self.est.ecc_dy:+.3f} "
                             f"cc={self.est.ecc_corr:.3f} 一致={self.est.ecc_agrees}")
            lines.append("候选峰:")
            for i, c in enumerate(self.est.candidates[:5]):
                lines.append(f"  #{i+1} dx={c.dx:+.3f} dy={c.dy:+.3f} peak={c.peak:.4f}")
            lines.append("判定:")
            lines.extend(f"  · {r}" for r in self.est.reasons)
            self.txt_reasons.setPlainText("\n".join(lines))

    def on_export(self) -> None:
        if self.ref is None or self.moving is None:
            QMessageBox.warning(self, "无法导出", "请先生成或导入配对图。")
            return
        dx, dy = self._current_shift()
        try:
            paths = export_bundle(self.edt_out.text().strip() or "tmp/gui_out",
                                  self.ref, self.moving, dx, dy)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        QMessageBox.information(
            self, "导出完成",
            "已导出到 " + self.edt_out.text() + "\n" +
            "\n".join(f"{k}: {v}" for k, v in paths.items()),
        )
