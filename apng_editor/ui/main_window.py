"""Main window for the APNG frame compositor."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import QSize, Qt, QTimer
from PySide6.QtGui import QColor, QImage, QPainter, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..exporter import export_apng, verify_export
from ..imaging import TileLoadError, checkerboard, generate_tile, load_rgba_png
from ..model import (
    BLEND_LABELS,
    BLEND_ORDER,
    DISPOSE_LABELS,
    DISPOSE_ORDER,
    MAX_CANVAS,
    MAX_DURATION_MS,
    MAX_FRAMES,
    MAX_LOOP_COUNT,
    Frame,
    Project,
    ValidationError,
    compose_project,
)
from ..playback import PlaybackClock
from ..samples import SAMPLES, sample_alpha_overlap
from .canvas_view import CanvasPreview, qimage_from_rgba, qimage_from_rgba_rgb

THUMB_SIZE = 56


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("APNG 逐帧合成小工具")
        self.resize(1280, 860)

        self.project = sample_alpha_overlap()
        self.selected = 0
        self.displayed: list[np.ndarray] = []
        self._syncing = False
        self._last_export: Path | None = None  # 最近一次成功导出的文件

        self.clock = PlaybackClock(
            durations_ms=[f.duration_ms for f in self.project.frames],
            loop_count=self.project.loop_count,
        )
        self.timer = QTimer(self)
        self.timer.setInterval(15)
        self.timer.timeout.connect(self._on_tick)

        self._build_ui()
        self._load_project(self.project, keep_selection=False)
        self._show_frame(0)

    # ----------------------------------------------------------------- UI
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        outer = QVBoxLayout(central)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        outer.addWidget(splitter, 1)

        splitter.addWidget(self._build_timeline_panel())
        splitter.addWidget(self._build_right_panel())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([300, 960])

        self.warning_label = QLabel()
        self.warning_label.setWordWrap(True)
        self.warning_label.setStyleSheet(
            "padding:6px; border-radius:4px; background:#4a2020; color:#ffd7d7;"
        )
        self.warning_label.hide()
        outer.addWidget(self.warning_label)

        self.status_label = QLabel("就绪")
        self.status_label.setStyleSheet("color:#9aa0a6;")
        outer.addWidget(self.status_label)

    def _build_timeline_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)

        header = QLabel("帧时间线（最多 20 帧）")
        header.setStyleSheet("font-weight:bold;")
        layout.addWidget(header)

        self.frame_list = QListWidget()
        self.frame_list.setIconSize(QSize(THUMB_SIZE, THUMB_SIZE))
        self.frame_list.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection
        )
        self.frame_list.currentRowChanged.connect(self._on_selection_changed)
        layout.addWidget(self.frame_list, 1)

        grid = QGridLayout()
        self.btn_add = QPushButton("生成图块…")
        self.btn_import = QPushButton("导入 PNG…")
        self.btn_duplicate = QPushButton("复制所选")
        self.btn_up = QPushButton("上移")
        self.btn_down = QPushButton("下移")
        self.btn_remove = QPushButton("移除所选")
        self.btn_add.clicked.connect(self._add_generated)
        self.btn_import.clicked.connect(self._import_tile)
        self.btn_duplicate.clicked.connect(self._duplicate_frame)
        self.btn_up.clicked.connect(lambda: self._move_selected(-1))
        self.btn_down.clicked.connect(lambda: self._move_selected(1))
        self.btn_remove.clicked.connect(self._remove_selected)
        grid.addWidget(self.btn_add, 0, 0)
        grid.addWidget(self.btn_import, 0, 1)
        grid.addWidget(self.btn_duplicate, 1, 0)
        grid.addWidget(self.btn_remove, 1, 1)
        grid.addWidget(self.btn_up, 2, 0)
        grid.addWidget(self.btn_down, 2, 1)
        layout.addLayout(grid)
        return panel

    def _build_right_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)

        previews = QHBoxLayout()
        self.tile_preview = CanvasPreview()
        self.placement_preview = CanvasPreview()
        self.composite_preview = CanvasPreview()
        for title, widget, tip in (
            ("原始图块", self.tile_preview, "所选帧的图块本身，棋盘格表示透明"),
            (
                "位置边界",
                self.placement_preview,
                "图块在画布中的位置；红框内为图块覆盖区域",
            ),
            (
                "完整合成画面",
                self.composite_preview,
                "从第 1 帧逐帧合成到当前帧得到的画面",
            ),
        ):
            box = QGroupBox(title)
            box_layout = QVBoxLayout(box)
            box_layout.addWidget(widget)
            widget.setToolTip(tip)
            previews.addWidget(box, 1)
        layout.addLayout(previews, 1)

        controls = QHBoxLayout()
        controls.addWidget(self._build_frame_settings(), 2)
        controls.addWidget(self._build_project_settings(), 1)
        layout.addLayout(controls)

        layout.addWidget(self._build_playback_bar())
        return panel

    def _build_frame_settings(self) -> QWidget:
        box = QGroupBox("所选帧")
        form = QFormLayout(box)

        self.frame_index_label = QLabel("-")
        self.frame_index_label.setStyleSheet("font-weight:bold;")
        form.addRow("当前帧", self.frame_index_label)

        self.spin_x = QSpinBox()
        self.spin_x.setRange(-MAX_CANVAS, MAX_CANVAS * 2)
        self.spin_x.valueChanged.connect(self._apply_position)
        self.spin_y = QSpinBox()
        self.spin_y.setRange(-MAX_CANVAS, MAX_CANVAS * 2)
        self.spin_y.valueChanged.connect(self._apply_position)
        position_row = QHBoxLayout()
        position_row.addWidget(QLabel("X"))
        position_row.addWidget(self.spin_x)
        position_row.addSpacing(12)
        position_row.addWidget(QLabel("Y"))
        position_row.addWidget(self.spin_y)
        position_row.addStretch(1)
        position_holder = QWidget()
        position_holder.setLayout(position_row)
        position_row.setContentsMargins(0, 0, 0, 0)
        form.addRow("画布内位置", position_holder)

        self.spin_duration = QSpinBox()
        self.spin_duration.setRange(0, MAX_DURATION_MS + 5000)
        self.spin_duration.setSuffix(" ms")
        self.spin_duration.setToolTip("1–65535 毫秒；0 或超过范围会明确报错")
        self.spin_duration.valueChanged.connect(self._apply_duration)
        form.addRow("显示时长", self.spin_duration)

        self.combo_blend = QComboBox()
        for key in BLEND_ORDER:
            self.combo_blend.addItem(BLEND_LABELS[key], key)
        self.combo_blend.currentIndexChanged.connect(self._apply_blend)
        form.addRow("覆盖方式", self.combo_blend)

        self.combo_dispose = QComboBox()
        for key in DISPOSE_ORDER:
            self.combo_dispose.addItem(DISPOSE_LABELS[key], key)
        self.combo_dispose.currentIndexChanged.connect(self._apply_dispose)
        form.addRow("本帧之后", self.combo_dispose)

        self.frame_info_label = QLabel()
        self.frame_info_label.setWordWrap(True)
        self.frame_info_label.setStyleSheet("color:#9aa0a6;")
        form.addRow(self.frame_info_label)
        return box

    def _build_project_settings(self) -> QWidget:
        box = QGroupBox("画布与循环")
        form = QFormLayout(box)

        self.spin_canvas_w = QSpinBox()
        self.spin_canvas_w.setRange(1, MAX_CANVAS)
        self.spin_canvas_h = QSpinBox()
        self.spin_canvas_h.setRange(1, MAX_CANVAS)
        size_row = QHBoxLayout()
        size_row.setContentsMargins(0, 0, 0, 0)
        size_row.addWidget(self.spin_canvas_w)
        size_row.addWidget(QLabel("×"))
        size_row.addWidget(self.spin_canvas_h)
        self.btn_apply_size = QPushButton("应用尺寸")
        self.btn_apply_size.clicked.connect(self._apply_canvas_size)
        size_row.addWidget(self.btn_apply_size)
        holder = QWidget()
        holder.setLayout(size_row)
        form.addRow("画布（≤512）", holder)

        self.spin_loops = QSpinBox()
        self.spin_loops.setRange(0, MAX_LOOP_COUNT)
        self.spin_loops.valueChanged.connect(self._apply_loop_count)
        form.addRow("循环次数", self.spin_loops)
        self.loop_hint = QLabel()
        self.loop_hint.setWordWrap(True)
        self.loop_hint.setStyleSheet("color:#9aa0a6;")
        form.addRow(self.loop_hint)

        self.combo_sample = QComboBox()
        self.combo_sample.addItems(list(SAMPLES.keys()))
        self.btn_load_sample = QPushButton("加载样例")
        self.btn_load_sample.clicked.connect(self._load_selected_sample)
        self.btn_reset = QPushButton("恢复默认样例")
        self.btn_reset.clicked.connect(lambda: self._load_project(sample_alpha_overlap()))
        form.addRow("内置样例", self.combo_sample)
        sample_row = QHBoxLayout()
        sample_row.setContentsMargins(0, 0, 0, 0)
        sample_row.addWidget(self.btn_load_sample)
        sample_row.addWidget(self.btn_reset)
        sample_holder = QWidget()
        sample_holder.setLayout(sample_row)
        form.addRow(sample_holder)

        self.btn_export = QPushButton("导出 APNG 并回读校验…")
        self.btn_export.setStyleSheet("font-weight:bold; padding:6px;")
        self.btn_export.clicked.connect(self._export)
        form.addRow(self.btn_export)
        return box

    def _build_playback_bar(self) -> QWidget:
        box = QGroupBox("播放")
        layout = QHBoxLayout(box)

        self.btn_prev = QPushButton("◀ 上一帧")
        self.btn_play = QPushButton("▶ 播放")
        self.btn_next = QPushButton("下一帧 ▶")
        self.btn_prev.clicked.connect(lambda: self._step(-1))
        self.btn_next.clicked.connect(lambda: self._step(1))
        self.btn_play.clicked.connect(self._toggle_play)
        layout.addWidget(self.btn_prev)
        layout.addWidget(self.btn_play)
        layout.addWidget(self.btn_next)

        self.clock_label = QLabel()
        self.clock_label.setMinimumWidth(260)
        layout.addWidget(self.clock_label, 1)

        self.auto_follow = QCheckBox("播放时跟随所选帧")
        self.auto_follow.setChecked(True)
        self.auto_follow.setToolTip(
            "勾选时播放会更新左侧选择；取消后可边播放边检查其它帧"
        )
        layout.addWidget(self.auto_follow)
        return box

    # ------------------------------------------------------------- helpers
    def _set_warning(self, message: str | None) -> None:
        if message:
            self.warning_label.setText(f"⚠ {message}")
            self.warning_label.show()
        else:
            self.warning_label.hide()

    def _set_status(self, message: str) -> None:
        self.status_label.setText(message)

    def _selected_frame(self) -> Frame | None:
        if 0 <= self.selected < len(self.project.frames):
            return self.project.frames[self.selected]
        return None

    def _update_loop_hint(self) -> None:
        if self.project.loop_count == 0:
            self.loop_hint.setText("0 = 无限循环：播放会一直重复，直到手动暂停")
        else:
            self.loop_hint.setText(
                f"{self.project.loop_count} = 有限循环：完整播放 "
                f"{self.project.loop_count} 遍后停在最后一帧"
            )
            self.loop_hint.setToolTip(self.loop_hint.text())

    # ------------------------------------------------------------ timeline
    def _refresh_frame_list(self) -> None:
        previous = self.selected
        self._syncing = True
        self.frame_list.clear()
        for index, frame in enumerate(self.project.frames):
            item = QListWidgetItem()
            item.setSizeHint(QSize(0, THUMB_SIZE + 12))
            item.setIcon(self._thumbnail(frame))
            blend = BLEND_LABELS[frame.blend]
            dispose = DISPOSE_LABELS[frame.dispose]
            item.setText(
                f"{index + 1}. {frame.name} · {frame.duration_ms} ms\n"
                f"({frame.x}, {frame.y}) · {blend} · 之后{dispose}"
            )
            item.setToolTip(
                f"图块 {frame.width}×{frame.height}，画布内位置 "
                f"({frame.x}, {frame.y})，显示 {frame.duration_ms} ms\n"
                f"覆盖方式：{blend}\n处置方式：{dispose}"
            )
            self.frame_list.addItem(item)
        if self.project.frames:
            self.selected = max(0, min(previous, len(self.project.frames) - 1))
            self.frame_list.setCurrentRow(self.selected)
        else:
            self.selected = 0
        self._syncing = False

    def _thumbnail(self, frame: Frame) -> QPixmap:
        image = qimage_from_rgba(frame.tile)
        scaled = image.scaled(
            THUMB_SIZE,
            THUMB_SIZE,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.FastTransformation,
        )
        canvas = QImage(THUMB_SIZE, THUMB_SIZE, QImage.Format.Format_ARGB32)
        canvas.fill(QColor(70, 70, 74))
        painter = QPainter(canvas)
        board = checkerboard(THUMB_SIZE, THUMB_SIZE, cell=8, light=205, dark=165)
        painter.drawImage(0, 0, qimage_from_rgba_rgb(board))
        painter.drawImage(
            (THUMB_SIZE - scaled.width()) // 2,
            (THUMB_SIZE - scaled.height()) // 2,
            scaled,
        )
        painter.end()
        return QPixmap.fromImage(canvas)

    # ------------------------------------------------------------- project
    def _load_project(self, project: Project, keep_selection: bool = False) -> None:
        self.timer.stop()
        self.btn_play.setText("▶ 播放")
        self.project = project
        self.selected = self.selected if keep_selection else 0
        self.displayed = []
        self.clock = PlaybackClock(
            durations_ms=[f.duration_ms for f in project.frames],
            loop_count=project.loop_count,
        )
        self._refresh_frame_list()
        self._sync_project_controls()
        self._show_frame(self.selected if self.project.frames else -1)
        self._set_warning(None)
        self._set_status("已加载样例；播放会从第 1 帧开始")

    def _sync_project_controls(self) -> None:
        self._syncing = True
        self.spin_canvas_w.setValue(self.project.canvas_width)
        self.spin_canvas_h.setValue(self.project.canvas_height)
        self.spin_loops.setValue(self.project.loop_count)
        self._syncing = False
        self._update_loop_hint()

    def _sync_frame_controls(self, frame: Frame | None) -> None:
        self._syncing = True
        enabled = frame is not None
        for widget in (
            self.spin_x,
            self.spin_y,
            self.spin_duration,
            self.combo_blend,
            self.combo_dispose,
            self.btn_duplicate,
            self.btn_remove,
            self.btn_up,
            self.btn_down,
        ):
            widget.setEnabled(enabled)
        if frame is not None:
            self.frame_index_label.setText(
                f"第 {self.selected + 1} / {len(self.project.frames)} 帧"
            )
            self.spin_x.setValue(frame.x)
            self.spin_y.setValue(frame.y)
            self.spin_duration.setValue(frame.duration_ms)
            self.combo_blend.setCurrentIndex(BLEND_ORDER.index(frame.blend))
            self.combo_dispose.setCurrentIndex(DISPOSE_ORDER.index(frame.dispose))
            self.frame_info_label.setText(
                f"图块 {frame.width}×{frame.height} 像素；"
                f"覆盖区域 X {frame.x}–{frame.x + frame.width}，"
                f"Y {frame.y}–{frame.y + frame.height}"
            )
        else:
            self.frame_index_label.setText("（无帧）")
            self.frame_info_label.setText("")
        self._syncing = False

    # -------------------------------------------------------- preview sync
    def _sync_clock(self) -> None:
        """Push frame durations/loop count into the playback clock."""

        durations = [f.duration_ms for f in self.project.frames]
        if durations != self.clock.durations_ms:
            self.clock.set_durations(durations)
        self.clock.set_loop_count(self.project.loop_count)

    def _select_row(self, index: int) -> None:
        """Change the list selection without triggering a re-entrant seek."""

        self._syncing = True
        try:
            self.frame_list.setCurrentRow(index)
        finally:
            self._syncing = False

    def _show_frame(self, index: int) -> None:
        self._sync_clock()
        width, height = self.project.canvas_size
        for preview in (self.placement_preview, self.composite_preview):
            preview.set_canvas_size(width, height)

        frame = self.project.frame(index) if 0 <= index < len(self.project.frames) else None
        self.selected = index if frame is not None else -1
        self._sync_frame_controls(frame)

        if frame is None:
            self.displayed = []
            self.tile_preview.set_image(None)
            self.placement_preview.set_image(None)
            self.composite_preview.set_image(None)
            self.placement_preview.set_outline(None)
            self.composite_preview.set_outline(None)
            self._select_row(-1)
            self.clock_label.setText("没有帧")
            return

        # The full sequence is always recomposed from frame 0, so seeking
        # backwards or jumping to a middle frame cannot depend on history.
        self.displayed = compose_project(self.project)
        self.tile_preview.set_canvas_size(frame.width, frame.height)
        self.tile_preview.set_image(frame.tile)
        self.tile_preview.set_outline(None)

        # Placement view: show the tile in place on an empty canvas.
        placement = np.zeros((height, width, 4), dtype=np.uint8)
        placement[
            frame.y : frame.y + frame.height, frame.x : frame.x + frame.width
        ] = frame.tile
        self.placement_preview.set_image(placement)
        self.placement_preview.set_outline(
            (frame.x, frame.y, frame.x + frame.width, frame.y + frame.height),
            f"({frame.x}, {frame.y})",
        )

        self.composite_preview.set_image(self.displayed[index])
        self.composite_preview.set_outline(
            (frame.x, frame.y, frame.x + frame.width, frame.y + frame.height)
        )
        self._select_row(index)
        self._update_playback_labels()

    def _update_playback_labels(self) -> None:
        if not self.project.frames:
            self.clock_label.setText("没有帧")
            return
        shown = self.selected
        if self.clock.playing and not self.auto_follow.isChecked():
            shown = self.clock.index
        shown = max(0, min(shown, len(self.project.frames) - 1))
        frame = self.project.frames[shown]
        state = "播放中" if self.clock.playing else "已暂停"
        if self.clock.finished and self.clock.loop_count != 0:
            state = "播放结束"
        self.clock_label.setText(
            f"{state} · 第 {shown + 1}/{len(self.project.frames)} 帧 · "
            f"{frame.duration_ms} ms · {self.clock.cycle_label()}"
        )

    # -------------------------------------------------------- modifications
    def _commit(self, action: str) -> None:
        """Re-compose everything, refresh previews and the frame list."""

        index = self.selected
        try:
            self.project.validate()
        except ValidationError as exc:
            self._set_warning(str(exc))
            return
        self._refresh_frame_list()
        self._show_frame(index)
        self._set_warning(None)
        self._set_status(action)

    def _on_selection_changed(self, row: int) -> None:
        if self._syncing or row < 0:
            return
        self.timer.stop()
        was_playing = self.clock.playing
        self.clock.playing = False
        self.clock.finished = False
        self.btn_play.setText("▶ 播放")
        self._show_frame(row)
        if was_playing:
            self._set_status("浏览其它帧时播放已暂停")
        else:
            self._set_status(
                f"查看第 {row + 1} 帧；合成画面由第 1 帧逐帧计算到此处，与浏览顺序无关"
            )

    def _step(self, delta: int) -> None:
        if not self.project.frames:
            return
        self.timer.stop()
        self.clock.playing = False
        self.btn_play.setText("▶ 播放")
        target = max(0, min(len(self.project.frames) - 1, self.selected + delta))
        self.clock.step(target - self.clock.index)
        self._show_frame(target)
        self._set_status(f"逐帧：第 {target + 1} 帧")

    def _apply_position(self) -> None:
        if self._syncing:
            return
        frame = self._selected_frame()
        if frame is None:
            return
        x, y = self.spin_x.value(), self.spin_y.value()
        try:
            self.project.update_frame(self.selected, x=x, y=y)
        except ValidationError as exc:
            self._set_warning(f"{exc}。位置已恢复为 ({frame.x}, {frame.y})")
            self._sync_frame_controls(frame)
            return
        self._commit(f"第 {self.selected + 1} 帧位置更新为 ({x}, {y})")

    def _apply_duration(self) -> None:
        if self._syncing:
            return
        frame = self._selected_frame()
        if frame is None:
            return
        duration = self.spin_duration.value()
        try:
            self.project.update_frame(self.selected, duration_ms=duration)
        except ValidationError as exc:
            self._set_warning(f"{exc}。时长已恢复为 {frame.duration_ms} ms")
            self._sync_frame_controls(frame)
            return
        self._commit(f"第 {self.selected + 1} 帧显示时长设为 {duration} ms")

    def _apply_blend(self) -> None:
        if self._syncing:
            return
        frame = self._selected_frame()
        if frame is None:
            return
        blend = self.combo_blend.currentData()
        try:
            self.project.update_frame(self.selected, blend=blend)
        except ValidationError as exc:
            self._set_warning(str(exc))
            self._sync_frame_controls(frame)
            return
        self._commit(f"第 {self.selected + 1} 帧覆盖方式：{BLEND_LABELS[blend]}")

    def _apply_dispose(self) -> None:
        if self._syncing:
            return
        frame = self._selected_frame()
        if frame is None:
            return
        dispose = self.combo_dispose.currentData()
        try:
            self.project.update_frame(self.selected, dispose=dispose)
        except ValidationError as exc:
            self._set_warning(str(exc))
            self._sync_frame_controls(frame)
            return
        self._commit(f"第 {self.selected + 1} 帧处置方式：{DISPOSE_LABELS[dispose]}")

    def _apply_canvas_size(self) -> None:
        width = self.spin_canvas_w.value()
        height = self.spin_canvas_h.value()
        try:
            self.project.set_canvas_size(width, height)
        except ValidationError as exc:
            self._set_warning(f"{exc}。画布保持 {self.project.canvas_width}×{self.project.canvas_height}")
            self._sync_project_controls()
            return
        self._refresh_frame_list()
        self._show_frame(self.selected)
        self._set_warning(None)
        self._set_status(f"画布尺寸设为 {width}×{height}")

    def _apply_loop_count(self) -> None:
        if self._syncing:
            return
        try:
            self.project.set_loop_count(self.spin_loops.value())
        except ValidationError as exc:
            self._set_warning(str(exc))
            return
        was_playing = self.clock.playing
        self.clock.set_loop_count(self.project.loop_count)
        self._update_loop_hint()
        if was_playing:
            # Restarting makes the new play count apply to complete passes
            # instead of cutting the current pass short.
            self.clock.start()
            if self.auto_follow.isChecked():
                self._show_frame(0)
        else:
            self._update_playback_labels()
        self._set_warning(None)
        if self.project.loop_count == 0:
            message = "循环次数设为 0：无限循环"
        else:
            message = (
                f"循环次数设为 {self.project.loop_count}：完整播放 "
                f"{self.project.loop_count} 遍后停止"
            )
        if was_playing:
            message += "（播放已从第 1 帧重新开始）"
        self._set_status(message)

    # -------------------------------------------------------------- frames
    def _add_generated(self) -> None:
        from PySide6.QtWidgets import QInputDialog

        max_side = max(self.project.canvas_size)
        if max_side < 8:
            self._set_warning(
                f"画布最大边只有 {max_side} 像素，无法放入生成的图块；请先放大画布"
            )
            return
        default = min(48, max_side)
        size, ok = QInputDialog.getInt(
            self, "生成图块", "图块边长（像素）：", default, 8, min(256, max_side), 4
        )
        if not ok:
            return
        tile, name = generate_tile(len(self.project.frames), size)
        self._add_frame(tile, name)

    def _import_tile(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "导入 PNG 作为图块", "", "PNG 图片 (*.png)"
        )
        if not path:
            return
        try:
            tile = load_rgba_png(path)
        except TileLoadError as exc:
            self._set_warning(str(exc))
            return
        self._add_frame(tile, Path(path).stem)

    def _add_frame(self, tile: np.ndarray, name: str) -> None:
        if len(self.project.frames) >= MAX_FRAMES:
            self._set_warning(
                f"帧数量已达上限：最多 {MAX_FRAMES} 帧，无法继续添加"
            )
            return
        max_x = self.project.canvas_width - tile.shape[1]
        max_y = self.project.canvas_height - tile.shape[0]
        if max_x < 0 or max_y < 0:
            self._set_warning(
                f"图块 {tile.shape[1]}×{tile.shape[0]} 超出画布 "
                f"{self.project.canvas_width}×{self.project.canvas_height}，请先调整画布"
            )
            return
        frame = Frame(
            tile,
            x=min(8, max_x),
            y=min(8, max_y),
            duration_ms=150,
            blend="over",
            dispose="keep",
            name=name,
        )
        try:
            index = self.project.add_frame(frame)
        except ValidationError as exc:
            self._set_warning(str(exc))
            return
        self.selected = index
        self._refresh_frame_list()
        self._show_frame(index)
        self._set_warning(None)
        self._set_status(f"已添加第 {index + 1} 帧：{name}")

    def _duplicate_frame(self) -> None:
        frame = self._selected_frame()
        if frame is None:
            return
        try:
            index = self.project.add_frame(frame.clone(), index=self.selected + 1)
        except ValidationError as exc:
            self._set_warning(str(exc))
            return
        self.selected = index
        self._refresh_frame_list()
        self._show_frame(index)
        self._set_status(f"已复制为第 {index + 1} 帧")

    def _remove_selected(self) -> None:
        if not self.project.frames:
            return
        index = self.selected
        remove = self.project.remove_frame(index)
        self.selected = min(index, len(self.project.frames) - 1)
        self._refresh_frame_list()
        self._show_frame(self.selected if self.project.frames else -1)
        self._set_status(f"已移除原第 {index + 1} 帧（{remove.name}）")
        self._set_warning(None)

    def _move_selected(self, delta: int) -> None:
        if not self.project.frames:
            return
        try:
            new_index = self.project.move_frame(self.selected, delta)
        except ValidationError as exc:
            self._set_warning(str(exc))
            return
        self.selected = new_index
        self._refresh_frame_list()
        self._show_frame(new_index)
        self._set_status(f"帧顺序调整：当前位于第 {new_index + 1} 位")
        self._set_warning(None)

    def _load_selected_sample(self) -> None:
        key = self.combo_sample.currentText()
        factory = SAMPLES.get(key)
        if factory is None:
            return
        self.selected = 0
        self._load_project(factory())
        self._set_status(f"已加载样例：{key}")

    # ------------------------------------------------------------ playback
    def _toggle_play(self) -> None:
        if not self.project.frames:
            self._set_warning("没有帧可供播放")
            return
        if self.clock.playing:
            self.clock.pause()
            self.timer.stop()
            self.btn_play.setText("▶ 播放")
            self._set_status("已暂停：画面不再推进，修改帧后合成会立即更新")
            self._update_playback_labels()
            return
        self.clock.start()
        self.timer.start()
        self.btn_play.setText("⏸ 暂停")
        # Playback always starts at frame 0 so a finite loop count means N
        # complete passes.  With "follow" off, keep the inspected frame in
        # the preview and only report the playing frame in the clock label.
        if self.auto_follow.isChecked():
            self._show_frame(0)
        else:
            self._update_playback_labels()
        self._set_status(
            "播放中：每帧按自身时长显示；"
            + ("无限循环" if self.project.loop_count == 0 else f"共 {self.project.loop_count} 遍")
        )

    def _on_tick(self) -> None:
        if not self.clock.playing and not self.clock.finished:
            return
        changed = self.clock.tick(self.timer.interval())
        if changed:
            if self.auto_follow.isChecked() or self.clock.finished:
                self._show_frame(self.clock.index)
            else:
                self._update_playback_labels()
        if self.clock.finished:
            self.timer.stop()
            self.btn_play.setText("▶ 播放")
            self._show_frame(self.clock.index)
            self._set_status(
                f"有限循环结束：共播放 {self.clock.plays_completed} 遍，停在最后一帧"
            )
            self._update_playback_labels()

    # -------------------------------------------------------------- export
    def _export(self) -> None:
        if not self.project.frames:
            self._set_warning("没有帧可导出")
            return
        try:
            self.project.validate(require_frames=True)
        except ValidationError as exc:
            self._set_warning(str(exc))
            QMessageBox.warning(self, "无法导出", str(exc))
            return
        suggested = str(Path.cwd() / "frames.apng.png")
        path, _ = QFileDialog.getSaveFileName(
            self, "导出 RGBA APNG", suggested, "APNG 动画 (*.png)"
        )
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"
        try:
            written = export_apng(self.project, path)
            report = verify_export(self.project, written)
        except (OSError, ValidationError) as exc:
            self._set_warning(f"导出失败：{exc}")
            QMessageBox.critical(self, "导出失败", str(exc))
            return

        self._last_export = written
        lines = [
            f"文件：{written}",
            f"画布：{self.project.canvas_width}×{self.project.canvas_height}",
            f"循环：{'无限（0）' if self.project.loop_count == 0 else f'{self.project.loop_count} 遍'}",
            f"帧数：{len(self.project.frames)}",
            "",
            "逐帧回读（完整画面逐像素比较）：",
        ]
        for check in report.frames:
            mark = "✔" if check.pixels_match and check.duration_ok else "✘"
            lines.append(
                f"  {mark} 第 {check.index + 1} 帧：设定 {check.expected_ms} ms，"
                f"回读 {check.actual_ms:.3f} ms"
                + (f"；{check.detail}" if check.detail else "")
            )
        if report.ok:
            lines.extend(
                [
                    "",
                    "全部一致。APNG 的 fcTL 延时分母为 1000，本工具的整数毫秒值",
                    "可无损写入；若时长来自其它动画，可能出现毫秒级舍入差异。",
                ]
            )
        else:
            lines.extend(["", report.summary()])
        detail = "\n".join(lines)

        dialog = QMessageBox(self)
        dialog.setWindowTitle("导出结果" if report.ok else "导出回读校验失败")
        dialog.setIcon(
            QMessageBox.Icon.Information if report.ok else QMessageBox.Icon.Warning
        )
        dialog.setText(
            "导出完成，回读校验通过。" if report.ok else "导出完成，但回读校验发现问题。"
        )
        dialog.setDetailedText(detail)
        dialog.setInformativeText(
            f"已写入 {written.name}；棋盘格与红框只属于界面，未写入文件。"
        )
        dialog.exec()

        self._set_warning(None if report.ok else report.summary())
        self._set_status(
            f"导出{'并校验通过' if report.ok else '完成但校验失败'}：{written}"
        )


def run() -> int:
    import sys

    from PySide6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    app.setApplicationName("APNG 逐帧合成小工具")
    window = MainWindow()
    window.show()
    return app.exec()
