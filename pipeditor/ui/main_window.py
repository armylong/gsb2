"""主窗口: 画布、时间轴、关键帧列表同屏可见。"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QAbstractItemView,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSlider,
    QSpinBox,
    QSplitter,
    QStatusBar,
    QVBoxLayout,
    QWidget,
)

from ..exporter import export_mp4
from ..media import VideoInfo, build_project, probe
from ..model import Keyframe, Project
from .canvas import CanvasView
from .frame_cache import FrameCache


def _overlay_scaled_size(ov: VideoInfo, width: int) -> tuple[int, int]:
    """按原比例由固定宽度算高度。"""

    height = max(1, round(ov.height * width / ov.width))
    return width, height


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("画中画位置关键帧编辑器")
        self.resize(1500, 900)

        self.bg_info: VideoInfo | None = None
        self.ov_info: VideoInfo | None = None
        self.project: Project | None = None
        self.bg_cache: FrameCache | None = None
        self.ov_cache: FrameCache | None = None
        self.current_frame = 0
        self._exporting = False

        self._build_actions()
        self._build_ui()

        # 播放定时器: 按背景帧间隔推进, 与帧号严格对应。
        self._play_timer = QTimer(self)
        self._play_timer.timeout.connect(self._playback_tick)
        self._playing = False

    # -------------------------------------------------------------- ui build
    def _build_actions(self) -> None:
        bar = self.menuBar()
        file_menu = bar.addMenu("文件")

        self.act_open_bg = QAction("导入背景视频…", self)
        self.act_open_bg.triggered.connect(self.open_background)
        file_menu.addAction(self.act_open_bg)

        self.act_open_ov = QAction("导入叠加视频…", self)
        self.act_open_ov.triggered.connect(self.open_overlay)
        file_menu.addAction(self.act_open_ov)

        self.act_import_kf = QAction("导入关键帧 JSON(样例)…", self)
        self.act_import_kf.triggered.connect(self.import_keyframes_json)
        file_menu.addAction(self.act_import_kf)

        file_menu.addSeparator()
        self.act_export = QAction("导出 MP4…", self)
        self.act_export.triggered.connect(self.export)
        self.act_export.setEnabled(False)
        file_menu.addAction(self.act_export)

        file_menu.addSeparator()
        act_quit = QAction("退出", self)
        act_quit.triggered.connect(self.close)
        file_menu.addAction(act_quit)

    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # 左: 画布 + 时间轴
        left = QWidget()
        left_layout = QVBoxLayout(left)
        self.canvas = CanvasView()
        self.canvas.position_committed.connect(self.on_position_committed)
        self.canvas.position_dragging.connect(self.on_position_dragging)
        left_layout.addWidget(self.canvas, stretch=1)
        left_layout.addWidget(self._build_timeline())
        splitter.addWidget(left)

        # 右: 参数与关键帧列表
        splitter.addWidget(self._build_side_panel())
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([1080, 420])

        self.setCentralWidget(splitter)
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("先导入背景与叠加视频")

    def _build_timeline(self) -> QWidget:
        box = QGroupBox("时间轴")
        v = QVBoxLayout(box)

        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 0)
        self.slider.valueChanged.connect(self.on_slider_changed)
        v.addWidget(self.slider)

        row = QHBoxLayout()
        self.btn_first = QPushButton("⏮ 首帧")
        self.btn_prev = QPushButton("◀ 上一帧")
        self.btn_play = QPushButton("▶ 播放")
        self.btn_next = QPushButton("下一帧 ▶")
        self.btn_last = QPushButton("末帧 ⏭")
        for btn, slot in (
            (self.btn_first, self.go_first),
            (self.btn_prev, self.go_prev_frame),
            (self.btn_play, self.toggle_play),
            (self.btn_next, self.go_next_frame),
            (self.btn_last, self.go_last),
        ):
            btn.clicked.connect(slot)
            row.addWidget(btn)
        row.addStretch(1)

        self.frame_spin = QSpinBox()
        self.frame_spin.setRange(0, 0)
        self.frame_spin.valueChanged.connect(self.on_frame_spin)
        row.addWidget(QLabel("帧"))
        row.addWidget(self.frame_spin)

        self.time_label = QLabel("0.000 s / 0.000 s")
        row.addWidget(self.time_label)
        v.addLayout(row)
        return box

    def _build_side_panel(self) -> QWidget:
        panel = QWidget()
        v = QVBoxLayout(panel)

        # 素材信息
        info_box = QGroupBox("素材")
        info_form = QFormLayout(info_box)
        self.lbl_bg = QLabel("(未导入) 要求 720p, ≤10s")
        self.lbl_ov = QLabel("(未导入) ≤10s")
        info_form.addRow("背景:", self.lbl_bg)
        info_form.addRow("叠加:", self.lbl_ov)
        v.addWidget(info_box)

        # 固定尺寸
        size_box = QGroupBox("叠加层固定尺寸(保持原比例)")
        size_form = QFormLayout(size_box)
        self.width_spin = QSpinBox()
        self.width_spin.setRange(1, 1280)
        self.width_spin.setValue(320)
        self.width_spin.editingFinished.connect(self.apply_overlay_size)
        self.lbl_size_hint = QLabel("")
        size_form.addRow("宽度(px):", self.width_spin)
        size_form.addRow("实际尺寸:", self.lbl_size_hint)
        v.addWidget(size_box)

        # 当前位置
        pos_box = QGroupBox("当前帧位置(画布左上角像素)")
        pos_form = QFormLayout(pos_box)
        self.spin_x = QSpinBox()
        self.spin_y = QSpinBox()
        for spin in (self.spin_x, self.spin_y):
            spin.setRange(0, 2000)
            spin.editingFinished.connect(self.apply_spin_position)
        pos_form.addRow("x:", self.spin_x)
        pos_form.addRow("y:", self.spin_y)
        v.addWidget(pos_box)

        # 关键帧操作
        kf_box = QGroupBox("位置关键帧(按时间排序)")
        kf_layout = QVBoxLayout(kf_box)
        self.kf_list = QListWidget()
        self.kf_list.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection
        )
        self.kf_list.itemSelectionChanged.connect(self.on_kf_selected)
        kf_layout.addWidget(self.kf_list)

        btn_row = QHBoxLayout()
        self.btn_add_kf = QPushButton("添加/更新本帧")
        self.btn_del_kf = QPushButton("删除选中帧")
        self.btn_add_kf.clicked.connect(self.add_keyframe_current)
        self.btn_del_kf.clicked.connect(self.delete_selected_keyframe)
        btn_row.addWidget(self.btn_add_kf)
        btn_row.addWidget(self.btn_del_kf)
        kf_layout.addLayout(btn_row)
        v.addWidget(kf_box, stretch=1)

        line = QFrame()
        line.setFrameShape(QFrame.Shape.HLine)
        v.addWidget(line)
        self.export_btn = QPushButton("导出 MP4")
        self.export_btn.setEnabled(False)
        self.export_btn.clicked.connect(self.export)
        v.addWidget(self.export_btn)
        return panel

    # ------------------------------------------------------------- open files
    def open_background(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择背景视频", "", "视频文件 (*.mp4 *.mov *.mkv *.avi *.webm)"
        )
        if not path:
            return
        try:
            info = probe(path)
            if (info.width, info.height) != (1280, 720):
                QMessageBox.warning(
                    self, "尺寸不符",
                    f"背景必须是 1280x720, 当前为 {info.width}x{info.height}。"
                )
                return
            if info.duration > 10.05:
                QMessageBox.warning(
                    self, "时长超限", f"背景不得超过 10 秒, 当前 {info.duration:.2f}s。"
                )
                return
        except Exception as exc:
            QMessageBox.critical(self, "探测失败", str(exc))
            return
        self.bg_info = info
        self.lbl_bg.setText(
            f"{Path(path).name}  {info.width}x{info.height}  "
            f"{float(info.fps):g}fps  {info.frame_count}帧  "
            f"{info.duration:.2f}s  音频:{'有' if info.has_audio else '无'}"
        )
        self._maybe_start_project()

    def open_overlay(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择叠加视频", "", "视频文件 (*.mp4 *.mov *.mkv *.avi *.webm)"
        )
        if not path:
            return
        try:
            info = probe(path)
            if info.duration > 10.05:
                QMessageBox.warning(
                    self, "时长超限", f"叠加视频不得超过 10 秒, 当前 {info.duration:.2f}s。"
                )
                return
        except Exception as exc:
            QMessageBox.critical(self, "探测失败", str(exc))
            return
        self.ov_info = info
        self.lbl_ov.setText(
            f"{Path(path).name}  {info.width}x{info.height}  "
            f"{float(info.fps):g}fps  {info.frame_count}帧  "
            f"{info.duration:.2f}s"
        )
        self._maybe_start_project()

    def _maybe_start_project(self) -> None:
        if self.bg_info is None or self.ov_info is None:
            return
        self.stop_play()
        if self.bg_cache:
            self.bg_cache.shutdown()
        if self.ov_cache:
            self.ov_cache.shutdown()

        width = min(self.width_spin.value(), self.bg_info.width)
        ow, oh = _overlay_scaled_size(self.ov_info, width)
        self.project = build_project(self.bg_info, self.ov_info, ow, oh)
        self.current_frame = 0

        # 初始给一个居中的首帧关键帧, 保证"只有一个点全程静止"可用。
        cx = (self.project.canvas_w - ow) // 2
        cy = (self.project.canvas_h - oh) // 2
        self.project.upsert_keyframe(0, cx, cy)

        self.width_spin.blockSignals(True)
        self.width_spin.setRange(1, self.bg_info.width)
        self.width_spin.setValue(ow)
        self.width_spin.blockSignals(False)
        self.lbl_size_hint.setText(f"{ow} × {oh} px")
        self.spin_x.setRange(0, self.project.max_x)
        self.spin_y.setRange(0, self.project.max_y)

        self.slider.setRange(0, self.project.frame_count - 1)
        self.frame_spin.setRange(0, self.project.frame_count - 1)

        self.canvas.set_project(self.project)
        self.bg_cache = FrameCache(self.bg_info)
        self.ov_cache = FrameCache(self.ov_info)
        self.bg_cache.frame_loaded.connect(lambda _i: self.refresh_canvas())
        self.ov_cache.frame_loaded.connect(lambda _i: self.refresh_canvas())
        self.bg_cache.start()
        self.ov_cache.start()

        self.act_export.setEnabled(True)
        self.export_btn.setEnabled(True)
        self.refresh_all()
        self.statusBar().showMessage(
            f"项目就绪: 输出 {self.bg_info.width}x{self.bg_info.height} "
            f"{float(self.bg_info.fps):g}fps {self.project.frame_count}帧"
        )

    # ------------------------------------------------------------- frame nav
    def on_slider_changed(self, value: int) -> None:
        if self.project is None or value == self.current_frame:
            return
        self.set_current_frame(value)

    def on_frame_spin(self, value: int) -> None:
        if self.project is None or value == self.current_frame:
            return
        self.set_current_frame(value)

    def set_current_frame(self, frame: int) -> None:
        self.current_frame = max(0, min(self.project.frame_count - 1, frame))
        for w in (self.slider, self.frame_spin):
            w.blockSignals(True)
            w.setValue(self.current_frame)
            w.blockSignals(False)
        self.refresh_canvas()
        self.refresh_position_editors()
        self.refresh_time_label()
        self._select_kf_row(self.current_frame)

    def refresh_time_label(self) -> None:
        p = self.project
        cur = self.current_frame / float(p.fps)
        total = p.frame_count / float(p.fps)
        self.time_label.setText(f"{cur:6.3f} s / {total:6.3f} s")

    def go_first(self) -> None:
        self.set_current_frame(0)

    def go_last(self) -> None:
        self.set_current_frame(self.project.frame_count - 1)

    def go_prev_frame(self) -> None:
        self.set_current_frame(self.current_frame - 1)

    def go_next_frame(self) -> None:
        self.set_current_frame(self.current_frame + 1)

    def toggle_play(self) -> None:
        if self._playing:
            self.stop_play()
        else:
            self.start_play()

    def start_play(self) -> None:
        if self.project is None:
            return
        if self.current_frame >= self.project.frame_count - 1:
            self.set_current_frame(0)
        self._playing = True
        self.btn_play.setText("⏸ 暂停")
        self._play_timer.start(int(1000 / float(self.project.fps)))

    def stop_play(self) -> None:
        self._playing = False
        self._play_timer.stop()
        self.btn_play.setText("▶ 播放")

    def _playback_tick(self) -> None:
        if self.project is None:
            return
        nxt = self.current_frame + 1
        if nxt >= self.project.frame_count:
            self.stop_play()
            return
        self.set_current_frame(nxt)

    # ------------------------------------------------------------- rendering
    def refresh_canvas(self) -> None:
        if self.project is None or self.bg_cache is None:
            return
        bg = self.bg_cache.frame_numpy(self.current_frame)
        if bg is None:
            return  # 该帧尚未解码完, frame_loaded 信号会再触发
        ov = None
        if self.ov_cache is not None and self.project.overlay_visible(
            self.current_frame
        ):
            ov_src = self.ov_cache.frame_numpy(self.current_frame)
            if ov_src is not None:
                ov = self._resize_overlay(ov_src)
        self.canvas.show_frame(self.current_frame, bg, ov)

    def _resize_overlay(self, ov_src):
        img = Image.fromarray(ov_src).resize(
            (self.project.overlay_w, self.project.overlay_h),
            Image.Resampling.LANCZOS,
        )
        return np.asarray(img, dtype=np.uint8).copy()

    def refresh_position_editors(self) -> None:
        p = self.project
        if not p.keyframes:
            return
        if p.overlay_visible(self.current_frame):
            x, y = p.position_at(self.current_frame)
            self.spin_x.blockSignals(True)
            self.spin_y.blockSignals(True)
            self.spin_x.setValue(x)
            self.spin_y.setValue(y)
            self.spin_x.blockSignals(False)
            self.spin_y.blockSignals(False)
        kf = p.keyframe_at(self.current_frame)
        self.statusBar().showMessage(
            self._frame_status_text()
            + ("  [本帧有关键帧]" if kf else "")
        )

    def _frame_status_text(self) -> str:
        p = self.project
        cur = self.current_frame / float(p.fps)
        if not p.overlay_visible(self.current_frame):
            return (
                f"帧 {self.current_frame} ({cur:.3f}s): 叠加层已结束, "
                f"画面为纯背景(共{p.overlay_frame_count}帧)"
            )
        x, y = p.position_at(self.current_frame)
        return f"帧 {self.current_frame} ({cur:.3f}s): 叠加层左上角=({x}, {y})"

    def refresh_all(self) -> None:
        self.refresh_keyframe_list()
        self.refresh_canvas()
        self.refresh_position_editors()
        self.refresh_time_label()
        self._select_kf_row(self.current_frame)

    # ------------------------------------------------------------- keyframes
    def refresh_keyframe_list(self) -> None:
        self.kf_list.clear()
        p = self.project
        for kf in p.keyframes:
            item = QListWidgetItem(
                f"帧 {kf.frame:3d}  t={kf.time(p.fps):6.3f}s  "
                f"位置=({kf.x}, {kf.y})"
            )
            item.setData(Qt.ItemDataRole.UserRole, kf.frame)
            self.kf_list.addItem(item)

    def _select_kf_row(self, frame: int) -> None:
        for i in range(self.kf_list.count()):
            item = self.kf_list.item(i)
            if item.data(Qt.ItemDataRole.UserRole) == frame:
                self.kf_list.blockSignals(True)
                self.kf_list.setCurrentRow(i)
                self.kf_list.blockSignals(False)
                return
        self.kf_list.blockSignals(True)
        self.kf_list.clearSelection()
        self.kf_list.blockSignals(False)

    def on_kf_selected(self) -> None:
        items = self.kf_list.selectedItems()
        if not items or self.project is None:
            return
        frame = items[0].data(Qt.ItemDataRole.UserRole)
        self.set_current_frame(frame)

    def add_keyframe_current(self) -> None:
        p = self.project
        if p is None:
            return
        if not p.overlay_visible(self.current_frame):
            QMessageBox.information(
                self, "无法添加",
                f"叠加层在第 {self.current_frame} 帧已结束, 不能在该帧定位。"
            )
            return
        x, y = p.position_at(self.current_frame)
        p.upsert_keyframe(self.current_frame, x, y)
        self.refresh_all()

    def delete_selected_keyframe(self) -> None:
        items = self.kf_list.selectedItems()
        if not items:
            return
        frame = items[0].data(Qt.ItemDataRole.UserRole)
        if not self.project.delete_keyframe(frame):
            QMessageBox.information(self, "无法删除", "至少保留一个位置关键帧。")
            return
        self.refresh_all()

    def on_position_committed(self, frame: int, x: int, y: int) -> None:
        """拖松手/方向键: 创建或更新该时刻关键帧(同一时刻只保留一个)。"""

        p = self.project
        if p is None or not p.overlay_visible(frame):
            return
        p.upsert_keyframe(frame, x, y)
        self.refresh_all()

    def on_position_dragging(self, x: int, y: int) -> None:
        self.statusBar().showMessage(f"拖动中: 左上角=({x}, {y})")

    def apply_spin_position(self) -> None:
        p = self.project
        if p is None:
            return
        x, y = self.spin_x.value(), self.spin_y.value()
        if not p.is_in_bounds(x, y):
            QMessageBox.warning(self, "坐标越界", "叠加层必须完整留在画布内。")
            self.refresh_position_editors()
            return
        p.upsert_keyframe(self.current_frame, x, y)
        self.refresh_all()

    # ------------------------------------------------------------- size edit
    def apply_overlay_size(self) -> None:
        p = self.project
        if p is None or self.ov_info is None:
            return
        new_w, new_h = _overlay_scaled_size(self.ov_info, self.width_spin.value())
        bad = p.out_of_bounds_keyframes(new_w, new_h)
        if bad:
            detail = "\n".join(
                f"  帧 {k.frame}: 位置({k.x},{k.y}) 超出新边界 "
                f"x<= {p.canvas_w - new_w}, y<= {p.canvas_h - new_h}"
                for k in bad
            )
            QMessageBox.warning(
                self,
                "尺寸修改被拒绝",
                "新尺寸会让以下关键帧越界, 请先在列表中修正这些点的位置, "
                "不会静默改动已有路径:\n\n" + detail,
            )
            self.width_spin.blockSignals(True)
            self.width_spin.setValue(p.overlay_w)
            self.width_spin.blockSignals(False)
            return
        p.apply_overlay_size(new_w, new_h)
        self.lbl_size_hint.setText(f"{new_w} × {new_h} px")
        self.spin_x.setRange(0, p.max_x)
        self.spin_y.setRange(0, p.max_y)
        self.refresh_all()

    # ------------------------------------------------------------- json import
    def import_keyframes_json(self) -> None:
        if self.project is None:
            QMessageBox.information(self, "提示", "请先导入背景与叠加视频。")
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "选择关键帧 JSON", "", "JSON (*.json)"
        )
        if not path:
            return
        try:
            data = json.loads(Path(path).read_text())
            size = data.get("overlay_size")
            if size:
                w, h = int(size["width"]), int(size["height"])
                if (w, h) != (self.project.overlay_w, self.project.overlay_h):
                    bad = self.project.out_of_bounds_keyframes(w, h)
                    if not bad:
                        self.project.apply_overlay_size(w, h)
                        self.width_spin.blockSignals(True)
                        self.width_spin.setValue(w)
                        self.width_spin.blockSignals(False)
                        self.lbl_size_hint.setText(f"{w} × {h} px")
                        self.spin_x.setRange(0, self.project.max_x)
                        self.spin_y.setRange(0, self.project.max_y)
            frames: list[Keyframe] = []
            for item in data["keyframes"]:
                f, x, y = int(item["frame"]), int(item["x"]), int(item["y"])
                if not (0 <= f < self.project.frame_count):
                    raise ValueError(f"帧号越界: {f}")
                if not self.project.is_in_bounds(x, y):
                    raise ValueError(f"帧 {f} 坐标越界: ({x},{y})")
                frames.append(Keyframe(f, x, y))
        except Exception as exc:
            QMessageBox.critical(self, "导入失败", str(exc))
            return
        self.project.keyframes = sorted(frames, key=lambda k: k.frame)
        self.set_current_frame(0)
        self.refresh_all()
        self.statusBar().showMessage(f"已从 {Path(path).name} 导入关键帧")

    # ----------------------------------------------------------------- export
    def export(self) -> None:
        p = self.project
        if p is None or not p.keyframes:
            QMessageBox.information(self, "无法导出", "至少需要一个关键帧。")
            return
        default_name = str(Path(self.bg_info.path).with_name("pip_output.mp4"))
        path, _ = QFileDialog.getSaveFileName(
            self, "导出 MP4", default_name, "MP4 (*.mp4)"
        )
        if not path:
            return
        self._exporting = True
        self.statusBar().showMessage("导出中…")
        try:
            export_mp4(self.bg_info, self.ov_info, p, path)
        except Exception as exc:
            self._exporting = False
            QMessageBox.critical(self, "导出失败", str(exc))
            self.statusBar().showMessage("导出失败")
            return
        self._exporting = False
        self.statusBar().showMessage(f"已导出: {path}")
        QMessageBox.information(
            self, "导出完成",
            f"输出: {path}\n尺寸/帧率/时长继承背景, 仅含背景音频。",
        )

    # ---------------------------------------------------------------- shutdown
    def closeEvent(self, event) -> None:  # noqa: N802
        self.stop_play()
        if self.bg_cache:
            self.bg_cache.shutdown()
        if self.ov_cache:
            self.ov_cache.shutdown()
        super().closeEvent(event)
