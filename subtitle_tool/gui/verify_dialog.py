"""Verification dialog: compare an exported / re-imported SRT cue by cue."""

from __future__ import annotations

from typing import Optional, Sequence

from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QColor
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QHeaderView,
    QLabel,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..export import (
    ExportOptions,
    export_merged_cues,
    verify_against_manifest,
    verify_srt_against_project,
)
from ..model import Project
from ..srt import SrtCue, build_srt, ms_to_timestamp, parse_srt
from .common import MONO_FONT

OK_COLOR = QColor("#1b5e20")
BAD_COLOR = QColor("#c62828")
WARN_COLOR = QColor("#b26a00")


class VerifyDialog(QDialog):
    """Side-by-side comparison of the project export and an SRT on disk."""

    COLUMNS = ["#", "期望时间", "实际时间", "期望文字", "实际文字", "结果"]

    def __init__(
        self,
        project: Project,
        srt_path: str,
        manifest_path: Optional[str] = None,
        options: Optional[ExportOptions] = None,
        parent: Optional[QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.project = project
        self.options = options or ExportOptions()
        self.setWindowTitle(f"核对 · {srt_path}")
        self.resize(1180, 720)

        with open(srt_path, "r", encoding="utf-8-sig") as fh:
            actual = parse_srt(fh.read())
        expected = export_merged_cues(project, self.options)
        if manifest_path:
            self.report = verify_against_manifest(
                project, srt_path, manifest_path
            )
        else:
            self.report = verify_srt_against_project(
                project, build_srt(actual), options=self.options
            )

        self.summary = QLabel(self.report.summary())
        self.summary.setWordWrap(True)
        font = self.summary.font()
        font.setPointSize(13)
        self.summary.setFont(font)
        self.summary.setStyleSheet(
            f"color: {'#1b5e20' if self.report.ok else '#c62828'};"
        )

        self.table = QTableWidget(0, len(self.COLUMNS))
        self.table.setHorizontalHeaderLabels(self.COLUMNS)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setAlternatingRowColors(True)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.Stretch)
        header.setSectionResizeMode(4, QHeaderView.Stretch)
        header.setSectionResizeMode(5, QHeaderView.ResizeToContents)
        self.table.setWordWrap(False)
        self.table.setTextElideMode(Qt.ElideRight)
        self.table.verticalHeader().setDefaultSectionSize(26)

        issues = self.report.issues
        self.detail = QLabel(
            "\n".join(
                f"[{i.severity}] 第 {i.index} 条 {i.kind}：{i.message}"
                for i in issues[:60]
            )
            or "时间与文字全部一致。"
        )
        self.detail.setWordWrap(True)
        self.detail.setStyleSheet("color: #455a64;")
        self.detail.setTextInteractionFlags(Qt.TextSelectableByMouse)

        buttons = QDialogButtonBox(QDialogButtonBox.Close)
        buttons.rejected.connect(self.reject)
        buttons.accepted.connect(self.accept)
        reexport = QPushButton("把期望内容另存为参考 SRT…")
        reexport.clicked.connect(self._save_reference)
        buttons.addButton(reexport, QDialogButtonBox.ActionRole)

        layout = QVBoxLayout(self)
        layout.addWidget(self.summary)
        layout.addWidget(self.table, 1)
        layout.addWidget(self.detail)
        layout.addWidget(buttons)
        self._fill(expected, actual)

    # -- table ------------------------------------------------------------
    def _fill(self, expected: Sequence[SrtCue], actual: Sequence[SrtCue]) -> None:
        rows = max(len(expected), len(actual))
        self.table.setRowCount(rows)
        for n in range(rows):
            exp = expected[n] if n < len(expected) else None
            act = actual[n] if n < len(actual) else None
            exp_time = (
                f"{ms_to_timestamp(exp.start_ms)}–{ms_to_timestamp(exp.end_ms)}"
                if exp
                else "（无）"
            )
            act_time = (
                f"{ms_to_timestamp(act.start_ms)}–{ms_to_timestamp(act.end_ms)}"
                if act
                else "（无）"
            )
            exp_text = exp.text if exp else "（无）"
            act_text = act.text if act else "（无）"
            same = exp is not None and act is not None and (
                exp.start_ms == act.start_ms
                and exp.end_ms == act.end_ms
                and exp_text == act_text
            )
            values = [
                str(n + 1),
                exp_time,
                act_time,
                exp_text.replace("\n", "  ⏎  "),
                act_text.replace("\n", "  ⏎  "),
                "一致" if same else "不同",
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                if col in (3, 4):
                    item.setFont(MONO_FONT)
                    item.setToolTip(exp_text if col == 3 else act_text)
                if not same:
                    item.setForeground(QBrush(BAD_COLOR))
                    item.setBackground(QBrush(QColor("#ffebee")))
                else:
                    item.setForeground(QBrush(OK_COLOR))
                self.table.setItem(n, col, item)

    def _save_reference(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "另存参考 SRT", "expected.srt", "SRT (*.srt)"
        )
        if not path:
            return
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(build_srt(export_merged_cues(self.project, self.options)))
