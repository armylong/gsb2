"""Main application window: inspect frames and build/verify optimized GIFs."""

from __future__ import annotations

import os

import numpy as np
from PIL import Image
from PySide6.QtCore import QTimer, Qt
from PySide6.QtWidgets import (
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSlider,
    QSpinBox,
    QSplitter,
    QStatusBar,
    QTableView,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from giftool.document import AnimationDocument
from giftool.exporter import export_gif
from giftool.player import PlaybackScheduler
from giftool.ui.export_dialog import ExportDialog
from giftool.ui.frame_model import FrameTableModel, COLUMNS
from giftool.ui.image_utils import overlay_with_checker


class ImagePane(QWidget):
    """A titled image pane that shows RGBA content over a checkerboard."""

    def __init__(self, title: str) -> None:
        super().__init__()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)
        self.title = QLabel(title)
        self.title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.title.setStyleSheet("font-weight: bold;")
        self.image_label = QLabel()
        self.image_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.image_label.setMinimumSize(260, 260)
        self.image_label.setFrameShape(QFrame.Shape.StyledPanel)
        self.meta = QLabel("")
        self.meta.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.meta.setWordWrap(True)
        layout.addWidget(self.title)
        layout.addWidget(self.image_label, stretch=1)
        layout.addWidget(self.meta)

    def show_rgba(self, rgba: np.ndarray, note: str = "") -> None:
        pixmap = overlay_with_checker(rgba)
        self.image_label.setPixmap(
            pixmap.scaled(
                self.image_label.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.FastTransformation,
            )
        )
        self.meta.setText(note)

    def clear(self) -> None:
        self.image_label.clear()
        self.meta.setText("")


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("GIF 局部帧工具")
        self.resize(1280, 860)

        self.document: AnimationDocument | None = None
        self.imported_frames: list[np.ndarray] | None = None
        self.imported_durations: list[int] | None = None
        self.scheduler: PlaybackScheduler | None = None

        self.model = FrameTableModel(None)
        self._build_ui()

        # Single timer drives playback; all timing comes from the scheduler,
        # so a late tick after pause recomputes position and cannot advance.
        self.timer = QTimer(self)
        self.timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.timer.timeout.connect(self._tick)
        self._suspended = False

    # ------------------------------------------------------------------ UI

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        toolbar = QHBoxLayout()
        self.open_btn = QPushButton("打开 GIF…")
        self.import_btn = QPushButton("导入 PNG 序列…")
        self.export_btn = QPushButton("导出 GIF…")
        self.export_btn.setEnabled(False)
        toolbar.addWidget(self.open_btn)
        toolbar.addWidget(self.import_btn)
        toolbar.addWidget(self.export_btn)
        toolbar.addStretch(1)
        root.addLayout(toolbar)

        self.meta_label = QLabel("未打开文件")
        self.meta_label.setWordWrap(True)
        self.meta_label.setStyleSheet("padding: 6px; background: #f4f4f8; border-radius: 4px;")
        root.addWidget(self.meta_label)

        splitter = QSplitter(Qt.Orientation.Vertical)
        root.addWidget(splitter, stretch=1)

        # Upper: the two synchronized image panes.
        images = QWidget()
        image_layout = QHBoxLayout(images)
        self.tile_pane = ImagePane("文件中存储的局部图块")
        self.canvas_pane = ImagePane("最终合成完整画面")
        image_layout.addWidget(self.tile_pane)
        image_layout.addWidget(self.canvas_pane)
        splitter.addWidget(images)

        # Lower: frame table + readback report.
        lower = QSplitter(Qt.Orientation.Horizontal)
        self.table = QTableView()
        self.table.setModel(self.model)
        self.table.setSelectionBehavior(QTableView.SelectionBehavior.SelectRows)
        for column, (_, width) in enumerate(COLUMNS):
            self.table.setColumnWidth(column, width)
        lower.addWidget(self.table)

        self.report = QTextEdit()
        self.report.setReadOnly(True)
        self.report.setPlaceholderText("导出回读报告将显示在这里")
        lower.addWidget(self.report)
        splitter.addWidget(lower)
        splitter.setSizes([420, 360])

        # Transport controls.
        transport = QHBoxLayout()
        self.play_btn = QPushButton("播放")
        self.pause_btn = QPushButton("暂停")
        self.prev_btn = QPushButton("◀ 上一帧")
        self.next_btn = QPushButton("下一帧 ▶")
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setMinimum(0)
        self.frame_spin = QSpinBox()
        self.frame_spin.setMinimum(0)
        self.position_label = QLabel("帧 0 / 0")
        self.duration_label = QLabel("")
        for widget in (
            self.play_btn, self.pause_btn, self.prev_btn, self.next_btn,
        ):
            transport.addWidget(widget)
        transport.addWidget(self.slider, stretch=1)
        transport.addWidget(self.frame_spin)
        transport.addWidget(self.position_label)
        transport.addWidget(self.duration_label)
        root.addLayout(transport)

        self.setStatusBar(QStatusBar())

        self.open_btn.clicked.connect(self._open_gif)
        self.import_btn.clicked.connect(self._import_pngs)
        self.export_btn.clicked.connect(self._export)
        self.play_btn.clicked.connect(self._play)
        self.pause_btn.clicked.connect(self._pause)
        self.prev_btn.clicked.connect(self._step_back)
        self.next_btn.clicked.connect(self._step_forward)
        self.slider.valueChanged.connect(self._slider_changed)
        self.frame_spin.valueChanged.connect(self._spin_changed)
        self.table.selectionModel()  # created lazily; selection wired on load

    # ------------------------------------------------------------- loading

    def _reset_views(self) -> None:
        """Tear down all prior animation state so nothing leaks across files."""
        self.timer.stop()
        self.scheduler = None
        self.document = None
        self.imported_frames = None
        self.imported_durations = None
        self.model.set_document(None)
        self.tile_pane.clear()
        self.canvas_pane.clear()
        self.slider.blockSignals(True)
        self.slider.setMaximum(0)
        self.slider.setValue(0)
        self.slider.blockSignals(False)
        self.frame_spin.blockSignals(True)
        self.frame_spin.setMaximum(0)
        self.frame_spin.setValue(0)
        self.frame_spin.blockSignals(False)
        self.position_label.setText("帧 0 / 0")
        self.duration_label.setText("")
        self.export_btn.setEnabled(False)

    def _open_gif(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开 GIF", "", "GIF 动画 (*.gif)"
        )
        if not path:
            return
        self._reset_views()
        try:
            self.document = AnimationDocument(path)
        except Exception as exc:  # noqa: BLE001 - surface parse errors to user
            QMessageBox.critical(self, "无法打开", f"解析 GIF 失败：\n{exc}")
            self._reset_views()
            self.meta_label.setText("未打开文件")
            return
        self._bind_document(path)

    def _bind_document(self, path: str) -> None:
        doc = self.document
        assert doc is not None
        self.model.set_document(doc)
        self.slider.blockSignals(True)
        self.slider.setMaximum(doc.frame_count - 1)
        self.slider.setValue(0)
        self.slider.blockSignals(False)
        self.frame_spin.blockSignals(True)
        self.frame_spin.setMaximum(doc.frame_count - 1)
        self.frame_spin.setValue(0)
        self.frame_spin.blockSignals(False)

        self.scheduler = PlaybackScheduler(doc.timeline)
        self.meta_label.setText(
            f"<b>{os.path.basename(path)}</b>　画布 {doc.width}×{doc.height}　"
            f"帧数 {doc.frame_count}　{doc.loop_description()}<br>"
            f"{doc.background_description()}　文件 {doc.file_size} B"
        )
        self.table.selectionModel().currentRowChanged.connect(
            lambda current, _: self._show_frame(current.row())
        )
        self._show_frame(0)
        self.statusBar().showMessage(
            "短帧规则：存储时长 < 20ms 时统一按 100ms 播放"
        )

    # ------------------------------------------------------------- display

    def _show_frame(self, index: int) -> None:
        if self.document is None:
            return
        doc = self.document
        index = max(0, min(index, doc.frame_count - 1))
        # Keep the scheduler's logical position aligned with the frame being
        # displayed so subsequent play/step actions start from the right place.
        if self.scheduler is not None:
            self.scheduler.seek_to_frame(index)
        info = doc.frame_info(index)

        tile = doc.tile_image(index)
        tile_note = (
            f"局部范围 {info.bbox}　{tile.shape[1]}×{tile.shape[0]} px"
            f"　{'完整画布' if info.is_full_canvas else '局部图块'}"
        )
        self.tile_pane.show_rgba(tile, tile_note)

        canvas = doc.composited_image(index)
        # Deterministic re-render from frame 0 proves seek consistency.
        re_rendered = doc.recomposite_from(index)
        consistent = np.array_equal(canvas, re_rendered)
        canvas_note = (
            f"{info.disposal_label}　存储 {info.stored_duration_ms}ms / "
            f"播放 {info.effective_duration_ms}ms　"
            f"{'起点渲染一致 ✓' if consistent else '渲染不一致 ✗'}"
        )
        self.canvas_pane.show_rgba(canvas, canvas_note)

        self.position_label.setText(self._position_text(index))
        self.duration_label.setText(
            f"本帧 {info.effective_duration_ms}ms（存储 {info.stored_duration_ms}ms）"
        )
        for widget in (self.slider, self.frame_spin):
            widget.blockSignals(True)
            if isinstance(widget, QSlider):
                widget.setValue(index)
            else:
                widget.setValue(index)
            widget.blockSignals(False)

        self.table.selectRow(index)

    def _position_text(self, index: int) -> str:
        assert self.document is not None
        doc = self.document
        if self.scheduler is not None and self.scheduler.is_playing:
            play_index = self.scheduler.play_index
            if doc.timeline.is_infinite:
                pass_text = f"第 {play_index + 1} 遍（无限循环）"
            else:
                pass_text = f"第 {play_index + 1}/{doc.timeline.total_plays} 遍"
            return f"帧 {index} / {doc.frame_count - 1}　{pass_text}"
        return f"帧 {index} / {doc.frame_count - 1}"

    # ------------------------------------------------------------ playback

    def _play(self) -> None:
        if self.scheduler is None:
            return
        # Restart from the beginning if the previous run finished at the end.
        if not self.scheduler.is_playing and (
            self.scheduler.frame_index == self.scheduler.timeline.frame_count - 1
        ):
            self.scheduler.stop_and_reset()
        self.scheduler.play(self._now_ms())
        self.timer.start(8)  # fine-grained polling; scheduler does the math

    def _pause(self) -> None:
        if self.scheduler is not None:
            self.scheduler.pause()
        self.timer.stop()

    def _tick(self) -> None:
        if self.scheduler is None:
            self.timer.stop()
            return
        frame, finished = self.scheduler.update(self._now_ms())
        if frame != self.slider.value():
            self._show_frame(frame)
        else:
            # A loop can wrap back onto the same frame index; refresh the
            # "which pass" label even though the frame number did not change.
            self.position_label.setText(self._position_text(frame))
        if finished:
            self.timer.stop()
            self.statusBar().showMessage("播放完成", 2000)

    def _step_forward(self) -> None:
        self._pause()
        if self.scheduler is not None:
            self._show_frame(self.scheduler.step_forward())

    def _step_back(self) -> None:
        self._pause()
        if self.scheduler is not None:
            self._show_frame(self.scheduler.step_backward())

    def _slider_changed(self, value: int) -> None:
        if self.scheduler is None:
            return
        self._pause()
        self.scheduler.seek_to_frame(value)
        self._show_frame(value)

    def _spin_changed(self, value: int) -> None:
        if self.scheduler is None:
            return
        self._pause()
        self.scheduler.seek_to_frame(value)
        self._show_frame(value)

    @staticmethod
    def _now_ms() -> int:
        from datetime import datetime

        return int(datetime.now().timestamp() * 1000)

    # -------------------------------------------------------------- import

    def _import_pngs(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择一组同尺寸 PNG（按文件名排序）", "", "PNG 图像 (*.png)"
        )
        if not paths:
            return
        try:
            images = [np.asarray(Image.open(p).convert("RGBA")) for p in paths]
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导入失败", str(exc))
            return
        shape = images[0].shape
        if any(img.shape != shape for img in images):
            QMessageBox.critical(self, "导入失败", "所有 PNG 必须尺寸一致")
            return
        self._reset_views()
        self.imported_frames = images
        self.imported_durations = [100] * len(images)
        self.export_btn.setEnabled(True)
        self.meta_label.setText(
            f"已导入 {len(images)} 张 PNG，画布 {shape[1]}×{shape[0]}，"
            f"默认每帧 100ms（导出前可在提示中调整）"
        )
        # Preview the first imported frame in the canvas pane.
        self.canvas_pane.show_rgba(images[0], f"导入帧 0 / {len(images) - 1}")
        self.statusBar().showMessage("PNG 序列已就绪，可导出为 GIF")

    # -------------------------------------------------------------- export

    def _collect_rgba_frames(self) -> tuple[list[np.ndarray], list[int]] | None:
        if self.imported_frames is not None:
            return self.imported_frames, list(self.imported_durations or [])
        if self.document is not None:
            # Re-export the currently open animation's composited frames.
            frames = [frame.copy() for frame in self.document.composited]
            durations = [
                frame.duration_ms for frame in self.document.doc.frames
            ]
            return frames, durations
        return None

    def _export(self) -> None:
        collected = self._collect_rgba_frames()
        if collected is None:
            QMessageBox.information(self, "导出", "请先打开 GIF 或导入 PNG 序列")
            return
        frames, durations = collected
        dialog = ExportDialog(frames[0], self)
        if dialog.exec() != ExportDialog.DialogCode.Accepted:
            return
        options = dialog.options()

        # Allow editing the uniform frame duration for imported PNG sets.
        if self.imported_frames is not None:
            uniform, ok = self._ask_duration()
            if not ok:
                return
            durations = [uniform] * len(frames)

        path, _ = QFileDialog.getSaveFileName(self, "保存 GIF", "output.gif", "GIF (*.gif)")
        if not path:
            return
        try:
            result = export_gif(
                frames,
                durations,
                options["loop_count"],
                colors=options["colors"],
                transparent_background=options["transparent_background"],
                optimize=options["optimize"],
                compare_full=True,
            )
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(exc))
            return

        with open(path, "wb") as handle:
            handle.write(result.optimized_bytes)
        self._present_report(path, result, options)

    def _ask_duration(self) -> tuple[int, bool]:
        from PySide6.QtWidgets import QInputDialog

        value, ok = QInputDialog.getInt(
            self, "帧时长", "每帧显示时长 (ms)：", 100, 1, 60000, 10
        )
        return value, ok

    def _present_report(self, path: str, result, options: dict) -> None:
        report = result.report
        lines = [
            f"<b>导出文件</b>：{path}",
            f"目标显示区间 {report.target_frames} 个，实际存储帧 {report.stored_frames} 个",
            f"循环设置 目标 loop={report.loop_target} / 回读 loop={report.loop_actual}"
            f"（{'一致 ✓' if report.loop_ok else '不一致 ✗'}）",
            f"总显示时长 目标 {report.total_target_duration_ms}ms / "
            f"回读 {report.total_actual_duration_ms}ms",
            report.size_summary(),
            "",
        ]
        bad = [item for item in report.intervals if not item.pixels_match]
        if report.all_pixels_match:
            lines.append("✅ 每个显示区间的完整合成画面均与调色板转换后的目标帧一致")
        else:
            lines.append(f"❌ {len(bad)} 个区间像素不一致")
        if report.all_durations_ok:
            lines.append("✅ 各区间时长一致（含 GIF 厘秒舍入容差 ±10ms）")
        else:
            lines.append("❌ 存在时长不一致的区间")
        lines.append(
            "比对基准为已完成调色板转换的目标帧，而非原始真彩 PNG（GIF 仅支持 256 色 + 单一透明）。"
        )
        self.report.setHtml("<br>".join(lines))
        self.statusBar().showMessage(
            "回读校验通过" if report.ok else "回读校验发现问题", 4000
        )
        if not report.ok:
            QMessageBox.warning(self, "回读校验", "部分校验未通过，详见报告面板")
