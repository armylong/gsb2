"""Manual pairing dialog: hand-pick cues from each track.

Used when the automatic suggestion is wrong, when one sentence must be split
by hand, or when a cue has no counterpart and should be recorded as missing.
"""

from __future__ import annotations

from typing import List, Optional, Sequence

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..model import CueRef
from ..srt import ms_to_timestamp
from ..session import Session

COLORS = ["#1a237e", "#4a148c", "#004d40", "#5d4037"]


class CuePicker(QWidget):
    def __init__(self, title: str, color: str, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.cues: List[CueRef] = []
        self.label = QLabel(title)
        self.label.setStyleSheet(f"color: {color}; font-weight: bold;")
        self.hint = QLabel("")
        self.hint.setStyleSheet("color: #607d8b;")
        self.list = QListWidget()
        self.list.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.list.setAlternatingRowColors(True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.label)
        layout.addWidget(self.list, 1)
        layout.addWidget(self.hint)

    def set_cues(self, cues: Sequence[CueRef], used: set) -> None:
        self.cues = list(cues)
        self.list.clear()
        for cue in self.cues:
            text = " / ".join(ln.strip() for ln in cue.text.splitlines() if ln.strip())
            item = QListWidgetItem(
                f"{ms_to_timestamp(cue.start_ms)}–{ms_to_timestamp(cue.end_ms)}  "
                f"{text}"
            )
            item.setData(Qt.UserRole, cue.uid)
            if cue.uid in used:
                item.setForeground(Qt.gray)
                item.setToolTip("该字幕已用在事件里；再取用会重复生成")
            self.list.addItem(item)
        count = len(self.cues)
        self.hint.setText(
            f"{count} 条字幕 · Ctrl/Shift 可多选（多选 = 手工拆分配对）"
            if count
            else "该轨没有字幕"
        )

    def selected_uids(self) -> List[str]:
        return [i.data(Qt.UserRole) for i in self.list.selectedItems()]


class ManualPairDialog(QDialog):
    def __init__(self, session: Session, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.session = session
        self.setWindowTitle("手工配对 / 拆配")
        self.resize(980, 620)
        self.created: List[str] = []

        self.anchor_combo = QComboBox()
        for lang in session.project.lang_order:
            self.anchor_combo.addItem(session.project.lang_label(lang), lang)
        self.align_combo = QComboBox()
        self.align_combo.addItem("按主轨时间", "anchor")
        self.align_combo.addItem("取两边并集", "union")
        self.align_combo.addItem("按副轨时间", "other")
        self.lock_box = QCheckBox("配对后立即锁定")
        self.filter_edit = QLineEdit()
        self.filter_edit.setPlaceholderText("按文字过滤…")
        self.filter_edit.textChanged.connect(self._refresh_lists)

        top = QHBoxLayout()
        top.addWidget(QLabel("主轨"))
        top.addWidget(self.anchor_combo)
        top.addWidget(QLabel("对齐"))
        top.addWidget(self.align_combo)
        top.addWidget(self.lock_box)
        top.addStretch(1)
        top.addWidget(QLabel("过滤"))
        top.addWidget(self.filter_edit, 1)

        self.left = CuePicker("主轨字幕", COLORS[0])
        self.right = CuePicker("副轨字幕", COLORS[1])
        self.preview = QLabel("")
        self.preview.setWordWrap(True)
        self.preview.setStyleSheet("color: #37474f;")
        self.status = QLabel("")
        self.status.setStyleSheet("color: #b26a00;")
        self.btn_pair = QPushButton("把所选配成事件")
        self.btn_pair.setToolTip("两边各选一条 = 1:1；一边多选 = 手工拆分配对")
        self.btn_pair.clicked.connect(self._pair)
        self.btn_missing_left = QPushButton("仅主轨所选 → 记为缺翻译")
        self.btn_missing_left.clicked.connect(lambda: self._missing("left"))
        self.btn_missing_right = QPushButton("仅副轨所选 → 记为缺翻译")
        self.btn_missing_right.clicked.connect(lambda: self._missing("right"))

        buttons = QDialogButtonBox(QDialogButtonBox.Close)
        buttons.rejected.connect(self.reject)
        buttons.accepted.connect(self.accept)

        action_row = QHBoxLayout()
        action_row.addWidget(self.btn_pair)
        action_row.addWidget(self.btn_missing_left)
        action_row.addWidget(self.btn_missing_right)
        action_row.addStretch(1)

        lists = QHBoxLayout()
        lists.addWidget(self.left, 1)
        lists.addWidget(self.right, 1)

        layout = QVBoxLayout(self)
        layout.addLayout(top)
        layout.addLayout(lists, 1)
        layout.addWidget(QLabel("将生成："))
        layout.addWidget(self.preview)
        layout.addWidget(self.status)
        layout.addLayout(action_row)
        layout.addWidget(buttons)

        self.left.list.itemSelectionChanged.connect(self._update_preview)
        self.right.list.itemSelectionChanged.connect(self._update_preview)
        self.anchor_combo.currentIndexChanged.connect(lambda _=0: self._refresh_lists())
        self._refresh_lists()

    # -- data -------------------------------------------------------------
    def _langs(self):
        anchor = self.anchor_combo.currentData()
        other = next(
            (l for l in self.session.project.lang_order if l != anchor), None
        )
        return anchor, other

    def _refresh_lists(self) -> None:
        anchor, other = self._langs()
        project = self.session.project
        used = project.used_origins()
        needle = self.filter_edit.text().strip().lower()

        def pick(lang):
            if lang is None or lang not in project.tracks:
                return []
            cues = project.tracks[lang].cues
            if needle:
                cues = [c for c in cues if needle in c.text.lower()]
            return cues

        self.left.set_cues(pick(anchor), used)
        self.right.set_cues(pick(other), used)
        self.left.label.setText(
            f"主轨 · {project.lang_label(anchor) if anchor else '—'}"
        )
        self.right.label.setText(
            f"副轨 · {project.lang_label(other) if other else '—'}"
        )
        self._update_preview()

    def _update_preview(self) -> None:
        left = self.left.selected_uids()
        right = self.right.selected_uids()
        self.preview.setText(
            f"主轨 {len(left)} 条  +  副轨 {len(right)} 条  →  "
            + (
                "1 条事件"
                if len(left) <= 1 and len(right) <= 1
                else f"按较密一侧生成 {max(len(left), len(right))} 条事件"
            )
        )

    # -- actions ----------------------------------------------------------
    def _pair(self) -> None:
        anchor, other = self._langs()
        left = self.left.selected_uids()
        right = self.right.selected_uids()
        if not left and not right:
            self.status.setText("两边都还没选字幕")
            return
        used = self.session.project.used_origins()
        if any(u in used for u in left + right):
            self.status.setText(
                "所选字幕里已有用在事件中的；请先解锁/重建，或改选其他字幕"
            )
            return
        created = self.session.manual_pair(
            anchor,
            left,
            other,
            right,
            align=self.align_combo.currentData(),
            lock=self.lock_box.isChecked(),
        )
        self.created.extend(created)
        self.status.setText(f"已生成 {len(created)} 条事件")
        self._refresh_lists()

    def _missing(self, side: str) -> None:
        anchor, other = self._langs()
        left = self.left.selected_uids() if side == "left" else []
        right = self.right.selected_uids() if side == "right" else []
        if not left and not right:
            self.status.setText("请先在对应一侧选字幕")
            return
        used = self.session.project.used_origins()
        if any(u in used for u in left + right):
            self.status.setText("所选字幕已用在事件中，不能重复标记")
            return
        created = self.session.manual_pair(
            anchor, left, other, right, lock=self.lock_box.isChecked()
        )
        self.created.extend(created)
        self.status.setText(f"已生成 {len(created)} 条缺翻译事件（保留原文）")
        self._refresh_lists()
