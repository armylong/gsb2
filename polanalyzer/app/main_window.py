"""主窗口."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QSplitter, QVBoxLayout, QHBoxLayout, QFormLayout, QGroupBox,
    QPushButton, QTableWidget, QTableWidgetItem, QDoubleSpinBox, QHeaderView, QCheckBox,
    QTabWidget, QLabel, QSlider, QFileDialog, QMessageBox, QScrollArea, QSpinBox,
)

from ..physics import (
    FitResult, Thresholds, check_angles, render_direction, render_gray,
    render_quality, overlay_errors, ERROR_COLORS,
)
from ..io_utils import load_rgb, save_rgb, save_mask, export_fit_csv, export_probe_csv
from ..synthetic import generate_synthetic
from .widgets import ImageView, CurveCanvas
from .worker import FitWorker
from .synthetic_dialog import SyntheticDialog

DEFAULT_ANGLES = [0.0, 45.0, 90.0, 135.0]
TAB_NAMES = ["方向图", "变化幅度 R", "偏振度 ρ", "质量分类", "模拟预览"]


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("本地偏振照片分析")
        self.resize(1480, 940)

        # 每行: {"path": str|None, "image": np.ndarray|None, "angle": float}
        self._rows: list[dict] = []
        self._fit: FitResult | None = None
        self._worker: FitWorker | None = None
        self._probe: tuple[int, int] | None = None
        self._hover: tuple[int, int] | None = None
        self._fit_generation = 0
        self._refit_timer = QTimer(self)
        self._refit_timer.setSingleShot(True)
        self._refit_timer.timeout.connect(self.run_fit)

        self._build_ui()
        self._load_default_synthetic()
        # 事件循环启动后自动拟合一次, 打开窗口即看到合成图的分析结果
        QTimer.singleShot(0, self.run_fit)

    def _load_default_synthetic(self):
        """启动即载入默认合成图, 打开窗口就能验证分析方向."""
        from ..synthetic import SyntheticConfig
        stack = generate_synthetic(SyntheticConfig(), DEFAULT_ANGLES)
        self._rows = [
            {"path": None, "image": stack[i], "angle": DEFAULT_ANGLES[i]}
            for i in range(stack.shape[0])
        ]
        self._rebuild_table()

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        root = QSplitter(Qt.Orientation.Horizontal)

        # ---- 左栏 ----
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(8, 8, 8, 8)

        in_box = QGroupBox("1. 图像与角度 (同机位、同尺寸)")
        il = QVBoxLayout(in_box)
        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["#", "图像", "角度 °"])
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.table.verticalHeader().setVisible(False)
        il.addWidget(self.table)

        row_btns = QHBoxLayout()
        for text, slot in (
            ("添加图像…", self.add_images),
            ("删除选中", self.remove_rows),
            ("上移", lambda: self.move_row(-1)),
            ("下移", lambda: self.move_row(1)),
        ):
            b = QPushButton(text)
            b.clicked.connect(slot)
            row_btns.addWidget(b)
        il.addLayout(row_btns)

        synth = QPushButton("生成/重置内置合成图 (强亮斑 + 普通底色)")
        synth.clicked.connect(self.open_synthetic)
        il.addWidget(synth)

        self.problem_label = QLabel()
        self.problem_label.setWordWrap(True)
        self.problem_label.setStyleSheet("color: #b00020;")
        il.addWidget(self.problem_label)
        lv.addWidget(in_box)

        opt_box = QGroupBox("2. 分析选项")
        opt_form = QFormLayout(opt_box)
        self.cb_linear = QCheckBox("sRGB 线性化后再算亮度")
        self.cb_linear.setChecked(True)
        self.cb_linear.stateChanged.connect(self._schedule_refit)
        self.cb_exposure = QCheckBox("按帧中位数做曝光归一化")
        self.cb_exposure.setChecked(True)
        self.cb_exposure.stateChanged.connect(self._schedule_refit)
        opt_form.addRow(self.cb_linear)
        opt_form.addRow(self.cb_exposure)

        self.sp_dark = self._thr_spin(0.03, 0.0, 1.0, 0.01, 3)
        self.sp_sat = QSpinBox(); self.sp_sat.setRange(200, 255); self.sp_sat.setValue(250)
        self.sp_resid = self._thr_spin(0.10, 0.01, 2.0, 0.01, 2)
        self.sp_unphys = self._thr_spin(0.05, 0.0, 1.0, 0.01, 2)
        for sp in (self.sp_dark, self.sp_resid, self.sp_unphys):
            sp.valueChanged.connect(self._schedule_refit)
        self.sp_sat.valueChanged.connect(self._schedule_refit)
        opt_form.addRow("极暗阈值 (亮度)", self.sp_dark)
        opt_form.addRow("过曝阈值 (通道 ≥)", self.sp_sat)
        opt_form.addRow("残差/A 上限", self.sp_resid)
        opt_form.addRow("非物理容差 (R/A-1)", self.sp_unphys)
        lv.addWidget(opt_box)

        run_row = QHBoxLayout()
        self.btn_fit = QPushButton("运行分析")
        self.btn_fit.setStyleSheet("font-weight: bold;")
        self.btn_fit.clicked.connect(self.run_fit)
        run_row.addWidget(self.btn_fit)
        self.lbl_status = QLabel("就绪")
        run_row.addWidget(self.lbl_status, 1)
        lv.addLayout(run_row)

        exp_box = QGroupBox("3. 导出 (当前模拟角度 / 可信区域)")
        el = QVBoxLayout(exp_box)
        for text, slot in (
            ("导出模拟预览 PNG", self.export_preview),
            ("导出可信区域掩码 PNG", self.export_trust_mask),
            ("导出方向图 PNG", self.export_direction),
            ("导出拟合参数 CSV (可信像素)", self.export_csv),
            ("导出当前取点曲线 CSV", self.export_curve),
        ):
            b = QPushButton(text)
            b.clicked.connect(slot)
            el.addWidget(b)
        lv.addWidget(exp_box)
        lv.addStretch(1)

        # ---- 中栏: 图像选项卡 ----
        center = QWidget()
        cl = QVBoxLayout(center)
        cl.setContentsMargins(4, 8, 4, 4)
        self.tabs = QTabWidget()
        self.views: list[ImageView] = []
        for name in TAB_NAMES:
            v = ImageView()
            v.hovered.connect(self.on_hover)
            v.picked.connect(self.on_pick)
            self.views.append(v)
            self.tabs.addTab(v, name)
        cl.addWidget(self.tabs, 1)

        view_row = QHBoxLayout()
        btn_reset = QPushButton("重置缩放")
        btn_reset.clicked.connect(lambda: self.views[self.tabs.currentIndex()].reset_view())
        view_row.addWidget(btn_reset)
        view_row.addStretch(1)
        cl.addLayout(view_row)

        sim_row = QHBoxLayout()
        sim_row.addWidget(QLabel("模拟滤镜角度"))
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 180)
        self.slider.setValue(45)
        self.slider.valueChanged.connect(self.on_slider)
        sim_row.addWidget(self.slider, 1)
        self.sp_theta = QDoubleSpinBox()
        self.sp_theta.setRange(0.0, 180.0)
        self.sp_theta.setDecimals(1)
        self.sp_theta.setSingleStep(1.0)
        self.sp_theta.setValue(45.0)
        self.sp_theta.valueChanged.connect(self._on_spin_theta)
        sim_row.addWidget(self.sp_theta)
        cl.addLayout(sim_row)

        self.cb_overlay = QCheckBox("在模拟预览上叠加错误类别颜色")
        self.cb_overlay.setChecked(True)
        self.cb_overlay.stateChanged.connect(self._refresh_sim)
        cl.addWidget(self.cb_overlay)

        self.curve = CurveCanvas()
        cl.addWidget(self.curve, 0)

        # ---- 右栏: 读数与图例 ----
        right = QWidget()
        right.setMaximumWidth(300)
        rl = QVBoxLayout(right)
        readout = QGroupBox("像素读数 (悬停 / 点击取点)")
        readout_layout = QVBoxLayout(readout)
        self.readout_label = QLabel("点击图像选取固定点")
        self.readout_label.setWordWrap(True)
        readout_layout.addWidget(self.readout_label)
        rl.addWidget(readout)

        legend = QGroupBox("方向图与错误配色 (固定, 不随色图改变)")
        ll = QVBoxLayout(legend)
        ll.addWidget(QLabel("色相 = 偏振方向 φ (0→180° 循环)"))
        hue = self._hue_bar_label()
        ll.addWidget(hue)
        ll.addWidget(QLabel("饱和度 = 偏振度 ρ, 明度 = 直流亮度 A"))
        ll.addSpacing(6)
        for name, color, desc in (
            ("saturated", ERROR_COLORS["saturated"], "过曝: 通道达到上限, 真实亮度未知"),
            ("unphysical", ERROR_COLORS["unphysical"], "非物理: R>A, 数据/模型冲突"),
            ("residual", ERROR_COLORS["residual"], "无法解释: 残差超过阈值"),
            ("dark", ERROR_COLORS["dark"], "极暗: 信号接近噪声底"),
        ):
            ll.addWidget(self._legend_row(color, desc))
        ll.addWidget(self._legend_row((170, 200, 170), "可信像素 (质量图)"))
        ll.addStretch(1)
        rl.addWidget(legend)
        rl.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidget(right)
        scroll.setWidgetResizable(True)

        root.addWidget(left)
        root.addWidget(center)
        root.addWidget(scroll)
        root.setStretchFactor(0, 0)
        root.setStretchFactor(1, 1)
        root.setStretchFactor(2, 0)
        root.setSizes([340, 820, 280])
        self.setCentralWidget(root)

    @staticmethod
    def _thr_spin(value: float, lo: float, hi: float, step: float, decimals: int) -> QDoubleSpinBox:
        sp = QDoubleSpinBox()
        sp.setRange(lo, hi)
        sp.setDecimals(decimals)
        sp.setSingleStep(step)
        sp.setValue(value)
        return sp

    @staticmethod
    def _legend_row(rgb: tuple[int, int, int], text: str) -> QWidget:
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(0, 0, 0, 0)
        chip = QLabel("　")
        chip.setStyleSheet(f"background: rgb({rgb[0]},{rgb[1]},{rgb[2]}); border: 1px solid #555;")
        chip.setFixedWidth(26)
        h.addWidget(chip)
        h.addWidget(QLabel(text), 1)
        return w

    @staticmethod
    def _hue_bar_label() -> QLabel:
        # 用一条渐变 CSS 表示 0..180 度色相
        lab = QLabel("0°　　　　　　90°　　　　　180°")
        lab.setStyleSheet(
            "background: qlineargradient(x1:0, y1:0, x2:1, y2:0, "
            "stop:0 hsv(0,204,242), stop:0.25 hsv(90,204,242), stop:0.5 hsv(180,204,242), "
            "stop:0.75 hsv(270,204,242), stop:1 hsv(359,204,242)); padding: 10px; color: #333;"
        )
        lab.setMinimumHeight(34)
        lab.setAlignment(Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignHCenter)
        return lab

    # ------------------------------------------------------------ 输入管理
    def _rebuild_table(self):
        self.table.blockSignals(True)
        self.table.setRowCount(len(self._rows))
        for r, row in enumerate(self._rows):
            self.table.setItem(r, 0, QTableWidgetItem(str(r + 1)))
            name = Path(row["path"]).name if row["path"] else "合成图"
            item = QTableWidgetItem(name)
            item.setToolTip(row["path"] or "内置合成数据")
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.table.setItem(r, 1, item)

            sp = QDoubleSpinBox()
            sp.setRange(-360.0, 360.0)
            sp.setDecimals(1)
            sp.setValue(row["angle"])
            sp.valueChanged.connect(lambda val, idx=r: self._on_angle_edited(idx, val))
            self.table.setCellWidget(r, 2, sp)
        self.table.blockSignals(False)
        self._validate_inputs()

    def _on_angle_edited(self, idx: int, value: float):
        self._rows[idx]["angle"] = float(value)
        self._validate_inputs()

    def _validate_inputs(self) -> list[str]:
        problems: list[str] = []
        if len(self._rows) < 3:
            problems.append(f"当前只有 {len(self._rows)} 张图, 至少需要 3 张 (推荐 4 张)")
        angles = [r["angle"] for r in self._rows]
        problems.extend(check_angles(angles))
        text = "\n".join("• " + p for p in problems)
        self.problem_label.setText(text)
        self.btn_fit.setEnabled(not problems)
        return problems

    def add_images(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择同机位不同滤镜角度的照片", "",
            "图像 (*.png *.jpg *.jpeg *.tif *.tiff *.bmp *.webp)",
        )
        if not paths:
            return
        loaded: list[dict] = []
        problems: list[str] = []
        base = self._rows[0]["image"].shape[1::-1] if self._rows else None
        for p in paths:
            try:
                im = load_rgb(p)
            except Exception as exc:
                problems.append(str(exc))
                continue
            size = (im.shape[1], im.shape[0])
            if base is not None and size != base:
                problems.append(f"{Path(p).name} 尺寸 {size[0]}x{size[1]} 与现有 {base[0]}x{base[1]} 不一致, 已跳过")
                continue
            base = size
            loaded.append({"path": p, "image": im, "angle": 0.0})
        if loaded:
            self._rows.extend(loaded)
            self._renumber_angles()
            self._rebuild_table()
        if problems:
            QMessageBox.warning(self, "部分图像未加载", "\n".join(problems))

    def remove_rows(self):
        rows = sorted({i.row() for i in self.table.selectedIndexes()}, reverse=True)
        for r in rows:
            del self._rows[r]
        self._rebuild_table()

    def move_row(self, delta: int):
        rows = sorted(i.row() for i in self.table.selectedIndexes())
        if not rows:
            return
        order = list(range(len(self._rows)))
        for r in (rows if delta < 0 else reversed(rows)):
            j = r + delta
            if 0 <= j < len(order):
                order[r], order[j] = order[j], order[r]
        self._rows = [self._rows[i] for i in order]
        self._rebuild_table()
        self.table.selectRow(rows[0] + delta)

    def _renumber_angles(self):
        """新增行默认补一组均匀角度, 只覆盖与其他行重复的角度."""
        n = len(self._rows)
        defaults = np.linspace(0.0, 180.0 * (n - 1) / max(n, 1), n)
        used = [r["angle"] for r in self._rows]
        for i, row in enumerate(self._rows):
            other = used[:i] + used[i + 1:]
            if any(abs(row["angle"] - a) < 1e-9 for a in other):
                row["angle"] = round(float(defaults[i]), 1)

    def open_synthetic(self):
        dlg = SyntheticDialog(self)
        if dlg.exec() != SyntheticDialog.DialogCode.Accepted:
            return
        cfg = dlg.config()
        stack = generate_synthetic(cfg, DEFAULT_ANGLES)
        self._rows = [
            {"path": None, "image": stack[i], "angle": DEFAULT_ANGLES[i]}
            for i in range(stack.shape[0])
        ]
        self._rebuild_table()
        self.run_fit()

    # ------------------------------------------------------------ 拟合
    def _current_thresholds(self) -> Thresholds:
        return Thresholds(
            dark=self.sp_dark.value(),
            saturated_value=self.sp_sat.value(),
            residual_ratio=self.sp_resid.value(),
            unphysical_tol=self.sp_unphys.value(),
        )

    def _schedule_refit(self):
        if self._fit is not None:
            self._refit_timer.start(350)

    def run_fit(self):
        problems = self._validate_inputs()
        if problems:
            QMessageBox.warning(self, "无法分析", "\n".join(problems))
            return
        if self._worker is not None and self._worker.isRunning():
            # 已有拟合在跑: 让它跑完后由世代机制丢弃, 排队下一轮
            self._refit_timer.start(200)
            return
        stack = np.stack([r["image"] for r in self._rows], axis=0)
        angles = [r["angle"] for r in self._rows]
        self.lbl_status.setText("拟合中…")
        self.btn_fit.setEnabled(False)
        self._fit_generation += 1
        gen = self._fit_generation
        self._worker = FitWorker(
            stack, angles,
            linearize=self.cb_linear.isChecked(),
            normalize=self.cb_exposure.isChecked(),
            thresholds=self._current_thresholds(),
        )
        self._worker.finished_ok.connect(lambda r, g=gen: self._on_fit_done(r, g))
        self._worker.failed.connect(self._on_fit_failed)
        self._worker.start()

    def _on_fit_failed(self, msg: str):
        self.btn_fit.setEnabled(not self._validate_inputs())
        self.lbl_status.setText("拟合失败")
        QMessageBox.critical(self, "拟合失败", msg)

    def _on_fit_done(self, fit: FitResult, generation: int):
        if generation != self._fit_generation:
            return  # 已被更新的一轮取代
        self._fit = fit
        self.btn_fit.setEnabled(True)
        self.lbl_status.setText(
            f"完成: {fit.shape[1]}x{fit.shape[0]}, 可信像素 {fit.trustworthy.mean() * 100:.1f}%"
        )
        if fit.residual_dof == 0:
            self.lbl_status.setText(self.lbl_status.text() + " (仅 3 帧, 残差掩码不可用)")
        self._render_all()
        if self._probe is None:
            h, w = fit.shape
            self.on_pick(w // 2, h // 2)
        else:
            # 取点可能落在新图范围外, 钳制后刷新曲线
            h, w = fit.shape
            x = min(self._probe[0], w - 1)
            y = min(self._probe[1], h - 1)
            self._probe = (x, y)
            self._refresh_curve()

    def _render_all(self):
        fit = self._fit
        if fit is None:
            return
        self.views[0].set_image(render_direction(fit))
        self.views[1].set_image(render_gray(fit.R, fit))
        self.views[2].set_image(render_gray(fit.rho, fit))
        self.views[3].set_image(render_quality(fit))
        self._refresh_sim()
        for v in self.views:
            v.set_probe(self._probe)

    # ------------------------------------------------------------ 模拟与取点
    def on_slider(self, value: int):
        self.sp_theta.blockSignals(True)
        self.sp_theta.setValue(float(value))
        self.sp_theta.blockSignals(False)
        self._refresh_sim()
        if self._fit is not None and self._probe is not None:
            self.curve.update_vline(float(value))

    def _on_spin_theta(self, value: float):
        self.slider.blockSignals(True)
        self.slider.setValue(int(round(value)))
        self.slider.blockSignals(False)
        self._refresh_sim()
        if self._fit is not None and self._probe is not None:
            self.curve.update_vline(value)

    def _refresh_sim(self):
        if self._fit is None:
            return
        rgb = (self._fit.simulate_rgb(self.sp_theta.value()) * 255).astype(np.uint8)
        if self.cb_overlay.isChecked():
            rgb = overlay_errors(rgb, self._fit)
        self.views[4].set_image(rgb)
        self.views[4].set_probe(self._probe)

    def on_hover(self, x: int, y: int):
        self._hover = (x, y)
        if self._fit is None:
            return
        f = self._fit
        self.readout_label.setText(
            f"悬停 ({x}, {y})\nA={f.A[y, x]:.4f}  R={f.R[y, x]:.4f}\n"
            f"ρ={f.rho[y, x]:.3f}  φ={f.phi[y, x]:.1f}°\n类别: {f.category_at(y, x)}"
        )

    def on_pick(self, x: int, y: int):
        self._probe = (x, y)
        for v in self.views:
            v.set_probe((x, y))
        self._refresh_curve()

    def _refresh_curve(self):
        if self._fit is None or self._probe is None:
            return
        x, y = self._probe
        self.curve.plot_probe(self._fit, x, y, self.sp_theta.value())
        self.on_hover(x, y)

    # ------------------------------------------------------------ 导出
    def _ask_save(self, title: str, default_name: str, flt: str) -> Path | None:
        path, _ = QFileDialog.getSaveFileName(self, title, default_name, flt)
        return Path(path) if path else None

    def export_preview(self):
        if not self._require_fit():
            return
        path = self._ask_save("导出模拟预览", f"preview_{self.sp_theta.value():.0f}deg.png", "PNG (*.png)")
        if path:
            save_rgb(self._sim_rgb(), path)
            self._toast(f"已导出 {path}")

    def _sim_rgb(self) -> np.ndarray:
        rgb = (self._fit.simulate_rgb(self.sp_theta.value()) * 255).astype(np.uint8)
        return overlay_errors(rgb, self._fit) if self.cb_overlay.isChecked() else rgb

    def export_trust_mask(self):
        if not self._require_fit():
            return
        path = self._ask_save("导出可信区域掩码", "trustworthy_mask.png", "PNG (*.png)")
        if path:
            save_mask(self._fit.trustworthy, path)
            self._toast(f"已导出 {path} (白=可信)")

    def export_direction(self):
        if not self._require_fit():
            return
        path = self._ask_save("导出方向图", "direction.png", "PNG (*.png)")
        if path:
            save_rgb(render_direction(self._fit), path)
            self._toast(f"已导出 {path}")

    def export_csv(self):
        if not self._require_fit():
            return
        path = self._ask_save("导出拟合参数", "fit_params.csv", "CSV (*.csv)")
        if path:
            export_fit_csv(self._fit, path)
            self._toast(f"已导出 {path}")

    def export_curve(self):
        if not self._require_fit() or self._probe is None:
            QMessageBox.information(self, "提示", "请先在图像上点击选取一个固定点")
            return
        path = self._ask_save("导出取点曲线", f"probe_{self._probe[0]}_{self._probe[1]}.csv", "CSV (*.csv)")
        if path:
            export_probe_csv(self._fit, *self._probe, np.arange(0, 180.01, 1.0), path)
            self._toast(f"已导出 {path}")

    def _require_fit(self) -> bool:
        if self._fit is None:
            QMessageBox.information(self, "提示", "请先运行分析")
            return False
        return True

    def _toast(self, msg: str):
        self.lbl_status.setText(msg)

    def closeEvent(self, event):
        if self._worker is not None and self._worker.isRunning():
            self._worker.wait(3000)
        super().closeEvent(event)
