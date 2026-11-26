"""Main window: dual canvas, panels, project handling, export."""

from __future__ import annotations

import os
from typing import List, Optional

from PIL import Image
from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import (QAction, QColor, QGuiApplication, QKeySequence,
                           QPalette)
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDialog,
                               QDialogButtonBox, QDockWidget, QFileDialog,
                               QFormLayout, QLabel, QMainWindow, QMessageBox,
                               QPushButton, QSplitter, QStatusBar, QTabWidget,
                               QTextBrowser, QToolBar, QVBoxLayout, QWidget)

from cropkit import imaging
from cropkit.editing import Editor
from cropkit.imaging import LoadedImage, export_crops, results_to_rows
from cropkit.lookup import point_in_crop
from cropkit.project import (Project, SourceInfo, adapt_project,
                             apply_reconciliation, read_source_info)
from cropkit.rectmath import Rect, anchor_rect, handle_at, parse_ratio
from cropkit.ui.canvas import ImageCanvas
from cropkit.ui.panels import (CropListPanel, ExportTable, LocatePanel,
                               MarkerListPanel, TransformPanel)

PROJECT_FILTER = "选区文件 (*.cropkit.json *.json);;所有文件 (*)"
IMAGE_FILTER = "图片 (*.jpg *.jpeg *.png *.tif *.tiff *.webp);;所有文件 (*)"


