"""Main window for the CueCut local audition/split tool."""

from __future__ import annotations

import os
import sys
from fractions import Fraction
from typing import List, Optional, Sequence, Tuple

from PySide6.QtCore import QSize, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QColor, QFont, QKeySequence, QPalette
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressDialog,
    QPushButton,
    QRadioButton,
    QSlider,
    QSizePolicy,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from . import widgets
from ..audio import AudioSource, OverviewPeaks, PreviewPlayer
from ..cue import parse_cue, validate_against_audio
from ..demo import generate_demo
from ..exporter import (
    ExportResult,
    export_plan,
    verify_exported_head_tail,
)
from ..model import AudioInfo, CueSheet
from ..plan import (
    Junction,
    Plan,
    SplitMode,
    boundary_points,
    build_plan,
    intrinsic_regions,
    in_track_offset,
    junctions,
    member_track_index,
)
from ..timeutil import format_clock, format_mmssff, sample_at, time_at

STATE_COLORS = {
    "head": QColor("#f0a64a"),
    "lead": QColor("#e05d5d"),
    "track": QColor("#4cc9f0"),
}

APP_STYLE = """
QMainWindow, QWidget { background: #12151b; color: #d7dee8; }
QGroupBox { border: 1px solid #2a313c; border-radius: 4px; margin-top: 14px;
            padding: 8px 8px 8px 8px; font-weight: 600; }
QGroupBox::title { subcontrol-origin: margin; left: 8px; padding: 0 4px;
                   color: #8e9aab; }
QPushButton, QToolButton { background: #202733; border: 1px solid #2f3846;
                           border-radius: 4px; padding: 4px 10px; color: #d7dee8; }
QPushButton:hover, QToolButton:hover { background: #283142; }
QPushButton:pressed { background: #171d26; }
QPushButton:checked { background: #2d6a82; border-color: #4cc9f0; }
QPushButton:disabled { color: #5b6675; border-color: #232a34; }
QComboBox, QLineEdit, QDoubleSpinBox, QPlainTextEdit {
    background: #171d26; border: 1px solid #2f3846; border-radius: 3px;
    padding: 3px 6px; color: #d7dee8; }
QComboBox::drop-down { border: none; }
QComboBox QAbstractItemView { background: #171d26; color: #d7dee8;
                              selection-background-color: #2d4b60; }
QListWidget { background: #141922; border: 1px solid #262d37; border-radius: 3px; }
QTableWidget { background: #141922; gridline-color: #222a34;
               border: 1px solid #262d37; }
QHeaderView::section { background: #1c232d; color: #8e9aab; border: none;
                       border-right: 1px solid #262d37; border-bottom: 1px solid #262d37;
                       padding: 4px; }
QTabWidget::pane { border: 1px solid #262d37; }
QTabBar::tab { background: #1a1f27; color: #8e9aab; padding: 6px 12px;
               border: 1px solid #262d37; border-bottom: none; }
QTabBar::tab:selected { background: #232b37; color: #d7dee8; }
QSlider::groove:horizontal { height: 4px; background: #2a313c; border-radius: 2px; }
QSlider::handle:horizontal { background: #4cc9f0; width: 12px; margin: -5px 0;
                             border-radius: 5px; }
QSplitter::handle { background: #1d232c; }
QLabel#hint { color: #7f8c9d; }
QLabel#fileLabel { color: #a9b5c5; }
QLabel#bad { color: #e05d5d; }
QLabel#good { color: #5fd68a; }
"""


def _fmt_samples(n: int) -> str:
    return f"{n:,}".replace(",", " ")


def _owner_state(
    sheet: CueSheet, info: AudioInfo, sample: int, plan: Optional[Plan] = None
) -> Tuple[str, str, QColor]:
    """(state key, human text, colour) for a source sample.

    The state key is intrinsic to the sheet (head lead / lead / in track).
    When a plan is supplied the text also says which output file will
    actually receive this sample in the current split mode.
    """
    owner_file = ""
    if plan is not None:
        owner = plan.owner_of_sample(sample)
        if owner is not None:
            owner_file = owner.file_name
    idx = member_track_index(sheet, info, sample)
    if idx < 0:
        if not sheet.tracks:
            return "head", "无轨道", STATE_COLORS["head"]
        first = sheet.tracks[0]
        off = sample - sample_at(first.start, info.samplerate)
        where = owner_file or "（尚未规划）"
        return (
            "head",
            f"整卷前导 · 距 T{first.number:02d} 正式起点 {abs(off)} 采样 · 写入 {where}",
            STATE_COLORS["head"],
        )
    tr = sheet.tracks[idx]
    start = sample_at(tr.start, info.samplerate)
    if sample < start:
        where = owner_file or "（未规划）"
        return (
            "lead",
            f"T{tr.number:02d} 前导 · 距正式起点倒计时 {start - sample} 采样 · 写入 {where}",
            STATE_COLORS["lead"],
        )
    where = owner_file or "（未规划）"
    return (
        "track",
        f"T{tr.number:02d} 轨内 · 距正式起点 +{sample - start} 采样 · 写入 {where}",
        STATE_COLORS["track"],
    )


class CueOverview(QWidget):
    """Whole-sheet list: each track's sheet time, sample position and lead."""

    trackSelected = Signal(int)  # sheet index

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        title = QLabel("分轨表总览（与时间尺同一套绝对值）")
        title.setObjectName("hint")
        layout.addWidget(title)
        self.list = QListWidget()
        self.list.setFont(QFont("Menlo", 9))
        self.list.setWordWrap(True)
        self.list.itemSelectionChanged.connect(self._emit_selection)
        layout.addWidget(self.list, 1)
        self._info: Optional[AudioInfo] = None
        self._sheet: Optional[CueSheet] = None
        self._names: List[str] = []

    @staticmethod
    def _row_text(i: int, tr, start_s: int, lead_s, end: int, sr: int, name: str) -> str:
        head = f"{tr.number:02d}  {tr.title or '（无标题）'}"
        line1 = f"{head}   INDEX 01 {format_mmssff(tr.start)} = 采样 {start_s}"
        if lead_s is not None:
            line2 = (
                f"INDEX 00 {format_mmssff(tr.lead)} = 采样 {lead_s}"
                f"（前导 {start_s - lead_s}）"
            )
        else:
            line2 = "无前导"
        line3 = f"时长 {format_clock(time_at(max(0, end - start_s), sr))} → {name}"
        return f"{line1}\n{line2}\n{line3}"

    def set_data(self, sheet: CueSheet, info: AudioInfo, names: Sequence[str]) -> None:
        self._sheet = sheet
        self._info = info
        self._names = list(names)
        selected = self.list.currentRow()
        self.list.blockSignals(True)
        self.list.clear()
        sr = info.samplerate
        for i, tr in enumerate(sheet.tracks):
            start_s = sample_at(tr.start, sr)
            lead_s = sample_at(tr.lead, sr) if tr.lead is not None else None
            end = (
                sample_at(sheet.tracks[i + 1].start, sr)
                if i + 1 < len(sheet.tracks)
                else info.total_samples
            )
            name = self._names[i] if i < len(self._names) else "?"
            item = QListWidgetItem(self._row_text(i, tr, start_s, lead_s, end, sr, name))
            item.setSizeHint(QSize(0, 54))
            item.setData(Qt.UserRole, i)
            item.setToolTip(
                f"INDEX 01 {format_mmssff(tr.start)} = 采样 {start_s}\n"
                f"INDEX 00 {format_mmssff(tr.lead) if tr.lead is not None else '—'}"
                f"{' = 采样 ' + str(lead_s) if lead_s is not None else ''}\n"
                f"写入 {name}"
            )
            self.list.addItem(item)
        if 0 <= selected < self.list.count():
            self.list.setCurrentRow(selected)
        self.list.blockSignals(False)

    def _emit_selection(self) -> None:
        row = self.list.currentRow()
        if row >= 0:
            self.trackSelected.emit(row)

    def select_row(self, index: int) -> None:
        self.list.blockSignals(True)
        self.list.setCurrentRow(index)
        self.list.blockSignals(False)

    def clear(self) -> None:
        self.list.blockSignals(True)
        self.list.clear()
        self.list.blockSignals(False)


