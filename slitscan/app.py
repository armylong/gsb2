"""PySide6 GUI for the local slit-scan tool."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PySide6.QtCore import QObject, QRect, Qt, QTimer, QThread, Signal
from PySide6.QtGui import QAction, QColor, QImage, QPainter, QPen
from PySide6.QtWidgets import (QApplication, QComboBox, QDoubleSpinBox,
                               QFileDialog, QFormLayout, QGroupBox, QHBoxLayout,
                               QLabel, QListWidget, QListWidgetItem,
                               QMainWindow, QMessageBox, QPushButton,
                               QScrollArea, QSpinBox, QSplitter, QTabWidget,
                               QVBoxLayout, QWidget)

from .core import (BuildResult, SliceBlock, SlitConfig, block_has_real_pixels,
                   build_strip, frame_to_block, slit_center_at,
                   slit_left_for_center, x_to_block)
from .output import save_result, verify_pages
from .synth import PATTERNS, generate
from .video import VideoInfo, decode_frames, probe

PAD_LABELS = [
    ("edge", "边缘拉伸 (edge)"),
    ("reflect", "镜像反射 (reflect)"),
    ("零值黑边 (zero)", "zero"),
    ("限制在画面内 (limit)", "limit"),
]


# --------------------------------------------------------------------------- #
# decode worker
# --------------------------------------------------------------------------- #

class DecodeWorker(QObject):
    finished = Signal(object, object, object)   # frames, ts, info
    failed = Signal(str)

    def __init__(self, path: str):
        super().__init__()
        self.path = path

    def run(self) -> None:
        try:
            info = probe(self.path)
            frames, ts = decode_frames(self.path, info)
            self.finished.emit(frames, ts, info)
        except Exception as exc:  # surfaced to the user, not swallowed
            self.failed.emit(str(exc))


# --------------------------------------------------------------------------- #
# source frame preview with draggable slit
# --------------------------------------------------------------------------- #

class VideoPreview(QWidget):
    slitEdited = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setMinimumHeight(260)
        self.setMouseTracking(True)
        self.frame: np.ndarray | None = None
        self.slit_left = 0
        self.slit_width = 16
        self.frame_width = 0
        self.padding = "edge"
        self._drag: str | None = None  # 'move' | 'left' | 'right'

    def set_frame(self, frame: np.ndarray) -> None:
        self.frame = frame
        self.frame_width = frame.shape[1]
        self.update()

    def set_slit(self, left: int, width: int, padding: str) -> None:
        self.slit_left, self.slit_width, self.padding = left, width, padding
        self.update()

    # -- geometry helpers -------------------------------------------------- #
    def _scale_offset(self) -> tuple[float, int, int]:
        if self.frame is None:
            return 1.0, 0, 0
        h, w = self.frame.shape[:2]
        s = min(self.width() / w, self.height() / h)
        ox = int((self.width() - w * s) / 2)
        oy = int((self.height() - h * s) / 2)
        return s, ox, oy

    def _to_frame_x(self, mx: int) -> int:
        s, ox, _ = self._scale_offset()
        return int(round((mx - ox) / s))

    def _rect_for(self, x0: int, x1: int) -> QRect:
        s, ox, oy = self._scale_offset()
        h = self.frame.shape[0]
        return QRect(int(ox + x0 * s), oy,
                     max(1, int((x1 - x0) * s)), int(h * s))

    # -- mouse ------------------------------------------------------------- #
    def mousePressEvent(self, ev) -> None:
        if self.frame is None:
            return
        fx = self._to_frame_x(ev.position().toPoint().x())
        if abs(fx - self.slit_left) <= 3:
            self._drag = "left"
        elif abs(fx - (self.slit_left + self.slit_width)) <= 3:
            self._drag = "right"
        elif self.slit_left <= fx < self.slit_left + self.slit_width:
            self._drag = "move"
        else:
            self._drag = "move"
            self.slit_left = fx - self.slit_width // 2
            self.slitEdited.emit()
        self.update()

    def mouseMoveEvent(self, ev) -> None:
        if self._drag is None or self.frame is None:
            return
        fx = self._to_frame_x(ev.position().toPoint().x())
        if self._drag == "left":
            new_left = min(fx, self.slit_left + self.slit_width - 2)
            self.slit_width += self.slit_left - new_left
            self.slit_left = new_left
        elif self._drag == "right":
            self.slit_width = max(2, fx - self.slit_left)
        else:
            self.slit_left = fx - self.slit_width // 2
        self.slitEdited.emit()
        self.update()

    def mouseReleaseEvent(self, ev) -> None:
        self._drag = None

    # -- paint ------------------------------------------------------------- #
    def paintEvent(self, ev) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(24, 24, 28))
        if self.frame is None:
            p.setPen(QColor(180, 180, 180))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       "打开视频或生成内置样片")
            return

        h, w = self.frame.shape[:2]
        img = QImage(self.frame.data, w, h, 3 * w,
                     QImage.Format.Format_RGB888).copy()
        s, ox, oy = self._scale_offset()
        p.drawImage(QRect(ox, oy, int(w * s), int(h * s)), img)

        left, sw = self.slit_left, self.slit_width
        right = left + sw
        # real (in-frame) portion vs padded portion
        real_x0, real_x1 = max(left, 0), min(right, w)
        if real_x1 > real_x0 and self.padding != "limit":
            p.fillRect(self._rect_for(real_x0, real_x1),
                       QColor(80, 220, 120, 70))
        if left < 0:
            p.fillRect(self._rect_for(left, min(right, 0)),
                       QColor(230, 70, 70, 110))
        if right > w:
            p.fillRect(self._rect_for(max(left, w), right),
                       QColor(230, 70, 70, 110))
        if self.padding == "limit":
            clamped = max(0, min(left, w - sw))
            p.fillRect(self._rect_for(clamped, clamped + sw),
                       QColor(80, 160, 255, 70))
        pen = QPen(QColor(255, 220, 60), 2)
        p.setPen(pen)
        p.drawRect(self._rect_for(max(left, 0) if self.padding == "limit"
                                  else left,
                                  max(left, 0) + sw
                                  if self.padding == "limit" else right))
        p.setPen(QColor(255, 255, 255))
        p.drawText(8, 18, f"源像素列: [{max(left, 0)}, {min(right, w)})  "
                          f"补边列: {max(0, -left) + max(0, right - w)}")
        p.end()


# --------------------------------------------------------------------------- #
# strip view (one build result, horizontally scrollable, click-to-backlink)
# --------------------------------------------------------------------------- #

class StripView(QWidget):
    blockClicked = Signal(object)   # SliceBlock

    def __init__(self) -> None:
        super().__init__()
        self.result: BuildResult | None = None
        self.zoom = 1.0
        self.selected: SliceBlock | None = None
        self.setMinimumHeight(220)
        self.setMouseTracking(True)

    def set_result(self, result: BuildResult) -> None:
        self.result = result
        self.selected = None
        self._relayout()

    def _relayout(self) -> None:
        if self.result is None:
            self.setFixedWidth(400)
            self.setFixedHeight(240)
            return
        self.setFixedWidth(max(400, int(self.result.total_width * self.zoom)))
        self.setFixedHeight(max(240, int(self.result.frame_height * self.zoom) + 26))
        self.update()

    def set_zoom(self, z: float) -> None:
        self.zoom = z
        self._relayout()

    def select_block(self, block: SliceBlock | None) -> None:
        self.selected = block
        self.update()

    def _page_at_x(self, x: int) -> tuple[int, int]:
        """Return (page index, local x) for a widget x coordinate."""
        acc = 0
        for i, page in enumerate(self.result.pages):
            pw = int(page.shape[1] * self.zoom)
            if x < acc + pw:
                return i, x - acc
            acc += pw
        return len(self.result.pages) - 1, \
            int(self.result.pages[-1].shape[1] * self.zoom) - 1

    def mousePressEvent(self, ev) -> None:
        if self.result is None:
            return
        page, local_x = self._page_at_x(ev.position().toPoint().x())
        col = int(local_x / self.zoom)
        block = x_to_block(self.result.blocks, page, col)
        if block is not None:
            self.selected = block
            self.update()
            self.blockClicked.emit(block)

    def paintEvent(self, ev) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(18, 18, 22))
        if self.result is None:
            p.setPen(QColor(170, 170, 170))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       "构建后在此显示长图，点击任意列可回到原片")
            p.end()
            return

        x_cursor = 0
        z = self.zoom
        for page_idx, page in enumerate(self.result.pages):
            h, w = page.shape[:2]
            img = QImage(page.data, w, h, 3 * w,
                         QImage.Format.Format_RGB888).copy()
            target = QRect(x_cursor, 20, int(w * z), int(h * z))
            p.drawImage(target, img)
            # page boundary
            if page_idx > 0:
                p.setPen(QPen(QColor(255, 90, 90), 2))
                p.drawLine(x_cursor, 0, x_cursor, self.height())
                p.setPen(QColor(255, 120, 120))
                p.drawText(x_cursor + 3, 12, f"page {page_idx + 1} 接缝")
            x_cursor += int(w * z)

        # markers: synthetic / fully-padded blocks
        for b in self.result.blocks:
            x0 = int(b.global_x0 * z)
            bw = max(1, int(b.width * z))
            if not block_has_real_pixels(b):
                p.fillRect(QRect(x0, 20, bw, int(self.result.frame_height * z)),
                           QColor(230, 60, 60, 90))
            elif b.synthetic:
                p.fillRect(QRect(x0, 20, bw, 6), QColor(255, 170, 40, 200))
            if self.selected is not None and b is self.selected:
                p.setPen(QPen(QColor(90, 200, 255), 2))
                p.drawRect(QRect(x0, 20, bw,
                                 int(self.result.frame_height * z)))
        p.end()


# --------------------------------------------------------------------------- #
# main window
# --------------------------------------------------------------------------- #

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("SlitScan 切缝取图工具")
        self.resize(1380, 900)

        self.frames: np.ndarray | None = None
        self.timestamps: np.ndarray | None = None
        self.info: VideoInfo | None = None
        self.current_idx = 0
        self.results: dict[str, BuildResult] = {}
        self._thread: QThread | None = None
        self._worker: DecodeWorker | None = None

        self._build_timer = QTimer(self)
        self._build_timer.setSingleShot(True)
        self._build_timer.timeout.connect(self.rebuild)

        self._play_timer = QTimer(self)
        self._play_timer.setInterval(30)
        self._play_timer.timeout.connect(self._tick_playback)
        self._play_clock = 0.0

        self._build_ui()

    # -- ui construction --------------------------------------------------- #
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        splitter = QSplitter(Qt.Orientation.Vertical)
        root.addWidget(splitter)
        splitter.addWidget(self._build_source_panel())
        splitter.addWidget(self._build_output_panel())
        splitter.setSizes([460, 380])

        self._build_menu()
        self._set_controls_enabled(False)
        self.statusBar().showMessage("就绪：文件 → 打开视频，或生成内置样片")

    def _build_source_panel(self) -> QWidget:
        box = QWidget()
        lay = QHBoxLayout(box)

        self.preview = VideoPreview()
        self.preview.slitEdited.connect(self._on_slit_dragged)
        lay.addWidget(self.preview, 3)

        side = QWidget()
        form_wrap = QVBoxLayout(side)

        transport = QGroupBox("播放 / 帧")
        tl = QHBoxLayout(transport)
        self.btn_play = QPushButton("暂停/播放")
        self.btn_play.clicked.connect(self._toggle_play)
        self.frame_slider = QSpinBox()
        self.frame_slider.setPrefix("帧 ")
        self.frame_slider.valueChanged.connect(self._jump_frame)
        self.lbl_time = QLabel("--")
        tl.addWidget(self.btn_play)
        tl.addWidget(self.frame_slider)
        tl.addWidget(self.lbl_time)
        form_wrap.addWidget(transport)

        slit_box = QGroupBox("竖缝设置")
        form = QFormLayout(slit_box)
        self.spin_width = QSpinBox()
        self.spin_width.setRange(1, 4096)
        self.spin_width.setValue(16)
        self.spin_start = QDoubleSpinBox()
        self.spin_start.setRange(-4096, 8192)
        self.spin_start.setValue(80)
        self.spin_end = QDoubleSpinBox()
        self.spin_end.setRange(-4096, 8192)
        self.spin_end.setValue(80)
        for sp in (self.spin_width, self.spin_start, self.spin_end):
            sp.valueChanged.connect(self._schedule_rebuild)
        form.addRow("缝宽 (px)", self.spin_width)
        form.addRow("起点中心 x", self.spin_start)
        form.addRow("终点中心 x", self.spin_end)

        btn_row = QHBoxLayout()
        b_set_start = QPushButton("用当前帧设起点")
        b_set_end = QPushButton("用当前帧设终点")
        b_set_start.clicked.connect(lambda: self._set_center_endpoint("start"))
        b_set_end.clicked.connect(lambda: self._set_center_endpoint("end"))
        btn_row.addWidget(b_set_start)
        btn_row.addWidget(b_set_end)
        form.addRow(btn_row)

        self.combo_pad = QComboBox()
        for label, value in PAD_LABELS:
            self.combo_pad.addItem(label, value)
        self.combo_pad.currentIndexChanged.connect(self._schedule_rebuild)
        form.addRow("贴边补边", self.combo_pad)
        form_wrap.addWidget(slit_box)

        range_box = QGroupBox("时间范围 / 跳过区间")
        rl = QFormLayout(range_box)
        self.spin_trim0 = QDoubleSpinBox()
        self.spin_trim1 = QDoubleSpinBox()
        for sp in (self.spin_trim0, self.spin_trim1):
            sp.setDecimals(3)
            sp.setRange(0, 10**6)
            sp.setSuffix(" s")
            sp.valueChanged.connect(self._schedule_rebuild)
        rl.addRow("入点", self.spin_trim0)
        rl.addRow("出点", self.spin_trim1)
        rb = QHBoxLayout()
        b_in = QPushButton("入点=当前")
        b_out = QPushButton("出点=当前")
        b_in.clicked.connect(lambda: self._set_trim(0))
        b_out.clicked.connect(lambda: self._set_trim(1))
        rb.addWidget(b_in)
        rb.addWidget(b_out)
        rl.addRow(rb)
        self.skip_list = QListWidget()
        self.skip_list.setMaximumHeight(70)
        rl.addRow("已跳过", self.skip_list)
        sb = QHBoxLayout()
        b_skip = QPushButton("把入/出点加入跳过")
        b_skip_del = QPushButton("删除选中")
        b_skip_clear = QPushButton("清空")
        b_skip.clicked.connect(self._add_skip)
        b_skip_del.clicked.connect(
            lambda: (self.skip_list.takeItem(self.skip_list.currentRow()),
                     self._schedule_rebuild()))
        b_skip_clear.clicked.connect(
            lambda: (self.skip_list.clear(), self._schedule_rebuild()))
        sb.addWidget(b_skip)
        sb.addWidget(b_skip_del)
        sb.addWidget(b_skip_clear)
        rl.addRow(sb)
        form_wrap.addWidget(range_box)

        lay_box = QGroupBox("输出布局")
        ll = QFormLayout(lay_box)
        self.combo_layout = QComboBox()
        self.combo_layout.addItem("每帧挨着排 (frame)", "frame")
        self.combo_layout.addItem("固定时间间隔 (interval)", "interval")
        self.combo_layout.currentIndexChanged.connect(self._schedule_rebuild)
        self.spin_interval = QDoubleSpinBox()
        self.spin_interval.setRange(0.001, 60)
        self.spin_interval.setDecimals(3)
        self.spin_interval.setValue(0.1)
        self.spin_interval.setSuffix(" s")
        self.spin_interval.valueChanged.connect(self._schedule_rebuild)
        ll.addRow("模式", self.combo_layout)
        ll.addRow("间隔", self.spin_interval)
        self.spin_page = QSpinBox()
        self.spin_page.setRange(64, 100000)
        self.spin_page.setValue(8000)
        self.spin_page.valueChanged.connect(self._schedule_rebuild)
        ll.addRow("单页最大宽", self.spin_page)
        btn_compare = QPushButton("对照两种布局（各建一个标签页）")
        btn_compare.clicked.connect(self._compare_layouts)
        ll.addRow(btn_compare)
        form_wrap.addWidget(lay_box)

        btn_find = QPushButton("从当前帧定位到长图")
        btn_find.clicked.connect(self._find_current_in_output)
        form_wrap.addWidget(btn_find)
        form_wrap.addStretch(1)
        lay.addWidget(side, 1)
        return box

    def _build_output_panel(self) -> QWidget:
        box = QWidget()
        lay = QVBoxLayout(box)
        top = QHBoxLayout()
        self.zoom_spin = QDoubleSpinBox()
        self.zoom_spin.setRange(0.1, 8.0)
        self.zoom_spin.setSingleStep(0.1)
        self.zoom_spin.setValue(1.0)
        self.zoom_spin.valueChanged.connect(self._apply_zoom)
        top.addWidget(QLabel("缩放"))
        top.addWidget(self.zoom_spin)
        self.lbl_mapping = QLabel("点击长图中的列 → 回到原片对应帧与切缝")
        top.addWidget(self.lbl_mapping, 1)
        lay.addLayout(top)

        self.tabs = QTabWidget()
        self._tab_scrolls: dict[str, QScrollArea] = {}
        self.tabs.currentChanged.connect(lambda _: self._refresh_mapping_label())
        lay.addWidget(self.tabs)
        return box

    def _build_menu(self) -> None:
        m_file = self.menuBar().addMenu("文件")
        act_open = QAction("打开视频…", self)
        act_open.triggered.connect(self._open_video)
        m_file.addAction(act_open)
        act_save = QAction("保存 PNG + 清单…", self)
        act_save.triggered.connect(self._save)
        m_file.addAction(act_save)
        act_verify = QAction("运行本地校验…", self)
        act_verify.triggered.connect(self._run_verify)
        m_file.addAction(act_verify)
        m_file.addSeparator()
        act_quit = QAction("退出", self)
        act_quit.triggered.connect(self.close)
        m_file.addAction(act_quit)

        m_sample = self.menuBar().addMenu("内置样片")
        for pat in PATTERNS:
            act = QAction(pat, self)
            act.triggered.connect(lambda checked=False, p=pat: self._make_sample(p))
            m_sample.addAction(act)

    # -- video loading ----------------------------------------------------- #
    def _set_controls_enabled(self, on: bool) -> None:
        for w in self.centralWidget().findChildren(QWidget):
            if w is not self.preview:
                w.setEnabled(on)

    def _open_video(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择视频", "", "视频 (*.mp4 *.mov *.mkv *.avi *.webm);;所有文件 (*)")
        if path:
            self._load(path)

    def _make_sample(self, pattern: str) -> None:
        out = Path(tempfile.gettempdir()) / f"slitscan_sample_{pattern}.mp4"
        try:
            QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
            generate(pattern, str(out))
        except Exception as exc:
            QApplication.restoreOverrideCursor()
            QMessageBox.critical(self, "样片生成失败", str(exc))
            return
        finally:
            QApplication.restoreOverrideCursor()
        self._load(str(out))

    def _load(self, path: str) -> None:
        self.statusBar().showMessage(f"解码中：{path}")
        self._thread = QThread(self)
        self._worker = DecodeWorker(path)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.run)
        self._worker.finished.connect(self._on_decoded)
        self._worker.failed.connect(self._on_decode_failed)
        self._worker.finished.connect(self._thread.quit)
        self._worker.failed.connect(self._thread.quit)
        self._thread.start()

    def _on_decoded(self, frames: np.ndarray, ts: np.ndarray,
                    info: VideoInfo) -> None:
        self.frames, self.timestamps, self.info = frames, ts, info
        self.current_idx = 0
        self.results.clear()
        while self.tabs.count():
            self.tabs.removeTab(0)
        self.frame_slider.blockSignals(True)
        self.frame_slider.setRange(0, len(ts) - 1)
        self.frame_slider.setValue(0)
        self.frame_slider.blockSignals(False)
        self.spin_trim0.setMaximum(info.duration)
        self.spin_trim1.setMaximum(info.duration)
        self.spin_trim0.setValue(0.0)
        self.spin_trim1.setValue(float(ts[-1]))
        self.spin_start.setValue(info.width / 2)
        self.spin_end.setValue(info.width / 2)
        self.spin_width.setValue(min(16, info.width))
        self._set_controls_enabled(True)
        self._show_current_frame()
        self.statusBar().showMessage(
            f"已加载 {info.path}  {info.width}x{info.height}  "
            f"{len(ts)} 帧  "
            f"{'VFR 不均匀帧时间' if info.is_vfr else 'CFR 恒定帧时间'}")
        self.rebuild()

    def _on_decode_failed(self, msg: str) -> None:
        self.statusBar().showMessage("解码失败")
        QMessageBox.critical(self, "无法打开视频", msg)

    # -- playback ---------------------------------------------------------- #
    def _toggle_play(self) -> None:
        if self._play_timer.isActive():
            self._play_timer.stop()
        else:
            self._play_clock = float(self.timestamps[self.current_idx])
            self._play_timer.start()

    def _tick_playback(self) -> None:
        self._play_clock += 0.03
        ts = self.timestamps
        idx = int(np.searchsorted(ts, self._play_clock, side="right")) - 1
        idx = max(0, min(idx, len(ts) - 1))
        if idx != self.current_idx:
            self.frame_slider.setValue(idx)
        if self._play_clock >= float(ts[-1]):
            self._play_timer.stop()

    def _jump_frame(self, idx: int) -> None:
        if self.frames is None or idx == self.current_idx:
            return
        self.current_idx = idx
        self._show_current_frame()

    def _show_current_frame(self) -> None:
        if self.frames is None:
            return
        self.preview.set_frame(self.frames[self.current_idx])
        t = float(self.timestamps[self.current_idx])
        self.lbl_time.setText(f"t = {t:.3f} s")
        self._update_preview_slit()

    def _current_config(self) -> SlitConfig:
        skips = []
        for i in range(self.skip_list.count()):
            skips.append(self.skip_list.item(i).data(Qt.ItemDataRole.UserRole))
        cfg = SlitConfig(
            width=int(self.spin_width.value()),
            start_center=float(self.spin_start.value()),
            end_center=float(self.spin_end.value()),
            padding=self.combo_pad.currentData(),
            trim_start=float(self.spin_trim0.value()),
            trim_end=float(self.spin_trim1.value()),
            skip_intervals=skips,
            layout=self.combo_layout.currentData(),
            interval=float(self.spin_interval.value()),
            max_page_width=int(self.spin_page.value()),
        )
        cfg.clamp_width(self.info.width)
        return cfg

    def _update_preview_slit(self) -> None:
        if self.frames is None:
            return
        cfg = self._current_config()
        t = float(self.timestamps[self.current_idx])
        t0 = cfg.trim_start if cfg.trim_start is not None else 0.0
        t1 = cfg.trim_end if cfg.trim_end is not None else float(self.timestamps[-1])
        center = slit_center_at(t, t0, t1,
                                cfg.start_center, cfg.end_center)
        left = slit_left_for_center(center, cfg.width)
        self.preview.set_slit(left, cfg.width, cfg.padding)

    def _on_slit_dragged(self) -> None:
        # dragging defines a static slit; endpoints can be keyed separately
        center = self.preview.slit_left + self.preview.slit_width / 2
        self.spin_width.blockSignals(True)
        self.spin_start.blockSignals(True)
        self.spin_end.blockSignals(True)
        self.spin_width.setValue(self.preview.slit_width)
        self.spin_start.setValue(center)
        self.spin_end.setValue(center)
        self.spin_width.blockSignals(False)
        self.spin_start.blockSignals(False)
        self.spin_end.blockSignals(False)
        self._schedule_rebuild()

    def _set_center_endpoint(self, which: str) -> None:
        center = self.preview.slit_left + self.preview.slit_width / 2
        (self.spin_start if which == "start" else self.spin_end).setValue(center)
        self._schedule_rebuild()

    def _set_trim(self, which: str) -> None:
        t = float(self.timestamps[self.current_idx])
        (self.spin_trim0 if which == 0 else self.spin_trim1).setValue(t)

    def _add_skip(self) -> None:
        a, b = float(self.spin_trim0.value()), float(self.spin_trim1.value())
        if b <= a:
            QMessageBox.warning(self, "跳过区间", "出点必须晚于入点")
            return
        from PySide6.QtCore import Qt as _Qt
        item = QListWidgetItem(f"[{a:.3f}, {b:.3f}) s")
        item.setData(_Qt.ItemDataRole.UserRole, (a, b))
        self.skip_list.addItem(item)
        self._schedule_rebuild()

    # -- build ------------------------------------------------------------- #
    def _schedule_rebuild(self, *_) -> None:
        if self.frames is not None:
            self._update_preview_slit()
            self._build_timer.start(250)

    def rebuild(self, layout: str | None = None,
                tab_title: str | None = None) -> BuildResult | None:
        if self.frames is None:
            return None
        cfg = self._current_config()
        if layout is not None:
            cfg.layout = layout
        try:
            result = build_strip(self.frames, self.timestamps, cfg)
        except ValueError as exc:
            self.statusBar().showMessage(f"未构建：{exc}")
            return None
        title = tab_title or ("逐帧排布" if cfg.layout == "frame"
                              else f"间隔 {cfg.interval:.3f}s")
        # an explicit title means a dedicated, keep-around tab; the untitled
        # live rebuild instead replaces the current working tab in place
        self._put_tab(title, result, dedicated=tab_title is not None)
        problems = verify_pages(result)
        n_pad = sum(1 for b in result.blocks if not block_has_real_pixels(b))
        self.statusBar().showMessage(
            f"已构建 {title}：{result.total_width} 列 / "
            f"{len(result.pages)} 页，{len(result.blocks)} 个时刻，"
            f"无原片像素的块 {n_pad} 个"
            + ("；结构校验异常!" if problems else "；结构校验通过"))
        return result

    def _put_tab(self, title: str, result: BuildResult,
                 dedicated: bool = False) -> None:
        view = StripView()
        view.set_zoom(float(self.zoom_spin.value()))
        view.set_result(result)
        view.blockClicked.connect(self._on_block_clicked)
        scroll = QScrollArea()
        scroll.setWidget(view)
        scroll.setWidgetResizable(False)
        self._tab_scrolls[title] = scroll
        if dedicated:
            self.tabs.addTab(scroll, title)
        else:
            # replace whatever tab is currently shown (live rebuild)
            idx = self.tabs.currentIndex()
            if idx < 0:
                self.tabs.addTab(scroll, title)
            else:
                old = self.tabs.widget(idx)
                self.tabs.removeTab(idx)
                old.deleteLater()
                self.tabs.insertTab(idx, scroll, title)
        self.tabs.setCurrentIndex(self.tabs.indexOf(scroll))
        self.results[title] = result

    def _compare_layouts(self) -> None:
        self.rebuild(layout="frame", tab_title="对照A: 逐帧")
        self.rebuild(layout="interval",
                     tab_title=f"对照B: 间隔{float(self.spin_interval.value()):.3f}s")

    def _apply_zoom(self) -> None:
        for i in range(self.tabs.count()):
            scroll = self.tabs.widget(i)
            if isinstance(scroll, QScrollArea) and isinstance(scroll.widget(), StripView):
                scroll.widget().set_zoom(float(self.zoom_spin.value()))

    # -- backlinks --------------------------------------------------------- #
    def _current_view(self) -> StripView | None:
        scroll = self.tabs.currentWidget()
        if isinstance(scroll, QScrollArea) and isinstance(scroll.widget(), StripView):
            return scroll.widget()
        return None

    def _on_block_clicked(self, block: SliceBlock) -> None:
        if block.frame_index < 0:
            self.lbl_mapping.setText(
                f"该列无对应原帧（缺失/重复占位） t={block.t:.3f}s，已在图上标红")
            return
        self.frame_slider.setValue(block.frame_index)
        self._refresh_mapping_label(block)

    def _refresh_mapping_label(self, block: SliceBlock | None = None) -> None:
        view = self._current_view()
        if view is None or view.result is None:
            return
        if block is None:
            block = view.selected
        if block is None:
            self.lbl_mapping.setText("点击长图中的列 → 回到原片对应帧与切缝")
            return
        real = [c for c in block.source_cols if c >= 0]
        if not real:
            self.lbl_mapping.setText(
                f"⚠ 无原片像素: t={block.t:.3f}s 缝左沿={block.slit_left}")
        else:
            self.lbl_mapping.setText(
                f"→ 帧 {block.frame_index}  t={block.t:.3f}s  "
                f"缝左沿={block.slit_left}  源列 {min(real)}..{max(real)}"
                f"{'  (含补边列)' if block.synthetic else ''}")

    def _find_current_in_output(self) -> None:
        view = self._current_view()
        if view is None or view.result is None:
            return
        block = frame_to_block(view.result.blocks, self.current_idx)
        if block is None:
            QMessageBox.information(
                self, "定位",
                "当前帧落在入/出点之外或跳过区间内，长图中没有对应段。")
            return
        view.select_block(block)
        scroll = self.tabs.currentWidget()
        if isinstance(scroll, QScrollArea):
            x = int(block.global_x0 * view.zoom)
            scroll.ensureVisible(x, 0)
        self._refresh_mapping_label(block)

    # -- save / verify ----------------------------------------------------- #
    def _save(self) -> None:
        view = self._current_view()
        if view is None or view.result is None:
            QMessageBox.warning(self, "保存", "还没有可保存的长图")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "保存长图", "strip.png", "PNG (*.png)")
        if not path:
            return
        try:
            pages, manifest = save_result(view.result, self.info.path, path)
        except Exception as exc:
            QMessageBox.critical(self, "保存失败", str(exc))
            return
        QMessageBox.information(
            self, "已保存",
            "PNG 页面:\n" + "\n".join(str(p) for p in pages)
            + f"\n清单: {manifest}")

    def _run_verify(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择清单", "", "manifest (*.manifest.json);;JSON (*.json)")
        if not path:
            return
        try:
            repo_root = str(Path(__file__).resolve().parents[1])
            proc = subprocess.run(
                [sys.executable, "-m", "slitscan.cli", "verify", path,
                 "--check-ids"],
                capture_output=True, text=True, timeout=300, cwd=repo_root)
            out = proc.stdout + proc.stderr
        except Exception as exc:
            QMessageBox.critical(self, "校验失败", str(exc))
            return
        QMessageBox.information(
            self, "本地校验结果",
            ("退出码 0 — 全部通过\n\n" if proc.returncode == 0
             else "发现问题：\n\n") + out)


def run() -> int:
    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(run())
