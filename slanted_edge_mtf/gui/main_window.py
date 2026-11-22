"""主窗口: 图像/选区交互 + ESF/LSF/MTF 面板 + 可信度提示 + 锁定比较 + 导出。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QColor
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDoubleSpinBox,
                               QFileDialog, QFrame, QHBoxLayout, QLabel,
                               QMainWindow, QMessageBox, QPushButton,
                               QSplitter, QStackedWidget, QTabWidget,
                               QVBoxLayout, QWidget)

from .. import analysis
from ..exporting import export_all
from .image_view import ImageView, ROI_COLORS
from .plot_widget import PlotConfig, PlotWidget, Series
from .synthetic_dialog import SyntheticDialog

FLAG_STYLE = {
    "error": ("#c0392b", "✖"),
    "warn": ("#d68910", "▲"),
    "info": ("#2471a3", "ℹ"),
}
PLOT_COLORS = (QColor(0, 122, 204), QColor(214, 107, 0))


def _read_image(path: str) -> np.ndarray:
    """用 QImage 读图(无第三方图像库依赖), 返回 float64 灰度 0..1。"""
    from PySide6.QtGui import QImage
    qimg = QImage(path)
    if qimg.isNull():
        raise ValueError(f"无法读取图像: {path}")
    if qimg.format() in (QImage.Format_Grayscale8, QImage.Format_Grayscale16):
        qimg = qimg.convertToFormat(QImage.Format_Grayscale8)
        ptr = qimg.bits()
        arr = np.frombuffer(ptr, dtype=np.uint8).reshape(
            qimg.height(), qimg.width())
        return arr.astype(np.float64) / 255.0
    qimg = qimg.convertToFormat(QImage.Format_RGBA8888)
    ptr = qimg.bits()
    arr = np.frombuffer(ptr, dtype=np.uint8).reshape(
        qimg.height(), qimg.width(), 4)
    return analysis.to_gray(arr)


class RoiPanel(QWidget):
    """单个 ROI 的三幅图 + 读数 + 可信度; read_only 时隐藏控制控件。"""

    def __init__(self, index: int, read_only: bool = False) -> None:
        super().__init__()
        self.index = index
        self.read_only = read_only
        self.setMinimumWidth(340)
        color = ROI_COLORS[index]
        self.result: analysis.AnalysisResult | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(6, 6, 6, 6)

        head = QHBoxLayout()
        tag = QLabel(f"ROI {index + 1}")
        tag.setStyleSheet(
            f"font-weight:bold;color:white;background:{color.name()};"
            "padding:2px 8px;border-radius:3px;")
        head.addWidget(tag)
        self.status = QLabel("尚未选择区域")
        self.status.setStyleSheet("color:#666;")
        head.addWidget(self.status, 1)
        root.addLayout(head)

        self.ctl_widget = QWidget()
        ctl = QHBoxLayout(self.ctl_widget)
        ctl.setContentsMargins(0, 0, 0, 0)
        ctl.addWidget(QLabel("拟合范围 ±"))
        self.half_width = QDoubleSpinBox()
        self.half_width.setRange(1.5, 200.0)
        self.half_width.setSuffix(" px")
        self.half_width.setDecimals(2)
        self.half_width.setSingleStep(0.5)
        ctl.addWidget(self.half_width)
        self.invert = QCheckBox("调换黑白方向")
        ctl.addWidget(self.invert)
        ctl.addStretch(1)
        root.addWidget(self.ctl_widget)
        self.ctl_widget.setVisible(not read_only)

        self.metrics = QLabel()
        self.metrics.setTextFormat(Qt.RichText)
        self.metrics.setWordWrap(True)
        self.metrics.setFrameStyle(QFrame.StyledPanel)
        self.metrics.setStyleSheet(
            "background:#f7f8fa;padding:6px;border-radius:4px;")
        root.addWidget(self.metrics)

        self.flags = QLabel()
        self.flags.setTextFormat(Qt.RichText)
        self.flags.setWordWrap(True)
        root.addWidget(self.flags)

        self.esf_plot = PlotWidget(PlotConfig(
            title="ESF 过渡曲线", x_label="到直边的有符号距离 (px)",
            y_label="灰度"))
        self.lsf_plot = PlotWidget(PlotConfig(
            title="LSF 线扩散函数", x_label="距离 (px)", y_label="归一化梯度"))
        self.mtf_plot = PlotWidget(PlotConfig(
            title="MTF 细节保留比例",
            x_label="空间频率 (周期/原图像素)", y_label="MTF",
            y_lim=(0.0, 1.08)))
        for w_ in (self.esf_plot, self.lsf_plot, self.mtf_plot):
            root.addWidget(w_)
        root.addStretch(1)

    # ------------------------------------------------------------ 刷新
    def sync_controls(self, half_width: float, inverted: bool,
                      maximum: float) -> None:
        """只读镜像面板同步主控面板的控件状态。"""
        self.half_width.blockSignals(True)
        self.half_width.setMaximum(maximum)
        self.half_width.setValue(half_width)
        self.half_width.blockSignals(False)
        self.invert.blockSignals(True)
        self.invert.setChecked(inverted)
        self.invert.blockSignals(False)

    def show_error(self, message: str) -> None:
        self.result = None
        self.status.setText("分析失败")
        self.status.setStyleSheet("color:#c0392b;font-weight:bold;")
        self.metrics.setText(f'<span style="color:#c0392b">{message}</span>')
        self.flags.clear()
        for p in (self.esf_plot, self.lsf_plot, self.mtf_plot):
            p.set_config(PlotConfig(title=p.cfg.title))

    def update_result(self, r: analysis.AnalysisResult) -> None:
        self.result = r
        self.status.setText(
            f"可信度: {r.confidence}    样本 {int(r.sample_used.sum())}"
            f"/{r.sample_used.size} px")
        conf_color = {"高": "#1e8449", "中": "#b9770e", "低": "#c0392b"}[
            r.confidence]
        self.status.setStyleSheet(
            f"color:{conf_color};font-weight:bold;")

        mtf50_txt = (f"{r.mtf50:.4f}" if r.mtf50 is not None
                     else "超出可测范围(>Nyquist)")
        self.metrics.setText(
            f"<b>MTF50</b> = <span style='color:#c0392b;font-size:15px'>"
            f"{mtf50_txt}</span> 周期/像素 &nbsp;&nbsp; "
            f"MTF@Nyquist = {r.mtf_nyquist:.3f}<br>"
            f"黑电平 {r.dark_level:.3f} / 白电平 {r.light_level:.3f} / "
            f"对比 {abs(r.contrast):.3f} / 噪声 {r.noise_est:.4f}<br>"
            f"边缘角度 {r.edge.angle_deg:.1f}° / 拟合残差 "
            f"{r.edge.residual_rms_px:.2f} px / 振铃负瓣 {r.ringing_pct:.1f}%"
            f" / ESF 过冲 {r.overshoot_pct:.1f}%")

        if r.flags:
            lines = []
            for f in r.flags:
                color, icon = FLAG_STYLE[f.level]
                lines.append(
                    f"<div style='color:{color}'>{icon} "
                    f"[{f.level.upper()}] {f.message}</div>")
            self.flags.setText(
                "<b>可信度提示</b><br>" + "".join(lines))
        else:
            self.flags.setText(
                "<span style='color:#1e8449'><b>✓ 未发现可信度问题</b></span>")

        c = PLOT_COLORS[self.index]
        # ESF: bin 均值 + 原像素散点
        self.esf_plot.set_config(PlotConfig(
            title="ESF 过渡曲线",
            x_label="到直边的有符号距离 (px)", y_label="灰度",
            series=[
                Series(list(r.sample_dist[r.sample_used]),
                       list(r.sample_value[r.sample_used]),
                       QColor(150, 150, 158), label="原像素样本",
                       scatter=True, width=1.0),
                Series(list(r.esf_dist), list(r.esf_mean), c,
                       label="4× 超采样 ESF", width=2.0),
            ]))
        # LSF: 用远离主峰的尾部估计基线, 归一化后基线落在 0
        lsf_abs = np.abs(r.lsf)
        tail = lsf_abs < 0.15 * lsf_abs.max()
        baseline = float(r.lsf[tail].mean()) if tail.any() else 0.0
        lsf = r.lsf - baseline
        lsf_norm = lsf / max(np.abs(lsf).max(), 1e-12)
        lsf_span = float(np.abs(r.lsf_dist).max())
        self.lsf_plot.set_config(PlotConfig(
            title="LSF 线扩散函数", x_label="距离 (px)",
            y_label="归一化梯度",
            x_lim=(-lsf_span, lsf_span), y_lim=(-0.6, 1.12),
            series=[Series(list(r.lsf_dist), list(lsf_norm), c,
                           label="LSF", width=2.0, hline=0.0)]))
        # MTF 只画到 Nyquist(0.5); 物理上 MTF≥0, 负的噪声底裁到 0
        sel = r.mtf_freq <= 0.5
        mtf_view = np.clip(r.mtf[sel], 0.0, None)
        self.mtf_plot.set_config(PlotConfig(
            title="MTF 细节保留比例",
            x_label="空间频率 (周期/原图像素)", y_label="MTF",
            x_lim=(0.0, 0.5), y_lim=(0.0, 1.08),
            series=[Series(list(r.mtf_freq[sel]), list(mtf_view), c,
                           label="MTF", width=2.0,
                           vline=r.mtf50, hline=0.5)]))


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("斜边 MTF 离线分析工具")
        self.resize(1500, 950)

        self.gray: np.ndarray | None = None
        self.source_name = ""
        self.rois: list[tuple[int, int, int, int]] = [None, None]
        self.edges: list = [None, None]
        # 两套独立面板: 单视图(带控件) + 并排只读镜像, 共享同一份结果
        self.panels = [RoiPanel(0), RoiPanel(1)]
        self.mirrors = [RoiPanel(0, read_only=True),
                        RoiPanel(1, read_only=True)]
        self._suppress_ctl = False
        self._build_ui()
        self._build_menu()

    # -------------------------------------------------------------- UI 搭建
    def _build_ui(self) -> None:
        central = QSplitter(Qt.Horizontal)

        # 左: 图像视图 + 工具条
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(4, 4, 4, 4)
        bar = QHBoxLayout()
        self.view = ImageView()
        self.view.roi_created.connect(self._on_roi_drawn)
        self.view.roi_selected.connect(self._select_roi)

        self.roi_selector = QComboBox()
        self.roi_selector.addItems(["ROI 1", "ROI 2"])
        self.roi_selector.currentIndexChanged.connect(self._select_roi)
        bar.addWidget(QLabel("当前选区"))
        bar.addWidget(self.roi_selector)

        self.lock_btn = QPushButton("锁住并排比较")
        self.lock_btn.setCheckable(True)
        self.lock_btn.toggled.connect(self._on_lock_toggled)
        bar.addWidget(self.lock_btn)

        self.show_samples = QCheckBox("显示测量样本")
        self.show_samples.setChecked(True)
        self.show_samples.toggled.connect(self._refresh_overlay)
        bar.addWidget(self.show_samples)

        for txt, fn in (("放大", lambda: self.view.scale(1.25, 1.25)),
                        ("缩小", lambda: self.view.scale(0.8, 0.8)),
                        ("适应窗口", self.view.reset_view),
                        ("旋转 90°", lambda: self.view.rotate_view(90))):
            b = QPushButton(txt)
            b.clicked.connect(fn)
            bar.addWidget(b)
        bar.addStretch(1)
        lv.addLayout(bar)
        lv.addWidget(self.view, 1)
        central.addWidget(left)

        # 右: 选项卡(单区, 带控件) / 并排(锁定, 只读镜像), 两套独立控件
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)
        self.stack = QStackedWidget()
        self.tabs = QTabWidget()
        self.tabs.addTab(self.panels[0], "ROI 1")
        self.tabs.addTab(self.panels[1], "ROI 2")
        self.stack.addWidget(self.tabs)

        compare = QSplitter(Qt.Horizontal)
        compare.addWidget(self.mirrors[0])
        compare.addWidget(self.mirrors[1])
        compare.setStretchFactor(0, 1)
        compare.setStretchFactor(1, 1)
        compare.setSizes([420, 420])
        self.stack.addWidget(compare)
        rv.addWidget(self.stack)
        central.addWidget(right)
        central.setStretchFactor(0, 5)
        central.setStretchFactor(1, 6)
        central.setSizes([780, 900])
        self.setCentralWidget(central)

        for i, p in enumerate(self.panels):
            p.half_width.editingFinished.connect(
                lambda _=None, i=i: self._on_half_width_edited(i))
            p.half_width.valueChanged.connect(
                lambda _v, i=i: self._on_half_width_changed(i))
            p.invert.toggled.connect(
                lambda _=None, i=i: self._on_invert_toggled(i))

        self.statusBar().showMessage(
            "打开图片或生成合成样例后, 在图上拖框圈出斜边(按住 Alt/中键平移, "
            "滚轮缩放)。预览变换不影响测量数据。")

    def _build_menu(self) -> None:
        m_file = self.menuBar().addMenu("文件")
        for text, slot in (
                ("打开图片…", self.open_image),
                ("生成合成斜边样例…", self.open_synthetic),
                ("导出分析结果(JSON+CSV)…", self.export_results),
                ("退出", self.close)):
            act = QAction(text, self)
            act.triggered.connect(slot)
            m_file.addAction(act)
        m_tool = self.menuBar().addMenu("工具")
        act = QAction("运行离线验证套件", self)
        act.triggered.connect(self.run_selftest)
        m_tool.addAction(act)

    # ------------------------------------------------------------ 图像载入
    def open_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择含斜边的图片", "",
            "图像 (*.png *.tif *.tiff *.bmp *.jpg *.jpeg *.webp *.pgm)")
        if not path:
            return
        try:
            gray = _read_image(path)
        except ValueError as exc:
            QMessageBox.warning(self, "读取失败", str(exc))
            return
        self._set_image(gray, Path(path).name)

    def open_synthetic(self) -> None:
        dlg = SyntheticDialog(self)
        if dlg.exec() != dlg.Accepted:
            return
        img, suggested_roi, desc = dlg.build()
        self._set_image(img, desc)
        if suggested_roi is not None:
            self.rois[0] = suggested_roi
            self._active_index = 0
            self.roi_selector.setCurrentIndex(0)
            self._analyze(0)
            self._refresh_overlay()

    def _set_image(self, gray: np.ndarray, name: str) -> None:
        self.gray = gray
        self.source_name = name
        self.rois = [None, None]
        self.edges = [None, None]
        for p in self.panels + self.mirrors:
            p.result = None
            p.status.setText("尚未选择区域")
            p.status.setStyleSheet("color:#666;")
            p.flags.clear()
            p.metrics.clear()
        self._suppress_ctl = True
        for p in self.panels:
            p.half_width.setMaximum(200.0)
            p.half_width.setValue(1.5)
            p.invert.setChecked(False)
        self._suppress_ctl = False
        self.view.set_image(gray)
        self.setWindowTitle(f"斜边 MTF 离线分析工具 — {name}")

    # ------------------------------------------------- 面板广播(单页+镜像)
    def _show_result(self, idx: int,
                     r: analysis.AnalysisResult) -> None:
        for p in (self.panels[idx], self.mirrors[idx]):
            p.update_result(r)
        self.mirrors[idx].sync_controls(
            r.fit_half_width, r.inverted,
            self.panels[idx].half_width.maximum())

    def _show_error(self, idx: int, message: str) -> None:
        for p in (self.panels[idx], self.mirrors[idx]):
            p.show_error(message)

    # ------------------------------------------------------------- ROI 流程
    def _on_roi_drawn(self, idx: int, roi: tuple) -> None:
        self.rois[idx] = roi
        self.roi_selector.setCurrentIndex(idx)
        self._analyze(idx)
        self._refresh_overlay()

    def _select_roi(self, idx: int) -> None:
        self.view.overlay.selected = idx
        self.view.overlay.update()
        self.tabs.setCurrentIndex(idx)

    def _on_lock_toggled(self, on: bool) -> None:
        self.lock_btn.setText("解除并排比较" if on else "锁住并排比较")
        self.stack.setCurrentIndex(1 if on else 0)
        if on:
            self._sync_locked_range(self.panels[0])

    def _on_half_width_edited(self, idx: int) -> None:
        self._remeasure(idx)
        if self.lock_btn.isChecked():
            self._sync_locked_range(self.panels[idx])

    def _on_half_width_changed(self, idx: int) -> None:
        # 程序内 setValue 引起的变化不重算, 避免递归
        if self._suppress_ctl:
            return
        if self.lock_btn.isChecked():
            self._sync_locked_range(self.panels[idx])
        else:
            self._remeasure(idx)

    def _on_invert_toggled(self, idx: int) -> None:
        self._remeasure(idx)
        self._refresh_overlay()

    def _sync_locked_range(self, src_panel: "RoiPanel") -> None:
        """锁定模式下拟合范围按相对比例联动(各自最大范围的同一 fraction),
        不同尺寸的选区也能公平比较, 两个结果同时更新。"""
        if not self.lock_btn.isChecked():
            return
        src_idx = self.panels.index(src_panel)
        src_max = src_panel.half_width.maximum()
        fraction = src_panel.half_width.value() / max(src_max, 1e-9)
        self._suppress_ctl = True
        try:
            for i, p in enumerate(self.panels):
                if i == src_idx or self.rois[i] is None:
                    continue
                target = p.half_width.maximum() * fraction
                p.half_width.setValue(min(target, p.half_width.maximum()))
        finally:
            self._suppress_ctl = False
        for i in range(2):
            if self.rois[i] is not None:
                self._remeasure(i)

    # ------------------------------------------------------------- 分析计算
    def _analyze(self, idx: int) -> None:
        roi = self.rois[idx]
        panel = self.panels[idx]
        if roi is None or self.gray is None:
            return
        try:
            edge = analysis.fit_edge(self.gray, roi)
            self.edges[idx] = edge
            max_hw = analysis.default_half_width(roi, edge)
            self._suppress_ctl = True
            panel.half_width.setMaximum(max_hw)
            # 新选区: 总是先用满可用范围; 用户改小后重算不会被覆盖
            if panel.half_width.value() <= 1.5001 or \
                    panel.half_width.value() > max_hw:
                panel.half_width.setValue(max_hw)
            self._suppress_ctl = False
            self._remeasure(idx)
        except ValueError as exc:
            self._show_error(idx, str(exc))
            self.edges[idx] = None
            self._refresh_overlay()

    def _remeasure(self, idx: int) -> None:
        roi, edge = self.rois[idx], self.edges[idx]
        if roi is None or edge is None or self.gray is None:
            return
        panel = self.panels[idx]
        try:
            r = analysis.measure(self.gray, roi, edge,
                                 panel.half_width.value(),
                                 panel.invert.isChecked())
            self._show_result(idx, r)
        except ValueError as exc:
            self._show_error(idx, str(exc))
        self._refresh_overlay()

    def _refresh_overlay(self) -> None:
        # overlay 按全局索引(0/1)取色与编号, 空选区用 None 占位
        valid: list[tuple[int, tuple]] = []
        segs: list = [None, None]
        pts: list = [None, None]
        for i in range(2):
            if self.rois[i] is None:
                continue
            valid.append((i, self.rois[i]))
            if self.edges[i] is not None:
                segs[i] = analysis.edge_segment(self.rois[i], self.edges[i])
            r = self.panels[i].result
            if r is not None and self.show_samples.isChecked():
                x0, y0, w, h = self.rois[i]
                rows, cols = np.mgrid[0:h, 0:w]
                gx = cols.ravel() + 0.5 + x0
                gy = rows.ravel() + 0.5 + y0
                m = r.sample_used
                pts[i] = np.column_stack([gx[m], gy[m]])
        self.view.set_rois(
            [roi for _, roi in valid],
            [i for i, _ in valid],
            [segs[i] for i, _ in valid],
            [pts[i] for i, _ in valid],
            self.roi_selector.currentIndex(),
            self.show_samples.isChecked())

    # ---------------------------------------------------------------- 导出
    def export_results(self) -> None:
        if self.gray is None:
            QMessageBox.information(self, "提示", "请先打开图片并选择区域")
            return
        avail = [i for i in range(2) if self.panels[i].result is not None]
        if not avail:
            QMessageBox.information(self, "提示", "还没有可用的分析结果")
            return
        d = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not d:
            return
        names = ["roi1", "roi2"]
        try:
            written = export_all(d, [p.result for p in self.panels],
                                 names, self.source_name)
        except OSError as exc:
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        QMessageBox.information(
            self, "导出完成",
            "已写入:\n" + "\n".join(str(Path(x).name) for x in written))

    # ------------------------------------------------------------- 自检
    def run_selftest(self) -> None:
        from ..selftest import run_all
        checks = run_all()
        lines, n = [], 0
        for c in checks:
            n += c.passed
            lines.append(f"{'✅' if c.passed else '❌'} {c.name}\n     {c.detail}")
        box = QMessageBox(self)
        box.setWindowTitle("离线验证套件")
        box.setText(f"<b>{n}/{len(checks)} 项通过</b>")
        box.setInformativeText("<br>".join(lines).replace("\n", "<br>"))
        box.setStyleSheet("QLabel{min-width:760px;}")
        box.exec()