class JunctionPanel(QGroupBox):
    """Audition a boundary and flip split modes without moving the sound."""

    auditionRequested = Signal(int, int)  # first, last (inclusive)
    stopRequested = Signal()
    modeChanged = Signal(str)
    junctionSelected = Signal(int)  # source sample at the junction point

    def __init__(self, parent=None):
        super().__init__("交界试听：切拆法，声音不换时间", parent)
        layout = QVBoxLayout(self)
        layout.setSpacing(6)

        self.junction_combo = QComboBox()
        self.junction_combo.setToolTip("选择一条交界（该轨的 INDEX 00 / INDEX 01）")
        layout.addWidget(self.junction_combo)

        row = QHBoxLayout()
        self.btn_play = QPushButton("▶ 试听交界")
        self.btn_stop = QPushButton("■ 停止")
        self.btn_loop = QPushButton("↻ 循环")
        self.btn_loop.setCheckable(True)
        for b in (self.btn_play, self.btn_stop, self.btn_loop):
            row.addWidget(b)
        row.addSpacing(6)
        row.addWidget(QLabel("前后"))
        self.seconds = QDoubleSpinBox()
        self.seconds.setRange(0.5, 30.0)
        self.seconds.setValue(4.0)
        self.seconds.setSingleStep(0.5)
        self.seconds.setSuffix(" 秒")
        row.addWidget(self.seconds)
        row.addStretch(1)
        layout.addLayout(row)

        mode_row = QHBoxLayout()
        self.btn_mode_tail = QPushButton(SplitMode.TAIL.label)
        self.btn_mode_head = QPushButton(SplitMode.HEAD.label)
        for b, mode in ((self.btn_mode_tail, SplitMode.TAIL), (self.btn_mode_head, SplitMode.HEAD)):
            b.setCheckable(True)
            b.setToolTip(mode.label)
            b.clicked.connect(lambda _=False, m=mode: self.modeChanged.emit(m.value))
            mode_row.addWidget(b)
        self.btn_mode_tail.setChecked(True)
        layout.addLayout(mode_row)

        self.info = QLabel("—")
        self.info.setWordWrap(True)
        self.info.setObjectName("hint")
        self.info.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
        layout.addWidget(self.info)

        self.split_label = QLabel("—")
        self.split_label.setWordWrap(True)
        self.split_label.setMinimumHeight(58)
        self.split_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
        f = QFont(self.split_label.font())
        f.setPointSizeF(8.5)
        self.split_label.setFont(f)
        self.split_label.setStyleSheet(
            "background: #141922; border: 1px solid #262d37; border-radius: 3px;"
            " padding: 6px 8px; color: #d7dee8;"
        )
        layout.addWidget(self.split_label)
        layout.addStretch(1)

        self.btn_play.clicked.connect(self._audition)
        self.btn_stop.clicked.connect(self.stopRequested)
        self.junction_combo.currentIndexChanged.connect(self._on_combo_changed)

        self._junctions: List[Junction] = []
        self._info_obj: Optional[AudioInfo] = None
        self._plan: Optional[Plan] = None
        self._mode = SplitMode.TAIL

    def set_junctions(self, items: Sequence[Junction], info: AudioInfo) -> None:
        self._junctions = list(items)
        self._info_obj = info
        self.junction_combo.blockSignals(True)
        keep = self.junction_combo.currentIndex()
        self.junction_combo.clear()
        for j in items:
            self.junction_combo.addItem(j.label)
        if 0 <= keep < self.junction_combo.count():
            self.junction_combo.setCurrentIndex(keep)
        self.junction_combo.blockSignals(False)
        self._refresh_info()

    def set_plan(self, plan: Optional[Plan]) -> None:
        self._plan = plan
        self._refresh_info()

    def current_junction(self) -> Optional[Junction]:
        idx = self.junction_combo.currentIndex()
        if idx < 0 or idx >= len(self._junctions):
            return None
        return self._junctions[idx]

    def _audition(self) -> None:
        j = self.current_junction()
        if j is None or self._info_obj is None:
            return
        sr = self._info_obj.samplerate
        seconds = int(self.seconds.value() * sr)
        first = max(0, j.sample - seconds)
        last = min(self._info_obj.total_samples - 1, j.sample + seconds)
        self.auditionRequested.emit(first, last)

    def _describe_split(self, j: Junction, pl: Optional[Plan]) -> str:
        if pl is None:
            return j.owner_text(self._mode)
        lines = []
        for mode in (SplitMode.TAIL, SplitMode.HEAD):
            prev = pl.segment_for_sheet_index(j.sheet_index - 1)
            cur = pl.segment_for_sheet_index(j.sheet_index)
            text = ""
            if j.lead_start is None:
                text = f"无前导，T{j.sheet_index + 1:02d} 自 {j.start} 起"
            if j.lead_start is not None and prev and cur:
                if mode == SplitMode.TAIL:
                    text = (
                        f"{prev.file_name} 收至 {j.start - 1}｜"
                        f"{cur.file_name} 自 {j.start}"
                    )
                else:
                    text = (
                        f"{prev.file_name} 收至 {j.lead_start - 1}｜"
                        f"{cur.file_name} 自 {j.lead_start}"
                    )
            mark = "● " if mode == self._mode else "○ "
            lines.append(mark + mode.short_label + "：" + text)
        return "\n".join(lines)

    def set_mode(self, mode: SplitMode) -> None:
        self._mode = mode
        self.btn_mode_tail.setChecked(mode == SplitMode.TAIL)
        self.btn_mode_head.setChecked(mode == SplitMode.HEAD)
        self._refresh_info()

    def _refresh_info(self) -> None:
        j = self.current_junction()
        if j is None or self._info_obj is None:
            self.info.setText("没有可试听的交界（cue 至少需要两轨）")
            self.split_label.setText("—")
            return
        sr = self._info_obj.samplerate
        self.info.setText(
            f"交界采样 {j.sample}（{format_mmssff(time_at(j.sample, sr))}）"
            + (" · INDEX 00" if j.lead_start is not None else " · INDEX 01")
        )
        self.split_label.setText(self._describe_split(j, self._plan))

    def set_playing(self, playing: bool) -> None:
        self.btn_play.setText("▶ 正在试听" if playing else "▶ 试听交界")

    def _on_combo_changed(self, _index: int) -> None:
        self._refresh_info()
        j = self.current_junction()
        if j is not None:
            self.junctionSelected.emit(j.sample)

    def set_index_for_sample(self, sample: int) -> None:
        """Select the junction nearest to a source sample (jump buttons)."""
        if not self._junctions:
            return
        best = min(range(len(self._junctions)),
                   key=lambda i: abs(self._junctions[i].sample - sample))
        if self.junction_combo.currentIndex() != best:
            self.junction_combo.setCurrentIndex(best)
        else:
            self._refresh_info()