class MismatchDialog(QDialog):
    """Shown before a saved selection is trusted against a changed source."""

    def __init__(self, differences, parent=None):
        super().__init__(parent)
        self.setWindowTitle("原图与保存时不一致")
        layout = QVBoxLayout(self)
        intro = QLabel(
            "这个选区文件是按另一份原图保存的。请先确认下列差异，<br>"
            "再决定如何换算选区。")
        intro.setWordWrap(True)
        layout.addWidget(intro)

        table = QTextBrowser()
        rows = "".join(
            f"<tr><td style='padding:3px 10px'>{d.label}</td>"
            f"<td style='padding:3px 10px;color:#999'>保存时</td>"
            f"<td style='padding:3px 10px'>{d.saved}</td>"
            f"<td style='padding:3px 10px;color:#999'>当前</td>"
            f"<td style='padding:3px 10px;color:#d9822b'>{d.current}</td></tr>"
            for d in differences)
        table.setHtml(f"<table>{rows}</table>")
        table.setMaximumHeight(180)
        layout.addWidget(table)

        self.mode = QComboBox()
        self.mode.addItem("按比例与方向换算选区（推荐）", "scale")
        self.mode.addItem("保留原坐标，仅裁到新图边界内", "keep")
        form = QFormLayout()
        form.addRow("换算方式", self.mode)
        layout.addLayout(form)

        buttons = QDialogButtonBox()
        self.btn_accept = buttons.addButton("确认并继续",
                                            QDialogButtonBox.ButtonRole.AcceptRole)
        self.btn_cancel = buttons.addButton("取消打开",
                                            QDialogButtonBox.ButtonRole.RejectRole)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def chosen_mode(self) -> str:
        return self.mode.currentData()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("CropKit · 统一坐标取图")
        self.resize(1500, 950)
        self.settings = QSettings("cropkit", "cropkit")
        self.image: Optional[LoadedImage] = None
        self.editor: Optional[Editor] = None
        self.project: Optional[Project] = None
        self.last_export_dir = self.settings.value("last_export_dir", "")
        self.last_export_results = []
        self._drag = None
        self._syncing = False
        self._last_selection = "crop"

        self._build_ui()
        self._build_actions()
        self._update_enabled(False)
        self.statusBar().showMessage(
            "打开一张 JPEG，或从「样图」菜单生成八种方向的样图")

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------
    def _build_ui(self) -> None:
        self.tabs = QTabWidget()
        self.canvas_display = ImageCanvas("display")
        self.canvas_stored = ImageCanvas("stored")
        self.canvas_crop = ImageCanvas("crop")

        display_wrap = QWidget()
        dl = QVBoxLayout(display_wrap)
        dl.setContentsMargins(0, 0, 0, 0)
        dl.addWidget(self.canvas_display, 1)
        self.hint_label = QLabel(
            "左键在空白处拖出选区 · 拖角/边调整 · 拖框内平移 · "
            "Shift+左键放置定位点 · 滚轮平移 · Ctrl+滚轮缩放")
        self.hint_label.setStyleSheet("color:#888; padding:3px")
        dl.addWidget(self.hint_label)

        stored_wrap = QWidget()
        sl = QVBoxLayout(stored_wrap)
        sl.setContentsMargins(0, 0, 0, 0)
        sl.addWidget(self._section_title(
            "编码原图（不做旋转/镜像）"), 0)
        sl.addWidget(self.canvas_stored, 1)
        stored_hint = QLabel(
            "绿色框是当前选区在存储坐标中的位置；四角标签是存储空间的 "
            "TL/TR/BL/BR。与左侧同时显示，方便在镜像方向下核对四角。")
        stored_hint.setWordWrap(True)
        stored_hint.setStyleSheet("color:#888; padding:3px")
        sl.addWidget(stored_hint)

        crop_wrap = QWidget()
        cl = QVBoxLayout(crop_wrap)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.addWidget(self.canvas_crop, 1)
        self.crop_hint = QLabel("导出裁片预览（读取已导出的 PNG）")
        self.crop_hint.setStyleSheet("color:#888; padding:3px")
        cl.addWidget(self.crop_hint)

        self.tabs.addTab(display_wrap, "摆正图（编辑）")
        self.tabs.addTab(crop_wrap, "裁片查找")

        # Display and encoded original are compared side by side; the crop
        # lookup replaces the upright view while it is open.
        self.center_split = QSplitter(Qt.Orientation.Horizontal)
        self.center_split.addWidget(self.tabs)
        self.center_split.addWidget(stored_wrap)
        self.center_split.setStretchFactor(0, 3)
        self.center_split.setStretchFactor(1, 2)
        self.center_split.setSizes([900, 600])
        self.setCentralWidget(self.center_split)

        self.crop_panel = CropListPanel()
        self.marker_panel = MarkerListPanel()
        self.transform_panel = TransformPanel()
        self.locate_panel = LocatePanel()
        self.export_table = ExportTable()

        left = QDockWidget("选区与定位点", self)
        left_body = QWidget()
        lv = QVBoxLayout(left_body)
        lv.setContentsMargins(0, 0, 0, 0)
        lv.addWidget(QLabel("裁片"))
        lv.addWidget(self.crop_panel, 1)
        lv.addWidget(QLabel("定位点"))
        lv.addWidget(self.marker_panel, 1)
        left.setWidget(left_body)
        left.setMinimumWidth(280)
        self.addDockWidget(Qt.DockWidgetArea.LeftDockWidgetArea, left)

        right_tabs = QTabWidget()
        right_tabs.addTab(self.transform_panel, "调整")
        right_tabs.addTab(self.locate_panel, "查找")
        export_page = QWidget()
        ev = QVBoxLayout(export_page)
        ev.setContentsMargins(6, 6, 6, 6)
        self.out_dir_edit = QLabel("（尚未导出）")
        self.out_dir_edit.setWordWrap(True)
        self.mask_checkbox = QCheckBox("同时导出与裁片同尺寸的定位点掩膜")
        self.mask_checkbox.setChecked(True)
        ev.addWidget(self.mask_checkbox)
        ev.addWidget(QLabel("清单"))
        ev.addWidget(self.export_table, 1)
        self.btn_export = QPushButton("导出全部裁片…")
        ev.addWidget(self.btn_export)
        self.btn_verify = QPushButton("复核导出最外一行像素")
        ev.addWidget(self.btn_verify)
        right_tabs.addTab(export_page, "导出")

        right = QDockWidget("工具", self)
        right.setWidget(right_tabs)
        right.setMinimumWidth(340)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, right)

        self.info_label = QLabel()
        self.info_label.setStyleSheet(
            "padding:4px 8px; background:#20222a; color:#ddd")
        self.info_label.setTextFormat(Qt.TextFormat.RichText)
        self.setStatusBar(QStatusBar())
        self.statusBar().addPermanentWidget(self.info_label, 1)

        self._wire_signals()

    @staticmethod
    def _section_title(text: str) -> QLabel:
        label = QLabel(text)
        label.setStyleSheet(
            "padding:4px 8px; background:#2a2d36; color:#cfd6e4;"
            "font-weight:600")
        return label

    def _wire_signals(self) -> None:
        self.crop_panel.selectionChanged.connect(self._crop_selected)
        self.crop_panel.addRequested.connect(self._add_crop_default)
        self.crop_panel.removeRequested.connect(self._remove_crop)
        self.crop_panel.duplicateRequested.connect(self._duplicate_crop)
        self.crop_panel.enabledChanged.connect(self._crop_enabled)
        self.crop_panel.renameRequested.connect(self._crop_renamed)

        self.marker_panel.selectionChanged.connect(self._marker_selected)
        self.marker_panel.addRequested.connect(self._add_marker_center)
        self.marker_panel.removeRequested.connect(self._remove_marker)

        self.transform_panel.widenRequested.connect(self._widen)
        self.transform_panel.translateRequested.connect(self._translate)
        self.transform_panel.tightenRequested.connect(self._tighten)
        self.transform_panel.ratioChanged.connect(self._ratio_changed)

        self.locate_panel.markerChosen.connect(self._marker_selected)
        self.locate_panel.showInSourceRequested.connect(self._find_in_source)
        self.locate_panel.showInCropRequested.connect(self._find_in_crop)
        self.locate_panel.markerInCropRequested.connect(
            self._find_marker_in_crop)

        self.btn_export.clicked.connect(self._export)
        self.btn_verify.clicked.connect(self._verify_export)
        self.export_table.cellDoubleClicked.connect(
            self._export_row_activated)

        for canvas in (self.canvas_display,):
            canvas.pointClicked.connect(self._canvas_clicked)
            canvas.pointDragged.connect(self._canvas_dragged)
            canvas.dragStarted.connect(self._drag_started)
            canvas.dragFinished.connect(self._drag_finished)
            canvas.mouseMoved.connect(self._mouse_moved)
        self.canvas_stored.mouseMoved.connect(self._stored_mouse_moved)
        self.canvas_display.mouseLeft.connect(self._clear_position_text)
        self.canvas_stored.mouseLeft.connect(self._clear_position_text)
        self.canvas_crop.pointClicked.connect(self._crop_canvas_clicked)

    def _build_actions(self) -> None:
        bar = QToolBar("主工具栏")
        bar.setMovable(False)
        self.addToolBar(bar)

        def act(text, shortcut, slot, checkable=False):
            a = QAction(text, self)
            if shortcut:
                a.setShortcut(QKeySequence(shortcut))
            a.triggered.connect(slot)
            a.setCheckable(checkable)
            bar.addAction(a)
            return a

        self.act_open = act("打开图片…", "Ctrl+O", self._open_image)
        self.act_open_project = act("打开选区…", "Ctrl+Shift+O",
                                    self._open_project)
        self.act_save = act("保存选区…", "Ctrl+S", self._save_project)
        self.act_save_as = act("另存选区…", "Ctrl+Shift+S",
                               self._save_project_as)
        bar.addSeparator()
        self.act_fit = act("适应窗口", "F", lambda: self.canvas_display.fit_image())
        self.act_actual = act("100%", "1",
                              lambda: self.canvas_display.actual_size())
        self.act_zoomin = act("放大", "Ctrl+=",
                              lambda: self.canvas_display.zoom_by(1.25))
        self.act_zoomout = act("缩小", "Ctrl+-",
                               lambda: self.canvas_display.zoom_by(0.8))
        bar.addSeparator()
        self.act_undo = act("撤销", "Ctrl+Z", lambda: self.editor and
                            self.editor.undo())
        self.act_delete = act("删除选中", "Delete", self._delete_current)
        self.act_delete.setShortcutContext(
            Qt.ShortcutContext.WindowShortcut)
        self.act_redo = act("重做", "Ctrl+Shift+Z", lambda: self.editor and
                            self.editor.redo())
        bar.addSeparator()
        self.act_export = act("导出…", "Ctrl+E", self._export)
        self.act_samples = act("生成样图", None, self._open_samples)
        self.act_check = act("本地复查", "Ctrl+Shift+R", self._run_check)
        self.act_report = act("导出复查报告…", None, self._save_report)

        menu = self.menuBar().addMenu("样图")
        menu.addAction(self.act_samples)
        help_menu = self.menuBar().addMenu("帮助")
        help_menu.addAction(self.act_check)
        help_menu.addAction(self.act_report)

    # ------------------------------------------------------------------
    # enablement
    # ------------------------------------------------------------------
    def _update_enabled(self, on: bool) -> None:
        for a in (self.act_save, self.act_save_as, self.act_export,
                  self.act_fit, self.act_actual, self.act_zoomin,
                  self.act_zoomout, self.act_undo, self.act_redo):
            a.setEnabled(on)
        for w in (self.crop_panel, self.marker_panel, self.transform_panel,
                  self.locate_panel, self.btn_export, self.btn_verify):
            w.setEnabled(on)

    # ------------------------------------------------------------------
    # image / project loading
    # ------------------------------------------------------------------
    def _open_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开图片", self._last_dir(), IMAGE_FILTER)
        if path:
            self.load_image(path)

    def _last_dir(self) -> str:
        return self.settings.value("last_dir", os.path.expanduser("~"))

    def load_image(self, path: str, source_info: Optional[SourceInfo] = None
                   ) -> bool:
        try:
            image = imaging.open_image(path)
        except Exception as exc:
            QMessageBox.critical(self, "无法打开", f"{path}\n\n{exc}")
            return False
        self.settings.setValue("last_dir", os.path.dirname(path))
        self.image = image
        info = source_info or read_source_info(path)
        self.editor = Editor(info, ratio=None)
        self.editor.on_change = self._on_model_change
        self.project = None
        self.canvas_display.set_image(image.display)
        self.canvas_stored.set_image(image.stored)
        self.canvas_crop.set_image(Image.new("RGB", (4, 3), (32, 32, 36)))
        self._sync_corner_labels()
        self._update_enabled(True)
        self._refresh_all()
        self._update_title()
        return True

    def _open_project(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开选区文件", self._last_dir(), PROJECT_FILTER)
        if path:
            self.load_project(path)

    def load_project(self, path: str) -> bool:
        try:
            project = Project.load(path)
        except Exception as exc:
            QMessageBox.critical(self, "无法读取选区文件", str(exc))
            return False
        source_path = project.source.path
        if not os.path.isabs(source_path):
            source_path = os.path.join(os.path.dirname(path), source_path)
        if not os.path.exists(source_path):
            found, _ = QFileDialog.getOpenFileName(
                self, f"找不到原图，请重新定位：\n{project.source.path}",
                os.path.dirname(path), IMAGE_FILTER)
            if not found:
                return False
            source_path = found
        try:
            image = imaging.open_image(source_path)
        except Exception as exc:
            QMessageBox.critical(self, "无法打开原图", str(exc))
            return False
        actual = read_source_info(source_path)

        recon = adapt_project(project, actual)
        if recon.needs_confirmation:
            dialog = MismatchDialog(recon.differences, self)
            if dialog.exec() != QDialog.DialogCode.Accepted:
                return False
            mode = dialog.chosen_mode()
            recon = adapt_project(project, actual, mode=mode)
            apply_reconciliation(project, actual, recon)
        else:
            # Same bytes, size and orientation: only the file's location
            # moved, so the saved coordinates stay valid as they are.
            project.source = actual

        self.settings.setValue("last_dir", os.path.dirname(source_path))
        self.image = image
        self.editor = Editor(actual)
        self.editor.on_change = self._on_model_change
        self.editor.load_project(project)
        self.project = project
        self.canvas_display.set_image(image.display)
        self.canvas_stored.set_image(image.stored)
        self.canvas_crop.set_image(Image.new("RGB", (4, 3), (32, 32, 36)))
        self._sync_corner_labels()
        self._update_enabled(True)
        self.transform_panel.set_ratio_text(project.ratio or "")
        self._refresh_all()
        self._update_title()
        self.statusBar().showMessage(
            f"已打开选区：{os.path.basename(path)}", 5000)
        return True

    def _open_samples(self) -> None:
        from cropkit.samples import write_sample_set

        target = QFileDialog.getExistingDirectory(
            self, "选择保存样图的文件夹", self._last_dir())
        if not target:
            return
        try:
            write_sample_set(target)
        except Exception as exc:
            QMessageBox.critical(self, "生成样图失败", str(exc))
            return
        QMessageBox.information(
            self, "样图已生成",
            "已生成 8 张带方向标记的 JPEG（orientation-1..8）以及摆正参考图。\n"
            f"目录：{target}\n\n"
            "可用「本地复查」一次核对镜像方向、触边裁切和旧文件替换。")

    # ------------------------------------------------------------------
    # saving
    # ------------------------------------------------------------------
    def _save_project(self) -> None:
        if not self.editor:
            return
        if self.project and self.project.path:
            self._write_project(self.project.path)
        else:
            self._save_project_as()

    def _save_project_as(self) -> None:
        if not self.editor:
            return
        suggested = os.path.splitext(self.editor.source.path)[0] + \
            ".cropkit.json"
        path, _ = QFileDialog.getSaveFileName(
            self, "保存选区文件", suggested, PROJECT_FILTER)
        if path:
            self._write_project(path)

    def _write_project(self, path: str) -> None:
        # Refresh the source identity so the saved file describes exactly
        # what is on screen (including a replaced original).
        if self.editor.source.path:
            try:
                self.editor.source = read_source_info(self.editor.source.path)
            except Exception:
                pass
        project = self.editor.to_project()
        project.path = path
        try:
            project.save(path)
        except Exception as exc:
            QMessageBox.critical(self, "保存失败", str(exc))
            return
        self.project = project
        self._update_title()
        self.statusBar().showMessage(f"已保存 {os.path.basename(path)}", 4000)

    # ------------------------------------------------------------------
    # model change -> views
    # ------------------------------------------------------------------
    def _on_model_change(self) -> None:
        self._refresh_all()

    def _refresh_all(self) -> None:
        if not self.editor:
            return
        self._syncing = True
        try:
            self._refresh_views()
        finally:
            self._syncing = False

    def _refresh_views(self) -> None:
        ed = self.editor
        rect_entries = [
            {"index": i, "rect": c.rect, "active": i == ed.active_crop,
             "enabled": c.enabled,
             "label": f"{c.name}  {c.rect.width}×{c.rect.height}"}
            for i, c in enumerate(ed.crops)]
        self.canvas_display.set_rects(rect_entries)
        marker_entries = [
            {"index": i, "x": m.x, "y": m.y, "active": i == ed.active_marker,
             "label": m.name}
            for i, m in enumerate(ed.markers)]
        self.canvas_display.set_markers(marker_entries)

        # stored view: the same selection mapped into encoded coordinates
        stored_rects = []
        for i, c in enumerate(ed.crops):
            sr = ed.display_rect_to_stored(c.rect)
            stored_rects.append({
                "index": i, "rect": sr, "active": i == ed.active_crop,
                "enabled": c.enabled,
                "label": f"{c.name} (存储坐标)"})
        self.canvas_stored.set_rects(stored_rects)
        stored_markers = []
        for i, m in enumerate(ed.markers):
            sx, sy = ed.display_to_stored(m.x, m.y)
            stored_markers.append({"index": i, "x": sx, "y": sy,
                                   "active": i == ed.active_marker,
                                   "label": ""})
        self.canvas_stored.set_markers(stored_markers)

        self.crop_panel.set_items(
            [{"index": i, "name": c.name, "enabled": c.enabled,
              "size": c.rect.size} for i, c in enumerate(ed.crops)],
            ed.active_crop)
        crop_counts = {i: len(ed.crops_containing_marker(i))
                       for i in range(len(ed.markers))}
        self.marker_panel.set_items(
            [{"index": i, "name": m.name, "x": m.x, "y": m.y}
             for i, m in enumerate(ed.markers)],
            ed.active_marker, crop_counts)
        self.locate_panel.set_markers(
            [{"index": i, "name": m.name, "x": m.x, "y": m.y}
             for i, m in enumerate(ed.markers)], ed.active_marker)
        self.locate_panel.set_crops(
            [{"index": i, "name": c.name} for i, c in enumerate(ed.crops)],
            ed.active_crop)
        self._update_info()
        self._update_title()

    def _update_info(self) -> None:
        ed = self.editor
        if not ed:
            return
        o = ed.orientation
        size = ed.size
        parts = [
            f"<b>方向 {o.value}</b> · {o.label}",
            f"摆正 {size[0]}×{size[1]}",
            f"编码 {ed.source.stored_size[0]}×{ed.source.stored_size[1]}",
        ]
        src = o.corner_sources()
        parts.append("四角 " + " ".join(f"{k}←{v}" for k, v in src.items()))
        if o.mirrored:
            parts.append("<b>含镜像</b>")
        if ed.active_crop is not None and 0 <= ed.active_crop < len(ed.crops):
            c = ed.crops[ed.active_crop]
            r = c.rect
            parts.append(
                f"当前 {c.name}: x={r.x0} y={r.y0} w={r.width} h={r.height}")
        if ed.active_marker is not None and \
                0 <= ed.active_marker < len(ed.markers):
            mk = ed.markers[ed.active_marker]
            parts.append(f"定位点 {mk.name} ({mk.x}, {mk.y})")
        self.info_label.setText(" &nbsp;|&nbsp; ".join(parts))

    def _sync_corner_labels(self) -> None:
        """Show, at each display corner, which stored corner it came from.

        For mirrored orientations this is the quickest way to see that the
        four corners are still in the expected order.
        """
        if not self.editor:
            return
        sources = self.editor.orientation.corner_sources()
        zh = {"TL": "左上", "TR": "右上", "BL": "左下", "BR": "右下"}
        self.canvas_display.set_corner_labels(
            [f"{zh[c]}←{sources[c]}" for c in ("TL", "TR", "BL", "BR")])
        self.canvas_stored.set_corner_labels(
            [f"{c}(编码)" for c in ("TL", "TR", "BL", "BR")])

    def _update_title(self) -> None:
        if not self.editor:
            self.setWindowTitle("CropKit · 统一坐标取图")
            return
        name = os.path.basename(self.editor.source.path)
        proj = os.path.basename(self.project.path) if self.project and \
            self.project.path else "未保存选区"
        self.setWindowTitle(f"{name} — {proj} — CropKit")

    # ------------------------------------------------------------------
    # canvas interaction
    # ------------------------------------------------------------------
    def _drag_started(self) -> None:
        if self.editor:
            self.editor.begin_interaction()

    def _drag_finished(self) -> None:
        drag, self._drag = self._drag, None
        if not self.editor:
            return
        self.editor.end_interaction()
        if drag and drag.get("mode") == "new":
            rect = drag.get("rect")
            if rect and rect.width >= 2 and rect.height >= 2:
                self.editor.add_crop(rect)

    def _canvas_clicked(self, x: float, y: float, button) -> None:
        ed = self.editor
        if not ed:
            return
        self.canvas_display.setFocus()
        tol = self.canvas_display.px_tolerance(7)
        shift = QGuiApplication.keyboardModifiers() & \
            Qt.KeyboardModifier.ShiftModifier

        marker = ed.marker_at(x, y, tol)
        if shift and button == Qt.MouseButton.LeftButton:
            # Shift+click always adds a new locator point, then lets the
            # same drag position it.
            index = ed.add_marker(int(x), int(y))
            self._last_selection = "marker"
            self._drag = {"mode": "marker", "marker": index, "origin": (x, y)}
            return
        if marker is not None and button in (Qt.MouseButton.LeftButton,
                                             Qt.MouseButton.RightButton):
            ed.select_marker(marker)
            self._last_selection = "marker"
            self._drag = {"mode": "marker", "marker": marker,
                          "origin": (x, y)}
            return

        # resize a handle of the active crop first, then of any crop
        for candidate in self._ordered_crop_indices():
            handle = handle_at(ed.crops[candidate].rect, x, y, tol)
            if handle is not None:
                ed.select_crop(candidate)
                self._last_selection = "crop"
                self._drag = {"mode": "resize", "crop": candidate,
                              "handle": handle,
                              "start": ed.crops[candidate].rect,
                              "origin": (x, y)}
                return

        inside = ed.crop_at(x, y)
        if button == Qt.MouseButton.LeftButton and inside is not None:
            ed.select_crop(inside)
            self._last_selection = "crop"
            self._drag = {"mode": "move", "crop": inside,
                          "start": ed.crops[inside].rect,
                          "origin": (x, y)}
            return
        if button == Qt.MouseButton.LeftButton:
            # start a new rectangle
            ed.select_crop(None)
            self._last_selection = "crop"
            self._drag = {"mode": "new", "origin": (x, y), "rect": None,
                          "anchor": Rect(int(round(x)), int(round(y)),
                                         int(round(x)), int(round(y)))}
            return

    def _ordered_crop_indices(self) -> List[int]:
        ed = self.editor
        if not ed:
            return []
        order = []
        if ed.active_crop is not None:
            order.append(ed.active_crop)
        order += [i for i in range(len(ed.crops) - 1, -1, -1)
                  if i != ed.active_crop]
        return order

    def _canvas_dragged(self, x: float, y: float, buttons) -> None:
        ed = self.editor
        if not ed or not self._drag:
            return
        drag = self._drag
        mode = drag["mode"]
        ox, oy = drag["origin"]
        if mode == "new":
            rect = anchor_rect(drag["anchor"], x, y).normalized()
            drag["rect"] = rect
            self.canvas_display.set_rects(
                [{"index": -1, "rect": rect, "active": True,
                  "enabled": True, "label": "新选区"}])
        elif mode == "move":
            ed.move_crop_to(drag["crop"], drag["start"], x - ox, y - oy)
        elif mode == "resize":
            ed.resize_crop(drag["crop"], drag["handle"], x - ox, y - oy,
                           drag["start"], keep_ratio=bool(ed.ratio))
        elif mode == "marker":
            ed.set_marker_position(drag["marker"], int(round(x)),
                                   int(round(y)), record=False)

    def _clear_position_text(self) -> None:
        self.statusBar().clearMessage()

    def _mouse_moved(self, x: float, y: float) -> None:
        ed = self.editor
        if not ed:
            return
        sx, sy = ed.display_to_stored(x, y)
        self.statusBar().showMessage(
            f"摆正 ({int(x)}, {int(y)})   编码 ({sx:.0f}, {sy:.0f})",)

    def _stored_mouse_moved(self, x: float, y: float) -> None:
        ed = self.editor
        if not ed:
            return
        dx, dy = ed.stored_to_display(x, y)
        self.statusBar().showMessage(
            f"编码 ({int(x)}, {int(y)})   摆正 ({dx:.0f}, {dy:.0f})")

    def _crop_canvas_clicked(self, x: float, y: float, button) -> None:
        ed = self.editor
        index = self._preview_crop_index
        if not ed or index is None or not (0 <= index < len(ed.crops)):
            return
        rect = ed.crops[index].rect
        dx, dy = rect.x0 + int(round(x)), rect.y0 + int(round(y))
        self.locate_panel.set_local(int(round(x)), int(round(y)))
        self.locate_panel.set_info(
            f"裁片 {ed.crops[index].name} ({rect.width}×{rect.height}) 内 "
            f"({int(round(x))}, {int(round(y))}) → 原图摆正 ({dx}, {dy})")
        self.canvas_display.set_crosshair((dx, dy))

    # ------------------------------------------------------------------
    # model operations
    # ------------------------------------------------------------------
    def _add_crop_default(self) -> None:
        ed = self.editor
        if not ed:
            return
        w, h = ed.size
        base = Rect.from_size(max(0, w // 4), max(0, h // 4),
                              max(10, w // 2), max(10, h // 2))
        ed.add_crop(base)

    def _remove_crop(self) -> None:
        if self.editor:
            self.editor.remove_crop()

    def _delete_current(self) -> None:
        """Delete from whichever list currently has focus."""
        if not self.editor:
            return
        if self.crop_panel.list.hasFocus():
            self.editor.remove_crop()
        elif self.marker_panel.list.hasFocus():
            self.editor.remove_marker()
        elif self._last_selection == "marker":
            self.editor.remove_marker()
        else:
            self.editor.remove_crop()

    def _duplicate_crop(self) -> None:
        ed = self.editor
        if not ed or ed.active_crop is None:
            return
        c = ed.crops[ed.active_crop]
        ed.add_crop(c.rect.translated(5, 5).clamped_to(*ed.size),
                    name=c.name + " 副本")

    def _crop_selected(self, index: int) -> None:
        if self._syncing or not self.editor:
            return
        self.editor.select_crop(index if index >= 0 else None)

    def _crop_enabled(self, index: int, enabled: bool) -> None:
        # The list is rebuilt on every refresh; guard against the rebuilt
        # rows re-emitting change signals while we are repopulating them.
        if self.editor and not self._syncing:
            self.editor.set_crop_enabled(index, enabled)

    def _crop_renamed(self, index: int, name: str) -> None:
        if self.editor and not self._syncing:
            self.editor.set_crop_name(index, name)

    def _marker_selected(self, index: int) -> None:
        if self._syncing or not self.editor:
            return
        self.editor.select_marker(index if index >= 0 else None)

    def _add_marker_center(self) -> None:
        ed = self.editor
        if not ed:
            return
        if ed.active_crop is not None:
            r = ed.crops[ed.active_crop].rect
            ed.add_marker(int(r.cx), int(r.cy))
        else:
            ed.add_marker(ed.size[0] // 2, ed.size[1] // 2)

    def _remove_marker(self) -> None:
        if self.editor:
            self.editor.remove_marker()

    def _widen(self, amount: int, only_active: bool, sides: str) -> None:
        if self.editor:
            self.editor.widen(amount, only_active, sides)

    def _translate(self, dx: int, dy: int, only_active: bool) -> None:
        if self.editor:
            self.editor.translate(dx, dy, only_active)

    def _tighten(self, ratio_text: str, only_active: bool) -> None:
        ed = self.editor
        if not ed:
            return
        if not parse_ratio(ratio_text):
            QMessageBox.warning(self, "长宽比无效",
                                "请输入形如 4:3 或 1:1 的比例。")
            return
        changed = ed.tighten_to_ratio(ratio_text, only_active)
        if not changed:
            self.statusBar().showMessage("选区已符合比例，无需收紧", 4000)

    def _ratio_changed(self, text: str) -> None:
        ed = self.editor
        if not ed:
            return
        if text.strip() and not parse_ratio(text):
            self.statusBar().showMessage(
                f"「{text}」不是有效比例，例如 4:3", 5000)
            return
        ed.set_ratio(text.strip() or None)

    # ------------------------------------------------------------------
    # locate
    # ------------------------------------------------------------------
    def _find_in_source(self, marker_index: int) -> None:
        ed = self.editor
        if not ed or not (0 <= marker_index < len(ed.markers)):
            return
        m = ed.markers[marker_index]
        ed.select_marker(marker_index)
        self.tabs.setCurrentIndex(0)
        self.canvas_display.focus_on_rect(
            Rect.from_size(max(0, m.x - 40), max(0, m.y - 40), 80, 80),
            margin=0.1)
        self.canvas_display.set_crosshair((m.x, m.y))
        hits = point_in_crop_many(ed, m.x, m.y)
        self.locate_panel.set_info(
            f"{m.name} 在原图 ({m.x}, {m.y})；" + hits)

    def _find_in_crop(self, crop_index: int, lx: int, ly: int) -> None:
        ed = self.editor
        if not ed or not (0 <= crop_index < len(ed.crops)):
            return
        rect = ed.crops[crop_index].rect
        dx, dy = rect.x0 + lx, rect.y0 + ly
        info = (f"裁片 {ed.crops[crop_index].name} 内 ({lx}, {ly}) → "
                f"原图摆正 ({dx}, {dy})")
        inside = rect.contains(dx, dy)
        if not inside:
            hit = point_in_crop(rect, dx, dy)
            info += f"（该点不在裁片内：{hit.edge}侧外 {hit.outside_px} px）"
        ed.select_crop(crop_index)
        self._show_crop_preview(crop_index)
        self.tabs.setCurrentIndex(1)
        if inside:
            self.canvas_crop.set_crosshair((lx, ly))
            self.canvas_crop.ensure_item_visible(lx, ly)
        self.canvas_display.set_crosshair((dx, dy))
        self.locate_panel.set_info(info)

    def _find_marker_in_crop(self, marker_index: int,
                             crop_index: int) -> None:
        ed = self.editor
        if not ed or not (0 <= marker_index < len(ed.markers)) or \
                not (0 <= crop_index < len(ed.crops)):
            return
        m = ed.markers[marker_index]
        rect = ed.crops[crop_index].rect
        lx, ly = m.x - rect.x0, m.y - rect.y0
        self.locate_panel.set_local(lx, ly)
        self.editor.select_marker(marker_index)
        self.tabs.setCurrentIndex(1)
        self._show_crop_preview(crop_index)
        if rect.contains(m.x, m.y):
            self.canvas_crop.set_crosshair((lx, ly))
            self.canvas_crop.ensure_item_visible(lx, ly)
            where = f"裁片内 ({lx}, {ly})"
        else:
            hit = point_in_crop(rect, m.x, m.y, crop_index,
                                ed.crops[crop_index].name)
            where = (f"不在裁片内：{hit.edge}侧外 {hit.outside_px} px，"
                     f"按裁片坐标算是 ({lx}, {ly})")
            self.canvas_crop.set_crosshair(None)
        self.canvas_display.set_crosshair((m.x, m.y))
        self.locate_panel.set_info(
            f"{m.name} 原图 ({m.x}, {m.y}) → {ed.crops[crop_index].name} "
            f"{where}")

    def _show_crop_preview(self, crop_index: int) -> None:
        ed = self.editor
        if not ed or not self.image:
            return
        rect = ed.crops[crop_index].rect
        self._preview_crop_index = crop_index
        # Canvas keeps full-resolution coordinates even when it internally
        # downscales the pixmap, so clicks here are always crop pixels.
        self.canvas_crop.set_image(self.image.upright_crop(rect))
        self.canvas_crop.set_crosshair(None)
        self.canvas_crop.set_corner_labels(None)
        self.crop_hint.setText(
            f"裁片 {ed.crops[crop_index].name} · {rect.width}×{rect.height} "
            f"(x={rect.x0}, y={rect.y0}) · 点击可换算回原图")

    # ------------------------------------------------------------------
    # export
    # ------------------------------------------------------------------
    def _export(self) -> None:
        ed = self.editor
        if not ed or not self.image:
            return
        if not any(c.enabled for c in ed.crops):
            QMessageBox.information(self, "没有可导出的裁片",
                                    "请先添加并勾选至少一个裁片。")
            return
        target = QFileDialog.getExistingDirectory(
            self, "选择导出文件夹", self.last_export_dir or self._last_dir())
        if not target:
            return
        self.last_export_dir = target
        self.settings.setValue("last_export_dir", target)
        with_masks = self.mask_checkbox.isChecked()
        try:
            results = export_crops(self.image, ed.crops, ed.markers, target,
                                   with_masks=with_masks)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        from cropkit.imaging import write_manifest

        manifest_path = os.path.join(target, "crops-manifest.json")
        try:
            write_manifest(results, manifest_path)
        except Exception as exc:
            QMessageBox.warning(self, "清单写入失败", str(exc))
        self.last_export_results = results
        self.export_table.set_rows(results_to_rows(results))
        self.out_dir_edit.setText(target)
        failures = [r for r in results if r.error]
        outside = sum(len(r.outside) for r in results)
        msg = (f"已导出 {len(results) - len(failures)} 个裁片到\n{target}\n\n"
               f"清单：{os.path.basename(manifest_path)}")
        if outside:
            msg += f"\n有 {outside} 个定位点落在裁片外侧，已在清单标为「未包含」。"
        if failures:
            msg += "\n失败：" + ", ".join(f"{r.name}: {r.error}"
                                        for r in failures)
            QMessageBox.warning(self, "导出完成（有失败）", msg)
        else:
            QMessageBox.information(self, "导出完成", msg)
        if ed.crops:
            self._show_crop_preview(ed.active_crop or 0)

    def _verify_export(self) -> None:
        ed = self.editor
        if not ed or not self.image:
            return
        results = self.last_export_results
        if not results:
            QMessageBox.information(self, "尚未导出", "请先导出裁片。")
            return
        # Re-read the PNGs that were actually written, not a fresh export.
        checks = imaging.verify_export_edges(self.image, results)
        if not checks:
            QMessageBox.warning(self, "无导出结果", "没有可复核的裁片。")
            return
        bad = [c for c in checks if not c[1]]
        text = "\n".join(f"{'通过' if ok else '失败'}  {name}: {detail}"
                         for name, ok, detail in checks)
        QMessageBox.information(
            self, "导出最外一行像素复核",
            text + ("\n\n全部通过。" if not bad else f"\n\n{len(bad)} 项不符。"))

    def _export_row_activated(self, row: int, _column: int) -> None:
        ed = self.editor
        if not ed:
            return
        item = self.export_table.item(row, 0)
        if not item:
            return
        index = item.data(Qt.ItemDataRole.UserRole)
        if index is None:
            return
        index = int(index)
        if 0 <= index < len(ed.crops):
            ed.select_crop(index)
            self._show_crop_preview(index)
            self.tabs.setCurrentIndex(1)

    # ------------------------------------------------------------------
    # self check
    # ------------------------------------------------------------------
    def _run_check(self) -> None:
        from cropkit.selfcheck import run_self_check

        try:
            checks = run_self_check()
        except Exception as exc:
            QMessageBox.critical(self, "本地复查失败", str(exc))
            return
        self._check_results = checks
        bad = [c for c in checks if not c.ok]
        dialog = QDialog(self)
        dialog.setWindowTitle("本地复查")
        dialog.resize(900, 640)
        layout = QVBoxLayout(dialog)
        summary = QLabel(
            f"共 {len(checks)} 项，通过 {len(checks) - len(bad)} 项，"
            f"失败 {len(bad)} 项。" +
            ("" if not bad else "  失败项已标红。"))
        layout.addWidget(summary)
        browser = QTextBrowser()
        rows = []
        for c in checks:
            color = "#2e9d68" if c.ok else "#d9534f"
            rows.append(
                f"<tr><td style='color:{color};white-space:nowrap'>"
                f"{c.mark}</td><td style='padding-right:12px'>{c.name}</td>"
                f"<td style='color:#888'>{c.detail}</td></tr>")
        browser.setHtml(f"<table>{''.join(rows)}</table>")
        layout.addWidget(browser)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dialog.reject)
        buttons.clicked.connect(dialog.accept)
        layout.addWidget(buttons)
        dialog.exec()

    def _save_report(self) -> None:
        from cropkit.selfcheck import run_self_check

        checks = run_self_check()
        path, _ = QFileDialog.getSaveFileName(
            self, "保存复查报告", "cropkit-report.txt",
            "文本 (*.txt);;所有文件 (*)")
        if not path:
            return
        lines = [f"[{'PASS' if c.ok else 'FAIL'}] {c.name} :: {c.detail}"
                 for c in checks]
        bad = sum(1 for c in checks if not c.ok)
        lines.append(f"\n合计 {len(checks)} 项，失败 {bad} 项")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
        self.statusBar().showMessage(f"复查报告已保存到 {path}", 5000)

    # ------------------------------------------------------------------
    def closeEvent(self, event) -> None:
        if self.editor and self.editor.can_undo:
            answer = QMessageBox.question(
                self, "未保存的修改", "当前选区有修改，仍然退出吗？",
                QMessageBox.StandardButton.Yes |
                QMessageBox.StandardButton.No)
            if answer != QMessageBox.StandardButton.Yes:
                event.ignore()
                return
        event.accept()


def point_in_crop_many(ed: Editor, x: int, y: int) -> str:
    if not ed.crops:
        return "尚无裁片"
    parts = []
    for i, c in enumerate(ed.crops):
        hit = point_in_crop(c.rect, x, y, i, c.name)
        if hit.inside:
            parts.append(f"{c.name} 内 ({hit.local[0]}, {hit.local[1]})")
        else:
            parts.append(f"{c.name} 外({hit.edge}{hit.outside_px}px)")
    return "；".join(parts)


def run(argv: Optional[List[str]] = None) -> int:
    app = QApplication.instance() or QApplication(argv or [])
    app.setApplicationName("CropKit")
    palette = app.palette()
    palette.setColor(QPalette.ColorRole.Window, QColor("#24262d"))
    palette.setColor(QPalette.ColorRole.WindowText, QColor("#e6e6e6"))
    palette.setColor(QPalette.ColorRole.Base, QColor("#1c1d23"))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor("#22242b"))
    palette.setColor(QPalette.ColorRole.Text, QColor("#e6e6e6"))
    palette.setColor(QPalette.ColorRole.Button, QColor("#2c2f38"))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor("#e6e6e6"))
    palette.setColor(QPalette.ColorRole.Highlight, QColor("#3d7eff"))
    app.setPalette(palette)
    window = MainWindow()
    window.show()
    args = (argv or [])[1:]
    if args:
        first = args[0]
        if first.endswith(".json"):
            window.load_project(first)
        else:
            window.load_image(first)
    return app.exec()


if __name__ == "__main__":
    import sys

    raise SystemExit(run(sys.argv))
