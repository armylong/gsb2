"""PySide6 图形界面."""
from __future__ import annotations

import os
import sys
from typing import List, Optional

from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal
from PySide6.QtGui import QPixmap, QPainter, QPen, QColor
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog,
    QFormLayout, QGroupBox, QHBoxLayout, QLabel, QLineEdit, QListWidget,
    QListWidgetItem, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton,
    QSplitter, QTabWidget, QTableWidget, QTableWidgetItem, QVBoxLayout,
    QWidget, QHeaderView,
)

from .analyze import load_presentation
from .exporter import common_coverage, export_range
from .model import Presentation, Segment
from .preview import PreviewResult, decode_preview


class _Signals(QObject):
    done = Signal(object)


class _Job(QRunnable):
    def __init__(self, fn, *args):
        super().__init__()
        self.fn, self.args = fn, args
        self.signals = _Signals()

    def run(self):
        try:
            self.signals.done.emit((self.fn(*self.args), None))
        except Exception as e:  # noqa: BLE001 - 界面层统一兜底
            self.signals.done.emit((None, e))


class WaveformWidget(QWidget):
    def __init__(self):
        super().__init__()
        self.setMinimumHeight(90)
        self._pcm: Optional[bytes] = None

    def set_pcm(self, pcm: Optional[bytes]):
        self._pcm = pcm
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 30, 30))
        if not self._pcm:
            p.setPen(QColor(150, 150, 150))
            p.drawText(self.rect(), Qt.AlignCenter, "无音频数据")
            return
        import struct
        n = len(self._pcm) // 2
        samples = struct.unpack(f"<{n}h", self._pcm[: n * 2])
        w, h = self.width(), self.height()
        mid = h / 2
        p.setPen(QPen(QColor(90, 200, 120)))
        per = max(1, n // w)
        for x in range(w):
            chunk = samples[x * per:(x + 1) * per]
            if not chunk:
                continue
            lo, hi = min(chunk), max(chunk)
            p.drawLine(x, int(mid - hi / 32768 * mid),
                       x, int(mid - lo / 32768 * mid))


class MainWindow(QMainWindow):
    def __init__(self, files: List[str]):
        super().__init__()
        self.setWindowTitle("分片 MP4 检查器")
        self.resize(1100, 720)
        self.pres: Optional[Presentation] = None
        self.pool = QThreadPool()
        self._pending: List[_Job] = []  # 持有引用, 防止任务对象在信号投递前被回收
        self._files: List[str] = list(files)
        self._preview: Optional[PreviewResult] = None

        root = QSplitter(Qt.Horizontal)
        root.addWidget(self._build_left())
        root.addWidget(self._build_tabs())
        root.setStretchFactor(1, 1)
        self.setCentralWidget(root)
        if self._files:
            self.reload()

    # ---------------------------------------------------------- 左侧文件列表
    def _build_left(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        v.addWidget(QLabel("输入文件 (按顺序, 首个含 moov 的作为初始化片段)"))
        self.file_list = QListWidget()
        v.addWidget(self.file_list)
        for text, slot in [
            ("添加初始化片段…", self.add_init),
            ("添加媒体片段…", self.add_media),
            ("打开完整 fMP4…", self.add_single),
            ("上移", lambda: self._move(-1)),
            ("下移", lambda: self._move(1)),
            ("移除", self._remove),
            ("清空", self._clear),
        ]:
            b = QPushButton(text)
            b.clicked.connect(slot)
            v.addWidget(b)
        return w

    def add_init(self):
        p, _ = QFileDialog.getOpenFileName(self, "选择初始化片段", "",
                                           "MP4 文件 (*.mp4 *.m4s *.mov);;所有文件 (*)")
        if p:
            self._files.insert(0, p)
            self.reload()

    def add_media(self):
        ps, _ = QFileDialog.getOpenFileNames(self, "按顺序选择媒体片段", "",
                                             "MP4 分片 (*.m4s *.mp4);;所有文件 (*)")
        if ps:
            self._files.extend(ps)
            self.reload()

    def add_single(self):
        p, _ = QFileDialog.getOpenFileName(self, "打开完整 fMP4", "",
                                           "MP4 文件 (*.mp4 *.m4s);;所有文件 (*)")
        if p:
            self._files.append(p)
            self.reload()

    def _move(self, d: int):
        row = self.file_list.currentRow()
        j = row + d
        if 0 <= row < len(self._files) and 0 <= j < len(self._files):
            self._files[row], self._files[j] = self._files[j], self._files[row]
            self.reload()
            self.file_list.setCurrentRow(j)

    def _remove(self):
        row = self.file_list.currentRow()
        if 0 <= row < len(self._files):
            del self._files[row]
            self.reload()

    def _clear(self):
        self._files.clear()
        self.reload()

    # ---------------------------------------------------------- 右侧标签页
    def _build_tabs(self) -> QWidget:
        self.tabs = QTabWidget()
        # 概览
        ov = QWidget()
        v = QVBoxLayout(ov)
        v.addWidget(QLabel("轨道"))
        self.track_table = QTableWidget(0, 6)
        self.track_table.setHorizontalHeaderLabels(
            ["ID", "类型", "编码", "时间基准", "参数", "样本总数"])
        self.track_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        v.addWidget(self.track_table)
        v.addWidget(QLabel("片段 (双击行可预览)"))
        self.seg_table = QTableWidget(0, 6)
        self.seg_table.setHorizontalHeaderLabels(
            ["#", "文件", "seq", "视频范围/样本", "音频范围/样本", "状态"])
        self.seg_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.seg_table.itemDoubleClicked.connect(self._preview_selected_row)
        v.addWidget(self.seg_table)
        self.tabs.addTab(ov, "概览")

        # 诊断
        self.diag_text = QPlainTextEdit()
        self.diag_text.setReadOnly(True)
        self.tabs.addTab(self.diag_text, "诊断")

        # 预览
        pv = QWidget()
        v = QVBoxLayout(pv)
        row = QHBoxLayout()
        row.addWidget(QLabel("片段:"))
        self.seg_combo = QComboBox()
        row.addWidget(self.seg_combo, 1)
        self.decode_btn = QPushButton("解码预览")
        self.decode_btn.clicked.connect(self.start_preview)
        row.addWidget(self.decode_btn)
        v.addLayout(row)
        self.preview_info = QPlainTextEdit()
        self.preview_info.setReadOnly(True)
        self.preview_info.setMaximumHeight(150)
        v.addWidget(self.preview_info)
        v.addWidget(QLabel("视频帧 (标签为显示时间 PTS)"))
        self.thumbs = QListWidget()
        self.thumbs.setViewMode(QListWidget.IconMode)
        from PySide6.QtCore import QSize
        self.thumbs.setIconSize(QSize(192, 108))
        self.thumbs.setResizeMode(QListWidget.Adjust)
        v.addWidget(self.thumbs, 1)
        v.addWidget(QLabel("音频波形 (8kHz 单声道)"))
        self.wave = WaveformWidget()
        v.addWidget(self.wave)
        self.audio_label = QLabel("")
        v.addWidget(self.audio_label)
        self.tabs.addTab(pv, "预览")

        # 导出
        ex = QWidget()
        form = QFormLayout(ex)
        self.range_combo = QComboBox()
        self.range_combo.currentIndexChanged.connect(self._range_changed)
        form.addRow("连续覆盖区间", self.range_combo)
        self.start_spin = QDoubleSpinBox()
        self.start_spin.setRange(0, 1e6)
        self.start_spin.setDecimals(3)
        self.end_spin = QDoubleSpinBox()
        self.end_spin.setRange(0, 1e6)
        self.end_spin.setDecimals(3)
        form.addRow("起始 (秒)", self.start_spin)
        form.addRow("结束 (秒)", self.end_spin)
        self.reencode_box = QCheckBox("重编码 (精确边界; 默认流拷贝, 起点对齐关键帧)")
        form.addRow(self.reencode_box)
        outrow = QHBoxLayout()
        self.out_edit = QLineEdit(os.path.abspath("export.mp4"))
        br = QPushButton("…")
        br.clicked.connect(self._pick_out)
        outrow.addWidget(self.out_edit)
        outrow.addWidget(br)
        form.addRow("输出文件", outrow)
        self.export_btn = QPushButton("导出并读回核对")
        self.export_btn.clicked.connect(self.start_export)
        form.addRow(self.export_btn)
        self.export_result = QPlainTextEdit()
        self.export_result.setReadOnly(True)
        form.addRow(self.export_result)
        self.tabs.addTab(ex, "导出")
        return self.tabs

    # ---------------------------------------------------------- 数据刷新
    def reload(self):
        self.file_list.clear()
        for f in self._files:
            QListWidgetItem(f, self.file_list)
        self.pres = load_presentation(self._files) if self._files else None
        self._refresh_overview()
        self._refresh_diag()
        self._refresh_export_ranges()
        self.seg_combo.clear()
        if self.pres:
            for s in self.pres.segments:
                self.seg_combo.addItem(s.label)

    def _refresh_overview(self):
        self.track_table.setRowCount(0)
        self.seg_table.setRowCount(0)
        pres = self.pres
        if not pres:
            return
        tracks = pres.tracks
        totals = {tid: 0 for tid in tracks}
        for s in pres.segments:
            for ft in s.frag_tracks:
                if ft.track_id in totals:
                    totals[ft.track_id] += ft.sample_count
        for t in tracks.values():
            r = self.track_table.rowCount()
            self.track_table.insertRow(r)
            param = (f"{t.width}x{t.height}" if t.handler == "vide"
                     else f"{t.sample_rate}Hz/{t.channels}ch")
            for c, val in enumerate([t.track_id, t.kind_label, t.codec,
                                     t.timescale, param, totals.get(t.track_id, 0)]):
                self.track_table.setItem(r, c, QTableWidgetItem(str(val)))
        vids = [t for t in tracks.values() if t.handler == "vide"]
        auds = [t for t in tracks.values() if t.handler == "soun"]
        for s in pres.segments:
            r = self.seg_table.rowCount()
            self.seg_table.insertRow(r)

            def cell(track_list):
                for t in track_list:
                    rng = s.track_pts_range_sec(t.track_id, t.timescale)
                    n = 0
                    for ft in s.frag_tracks:
                        if ft.track_id == t.track_id:
                            n = ft.sample_count
                    if rng:
                        return f"[{rng[0]:.3f}..{rng[1]:.3f}]s {n}样本"
                return "-"

            status = "；".join(s.issues) if s.issues else "正常"
            vals = [s.order, os.path.basename(s.path),
                    s.sequence_number, cell(vids), cell(auds), status]
            for c, val in enumerate(vals):
                item = QTableWidgetItem(str(val))
                if s.issues and c == 5:
                    item.setForeground(QColor(200, 60, 60))
                self.seg_table.setItem(r, c, item)

    def _refresh_diag(self):
        self.diag_text.clear()
        pres = self.pres
        if not pres:
            return
        lines = []
        for tid, cov in pres.coverage.items():
            t = pres.tracks.get(tid)
            label = f"轨{tid}({t.kind_label})" if t else f"轨{tid}"
            ivs = ", ".join(f"[{a:.3f}s..{b:.3f}s]" for a, b in cov)
            lines.append(f"覆盖 {label}: {ivs}")
        cc = common_coverage(pres)
        if len(pres.coverage) > 1:
            ivs = ", ".join(f"[{a:.3f}s..{b:.3f}s]" for a, b in cc)
            lines.append(f"共同覆盖: {ivs}")
        lines.append("")
        if not pres.issues:
            lines.append("未发现问题")
        for i in pres.issues:
            mark = "✗" if i.severity == "error" else "△"
            lines.append(f"{mark} [{i.category}] {i.message}")
        self.diag_text.setPlainText("\n".join(lines))

    def _refresh_export_ranges(self):
        self.range_combo.clear()
        if not self.pres:
            return
        for a, b in common_coverage(self.pres):
            self.range_combo.addItem(f"[{a:.3f}s .. {b:.3f}s]", (a, b))
        if self.range_combo.count():
            self._range_changed(0)

    def _range_changed(self, idx: int):
        data = self.range_combo.itemData(idx)
        if data:
            self.start_spin.setValue(data[0])
            self.end_spin.setValue(data[1])

    # ---------------------------------------------------------- 预览
    def _preview_selected_row(self, item):
        row = item.row()
        if 0 <= row < self.seg_combo.count():
            self.seg_combo.setCurrentIndex(row)
            self.tabs.setCurrentIndex(2)
            self.start_preview()

    def start_preview(self):
        pres = self.pres
        idx = self.seg_combo.currentIndex()
        if not pres or not (0 <= idx < len(pres.segments)):
            return
        seg = pres.segments[idx]
        self.decode_btn.setEnabled(False)
        self.preview_info.setPlainText("解码中…")
        job = _Job(decode_preview, pres, seg)
        job.signals.done.connect(lambda res: self._preview_done(res, seg))
        self._pending.append(job)
        job.signals.done.connect(lambda _res, j=job: self._discard(j))
        self.pool.start(job)

    def _preview_done(self, res, seg: Segment):
        self.decode_btn.setEnabled(True)
        result, err = res
        if err:
            self.preview_info.setPlainText(f"解码失败: {err}")
            return
        self._preview = result
        pres = self.pres
        lines = []
        for ft in seg.frag_tracks:
            t = pres.tracks.get(ft.track_id)
            if not t or not t.timescale:
                continue
            rng = ft.pts_range_sec(t.timescale)
            dec = result.video if t.handler == "vide" else result.audio
            kind = "视频" if t.handler == "vide" else "音频"
            sample_pts = ft.sample_pts_sec(t.timescale)
            if rng:
                lines.append(
                    f"{kind}轨 {ft.track_id}: 样本 {ft.sample_count} 个, "
                    f"显示时间 [{rng[0]:.3f}s .. {rng[1]:.3f}s]")
            if dec and dec.frame_count:
                dr = dec.pts_range
                lines.append(
                    f"  实际解码 {dec.frame_count} 帧, "
                    f"可解码到 PTS {dr[1]:.3f}s"
                    + ("" if dec.frame_count == ft.sample_count
                       else f"  ⚠ 比样本表少 {ft.sample_count - dec.frame_count} 帧"
                            f" (数据不完整)"))
            elif dec is not None:
                lines.append("  未能解码出任何帧")
        for e in result.errors:
            lines.append("错误: " + e)
        self.preview_info.setPlainText("\n".join(lines))

        self.thumbs.clear()
        for pts, png in result.thumbnails:
            item = QListWidgetItem(f"{pts:.3f}s")
            item.setIcon(self._icon(png))
            self.thumbs.addItem(item)
        self.wave.set_pcm(result.pcm)
        if result.audio and result.audio.frame_count:
            dr = result.audio.pts_range
            self.audio_label.setText(
                f"音频: 解码 {result.audio.frame_count} 帧, "
                f"PTS [{dr[0]:.3f}s .. {dr[1]:.3f}s], "
                f"峰值 {result.audio_peak:.3f}, RMS {result.audio_rms:.3f}")
        else:
            self.audio_label.setText("音频: 无")

    def _icon(self, path):
        from PySide6.QtGui import QIcon
        return QIcon(QPixmap(path))

    # ---------------------------------------------------------- 导出
    def _pick_out(self):
        p, _ = QFileDialog.getSaveFileName(self, "导出到", self.out_edit.text(),
                                           "MP4 文件 (*.mp4)")
        if p:
            self.out_edit.setText(p)

    def start_export(self):
        pres = self.pres
        if not pres:
            return
        out = self.out_edit.text().strip()
        if not out:
            QMessageBox.warning(self, "导出", "请指定输出文件")
            return
        self.export_btn.setEnabled(False)
        self.export_result.setPlainText("导出中…")
        job = _Job(export_range, pres, self.start_spin.value(),
                   self.end_spin.value(), out, self.reencode_box.isChecked())
        job.signals.done.connect(self._export_done)
        self._pending.append(job)
        job.signals.done.connect(lambda _res, j=job: self._discard(j))
        self.pool.start(job)

    def _discard(self, job):
        try:
            self._pending.remove(job)
        except ValueError:
            pass

    def _export_done(self, res):
        self.export_btn.setEnabled(True)
        rep, err = res
        if err:
            self.export_result.setPlainText(f"导出失败: {err}")
            return
        lines = list(rep.messages)
        lines.append("使用片段: " + ", ".join(rep.segments_used))
        for ctype, (a, b, n) in rep.achieved.items():
            lines.append(f"读回 {ctype}: [{a:.3f}s .. {b:.3f}s] {n} 包 "
                         f"(时长 {b - a:.3f}s)")
        lines.append("结论: " + ("范围核对通过 ✓" if rep.ok else "范围核对未通过 ✗"))
        self.export_result.setPlainText("\n".join(lines))


def run_gui(files: List[str]) -> int:
    app = QApplication(sys.argv[:1])
    w = MainWindow(files)
    w.show()
    return app.exec()