class ExportPanel(QGroupBox):
    """Choose split mode / head handling, see exactly which file each region goes to."""

    modeChanged = Signal(str)
    headLeadChanged = Signal(bool)
    exportRequested = Signal()
    verifyRequested = Signal()

    FIXED_PREFIX = ""

    def __init__(self, parent=None):
        super().__init__("拆分与导出", parent)
        layout = QVBoxLayout(self)
        layout.setSpacing(6)

        mode_row = QHBoxLayout()
        self.radio_tail = QRadioButton("前导归上一轨末尾")
        self.radio_head = QRadioButton("前导归本轨开头")
        self.radio_tail.setChecked(True)
        self.radio_head.setToolTip("INDEX 00 起归当前轨；上一轨向前缩到 INDEX 00 前一采样")
        mode_row.addWidget(self.radio_tail)
        mode_row.addWidget(self.radio_head)
        layout.addLayout(mode_row)

        self.head_check = QCheckBox("整卷最前面的前导单独存成文件（00 - 整卷前导.wav）")
        self.head_check.setChecked(False)
        layout.addWidget(self.head_check)

        self.dir_label = QLabel("尚未导出")
        self.dir_label.setObjectName("hint")
        self.dir_label.setWordWrap(True)
        layout.addWidget(self.dir_label)

        layout.addWidget(self._hline())
        self.seg_table = QTableWidget(0, 6)
        self.seg_table.setHorizontalHeaderLabels(
            ["段", "首采样", "末采样", "采样数", "→ 写入文件", "区间时间"]
        )
        self.seg_table.verticalHeader().setVisible(False)
        self.seg_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.seg_table.setSelectionMode(QTableWidget.SingleSelection)
        self.seg_table.setEditTriggers(QTableWidget.NoEditTriggers)
        header = self.seg_table.horizontalHeader()
        for c in range(6):
            header.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(4, QHeaderView.Stretch)
        header.setStretchLastSection(False)
        layout.addWidget(self.seg_table, 1)

        self.summary = QLabel("—")
        self.summary.setWordWrap(True)
        self.summary.setObjectName("hint")
        layout.addWidget(self.summary)
        self.notes_label = QLabel("")
        self.notes_label.setWordWrap(True)
        self.notes_label.setObjectName("bad")
        self.notes_label.setVisible(False)
        layout.addWidget(self.notes_label)

        row = QHBoxLayout()
        self.btn_export = QPushButton("导出分轨 WAV…")
        self.btn_verify = QPushButton("重新读开已导出文件核头尾")
        self.btn_verify.setToolTip("不重新导出，只重新打开已写入的 wav，逐文件核对首/末采样")
        row.addWidget(self.btn_export)
        row.addWidget(self.btn_verify)
        layout.addLayout(row)

        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMinimumHeight(58)
        self.log.setMaximumHeight(96)
        self.log.setPlaceholderText("导出与核对结果会显示在这里")
        layout.addWidget(self.log)

        self.radio_tail.toggled.connect(
            lambda on: on and self.modeChanged.emit(SplitMode.TAIL.value)
        )
        self.radio_head.toggled.connect(
            lambda on: on and self.modeChanged.emit(SplitMode.HEAD.value)
        )
        self.head_check.toggled.connect(self.headLeadChanged)
        self.btn_export.clicked.connect(self.exportRequested)
        self.btn_verify.clicked.connect(self.verifyRequested)

    def _hline(self) -> QFrame:
        line = QFrame()
        line.setFrameShape(QFrame.HLine)
        line.setFrameShadow(QFrame.Plain)
        line.setStyleSheet("color: #2a313c;")
        return line

    def set_plan(self, plan: Plan) -> None:
        self._plan = plan
        self.btn_export.setEnabled(True)
        self.btn_verify.setEnabled(True)
        info = plan.info
        sr = info.samplerate if info else 44100
        self.seg_table.setRowCount(len(plan.segments))
        for i, seg in enumerate(plan.segments):
            cells = [
                seg.label,
                str(seg.first_sample),
                str(seg.last_sample),
                str(seg.sample_count),
                seg.file_name,
                f"{format_mmssff(time_at(seg.first_sample, sr))} – "
                f"{format_mmssff(time_at(seg.last_sample + 1, sr))}",
            ]
            for c, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if c in (1, 2, 3):
                    item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if c == 5:
                    item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if seg.kind == "head_lead":
                    item.setForeground(QColor("#f0a64a"))
                self.seg_table.setItem(i, c, item)
        problems = plan.ownership_problems()
        if problems:
            self.summary.setText("⚠ " + "；".join(problems))
            self.summary.setObjectName("bad")
        else:
            head_seg = next((s for s in plan.segments if s.kind == "head_lead"), None)
            text = (
                f"✓ 覆盖 [0, {plan.total_samples}) 共 {_fmt_samples(plan.total_samples)} 采样，"
                f"{len(plan.segments)} 个文件，无缝无重。"
            )
            if head_seg:
                text += f" 整卷前导单独成文件（{_fmt_samples(head_seg.sample_count)} 采样）。"
            else:
                text += " 整卷前导并入 T01 文件开头。"
            if plan.notes:
                text += " 注意：" + "；".join(plan.notes)
            self.summary.setText(text)
            self.summary.setObjectName("good" if not plan.notes else "bad")
        self.summary.style().unpolish(self.summary)
        self.summary.style().polish(self.summary)

    def clear_plan(self, reason: str) -> None:
        self._plan = None
        self.seg_table.setRowCount(0)
        self.summary.setText("⚠ " + reason)
        self.summary.setObjectName("bad")
        self.summary.style().unpolish(self.summary)
        self.summary.style().polish(self.summary)
        self.notes_label.setVisible(False)
        self.btn_export.setEnabled(False)
        self.btn_verify.setEnabled(False)

    def set_dir(self, directory: Optional[str]) -> None:
        self.dir_label.setText(
            f"输出目录：{directory}" if directory else "尚未导出（导出时会选择目录）"
        )
        self.dir_label.setToolTip(directory or "")

    def append_log(self, text: str) -> None:
        self.log.appendPlainText(text)

    def clear_log(self) -> None:
        self.log.clear()

    def set_mode_controls(self, mode: SplitMode, head_sep: bool) -> None:
        self.radio_tail.blockSignals(True)
        self.radio_head.blockSignals(True)
        self.radio_tail.setChecked(mode == SplitMode.TAIL)
        self.radio_head.setChecked(mode == SplitMode.HEAD)
        self.radio_tail.blockSignals(False)
        self.radio_head.blockSignals(False)
        self.head_check.blockSignals(True)
        self.head_check.setChecked(head_sep)
        self.head_check.blockSignals(False)


