"""Editing panels: event list, event editor, pairing suggestions, cuts, checks."""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QBrush, QColor, QFont
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QToolButton,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..export import ExportOptions
from ..model import Event, Issue, Project
from ..pairing import PairingSuggestion
from ..srt import ms_to_short, ms_to_timestamp, parse_short
from ..session import Session
from .common import (
    MONO_FONT,
    STATUS_COLORS,
    lang_color,
    rows_caption,
    summarize_text,
)


# ---------------------------------------------------------------------------
# Event table
# ---------------------------------------------------------------------------


class EventTable(QWidget):
    eventSelected = Signal(str)
    requestSeek = Signal(int)

    COLUMNS = ["#", "开始", "结束", "时长", "状态", "锁", "语言行", "内容"]

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.project: Optional[Project] = None
        self.session: Optional[Session] = None
        self._current_id = ""
        self.table = QTableWidget(0, len(self.COLUMNS))
        self.table.setHorizontalHeaderLabels(self.COLUMNS)
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        for col in range(1, 7):
            header.setSectionResizeMode(col, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(7, QHeaderView.Stretch)
        self.table.itemSelectionChanged.connect(self._on_select)
        self.table.cellDoubleClicked.connect(self._on_double_click)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.table)

    # -- refresh ----------------------------------------------------------
    def set_project(
        self, project: Optional[Project], session: Optional[Session] = None
    ) -> None:
        self.project = project
        self.session = session
        self.refresh()

    def set_current(self, eid: str) -> None:
        self._current_id = eid
        self.refresh(keep_selection=True)

    def row_for(self, eid: str) -> int:
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 0)
            if item is not None and item.data(Qt.UserRole) == eid:
                return row
        return -1

    def _on_double_click(self, row: int, col: int) -> None:
        item = self.table.item(row, 0)
        if item is None:
            return
        eid = item.data(Qt.UserRole)
        ev = self.project.event_by_id(eid) if self.project else None
        if ev is not None:
            self.requestSeek.emit(ev.start_ms)

    def refresh(self, keep_selection: bool = True) -> None:
        if self.project is None:
            self.table.setRowCount(0)
            return
        selected = self._current_id if keep_selection else ""
        events = self.project.sorted_events()
        self.table.blockSignals(True)
        self.table.setRowCount(len(events))
        first_issue: Dict[str, Issue] = {}
        for issue in self.project.all_issues():
            first_issue.setdefault(issue.event_id, issue)
        for row, ev in enumerate(events):
            status = self.project.event_status(ev)
            issue = first_issue.get(ev.eid)
            values = [
                str(row + 1),
                ms_to_short(ev.start_ms),
                ms_to_short(ev.end_ms),
                f"{ev.duration_ms / 1000:.2f}s",
                {"ok": "正常", "warning": "注意", "error": "错误"}[status],
                "🔒" if ev.locked else "",
                rows_caption(self.project, ev),
                summarize_text(
                    " | ".join(
                        f"{self.project.lang_label(lang)} "
                        f"{summarize_text(ev.text_for(lang), 28) or '（缺）'}"
                        for lang in self.project.lang_order
                    ),
                    80,
                ),
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setData(Qt.UserRole, ev.eid)
                if col in (1, 2, 3, 0):
                    item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if col == 4:
                    item.setForeground(QBrush(STATUS_COLORS.get(status, QColor("#333"))))
                if col == 5 and ev.locked:
                    item.setForeground(QBrush(STATUS_COLORS["locked"]))
                if col == 7 and issue is not None:
                    item.setToolTip(issue.message)
                self.table.setItem(row, col, item)
            if ev.eid == selected:
                self.table.selectRow(row)
                self.table.setCurrentCell(row, 0)
            if issue is not None:
                for col in range(len(self.COLUMNS)):
                    cell = self.table.item(row, col)
                    if cell:
                        cell.setToolTip(issue.message)
        self.table.blockSignals(False)

    def _on_select(self) -> None:
        items = self.table.selectedItems()
        if not items:
            return
        eid = items[0].data(Qt.UserRole)
        if eid:
            self._current_id = eid
            self.eventSelected.emit(eid)

    def selected_ids(self) -> List[str]:
        return [self._current_id] if self._current_id else []


# ---------------------------------------------------------------------------
# Event editor
# ---------------------------------------------------------------------------


class EventEditor(QWidget):
    changed = Signal()
    seekRequested = Signal(int)
    statusMessage = Signal(str)

    def __init__(self, session: Session, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.session = session
        self.eid = ""
        self._loaded_eid = ""
        self.playhead = 0
        self._building = False
        self._autosave = QTimer(self)
        self._autosave.setSingleShot(True)
        self._autosave.setInterval(700)
        self._autosave.timeout.connect(lambda: self._apply_text(silent=True))

        self.title = QLabel("未选择事件")
        self.title.setWordWrap(True)
        font = QFont()
        font.setBold(True)
        font.setPointSize(13)
        self.title.setFont(font)

        self.lock_box = QCheckBox("锁定此事件（锁定后时间、拆分、合并都不会改动它）")
        self.lock_box.toggled.connect(self._on_lock)

        self.start_edit = QLineEdit()
        self.end_edit = QLineEdit()
        for edit in (self.start_edit, self.end_edit):
            edit.setFont(MONO_FONT)
            edit.setMaximumWidth(130)
        self.start_edit.editingFinished.connect(self._on_time_edit)
        self.end_edit.editingFinished.connect(self._on_time_edit)
        self.goto_start = QToolButton()
        self.goto_start.setText("定位")
        self.goto_start.clicked.connect(
            lambda: self.seekRequested.emit(self._current_start())
        )
        self.goto_end = QToolButton()
        self.goto_end.setText("定位")
        self.goto_end.clicked.connect(
            lambda: self.seekRequested.emit(max(0, self._current_end() - 1))
        )
        time_row = QHBoxLayout()
        time_row.addWidget(QLabel("开始"))
        time_row.addWidget(self.start_edit)
        time_row.addWidget(self.goto_start)
        time_row.addSpacing(12)
        time_row.addWidget(QLabel("结束"))
        time_row.addWidget(self.end_edit)
        time_row.addWidget(self.goto_end)
        self.shift_box = QDoubleSpinBox()
        self.shift_box.setRange(-60.0, 60.0)
        self.shift_box.setDecimals(2)
        self.shift_box.setSingleStep(0.1)
        self.shift_box.setSuffix(" 秒")
        self.shift_box.setValue(0.2)
        self.shift_btn = QPushButton("整体平移")
        self.shift_btn.clicked.connect(self._on_shift)
        time_row.addSpacing(12)
        time_row.addWidget(self.shift_box)
        time_row.addWidget(self.shift_btn)
        time_row.addStretch(1)

        self.texts: Dict[str, QPlainTextEdit] = {}
        self.text_labels: Dict[str, QLabel] = {}
        self.missing_buttons: Dict[str, QPushButton] = {}
        self.text_grid = QGridLayout()
        self.text_grid.setColumnStretch(0, 0)
        self.text_grid.setColumnStretch(1, 1)
        self.texts_container = QWidget()
        self.texts_container.setLayout(self.text_grid)
        self._built_langs: List[str] = []
        self._rebuild_language_fields()

        btn_row = QHBoxLayout()
        self.btn_apply_text = QPushButton("应用文字修改")
        self.btn_apply_text.setToolTip("把上面的文字写入事件（会记录一步撤销）")
        self.btn_apply_text.clicked.connect(self._on_apply_text)
        self.btn_split = QPushButton("在此处拆分…")
        self.btn_split.setToolTip("用时间轴当前位置把这一条拆成两条，文字按行/比例分到两边")
        self.btn_split.clicked.connect(self._on_split)
        self.btn_merge = QPushButton("与上一条合并")
        self.btn_merge.clicked.connect(self._on_merge_prev)
        self.btn_unpair = QPushButton("拆配（按语言分开）")
        self.btn_unpair.clicked.connect(self._on_unpair)
        self.btn_move_cut = QPushButton("避开切点")
        self.btn_move_cut.setToolTip("自动把这一条收拢或平移到切点一侧")
        self.btn_move_cut.clicked.connect(self._on_move_off_cut)
        self.btn_lock_cut = QPushButton("切点处拆开")
        self.btn_lock_cut.clicked.connect(self._on_split_at_cut)
        for btn in (
            self.btn_apply_text,
            self.btn_split,
            self.btn_merge,
            self.btn_unpair,
            self.btn_move_cut,
            self.btn_lock_cut,
        ):
            btn_row.addWidget(btn)
        btn_row.addStretch(1)

        self.issues = QListWidget()
        self.issues.setMaximumHeight(96)
        self.issues.setSelectionMode(QAbstractItemView.SingleSelection)
        self.issues.itemDoubleClicked.connect(self._on_issue_double_click)

        self.hint = QLabel("")
        self.hint.setWordWrap(True)
        self.hint.setStyleSheet("color: #455a64;")

        layout = QVBoxLayout(self)
        layout.addWidget(self.title)
        layout.addWidget(self.lock_box)
        layout.addLayout(time_row)
        layout.addWidget(self.texts_container)
        layout.addLayout(btn_row)
        layout.addWidget(QLabel("本条的检查结果："))
        layout.addWidget(self.issues)
        layout.addWidget(self.hint)
        layout.addStretch(1)

        self.setEnabled(False)

    # -- language fields --------------------------------------------------
    def _rebuild_language_fields(self) -> None:
        """(Re)create one text editor per language of the current project."""
        langs = list(self.session.project.lang_order)
        if langs == self._built_langs:
            return
        while self.text_grid.count():
            item = self.text_grid.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        self.texts.clear()
        self.text_labels.clear()
        self.missing_buttons.clear()
        for index, lang in enumerate(langs):
            label = QLabel(self.session.project.lang_label(lang))
            label.setStyleSheet(
                f"color: {lang_color(index).name()}; font-weight: bold;"
            )
            edit = QPlainTextEdit()
            edit.setFont(MONO_FONT)
            edit.setMinimumHeight(64)
            edit.setTabChangesFocus(True)
            edit.textChanged.connect(
                lambda lang=lang: self._on_text_changed(lang)
            )
            btn = QPushButton("补占位")
            btn.setToolTip("该语言缺失时补一个空行占位，导出时仍保留另一语言原文")
            btn.clicked.connect(lambda _=False, lang=lang: self._on_add_missing(lang))
            self.texts[lang] = edit
            self.text_labels[lang] = label
            self.missing_buttons[lang] = btn
            self.text_grid.addWidget(label, index, 0, Qt.AlignTop)
            box = QVBoxLayout()
            box.addWidget(edit)
            meta = QHBoxLayout()
            hint = QLabel("")
            hint.setStyleSheet("color: #607d8b;")
            meta.addWidget(hint, 1)
            meta.addWidget(btn)
            box.addLayout(meta)
            holder = QWidget()
            holder.setLayout(box)
            self.text_grid.addWidget(holder, index, 1)
            edit.setProperty("hintLabel", hint)
        self._built_langs = langs

    def refresh_languages(self) -> None:
        self._rebuild_language_fields()
        self.reload()

    # -- helpers ----------------------------------------------------------
    def _ev(self) -> Optional[Event]:
        return self.session.project.event_by_id(self.eid) if self.eid else None

    def _current_start(self) -> int:
        ev = self._ev()
        return ev.start_ms if ev else 0

    def _current_end(self) -> int:
        ev = self._ev()
        return ev.end_ms if ev else 0

    def set_event(self, eid: str, playhead: int) -> None:
        if eid == self.eid:
            self.playhead = playhead
            self.reload()
            return
        # Flush while ``_loaded_eid`` still names the event the fields show.
        wrote = self.flush_pending_text(notify=False)
        self.eid = eid
        self.playhead = playhead
        self._loaded_eid = ""  # fields are stale until reload() repopulates
        self.reload()
        if wrote:
            self.session.end_text_edit_burst()
            self.changed.emit()

    def set_playhead(self, playhead: int) -> None:
        """Track the playhead *without* touching text the user is typing."""
        self.playhead = playhead

    # -- pending text -----------------------------------------------------
    @staticmethod
    def _normalized(text: str) -> str:
        return "\n".join(ln.strip() for ln in text.splitlines() if ln.strip())

    def _dirty_langs(self) -> List[str]:
        ev = self._ev()
        if ev is None or not self.texts:
            return []
        # Text shown in the widgets belongs to *this* event; if the editor was
        # pointed at a different event the fields are not yet loaded, so any
        # difference is not a user edit.
        if self._loaded_eid != self.eid:
            return []
        dirty = []
        for lang, edit in self.texts.items():
            if not edit.isEnabled():
                continue
            if self._normalized(edit.toPlainText()) != self._normalized(
                ev.text_for(lang)
            ):
                dirty.append(lang)
        return dirty

    def flush_pending_text(self, notify: bool = True) -> bool:
        """Write unsaved text edits into the event before switching away.

        Returns True when something was written.  Keeps the user from losing
        a typed translation just because they clicked another event.
        """
        dirty = self._dirty_langs()
        if not dirty:
            return False
        for lang in dirty:
            self.session.set_event_text(
                self.eid, lang, self.texts[lang].toPlainText()
            )
        if notify:
            self.session.end_text_edit_burst()
            self.statusMessage.emit("已自动保存上一条的文字修改")
            self.changed.emit()
        return True

    def reload(self) -> None:
        ev = self._ev()
        dirty = self._dirty_langs() if self._loaded_eid == self.eid else []
        if ev is not None and dirty:
            # A background refresh must not wipe what the user is typing.
            self._reload_issues()
            self._update_buttons()
            return
        self._building = True
        try:
            if ev is None:
                self.setEnabled(False)
                self.title.setText("未选择事件")
                return
            self.setEnabled(True)
            project = self.session.project
            self.title.setText(
                f"{ev.eid}  ·  {ms_to_timestamp(ev.start_ms)} – "
                f"{ms_to_timestamp(ev.end_ms)}  ·  {ev.duration_ms / 1000:.2f}s"
                + (f"  ·  关联组 {ev.split_group}" if ev.split_group else "")
            )
            self.lock_box.setChecked(ev.locked)
            self.start_edit.setText(ms_to_timestamp(ev.start_ms))
            self.end_edit.setText(ms_to_timestamp(ev.end_ms))
            for lang in project.lang_order:
                if lang not in self.texts:
                    continue
                rows = ev.rows_for(lang)
                text = "\n".join(r.text for r in rows if r.visible)
                edit = self.texts[lang]
                edit.blockSignals(True)
                edit.setPlainText(text)
                edit.blockSignals(False)
                hint: QLabel = edit.property("hintLabel")
                if not rows:
                    hint.setText("该语言没有内容 — 可补占位，导出会保留其他语言原文")
                    edit.setEnabled(False)
                elif all(r.missing for r in rows):
                    hint.setText("缺翻译占位 — 可直接输入译文")
                    edit.setEnabled(True)
                else:
                    line_count = sum(len(r.lines) for r in rows if r.visible)
                    prof = project.profiles.get(lang) or project.ensure_language(lang)
                    chars = sum(len("".join(r.text.split())) for r in rows if r.visible)
                    cps = chars / max(0.001, ev.duration_ms / 1000)
                    hint.setText(
                        f"{line_count} 行 / 上限 {prof.max_lines}；"
                        f"{chars} 字 / {cps:.1f} 字每秒，上限 {prof.max_cps:.1f}"
                    )
                    edit.setEnabled(True)
                self.missing_buttons[lang].setVisible(not rows)
            self._loaded_eid = self.eid
            self._reload_issues()
            self._update_buttons()
        finally:
            self._building = False

    def _reload_issues(self) -> None:
        self.issues.clear()
        if not self.eid:
            return
        issues = self.session.project.issues_for_event(self.eid)
        if not issues:
            item = QListWidgetItem("没有检出问题")
            item.setForeground(QBrush(STATUS_COLORS["ok"]))
            self.issues.addItem(item)
            return
        for issue in issues:
            item = QListWidgetItem(
                f"{issue.severity} · {issue.kind} · {issue.message}"
            )
            item.setData(Qt.UserRole, issue.time_ms)
            item.setForeground(
                QBrush(
                    STATUS_COLORS["error"]
                    if issue.severity == "error"
                    else STATUS_COLORS["warning"]
                    if issue.severity == "warning"
                    else QColor("#546e7a")
                )
            )
            self.issues.addItem(item)

    def _update_buttons(self) -> None:
        ev = self._ev()
        locked = bool(ev and ev.locked)
        for btn in (
            self.btn_split,
            self.btn_merge,
            self.btn_unpair,
            self.btn_move_cut,
            self.btn_lock_cut,
            self.shift_btn,
        ):
            btn.setEnabled(bool(ev) and not locked)
        # 锁定保护时间、拆分、合并与文字：锁定的内容在重排时整体保留。
        self.btn_apply_text.setEnabled(bool(ev) and not locked)
        self.lock_box.setEnabled(bool(ev))
        for edit in self.texts.values():
            if locked:
                edit.setReadOnly(True)
            else:
                edit.setReadOnly(False)
        if ev is not None:
            has_cut = any(ev.start_ms < c < ev.end_ms for c in self.session.project.cuts)
            self.btn_move_cut.setEnabled(not locked and has_cut)
            self.btn_lock_cut.setEnabled(not locked and has_cut)

    # -- slots ------------------------------------------------------------
    def _on_lock(self, checked: bool) -> None:
        if self._building or not self.eid:
            return
        if self.session.lock_event(self.eid, checked):
            self.statusMessage.emit("已锁定" if checked else "已解锁")
            self.changed.emit()

    def _apply_window(self, start: int, end: int) -> None:
        result = self.session.set_event_window(self.eid, start, end)
        if not result.applied and result.warnings:
            detail = "\n".join(f"• {w}" for w in result.warnings)
            answer = QMessageBox.warning(
                self,
                "调整会带来影响",
                "这个调整会：\n" + detail + "\n\n仍要应用吗？",
                QMessageBox.Apply | QMessageBox.Cancel,
                QMessageBox.Cancel,
            )
            if answer == QMessageBox.Apply:
                result = self.session.set_event_window(
                    self.eid, start, end, acknowledge=True
                )
        if result.applied:
            for w in result.warnings:
                self.statusMessage.emit("已应用，附注：" + w)
            if not result.warnings:
                self.statusMessage.emit("时间已更新")
            self.changed.emit()
        else:
            if result.error:
                self.statusMessage.emit(result.error)
                QMessageBox.warning(self, "无法调整", result.error)
            self.reload()

    def _on_time_edit(self) -> None:
        if self._building or not self.eid:
            return
        try:
            start = parse_short(self.start_edit.text())
            end = parse_short(self.end_edit.text())
        except ValueError as exc:
            QMessageBox.warning(self, "时间格式", f"时间无法解析：{exc}")
            self.reload()
            return
        ev = self._ev()
        if ev and (start, end) == (ev.start_ms, ev.end_ms):
            return
        self._apply_window(start, end)

    def _on_shift(self) -> None:
        ev = self._ev()
        if ev is None:
            return
        delta = int(round(self.shift_box.value() * 1000))
        self._apply_window(ev.start_ms + delta, ev.end_ms + delta)

    def _on_text_changed(self, lang: str) -> None:
        if self._building:
            return
        self.btn_apply_text.setEnabled(True)
        self.btn_apply_text.setText("应用文字修改 •")
        self._autosave.start()

    def _apply_text(self, silent: bool = False) -> None:
        if not self.eid or self._building:
            return
        dirty = self._dirty_langs()
        if not dirty:
            return
        for lang in dirty:
            self.session.set_event_text(
                self.eid, lang, self.texts[lang].toPlainText()
            )
        self.btn_apply_text.setText("应用文字修改")
        if not silent:
            self.session.end_text_edit_burst()
            self.statusMessage.emit("文字已更新（可撤销）")
        self.changed.emit()

    def _on_apply_text(self) -> None:
        self._autosave.stop()
        self._apply_text(silent=False)

    def _on_split(self) -> None:
        ev = self._ev()
        if ev is None:
            return
        at = self.playhead
        if not (ev.start_ms < at < ev.end_ms):
            at = (ev.start_ms + ev.end_ms) // 2
            QMessageBox.information(
                self,
                "使用中点拆分",
                "播放头不在该字幕范围内，已改用中点作为拆分点。",
            )
        new_id, error = self.session.split_event(ev.eid, at)
        if error:
            QMessageBox.warning(self, "无法拆分", error)
            return
        self.statusMessage.emit(f"已拆分成两条（关联组 {self.session.project.event_by_id(ev.eid).split_group}）")
        self.changed.emit()

    def _on_merge_prev(self) -> None:
        events = self.session.project.sorted_events()
        ids = [e.eid for e in events]
        if self.eid not in ids or ids.index(self.eid) == 0:
            self.statusMessage.emit("没有可合并的上一条")
            return
        prev = events[ids.index(self.eid) - 1]
        target, error = self.session.merge_events([prev.eid, self.eid])
        if error:
            QMessageBox.warning(self, "无法合并", error)
            return
        self.eid = target or self.eid
        self.statusMessage.emit("已合并两条")
        self.changed.emit()

    def _on_unpair(self) -> None:
        ids, error = self.session.unpair_event(self.eid)
        if error:
            QMessageBox.warning(self, "无法拆配", error)
            return
        self.statusMessage.emit("已按语言拆开（各自恢复原轨时间）")
        self.changed.emit()

    def _on_move_off_cut(self) -> None:
        ok, message = self.session.move_event_off_cuts(self.eid, "shrink")
        self.statusMessage.emit(message)
        if ok:
            self.changed.emit()
        else:
            QMessageBox.information(self, "未改动", message)
            self.reload()

    def _on_split_at_cut(self) -> None:
        new_id, error = self.session.split_at_cut(self.eid)
        if error:
            QMessageBox.warning(self, "无法拆分", error)
            return
        self.statusMessage.emit("已在切点处拆开")
        self.changed.emit()

    def _on_add_missing(self, lang: str) -> None:
        if self.session.add_missing_language(self.eid, lang):
            self.statusMessage.emit("已补占位")
            self.changed.emit()

    def _on_issue_double_click(self, item: QListWidgetItem) -> None:
        t = item.data(Qt.UserRole)
        if t is not None:
            self.seekRequested.emit(int(t))


# ---------------------------------------------------------------------------
# Pairing panel
# ---------------------------------------------------------------------------


class PairingPanel(QWidget):
    applied = Signal()
    aboutToApply = Signal()
    manualRequested = Signal()
    statusMessage = Signal(str)

    def __init__(self, session: Session, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.session = session
        self.suggestions: List[PairingSuggestion] = []

        self.anchor_combo = QComboBox()
        self.anchor_combo.setToolTip("以哪条轨的时间为主（另一轨按它对齐）")
        self.refresh_languages()
        self.align_combo = QComboBox()
        self.align_combo.addItem("按主轨时间", "anchor")
        self.align_combo.addItem("取两边并集", "union")
        self.align_combo.addItem("按副轨时间", "other")
        self.filter_combo = QComboBox()
        self.filter_combo.addItem("全部建议", "all")
        self.filter_combo.addItem("仅 1:1 配对", "pair")
        self.filter_combo.addItem("仅拆分", "split")
        self.filter_combo.addItem("仅缺翻译", "missing")
        self.filter_combo.currentIndexChanged.connect(lambda _=0: self.refresh_list())

        self.btn_scan = QPushButton("扫描配对建议")
        self.btn_scan.clicked.connect(self.refresh)
        self.btn_apply_sel = QPushButton("应用选中")
        self.btn_apply_sel.clicked.connect(self._apply_selected)
        self.btn_apply_all = QPushButton("应用全部建议")
        self.btn_apply_all.clicked.connect(self._apply_all)
        self.btn_rebuild = QPushButton("重建未锁定")
        self.btn_rebuild.setToolTip("丢弃所有未锁定事件，按当前建议重新配对；锁定事件与其原字幕保持不变")
        self.btn_rebuild.clicked.connect(self._rebuild)
        self.btn_manual = QPushButton("手工配对…")
        self.btn_manual.setToolTip("自动建议不对时，手动挑两边字幕配成一条，或把多选的一侧手工拆分")
        self.btn_manual.clicked.connect(lambda: self.manualRequested.emit())
        self.lock_applied = QCheckBox("应用后立即锁定")

        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["类型", "时间", "内容", "说明"])
        self.tree.setRootIsDecorated(False)
        self.tree.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.tree.setAlternatingRowColors(True)
        header = self.tree.header()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.Stretch)
        header.setSectionResizeMode(3, QHeaderView.Stretch)

        opts = QHBoxLayout()
        opts.addWidget(QLabel("主轨"))
        opts.addWidget(self.anchor_combo)
        opts.addWidget(QLabel("对齐"))
        opts.addWidget(self.align_combo)
        opts.addWidget(QLabel("筛选"))
        opts.addWidget(self.filter_combo)
        opts.addStretch(1)
        actions = QHBoxLayout()
        for btn in (
            self.btn_scan,
            self.btn_apply_sel,
            self.btn_apply_all,
            self.btn_rebuild,
            self.btn_manual,
        ):
            actions.addWidget(btn)
        actions.addWidget(self.lock_applied)
        actions.addStretch(1)
        layout = QVBoxLayout(self)
        layout.addLayout(opts)
        layout.addLayout(actions)
        layout.addWidget(self.tree, 1)

    def refresh_languages(self) -> None:
        current = self.anchor_combo.currentData()
        self.anchor_combo.clear()
        for lang in self.session.project.lang_order:
            self.anchor_combo.addItem(self.session.project.lang_label(lang), lang)
        if current:
            idx = self.anchor_combo.findData(current)
            if idx >= 0:
                self.anchor_combo.setCurrentIndex(idx)

    # -- data -------------------------------------------------------------
    def refresh(self) -> None:
        anchor = self.anchor_combo.currentData()
        self.suggestions = self.session.suggestions(anchor)
        self.refresh_list()

    def refresh_list(self) -> None:
        wanted = self.filter_combo.currentData()
        cues = self.session.project.all_cues()
        self.tree.clear()
        for sug in self.suggestions:
            if wanted != "all" and sug.kind != wanted:
                continue
            lines = []
            for uid in sug.anchor_uids + sug.other_uids:
                cue = cues.get(uid)
                if cue is None:
                    continue
                tag = self.session.project.lang_label(cue.lang)
                flat = " / ".join(ln.strip() for ln in cue.text.splitlines() if ln.strip())
                lines.append(f"[{tag}] {flat}")
            item = QTreeWidgetItem(
                [
                    sug.label,
                    f"{ms_to_short(sug.start_ms)}–{ms_to_short(sug.end_ms)}",
                    " ⏎ ".join(lines),
                    sug.reason,
                ]
            )
            item.setData(0, Qt.UserRole, sug)
            color = {
                "pair": QColor("#1b5e20"),
                "split": QColor("#00695c"),
                "missing": QColor("#8e24aa"),
            }.get(sug.kind, QColor("#333"))
            item.setForeground(0, QBrush(color))
            self.tree.addTopLevelItem(item)
        self.statusMessage.emit(f"{len(self.suggestions)} 条配对建议")

    def _selected(self) -> List[PairingSuggestion]:
        return [
            item.data(0, Qt.UserRole)
            for item in self.tree.selectedItems()
            if item.data(0, Qt.UserRole)
        ]

    def _apply_selected(self) -> None:
        chosen = self._selected()
        if not chosen:
            self.statusMessage.emit("请先在列表中选中建议")
            return
        self._apply(chosen)

    def _apply_all(self) -> None:
        if not self.suggestions:
            self.statusMessage.emit("没有可应用的建议，先扫描")
            return
        self._apply(list(self.suggestions))

    def _apply(self, chosen: Sequence[PairingSuggestion]) -> None:
        used = self.session.project.used_origins()
        fresh = [
            s for s in chosen
            if not any(uid in used for uid in s.anchor_uids + s.other_uids)
        ]
        skipped = len(chosen) - len(fresh)
        if not fresh:
            self.statusMessage.emit(
                "选中的建议所用的字幕都已在事件里，未重复生成；"
                "如需重新配对请用「重建未锁定」"
            )
            return
        align = self.align_combo.currentData()
        lock = self.lock_applied.isChecked()
        self.aboutToApply.emit()
        created = self.session.apply_suggestions(fresh, align=align, lock=lock)
        message = f"已生成 {len(created)} 条事件"
        if skipped:
            message += f"；跳过 {skipped} 条已使用的建议"
        self.statusMessage.emit(message)
        self.applied.emit()

    def _rebuild(self) -> None:
        answer = QMessageBox.question(
            self,
            "重建未锁定",
            "将丢弃所有未锁定事件并按当前主轨重新配对。\n"
            "锁定的事件及其原字幕会保留不动。继续吗？",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if answer != QMessageBox.Yes:
            return
        self.aboutToApply.emit()
        created = self.session.rebuild_unlocked(self.anchor_combo.currentData())
        self.statusMessage.emit(f"重建完成，生成 {len(created)} 条未锁定事件")
        self.applied.emit()


# ---------------------------------------------------------------------------
# Scene cuts panel
# ---------------------------------------------------------------------------


class CutsPanel(QWidget):
    changed = Signal()
    seekRequested = Signal(int)
    statusMessage = Signal(str)

    def __init__(self, session: Session, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.session = session
        self.editor = QPlainTextEdit()
        self.editor.setFont(MONO_FONT)
        self.editor.setPlaceholderText(
            "每行一个切点，可用秒数 (12.5)、MM:SS.mmm 或 HH:MM:SS,mmm；\n"
            "也接受 00:00:12,000 --> 00:00:15,000 这样的镜头范围（取起点）。\n"
            "# 开头为注释。"
        )
        self.editor.setMinimumHeight(120)
        self.btn_apply = QPushButton("应用切点")
        self.btn_apply.clicked.connect(self._apply)
        self.btn_reload = QPushButton("从工程重载")
        self.btn_reload.clicked.connect(self.reload)
        self.summary = QLabel("")
        self.summary.setWordWrap(True)
        row = QHBoxLayout()
        row.addWidget(self.btn_apply)
        row.addWidget(self.btn_reload)
        row.addWidget(self.summary, 1)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("场景切点（可编辑，应用后立即参与检查与预览）"))
        layout.addWidget(self.editor, 1)
        layout.addLayout(row)
        self.reload()

    def reload(self) -> None:
        from ..srt import format_cut_column

        self.editor.setPlainText(format_cut_column(self.session.project.cuts))
        self.summary.setText(self._summary())

    def _summary(self) -> str:
        cuts = self.session.project.cuts
        if not cuts:
            return "当前没有切点"
        return f"{len(cuts)} 个切点：" + "，".join(ms_to_short(c) for c in cuts[:8]) + (
            " …" if len(cuts) > 8 else ""
        )

    def _apply(self) -> None:
        try:
            count = self.session.set_cuts_text(self.editor.toPlainText())
        except ValueError as exc:
            QMessageBox.warning(self, "切点格式", str(exc))
            return
        self.summary.setText(self._summary())
        self.statusMessage.emit(f"已应用 {count} 个切点")
        self.changed.emit()


# ---------------------------------------------------------------------------
# Issues / verification panel
# ---------------------------------------------------------------------------


class IssuesPanel(QWidget):
    seekRequested = Signal(int)
    eventRequested = Signal(str)

    COLUMNS = ["级别", "时间", "事件", "类型", "说明"]

    def __init__(self, session: Session, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.session = session
        self.table = QTableWidget(0, len(self.COLUMNS))
        self.table.setHorizontalHeaderLabels(self.COLUMNS)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setAlternatingRowColors(True)
        header = self.table.horizontalHeader()
        for col in range(4):
            header.setSectionResizeMode(col, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(4, QHeaderView.Stretch)
        self.table.doubleClicked.connect(self._on_double_click)
        self.auto_scroll = QCheckBox("只看当前事件")
        self.auto_scroll.setChecked(False)
        self.show_labels = QCheckBox("导出时给每行加语言标签")
        self.show_labels.setToolTip(
            "例如 [英文] / [中文]；适合校对，不适合直接上屏"
        )
        self.counts = QLabel("")
        self.verify_label = QLabel("")
        self.verify_label.setWordWrap(True)
        self.export_opts = ExportOptions()
        self.show_labels.toggled.connect(self._on_labels_toggled)
        top = QHBoxLayout()
        top.addWidget(self.counts, 1)
        top.addWidget(self.show_labels)
        top.addWidget(self.auto_scroll)
        layout = QVBoxLayout(self)
        layout.addLayout(top)
        layout.addWidget(self.table, 1)
        layout.addWidget(self.verify_label)

    def _on_labels_toggled(self, checked: bool) -> None:
        self.export_opts.include_lang_labels = checked

    def refresh(self, only_eid: str = "") -> None:
        project = self.session.project
        issues = project.all_issues()
        if only_eid and self.auto_scroll.isChecked():
            issues = [i for i in issues if i.event_id == only_eid]
        self.table.setRowCount(len(issues))
        for row, issue in enumerate(issues):
            values = [
                {"error": "错误", "warning": "注意", "info": "提示"}.get(
                    issue.severity, issue.severity
                ),
                ms_to_short(issue.time_ms),
                issue.event_id,
                issue.kind,
                issue.message,
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setData(Qt.UserRole, (issue.event_id, issue.time_ms))
                if col == 0:
                    item.setForeground(
                        QBrush(STATUS_COLORS.get(issue.severity, QColor("#333")))
                    )
                self.table.setItem(row, col, item)
        counts = project.counts()
        self.counts.setText(
            f"{counts['events']} 条事件 · {counts['errors']} 个错误 · "
            f"{counts['warnings']} 个注意 · {counts['locked']} 条已锁定"
        )

    def _on_double_click(self, index) -> None:
        item = self.table.item(index.row(), 0)
        if item is None:
            return
        data = item.data(Qt.UserRole)
        if data:
            eid, t = data
            self.eventRequested.emit(eid)
            self.seekRequested.emit(int(t))

    def show_verify(self, text: str, ok: Optional[bool] = None) -> None:
        color = "#2e7d32" if ok else "#b26a00"
        self.verify_label.setStyleSheet(f"color: {color};")
        self.verify_label.setText(text)


# ---------------------------------------------------------------------------
# Preview panel: rows on screen at playhead
# ---------------------------------------------------------------------------


class PreviewPanel(QWidget):
    def __init__(self, session: Session, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.session = session
        self.time_label = QLabel("00:00.000")
        self.time_label.setFont(MONO_FONT)
        font = QFont()
        font.setPointSize(16)
        self.time_label.setFont(font)
        self.time_edit = QLineEdit()
        self.time_edit.setMaximumWidth(120)
        self.time_edit.setFont(MONO_FONT)
        self.time_edit.editingFinished.connect(self._on_time_edit)
        self.set_time_btn = QPushButton("跳到")
        self.set_time_btn.clicked.connect(self._on_time_edit)
        self.rows_box = QVBoxLayout()
        self.rows_box.setSpacing(6)
        self.rows_holder = QWidget()
        self.rows_holder.setLayout(self.rows_box)
        self.notes = QListWidget()
        self.notes.setMaximumHeight(110)
        self.notes.setWordWrap(True)
        top = QHBoxLayout()
        top.addWidget(QLabel("预览时刻"))
        top.addWidget(self.time_label)
        top.addStretch(1)
        top.addWidget(QLabel("输入"))
        top.addWidget(self.time_edit)
        top.addWidget(self.set_time_btn)
        layout = QVBoxLayout(self)
        layout.addLayout(top)
        frame = QFrame()
        frame.setFrameShape(QFrame.StyledPanel)
        frame.setStyleSheet("background: #111;")
        frame_layout = QVBoxLayout(frame)
        self.screen = QLabel("（此刻没有字幕）")
        self.screen.setWordWrap(True)
        self.screen.setAlignment(Qt.AlignCenter)
        screen_font = QFont()
        screen_font.setPointSize(17)
        self.screen.setFont(screen_font)
        self.screen.setStyleSheet("color: #f5f5f5; padding: 18px;")
        self.screen.setMinimumHeight(140)
        frame_layout.addWidget(self.screen)
        layout.addWidget(frame)
        layout.addWidget(QLabel("此刻出现的行（按语言）："))
        layout.addWidget(self.rows_holder)
        layout.addWidget(QLabel("此刻相关提示："))
        layout.addWidget(self.notes)
        self.set_time(0)

    def _on_time_edit(self) -> None:
        try:
            t = parse_short(self.time_edit.text())
        except ValueError:
            return
        self.set_time(t)

    def set_time(self, t: int) -> None:
        self.time_ms = t
        self.time_label.setText(ms_to_timestamp(t))
        self.time_edit.setText(ms_to_short(t))
        project = self.session.project
        pairs = project.rows_at(t)
        # clear dynamic rows
        while self.rows_box.count():
            item = self.rows_box.takeAt(0)
            widget = item.widget()
            if widget:
                widget.deleteLater()
        self.notes.clear()
        if not pairs:
            self.screen.setText("（此刻没有字幕）")
            self.screen.setStyleSheet(
                "color: #9e9e9e; padding: 18px; background: #111;"
            )
            return
        screen_lines = []
        langs_seen: List[str] = []
        for ev, row in pairs:
            screen_lines.append(row.text)
            if row.lang not in langs_seen:
                langs_seen.append(row.lang)
        self.screen.setText("\n".join(screen_lines))
        self.screen.setStyleSheet("color: #ffffff; padding: 18px; background: #111;")
        for ev, row in pairs:
            index = (
                project.lang_order.index(row.lang)
                if row.lang in project.lang_order
                else 0
            )
            lab = QLabel(
                f"{ms_to_short(ev.start_ms)}–{ms_to_short(ev.end_ms)} · "
                f"{project.lang_label(row.lang)}（{ev.eid}）: {row.text.replace(chr(10), ' / ')}"
            )
            lab.setWordWrap(True)
            lab.setStyleSheet(f"color: {lang_color(index).name()};")
            self.rows_box.addWidget(lab)
        seen = set()
        for ev, _row in pairs:
            if ev.eid in seen:
                continue
            seen.add(ev.eid)
            for issue in project.check_event(ev):
                item = QListWidgetItem(
                    f"{ev.eid} · {issue.severity} · {issue.message}"
                )
                item.setForeground(
                    QBrush(
                        STATUS_COLORS["error"]
                        if issue.severity == "error"
                        else STATUS_COLORS["warning"]
                    )
                )
                self.notes.addItem(item)
        if not self.notes.count():
            self.notes.addItem("此刻显示的事件没有检查问题")
