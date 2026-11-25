from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

from PySide6.QtCore import QObject, Qt, QThread, QTimer, QUrl, Signal
from PySide6.QtGui import QAction, QDesktopServices, QFont
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from .audio import extract_audio_wav
from .edits import TrackEditSession, TrackDraft, format_offset, track_label
from .errors import MkvToolError
from .exporter import export_mkv
from .media import SourceInfo, probe_file
from .sample import generate_sample
from .subtitles import SubtitleCue, cues_at, extract_subtitle_srt, parse_srt
from .verification import VerificationReport

COMMON_LANGUAGES = [
    "",
    "eng",
    "chi",
    "zho",
    "zh",
    "jpn",
    "kor",
    "fra",
    "deu",
    "spa",
    "rus",
    "por",
    "ita",
    "ara",
    "hin",
    "und",
]

KIND_LABELS = {
    "video": "视频",
    "audio": "音频",
    "subtitle": "字幕",
    "data": "数据",
    "attachment": "附件",
    "unknown": "未知",
}


class CallWorker(QThread):
    succeeded = Signal(object)
    failed = Signal(str)

    def __init__(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
        super().__init__()
        self.fn = fn
        self.args = args
        self.kwargs = kwargs

    def run(self) -> None:  # pragma: no cover - Qt thread boundary
        try:
            self.succeeded.emit(self.fn(*self.args, **self.kwargs))
        except Exception as exc:  # noqa: BLE001 - show all failures in GUI
            self.failed.emit(f"{type(exc).__name__}: {exc}")


class VerificationDialog(QMessageBox):
    def __init__(self, report: VerificationReport, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.report = report
        self.setWindowTitle("输出复核通过")
        self.setIcon(QMessageBox.Icon.Information)
        self.setText(f"新 MKV 已生成，并已重新打开核对：\n{report.output_path}")
        self.setDetailedText("\n".join(report.summary_lines()))
        self.setStandardButtons(QMessageBox.StandardButton.Close)

        self.open_output_button = self.addButton(
            "在本窗口打开输出", QMessageBox.ButtonRole.ActionRole
        )
        self.player_button = self.addButton(
            "用系统播放器打开", QMessageBox.ButtonRole.ActionRole
        )
        self.finder_button = self.addButton("在文件夹中显示", QMessageBox.ButtonRole.ActionRole)
        self.open_output_button.clicked.connect(lambda: self.done(42))
        self.player_button.clicked.connect(self.open_in_player)
        self.finder_button.clicked.connect(self.reveal_in_folder)

    def open_in_player(self) -> None:
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.report.output_path)))

    def reveal_in_folder(self) -> None:
        path = self.report.output_path
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(path)])
        elif sys.platform.startswith("win"):
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(path.parent)))


