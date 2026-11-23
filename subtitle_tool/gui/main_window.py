"""Main window: wiring panels, menus, import/export and verification."""

from __future__ import annotations

import os
from typing import Dict, Optional

from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QStatusBar,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ..export import ExportOptions
from ..examples import example_paths
from ..session import Session
from .panels import (
    CutsPanel,
    EventEditor,
    EventTable,
    IssuesPanel,
    PairingPanel,
    PreviewPanel,
)
from .timeline import TimelineWidget
from .verify_dialog import VerifyDialog
from .manual_pair import ManualPairDialog

APP_TITLE = "双语字幕重排台 · Subtitle Reflow"


class ProfileDialog(QDialog):
    def __init__(self, session: Session, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.session = session
        self.setWindowTitle("阅读速度与行数预算")
        layout = QVBoxLayout(self)
        note = QLabel(
            "阅读速度按「非空白字符数 ÷ 时长」计算。\n"
            "总行数是合并后一条事件最多可占的行数（两条语言轨加起来）。"
        )
        note.setWordWrap(True)
        layout.addWidget(note)
        self.forms: Dict[str, tuple] = {}
        for lang in session.project.lang_order:
            prof = session.project.profiles.get(lang) or session.project.ensure_language(lang)
            box = QGroupBox(prof.label)
            form = QFormLayout(box)
            cps = QDoubleSpinBox()
            cps.setRange(1.0, 60.0)
            cps.setDecimals(1)
            cps.setValue(prof.max_cps)
            lines = QSpinBox()
            lines.setRange(1, 6)
            lines.setValue(prof.max_lines)
            chars = QSpinBox()
            chars.setRange(5, 200)
            chars.setValue(prof.max_chars_per_line)
            form.addRow("最大字/秒", cps)
            form.addRow("单语最大行数", lines)
            form.addRow("每行最大字数", chars)
            self.forms[lang] = (cps, lines, chars)
            layout.addWidget(box)
        budget_box = QGroupBox("合并总行数预算")
        budget_form = QFormLayout(budget_box)
        self.budget = QSpinBox()
        self.budget.setRange(1, 12)
        self.budget.setValue(session.project.total_lines_budget)
        budget_form.addRow("每条事件最多行数", self.budget)
        self.gap = QSpinBox()
        self.gap.setRange(0, 2000)
        self.gap.setSingleStep(10)
        self.gap.setValue(session.project.min_gap_ms)
        budget_form.addRow("相邻最小间隔 (ms)", self.gap)
        layout.addWidget(budget_box)
        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def accept(self) -> None:
        for lang, (cps, lines, chars) in self.forms.items():
            self.session.set_profile(
                lang,
                max_cps=cps.value(),
                max_lines=lines.value(),
                max_chars_per_line=chars.value(),
            )
        self.session.set_total_lines_budget(self.budget.value())
        self.session.project.min_gap_ms = self.gap.value()
        super().accept()


class ImportDialog(QDialog):
    """Choose the two SRT files and their languages."""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("导入两份字幕")
        self.paths: Dict[str, QLineEdit] = {}
        self.lang_edits: Dict[str, QLineEdit] = {}
        layout = QVBoxLayout(self)
        for side, default_lang, default_file in (
            ("A", "en", "en.srt"),
            ("B", "zh", "zh.srt"),
        ):
            box = QGroupBox(f"字幕 {side}")
            form = QFormLayout(box)
            path_edit = QLineEdit()
            browse = QPushButton("浏览…")
            row = QHBoxLayout()
            row.addWidget(path_edit, 1)
            row.addWidget(browse)
            holder = QWidget()
            holder.setLayout(row)
            lang_edit = QLineEdit(default_lang)
            lang_edit.setMaximumWidth(80)
            form.addRow("文件", holder)
            form.addRow("语言代码", lang_edit)
            browse.clicked.connect(
                lambda _=False, e=path_edit, f=default_file: self._browse(e, f)
            )
            self.paths[side] = path_edit
            self.lang_edits[side] = lang_edit
            layout.addWidget(box)
        cuts_row = QHBoxLayout()
        self.cuts_path = QLineEdit()
        cuts_browse = QPushButton("浏览…")
        cuts_browse.clicked.connect(lambda: self._browse(self.cuts_path, "cuts.txt"))
        cuts_row.addWidget(QLabel("切点文件（可选）"))
        cuts_row.addWidget(self.cuts_path, 1)
        cuts_row.addWidget(cuts_browse)
        layout.addLayout(cuts_row)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def _browse(self, edit: QLineEdit, default_name: str) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择文件",
            os.path.join(os.getcwd(), default_name),
            "字幕与切点 (*.srt *.txt *.csv);;所有文件 (*)",
        )
        if path:
            edit.setText(path)

    def values(self):
        return (
            self.paths["A"].text().strip(),
            self.lang_edits["A"].text().strip() or "en",
            self.paths["B"].text().strip(),
            self.lang_edits["B"].text().strip() or "zh",
            self.cuts_path.text().strip(),
        )