class MainWindow(QMainWindow):
    MAX_ZOOM_SAMPLES = 256
    MIN_ZOOM_SAMPLES = 64

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("CueCut — 连续母带切听与分轨")
        self.resize(1440, 900)

        self.sheet: Optional[CueSheet] = None
        self.info: Optional[AudioInfo] = None
        self.source: Optional[AudioSource] = None
        self.overview: Optional[OverviewPeaks] = None
        self.player: Optional[PreviewPlayer] = None
        self.plan: Optional[Plan] = None
        self.mode = SplitMode.TAIL
        self.head_sep = False
        self.view_first = 0
        self.view_last = 1
        self.cursor = 0
        self._export_dir: Optional[str] = None
        self._last_export: Optional[ExportResult] = None
        self._exported_plan: Optional[Plan] = None
        self._player_was_active = False
        self._overview_painted = False

        self._build_ui()
        self._build_menu()
        self._timer = QTimer(self)
        self._timer.setInterval(33)
        self._timer.timeout.connect(self._on_tick)
        self._timer.start()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        outer = QHBoxLayout(central)
        outer.setContentsMargins(8, 6, 8, 8)
        outer.setSpacing(8)

        # left: source + overview
        left = QWidget()
        left.setMinimumWidth(350)
        left.setMaximumWidth(520)
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)

        src_box = QGroupBox("母带与分轨表")
        sl = QVBoxLayout(src_box)
        row = QHBoxLayout()
        self.btn_open_wav = QPushButton("打开连续 WAV…")
        self.btn_open_cue = QPushButton("打开单文件 CUE…")
        row.addWidget(self.btn_open_wav)
        row.addWidget(self.btn_open_cue)
        sl.addLayout(row)
        row2 = QHBoxLayout()
        self.btn_open_pair = QPushButton("按同名 .cue 自动配对")
        self.btn_demo = QPushButton("生成演示卷")
        row2.addWidget(self.btn_open_pair)
        row2.addWidget(self.btn_demo)
        sl.addLayout(row2)
        self.file_label = QLabel("尚未加载文件")
        self.file_label.setWordWrap(True)
        self.file_label.setObjectName("fileLabel")
        sl.addWidget(self.file_label)
        self.status_label = QLabel("")
        self.status_label.setWordWrap(True)
        self.status_label.setObjectName("hint")
        sl.addWidget(self.status_label)
        lv.addWidget(src_box)

        self.issues = QListWidget()
        self.issues.setMaximumHeight(150)
        self.issues.setWordWrap(True)
        self.issues.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.issues.setToolTip("分轨表问题：点条目可跳到对应行/位置")
        self.issues.itemDoubleClicked.connect(self._issue_activated)
        lv.addWidget(QLabel("分轨表校验"))
        lv.addWidget(self.issues)

        self.cue_overview = CueOverview()
        self.cue_overview.trackSelected.connect(self._on_track_selected)
        lv.addWidget(self.cue_overview, 1)

        # right: ruler/wave + panels
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)

        transport = QHBoxLayout()
        self.btn_zoom_out = QToolButton()
        self.btn_zoom_out.setText("−")
        self.btn_zoom = QToolButton()
        self.btn_zoom.setText("整卷")
        self.btn_zoom_in = QToolButton()
        self.btn_zoom_in.setText("+")
        transport.addWidget(self.btn_zoom_out)
        transport.addWidget(self.btn_zoom)
        transport.addWidget(self.btn_zoom_in)
        transport.addSpacing(8)
        self.btn_prev = QPushButton("◀ 交界")
        self.btn_next = QPushButton("交界 ▶")
        transport.addWidget(self.btn_prev)
        transport.addWidget(self.btn_next)
        transport.addSpacing(16)
        self.chk_state = QLabel()
        self.chk_state.setMinimumWidth(300)
        transport.addWidget(self.chk_state, 1)
        self.btn_play_region = QPushButton("▶ 播放当前区间")
        self.btn_stop = QPushButton("■")
        self.btn_stop.setFixedWidth(38)
        self.chk_loop = QCheckBox("循环")
        transport.addWidget(self.btn_play_region)
        transport.addWidget(self.btn_stop)
        transport.addWidget(self.chk_loop)
        self.vol = QSlider(Qt.Horizontal)
        self.vol.setRange(0, 100)
        self.vol.setValue(100)
        self.vol.setFixedWidth(90)
        self.vol.setToolTip("试听音量")
        transport.addWidget(self.vol)
        rv.addLayout(transport)

        self.strip = widgets.RulerStrip()
        self.strip.setMinimumHeight(280)
        self.strip.seekRequested.connect(self._on_seek)
        self.strip.markerActivated.connect(self._on_track_selected)
        self.strip.hoverSample.connect(self._on_hover)
        self.strip.hoverLeft.connect(self._on_hover_left)

        # bottom: audition + export
        bottom = QWidget()
        bl = QHBoxLayout(bottom)
        bl.setContentsMargins(0, 4, 0, 0)
        bl.setSpacing(8)
        self.junction_panel = JunctionPanel()
        self.junction_panel.setMaximumWidth(470)
        bl.addWidget(self.junction_panel)
        self.export_panel = ExportPanel()
        bl.addWidget(self.export_panel, 1)
        self._bottom = bottom
        bottom.setMinimumHeight(330)
        self._right_split = QSplitter(Qt.Vertical)
        self._right_split.addWidget(self.strip)
        self._right_split.addWidget(bottom)
        self._right_split.setStretchFactor(0, 1)
        self._right_split.setStretchFactor(1, 0)
        self._right_split.setSizes([392, 422])
        rv.addWidget(self._right_split, 1)

        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        outer.addWidget(splitter, 1)

        # wiring
        self.btn_open_wav.clicked.connect(self.open_wav_dialog)
        self.btn_open_cue.clicked.connect(self.open_cue_dialog)
        self.btn_open_pair.clicked.connect(self.open_pair_dialog)
        self.btn_demo.clicked.connect(self.make_demo)
        self.btn_zoom_out.clicked.connect(lambda: self._zoom(4.0))
        self.btn_zoom_in.clicked.connect(lambda: self._zoom(0.25))
        self.btn_zoom.clicked.connect(self._zoom_full)
        self.btn_prev.clicked.connect(lambda: self._jump_junction(-1))
        self.btn_next.clicked.connect(lambda: self._jump_junction(+1))
        self.btn_play_region.clicked.connect(self._play_around_cursor)
        self.btn_stop.clicked.connect(self._stop_audio)
        self.chk_loop.toggled.connect(self._on_loop_toggled)
        self.vol.valueChanged.connect(self._on_volume)
        self.junction_panel.auditionRequested.connect(self._audition_region)
        self.junction_panel.stopRequested.connect(self._stop_audio)
        self.junction_panel.modeChanged.connect(self.set_mode)
        self.junction_panel.junctionSelected.connect(self._on_junction_selected)
        self.export_panel.modeChanged.connect(self.set_mode)
        self.export_panel.headLeadChanged.connect(self.set_head_sep)
        self.export_panel.exportRequested.connect(self.do_export)
        self.export_panel.verifyRequested.connect(self.verify_files)

    def _build_menu(self) -> None:
        menu = self.menuBar()
        file_menu = menu.addMenu("文件")
        act_wav = QAction("打开连续 WAV…", self)
        act_wav.setShortcut(QKeySequence.Open)
        act_wav.triggered.connect(self.open_wav_dialog)
        file_menu.addAction(act_wav)
        act_cue = QAction("打开单文件 CUE…", self)
        act_cue.triggered.connect(self.open_cue_dialog)
        file_menu.addAction(act_cue)
        act_pair = QAction("按同名 .cue 自动配对…", self)
        act_pair.triggered.connect(self.open_pair_dialog)
        file_menu.addAction(act_pair)
        file_menu.addSeparator()
        act_demo = QAction("生成演示卷（已知点声 + 跨边界持续音）…", self)
        act_demo.triggered.connect(self.make_demo)
        file_menu.addAction(act_demo)
        act_selftest = QAction("用演示卷自检拆分与回读…", self)
        act_selftest.triggered.connect(self.run_demo_selftest)
        file_menu.addAction(act_selftest)
        file_menu.addSeparator()
        act_quit = QAction("退出", self)
        act_quit.setShortcut(QKeySequence.Quit)
        act_quit.triggered.connect(self.close)
        file_menu.addAction(act_quit)

        view = menu.addMenu("视图")
        for label, key in (("放大 4×", "="), ("缩小 4×", "-"), ("整卷", "0")):
            act = QAction(label, self)
            act.setShortcut(key)
            if label.startswith("放大"):
                act.triggered.connect(lambda: self._zoom(0.25))
            elif label.startswith("缩小"):
                act.triggered.connect(lambda: self._zoom(4.0))
            else:
                act.triggered.connect(self._zoom_full)
            view.addAction(act)
        act_play = QAction("播放/停止当前区间", self)
        act_play.setShortcut(QKeySequence("Space"))
        act_play.triggered.connect(self._play_around_cursor)
        view.addAction(act_play)

        helpm = menu.addMenu("帮助")
        act_about = QAction("关于 / 使用说明", self)
        act_about.triggered.connect(self.show_about)
        helpm.addAction(act_about)

    # -------------------------------------------------------------- loading
    def open_wav_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择连续母带 WAV", "", "WAV 音频 (*.wav *.WAV);;所有文件 (*)"
        )
        if path:
            self.load_wav(path)

    def open_cue_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择单文件 cue", "", "Cue 分轨表 (*.cue *.CUE);;所有文件 (*)"
        )
        if path:
            self.load_cue(path)

    def open_pair_dialog(self) -> None:
        wav, _ = QFileDialog.getOpenFileName(
            self, "选择 WAV（自动寻找同名 .cue）", "", "WAV 音频 (*.wav);;所有文件 (*)"
        )
        if not wav:
            return
        cue = os.path.splitext(wav)[0] + ".cue"
        if not os.path.exists(cue):
            QMessageBox.warning(
                self,
                "找不到分轨表",
                f"未找到 {os.path.basename(cue)}。\n请手动选择 cue 文件。",
            )
            self.load_wav(wav)
            return
        self.load_wav(wav)
        self.load_cue(cue)

    def load_wav(self, path: str) -> None:
        try:
            source = AudioSource(path)
        except Exception as exc:
            QMessageBox.critical(self, "无法打开 WAV", str(exc))
            return
        self._stop_audio()
        self._close_source()
        self._overview_painted = False
        self._last_export = None
        self._exported_plan = None
        self.source = source
        self.info = source.info
        self.overview = OverviewPeaks(source)
        self.overview.start()
        self.player = PreviewPlayer(source)
        self.player.set_loop(self.chk_loop.isChecked())
        self.player.set_volume(self.vol.value() / 100.0)
        self.view_first = 0
        self.view_last = max(1, self.info.total_samples)
        self.cursor = 0
        self._update_file_label()
        self._refresh()
        self._fill_issues()
        self.status_label.setText(
            f"{self.info.samplerate} Hz · {self.info.channels} 声道 · "
            f"{_fmt_samples(self.info.total_samples)} 采样"
            f"（{format_clock(self.info.duration)}）· {self.info.subtype}"
        )

    def load_cue(self, path: str) -> None:
        try:
            sheet = parse_cue(path)
        except Exception as exc:
            QMessageBox.critical(self, "无法读取 cue", str(exc))
            return
        self.sheet = sheet
        self._last_export = None
        self._exported_plan = None
        if self.info is None:
            self._fill_issues()
            self._update_file_label()
            self.status_label.setText(
                f"已读取 {len(sheet.tracks)} 轨；请再载入对应 WAV 以校验时间点是否落在文件内"
            )
            return
        validate_against_audio(sheet, self.info)
        self._update_file_label()
        self._refresh()
        self._fill_issues()
        if sheet.errors:
            self.status_label.setText(
                f"分轨表有 {len(sheet.errors)} 处需要修正的问题（见左侧“分轨表校验”）"
            )
        else:
            self.status_label.setText(
                f"已读取 {len(sheet.tracks)} 轨，"
                f"错误 0，提示 {len(sheet.warnings)}"
            )

    def make_demo(self) -> None:
        directory = QFileDialog.getExistingDirectory(self, "演示卷输出目录")
        if not directory:
            return
        try:
            truth = generate_demo(directory)
        except Exception as exc:
            QMessageBox.critical(self, "演示卷生成失败", str(exc))
            return
        self.load_wav(truth.path)
        self.load_cue(truth.cue_path)
        self._export_dir = os.path.join(directory, "splits")
        self.export_panel.set_dir(self._export_dir)
        QMessageBox.information(
            self,
            "演示卷已生成",
            "已生成带已知点声和跨边界持续音的母带与 cue，并已加载。\n\n"
            f"WAV：{truth.path}\nCUE：{truth.cue_path}\n\n"
            "可先试听交界，再用「导出分轨 WAV」或菜单「用演示卷自检拆分与回读」。",
        )

    def _close_source(self) -> None:
        if self.player is not None:
            self.player.shutdown()
            self.player = None
        if self.source is not None:
            self.source.close()
            self.source = None
        self._player_was_active = False

    def _update_file_label(self) -> None:
        parts = []
        if self.info:
            parts.append(f"WAV: {os.path.basename(self.info.path)}")
        if self.sheet:
            parts.append(f"CUE: {os.path.basename(self.sheet.filename)}")
        self.file_label.setText("  ·  ".join(parts) if parts else "尚未加载文件")

    # ------------------------------------------------------------- refresh
    def _refresh(self) -> None:
        """Rebuild plan/ownership from current sheet, info, mode, head choice."""
        if self.info is None or self.sheet is None:
            return
        if self.sheet.errors:
            self.export_panel.clear_log()
            self.export_panel.append_log("分轨表有错误，先修正后再拆分。")
            first = self.sheet.errors[0]
            where = f"第 {first.line} 行：" if first.line else ""
            self.export_panel.clear_plan(where + first.message)
            self.plan = None
            self.cue_overview.clear()
            self.strip.set_ownership([], [], None, None)
            self.strip.set_state_regions([])
            self.junction_panel.set_junctions([], self.info)
            self._rebuild_bands()
            self._apply_view()
            self._update_file_label()
            self._update_readout(self.cursor)
            return
        self.plan = build_plan(self.sheet, self.info, self.mode, self.head_sep)
        self.export_panel.set_plan(self.plan)
        self.cue_overview.set_data(
            self.sheet, self.info, [s.file_name for s in self.plan.segments if s.kind == "track"]
        )
        self.junction_panel.set_junctions(junctions(self.sheet, self.info), self.info)
        self.junction_panel.set_plan(self.plan)
        self.junction_panel.set_mode(self.mode)
        self.export_panel.set_mode_controls(self.mode, self.head_sep)
        self._rebuild_bands()
        self._update_cursor_views()

    def _rebuild_bands(self) -> None:
        if self.info is None or self.sheet is None or self.plan is None:
            return
        sr = self.info.samplerate
        markers = [
            widgets.MarkerSpec(
                sample=s,
                kind=kind,
                track=self.sheet.tracks[idx].number,
                title=self.sheet.tracks[idx].title,
            )
            for s, idx, kind in boundary_points(self.sheet, self.info)
        ]
        bands = [
            widgets.Band(
                first=seg.first_sample,
                last=seg.last_sample,
                text=seg.file_name,
                color=(
                    QColor("#8a5a2b")
                    if seg.kind == "head_lead"
                    else QColor("#20405a") if seg.kind == "track" else QColor("#6b2f2f")
                ),
                short_text=(
                    "前导" if seg.kind == "head_lead"
                    else f"T{self.sheet.tracks[seg.sheet_index].number:02d}"
                    if seg.sheet_index >= 0 else seg.label
                ),
            )
            for seg in self.plan.segments
        ]

        def lookup(sample: int):
            return _owner_state(self.sheet, self.info, sample, self.plan)

        def text_at(sample: int) -> str:
            key, text, _ = _owner_state(self.sheet, self.info, sample, self.plan)
            idx = member_track_index(self.sheet, self.info, sample)
            off = Fraction(in_track_offset(self.sheet, self.info, sample, idx), sr)
            return (
                f"{text}\n采样 {sample} · 分轨表 {format_mmssff(time_at(sample, sr))} · "
                f"轨内 {format_clock(off, signed=True)}"
            )

        # intrinsic state regions: lead-in vs song proper, mode-independent
        regions = []
        for first, last, kind, idx in intrinsic_regions(self.sheet, self.info):
            # Only lead regions get a tint; the song proper is the quiet base.
            if kind == "head_lead":
                regions.append((first, last, STATE_COLORS["head"], "整卷前导"))
            elif kind == "lead":
                regions.append(
                    (first, last, STATE_COLORS["lead"],
                     f"T{self.sheet.tracks[idx].number:02d} 前导")
                )
        if self.info:
            self.strip.set_state_regions(regions)
            self.strip.set_ownership(markers, bands, lookup, text_at)
        self.strip.set_view(self.view_first, self.view_last, self.info.samplerate,
                            self.info.total_samples)

    def _recompute_cursor(self, sample: int) -> None:
        self.cursor = max(0, min(sample, (self.info.total_samples - 1) if self.info else 0))
        self._update_cursor_views()

    def _update_readout(self, sample: int, preview: bool = False) -> None:
        if self.info is None or self.sheet is None:
            return
        sr = self.info.samplerate
        key, text, color = _owner_state(self.sheet, self.info, sample, self.plan)
        idx = member_track_index(self.sheet, self.info, sample)
        off = in_track_offset(self.sheet, self.info, sample, idx)
        self.strip.set_readout(
            sample,
            sr,
            format_mmssff(time_at(sample, sr)),
            format_clock(Fraction(off, sr), signed=True),
            text,
            color,
        )
        self.chk_state.setText(text)
        self.chk_state.setStyleSheet(f"color: {color.name()};")
        if preview:
            self.strip.readout.setStyleSheet("border-left: 2px solid #ffd166;")

    def _update_cursor_views(self) -> None:
        # While auditioning, the readout follows the heard position so a
        # mode switch mid-playback keeps the three time readings on the sound.
        playing = self.player is not None and self.player.is_active()
        self._update_readout(self.player.position() if playing else self.cursor)
        self.strip.readout.setStyleSheet("")
        if not playing:
            self.strip.set_playhead(self.cursor)

    def _fill_issues(self) -> None:
        self.issues.clear()
        if self.sheet is None:
            return
        for e in self.sheet.errors:
            item = QListWidgetItem(f"✗ 第 {e.line} 行：{e.message}" if e.line else f"✗ {e.message}")
            item.setForeground(QColor("#e05d5d"))
            item.setData(Qt.UserRole, ("error", e))
            item.setToolTip(e.message)
            self.issues.addItem(item)
        for w in self.sheet.warnings:
            item = QListWidgetItem(
                (f"! 第 {w.line} 行：" if w.line else "! ") + w.message
            )
            item.setForeground(QColor("#e0a95d"))
            item.setData(Qt.UserRole, ("warning", w))
            self.issues.addItem(item)
        if self.issues.count() == 0:
            item = QListWidgetItem("✓ 未发现问题")
            item.setForeground(QColor("#5fd68a"))
            self.issues.addItem(item)

    def _issue_activated(self, item: QListWidgetItem) -> None:
        data = item.data(Qt.UserRole)
        if not data or self.info is None or self.sheet is None:
            return
        kind, obj = data
        if getattr(obj, "track_number", None):
            idx = next(
                (i for i, t in enumerate(self.sheet.tracks) if t.number == obj.track_number),
                None,
            )
            if idx is not None:
                self._on_track_selected(idx)
                return
        QMessageBox.information(self, "分轨表问题", f"第 {obj.line} 行：{obj.message}")

    def _on_track_selected(self, sheet_index: int) -> None:
        if self.info is None or self.sheet is None:
            return
        if sheet_index < 0 or sheet_index >= len(self.sheet.tracks):
            return
        tr = self.sheet.tracks[sheet_index]
        sample = sample_at(tr.lead, self.info.samplerate) if tr.lead is not None else sample_at(
            tr.start, self.info.samplerate
        )
        self._recompute_cursor(sample)
        self.cue_overview.select_row(sheet_index)
        self._ensure_visible(sample)
        self.strip.set_selected(sheet_index)

    # ------------------------------------------------------------- viewport
    def _ensure_visible(self, sample: int) -> None:
        visible = self.view_last - self.view_first
        if sample < self.view_first or sample > self.view_last:
            self.view_first = max(0, sample - visible // 2)
            self.view_last = self.view_first + visible
            self._clamp_view()
            self._apply_view()

    def _clamp_view(self) -> None:
        if self.info is None:
            return
        total = self.info.total_samples
        span = max(self.MIN_ZOOM_SAMPLES, min(self.view_last - self.view_first, total))
        if self.view_first < 0:
            self.view_first = 0
        if self.view_first + span > total:
            self.view_first = max(0, total - span)
        self.view_last = self.view_first + span

    def _apply_view(self) -> None:
        if self.info is None:
            return
        self.strip.set_view(self.view_first, self.view_last, self.info.samplerate,
                            self.info.total_samples)
        self._update_peaks()

    def _update_peaks(self) -> None:
        if self.overview is None or self.info is None:
            return
        width = max(64, self.strip.wave.width())
        peaks = self.overview.get(self.view_first, self.view_last - 1, width)
        self.strip.set_peaks(peaks)

    def _zoom(self, factor: float) -> None:
        if self.info is None:
            return
        span = max(
            self.MIN_ZOOM_SAMPLES,
            min(int((self.view_last - self.view_first) * factor), self.info.total_samples),
        )
        center = self.cursor
        self.view_first = center - span // 2
        self.view_last = self.view_first + span
        self._clamp_view()
        self._apply_view()

    def _zoom_full(self) -> None:
        if self.info is None:
            return
        self.view_first = 0
        self.view_last = self.info.total_samples
        self._apply_view()

    def _zoom_to(self, first: int, last: int, margin: float = 0.15) -> None:
        if self.info is None:
            return
        span = max(self.MIN_ZOOM_SAMPLES, last - first)
        pad = int(span * margin)
        self.view_first = max(0, first - pad)
        self.view_last = min(self.info.total_samples, last + pad)
        self._clamp_view()
        self._apply_view()

    def _on_seek(self, sample: int) -> None:
        self._recompute_cursor(sample)
        self._ensure_visible(sample)

    def _on_junction_selected(self, sample: int) -> None:
        self._recompute_cursor(sample)
        self._ensure_visible(sample)

    def _on_hover(self, sample: int) -> None:
        if self.info is None or self.sheet is None:
            return
        # Hovering previews the readout at the pointed sample without moving
        # the cursor: dragging from a normal position into a lead region shows
        # that region's state and destination file immediately.
        self._update_readout(sample, preview=True)
        key, text, _ = _owner_state(self.sheet, self.info, sample, self.plan)
        self.statusBar().showMessage(
            f"{format_mmssff(time_at(sample, self.info.samplerate))} · 采样 {sample} · {text}"
        )

    def _on_hover_left(self) -> None:
        if self.player is not None and self.player.is_active():
            return
        self._update_cursor_views()

    def _jump_junction(self, delta: int) -> None:
        if self.sheet is None or self.info is None:
            return
        js = junctions(self.sheet, self.info)
        if not js:
            return
        positions = [j.sample for j in js]
        if delta < 0:
            earlier = [p for p in positions if p < self.cursor - 1]
            target = earlier[-1] if earlier else positions[0]
        else:
            later = [p for p in positions if p > self.cursor + 1]
            target = later[0] if later else positions[-1]
        self._recompute_cursor(target)
        self._ensure_visible(target)
        self.junction_panel.set_index_for_sample(target)

    # ---------------------------------------------------------------- audio
    def _audition_region(self, first: int, last: int) -> None:
        if self.player is None or self.info is None:
            return
        self.player.set_mode(self.mode)
        self.player.set_loop(self.chk_loop.isChecked())
        self.player.start(first, last)
        self._preview_region = (first, last)
        self.strip.set_preview_region(self._preview_region)
        self._recompute_cursor(first)
        self._zoom_to(first, last, 0.35)
        self.junction_panel.set_playing(True)

    def _play_around_cursor(self) -> None:
        if self.player is not None and self.player.is_active():
            self._stop_audio()
            return
        if self.info is None:
            return
        sr = self.info.samplerate
        seconds = int(self.junction_panel.seconds.value() * sr)
        self._audition_region(
            max(0, self.cursor - seconds),
            min(self.info.total_samples - 1, self.cursor + seconds),
        )

    def _stop_audio(self) -> None:
        if self.player is not None:
            self.player.stop()
        self.junction_panel.set_playing(False)
        self.strip.set_playhead(self.cursor)

    def _on_loop_toggled(self, on: bool) -> None:
        if self.player is not None:
            self.player.set_loop(on)

    def _on_volume(self, value: int) -> None:
        if self.player is not None:
            self.player.set_volume(value / 100.0)

    def _on_tick(self) -> None:
        if self.player is not None and self.player.is_active():
            self._player_was_active = True
            pos = self.player.position()
            self.strip.set_playhead(pos)
            self._ensure_visible(pos)
            self.chk_state.setText(
                f"试听中：采样 {pos} · {format_mmssff(time_at(pos, self.info.samplerate))}"
                if self.info else ""
            )
        elif self.player is not None:
            if self._player_was_active:
                self._player_was_active = False
                self.junction_panel.set_playing(False)
                self.strip.set_playhead(self.cursor)
                self._update_cursor_views()
        if (self.overview is not None and self.overview.ready()
                and not self._overview_painted):
            self._overview_painted = True
            self._update_peaks()

    # ----------------------------------------------------------- split mode
    def set_mode(self, mode_value: str) -> None:
        try:
            mode = SplitMode(mode_value)
        except ValueError:
            return
        self.mode = mode
        if self.player is not None:
            # Recorded only; the playing buffer is not touched, so the
            # audition keeps its position across this switch (requirement 4).
            self.player.set_mode(mode)
        self.junction_panel.set_mode(mode)
        self._refresh()
        if self.sheet is not None and self.info is not None:
            j = self.junction_panel.current_junction()
            if j is not None:
                self.statusBar().showMessage(
                    f"拆法切换：{mode.label}；交界归属 → {j.owner_text(self.mode)}",
                    5000,
                )

    def set_head_sep(self, separate: bool) -> None:
        self.head_sep = bool(separate)
        self._refresh()
        self.statusBar().showMessage(
            "整卷前导：" + ("单独保存为 00 - 整卷前导.wav" if separate else "并入 T01 文件开头"),
            4000,
        )

    # --------------------------------------------------------------- export
    def do_export(self) -> None:
        if self.plan is None or self.info is None:
            QMessageBox.warning(self, "尚无可导出内容", "请先加载带分轨表的 WAV，且分轨表无错误。")
            return
        if self.plan.ownership_problems():
            QMessageBox.critical(self, "规划不完整", "\n".join(self.plan.ownership_problems()))
            return
        start_dir = self._export_dir or os.path.dirname(self.info.path)
        directory = QFileDialog.getExistingDirectory(self, "选择分轨输出目录", start_dir)
        if not directory:
            return
        self._export_dir = directory
        self.export_panel.set_dir(directory)
        self.export_panel.clear_log()
        self.export_panel.append_log(f"输出目录：{directory}")
        progress = QProgressDialog("正在导出…", None, 0, len(self.plan.segments), self)
        progress.setWindowModality(Qt.WindowModal)
        progress.setMinimumDuration(300)

        def cb(done: int, total: int, label: str) -> None:
            progress.setValue(done)
            progress.setLabelText(f"正在写入：{label} ({done + 1}/{total})")
            QApplication.processEvents()

        try:
            result = export_plan(self.plan, directory, progress=cb, verify=True)
        finally:
            progress.close()
        self._last_export = result
        if result.ok:
            self._exported_plan = self.plan
        for fr in result.files:
            mark = "✓" if fr.ok else "✗"
            self.export_panel.append_log(
                f"{mark} {fr.segment.file_name}  [{fr.segment.first_sample}..{fr.segment.last_sample}]"
                + (f"  — {fr.message}" if fr.message else "")
            )
        if result.ok:
            self.export_panel.append_log(
                f"完成：{len(result.files)} 个文件，全部回读核对通过。"
            )
            QMessageBox.information(
                self,
                "导出完成",
                f"已写入 {len(result.files)} 个 WAV 到\n{directory}\n\n"
                "每个文件都已重新读开并与源文件对应区间逐采样核对。",
            )
        else:
            self.export_panel.append_log("存在问题：\n" + "\n".join(result.errors))
            QMessageBox.critical(self, "导出发现问题", "\n".join(result.errors))

    def verify_files(self) -> None:
        if self.info is None:
            QMessageBox.warning(self, "尚未加载", "请先加载带分轨表的 WAV。")
            return
        if self.plan is None and self._exported_plan is None:
            QMessageBox.warning(self, "尚无可核对内容", "请先成功导出一次。")
            return
        if not self._export_dir or not os.path.isdir(self._export_dir):
            directory = QFileDialog.getExistingDirectory(self, "选择要核对的导出目录")
            if not directory:
                return
            self._export_dir = directory
        self.export_panel.clear_log()
        self.export_panel.append_log(f"重新读开目录：{self._export_dir}")
        self.export_panel.set_dir(self._export_dir)
        plan = self._exported_plan or self.plan
        if self._exported_plan is not None and self.plan is not None:
            if (self.plan.mode != self._exported_plan.mode
                    or self.plan.head_lead_separate != self._exported_plan.head_lead_separate
                    or [(s.first_sample, s.last_sample) for s in self.plan.segments]
                    != [(s.first_sample, s.last_sample) for s in self._exported_plan.segments]):
                self.export_panel.append_log(
                    "! 当前界面拆法/区间与导出时不同，按导出时的规划核对。"
                )
        rows = verify_exported_head_tail(self._export_dir, plan)
        bad = 0
        for fr in rows:
            if not fr.ok:
                bad += 1
            self.export_panel.append_log(f"{fr.segment.file_name}")
            if fr.head_text:
                self.export_panel.append_log("  " + fr.head_text)
            if fr.tail_text:
                self.export_panel.append_log("  " + fr.tail_text)
        self.export_panel.append_log(
            ("✗ " + f"{bad} 个文件头尾不符") if bad else "✓ 全部文件头/尾采样与源一致"
        )

    def run_demo_selftest(self) -> None:
        if not self.info or not self.sheet:
            QMessageBox.information(self, "尚未加载", "先点“生成演示卷”。")
            return
        from ..selftest import run as run_selftest

        directory = QFileDialog.getExistingDirectory(self, "自检输出目录")
        if not directory:
            return
        rc = run_selftest(directory)
        if rc == 0:
            QMessageBox.information(self, "自检通过", "演示卷拆分与回读全部通过。")
        else:
            QMessageBox.warning(self, "自检未通过", "详情见控制台输出。")

    # ----------------------------------------------------------------- misc
    def show_about(self) -> None:
        QMessageBox.information(
            self,
            "使用说明",
            "1. 打开连续 44.1 kHz WAV 和单文件 cue（或按同名 .cue 自动配对）。\n"
            "2. 左侧总览给出分轨表时间、采样位置、前导位置；存在问题会列在“分轨表校验”。\n"
            "3. 主视图一根时间尺同时显示分轨表时间 / 采样位置 / 轨内时间，"
            "前导区与正式区用不同颜色标注，归属状态随当前位置显示。\n"
            "4. 在“交界试听”里选一条交界，前后各听 N 秒；切换拆法时播放的是源文件同一段。\n"
            "5. “拆分与导出”里选前导归前轨还是归本轨、整卷前导是否单独成文件，"
            "表格显示每段实际写入哪个文件；导出后会逐文件回读核对。\n"
            "6. 菜单“用演示卷自检”可生成已知点声和跨边界持续音的演示卷并验证接回原音。\n\n"
            "快捷键：Space 播放/停止，= 放大，- 缩小，0 整卷。",
        )

    def closeEvent(self, event) -> None:
        self._stop_audio()
        self._close_source()
        super().closeEvent(event)


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    QApplication.setAttribute(Qt.AA_DontUseNativeMenuBar, False)
    app = QApplication(argv)
    app.setStyleSheet(APP_STYLE)
    palette = app.palette()
    palette.setColor(QPalette.Window, QColor("#12151b"))
    palette.setColor(QPalette.WindowText, QColor("#d7dee8"))
    palette.setColor(QPalette.Base, QColor("#171d26"))
    palette.setColor(QPalette.Text, QColor("#d7dee8"))
    palette.setColor(QPalette.Button, QColor("#202733"))
    palette.setColor(QPalette.ButtonText, QColor("#d7dee8"))
    palette.setColor(QPalette.Highlight, QColor("#2d4b60"))
    palette.setColor(QPalette.HighlightedText, QColor("#ffffff"))
    app.setPalette(palette)

    win = MainWindow()
    win.show()
    # Optional: open a demo pair passed on the command line, handy for smoke tests.
    args = [a for a in argv[1:] if not a.startswith("-")]
    if len(args) >= 2 and os.path.exists(args[0]) and os.path.exists(args[1]):
        win.load_wav(args[0])
        win.load_cue(args[1])
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
