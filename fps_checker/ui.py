"""PySide6 主窗口: 并排检查、播放控制、转换规则与导出核对。"""
from __future__ import annotations

import os
import tempfile
from collections import OrderedDict

from PySide6.QtCore import Qt, QTimer, QElapsedTimer
from PySide6.QtGui import QPixmap, QColor, QAction
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QSplitter,
    QLabel, QPushButton, QComboBox, QTableWidget, QTableWidgetItem,
    QFileDialog, QMessageBox, QTabWidget, QPlainTextEdit, QDoubleSpinBox,
    QSpinBox, QProgressDialog, QGroupBox, QHeaderView, QAbstractItemView,
)

from . import TARGET_FPS_CHOICES, exporter, mapping, verify
from .workers import LoadWorker, SampleWorker


PREVIEW_CACHE = 120  # 预览像素缓存上限(帧)


class PixmapCache:
    """按文件路径缓存缩放后的 QPixmap, LRU 淘汰。"""

    def __init__(self, max_size: int = PREVIEW_CACHE):
        self._max = max_size
        self._store: OrderedDict[str, QPixmap] = OrderedDict()

    def get(self, path: str, width: int) -> QPixmap:
        key = f"{path}@{width}"
        if key in self._store:
            self._store.move_to_end(key)
            return self._store[key]
        pm = QPixmap(path)
        if pm.isNull():
            return QPixmap()
        pm = pm.scaledToWidth(width, Qt.SmoothTransformation)
        self._store[key] = pm
        self._store.move_to_end(key)
        while len(self._store) > self._max:
            self._store.popitem(last=False)
        return pm

    def clear(self) -> None:
        self._store.clear()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("短视频帧率转换检查器")
        self.resize(1320, 860)

        self._source = None                 # probe.InputVideo
        self._mappings: dict[int, mapping.MappingResult] = {}
        self._fps = TARGET_FPS_CHOICES[0]
        self._index = 0
        self._version = 0                   # 状态代际, 丢弃过期异步回调
        self._worker = None
        self._cache = PixmapCache()
        self._has_beeps = False
        self._sample_dir = os.path.join(tempfile.gettempdir(), "fpsc_samples")

        self._play_timer = QTimer(self)
        self._play_timer.timeout.connect(self._tick_playback)
        self._clock = QElapsedTimer()

        self._build_ui()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        toolbar = self.addToolBar("主工具栏")
        toolbar.setMovable(False)
        act_open = QAction("导入 mp4", self)
        act_open.triggered.connect(self._on_open)
        toolbar.addAction(act_open)
        act_sample = QAction("生成内置样例", self)
        act_sample.triggered.connect(self._on_make_samples)
        toolbar.addAction(act_sample)
        act_export = QAction("导出 mp4 + 清单", self)
        act_export.triggered.connect(self._on_export)
        toolbar.addAction(act_export)

        self._info = QLabel("尚未导入视频(≤10s、≤720p 的 mp4, 支持 CFR/VFR)")
        toolbar.addWidget(self._info)

        # 传输控制条
        bar = QWidget()
        bl = QHBoxLayout(bar)
        bl.setContentsMargins(6, 4, 6, 4)
        bl.addWidget(QLabel("目标帧率:"))
        self._fps_box = QComboBox()
        for f in TARGET_FPS_CHOICES:
            self._fps_box.addItem(f"{f} fps", f)
        self._fps_box.currentIndexChanged.connect(self._on_fps_changed)
        bl.addWidget(self._fps_box)

        self._btn_first = QPushButton("⏮ 首帧")
        self._btn_prev = QPushButton("◀ 单步")
        self._btn_play = QPushButton("▶ 播放")
        self._btn_next = QPushButton("单步 ▶")
        self._btn_last = QPushButton("末帧 ⏭")
        for b, slot in (
            (self._btn_first, self._goto_first),
            (self._btn_prev, self._goto_prev),
            (self._btn_play, self._toggle_play),
            (self._btn_next, self._goto_next),
            (self._btn_last, self._goto_last),
        ):
            b.clicked.connect(slot)
            bl.addWidget(b)

        bl.addWidget(QLabel("时间定位(s):"))
        self._seek = QDoubleSpinBox()
        self._seek.setDecimals(3)
        self._seek.setSingleStep(0.1)
        self._seek.setRange(0.0, 10.0)
        bl.addWidget(self._seek)
        btn_seek = QPushButton("定位")
        btn_seek.clicked.connect(self._on_seek)
        bl.addWidget(btn_seek)

        bl.addWidget(QLabel("帧区间:"))
        self._range_from = QSpinBox()
        self._range_to = QSpinBox()
        for sb in (self._range_from, self._range_to):
            sb.setMinimum(0)
            sb.setMaximum(999999)
        bl.addWidget(self._range_from)
        bl.addWidget(QLabel("–"))
        bl.addWidget(self._range_to)
        btn_range = QPushButton("应用区间")
        btn_range.clicked.connect(self._apply_range)
        bl.addWidget(btn_range)
        btn_range_clear = QPushButton("清除")
        btn_range_clear.clicked.connect(self._clear_range)
        bl.addWidget(btn_range_clear)
        bl.addStretch(1)

        # 左右并排预览 + 信息
        self._src_preview = QLabel("源画面")
        self._out_preview = QLabel("输出画面")
        for lb in (self._src_preview, self._out_preview):
            lb.setAlignment(Qt.AlignCenter)
            lb.setMinimumSize(420, 260)
            lb.setStyleSheet("background:#111;color:#888;")
        self._src_info = QPlainTextEdit()
        self._out_info = QPlainTextEdit()
        for te in (self._src_info, self._out_info):
            te.setReadOnly(True)
            te.setMaximumHeight(170)

        src_box = QGroupBox("输入(源帧)")
        sl = QVBoxLayout(src_box)
        sl.addWidget(self._src_preview, 1)
        sl.addWidget(self._src_info)
        out_box = QGroupBox("输出(转换结果, 与当前帧率设置一致)")
        ol = QVBoxLayout(out_box)
        ol.addWidget(self._out_preview, 1)
        ol.addWidget(self._out_info)

        top_split = QSplitter(Qt.Horizontal)
        top_split.addWidget(src_box)
        top_split.addWidget(out_box)
        top_split.setSizes([660, 660])

        # 下部表格与说明
        self._tabs = QTabWidget()
        self._out_table = QTableWidget()
        self._src_table = QTableWidget()
        for t in (self._out_table, self._src_table):
            t.setSelectionBehavior(QAbstractItemView.SelectRows)
            t.setSelectionMode(QAbstractItemView.SingleSelection)
            t.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self._out_table.itemSelectionChanged.connect(self._on_out_row)
        self._src_table.itemSelectionChanged.connect(self._on_src_row)
        self._rules_view = QPlainTextEdit()
        self._rules_view.setReadOnly(True)
        self._report_view = QPlainTextEdit()
        self._report_view.setReadOnly(True)
        self._tabs.addTab(self._out_table, "输出帧对应表")
        self._tabs.addTab(self._src_table, "源帧时间表")
        self._tabs.addTab(self._rules_view, "转换规则")
        self._tabs.addTab(self._report_view, "核对报告")

        vert = QSplitter(Qt.Vertical)
        vert.addWidget(top_split)
        vert.addWidget(self._tabs)
        vert.setSizes([560, 300])

        central = QWidget()
        cl = QVBoxLayout(central)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.addWidget(bar)
        cl.addWidget(vert, 1)
        self.setCentralWidget(central)
        self._set_controls_enabled(False)

    def _set_controls_enabled(self, on: bool) -> None:
        for w in (
            self._fps_box, self._btn_first, self._btn_prev, self._btn_play,
            self._btn_next, self._btn_last, self._seek,
            self._range_from, self._range_to,
        ):
            w.setEnabled(on)

    # ------------------------------------------------------------- 导入/样例
    def _on_open(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 mp4(≤10s、≤720p)", "", "MP4 视频 (*.mp4)"
        )
        if not path:
            return
        self._start_load(path, has_beeps=False)

    def _on_make_samples(self) -> None:
        self._info.setText("正在生成 CFR/VFR 样例…")
        worker = SampleWorker(self._sample_dir, self)
        self._version += 1
        version = self._version
        worker.finished_ok.connect(
            lambda paths: self._samples_ready(paths, version, worker)
        )
        worker.failed.connect(self._on_worker_failed)
        self._worker = worker
        worker.start()

    def _samples_ready(self, paths: dict, version: int,
                       worker: SampleWorker) -> None:
        if version != self._version:
            worker.cleanup_dir()
            return
        worker.cleanup_dir()
        box = QMessageBox(self)
        box.setWindowTitle("样例已生成")
        box.setText(
            f"CFR: {paths['cfr']}\nVFR: {paths['vfr']}\n\n"
            "选择要检查的样例:"
        )
        b_cfr = box.addButton("CFR 样例", QMessageBox.AcceptRole)
        b_vfr = box.addButton("VFR 样例", QMessageBox.DestructiveRole)
        box.addButton("取消", QMessageBox.RejectRole)
        box.exec()
        if box.clickedButton() is b_cfr:
            self._start_load(paths["cfr"], has_beeps=True)
        elif box.clickedButton() is b_vfr:
            self._start_load(paths["vfr"], has_beeps=True)

    def _start_load(self, path: str, *, has_beeps: bool) -> None:
        self._stop_play()
        self._version += 1
        version = self._version
        self._info.setText(f"正在导入 {os.path.basename(path)} …")
        worker = LoadWorker(path, self)
        worker.finished_ok.connect(
            lambda video: self._load_ready(video, version, worker)
        )
        worker.failed.connect(self._on_worker_failed)
        worker.progress.connect(
            lambda c, t: self._info.setText(f"解码帧 {c}/{t}")
        )
        self._worker = worker
        self._has_beeps = has_beeps
        worker.start()

    def _load_ready(self, video, version: int, worker: LoadWorker) -> None:
        if version != self._version:
            worker.cleanup_dir()
            return
        old = self._source
        self._source = video
        if old is not None:
            import shutil
            shutil.rmtree(old.work_dir, ignore_errors=True)
        self._cache.clear()
        self._mappings = {
            f: mapping.build_mapping(video.zero_ts, video.raw_pts, f)
            for f in TARGET_FPS_CHOICES
        }
        self._set_controls_enabled(True)
        kind = "VFR(可变帧率)" if video.is_vfr else "CFR(恒定帧率)"
        self._info.setText(
            f"{os.path.basename(video.path)} | {video.width}x{video.height} "
            f"| {kind} | {video.frame_count} 帧 | "
            f"容器时长 {video.container_duration:.3f}s | "
            f"零点跨度 {video.source_span:.3f}s"
        )
        self._seek.setRange(0.0, video.source_span)
        self._rules_view.setPlainText(mapping.RULE_TEXT)
        self._report_view.setPlainText("尚未导出; 导出后此处显示实测核对报告。")
        self._populate_source_table()
        self._apply_fps(reset_index=True)

    def _on_worker_failed(self, msg: str) -> None:
        self._info.setText("操作失败")
        QMessageBox.critical(self, "操作失败", msg)

    # ------------------------------------------------------------- 帧率切换
    def _on_fps_changed(self) -> None:
        if self._source is None:
            return
        self._apply_fps(reset_index=True)

    def _apply_fps(self, *, reset_index: bool) -> None:
        """同步重建: 映射表、输出表、预览与信息全部来自同一版本结果。"""
        self._stop_play()
        self._fps = self._fps_box.currentData()
        if reset_index:
            self._index = 0
        self._populate_output_table()
        self._refresh_view()

    def _current_mapping(self) -> mapping.MappingResult:
        return self._mappings[self._fps]

    # ------------------------------------------------------------- 表格填充
    def _populate_output_table(self) -> None:
        m = self._current_mapping()
        t = self._out_table
        t.blockSignals(True)
        t.clear()
        headers = [
            "输出#", "输出时间(s)", "请求时间(s)", "源帧#", "源帧时间(s)",
            "源原始pts(s)", "重复帧", "请求-源帧(s)", "到下一源帧(s)",
        ]
        t.setColumnCount(len(headers))
        t.setHorizontalHeaderLabels(headers)
        t.setRowCount(m.output_count)
        repeat_bg = QColor(255, 224, 178)
        for row, f in enumerate(m.frames):
            vals = [
                str(f.index), f"{f.out_time:.6f}", f"{f.request_time:.6f}",
                str(f.source_index), f"{f.source_time:.6f}",
                f"{f.source_raw_time:.6f}", "是" if f.repeated else "",
                f"{f.gap_before:.6f}",
                "" if f.gap_after is None else f"{f.gap_after:.6f}",
            ]
            for col, v in enumerate(vals):
                item = QTableWidgetItem(v)
                if f.repeated:
                    item.setBackground(repeat_bg)
                t.setItem(row, col, item)
        t.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        t.blockSignals(False)
        self._range_from.setMaximum(max(0, m.output_count - 1))
        self._range_to.setMaximum(max(0, m.output_count - 1))
        self._range_from.setValue(0)
        self._range_to.setValue(m.output_count - 1)

    def _populate_source_table(self) -> None:
        assert self._source is not None
        m = self._current_mapping()
        t = self._src_table
        t.blockSignals(True)
        t.clear()
        headers = ["源帧#", "零点时间(s)", "原始pts(s)", "与上帧间隔(s)",
                   "被输出使用次数", "状态"]
        t.setColumnCount(len(headers))
        t.setHorizontalHeaderLabels(headers)
        t.setRowCount(self._source.frame_count)
        unused_bg = QColor(255, 190, 190)
        for i in range(self._source.frame_count):
            gap = self._source.intervals[i]
            usage = m.source_usage.get(i, 0)
            status = "丢弃(未使用)" if usage == 0 else (
                "重复复用" if usage > 1 else "使用 1 次"
            )
            vals = [
                str(i), f"{self._source.zero_ts[i]:.6f}",
                f"{self._source.raw_pts[i]:.6f}",
                "" if gap is None else f"{gap:.6f}",
                str(usage), status,
            ]
            for col, v in enumerate(vals):
                item = QTableWidgetItem(v)
                if usage == 0:
                    item.setBackground(unused_bg)
                t.setItem(i, col, item)
        t.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        t.blockSignals(False)

    # ------------------------------------------------------------- 行选择
    def _on_out_row(self) -> None:
        rows = self._out_table.selectionModel().selectedRows()
        if not rows or self._source is None:
            return
        self._stop_play()
        self._index = rows[0].row()
        self._refresh_view(sync_table=False)

    def _on_src_row(self) -> None:
        rows = self._src_table.selectionModel().selectedRows()
        if not rows or self._source is None:
            return
        i = rows[0].row()
        pm = self._cache.get(self._source.frame_files[i], 560)
        self._src_preview.setPixmap(pm)
        gap = self._source.intervals[i]
        m = self._current_mapping()
        usage = m.source_usage.get(i, 0)
        self._src_info.setPlainText(
            f"源帧 #{i}\n"
            f"零点时间: {self._source.zero_ts[i]:.6f} s\n"
            f"原始 pts: {self._source.raw_pts[i]:.6f} s\n"
            f"与上帧间隔: {'(首帧)' if gap is None else f'{gap:.6f} s'}\n"
            f"在 {self._fps}fps 输出中被使用 {usage} 次\n"
            f"状态: {'丢弃(未使用)' if usage == 0 else ('重复复用' if usage > 1 else '使用 1 次')}"
        )

    # ------------------------------------------------------------- 播放控制
    def _toggle_play(self) -> None:
        if self._play_timer.isActive():
            self._stop_play()
            return
        if self._source is None:
            return
        if self._index >= self._current_mapping().output_count - 1:
            self._index = 0
        self._clock.start()
        self._play_start_index = self._index
        self._play_timer.start(max(1, int(1000 / self._fps) // 2))
        self._btn_play.setText("⏸ 暂停")

    def _tick_playback(self) -> None:
        m = self._current_mapping()
        elapsed = self._clock.elapsed() / 1000.0
        target = self._play_start_index + round(elapsed * self._fps)
        if target >= m.output_count:
            target = m.output_count - 1
            self._stop_play()
        if target != self._index:
            self._index = target
            self._refresh_view()

    def _stop_play(self) -> None:
        if self._play_timer.isActive():
            self._play_timer.stop()
        self._btn_play.setText("▶ 播放")

    def _goto_first(self) -> None:
        self._stop_play()
        self._index = 0
        self._refresh_view()

    def _goto_last(self) -> None:
        self._stop_play()
        self._index = self._current_mapping().output_count - 1
        self._refresh_view()

    def _goto_prev(self) -> None:
        self._stop_play()
        self._index = max(0, self._index - 1)
        self._refresh_view()

    def _goto_next(self) -> None:
        self._stop_play()
        self._index = min(self._current_mapping().output_count - 1,
                          self._index + 1)
        self._refresh_view()

    def _on_seek(self) -> None:
        if self._source is None:
            return
        self._stop_play()
        t = self._seek.value()
        # 真实规则: floor 到输出栅格, 再由映射规则决定源帧
        k = min(
            self._current_mapping().output_count - 1,
            max(0, int(t * self._fps)),
        )
        self._index = k
        self._refresh_view()

    def _apply_range(self) -> None:
        m = self._current_mapping()
        lo = min(self._range_from.value(), m.output_count - 1)
        hi = min(self._range_to.value(), m.output_count - 1)
        if lo > hi:
            lo, hi = hi, lo
        for row in range(m.output_count):
            self._out_table.setRowHidden(row, not (lo <= row <= hi))

    def _clear_range(self) -> None:
        for row in range(self._current_mapping().output_count):
            self._out_table.setRowHidden(row, False)

    # ------------------------------------------------------------- 画面刷新
    def _refresh_view(self, *, sync_table: bool = True) -> None:
        if self._source is None:
            return
        m = self._current_mapping()
        self._index = max(0, min(self._index, m.output_count - 1))
        f = m.frames[self._index]

        self._out_preview.setPixmap(
            self._cache.get(self._source.frame_files[f.source_index], 560)
        )
        self._src_preview.setPixmap(
            self._cache.get(self._source.frame_files[f.source_index], 560)
        )

        gap = self._source.intervals[f.source_index]
        self._src_info.setPlainText(
            f"源帧 #{f.source_index}\n"
            f"零点时间: {f.source_time:.6f} s\n"
            f"原始 pts: {f.source_raw_time:.6f} s\n"
            f"与上帧间隔: {'(首帧)' if gap is None else f'{gap:.6f} s'}\n"
            f"在 {self._fps}fps 输出中被使用 "
            f"{m.source_usage.get(f.source_index, 0)} 次"
        )
        self._out_info.setPlainText(
            f"输出帧 #{f.index} / {m.output_count - 1}\n"
            f"实际输出时间: {f.out_time:.6f} s (栅格 {1/self._fps:.6f} s)\n"
            f"请求时间: {f.request_time:.6f} s  "
            f"(展示真实选择结果, 不以请求时间充当帧时间)\n"
            f"对应源帧: #{f.source_index}, 源帧时间 {f.source_time:.6f} s\n"
            f"请求早于源帧: {f.gap_before:.6f} s | "
            f"距下一源帧: {'(末帧, 无下一帧)' if f.gap_after is None else f'{f.gap_after:.6f} s'}\n"
            f"{'⚠ 重复帧: 与上一输出帧复用同一源帧' if f.repeated else '新帧'}"
        )

        if sync_table:
            self._out_table.blockSignals(True)
            self._out_table.selectRow(self._index)
            self._out_table.scrollToItem(
                self._out_table.item(self._index, 0),
                QAbstractItemView.PositionAtCenter,
            )
            self._out_table.blockSignals(False)
        self._src_table.blockSignals(True)
        self._src_table.selectRow(f.source_index)
        self._src_table.blockSignals(False)

        stats = (
            f"\n\n--- 当前 {self._fps}fps 统计 ---\n"
            f"输出总帧数: {m.output_count}\n"
            f"重复帧数: {m.repeat_count}\n"
            f"被丢弃源帧: {len(m.unused_indices)} 个 {m.unused_indices[:20]}\n"
            f"源跨度 {m.source_span:.6f}s, 输出末帧 {m.output_span:.6f}s, "
            f"时长差 {m.duration_diff:.6f}s (< {1/self._fps:.6f}s)"
        )
        self._rules_view.setPlainText(mapping.RULE_TEXT + stats)

    # ------------------------------------------------------------- 导出
    def _on_export(self) -> None:
        if self._source is None:
            return
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        m = self._current_mapping()
        base = f"{os.path.splitext(os.path.basename(self._source.path))[0]}_{self._fps}fps"
        progress = QProgressDialog("正在编码 CFR mp4…", None, 0, m.output_count, self)
        progress.setWindowModality(Qt.WindowModal)
        progress.setMinimumDuration(0)
        progress.setCancelButton(None)

        def on_step(done: int, total: int) -> None:
            progress.setMaximum(total)
            progress.setValue(done)
            QApplication.processEvents()

        try:
            paths = exporter.export(
                self._source, m, out_dir, base, on_progress=on_step
            )
            progress.setLabelText("正在重新解码成品并核对…")
            QApplication.processEvents()
            report = verify.verify_output(
                self._source, m, paths["mp4"], self._source.work_dir,
                expect_beeps=self._has_beeps,
            )
        except verify.VerifyError as exc:
            progress.close()
            report = exc.report
            self._report_view.setPlainText(verify.format_report(report))
            self._tabs.setCurrentWidget(self._report_view)
            QMessageBox.critical(self, "核对未通过",
                                 "成品核对失败, 详见「核对报告」页。")
            return
        except Exception as exc:  # noqa: BLE001
            progress.close()
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        progress.close()
        self._report_view.setPlainText(
            verify.format_report(report)
            + f"\n\n导出文件:\n  mp4 : {paths['mp4']}\n"
              f"  清单: {paths['csv']}\n  摘要: {paths['json']}"
        )
        self._tabs.setCurrentWidget(self._report_view)
        QMessageBox.information(
            self, "导出完成",
            f"全部 {report['summary']}\n\n{paths['mp4']}\n{paths['csv']}",
        )


def run() -> int:
    import sys
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()