class MainWindow(QMainWindow):
    def __init__(self, session: Optional[Session] = None) -> None:
        super().__init__()
        self.session = session or Session()
        self.playhead = 0
        self.current_eid = ""
        self.settings = QSettings("subtitle-reflow", "app")
        self.setWindowTitle(APP_TITLE)
        self.resize(1440, 900)

        self._build_ui()
        self._build_actions()
        self._connect()
        self.refresh_all()
        self._maybe_restore()

    # -- construction -----------------------------------------------------
    def _build_ui(self) -> None:
        self.timeline = TimelineWidget()
        self.preview = PreviewPanel(self.session)
        self.event_table = EventTable()
        self.editor = EventEditor(self.session)
        self.pairing = PairingPanel(self.session)
        self.cuts = CutsPanel(self.session)
        self.issues = IssuesPanel(self.session)

        self.tabs = QTabWidget()
        self.tabs.addTab(self.pairing, "配对建议")
        self.tabs.addTab(self.cuts, "场景切点")
        self.tabs.addTab(self.issues, "检查与核对")

        right = QSplitter(Qt.Vertical)
        right.addWidget(self.editor)
        right.addWidget(self.tabs)
        right.setSizes([520, 300])

        left = QSplitter(Qt.Vertical)
        left.addWidget(self.preview)
        left.addWidget(self.event_table)
        left.setSizes([300, 420])

        middle = QSplitter(Qt.Horizontal)
        middle.addWidget(left)
        middle.addWidget(right)
        middle.setSizes([720, 620])

        central = QWidget()
        layout = QVBoxLayout(central)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.addWidget(self.timeline)
        layout.addWidget(middle, 1)

        hint = QLabel(
            "时间轴：拖动/←→移动播放头（Shift 细调）；点中色块选中事件；"
            "滚轮步进 0.5s；Shift+滚轮缩放，Ctrl+滚轮复位。橙色虚线为场景切点。"
        )
        hint.setStyleSheet("color: #607d8b;")
        hint.setWordWrap(True)
        layout.addWidget(hint)
        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("就绪")

    def _build_actions(self) -> None:
        menu = self.menuBar()
        file_menu = menu.addMenu("文件")
        self.act_import = QAction("导入两份字幕…", self)
        self.act_import.setShortcut(QKeySequence("Ctrl+O"))
        self.act_import.triggered.connect(self.on_import)
        self.act_import_example = QAction("加载示例（含跨切点与缺翻译）", self)
        self.act_import_example.triggered.connect(self.on_load_example)
        self.act_open_project = QAction("打开工程…", self)
        self.act_open_project.triggered.connect(self.on_open_project)
        self.act_save_project = QAction("保存工程", self)
        self.act_save_project.setShortcut(QKeySequence("Ctrl+S"))
        self.act_save_project.triggered.connect(self.on_save_project)
        self.act_export = QAction("导出合并 SRT + 未解决项…", self)
        self.act_export.setShortcut(QKeySequence("Ctrl+E"))
        self.act_export.triggered.connect(self.on_export)
        self.act_verify = QAction("核对导出的 SRT…", self)
        self.act_verify.setShortcut(QKeySequence("Ctrl+R"))
        self.act_verify.triggered.connect(self.on_verify)
        act_quit = QAction("退出", self)
        act_quit.setShortcut(QKeySequence.Quit)
        act_quit.triggered.connect(self.close)
        for act in (
            self.act_import,
            self.act_import_example,
            self.act_open_project,
            self.act_save_project,
        ):
            file_menu.addAction(act)
        file_menu.addSeparator()
        file_menu.addAction(self.act_export)
        file_menu.addAction(self.act_verify)
        file_menu.addSeparator()
        file_menu.addAction(act_quit)

        edit_menu = menu.addMenu("编辑")
        self.act_undo = QAction("撤销", self)
        self.act_undo.setShortcut(QKeySequence.Undo)
        self.act_undo.triggered.connect(self.on_undo)
        self.act_redo = QAction("重做", self)
        self.act_redo.setShortcut(QKeySequence.Redo)
        self.act_redo.triggered.connect(self.on_redo)
        self.act_lock = QAction("锁定/解锁当前事件", self)
        self.act_lock.setShortcut(QKeySequence("Ctrl+L"))
        self.act_lock.triggered.connect(self.on_toggle_lock)
        self.act_split = QAction("在播放头处拆分", self)
        self.act_split.setShortcut(QKeySequence("Ctrl+K"))
        self.act_split.triggered.connect(lambda: self.editor._on_split())
        self.act_tidy = QAction("整理未锁定时间（消除重叠）", self)
        self.act_tidy.triggered.connect(self.on_tidy)
        for act in (
            self.act_undo,
            self.act_redo,
            self.act_lock,
            self.act_split,
            self.act_tidy,
        ):
            edit_menu.addAction(act)

        tools_menu = menu.addMenu("检查")
        self.act_profiles = QAction("阅读速度与行数预算…", self)
        self.act_profiles.triggered.connect(self.on_profiles)
        self.act_rebuild = QAction("按锁定状态重建未锁定项", self)
        self.act_rebuild.triggered.connect(self.pairing._rebuild)
        self.act_manual = QAction("手工配对…", self)
        self.act_manual.setShortcut(QKeySequence("Ctrl+M"))
        self.act_manual.triggered.connect(self.on_manual_pair)
        tools_menu.addAction(self.act_profiles)
        tools_menu.addAction(self.act_rebuild)
        tools_menu.addAction(self.act_manual)

        help_menu = menu.addMenu("帮助")
        act_about = QAction("关于", self)
        act_about.triggered.connect(self.on_about)
        help_menu.addAction(act_about)

    def _connect(self) -> None:
        self.timeline.timeClicked.connect(self.on_time)
        self.timeline.eventClicked.connect(self.on_event_clicked)
        self.event_table.eventSelected.connect(self.on_event_selected)
        self.event_table.requestSeek.connect(self.on_time)
        self.editor.changed.connect(self.on_editor_changed)
        self.editor.seekRequested.connect(self.on_time)
        self.editor.statusMessage.connect(self.status)
        self.pairing.applied.connect(self.on_editor_changed)
        self.pairing.aboutToApply.connect(self._flush_editor_text)
        self.pairing.manualRequested.connect(self.on_manual_pair)
        self.pairing.statusMessage.connect(self.status)
        self.cuts.changed.connect(self.on_editor_changed)
        self.cuts.statusMessage.connect(self.status)
        self.issues.seekRequested.connect(self.on_time)
        self.issues.eventRequested.connect(self.on_event_selected)

    # -- state ------------------------------------------------------------
    def _maybe_restore(self) -> None:
        if self.session.project.events or self.session.project.tracks:
            return
        if self.settings.value("load_example_on_start", False, type=bool):
            self.on_load_example()

    def status(self, message: str) -> None:
        self.statusBar().showMessage(message, 8000)

    def on_time(self, t: int) -> None:
        self.playhead = max(0, int(t))
        self.timeline.set_time(self.playhead)
        self.preview.set_time(self.playhead)
        if self.current_eid:
            # Only the split point follows the playhead; reloading the whole
            # editor here would discard text the user is still typing.
            self.editor.set_playhead(self.playhead)

    def on_event_clicked(self, eid: str) -> None:
        self.on_event_selected(eid)

    def on_event_selected(self, eid: str) -> None:
        self._flush_editor_text()
        self.current_eid = eid
        self.event_table.set_current(eid)
        self.editor.set_event(eid, self.playhead)
        self.issues.refresh(eid if self.issues.auto_scroll.isChecked() else "")

    def _flush_editor_text(self) -> None:
        if not self.current_eid:
            return
        try:
            self.editor.flush_pending_text(notify=False)
        except Exception:
            pass

    def on_editor_changed(self) -> None:
        self.refresh_all()
        if self.current_eid:
            self.editor.reload()

    def on_toggle_lock(self) -> None:
        if not self.current_eid:
            return
        ev = self.session.project.event_by_id(self.current_eid)
        if ev is None:
            return
        self.session.lock_event(self.current_eid, not ev.locked)
        self.on_editor_changed()

    def on_tidy(self) -> None:
        result = self.session.tidy(acknowledge=False)
        if not result.applied and result.warnings:
            detail = "\n".join(f"• {w}" for w in result.warnings)
            answer = QMessageBox.warning(
                self,
                "整理时间会带来影响",
                "整理会：\n" + detail + "\n\n仍要应用吗？",
                QMessageBox.Apply | QMessageBox.Cancel,
                QMessageBox.Cancel,
            )
            if answer == QMessageBox.Apply:
                result = self.session.tidy(acknowledge=True)
        if result.applied:
            self.status("时间整理完成" + ("" if not result.warnings else "（有附带提示）"))
            for w in result.warnings:
                self.status("整理提示：" + w)
            self.on_editor_changed()
        elif result.warnings:
            self.status("未应用整理：" + "；".join(result.warnings))
        else:
            self.status("没有需要整理的重叠")

    def on_undo(self) -> None:
        if self.session.undo():
            self.refresh_all()
            if self.current_eid and self.session.project.event_by_id(self.current_eid):
                self.editor.reload()
            self.status("已撤销")
        else:
            self.status("没有可撤销的操作")

    def on_redo(self) -> None:
        if self.session.redo():
            self.refresh_all()
            self.status("已重做")
        else:
            self.status("没有可重做的操作")

    # -- refresh ----------------------------------------------------------
    def refresh_all(self) -> None:
        project = self.session.project
        self.timeline.set_project(project)
        self.timeline.set_time(self.playhead)
        self.event_table.set_project(project, self.session)
        self.preview.set_time(self.playhead)
        self.issues.refresh(self.current_eid if self.issues.auto_scroll.isChecked() else "")
        self.pairing.refresh_languages()
        if self.current_eid and project.event_by_id(self.current_eid) is None:
            self.current_eid = ""
        if not self.current_eid:
            events = project.sorted_events()
            self.current_eid = events[0].eid if events else ""
        if self.current_eid:
            self.event_table.set_current(self.current_eid)
        if self.current_eid and self.current_eid == self.editor.eid:
            self.editor.reload()
        else:
            self.editor.set_event(self.current_eid, self.playhead)
        self.setWindowTitle(
            APP_TITLE
            + (" *" if self.session.dirty else "")
            + f" — {len(project.events)} 条事件"
        )
        self.act_undo.setEnabled(self.session.can_undo())
        self.act_redo.setEnabled(self.session.can_redo())

    # -- import/export ----------------------------------------------------
    def on_import(self) -> None:
        dialog = ImportDialog(self)
        if dialog.exec() != QDialog.Accepted:
            return
        path_a, lang_a, path_b, lang_b, cuts_path = dialog.values()
        if not path_a or not path_b:
            QMessageBox.warning(self, "导入", "请选择两份字幕文件")
            return
        try:
            self._do_import(path_a, lang_a, path_b, lang_b, cuts_path)
        except Exception as exc:  # parse errors, IO errors
            QMessageBox.critical(self, "导入失败", str(exc))

    def _do_import(
        self,
        path_a: str,
        lang_a: str,
        path_b: str,
        lang_b: str,
        cuts_path: str = "",
    ) -> None:
        session = Session()
        session.new_project(lang_a, lang_b)
        with open(path_a, "r", encoding="utf-8-sig") as fh:
            n_a = session.load_track(lang_a, path_a, fh.read())
        with open(path_b, "r", encoding="utf-8-sig") as fh:
            n_b = session.load_track(lang_b, path_b, fh.read())
        if cuts_path:
            with open(cuts_path, "r", encoding="utf-8-sig") as fh:
                session.set_cuts_text(fh.read())
        self.session = session
        self.playhead = 0
        self.current_eid = ""
        self._rebind_session()
        self.pairing.refresh()
        self.refresh_all()
        self.status(
            f"已导入 {lang_a.upper()} {n_a} 条、{lang_b.upper()} {n_b} 条；"
            f"发现 {len(self.pairing.suggestions)} 条配对建议"
        )

    def _rebind_session(self) -> None:
        self.preview.session = self.session
        self.editor.session = self.session
        self.pairing.session = self.session
        self.cuts.session = self.session
        self.issues.session = self.session
        self.editor.refresh_languages()
        self.cuts.reload()
        self.pairing.refresh_languages()

    def on_load_example(self) -> None:
        paths = example_paths()
        self._do_import(paths["en"], "en", paths["zh"], "zh", paths["cuts"])
        self.settings.setValue("load_example_on_start", True)
        self.status(
            "示例已载入：第 4 条缺中文译文，第 6/7 条为拆分关联，"
            "00:00:21,000 的切点落在第 7 条内。"
        )

    def on_open_project(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开工程", "", "字幕重排工程 (*.json);;所有文件 (*)"
        )
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as fh:
                self.session.load_project(fh.read())
        except Exception as exc:
            QMessageBox.critical(self, "打开失败", str(exc))
            return
        self.playhead = 0
        self.current_eid = ""
        self._rebind_session()
        self.refresh_all()
        self.status(f"已打开 {path}")

    def on_save_project(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self,
            "保存工程",
            os.path.join(os.getcwd(), "project.srf.json"),
            "字幕重排工程 (*.json)",
        )
        if not path:
            return
        try:
            self.session.save_project(path)
        except Exception as exc:
            QMessageBox.critical(self, "保存失败", str(exc))
            return
        self.refresh_all()
        self.status(f"工程已保存到 {path}")

    def on_export(self) -> None:
        if not self.session.project.events:
            QMessageBox.information(self, "导出", "还没有合并事件，先应用配对建议")
            return
        path, _ = QFileDialog.getSaveFileName(
            self,
            "导出合并 SRT",
            os.path.join(os.getcwd(), "merged.srt"),
            "SRT (*.srt)",
        )
        if not path:
            return
        base, _ext = os.path.splitext(path)
        manifest = base + ".manifest.json"
        unresolved_json = base + ".unresolved.json"
        unresolved_txt = base + ".unresolved.txt"
        options = ExportOptions(include_lang_labels=self.issues.export_opts.include_lang_labels)
        try:
            self.session.export_merged(path, manifest, options)
            report = self.session.export_unresolved(unresolved_json, unresolved_txt)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        counts = report.counts
        msg = (
            f"已导出：\n{path}\n{manifest}\n{unresolved_json}\n{unresolved_txt}\n\n"
            f"{counts['events']} 条事件，{counts['errors']} 个错误，"
            f"{counts['warnings']} 个注意"
        )
        QMessageBox.information(self, "导出完成", msg)
        self.status("导出完成")

    def on_verify(self) -> None:
        if not self.session.project.events:
            QMessageBox.information(self, "核对", "还没有合并事件可核对")
            return
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择要核对的 SRT",
            "",
            "SRT (*.srt);;所有文件 (*)",
        )
        if not path:
            return
        base, _ = os.path.splitext(path)
        manifest = base + ".manifest.json"
        try:
            dialog = VerifyDialog(
                self.session.project,
                path,
                manifest if os.path.exists(manifest) else None,
                self.issues.export_opts,
                self,
            )
        except Exception as exc:
            QMessageBox.critical(self, "核对失败", str(exc))
            return
        dialog.exec()
        self.issues.show_verify(dialog.report.summary(), dialog.report.ok)

    def on_profiles(self) -> None:
        dialog = ProfileDialog(self.session, self)
        if dialog.exec() == QDialog.Accepted:
            self.refresh_all()
            if self.current_eid:
                self.editor.reload()
            self.status("预算已更新，检查结果已刷新")

    def on_manual_pair(self) -> None:
        if not self.session.project.tracks:
            QMessageBox.information(self, "手工配对", "还没有导入字幕")
            return
        self._flush_editor_text()
        dialog = ManualPairDialog(self.session, self)
        dialog.exec()
        if dialog.created:
            self.pairing.refresh()
            self.refresh_all()
            self.status(f"手工配对生成 {len(dialog.created)} 条事件")

    def on_about(self) -> None:
        QMessageBox.about(
            self,
            "关于",
            "双语字幕重排台\n\n"
            "导入两份独立时间轴的字幕与场景切点，给配对建议，检查阅读速度/"
            "行数/切点/缺翻译，导出合并 SRT 与未解决项，并可回读核对。\n\n"
            "不需要视频：用毫秒时间轴与文字预览验证。",
        )

    def closeEvent(self, event) -> None:  # noqa: N802
        if self.session.dirty:
            answer = QMessageBox.question(
                self,
                "未保存的改动",
                "工程有未保存的改动，仍要退出吗？",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.No,
            )
            if answer != QMessageBox.Yes:
                event.ignore()
                return
        super().closeEvent(event)
