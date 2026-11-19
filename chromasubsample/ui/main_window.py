"""主窗口: 三路同步预览、播放控制、平面查看、剖面与区域测量、元数据核对。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog, QFormLayout, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPushButton, QSlider,
    QSplitter, QTabWidget, QTableWidget, QTableWidgetItem, QTextEdit,
    QVBoxLayout, QWidget,
)

from ..analysis import extract_profile, measure_all_modes
from ..color import MODES, PIXEL_FORMATS, reconstruct_rgb
from ..pipeline import Project
from .image_view import PixelView, mode_title
from .profile_plot import ProfilePlot
from .worker import BuildWorker


def _gray(plane: np.ndarray) -> np.ndarray:
    return np.repeat(plane[..., None], 3, axis=2)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("色度采样对比工具 — 4:4:4 / 4:2:2 / 4:2:0 (FFV1 无损)")
        self.resize(1500, 950)

        self.project: Project | None = None
        self.worker: BuildWorker | None = None
        self._index = 0
        self._plane_mode = "color"          # color / Y / Cb / Cr
        self._hover = {"444": (-1, -1), "422": (-1, -1), "420": (-1, -1)}
        self._profile_orient: str | None = None
        self._profile_pos = -1
        self._play_timer = QTimer(self)
        self._play_timer.timeout.connect(self._tick_play)

        self._build_actions()
        self._build_ui()

    # ============================================================ UI 搭建
    def _build_actions(self):
        toolbar = self.addToolBar("文件")
        toolbar.setMovable(False)
        self.act_open = QAction("打开视频…", self)
        self.act_sample = QAction("生成内置样例", self)
        self.act_export = QAction("导出三份视频…", self)
        self.act_export.setEnabled(False)
        toolbar.addAction(self.act_open)
        toolbar.addAction(self.act_sample)
        toolbar.addSeparator()
        toolbar.addAction(self.act_export)
        self.act_open.triggered.connect(self._on_open)
        self.act_sample.triggered.connect(self._on_generate)
        self.act_export.triggered.connect(self._on_export)

    def _build_ui(self):
        central = QWidget()
        root = QVBoxLayout(central)

        # 警告横幅 (核对失败/格式替换时明确指出)
        self.warn_banner = QLabel("")
        self.warn_banner.setWordWrap(True)
        self.warn_banner.setStyleSheet("background:#7a1f1f; color:white; padding:6px; font-weight:600;")
        self.warn_banner.hide()
        root.addWidget(self.warn_banner)

        self.source_label = QLabel("尚未加载工程。打开 ≤5s / ≤720p 的逐行视频, 或生成内置样例。")
        root.addWidget(self.source_label)

        # ---- 三路视图 ----
        self.views: dict[str, PixelView] = {}
        self.titles: dict[str, QLabel] = {}
        splitter = QSplitter(Qt.Orientation.Horizontal)
        for mode in MODES:
            box = QWidget()
            lay = QVBoxLayout(box)
            lay.setContentsMargins(2, 2, 2, 2)
            title = QLabel(mode)
            title.setStyleSheet("font-weight:600; padding:2px;")
            self.titles[mode] = title
            view = PixelView(mode)
            view.hoverChanged.connect(self._on_hover)
            view.regionChanged.connect(self._on_roi)
            view.scrollMoved.connect(self._sync_scroll_factory(mode))
            self.views[mode] = view
            lay.addWidget(title)
            lay.addWidget(view)
            splitter.addWidget(box)
        splitter.setSizes([500, 500, 500])
        root.addWidget(splitter, stretch=3)

        # ---- 控制条 ----
        ctrl = QHBoxLayout()
        self.btn_prev = QPushButton("◀ 上一帧")
        self.btn_play = QPushButton("播放/暂停")
        self.btn_next = QPushButton("下一帧 ▶")
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 0)
        self.frame_label = QLabel("--/--")
        self.time_spin = QDoubleSpinBox()
        self.time_spin.setDecimals(3)
        self.time_spin.setSingleStep(0.1)
        self.time_spin.setSuffix(" s")
        self.btn_seek = QPushButton("按时间定位")
        for w in (self.btn_prev, self.btn_play, self.btn_next):
            ctrl.addWidget(w)
        ctrl.addWidget(self.slider, stretch=2)
        ctrl.addWidget(self.frame_label)
        ctrl.addWidget(self.time_spin)
        ctrl.addWidget(self.btn_seek)
        self.btn_prev.clicked.connect(lambda: self._step(-1))
        self.btn_next.clicked.connect(lambda: self._step(1))
        self.btn_play.clicked.connect(self._toggle_play)
        self.btn_seek.clicked.connect(self._seek_time)
        self.slider.valueChanged.connect(self._on_slider)
        root.addLayout(ctrl)

        # ---- 显示/测量选项 ----
        opt = QHBoxLayout()
        opt.addWidget(QLabel("显示平面:"))
        self.cmb_plane = QComboBox()
        self.cmb_plane.addItems(["彩色重建", "亮度 Y", "色度 Cb (原生尺寸)", "色度 Cr (原生尺寸)"])
        self.cmb_plane.currentIndexChanged.connect(self._on_plane_mode)
        opt.addWidget(self.cmb_plane)

        opt.addWidget(QLabel("整数倍放大:"))
        self.cmb_zoom = QComboBox()
        self.cmb_zoom.addItems([str(z) for z in (1, 2, 4, 8, 16)])
        self.cmb_zoom.setCurrentText("2")
        self.cmb_zoom.currentTextChanged.connect(self._on_zoom)
        opt.addWidget(self.cmb_zoom)

        self.chk_grid = QCheckBox("像素网格/坐标")
        self.chk_grid.setChecked(True)
        self.chk_grid.toggled.connect(lambda on: [v.set_grid(on) for v in self.views.values()])
        opt.addWidget(self.chk_grid)

        self.chk_samples = QCheckBox("色度取样点")
        self.chk_samples.setChecked(True)
        self.chk_samples.toggled.connect(self._refresh_frame)
        opt.addWidget(self.chk_samples)

        self.btn_profile_h = QPushButton("水平剖面@悬停行")
        self.btn_profile_v = QPushButton("竖直剖面@悬停列")
        self.btn_profile_clear = QPushButton("清除剖面")
        self.btn_profile_h.clicked.connect(lambda: self._set_profile("h"))
        self.btn_profile_v.clicked.connect(lambda: self._set_profile("v"))
        self.btn_profile_clear.clicked.connect(self._clear_profile)
        opt.addWidget(self.btn_profile_h)
        opt.addWidget(self.btn_profile_v)
        opt.addWidget(self.btn_profile_clear)
        opt.addStretch(1)
        root.addLayout(opt)

        # ---- 下半部: 剖面 + 测量 + 元数据 ----
        bottom = QSplitter(Qt.Orientation.Horizontal)

        plot_box = QWidget()
        plot_lay = QVBoxLayout(plot_box)
        ch_row = QHBoxLayout()
        ch_row.addWidget(QLabel("剖面通道:"))
        self.cmb_channel = QComboBox()
        self.cmb_channel.addItems(["Y", "Cb", "Cr", "Cb_err (对4:4:4)", "Cr_err (对4:4:4)"])
        self.cmb_channel.currentTextChanged.connect(self._on_channel)
        ch_row.addWidget(self.cmb_channel)
        ch_row.addStretch(1)
        plot_lay.addLayout(ch_row)
        self.plot = ProfilePlot()
        plot_lay.addWidget(self.plot)
        bottom.addWidget(plot_box)

        side = QTabWidget()
        # 测量 tab
        measure_tab = QWidget()
        ml = QVBoxLayout(measure_tab)
        self.roi_label = QLabel("测量区域: 未选择 (在任一画面上按住左键框选)")
        ml.addWidget(self.roi_label)
        self.metrics_text = QTextEdit()
        self.metrics_text.setReadOnly(True)
        ml.addWidget(self.metrics_text)
        side.addTab(measure_tab, "区域色度误差")

        # 元数据 tab —— 实际回读格式
        self.meta_tabs = QTabWidget()
        self.meta_tables: dict[str, QTableWidget] = {}
        self.meta_warns: dict[str, QLabel] = {}
        for mode in MODES:
            tab = QWidget()
            tl = QVBoxLayout(tab)
            warn = QLabel("")
            warn.setWordWrap(True)
            warn.setStyleSheet("color:#ff8a8a;")
            self.meta_warns[mode] = warn
            tl.addWidget(warn)
            table = QTableWidget(0, 2)
            table.setHorizontalHeaderLabels(["字段", "ffprobe 实际值"])
            table.horizontalHeader().setStretchLastSection(True)
            self.meta_tables[mode] = table
            tl.addWidget(table)
            self.meta_tabs.addTab(tab, {"444": "4:4:4", "422": "4:2:2", "420": "4:2:0"}[mode])
        side.addTab(self.meta_tabs, "实际格式核对")
        bottom.addWidget(side)
        bottom.setSizes([750, 650])
        root.addWidget(bottom, stretch=2)

        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪")

    # ============================================================ 工程加载
    def _on_open(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择视频 (≤5s, ≤720p, 逐行)",
            "", "视频文件 (*.mp4 *.mov *.mkv *.avi *.m4v *.webm *.y4m);;所有文件 (*)",
        )
        if path:
            self._start_worker(BuildWorker("input", path=path))

    def _on_generate(self):
        self._start_worker(BuildWorker("synthetic"))

    def _start_worker(self, worker: BuildWorker):
        self._set_busy(True)
        self.worker = worker
        worker.finished_ok.connect(self._on_project_ready)
        worker.failed.connect(self._on_project_failed)
        worker.start()

    def _set_busy(self, busy: bool):
        for a in (self.act_open, self.act_sample):
            a.setEnabled(not busy)
        self.statusBar().showMessage("正在解码 / 编码 / 回读核对…" if busy else "就绪")

    def _on_project_failed(self, msg: str):
        self._set_busy(False)
        QMessageBox.critical(self, "构建失败", msg)

    def _on_project_ready(self, project: Project):
        self._set_busy(False)
        self.act_export.setEnabled(True)
        self.project = project
        self._index = 0
        self._profile_orient = None
        self.slider.setRange(0, project.frame_count - 1)
        self.slider.setValue(0)
        self.time_spin.setRange(0.0, float(project.frame_times[-1]))
        baseline_note = (
            "" if project.is_synthetic else
            "   ⚠ 外部输入的 4:4:4 仅为当前解码基准, 输入已丢失的色度无法恢复, 不是无损原始真值"
        )
        self.source_label.setText(
            f"来源: {project.source_label}   {project.width}x{project.height}   "
            f"{project.fps_fraction} fps   {project.frame_count} 帧   "
            f"时长 {project.duration():.3f}s   颜色: BT.709 limited-range, "
            f"chroma left/co-sited, FFV1 无损 (MKV){baseline_note}"
        )
        self._populate_metadata()
        self._refresh_warnings()
        self._refresh_frame()

    def _populate_metadata(self):
        assert self.project
        for mode in MODES:
            v = self.project.variants[mode]
            table = self.meta_tables[mode]
            table.setRowCount(0)
            for k, val in v.probe.actual.items():
                r = table.rowCount()
                table.insertRow(r)
                table.setItem(r, 0, QTableWidgetItem(k))
                table.setItem(r, 1, QTableWidgetItem(str(val)))
            if v.probe.warnings:
                self.meta_warns[mode].setText("⚠ " + "；".join(v.probe.warnings))
            else:
                self.meta_warns[mode].setText("✓ 像素格式/帧数/时间/颜色参数全部核对通过, 且回读字节与编码输入一致")
                self.meta_warns[mode].setStyleSheet("color:#8aff9b;")

    def _refresh_warnings(self):
        assert self.project
        msgs = list(self.project.warnings)
        for mode in MODES:
            for w in self.project.variants[mode].probe.warnings:
                msgs.append(f"[{mode}] {w}")
        if msgs:
            self.warn_banner.setText("⚠ 核对警告: " + "；".join(msgs))
            self.warn_banner.show()
        else:
            self.warn_banner.hide()

    # ============================================================ 帧渲染
    def _on_plane_mode(self, idx: int):
        self._plane_mode = {0: "color", 1: "Y", 2: "Cb", 3: "Cr"}[idx]
        self._refresh_frame()

    def _on_zoom(self, text: str):
        z = int(text)
        for v in self.views.values():
            v.set_zoom(z)

    def _refresh_frame(self):
        if self.project is None:
            return
        p = self.project
        zoom = int(self.cmb_zoom.currentText())
        native_chroma = self._plane_mode in ("Cb", "Cr")

        # 原生色度平面尺寸各不相同, ROI/剖面只在全尺寸视图 (彩色/Y) 上有效
        if native_chroma:
            for v in self.views.values():
                v.canvas.blockSignals(True)
                v.set_roi(None)
                v.canvas.blockSignals(False)
                v.set_profile_line(None)
            self._update_metrics()
            self.plot.set_profile(None)
            self.roi_label.setText("测量区域: 仅在「彩色重建 / 亮度 Y」全尺寸视图下可用")

        for mode in MODES:
            y, cb_sub, cr_sub = p.get_planes(self._index, mode)
            v = self.project.variants[mode]

            if self._plane_mode == "color":
                img = reconstruct_rgb(y, cb_sub, cr_sub, mode)
            elif self._plane_mode == "Y":
                img = _gray(y)
            elif self._plane_mode == "Cb":
                img = _gray(cb_sub)
            else:
                img = _gray(cr_sub)

            view = self.views[mode]
            view.set_zoom(zoom)
            view.set_image(img)
            view.set_grid(self.chk_grid.isChecked())

            if native_chroma:
                view.set_sample_markers(False, None)
                dims_text = f"原生色度平面 {v.chroma_width}x{v.chroma_height}"
            else:
                show_mk = self.chk_samples.isChecked() and mode != "444"
                view.set_sample_markers(show_mk, (v.chroma_width, v.chroma_height))
                view.set_profile_line(self._profile_orient, self._profile_pos)
                dims_text = f"Y {p.width}x{p.height}  Cb/Cr {v.chroma_width}x{v.chroma_height}"

            self.titles[mode].setText(
                f"{mode_title(mode, v.chroma_width, v.chroma_height, p.width, p.height, v.pix_fmt, v.chroma_location)}\n"
                f"当前: {self.cmb_plane.currentText()}  [{dims_text}]"
                + ("  (解码基准)" if (mode == "444" and not p.is_synthetic) else "")
            )

        self.frame_label.setText(
            f"{self._index + 1}/{p.frame_count}  t={p.time_of(self._index):.3f}s"
        )
        if not native_chroma:
            self._update_metrics()
            self._update_profile_plot()

    # ============================================================ 播放控制
    def _step(self, delta: int):
        if not self.project:
            return
        self._play_timer.stop()
        self._index = int(np.clip(self._index + delta, 0, self.project.frame_count - 1))
        self.slider.blockSignals(True)
        self.slider.setValue(self._index)
        self.slider.blockSignals(False)
        self._refresh_frame()

    def _on_slider(self, value: int):
        if not self.project:
            return
        self._index = value
        self._refresh_frame()

    def _toggle_play(self):
        if not self.project:
            return
        if self._play_timer.isActive():
            self._play_timer.stop()
        else:
            self._play_timer.start(int(1000.0 / self.project.fps))

    def _tick_play(self):
        assert self.project
        if self._index >= self.project.frame_count - 1:
            self._play_timer.stop()
            return
        self._index += 1
        self.slider.blockSignals(True)
        self.slider.setValue(self._index)
        self.slider.blockSignals(False)
        self._refresh_frame()

    def _seek_time(self):
        if not self.project:
            return
        self._play_timer.stop()
        self._index = self.project.frame_at_time(self.time_spin.value())
        self.slider.blockSignals(True)
        self.slider.setValue(self._index)
        self.slider.blockSignals(False)
        self._refresh_frame()

    # ============================================================ 交互
    def _on_hover(self, mode: str, x: int, y: int):
        self._hover[mode] = (x, y)
        if self.project:
            self.statusBar().showMessage(
                f"[{mode}] 坐标 x={x}, y={y}   平面={self.cmb_plane.currentText()}"
            )

    def _sync_scroll_factory(self, source_mode: str):
        def handler(hx, vy):
            for mode, view in self.views.items():
                if mode != source_mode:
                    view.sync_scroll(hx, vy)
        return handler

    def _on_roi(self, mode: str, rect):
        if rect is None or self.project is None:
            self.roi_label.setText("测量区域: 未选择 (在任一画面上按住左键框选)")
            self.metrics_text.clear()
            for v in self.views.values():
                v.set_roi(None)
            return
        for v in self.views.values():
            v.set_roi(rect)
        self.roi_label.setText(
            f"测量区域: x[{rect.x()},{rect.x() + rect.width()}) "
            f"y[{rect.y()},{rect.y() + rect.height()}) — 已重建到全尺寸后比较"
        )
        self._update_metrics()

    def _update_metrics(self):
        if not self.project:
            return
        roi = self.views["444"].roi()
        if roi is None or self._plane_mode in ("Cb", "Cr"):
            if self._plane_mode in ("Cb", "Cr"):
                self.metrics_text.setPlainText("(原生色度平面: 请切回彩色/亮度视图做全尺寸区域测量)")
            return
        stats = measure_all_modes(
            self.project, self._index,
            roi.x(), roi.y(), roi.x() + roi.width(), roi.y() + roi.height(),
        )
        lines = [f"帧 {self._index + 1}  t={self.project.time_of(self._index):.3f}s", ""]
        for s in stats:
            lines += s.as_lines()
            lines.append("")
        self.metrics_text.setPlainText("\n".join(lines))

    def _set_profile(self, orient: str):
        if not self.project:
            return
        x, y = self._hover["444"]
        if orient == "h" and y < 0:
            QMessageBox.information(self, "提示", "先在画面上移动鼠标选择一行")
            return
        if orient == "v" and x < 0:
            QMessageBox.information(self, "提示", "先在画面上移动鼠标选择一列")
            return
        self._profile_orient = orient
        self._profile_pos = y if orient == "h" else x
        self._refresh_frame()

    def _clear_profile(self):
        self._profile_orient = None
        self._profile_pos = -1
        self.plot.set_profile(None)
        self._refresh_frame()

    def _on_channel(self, text: str):
        mapping = {
            "Y": "Y", "Cb": "Cb", "Cr": "Cr",
            "Cb_err (对4:4:4)": "Cb_err", "Cr_err (对4:4:4)": "Cr_err",
        }
        self.plot.set_channel(mapping[text])

    def _update_profile_plot(self):
        if not self.project or self._profile_orient is None:
            self.plot.set_profile(None)
            return
        prof = extract_profile(self.project, self._index,
                               self._profile_orient, self._profile_pos)
        self.plot.set_profile(prof)

    # ============================================================ 导出
    def _on_export(self):
        if not self.project:
            return
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        try:
            paths = self.project.export(out_dir)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", f"{type(exc).__name__}: {exc}")
            return
        text = "\n".join(f"{mode}: {p}" for mode, p in paths.items())
        QMessageBox.information(
            self, "导出完成并回读核对通过",
            text + "\n\n三份文件顺序、帧数、时长一致, 像素格式与颜色参数经 ffprobe 实测确认。",
        )
