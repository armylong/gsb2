"""主窗口: 载入、手调区间、拼接、双向定位试听、导出。"""

from __future__ import annotations

import os
from typing import List, Optional, Tuple

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QColor
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDoubleSpinBox,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QStatusBar,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from . import annotations as ann_io
from . import wavfile
from .model import (
    CONFLICT,
    EDIT,
    TOO_SHORT,
    EditRegion,
    apply_edits,
    build_plan,
    find_conflicts,
    format_time,
)
from .player import ArrayPlayer
from .waveform import WaveformView

PRE_ROLL_S = 1.0
POST_ROLL_S = 1.5
DEFAULT_TRANSITION_MS = 30.0
DEFAULT_KEEP_MS = 120.0


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("本地停顿整理工具 — 只对手工确认过的区间动刀")
        self.resize(1280, 860)

        self.audio: Optional[wavfile.AudioData] = None
        self.regions: List[EditRegion] = []
        self.marks: List[Tuple[str, int]] = []
        self.ann_path: Optional[str] = None
        self.plan = []
        self.engine = None
        self._loading_table = False
        self.player = ArrayPlayer(self)

        self._build_ui()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        bar = self.addToolBar("主工具栏")
        bar.setMovable(False)
        self.act_open_wav = QAction("打开 WAV…", self)
        self.act_open_ann = QAction("打开标注…", self)
        self.act_rebuild = QAction("重新拼接", self)
        self.act_export = QAction("导出成品与对照…", self)
        self.act_zoom = QAction("全景", self)
        for act in (self.act_open_wav, self.act_open_ann, self.act_rebuild,
                    self.act_export, self.act_zoom):
            bar.addAction(act)
        bar.addSeparator()
        bar.addWidget(QLabel("  过渡上限(ms): "))
        self.spin_transition = QDoubleSpinBox()
        self.spin_transition.setRange(0.0, 2000.0)
        self.spin_transition.setValue(DEFAULT_TRANSITION_MS)
        self.spin_transition.setSingleStep(5.0)
        bar.addWidget(self.spin_transition)

        self.act_open_wav.triggered.connect(self.choose_wav)
        self.act_open_ann.triggered.connect(self.choose_annotation)
        self.act_rebuild.triggered.connect(self.rebuild)
        self.act_export.triggered.connect(self.export_dialog)
        self.act_zoom.triggered.connect(self.zoom_all)
        self.spin_transition.valueChanged.connect(self.rebuild)

        self.view_src = WaveformView("原声 (可手调: 拖边/拖体, 空白处框选新区间)", editable=True)
        self.view_dst = WaveformView("成品 (只读; 红三角=硬切点, 绿带=交叉淡变)", editable=False)

        btn_play_src = QPushButton("试听指针附近·原声")
        btn_stop_src = QPushButton("停止")
        btn_play_dst = QPushButton("试听指针附近·成品")
        btn_stop_dst = QPushButton("停止")
        btn_play_src.clicked.connect(lambda: self.preview(self.view_src, "src"))
        btn_play_dst.clicked.connect(lambda: self.preview(self.view_dst, "dst"))
        btn_stop_src.clicked.connect(self.player.stop)
        btn_stop_dst.clicked.connect(self.player.stop)

        src_btns = QHBoxLayout()
        src_btns.addWidget(btn_play_src)
        src_btns.addWidget(btn_stop_src)
        src_btns.addStretch(1)
        dst_btns = QHBoxLayout()
        dst_btns.addWidget(btn_play_dst)
        dst_btns.addWidget(btn_stop_dst)
        dst_btns.addStretch(1)

        src_box = QWidget()
        sb = QVBoxLayout(src_box)
        sb.setContentsMargins(4, 4, 4, 4)
        sb.addWidget(self.view_src, 1)
        sb.addLayout(src_btns)

        dst_box = QWidget()
        db = QVBoxLayout(dst_box)
        db.setContentsMargins(4, 4, 4, 4)
        db.addWidget(self.view_dst, 1)
        db.addLayout(dst_btns)

        split_v = QSplitter(Qt.Orientation.Vertical)
        split_v.addWidget(src_box)
        split_v.addWidget(dst_box)
        split_v.setSizes([480, 300])

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["#", "起点(采样)", "终点(采样)",
                                              "保留(ms)", "状态/告警"])
        self.table.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch
        )
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.itemSelectionChanged.connect(self._table_selection)
        self.table.cellChanged.connect(self._table_edited)

        split_h = QSplitter(Qt.Orientation.Horizontal)
        split_h.addWidget(split_v)
        split_h.addWidget(self.table)
        split_h.setSizes([900, 360])
        self.setCentralWidget(split_h)

        self.setStatusBar(QStatusBar())
        self.lbl_stats = QLabel("尚未载入音频")
        self.lbl_conflict = QLabel("")
        self.statusBar().addWidget(self.lbl_stats, 2)
        self.statusBar().addWidget(self.lbl_conflict, 1)

        # 信号
        self.view_src.region_create_requested.connect(self.add_region)
        self.view_src.region_changed.connect(self.rebuild)
        self.view_src.region_selected.connect(self._select_region_on_view)
        self.view_src.cursor_changed.connect(self._on_src_cursor)
        self.view_src.double_clicked.connect(lambda _s: self.preview(self.view_src, "src"))
        self.view_dst.cursor_changed.connect(self._on_dst_cursor)
        self.view_dst.double_clicked.connect(lambda _s: self.preview(self.view_dst, "dst"))

    # ------------------------------------------------------------- 载入
    def choose_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择 WAV", "", "WAV (*.wav)")
        if path:
            sidecar = path.rsplit(".", 1)[0] + ".annotations.json"
            self.load_files(path, sidecar if os.path.exists(sidecar) else None)

    def choose_annotation(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择标注 JSON", "", "标注 (*.json)")
        if path:
            if self.audio is None:
                QMessageBox.information(self, "提示", "请先打开 WAV")
                return
            self._load_annotation(path)
            self.rebuild()

    def load_files(self, wav_path: str, ann_path: Optional[str]) -> None:
        try:
            self.audio = wavfile.read_wav(wav_path)
        except Exception as e:  # noqa: BLE001
            QMessageBox.critical(self, "WAV 读取失败", str(e))
            return
        self.regions, self.marks = [], []
        self.ann_path = ann_path
        self.view_src.set_audio(self.audio.samples, self.audio.sample_rate)
        self.view_dst.set_audio(self.audio.samples, self.audio.sample_rate)
        if ann_path:
            self._load_annotation(ann_path)
        self.setWindowTitle(f"本地停顿整理工具 — {os.path.basename(wav_path)}")
        self.rebuild()

    def _load_annotation(self, path: str) -> None:
        try:
            af = ann_io.load_annotations(path, self.audio.sample_rate)
        except Exception as e:  # noqa: BLE001
            QMessageBox.critical(self, "标注读取失败", str(e))
            return
        self.marks = af.marks
        self.regions = af.regions
        self.ann_path = path
        self.view_src.set_marks(self.marks)
        self.view_dst.set_marks(self.marks)

    # ------------------------------------------------------------- 区间编辑
    def add_region(self, start: int, end: int) -> None:
        if self.audio is None:
            return
        self.regions.append(EditRegion(start, end, keep_ms=DEFAULT_KEEP_MS))
        self.view_src.selected_region = len(self.regions) - 1
        self.rebuild()

    def delete_selected_region(self) -> None:
        idx = self.view_src.selected_region
        if 0 <= idx < len(self.regions):
            del self.regions[idx]
            self.view_src.selected_region = -1
            self.rebuild()

    def keyPressEvent(self, event):  # noqa: N802
        # 在窗口层统一处理删除键: 无论焦点在波形还是表格都能删掉选中区间
        if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            idx = self.view_src.selected_region
            if 0 <= idx < len(self.regions):
                self.delete_selected_region()
                return
        super().keyPressEvent(event)

    def _select_region_on_view(self, idx: int) -> None:
        if 0 <= idx < self.table.rowCount():
            self.table.selectRow(idx)

    def _table_selection(self) -> None:
        rows = self.table.selectionModel().selectedRows()
        if rows:
            idx = rows[0].row()
            self.view_src.selected_region = idx
            self.view_src.update()

    def _table_edited(self, row: int, col: int) -> None:
        if self._loading_table or self.audio is None:
            return
        if col == 1:
            self.regions[row].start = int(self.table.item(row, 1).text())
        elif col == 2:
            self.regions[row].end = int(self.table.item(row, 2).text())
        elif col == 3:
            self.regions[row].keep_ms = float(self.table.item(row, 3).text())
        self.rebuild()

    # ------------------------------------------------------------- 拼接
    def rebuild(self) -> None:
        if self.audio is None:
            return
        n = self.audio.n_samples
        sr = self.audio.sample_rate
        self.plan = build_plan(n, sr, self.regions, self.spin_transition.value())
        self.engine = apply_edits(self.audio.samples, sr, self.plan)

        self.view_src.set_regions(self.regions, self.plan)
        self.view_src.set_marks(self.marks)
        self.view_dst.set_audio(self.engine.output, sr)
        self.view_dst.set_feedback(self.engine.junctions, self.engine.deleted)
        # 成品视图的标注: 未删点按映射落点; 被删点用红虚线画在对应拼接点
        dst_marks = []
        orphan_marks = []
        for label, src in self.marks:
            m = self.engine.map_source(src)
            if m.kind != "deleted":
                dst_marks.append((label, m.dst_sample))
            else:
                orphan_marks.append((label, m.dst_sample))
        self.view_dst.set_marks(dst_marks)
        self.view_dst.set_orphan_marks(orphan_marks)

        self._refresh_table()
        self._refresh_status()

    def _refresh_table(self) -> None:
        self._loading_table = True
        self.table.setRowCount(len(self.plan))
        status_text = {
            EDIT: "执行",
            CONFLICT: "冲突·不动",
            TOO_SHORT: "太短·放过",
            "invalid": "非法·跳过",
        }
        for row, pr in enumerate(self.plan):
            warn = "；".join(pr.warnings)
            status = status_text.get(pr.status, pr.status)
            cells = [
                str(row),
                str(pr.region.start),
                str(pr.region.end),
                f"{pr.region.keep_ms:g}",
                f"{status} {('｜' + warn) if warn else ''}",
            ]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if col in (0, 4):
                    item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                if pr.status == CONFLICT:
                    item.setForeground(QColor(220, 70, 60))
                elif pr.status == TOO_SHORT:
                    item.setForeground(QColor(210, 160, 40))
                if warn:
                    item.setToolTip(warn)
                self.table.setItem(row, col, item)
        self._loading_table = False

    def _refresh_status(self) -> None:
        eng = self.engine
        conflicts = find_conflicts(self.regions)
        self.lbl_stats.setText(
            f"原声 {eng.n_src} 帧 ({eng.n_src / eng.sample_rate:.3f}s)  →  "
            f"成品 {eng.n_dst} 帧 ({eng.n_dst / eng.sample_rate:.3f}s) ｜ "
            f"真删 {eng.deleted_count()} 帧 ｜ 淡变叠加 {eng.total_removed() - eng.deleted_count()} 帧 ｜ "
            f"拼接点 {len(eng.junctions)} ｜ 硬切 {sum(1 for sp in eng.deleted if sp.dst_start == sp.dst_end)}"
        )
        if conflicts:
            detail = "；".join(
                f"#{c.index_a}↔#{c.index_b}({c.reason})" for c in conflicts
            )
            self.lbl_conflict.setText(f"⚠ 冲突 {len(conflicts)} 对, 相关区间已整体冻结: {detail}")
            self.lbl_conflict.setStyleSheet("color: #ff6b60; font-weight: 600;")
        else:
            self.lbl_conflict.setText("无区间冲突")
            self.lbl_conflict.setStyleSheet("color: #4ade80;")

    def zoom_all(self) -> None:
        self.view_src.zoom_all()
        if self.engine:
            self.view_dst.zoom_all()

    # ------------------------------------------------------------- 双向定位
    def _window(self, samples: np.ndarray, center: int,
                pre: int, post: int) -> Tuple[np.ndarray, int, int]:
        n = samples.shape[0]
        s0 = max(0, center - pre)
        s1 = min(n, center + post)
        return samples[s0:s1], s0, s1

    def _on_src_cursor(self, src_sample: int) -> None:
        if self.engine is None:
            return
        m = self.engine.map_source(src_sample)
        if m.kind == "deleted":
            sp = self.engine.is_source_deleted(src_sample)
            self.view_dst.set_cursor(sp.dst_start if sp else 0)
            self.view_dst.set_highlight(
                [(sp.dst_start, min(self.engine.n_dst, sp.dst_start + 1))] if sp else [],
                f"原声 {format_time(self.engine.sample_rate, src_sample)} 在被删段内 → "
                f"对应拼接点 {format_time(self.engine.sample_rate, sp.dst_start) if sp else ''}",
                QColor(235, 64, 52),
            )
            self.view_src.set_highlight(
                [(sp.src_start, sp.src_end)] if sp else [],
                "此帧属于被删段", QColor(235, 64, 52),
            )
        else:
            self.view_dst.set_cursor(m.dst_sample)
            self.view_dst.set_highlight(
                [(max(0, m.dst_sample - 40), m.dst_sample + 40)],
                f"原声 {format_time(self.engine.sample_rate, src_sample)} → "
                f"成品 {format_time(self.engine.sample_rate, m.dst_sample)}",
            )
            self.view_src.clear_highlight()

    def _on_dst_cursor(self, dst_sample: int) -> None:
        if self.engine is None:
            return
        sources = self.engine.map_destination(dst_sample)
        ranges = [(max(0, sm.src_sample - 40), sm.src_sample + 40) for sm in sources]
        if len(sources) == 2:
            label = (
                f"成品 {format_time(self.engine.sample_rate, dst_sample)} 是交叉淡变, "
                f"由原声两处合成: {format_time(self.engine.sample_rate, sources[0].src_sample)}"
                f" + {format_time(self.engine.sample_rate, sources[1].src_sample)}"
            )
            color = QColor(46, 204, 113)
        else:
            label = (
                f"成品 {format_time(self.engine.sample_rate, dst_sample)} ← "
                f"原声 {format_time(self.engine.sample_rate, sources[0].src_sample)}"
            )
            color = QColor(90, 170, 255)
        self.view_src.set_highlight(ranges, label, color)
        self.view_src.set_cursor(sources[0].src_sample, move_view=False)
        if not (self.view_src.view_start <= sources[0].src_sample < self.view_src.view_end):
            self.view_src.center_on(sources[0].src_sample)

    # ------------------------------------------------------------- 试听
    def preview(self, view: WaveformView, which: str) -> None:
        if self.audio is None:
            return
        sr = self.audio.sample_rate
        pre = int(PRE_ROLL_S * sr)
        post = int(POST_ROLL_S * sr)
        if which == "src":
            window, s0, s1 = self._window(self.audio.samples, view.cursor, pre, post)
        else:
            window, s0, s1 = self._window(self.engine.output, view.cursor, pre, post)
        err = self.player.play_window(window, sr, window.shape[1])
        if err:
            self.statusBar().showMessage(f"试听不可用: {err}", 4000)
        else:
            self.statusBar().showMessage(
                f"试听 {('原声' if which == 'src' else '成品')} "
                f"{format_time(sr, s0)} – {format_time(sr, s1)}", 3000
            )

    # ------------------------------------------------------------- 导出
    def export_dialog(self) -> None:
        if self.engine is None:
            QMessageBox.information(self, "提示", "请先载入音频")
            return
        base, _ = QFileDialog.getSaveFileName(
            self, "导出成品 (将自动生成 .wav/.annotations.json/.map.json/.map.csv)",
            "edited", "")
        if not base:
            return
        try:
            n_orphan = self.export_outputs(base)
        except Exception as e:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(e))
            return
        QMessageBox.information(
            self, "导出完成",
            f"已写出:\n{base}.wav\n{base}.annotations.json\n{base}.map.json\n{base}.map.csv\n\n"
            f"落在被删段里的标注点: {n_orphan} 个 (已在标注文件 deleted_marks 与对照文件列出)",
        )

    def export_outputs(self, base: str) -> int:
        """供 GUI 与冒烟测试共用。返回被删标注点数量。"""
        sr = self.engine.sample_rate
        clipped = wavfile.write_wav(
            base + ".wav",
            wavfile.AudioData(self.engine.output, sr),
            sampwidth=2,
        )
        remapped = ann_io.export_annotations(base + ".annotations.json",
                                             self.engine, self.marks)
        ann_io.export_mapping(base + ".map.json", self.engine)
        ann_io.export_mapping_csv(base + ".map.csv", self.engine)
        orphans = [m for m in remapped if m.deleted]
        if clipped:
            self.statusBar().showMessage(f"注意: {clipped} 帧超界被限幅", 6000)
        return len(orphans)