class MainWindow(QMainWindow):
    COL_INCLUDE = 0
    COL_OUTPUT = 1
    COL_SOURCE = 2
    COL_KIND = 3
    COL_CODEC = 4
    COL_LANG = 5
    COL_TITLE = 6
    COL_SOURCE_FLAGS = 7
    COL_DEFAULT = 8
    COL_FORCED = 9
    COL_OFFSET = 10

    COLUMNS = [
        ("保留", 56),
        ("输出#", 58),
        ("源#", 52),
        ("种类", 56),
        ("编码", 92),
        ("语言", 110),
        ("标题", 240),
        ("源 D/F", 70),
        ("导出默认", 76),
        ("强制", 56),
        ("相对偏移", 92),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("MKV 声轨字幕检查器")
        self.resize(1280, 860)

        self.source_info: SourceInfo | None = None
        self.session: TrackEditSession | None = None
        self.current_path: Path | None = None
        self.last_report: VerificationReport | None = None
        self.selected_source_index: int | None = None

        self._loading = False
        self._workers: list[CallWorker] = []
        self._export_running = False
        self._audio_request_id = 0
        self._subtitle_request_id = 0
        self._preview_dir = Path(tempfile.mkdtemp(prefix="mkvtool-preview-"))
        self._wav_path: Path | None = None
        self._subtitle_cache_key: tuple[str, int] | None = None
        self._subtitle_cues: list[SubtitleCue] = []

        self.player = QMediaPlayer(self)
        self.audio_output = QAudioOutput(self)
        self.player.setAudioOutput(self.audio_output)
        self.audio_output.setVolume(0.9)

        self._build_ui()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)

        file_row = QHBoxLayout()
        self.open_button = QPushButton("打开 MKV…")
        self.open_button.clicked.connect(self.choose_and_open)
        self.sample_button = QPushButton("生成多轨样片…")
        sample_menu = QMenu(self)
        sample_menu.addAction("普通多轨样片", self.generate_normal_sample)
        sample_menu.addAction("正负偏移样片", self.generate_offset_sample)
        self.sample_button.setMenu(sample_menu)
        self.export_button = QPushButton("导出新 MKV 并复核…")
        self.export_button.setStyleSheet("font-weight: 600;")
        self.export_button.clicked.connect(self.choose_and_export)
        self.reopen_button = QPushButton("重新打开上次输出")
        self.reopen_button.clicked.connect(self.reopen_last_output)
        self.reopen_button.setEnabled(False)

        self.path_label = QLabel("尚未打开文件。可先生成样片，或打开一份短 MKV。")
        self.path_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        file_row.addWidget(self.open_button)
        file_row.addWidget(self.sample_button)
        file_row.addWidget(self.export_button)
        file_row.addWidget(self.reopen_button)
        file_row.addSpacing(16)
        file_row.addWidget(self.path_label, 1)
        layout.addLayout(file_row)

        edit_row = QHBoxLayout()
        self.remove_button = QPushButton("移除选中轨")
        self.remove_button.clicked.connect(lambda: self.toggle_selected_included(False))
        self.restore_button = QPushButton("恢复保留")
        self.restore_button.clicked.connect(lambda: self.toggle_selected_included(True))
        self.up_button = QPushButton("上移")
        self.down_button = QPushButton("下移")
        self.up_button.clicked.connect(lambda: self.move_selected(-1))
        self.down_button.clicked.connect(lambda: self.move_selected(1))
        self.ack_unsupported = QCheckBox("显式确认：导出时丢弃超出范围的流（位图字幕/数据/附件/多视频）")
        self.ack_unsupported.toggled.connect(self.refresh_expectations)
        edit_row.addWidget(self.remove_button)
        edit_row.addWidget(self.restore_button)
        edit_row.addWidget(self.up_button)
        edit_row.addWidget(self.down_button)
        edit_row.addSpacing(20)
        edit_row.addWidget(self.ack_unsupported, 1)
        layout.addLayout(edit_row)

        splitter = QSplitter(Qt.Orientation.Vertical)
        layout.addWidget(splitter, 1)

        self.table = QTableWidget(0, len(self.COLUMNS))
        self.table.setHorizontalHeaderLabels([name for name, _ in self.COLUMNS])
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.table.itemSelectionChanged.connect(self.on_selection_changed)
        self.table.itemChanged.connect(self.on_item_changed)
        header = self.table.horizontalHeader()
        for col, (_, width) in enumerate(self.COLUMNS):
            self.table.setColumnWidth(col, width)
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.Stretch)
        header.setStretchLastSection(False)
        splitter.addWidget(self.table)

        bottom = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(bottom)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)

        preview_tabs = QTabWidget()
        bottom.addWidget(preview_tabs)

        audio_box = QWidget()
        audio_layout = QVBoxLayout(audio_box)
        self.audio_label = QLabel("选择一条音轨后试听。")
        self.audio_label.setWordWrap(True)
        audio_buttons = QHBoxLayout()
        self.play_button = QPushButton("试听选中音轨")
        self.play_button.clicked.connect(self.play_selected_audio)
        self.stop_button = QPushButton("停止")
        self.stop_button.clicked.connect(self.player.stop)
        audio_buttons.addWidget(self.play_button)
        audio_buttons.addWidget(self.stop_button)
        audio_buttons.addStretch(1)
        self.audio_status = QLabel("")
        audio_layout.addWidget(self.audio_label)
        audio_layout.addLayout(audio_buttons)
        audio_layout.addWidget(self.audio_status)
        audio_layout.addStretch(1)
        preview_tabs.addTab(audio_box, "试听")

        sub_box = QWidget()
        sub_layout = QVBoxLayout(sub_box)
        time_row = QHBoxLayout()
        time_row.addWidget(QLabel("时刻（秒）"))
        self.time_spin = QDoubleSpinBox()
        self.time_spin.setRange(0.0, 86400.0)
        self.time_spin.setDecimals(3)
        self.time_spin.setSingleStep(0.1)
        self.time_spin.setValue(1.0)
        self.query_sub_button = QPushButton("查看该时刻文本")
        self.query_sub_button.clicked.connect(self.query_subtitle_at_time)
        self.reload_sub_button = QPushButton("重新提取字幕")
        self.reload_sub_button.clicked.connect(lambda: self.query_subtitle_at_time(force=True))
        time_row.addWidget(self.time_spin)
        time_row.addWidget(self.query_sub_button)
        time_row.addWidget(self.reload_sub_button)
        time_row.addStretch(1)
        sub_layout.addLayout(time_row)
        self.subtitle_result = QPlainTextEdit()
        self.subtitle_result.setReadOnly(True)
        self.subtitle_result.setPlaceholderText("这里显示指定时刻命中的字幕文本。")
        self.subtitle_all = QPlainTextEdit()
        self.subtitle_all.setReadOnly(True)
        self.subtitle_all.setPlaceholderText("选中字幕后可提取全部文本字幕。")
        sub_splitter = QSplitter(Qt.Orientation.Vertical)
        sub_splitter.addWidget(self.subtitle_result)
        sub_splitter.addWidget(self.subtitle_all)
        sub_layout.addWidget(sub_splitter, 1)
        preview_tabs.addTab(sub_box, "字幕时刻")

        expected_box = QGroupBox("导出预期 / 标记核对")
        expected_layout = QVBoxLayout(expected_box)
        self.expected_view = QPlainTextEdit()
        self.expected_view.setReadOnly(True)
        font = QFont("Menlo")
        font.setStyleHint(QFont.StyleHint.Monospace)
        self.expected_view.setFont(font)
        expected_layout.addWidget(self.expected_view)
        bottom.addWidget(expected_box)
        bottom.setStretchFactor(0, 1)
        bottom.setStretchFactor(1, 1)

        self.statusBar().showMessage("就绪")
        self._set_editing_enabled(False)

    def _set_editing_enabled(self, enabled: bool) -> None:
        for widget in (
            self.export_button,
            self.remove_button,
            self.restore_button,
            self.up_button,
            self.down_button,
            self.play_button,
            self.query_sub_button,
            self.reload_sub_button,
        ):
            widget.setEnabled(enabled)

    # ------------------------------------------------------------ open/sample
    def choose_and_open(self) -> None:
        if self._export_running:
            QMessageBox.information(self, "正在导出", "请等待当前导出和复核完成后再打开其他文件。")
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "打开短 MKV", "", "MKV 文件 (*.mkv);;所有文件 (*)"
        )
        if path:
            self.load_path(Path(path))

    def load_path(self, path: Path | str) -> None:
        p = Path(path).expanduser().absolute()
        # Any preview result from the previous file is stale.
        self._audio_request_id += 1
        self._subtitle_request_id += 1
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            info = probe_file(p)
            self.source_info = info
            self.current_path = p
            try:
                self.session = TrackEditSession(info)
            except MkvToolError as exc:
                self.session = None
                self.path_label.setText(f"{p} — {exc}")
                self.populate_readonly(info)
                self._set_editing_enabled(False)
                self.export_button.setEnabled(False)
                QMessageBox.warning(self, "范围受限", str(exc))
                return
            self.path_label.setText(str(p))
            self.ack_unsupported.setChecked(False)
            self.ack_unsupported.setVisible(bool(info.unsupported_streams))
            self.populate_table()
            self._set_editing_enabled(True)
            self.statusBar().showMessage(f"已打开 {p.name}，共 {len(info.streams)} 条流")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "打开失败", str(exc))
            self.statusBar().showMessage("打开失败")
        finally:
            QApplication.restoreOverrideCursor()

    def populate_readonly(self, info: SourceInfo) -> None:
        self._loading = True
        self.table.clearContents()
        self.table.setRowCount(len(info.streams))
        for row, stream in enumerate(info.streams):
            self._set_readonly_row(row, stream.index, editable=False)
        self._loading = False
        self.refresh_expectations()

    def generate_normal_sample(self) -> None:
        self._generate_sample(offset_demo=False)

    def generate_offset_sample(self) -> None:
        self._generate_sample(offset_demo=True)

    def _generate_sample(self, *, offset_demo: bool) -> None:
        default_name = "multitrack.offsets.mkv" if offset_demo else "multitrack.mkv"
        path, _ = QFileDialog.getSaveFileName(
            self, "生成样片", str(Path("samples") / default_name), "MKV (*.mkv)"
        )
        if not path:
            return
        self.statusBar().showMessage("正在生成样片…")
        worker = CallWorker(generate_sample, Path(path), offset_demo=offset_demo)
        self._run_worker(
            worker,
            lambda result: self._sample_done(result),
            lambda msg: self._worker_failed("样片生成失败", msg),
        )

    def _sample_done(self, path: object) -> None:
        p = Path(str(path))
        self.statusBar().showMessage(f"样片已生成：{p}")
        reply = QMessageBox.question(
            self,
            "样片已生成",
            f"已生成：\n{p}\n\n是否立即在窗口中打开？",
        )
        if reply == QMessageBox.StandardButton.Yes:
            self.load_path(p)

    def reopen_last_output(self) -> None:
        if self.last_report:
            self.load_path(self.last_report.output_path)

    # ------------------------------------------------------------- table data
    def _row_indices(self) -> list[int]:
        assert self.source_info and self.session
        indices = [self.session.video.index]
        indices.extend(t.source_index for t in self.session.audio)
        indices.extend(t.source_index for t in self.session.subtitles)
        known = set(indices)
        indices.extend(s.index for s in self.source_info.streams if s.index not in known)
        return indices

    def populate_table(self, select_index: int | None = None) -> None:
        if not self.source_info:
            return
        if not self.session:
            self.populate_readonly(self.source_info)
            return

        if select_index is None:
            select_index = self.selected_source_index
        self._loading = True
        indices = self._row_indices()
        self.table.clearContents()
        self.table.setRowCount(len(indices))

        output_numbers = self._output_numbers()
        for row, source_index in enumerate(indices):
            stream = self.source_info.get(source_index)
            draft = self._draft_or_none(source_index)
            self._fill_row(row, source_index, draft, output_numbers)

        self.table.resizeColumnsToContents()
        self.table.setColumnWidth(self.COL_TITLE, 260)
        self.table.horizontalHeader().setSectionResizeMode(
            self.COL_TITLE, QHeaderView.ResizeMode.Stretch
        )
        self._loading = False

        target_row = 0
        if select_index is not None and select_index in indices:
            target_row = indices.index(select_index)
        self.table.selectRow(target_row)
        self.selected_source_index = select_index if select_index in indices else indices[target_row]
        self.refresh_expectations()

    def _output_numbers(self) -> dict[int, int]:
        if not self.session:
            return {}
        result = {self.session.video.index: 0}
        n = 1
        for track in self.session.included_audio():
            result[track.source_index] = n
            n += 1
        for track in self.session.included_subtitles():
            result[track.source_index] = n
            n += 1
        return result

    def _draft_or_none(self, source_index: int) -> TrackDraft | None:
        if not self.session:
            return None
        try:
            return self.session.find(source_index)
        except KeyError:
            return None

    def _fill_row(
        self, row: int, source_index: int, draft: TrackDraft | None, output_numbers: dict[int, int]
    ) -> None:
        assert self.source_info
        stream = self.source_info.get(source_index)

        source_item = QTableWidgetItem(str(source_index))
        source_item.setData(Qt.ItemDataRole.UserRole, source_index)
        source_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        source_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.table.setItem(row, self.COL_SOURCE, source_item)

        kind_item = QTableWidgetItem(KIND_LABELS.get(stream.codec_type, stream.codec_type))
        kind_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        kind_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.table.setItem(row, self.COL_KIND, kind_item)

        codec_item = QTableWidgetItem(stream.codec_name)
        codec_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        codec_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.table.setItem(row, self.COL_CODEC, codec_item)

        flags_item = QTableWidgetItem(stream.flag_text or "—")
        flags_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        flags_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.table.setItem(row, self.COL_SOURCE_FLAGS, flags_item)

        offset = self.source_info.relative_offset(stream)
        offset_item = QTableWidgetItem(format_offset(offset))
        offset_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        offset_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.table.setItem(row, self.COL_OFFSET, offset_item)

        if draft is None:
            unsupported = (
                stream.is_bitmap_subtitle
                or stream.attached_pic
                or stream.codec_type in {"data", "attachment", "unknown"}
            )
            include = QTableWidgetItem("不支持" if unsupported else "固定")
            include.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
            include.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, self.COL_INCLUDE, include)

            out_item = QTableWidgetItem("—")
            out_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
            out_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, self.COL_OUTPUT, out_item)

            lang_item = QTableWidgetItem(stream.language or "（无标注）")
            lang_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
            self.table.setItem(row, self.COL_LANG, lang_item)
            title_item = QTableWidgetItem(stream.title)
            title_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
            self.table.setItem(row, self.COL_TITLE, title_item)

            default_item = self._centered_item("☑" if stream.default else "☐")
            default_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
            self.table.setItem(row, self.COL_DEFAULT, default_item)
            forced_item = self._centered_item("F" if stream.forced else "—")
            forced_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
            self.table.setItem(row, self.COL_FORCED, forced_item)
            return

        include_item = QTableWidgetItem()
        include_item.setFlags(
            Qt.ItemFlag.ItemIsEnabled
            | Qt.ItemFlag.ItemIsSelectable
            | Qt.ItemFlag.ItemIsUserCheckable
        )
        include_item.setCheckState(
            Qt.CheckState.Checked if draft.included else Qt.CheckState.Unchecked
        )
        include_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.table.setItem(row, self.COL_INCLUDE, include_item)

        out_text = str(output_numbers.get(source_index, "—")) if draft.included else "已移除"
        out_item = self._centered_item(out_text)
        out_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        self.table.setItem(row, self.COL_OUTPUT, out_item)

        language_combo = QComboBox()
        language_combo.setEditable(True)
        language_combo.addItems(COMMON_LANGUAGES)
        language_combo.setCurrentText(draft.language)
        if language_combo.lineEdit():
            language_combo.lineEdit().setPlaceholderText("无语言标记")
        language_combo.blockSignals(True)
        language_combo.setCurrentText(draft.language)
        language_combo.blockSignals(False)
        language_combo.currentTextChanged.connect(
            lambda text, idx=source_index: self.on_language_edited(idx, text)
        )
        self.table.setCellWidget(row, self.COL_LANG, language_combo)

        title_item = QTableWidgetItem(draft.title)
        title_item.setFlags(
            Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEditable
        )
        self.table.setItem(row, self.COL_TITLE, title_item)

        default_item = QTableWidgetItem()
        default_item.setFlags(
            Qt.ItemFlag.ItemIsEnabled
            | Qt.ItemFlag.ItemIsSelectable
            | Qt.ItemFlag.ItemIsUserCheckable
        )
        default_item.setCheckState(
            Qt.CheckState.Checked if draft.is_default else Qt.CheckState.Unchecked
        )
        default_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.table.setItem(row, self.COL_DEFAULT, default_item)

        forced_item = QTableWidgetItem()
        if draft.kind == "subtitle":
            forced_item.setFlags(
                Qt.ItemFlag.ItemIsEnabled
                | Qt.ItemFlag.ItemIsSelectable
                | Qt.ItemFlag.ItemIsUserCheckable
            )
            forced_item.setCheckState(
                Qt.CheckState.Checked if draft.is_forced else Qt.CheckState.Unchecked
            )
        else:
            forced_item.setText("—")
            forced_item.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        forced_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.table.setItem(row, self.COL_FORCED, forced_item)

        if not draft.included:
            for col in range(self.COLUMNS.__len__()):
                item = self.table.item(row, col)
                if item is not None:
                    item.setForeground(Qt.GlobalColor.gray)

    def _set_readonly_row(self, row: int, source_index: int, editable: bool) -> None:
        # populate_table handles unsupported rows; this is retained as a small
        # explicit entry point for future read-only error states.
        self._fill_row(row, source_index, None, {})

    @staticmethod
    def _centered_item(text: str) -> QTableWidgetItem:
        item = QTableWidgetItem(text)
        item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        return item

    # ---------------------------------------------------------- table events
    def on_item_changed(self, item: QTableWidgetItem) -> None:
        if self._loading or not self.session:
            return
        row = item.row()
        source_item = self.table.item(row, self.COL_SOURCE)
        if source_item is None:
            return
        source_index = int(source_item.data(Qt.ItemDataRole.UserRole))
        column = item.column()

        if column == self.COL_TITLE:
            self.session.set_title(source_index, item.text())
            self.refresh_expectations()
        elif column == self.COL_INCLUDE:
            included = item.checkState() == Qt.CheckState.Checked
            self.session.set_included(source_index, included)
            # Defer rebuild so Qt finishes committing the checkbox.  State is
            # read from the session, never from the currently selected row.
            QTimer.singleShot(0, lambda: self.populate_table(source_index))
        elif column == self.COL_DEFAULT:
            chosen = item.checkState() == Qt.CheckState.Checked
            try:
                self.session.set_default(source_index, chosen)
            except MkvToolError as exc:
                QMessageBox.warning(self, "不能设为默认", str(exc))
            QTimer.singleShot(0, lambda: self.populate_table(source_index))
        elif column == self.COL_FORCED:
            if self.session.find(source_index).kind == "subtitle":
                forced = item.checkState() == Qt.CheckState.Checked
                self.session.set_forced(source_index, forced)
                self.refresh_expectations()

    def on_language_edited(self, source_index: int, text: str) -> None:
        if self._loading or not self.session:
            return
        self.session.set_language(source_index, text)
        self.refresh_expectations()

    def on_selection_changed(self) -> None:
        if not self.source_info:
            return
        rows = self.table.selectionModel().selectedRows()
        if not rows:
            return
        row = rows[0].row()
        source_item = self.table.item(row, self.COL_SOURCE)
        if source_item is None:
            return
        source_index = int(source_item.data(Qt.ItemDataRole.UserRole))
        self.selected_source_index = source_index
        # A response from an extraction started for the previous row is stale.
        self._audio_request_id += 1
        self._subtitle_request_id += 1
        stream = self.source_info.get(source_index)
        draft = self._draft_or_none(source_index)

        if draft and draft.kind == "audio":
            self.audio_label.setText(f"选中音轨：{track_label(draft)}")
            self.play_button.setEnabled(True)
        else:
            self.audio_label.setText(
                f"当前选中：{track_label(stream)}（请选择一条音频流试听）"
            )
            self.play_button.setEnabled(False)

        if draft and draft.kind == "subtitle" and stream.is_text_subtitle:
            self.subtitle_result.setPlaceholderText("点击“查看该时刻文本”。")
        else:
            self.subtitle_result.setPlainText("")
            self.subtitle_all.setPlainText("")
        self._subtitle_cues = []
        self._subtitle_cache_key = None

    def move_selected(self, delta: int) -> None:
        if not self.session or self.selected_source_index is None:
            return
        idx = self.selected_source_index
        try:
            if self.session.move(idx, delta):
                self.populate_table(idx)
        except KeyError:
            QMessageBox.information(self, "无法移动", "请选择音轨或字幕行。")

    def toggle_selected_included(self, included: bool) -> None:
        if not self.session or self.selected_source_index is None:
            return
        try:
            self.session.set_included(self.selected_source_index, included)
            self.populate_table(self.selected_source_index)
        except KeyError:
            QMessageBox.information(self, "无法移除", "视频流固定保留；请选择音轨或字幕。")

    # --------------------------------------------------------- expectations
    def refresh_expectations(self) -> None:
        if not self.session or not self.current_path:
            self.expected_view.setPlainText("")
            return
        dummy = self.current_path.with_name(f".{self.current_path.stem}.preview-plan.mkv")
        try:
            plan = self.session.build_plan(
                dummy,
                overwrite=True,
                acknowledge_unsupported=self.ack_unsupported.isChecked(),
            )
        except MkvToolError as exc:
            self.expected_view.setPlainText("当前方案还不能导出：\n" + str(exc))
            return

        lines = []
        if self.session.notices:
            lines.extend("注意：" + notice for notice in self.session.notices)
            lines.append("")
        lines.append("实际导出顺序 / 写入标记：")
        for e in plan.expected:
            lang = e.language or "∅无标注"
            title = e.title or "∅无标题"
            offset = format_offset(e.relative_offset)
            lines.append(
                f"#{e.output_index:<2} <- 源#{e.source_index:<2} "
                f"{e.codec_type:<8} {e.codec_name:<8} lang={lang:<6} "
                f"D={int(e.default)} F={int(e.forced)} off={offset}  {title}"
            )

        audio_default = self.session.default_track("audio")
        sub_default = self.session.default_track("subtitle")
        forced_subs = [
            t.source_index for t in self.session.included_subtitles() if t.is_forced
        ]
        lines.append("")
        lines.append(
            "音频默认项："
            + (f"源#{audio_default.source_index} {audio_default.title}" if audio_default else "无（全部 default=0）")
        )
        lines.append(
            "字幕默认项："
            + (f"源#{sub_default.source_index} {sub_default.title}" if sub_default else "无（全部 default=0）")
        )
        lines.append(
            "强制字幕：" + (", ".join(f"源#{i}" for i in forced_subs) if forced_subs else "无")
        )
        lines.append("")
        lines.append(
            "核对预期：默认字幕通常会自动显示；强制字幕独立于默认项，"
            "用于播放器关闭普通字幕时仍显示。可把默认设在一条、强制勾在另一条。"
        )
        self.expected_view.setPlainText("\n".join(lines))

    # ------------------------------------------------------------- playback
    def _selected_draft(self) -> TrackDraft | None:
        if not self.session or self.selected_source_index is None:
            return None
        try:
            return self.session.find(self.selected_source_index)
        except KeyError:
            return None

    def play_selected_audio(self) -> None:
        draft = self._selected_draft()
        if not draft or draft.kind != "audio":
            QMessageBox.information(self, "选择音轨", "请先在表中选择一条音频流。")
            return
        if not self.current_path:
            return
        self._audio_request_id += 1
        request_id = self._audio_request_id
        self.audio_status.setText("正在提取所选音轨为临时 WAV…")
        wav = self._preview_dir / f"source-{self.current_path.stat().st_mtime_ns}-{draft.source_index}.wav"
        worker = CallWorker(extract_audio_wav, self.current_path, draft.source_index, wav)
        self._run_worker(
            worker,
            lambda result, seq=request_id, idx=draft.source_index: self._play_wav(
                seq, Path(str(result)), idx
            ),
            lambda message, seq=request_id: self._audio_failed(seq, message),
        )

    def _play_wav(self, request_id: int, wav: Path, source_index: int) -> None:
        if request_id != self._audio_request_id:
            return
        self._wav_path = wav
        self.player.stop()
        self.player.setSource(QUrl.fromLocalFile(str(wav)))
        self.player.play()
        self.audio_status.setText(f"正在试听源 #{source_index}（临时 WAV：{wav.name}）")

    def _audio_failed(self, request_id: int, message: str) -> None:
        if request_id != self._audio_request_id:
            return
        self.audio_status.setText("预览失败")
        QMessageBox.warning(self, "预览失败", message)

    # ------------------------------------------------------------ subtitles
    def query_subtitle_at_time(self, *, force: bool = False) -> None:
        draft = self._selected_draft()
        if not draft or draft.kind != "subtitle":
            QMessageBox.information(self, "选择字幕", "请先选择一条文本字幕流。")
            return
        if not self.current_path or not draft.source.is_text_subtitle:
            QMessageBox.warning(self, "不支持的字幕", "位图字幕不在文本预览范围内。")
            return

        key = (str(self.current_path), draft.source_index)
        seconds = self.time_spin.value()
        if force or self._subtitle_cache_key != key:
            self._subtitle_request_id += 1
            request_id = self._subtitle_request_id
            self.subtitle_result.setPlainText("正在提取字幕…")
            worker = CallWorker(extract_subtitle_srt, self.current_path, draft.source_index)
            self._run_worker(
                worker,
                lambda text, seq=request_id, k=key, t=seconds: self._subtitle_loaded(
                    seq, k, str(text), t
                ),
                lambda message, seq=request_id: self._subtitle_failed(seq, message),
            )
        else:
            self._show_subtitle_at(seconds)

    def _subtitle_loaded(
        self,
        request_id: int,
        key: tuple[str, int],
        srt_text: str,
        seconds: float,
    ) -> None:
        if request_id != self._subtitle_request_id:
            return
        self._subtitle_cache_key = key
        self._subtitle_cues = parse_srt(srt_text)
        self.subtitle_all.setPlainText(srt_text)
        self._show_subtitle_at(seconds)

    def _subtitle_failed(self, request_id: int, message: str) -> None:
        if request_id != self._subtitle_request_id:
            return
        QMessageBox.warning(self, "字幕预览失败", message)

    def _show_subtitle_at(self, seconds: float) -> None:
        hits = cues_at(self._subtitle_cues, seconds)
        if not hits:
            nearest = min(
                self._subtitle_cues,
                key=lambda c: min(abs(c.start - seconds), abs(c.end - seconds)),
                default=None,
            )
            hint = ""
            if nearest:
                hint = f"\n\n最近条目：{nearest.start:.3f}–{nearest.end:.3f}"
            self.subtitle_result.setPlainText(f"{seconds:.3f}s 处没有正在显示的字幕。{hint}")
            return
        blocks = []
        for cue in hits:
            blocks.append(f"[{cue.start:.3f} → {cue.end:.3f}]\n{cue.text}")
        self.subtitle_result.setPlainText("\n\n".join(blocks))

    # ---------------------------------------------------------------- export
    def choose_and_export(self) -> None:
        if not self.session or not self.current_path:
            return
        default_output = str(
            self.current_path.with_name(self.current_path.stem + ".edited.mkv")
        )
        output, _ = QFileDialog.getSaveFileName(
            self, "导出新 MKV", default_output, "Matroska (*.mkv)"
        )
        if not output:
            return
        try:
            plan = self.session.build_plan(
                Path(output),
                overwrite=True,  # save dialog already asks before replacing
                acknowledge_unsupported=self.ack_unsupported.isChecked(),
            )
        except MkvToolError as exc:
            QMessageBox.critical(self, "不能导出", str(exc))
            return

        self.statusBar().showMessage("正在封装并无缝复核，请稍候…")
        self._set_export_busy(True)
        worker = CallWorker(export_mkv, plan)
        self._run_worker(worker, self._export_succeeded, self._export_failed)

    def _set_export_busy(self, busy: bool) -> None:
        self._export_running = busy
        self.export_button.setEnabled(not busy and self.session is not None)
        self.open_button.setEnabled(not busy)
        self.sample_button.setEnabled(not busy)

    def _export_succeeded(self, result: object) -> None:
        report = result if isinstance(result, VerificationReport) else None
        self._set_export_busy(False)
        if report is None:
            self._export_failed("内部错误：没有收到复核报告")
            return
        self.last_report = report
        self.reopen_button.setEnabled(True)
        self.statusBar().showMessage("导出并复核成功")
        dialog = VerificationDialog(report, self)
        choice = dialog.exec()
        if choice == 42:
            self.load_path(report.output_path)

    def _export_failed(self, message: str) -> None:
        self._set_export_busy(False)
        self.statusBar().showMessage("导出失败；没有发布未复核成品")
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Critical)
        box.setWindowTitle("导出/复核失败")
        box.setText("没有生成看起来成功的成品。临时文件已清理（若存在）。")
        box.setDetailedText(message)
        box.exec()

    # --------------------------------------------------------------- workers
    def _run_worker(
        self,
        worker: CallWorker,
        on_success: Callable[[object], None],
        on_failure: Callable[[str], None],
    ) -> None:
        self._workers.append(worker)

        def cleanup() -> None:
            if worker in self._workers:
                self._workers.remove(worker)
            worker.deleteLater()

        worker.succeeded.connect(on_success)
        worker.failed.connect(on_failure)
        worker.finished.connect(cleanup)
        worker.start()

    def closeEvent(self, event: Any) -> None:  # noqa: N802 - Qt API name
        running = [worker for worker in self._workers if worker.isRunning()]
        if running:
            QMessageBox.information(
                self,
                "后台任务仍在运行",
                "请等待当前提取、样片生成或导出复核完成后再关闭窗口，避免留下临时文件。",
            )
            event.ignore()
            return
        try:
            self.player.stop()
        except Exception:  # noqa: BLE001 - closing must still succeed
            pass
        event.accept()


def run_gui(argv: list[str] | None = None) -> int:
    app = QApplication.instance() or QApplication(argv or sys.argv)
    window = MainWindow()
    window.show()
    if argv and len(argv) > 0:
        candidate = Path(argv[0])
        if candidate.exists():
            window.load_path(candidate)
    return app.exec()


def main_entry() -> int:
    return run_gui(sys.argv[1:])
