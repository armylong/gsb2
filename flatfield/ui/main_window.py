"""Main application window."""

from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDockWidget,
    QFileDialog,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QScrollArea,
    QSplitter,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from .. import __version__
from ..core import (
    FULL_SCALE,
    Frame,
    RegionSummary,
    display_limits,
)
from ..exports import (
    export_corrected,
    export_masks,
    export_references,
    export_report,
)
from ..generator import save_set
from ..io import (
    ImageLoadError,
    LoadedImage,
    Meta,
    read_bundle,
    read_image,
    sniff_supported,
)
from ..session import Session, ViewKey
from .defect_panel import DefectPanel
from .dock_panels import ImportDock, IssueList
from .generator_dialog import GeneratorDialog
from .verify_panel import VerifyPanel
from .widgets import ElidedLabel, HistogramWidget, ImageView, ProfilesWidget

VIEW_OPTIONS: list[tuple[str, str]] = [
    ("corrected", "校正结果 (暗场+亮场)"),
    ("original", "原样品"),
    ("dark_only", "仅暗场修正"),
    ("flat_norm", "归一化亮场图"),
    ("dark_mean", "暗场均值 (固定底值)"),
    ("light_mean", "亮场均值"),
    ("mask", "有效区域掩膜"),
]


def _frame_from_loaded(loaded: LoadedImage) -> Frame:
    return Frame(loaded.array, name=loaded.name(), meta=loaded.meta,
                 path=str(loaded.path))


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("FlatField Studio — 16 位暗场/亮场校正")
        self.resize(1480, 940)
        self.session = Session()
        self._display_range: tuple[float, float] = (0.0, float(FULL_SCALE))
        self._auto_range = True
        self._current_view: ViewKey = "corrected"
        self._view_info_text = "把指针移到图上可读取该像素的原始与校正数值。"
        self._show_overlay = True
        self._shade_invalid = True
        self._suspend_updates = False
        self._last_verified: object | None = None
        self._verify_tab_shown = False
        self._prompted_signature: tuple = ()
        self._error_dialog_shown = False

        self._build_actions()
        self._build_central()
        self._build_docks()
        self._connect()
        self._refresh_all(rebuild_range=True)
        self.resizeDocks([self.issue_dock], [330], Qt.Vertical)
        self.statusBar().showMessage(
            "先导入暗场/亮场/样品, 或从「测试数据」生成一组带已知真值的图。")

    # ------------------------------------------------------------------ #
    # Construction
    # ------------------------------------------------------------------ #
    def _build_actions(self) -> None:
        toolbar = QToolBar("主操作")
        toolbar.setMovable(False)
        toolbar.setIconSize(QSize(18, 18))
        self.addToolBar(toolbar)

        def add(text: str, slot, shortcut: str | None = None) -> QAction:
            action = QAction(text, self)
            action.triggered.connect(slot)
            if shortcut:
                action.setShortcut(QKeySequence(shortcut))
            toolbar.addAction(action)
            return action

        menubar = self.menuBar()
        file_menu = menubar.addMenu("文件")

        def add_menu(menu, text: str, slot, shortcut: str | None = None) -> QAction:
            action = QAction(text, self)
            action.triggered.connect(slot)
            if shortcut:
                action.setShortcut(QKeySequence(shortcut))
            menu.addAction(action)
            return action

        import_dark = add("导入暗场…", lambda: self._pick_files("dark"))
        import_light = add("导入亮场…", lambda: self._pick_files("light"))
        import_sample = add("单张样品…", lambda: self._pick_sample())
        file_menu.addAction(import_dark)
        file_menu.addAction(import_light)
        file_menu.addAction(import_sample)
        file_menu.addSeparator()
        self.export_corrected_action = add_menu(
            file_menu, "导出校正数据…", self._export_corrected)
        self.export_all_action = add_menu(
            file_menu, "导出参考、掩膜与报告…", self._export_everything)
        self.export_report_action = add_menu(
            file_menu, "导出报告 JSON…", self._export_report)
        file_menu.addSeparator()
        file_menu.addAction("退出", self.close, QKeySequence.Quit)

        toolbar.addSeparator()
        self.dark_action = add("暗场修正", self._toggle_from_action)
        self.dark_action.setCheckable(True)
        self.dark_action.setChecked(True)
        self.dark_action.setToolTip("扣除暗场均值 (固定底值); 与右侧开关联动")
        self.light_action = add("亮场修正", self._toggle_from_action)
        self.light_action.setCheckable(True)
        self.light_action.setChecked(True)
        self.light_action.setToolTip("按归一化亮场去除亮度起伏; 与右侧开关联动")
        toolbar.addSeparator()
        add("测试数据…", self._open_generator)
        add("导出校正数据…", self._export_corrected, "Ctrl+E")
        add("导出全部…", self._export_everything)
        toolbar.addSeparator()
        add("适应窗口", lambda: self.image_view.fit_to_window())
        add("1:1", lambda: self.image_view.actual_size())
        add("自动显示范围", self._auto_display_range)

        view_menu = menubar.addMenu("视图")
        add_menu(view_menu, "适应窗口", lambda: self.image_view.fit_to_window(), "Ctrl+F")
        add_menu(view_menu, "1:1", lambda: self.image_view.actual_size(), "Ctrl+1")
        view_menu.addSeparator()
        add_menu(view_menu, "自动显示范围", self._auto_display_range, "Ctrl+R")
        self.overlay_action = add_menu(view_menu, "显示缺陷标记", self._toggle_overlay,
                                       "Ctrl+Shift+O")
        self.overlay_action.setCheckable(True)
        self.overlay_action.setChecked(True)
        self.overlay_action.toggled.connect(self._overlay_action_toggled)
        view_menu.addSeparator()

        tools_menu = menubar.addMenu("工具")
        add_menu(tools_menu, "生成测试数据…", self._open_generator, "Ctrl+G")
        add_menu(tools_menu, "重新运行真值自检", self._run_verify)
        help_menu = menubar.addMenu("帮助")
        add_menu(help_menu, "关于", self._about)

    def _build_central(self) -> None:
        central = QWidget()
        layout = QVBoxLayout(central)
        layout.setContentsMargins(6, 6, 6, 6)
        layout.setSpacing(6)

        control_bar = QHBoxLayout()
        control_bar.setSpacing(8)
        self.view_combo = QComboBox()
        for key, label in VIEW_OPTIONS:
            self.view_combo.addItem(label, key)
        self.view_combo.setCurrentIndex(0)
        self.view_combo.setMinimumWidth(220)
        control_bar.addWidget(QLabel("显示:"))
        control_bar.addWidget(self.view_combo)

        control_bar.addSpacing(12)
        self.dark_check = QCheckBox("暗场修正")
        self.dark_check.setChecked(True)
        self.light_check = QCheckBox("亮场修正")
        self.light_check.setChecked(True)
        control_bar.addWidget(self.dark_check)
        control_bar.addWidget(self.light_check)

        control_bar.addSpacing(12)
        self.overlay_check = QCheckBox("缺陷标记")
        self.overlay_check.setChecked(True)
        control_bar.addWidget(self.overlay_check)
        self.shade_check = QCheckBox("暗化无效区")
        self.shade_check.setChecked(True)
        control_bar.addWidget(self.shade_check)
        self.info_label = ElidedLabel("—")
        self.info_label.setStyleSheet("color:#9aa3b2;")
        control_bar.addWidget(self.info_label, 1)
        layout.addLayout(control_bar)

        # doubles as the current-view summary when the pointer is off the image
        self.readout = QLabel("把指针移到图上可读取该像素的原始与校正数值。")
        self.readout.setWordWrap(True)
        self.readout.setMinimumHeight(38)
        self.readout.setTextFormat(Qt.RichText)
        self.readout.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.readout.setStyleSheet(
            "font-family: Menlo, Consolas, monospace; font-size: 11px; "
            "background:#181a1f; border:1px solid #2c3039; border-radius:4px; "
            "padding:4px 8px; color:#c3c9d4;")
        layout.addWidget(self.readout)

        splitter = QSplitter(Qt.Vertical)
        self.image_view = ImageView()
        self.image_view.setToolTip("滚轮缩放 · 拖拽平移 · 双击适应窗口 · 单击读数")
        splitter.addWidget(self.image_view)

        bottom = QWidget()
        bottom_layout = QHBoxLayout(bottom)
        bottom_layout.setContentsMargins(0, 0, 0, 0)
        bottom_layout.setSpacing(8)
        hist_box = QGroupBox("直方图与显示范围")
        hist_layout = QVBoxLayout(hist_box)
        hist_layout.setContentsMargins(6, 8, 6, 6)
        self.histogram = HistogramWidget()
        hist_layout.addWidget(self.histogram)
        range_row = QHBoxLayout()
        self.range_label = QLabel("显示范围 —")
        self.range_label.setStyleSheet("font-size:11px; color:#9aa3b2;")
        range_row.addWidget(self.range_label)
        range_row.addStretch(1)
        bottom_layout.addWidget(hist_box, 1)

        profile_box = QGroupBox("中心 / 边缘剖面与区域数值")
        profile_layout = QVBoxLayout(profile_box)
        profile_layout.setContentsMargins(6, 8, 6, 6)
        self.profiles = ProfilesWidget()
        profile_layout.addWidget(self.profiles, 1)
        self.region_label = QLabel("—")
        self.region_label.setTextFormat(Qt.RichText)
        self.region_label.setStyleSheet("font-size:11px;")
        self.region_label.setWordWrap(True)
        profile_layout.addWidget(self.region_label)
        bottom_layout.addWidget(profile_box, 2)
        splitter.addWidget(bottom)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([560, 330])
        layout.addWidget(splitter, 1)

        self.setCentralWidget(central)
        self._last_region: RegionSummary | None = None

    def _build_docks(self) -> None:
        self.import_dock = ImportDock()
        left = QDockWidget("导入与条件", self)
        left.setObjectName("importDock")
        left.setWidget(self.import_dock)
        left.setFeatures(QDockWidget.DockWidgetMovable | QDockWidget.DockWidgetFloatable)
        self.addDockWidget(Qt.LeftDockWidgetArea, left)
        self.left_dock = left

        self.defect_panel = DefectPanel()
        right = QDockWidget("缺陷像素", self)
        right.setObjectName("defectDock")
        right.setWidget(self.defect_panel)
        self.addDockWidget(Qt.RightDockWidgetArea, right)
        self.right_dock = right

        self.verify_panel = VerifyPanel()
        verify = QDockWidget("真值自检", self)
        verify.setObjectName("verifyDock")
        self._verify_scroll = QScrollArea()
        self._verify_scroll.setWidgetResizable(True)
        self._verify_scroll.setFrameShape(QFrame.NoFrame)
        self._verify_scroll.setWidget(self.verify_panel)
        verify.setWidget(self._verify_scroll)
        self.addDockWidget(Qt.BottomDockWidgetArea, verify)
        self.verify_dock = verify

        self.issue_list = IssueList()
        issue_dock = QDockWidget("导入检查", self)
        issue_dock.setObjectName("issueDock")
        holder = QWidget()
        holder_layout = QVBoxLayout(holder)
        holder_layout.setContentsMargins(8, 6, 8, 6)
        holder_layout.addWidget(self.issue_list)
        issue_scroll = QScrollArea()
        issue_scroll.setWidgetResizable(True)
        issue_scroll.setFrameShape(QFrame.NoFrame)
        issue_scroll.setWidget(holder)
        issue_dock.setWidget(issue_scroll)
        self.addDockWidget(Qt.BottomDockWidgetArea, issue_dock)
        self.issue_dock = issue_dock
        issue_dock.setMinimumHeight(120)

        for menu_action in self.menuBar().actions():
            if menu_action.text() == "视图":
                view_menu = menu_action.menu()
                view_menu.addSeparator()
                view_menu.addAction(self.left_dock.toggleViewAction())
                view_menu.addAction(self.right_dock.toggleViewAction())
                view_menu.addAction(self.verify_dock.toggleViewAction())
                view_menu.addAction(self.issue_dock.toggleViewAction())
                break
        self.tabifyDockWidget(self.issue_dock, self.verify_dock)
        self.right_dock.raise_()
        self.left_dock.setMinimumWidth(392)
        self.right_dock.setMinimumWidth(372)
        self.issue_dock.setMinimumHeight(240)

    def _connect(self) -> None:
        dock = self.import_dock
        dock.importFiles.connect(self._pick_files)
        dock.importFolder.connect(self._pick_folder)
        dock.removeFrame.connect(self._remove_frame)
        dock.clearGroup.connect(self._clear_group)
        dock.conditionsChanged.connect(self._conditions_changed)
        dock.selectFrame.connect(self._select_frame)
        dock.loadBundle.connect(self._pick_bundle)

        self.defect_panel.patchPolicyChanged.connect(self._patch_policy_changed)
        self.defect_panel.patchSelectionChanged.connect(self._patch_selection_changed)
        self.defect_panel.locateRequested.connect(self._locate_component)

        self.verify_panel.checkRequested.connect(self._run_verify)
        self.verify_panel.exportMaskRequested.connect(self._export_masks_dialog)

        self.view_combo.currentIndexChanged.connect(self._view_changed)
        self.dark_check.toggled.connect(self._toggle_changed)
        self.light_check.toggled.connect(self._toggle_changed)
        self.overlay_check.toggled.connect(self._overlay_toggled)
        self.shade_check.toggled.connect(self._overlay_toggled)
        self.histogram.rangeEdited.connect(self._histogram_range)
        self.image_view.hovered.connect(self._hover_pixel)
        self.image_view.clicked.connect(self._click_pixel)
        self.image_view.zoomChanged.connect(self._zoom_changed)
        self.dark_action.triggered.connect(
            lambda: self.dark_check.setChecked(self.dark_action.isChecked()))
        self.light_action.triggered.connect(
            lambda: self.light_check.setChecked(self.light_action.isChecked()))

    # ------------------------------------------------------------------ #
    # Import
    # ------------------------------------------------------------------ #
    def _pick_files(self, group: str) -> None:
        title = {"dark": "导入暗场", "light": "导入亮场", "sample": "导入样品图"}.get(
            group, "导入图像")
        files, _ = QFileDialog.getOpenFileNames(
            self, title, "",
            "16 位灰度 (*.png *.tif *.tiff *.pgm *.npz *.json);;所有文件 (*)")
        if not files:
            return
        if group == "sample" and len(files) > 1:
            QMessageBox.information(self, "单张样品", "样品图一次只接受一张，已使用第一个文件。")
        self._load_group_files(group, files)

    def _pick_sample(self) -> None:
        self._pick_files("sample")

    def _pick_folder(self, group: str) -> None:
        directory = QFileDialog.getExistingDirectory(self, "选择参考图文件夹")
        if not directory:
            return
        files = sorted(
            str(p) for p in Path(directory).iterdir()
            if p.is_file() and sniff_supported(p))
        if not files:
            QMessageBox.warning(self, "空文件夹", "该文件夹中没有支持的文件。")
            return
        self._load_group_files(group, files)

    def _load_group_files(self, group: str, files: list[str]) -> None:
        accepted: list[LoadedImage] = []
        rejected: list[str] = []
        bundle_sample: LoadedImage | None = None
        for path in files:
            try:
                if Path(path).suffix.lower() == ".npz" or Path(path).suffix.lower() == ".json":
                    bundle = read_bundle(path)
                    if group == "dark":
                        accepted.extend(bundle.dark)
                    elif group == "light":
                        accepted.extend(bundle.light)
                    else:
                        bundle_sample = bundle.sample
                else:
                    accepted.append(read_image(path))
            except ImageLoadError as exc:
                rejected.append(str(exc))
            except Exception as exc:  # pragma: no cover - defensive
                rejected.append(f"{Path(path).name}: {exc}")
        if group == "sample":
            if bundle_sample is not None:
                accepted.insert(0, bundle_sample)
            if not accepted:
                self._report_rejections(rejected)
                return
            frame = _frame_from_loaded(accepted[0])
            if not self._confirm_sample_dimensions(frame):
                return
            self.session.set_sample(frame)
            self.session.attach_truth_adjacent(str(accepted[0].path))
        else:
            if accepted:
                self.session.add_frames(group, [_frame_from_loaded(item) for item in accepted])
        if rejected:
            self._report_rejections(rejected)
        self._after_import()

    def _confirm_sample_dimensions(self, frame: Frame) -> bool:
        mismatched = []
        for label, frames in (("暗场", self.session.darks), ("亮场", self.session.lights)):
            for other in frames:
                if other.shape != frame.shape:
                    mismatched.append(f"{label} {other.name}: {other.shape[1]}×{other.shape[0]}")
        if not mismatched:
            return True
        answer = QMessageBox.question(
            self, "尺寸不一致",
            f"样品图 {frame.name}: {frame.shape[1]}×{frame.shape[0]}\n"
            "与已导入的参考图尺寸不同:\n" + "\n".join(mismatched[:10]) +
            ("\n…" if len(mismatched) > 10 else "") +
            "\n\n逐像素校正要求尺寸完全一致。仍然导入这张样品图吗？",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
        return answer == QMessageBox.Yes

    def _report_rejections(self, rejected: list[str]) -> None:
        text = "\n".join(f"· {item}" for item in rejected[:14])
        if len(rejected) > 14:
            text += f"\n… 共 {len(rejected)} 个文件被拒绝"
        QMessageBox.warning(self, "部分文件无法导入",
                            "只接受同尺寸 16 位单通道灰度图。以下文件被拒绝:\n\n" + text)

    def _pick_bundle(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "导入参考集", "",
            "参考集 (*.npz *.json);;文件夹请用左侧面板")
        if not path:
            return
        try:
            bundle = read_bundle(path)
        except ImageLoadError as exc:
            QMessageBox.warning(self, "参考集无法读取", str(exc))
            return
        self.session.darks = [_frame_from_loaded(x) for x in bundle.dark]
        self.session.lights = [_frame_from_loaded(x) for x in bundle.light]
        self.session.set_sample(_frame_from_loaded(bundle.sample))
        self.session.attach_truth_adjacent(path)
        self._after_import()

    def _remove_frame(self, group: str, index: int) -> None:
        self.session.remove_frame(group, index)
        self._after_import()

    def _clear_group(self, group: str) -> None:
        self.session.clear(group)
        self._after_import()

    def _select_frame(self, group: str, index: int) -> None:
        self.statusBar().showMessage(f"已选中 {group} 第 {index + 1} 张", 3000)

    def _conditions_changed(self) -> None:
        self.import_dock.conditions.apply_to(self.session)
        # typing conditions must not pop modal dialogs on every keystroke;
        # problems show in the issue list and on the next import
        self._refresh_all(rebuild_range=False)

    def _after_import(self) -> None:
        self._refresh_all(rebuild_range=True)
        self._prompt_import_issues()

    def _prompt_import_issues(self) -> None:
        """Surface dimension / condition problems right after an import."""
        relevant = [i for i in self.session.issues
                    if i.code in ("size_mismatch", "dark_sample_exposure")
                    or i.code.startswith("conditions_mismatch")
                    or i.code.startswith("exposure_spread")]
        signature = tuple((i.code, i.detail) for i in relevant)
        # non-blocking problems stay in the issue list and status bar; only
        # conditions that make correction impossible get a modal dialog
        if signature != self._prompted_signature:
            self._prompted_signature = signature
            warnings = [i for i in relevant if not i.blocks]
            if warnings:
                self.issue_dock.raise_()
                self.statusBar().showMessage(
                    f"导入检查: {warnings[0].message} " +
                    (f"等 {len(warnings)} 项" if len(warnings) > 1 else ""), 12000)
        blocking = [i for i in relevant if i.blocks]
        if not blocking or self._error_dialog_shown:
            return
        self._error_dialog_shown = True
        body = [f"[阻断] {issue.message}" for issue in blocking]
        for issue in blocking:
            if issue.detail:
                body.append("    " + issue.detail.replace("\n", "\n    "))
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Critical)
        box.setWindowTitle("无法校正: 尺寸或数据不匹配")
        box.setText("\n".join(body))
        box.setInformativeText(
            "逐像素校正要求所有图尺寸完全一致; 请移除不匹配的图像或改用同一相机的图像。")
        box.setStandardButtons(QMessageBox.Ok)
        box.exec()
        self._update_status()

    # ------------------------------------------------------------------ #
    # Generator
    # ------------------------------------------------------------------ #
    def _open_generator(self) -> None:
        dialog = GeneratorDialog(self)
        if dialog.exec() != QDialog.Accepted:
            return
        dataset = dialog.dataset
        if dataset is None:
            return
        self.session.darks = list(copy.copy(dataset.darks))
        self.session.lights = list(copy.copy(dataset.lights))
        self.session.set_sample(dataset.sample)
        self.session.attach_truth_generated(dataset)
        if dialog.save_requested:
            outdir = QFileDialog.getExistingDirectory(self, "选择测试数据保存位置")
            if outdir:
                try:
                    save_set(dataset, outdir)
                except OSError as exc:
                    QMessageBox.warning(self, "保存失败", str(exc))
        self._after_import()
        self.statusBar().showMessage(
            "已载入测试数据 (含真值)。可在右侧「真值自检」中查看背景平坦度与纹理保留。", 8000)

    # ------------------------------------------------------------------ #
    # Refresh
    # ------------------------------------------------------------------ #
    def _refresh_all(self, rebuild_range: bool = False) -> None:
        if self._suspend_updates:
            return
        self._suspend_updates = True
        try:
            issues = self.session.validate()
            self.issue_list.set_issues(
                [i for i in issues if i.severity in ("error", "warning")] or issues)
            self._refresh_group_panels()
            self._refresh_defect_panel()
            self._rebuild_views(rebuild_range)
            self._refresh_verify()
        finally:
            self._suspend_updates = False

    def _refresh_group_panels(self) -> None:
        dock = self.import_dock
        dock.dark_panel.set_frames(
            self.session.darks, self.session.dark_stats() if self.session.darks else None)
        dock.light_panel.set_frames(
            self.session.lights, self.session.light_stats() if self.session.lights else None)
        sample = self.session.sample
        dock.sample_panel.set_frames(
            [sample] if sample else [],
            self.session.sample_stats() if sample else None)

    def _refresh_defect_panel(self) -> None:
        model = self.session.ensure_model()
        self.defect_panel.set_model(model, self.session.sample)
        if model is not None:
            stats = model.defects
            highlight = stats.invalid
        else:
            highlight = None
        if highlight is not None and self.session.lights:
            self.import_dock.light_panel.set_frames(
                self.session.lights, self.session.light_stats(), highlight=highlight)
        if model is not None:
            self.defect_panel.set_policy(self.session.patch_policy)

    def _rebuild_views(self, rebuild_range: bool) -> None:
        key = self.view_combo.currentData()
        if key is None:
            key = self._current_view
        self._current_view = key
        view = self.session.view(key)
        if view is None:
            if self.session.sample is None:
                hint = "请导入样品图 (以及暗场/亮场参考)"
            elif not self.session.ready_for_reference:
                hint = "该视图需要暗场与亮场参考, 请导入后重试"
            else:
                hint = "当前视角不可用: 请检查尺寸与导入情况"
            self.image_view.clear(hint)
            self.image_view.set_marker(None, None)
            self.histogram.set_data(np.zeros(0), None, (0, 1))
            self.profiles.set_profiles([])
            self.range_label.setText("显示范围 —")
            self.region_label.setText("—")
            self._last_region = None
            return
        if view.fixed_display is not None:
            self._display_range = view.fixed_display
        elif rebuild_range or self._auto_range:
            lo, hi = display_limits(view.array, view.valid, 0.5, 99.5)
            self._display_range = (lo, hi)
            self._auto_range = False
        self.image_view.set_image(view.array, view.valid, self._display_range)
        self._update_overlays()
        self.histogram.set_data(view.array, view.valid, self._display_range)
        sat_count = int(np.count_nonzero(~view.valid))
        self.histogram.set_saturation_count(sat_count, "无效/饱和")
        self.range_label.setText(
            f"显示 {self._display_range[0]:.0f} – {self._display_range[1]:.1f} "
            f"(仅预览; 导出为原始 16 位数值)" if view.fixed_display is None
            else "固定 0–65535 (掩膜预览)")
        profiles, reference = self.session.profiles(
            key, with_reference=key in ("corrected", "dark_only", "original"))
        self.profiles.set_profiles(profiles, reference)
        self._profile_compare = self._compare_profiles(profiles, reference)
        self._refresh_region_text(key)
        self._view_info_text = (
            f"<span style='color:#8b93a3'>{self._view_info(view)}</span><br>"
            "把指针移到图上可读取该像素的原始与校正数值。")
        self.readout.setText(self._view_info_text)

    def _update_overlays(self) -> None:
        model = self.session.ensure_model()
        correction = self.session.ensure_correction()
        if model is None or not self.overlay_check.isChecked():
            self.image_view.set_overlay_masks(None)
            return
        masks: dict[str, np.ndarray] = {}
        key = self._current_view
        if key == "mask":
            self.image_view.set_overlay_masks(None)
            return
        if key in ("flat_norm", "light_mean", "dark_mean"):
            masks["low"] = model.defects.low
            masks["saturated"] = model.defects.saturated
            masks["unstable"] = model.defects.unstable
            masks["patched"] = model.patched_mask
            masks["invalid"] = model.defects.invalid
            self.image_view.set_overlay_masks(masks, shade_invalid=False)
            return
        if correction is not None:
            masks["invalid"] = ~correction.valid_mask
        masks["low"] = model.defects.low
        masks["saturated"] = model.defects.saturated
        masks["unstable"] = model.defects.unstable
        masks["patched"] = model.patched_mask
        if correction is not None:
            masks["sample_sat"] = correction.sample_saturated
        self.image_view.set_overlay_masks(
            masks, shade_invalid=self.shade_check.isChecked())

    @staticmethod
    def _compare_profiles(profiles, reference) -> str:
        """Center-vs-edge numbers from the current view's own profiles."""
        if len(profiles) < 4:
            return ""
        labels = ("水平", "垂直")
        parts = []
        for i, axis in enumerate(labels):
            center, edge = profiles[i], profiles[i + 2]
            if not (np.isfinite(center.median) and np.isfinite(edge.median)) \
                    or center.median == 0:
                continue
            delta = edge.median - center.median
            parts.append(f"{axis}: 中心 {center.median:.1f} → 边缘 {edge.median:.1f} "
                         f"({delta:+.1f}, {delta / center.median * 100:+.2f}%)")
        return " · ".join(parts)

    def _view_info(self, view) -> str:
        unit = "ADU"
        data = view.array
        finite = np.isfinite(data) & view.valid
        if finite.any():
            values = data[finite]
            return (f"{view.title} · 有效 {np.count_nonzero(finite):,}/{data.size:,} px · "
                    f"有效区 {values.min():.0f}–{values.max():.0f} {unit} · "
                    f"均值 {values.mean():.1f}")
        return view.title

    def _refresh_region_text(self, key: str) -> None:
        summary = self.session.region_summary(key)
        self._last_region = summary
        if summary is None:
            self.region_label.setText("—")
            return
        text = (
            f"<b>中心</b> 均值 {summary.center_mean:.1f} · 中位 {summary.center_median:.1f} · "
            f"σ {summary.center_std:.1f} &nbsp;&nbsp;"
            f"<b>边缘</b> 均值 {summary.edge_mean:.1f} · σ {summary.edge_std:.1f} &nbsp;&nbsp;"
            f"边缘/中心 {summary.edge_center_ratio:.3f} &nbsp;&nbsp;"
            f"<b>四角</b> {summary.corner_mean:.1f}")
        flat = self.session.flatness(key)
        if flat is not None:
            where = "真值背景区" if flat["masked_to_background"] else "有效区"
            text += (f"<br><b>背景平坦度</b> ({where}) 平面残差 "
                     f"{flat['plane_std_pct']:.2f}% · 1–99% 跨度 {flat['p1p99_pct']:.1f}%")
        else:
            text += ("<br><span style='color:#8b93a3'>样品纹理会计入平坦度统计; "
                     "可切到「归一化亮场图」查看亮场均匀性, 或载入真值后查看背景区平坦度</span>")
        compare = getattr(self, "_profile_compare", "")
        if compare:
            text += f"<br><b>中心 vs 边缘剖面</b> {compare}"
        flat_summary = self.session.flat_summary()
        if flat_summary is not None:
            text += (f"<br><b>亮场归一化幅值</b> 1–99%: "
                     f"{flat_summary['p1']:.3f}–{flat_summary['p99']:.3f} "
                     f"(跨度 {flat_summary['span_pct']:.1f}%, 越大暗角越强, 已用于亮场修正)")
        self.region_label.setText(text)

    def _refresh_verify(self) -> None:
        report = None
        has_truth = self.session.truth is not None
        if has_truth:
            report = self.session.verify()
        self.verify_panel.set_report(report, has_truth)
        self.verify_panel.set_export_enabled(self.session.model is not None)
        if has_truth and not self._verify_tab_shown:
            self._verify_tab_shown = True
            self.verify_dock.raise_()
            self.resizeDocks([self.issue_dock], [340], Qt.Vertical)

    # ------------------------------------------------------------------ #
    # Interaction
    # ------------------------------------------------------------------ #
    def _view_changed(self) -> None:
        self._auto_range = True
        self._refresh_all(rebuild_range=True)

    def _toggle_changed(self) -> None:
        self.dark_action.setChecked(self.dark_check.isChecked())
        self.light_action.setChecked(self.light_check.isChecked())
        self.session.apply_dark = self.dark_check.isChecked()
        self.session.apply_light = self.light_check.isChecked()
        self._refresh_all(rebuild_range=True)

    def _toggle_from_action(self) -> None:
        self.dark_check.setChecked(self.dark_action.isChecked())
        self.light_check.setChecked(self.light_action.isChecked())

    def _overlay_toggled(self) -> None:
        self._update_overlays()

    def _histogram_range(self, lo: float, hi: float) -> None:
        self._display_range = (lo, hi)
        self.image_view.set_display_range(lo, hi)
        self.range_label.setText(
            f"显示 {lo:.0f} – {hi:.1f} (仅预览; 导出为原始 16 位数值)")

    def _auto_display_range(self) -> None:
        view = self.session.view(self._current_view)
        if view is None:
            return
        lo, hi = display_limits(view.array, view.valid, 0.5, 99.5)
        self._display_range = (lo, hi)
        self.image_view.set_display_range(lo, hi)
        self.histogram.set_data(view.array, view.valid, self._display_range)
        self.range_label.setText(
            f"显示 {lo:.0f} – {hi:.1f} (仅预览; 导出为原始 16 位数值)")

    def _toggle_overlay(self) -> None:
        self.overlay_check.toggle()

    def _overlay_action_toggled(self, checked: bool) -> None:
        if self.overlay_check.isChecked() != checked:
            self.overlay_check.setChecked(checked)

    @staticmethod
    def _adu(value: float) -> str:
        return "—" if not np.isfinite(value) else f"{value:9.1f}"

    def _hover_pixel(self, row: int, col: int) -> None:
        view = self.session.view(self._current_view)
        if view is None:
            return
        if row < 0 or col < 0:
            self.readout.setText(self._view_info_text)
            return
        model = self.session.model
        correction = self.session.correction
        sample = self.session.sample
        parts = []
        if sample is not None:
            parts.append(f"原样品 {self._adu(float(sample.array[row, col]))}")
        if model is not None:
            parts.append(f"暗场均值 {self._adu(float(model.dark_mean[row, col]))}")
            parts.append(f"亮场均值 {self._adu(float(model.light_mean[row, col]))}")
            parts.append(f"归一化亮场 {self._adu(float(model.flat_norm[row, col]))}")
            parts.append(f"有效响应 {self._adu(float(model.flat_signal[row, col]))}")
        if correction is not None:
            parts.append(f"校正值 {self._adu(float(correction.corrected[row, col]))}")
        category = ""
        if model is not None:
            category = model.defects.category_at(row, col)
            if correction is not None and correction.sample_saturated[row, col]:
                category = (category + " / 样品饱和").strip(" /")
            if model.patched_mask[row, col]:
                category = (category + " / 已修补").strip(" /")
            if not category:
                category = "正常"
        self.readout.setText(
            f"<b>行 {row}, 列 {col}</b> &nbsp; " + " &nbsp;|&nbsp; ".join(parts) +
            (f" &nbsp;|&nbsp; <span style='color:#ffb454'>{category}</span>"
             if category else "") +
            " &nbsp;<span style='color:#6f7787'>(ADU, 与显示范围无关)</span>")

    def _click_pixel(self, row: int, col: int) -> None:
        model = self.session.model
        if model is None:
            return
        label = int(model.defects.labels[row, col])
        if label > 0:
            self.defect_panel.select_component(label)

    def _locate_component(self, comp_id: int) -> None:
        model = self.session.model
        if model is None:
            return
        comp = next((c for c in model.defects.components if c.id == comp_id), None)
        if comp is None:
            return
        row, col = comp.center
        self.image_view.set_marker(row, col)
        self.image_view.focus_on(row, col)

    def _zoom_changed(self, zoom: float) -> None:
        self.statusBar().showMessage(f"缩放 {zoom * 100:.0f}%", 1500)

    def _patch_policy_changed(self, policy: str) -> None:
        if policy == "selected":
            self.session.patch_policy = "selected"
            self.session.selected_patches = self.defect_panel.selected_ids()
        else:
            self.session.patch_policy = policy  # type: ignore[assignment]
            self.session.selected_patches = set()
        self._refresh_all(rebuild_range=False)

    def _patch_selection_changed(self, ids: set) -> None:
        self.session.selected_patches = set(ids)
        if self.session.patch_policy == "selected":
            self._refresh_all(rebuild_range=False)

    def _run_verify(self) -> None:
        self._refresh_verify()
        self.verify_dock.raise_()

    def _update_status(self) -> None:
        model = self.session.model
        if model is None:
            return
        if model.notes:
            self.statusBar().showMessage(" / ".join(model.notes[:2]), 9000)

    # ------------------------------------------------------------------ #
    # Exports
    # ------------------------------------------------------------------ #
    def _require_correction(self):
        self.session.ensure_model()
        correction = self.session.ensure_correction()
        if correction is None or self.session.sample is None:
            QMessageBox.information(self, "无法导出",
                                    "需要暗场、亮场和样品图, 且尺寸一致。")
            return None
        return correction

    def _export_corrected(self) -> None:
        correction = self._require_correction()
        if correction is None:
            return
        directory = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not directory:
            return
        meta = self.session.sample.meta if self.session.sample else Meta()
        try:
            paths = export_corrected(directory, correction, self.session.model,
                                     self.session.sample.name, meta)
            export_report(
                directory,
                {"kind": "corrected_export", "source": self.session.sample.name,
                 **self.session.evidence()},
                stem=f"report_{Path(self.session.sample.name).stem}")
        except OSError as exc:
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        QMessageBox.information(
            self, "已导出",
            "已写入:\n" + "\n".join(str(p) for p in paths.written) +
            "\n\n16 位 PNG 与有效区域掩膜 (0/65535) 保留原始数值, 与显示范围无关。")

    def _export_masks_dialog(self) -> None:
        model = self.session.ensure_model()
        if model is None:
            QMessageBox.information(self, "无法导出掩膜", "请先导入暗场与亮场。")
            return
        directory = QFileDialog.getExistingDirectory(self, "选择掩膜导出目录")
        if not directory:
            return
        stem = Path(self.session.sample.name).stem if self.session.sample else ""
        paths = export_masks(directory, model, prefix="refmask", stem=stem)
        QMessageBox.information(
            self, "掩膜已导出",
            "有效掩膜 1 = 可用像素 (PNG 写为 65535)。\n" +
            "\n".join(str(p) for p in paths.written))

    def _export_everything(self) -> None:
        correction = self._require_correction()
        if correction is None:
            return
        directory = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not directory:
            return
        sample = self.session.sample
        meta = sample.meta if sample else Meta()
        stem = Path(sample.name).stem if sample else "sample"
        written: list[Path] = []
        try:
            written += export_corrected(directory, correction, self.session.model,
                                        sample.name, meta).written
            written += export_masks(directory, self.session.model,
                                    prefix="ref", stem=stem).written
            written += export_references(directory, self.session.model,
                                         sample.array, meta).written
            written.append(export_report(
                directory, {"kind": "full_export", **self.session.evidence()},
                stem=f"report_{stem}"))
        except OSError as exc:
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        QMessageBox.information(
            self, "已导出", f"共写入 {len(written)} 个文件到\n{directory}\n\n" +
            "\n".join(p.name for p in written[:14]) +
            ("\n…" if len(written) > 14 else ""))

    def _export_report(self) -> None:
        self.session.ensure_model()
        report = self.session.verify() if self.session.truth is not None else None
        payload = {"kind": "session_report", **self.session.evidence()}
        if report is not None:
            payload["verification"] = report.to_dict()
        directory = QFileDialog.getExistingDirectory(self, "选择报告导出目录")
        if not directory:
            return
        path = export_report(directory, payload, stem="flatfield_report")
        QMessageBox.information(self, "报告已导出", str(path))

    def _about(self) -> None:
        QMessageBox.about(
            self, "关于 FlatField Studio",
            f"<b>FlatField Studio {__version__}</b><br>"
            "16 位灰度图像的暗场 / 亮场校正与缺陷检查。<br><br>"
            "· 只接受同尺寸 16 位单通道灰度数据<br>"
            "· 显示范围仅影响预览, 导出数值保持原始 16 位<br>"
            "· 原样品与参考图只读, 所有校正生成新数据")

    # ------------------------------------------------------------------ #
    # Tagging support for tests / scripting
    # ------------------------------------------------------------------ #
    def load_dataset(self, dataset) -> None:
        self.session.darks = list(dataset.darks)
        self.session.lights = list(dataset.lights)
        self.session.set_sample(dataset.sample)
        self.session.attach_truth_generated(dataset)
        self._after_import()

    def set_view(self, key: str) -> None:
        index = self.view_combo.findData(key)
        if index >= 0:
            self.view_combo.setCurrentIndex(index)
