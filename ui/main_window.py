"""Main window and application wiring."""

from __future__ import annotations

import os

from PySide6 import QtCore, QtGui, QtWidgets

from matting.constraints import Tool
from matting.engine import MattingError, load_image_opencv
from matting.record import ConstraintRecord, RecordError
from matting.samples import SAMPLES, generate_sample
from ui.canvas import CanvasWidget
from ui.document import Document, DocumentStatus
from ui.exports import export_alpha_png, export_constraints, export_foreground_png
from ui.sample_gallery import SampleGallery

APP_NAME = "ScribbleMatte"
APP_VERSION = "1.0.0"
CHECKER_CELL = 16

HELP_TEXT = """\
<b>快速上手</b>
<ol>
<li><b>打开图片</b>：PNG / JPEG，长边自动限制到 1200 像素以内。</li>
<li><b>框选</b>（快捷键 B）：按住左键拖出前景的大致范围。框外的像素一律视为背景。</li>
<li><b>确定前景</b>（F）在物体内部画几笔，<b>确定背景</b>（D）在物体外侧的背景上画几笔，
<b>待定 / 擦除</b>（E）把已有笔墨改回「待定」，交给算法依图像内容判断。</li>
<li>点击 <b>重新计算</b>（Ctrl+Enter）。失败时笔迹和上次有效结果都会保留。</li>
<li>结果不满意时，用对应画笔继续补画或按 <b>待定 / 擦除</b>（E）擦掉笔迹，再重新计算。</li>
<li>右侧并排显示 <b>原图 / 透明度 / 合成</b> 三个视图；合成视图可换棋盘格、浅色、深色底。</li>
</ol>
<b>视图操作</b>
<ul>
<li>滚轮：以鼠标位置为中心缩放；<code>Alt</code>/右键/中键拖动或按住空格拖动：平移。</li>
<li><code>+</code> / <code>-</code> 缩放，<code>0</code> 适配窗口，<code>1</code> 实际像素。</li>
<li><code>Ctrl+Z</code> / <code>Ctrl+Shift+Z</code>：撤销 / 重做（一次连续笔划算一步）。</li>
<li><code>[</code> / <code>]</code>：调整画笔粗细；<code>L</code>：显示/隐藏笔迹。</li>
</ul>
<b>导出</b>
<ul>
<li>透明 PNG（BGRA）、灰度透明度 PNG、约束记录 JSON。</li>
<li>约束记录包含原图尺寸与 SHA-256 内容校验；在原图上重新载入后可以继续修改。</li>
<li>若预览已过期（标记或设置变了但还没重新计算），导出前会先提示。</li>
</ul>
"""


class ToggleButton(QtWidgets.QToolButton):
    """Small checkable tool button used for tool / backdrop switching."""

    def __init__(self, text: str, shortcut: str = "", parent=None):
        super().__init__(parent)
        self.setCheckable(True)
        self.setText(text)
        self.setToolButtonStyle(QtCore.Qt.ToolButtonTextOnly)
        self.setAutoRaise(False)
        self.setMinimumHeight(30)
        if shortcut:
            self.setToolTip(f"{text}（{shortcut}）")


class MainWindow(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.doc = Document(self)
        self.setWindowTitle(APP_NAME)
        self.resize(1500, 940)
        self.setAcceptDrops(True)

        self._tool = Tool.BOX
        self._brush_radius = 12.0
        self._loading = False
        self._current_path: str = ""

        self._build_ui()
        self._build_shortcuts()
        self._connect_doc()
        self._apply_tool(Tool.BOX)
        self._refresh_all()

    # ------------------------------------------------------------------- UI
    def _build_ui(self) -> None:
        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        root = QtWidgets.QHBoxLayout(central)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(12)

        root.addWidget(self._build_sidebar(), 0)
        root.addWidget(self._build_viewer(), 1)
        self.statusBar().showMessage("就绪", 4000)
        self._build_menu()

    # ---------------------------------------------------------------- sidebar
    def _section(self, title: str) -> QtWidgets.QVBoxLayout:
        box = QtWidgets.QVBoxLayout()
        box.setSpacing(8)
        label = QtWidgets.QLabel(title)
        label.setStyleSheet("font-weight: 600; margin-top: 6px;")
        box.addWidget(label)
        return box

    def _build_sidebar(self) -> QtWidgets.QWidget:
        side = QtWidgets.QWidget()
        side.setFixedWidth(330)
        panel = QtWidgets.QVBoxLayout(side)
        panel.setSpacing(10)
        panel.setContentsMargins(0, 0, 0, 0)

        # --- file
        file_box = self._section("图片")
        row = QtWidgets.QHBoxLayout()
        self.open_btn = QtWidgets.QPushButton("打开…")
        self.open_btn.setToolTip("打开 PNG / JPEG（Ctrl+O）")
        self.open_btn.clicked.connect(self.action_open)
        row.addWidget(self.open_btn)
        self.sample_btn = QtWidgets.QPushButton("生成样例…")
        self.sample_btn.setToolTip("内置静物样例，带上参考透明度与预设笔迹")
        self.sample_btn.clicked.connect(self.action_samples)
        row.addWidget(self.sample_btn)
        file_box.addLayout(row)
        self.image_label = QtWidgets.QLabel("尚未打开图片")
        self.image_label.setWordWrap(True)
        self.image_label.setStyleSheet("color: #666;")
        file_box.addWidget(self.image_label)
        panel.addLayout(file_box)

        # --- tools
        tool_box = self._section("标记工具")
        grid = QtWidgets.QGridLayout()
        grid.setSpacing(6)
        self.tool_buttons: dict[int, ToggleButton] = {}
        tools = [
            (Tool.BOX, "框选 (B)", "B"),
            (Tool.FG, "确定前景 (F)", "F"),
            (Tool.BG, "确定背景 (D)", "D"),
            (Tool.ERASE, "待定 / 擦除 (E)", "E"),
        ]
        for i, (tool, text, shortcut) in enumerate(tools):
            btn = ToggleButton(text, shortcut)
            btn.clicked.connect(lambda _=False, t=tool: self._apply_tool(t))
            grid.addWidget(btn, i // 2, i % 2)
            self.tool_buttons[tool] = btn
        tool_box.addLayout(grid)

        brush_row = QtWidgets.QHBoxLayout()
        brush_row.addWidget(QtWidgets.QLabel("画笔粗细"))
        self.brush_slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
        self.brush_slider.setRange(2, 80)
        self.brush_slider.setValue(int(self._brush_radius))
        self.brush_slider.valueChanged.connect(self._on_brush_changed)
        brush_row.addWidget(self.brush_slider, 1)
        self.brush_value = QtWidgets.QLabel(f"{int(self._brush_radius)} px")
        self.brush_value.setMinimumWidth(48)
        brush_row.addWidget(self.brush_value)
        tool_box.addLayout(brush_row)
        self.show_labels = QtWidgets.QCheckBox("显示笔迹")
        self.show_labels.setChecked(True)
        self.show_labels.toggled.connect(lambda v: self.canvas.set_show_labels(v))
        tool_box.addWidget(self.show_labels)
        panel.addLayout(tool_box)

        # --- actions
        action_box = self._section("计算")
        row = QtWidgets.QHBoxLayout()
        self.undo_btn = QtWidgets.QPushButton("撤销")
        self.undo_btn.setShortcut(QtGui.QKeySequence.Undo)
        self.undo_btn.clicked.connect(self.action_undo)
        self.redo_btn = QtWidgets.QPushButton("重做")
        self.redo_btn.setShortcut(QtGui.QKeySequence.Redo)
        self.redo_btn.clicked.connect(self.action_redo)
        row.addWidget(self.undo_btn)
        row.addWidget(self.redo_btn)
        action_box.addLayout(row)

        self.recompute_btn = QtWidgets.QPushButton("重新计算")
        self.recompute_btn.setMinimumHeight(36)
        self.recompute_btn.setStyleSheet("font-weight: 600;")
        self.recompute_btn.setToolTip("根据原图 + 当前标记重新计算（Ctrl+Enter）")
        self.recompute_btn.clicked.connect(self.action_recompute)
        action_box.addWidget(self.recompute_btn)

        refine_row = QtWidgets.QHBoxLayout()
        refine_row.addWidget(QtWidgets.QLabel("边缘细化"))
        self.refine_slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
        self.refine_slider.setRange(0, 12)
        self.refine_slider.setValue(3)
        self.refine_slider.setToolTip("0 = 关闭柔软边缘；数值越大，柔和过渡带越宽")
        self.refine_slider.valueChanged.connect(self._on_refine_changed)
        refine_row.addWidget(self.refine_slider, 1)
        self.refine_value = QtWidgets.QLabel("3 px")
        self.refine_value.setMinimumWidth(48)
        refine_row.addWidget(self.refine_value)
        action_box.addLayout(refine_row)
        panel.addLayout(action_box)

        # --- views
        view_box = self._section("查看")
        backdrop_row = QtWidgets.QHBoxLayout()
        backdrop_row.addWidget(QtWidgets.QLabel("合成底色"))
        self.backdrop_buttons: dict[str, ToggleButton] = {}
        for key, text in (("checker", "棋盘格"), ("light", "浅色"), ("dark", "深色")):
            btn = ToggleButton(text)
            btn.clicked.connect(lambda _=False, k=key: self._set_backdrop(k))
            backdrop_row.addWidget(btn)
            self.backdrop_buttons[key] = btn
        view_box.addLayout(backdrop_row)

        self.link_views = QtWidgets.QCheckBox("缩放/平移联动各视图")
        self.link_views.setChecked(True)
        self.link_views.toggled.connect(self._apply_linking)
        view_box.addWidget(self.link_views)

        nav_row = QtWidgets.QHBoxLayout()
        for text, tip, fn in (
            ("−", "缩小 (-)", lambda: self.canvas.set_zoom_steps(-1)),
            ("+", "放大 (+)", lambda: self.canvas.set_zoom_steps(1)),
            ("适配", "适配窗口 (0)", lambda: self.canvas.fit_to_window()),
            ("1:1", "实际像素 (1)", lambda: self.canvas.actual_size()),
        ):
            btn = QtWidgets.QPushButton(text)
            btn.setToolTip(tip)
            btn.clicked.connect(fn)
            nav_row.addWidget(btn)
        view_box.addLayout(nav_row)
        panel.addLayout(view_box)

        # --- export
        export_box = self._section("导出")
        self.export_fg_btn = QtWidgets.QPushButton("透明 PNG…")
        self.export_fg_btn.clicked.connect(self.action_export_foreground)
        self.export_alpha_btn = QtWidgets.QPushButton("灰度透明度 PNG…")
        self.export_alpha_btn.clicked.connect(self.action_export_alpha)
        self.export_rec_btn = QtWidgets.QPushButton("导出约束记录…")
        self.export_rec_btn.clicked.connect(self.action_export_record)
        self.import_rec_btn = QtWidgets.QPushButton("载入约束记录…")
        self.import_rec_btn.clicked.connect(self.action_import_record)
        for b in (self.export_fg_btn, self.export_alpha_btn, self.export_rec_btn, self.import_rec_btn):
            export_box.addWidget(b)
        panel.addLayout(export_box)

        panel.addStretch(1)

        # --- status
        self.state_label = QtWidgets.QLabel()
        self.state_label.setWordWrap(True)
        self.state_label.setStyleSheet(
            "background: #f4f5f7; border: 1px solid #dfe1e6; border-radius: 6px; padding: 8px;"
        )
        panel.addWidget(self.state_label)
        self.help_btn = QtWidgets.QPushButton("操作说明")
        self.help_btn.clicked.connect(self.action_help)
        panel.addWidget(self.help_btn)

        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(side)
        scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
        scroll.setFixedWidth(352)
        return scroll

    # ----------------------------------------------------------------- viewer
    def _pane(self, title: str, hint: str = "") -> tuple[QtWidgets.QWidget, QtWidgets.QLabel]:
        frame = QtWidgets.QWidget()
        v = QtWidgets.QVBoxLayout(frame)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(4)
        head = QtWidgets.QHBoxLayout()
        label = QtWidgets.QLabel(title)
        label.setStyleSheet("font-weight: 600;")
        head.addWidget(label)
        head.addStretch(1)
        if hint:
            note = QtWidgets.QLabel(hint)
            note.setStyleSheet("color: #888; font-size: 11px;")
            head.addWidget(note)
        v.addLayout(head)
        return frame, label

    def _build_viewer(self) -> QtWidgets.QWidget:
        wrapper = QtWidgets.QWidget()
        layout = QtWidgets.QVBoxLayout(wrapper)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        header = QtWidgets.QHBoxLayout()
        self.zoom_label = QtWidgets.QLabel("100%")
        self.zoom_label.setStyleSheet("color: #666;")
        header.addWidget(QtWidgets.QLabel("三视图并排：原图标记 · 透明度 · 换底合成（缩放/平移联动）"))
        header.addStretch(1)
        header.addWidget(self.zoom_label)
        layout.addLayout(header)

        panes = QtWidgets.QHBoxLayout()
        panes.setSpacing(10)

        original_frame, _ = self._pane("原图 · 在此框选与标记", "画笔以原始像素记录")
        self.canvas = CanvasWidget()
        self.canvas.set_tool(Tool.BOX)
        self.canvas.stroke_started.connect(self.doc.begin_stroke)
        self.canvas.stroke_finished.connect(self.doc.commit_stroke)
        self.canvas.box_changed.connect(self._on_box_changed)
        self.canvas.zoom_changed.connect(self._on_zoom_changed)
        self.canvas.cursor_moved.connect(self._on_cursor)
        original_frame.layout().addWidget(self.canvas, 1)
        panes.addWidget(original_frame, 4)

        alpha_frame, _ = self._pane("透明度", "与导出灰度图一致")
        self.alpha_view = CanvasWidget()
        self.alpha_view.set_interactive(False)
        self.alpha_view.set_show_labels(False)
        self.alpha_view.set_view_mode("alpha")
        alpha_frame.layout().addWidget(self.alpha_view, 1)
        panes.addWidget(alpha_frame, 3)

        comp_frame, _ = self._pane("合成预览", "与导出透明 PNG 一致")
        self.composite_view = CanvasWidget()
        self.composite_view.set_interactive(False)
        self.composite_view.set_show_labels(False)
        self.composite_view.set_view_mode("composite")
        comp_frame.layout().addWidget(self.composite_view, 1)
        panes.addWidget(comp_frame, 3)

        layout.addLayout(panes, 1)

        self.message_label = QtWidgets.QLabel("")
        self.message_label.setWordWrap(True)
        self.message_label.setStyleSheet(
            "padding: 8px 10px; border-radius: 6px; background: #eef1f5; color: #333;"
        )
        self.message_label.setVisible(False)
        layout.addWidget(self.message_label)
        self.preview_views = [self.alpha_view, self.composite_view]
        self._apply_linking(True)
        return wrapper

    def _build_menu(self) -> None:
        menu = self.menuBar()
        file_menu = menu.addMenu("文件(&F)")
        file_menu.addAction("打开图片…", self.action_open, QtGui.QKeySequence.Open)
        file_menu.addAction("生成样例…", self.action_samples)
        file_menu.addSeparator()
        file_menu.addAction("导出透明 PNG…", self.action_export_foreground)
        file_menu.addAction("导出灰度透明度 PNG…", self.action_export_alpha)
        file_menu.addAction("导出约束记录…", self.action_export_record)
        file_menu.addAction("载入约束记录…", self.action_import_record)
        file_menu.addSeparator()
        file_menu.addAction("退出", self.close, QtGui.QKeySequence.Quit)

        edit_menu = menu.addMenu("编辑(&E)")
        edit_menu.addAction("撤销", self.action_undo, QtGui.QKeySequence.Undo)
        edit_menu.addAction("重做", self.action_redo, QtGui.QKeySequence.Redo)
        edit_menu.addSeparator()
        edit_menu.addAction("清除全部笔迹", self.action_clear_strokes)

        view_menu = menu.addMenu("视图(&V)")
        view_menu.addAction("适配窗口", self.canvas.fit_to_window)
        view_menu.addAction("实际像素", self.canvas.actual_size)
        help_menu = menu.addMenu("帮助(&H)")
        help_menu.addAction("操作说明", self.action_help)

    def _build_shortcuts(self) -> None:
        def add(seq, fn):
            shortcut = QtGui.QShortcut(QtGui.QKeySequence(seq), self)
            shortcut.activated.connect(fn)
            return shortcut

        add("Ctrl+Return", self.action_recompute)
        add("Ctrl+Enter", self.action_recompute)
        add("B", lambda: self._apply_tool(Tool.BOX))
        add("F", lambda: self._apply_tool(Tool.FG))
        add("D", lambda: self._apply_tool(Tool.BG))
        add("E", lambda: self._apply_tool(Tool.ERASE))
        add("L", lambda: self.show_labels.toggle())
        add("+", lambda: self.canvas.set_zoom_steps(1))
        add("=", lambda: self.canvas.set_zoom_steps(1))
        add("-", lambda: self.canvas.set_zoom_steps(-1))
        add("0", lambda: self.canvas.fit_to_window())
        add("1", lambda: self.canvas.actual_size())
        add("[", lambda: self._nudge_brush(-2))
        add("]", lambda: self._nudge_brush(2))
        add("Ctrl+Z", self.action_undo)
        add("Ctrl+Shift+Z", self.action_redo)

    def _connect_doc(self) -> None:
        self.doc.content_changed.connect(self._on_content_changed)
        self.doc.constraints_changed.connect(self._on_constraints_changed)
        self.doc.result_changed.connect(self._on_result_changed)
        self.doc.status_changed.connect(self._on_status)
        self.doc.message.connect(self._show_message)

    # ---------------------------------------------------------------- actions
    def action_open(self) -> None:
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, "打开图片", os.path.expanduser("~"), "图片 (*.png *.jpg *.jpeg);;所有文件 (*)"
        )
        if not path:
            return
        try:
            image = load_image_opencv(path)
        except MattingError as exc:
            self._show_message(exc.message, "error")
            QtWidgets.QMessageBox.warning(self, "无法打开图片", exc.message)
            return
        if self.doc.has_image() and self.doc.history and len(self.doc.history):
            answer = QtWidgets.QMessageBox.question(
                self,
                "打开新图片",
                "打开新图片会清除当前图片的所有标记与结果。是否继续？",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
                QtWidgets.QMessageBox.No,
            )
            if answer != QtWidgets.QMessageBox.Yes:
                return
        self._current_path = path
        self.doc.load_image(image, os.path.basename(path), source_path=path)
        self._show_message(f"已打开 {os.path.basename(path)}（{image.shape[1]}×{image.shape[0]}）", "info")

    def action_samples(self) -> None:
        dialog = SampleGallery(self)
        dialog.sample_chosen.connect(self._load_sample)
        dialog.exec()

    def _load_sample(self, key: str) -> None:
        if key not in SAMPLES:
            return
        self._loading = True
        try:
            sample = generate_sample(key)
            self._current_path = ""
            self.doc.load_image(sample.image, f"样例 · {sample.spec.title}", sample_key=key)
            # Box, then strokes: the box goes through the same path as a user drag.
            self.doc.set_box(tuple(sample.box))
            self.doc.load_strokes(sample.strokes)
            computed = self.doc.compute()
            if computed is None:
                self._show_message(self.doc.last_error, "error")
            # Frame the whole sample rather than whichever view fitted last.
            for view in [self.canvas] + self.preview_views:
                view.fit_to_window()
                view._auto_fit = True
        finally:
            self._loading = False

    def action_recompute(self) -> None:
        if not self.doc.has_image():
            self._show_message("请先打开一张图片，或加载一个内置样例。", "warn")
            return
        self.doc.settings.refine_radius = int(self.refine_slider.value())
        result = self.doc.compute()
        if result is None and self.doc.last_error:
            QtWidgets.QMessageBox.warning(self, "暂时无法生成结果", self.doc.last_error)

    def action_undo(self) -> None:
        if self.doc.has_image() and self.doc.history.can_undo():
            label = self.doc.history.undo_label()
            if self.doc.undo():
                self._show_message(f"已撤销：{label}", "info")

    def action_redo(self) -> None:
        if self.doc.has_image() and self.doc.history.can_redo():
            label = self.doc.history.redo_label()
            if self.doc.redo():
                self._show_message(f"已重做：{label}", "info")

    def action_clear_strokes(self) -> None:
        if self.doc.clear_strokes():
            self._show_message("已清除全部笔迹", "info")

    def action_help(self) -> None:
        box = QtWidgets.QMessageBox(self)
        box.setWindowTitle("操作说明")
        box.setTextFormat(QtCore.Qt.RichText)
        box.setText(HELP_TEXT)
        box.exec()

    def _ensure_fresh_before_export(self) -> bool:
        """Requirement 6: warn before exporting a stale preview."""
        if not self.doc.has_image():
            QtWidgets.QMessageBox.information(self, "导出", "请先打开一张图片。")
            return False
        if self.doc.result is None:
            answer = QtWidgets.QMessageBox.question(
                self,
                "预览尚未生成",
                "当前还没有有效的抠图结果。要先重新计算再导出吗？",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
                QtWidgets.QMessageBox.Yes,
            )
            if answer != QtWidgets.QMessageBox.Yes:
                return False
            if self.doc.compute() is None:
                QtWidgets.QMessageBox.warning(self, "无法导出", self.doc.last_error)
                return False
            return True
        if self.doc.is_stale():
            answer = QtWidgets.QMessageBox.question(
                self,
                "预览已过期",
                "标记或设置在上次计算之后又发生了变化，当前预览不是最新的。\n"
                "建议先重新计算再导出。现在要重新计算吗？",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
                QtWidgets.QMessageBox.Yes,
            )
            if answer == QtWidgets.QMessageBox.Yes:
                if self.doc.compute() is None:
                    QtWidgets.QMessageBox.warning(self, "无法导出", self.doc.last_error)
                    return False
                return True
            return False
        return True

    def _default_dir(self) -> str:
        return os.path.dirname(self._current_path) if self._current_path else os.path.expanduser("~")

    def _default_stem(self) -> str:
        if self._current_path:
            return os.path.splitext(os.path.basename(self._current_path))[0]
        if self.doc.sample_key:
            return f"sample_{self.doc.sample_key}"
        return "foreground"

    def action_export_foreground(self) -> None:
        if not self._ensure_fresh_before_export():
            return
        assert self.doc.result is not None
        name = f"{self._default_stem()}_foreground.png"
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, "导出透明 PNG", os.path.join(self._default_dir(), name), "PNG (*.png)"
        )
        if not path:
            return
        try:
            export_foreground_png(path, self.doc.result)
        except OSError as exc:
            QtWidgets.QMessageBox.warning(self, "导出失败", str(exc))
            return
        self._show_message(f"已导出透明 PNG：{os.path.basename(path)}", "success")

    def action_export_alpha(self) -> None:
        if not self._ensure_fresh_before_export():
            return
        assert self.doc.result is not None
        name = f"{self._default_stem()}_alpha.png"
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, "导出灰度透明度图", os.path.join(self._default_dir(), name), "PNG (*.png)"
        )
        if not path:
            return
        try:
            export_alpha_png(path, self.doc.result)
        except OSError as exc:
            QtWidgets.QMessageBox.warning(self, "导出失败", str(exc))
            return
        self._show_message(f"已导出灰度透明度图：{os.path.basename(path)}", "success")

    def action_export_record(self) -> None:
        if not self.doc.has_image():
            QtWidgets.QMessageBox.information(self, "导出", "请先打开一张图片。")
            return
        if not self.doc.settings.box:
            QtWidgets.QMessageBox.information(self, "导出", "还没有选框，无法保存约束。")
            return
        name = f"{self._default_stem()}_constraints.json"
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self, "导出约束记录", os.path.join(self._default_dir(), name), "JSON (*.json)"
        )
        if not path:
            return
        try:
            record = self.doc.build_record()
            export_constraints(path, record)
        except (RecordError, OSError) as exc:
            QtWidgets.QMessageBox.warning(
                self, "导出失败", getattr(exc, "message", str(exc))
            )
            return
        self._show_message(
            f"已导出约束记录（{len(record.strokes)} 条笔迹，含内容校验）", "success"
        )

    def action_import_record(self) -> None:
        if not self.doc.has_image():
            QtWidgets.QMessageBox.information(self, "载入约束", "请先打开对应的原图，再载入约束记录。")
            return
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self, "载入约束记录", self._default_dir(), "JSON (*.json);;所有文件 (*)"
        )
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
            record = ConstraintRecord.from_json(text, self.doc.image)
        except RecordError as exc:
            QtWidgets.QMessageBox.warning(self, "无法载入约束", exc.message)
            self._show_message(exc.message, "error")
            return
        except OSError as exc:
            QtWidgets.QMessageBox.warning(self, "无法载入约束", f"读取文件失败：{exc}")
            return
        # Apply the record's own settings first, then mirror them into the UI so
        # the sliders do not overwrite what was just loaded.
        self._loading = True
        try:
            self.doc.load_record(record)
            self._tool = Tool.FG
            self._apply_tool(Tool.FG)
            self.refine_slider.setValue(int(self.doc.settings.refine_radius))
            self.refine_value.setText(f"{int(self.doc.settings.refine_radius)} px")
        finally:
            self._loading = False
        self._show_message(
            f"已载入约束记录：{len(record.strokes)} 条笔迹。请点击“重新计算”生成结果。", "info"
        )

    # ---------------------------------------------------------------- helpers
    def _apply_tool(self, tool: int) -> None:
        self._tool = Tool(tool)
        for key, btn in self.tool_buttons.items():
            btn.setChecked(key == self._tool)
        self.canvas.set_tool(self._tool)
        if self._tool in (Tool.FG, Tool.BG, Tool.ERASE):
            self.canvas.setCursor(QtCore.Qt.BlankCursor)
        elif self._tool == Tool.BOX:
            self.canvas.setCursor(QtCore.Qt.CrossCursor)

    def _nudge_brush(self, delta: int) -> None:
        self.brush_slider.setValue(max(self.brush_slider.minimum(),
                                       min(self.brush_slider.maximum(),
                                           self.brush_slider.value() + delta)))

    def _on_brush_changed(self, value: int) -> None:
        self._brush_radius = float(value)
        self.brush_value.setText(f"{value} px")
        self.canvas.set_brush_radius(self._brush_radius)

    def _on_refine_changed(self, value: int) -> None:
        if self._loading:
            return
        self.refine_value.setText(f"{value} px")
        self.doc.settings.refine_radius = int(value)
        self.doc._emit_status()
        self._update_stale_badge()

    def _on_box_changed(self, box) -> None:
        self.doc.set_box(box)
        if box is None:
            self._show_message("选框太小，已忽略。请重新拖出至少 24×24 的框。", "warn")

    def _set_backdrop(self, mode: str) -> None:
        for key, btn in self.backdrop_buttons.items():
            btn.setChecked(key == mode)
        self.composite_view.set_backdrop(mode)

    def _apply_linking(self, enabled: bool) -> None:
        views = [self.canvas] + getattr(self, "preview_views", [])
        for view in views:
            view._linked.clear()
        if enabled:
            for view in views:
                for other in views:
                    if other is not view:
                        view.link_view(other)
            for view in views[1:]:
                view._zoom = self.canvas.zoom
                view._pan = QtCore.QPointF(self.canvas._pan)
                view._auto_fit = self.canvas._auto_fit
                view._fitted = self.canvas._fitted
                view._invalidate()

    # ----------------------------------------------------------------- events
    def _on_content_changed(self) -> None:
        image = self.doc.image
        self.canvas.set_model(
            image,
            self.doc.labels.data if self.doc.labels else None,
            self.doc.result,
            self.doc.settings.box,
        )
        for view in self.preview_views:
            view.set_model(image, None, self.doc.result, self.doc.settings.box)
        if image is None:
            self.image_label.setText("尚未打开图片")
        else:
            h, w = image.shape[:2]
            kinds = "样例" if self.doc.sample_key else "图片"
            self.image_label.setText(f"{self.doc.image_name}\n{kinds} · {w}×{h}")

    def _on_constraints_changed(self) -> None:
        self.canvas.set_labels(self.doc.labels.data if self.doc.labels else None)
        self.canvas.set_box(self.doc.settings.box)
        for view in self.preview_views:
            view.set_box(self.doc.settings.box)

    def _on_result_changed(self) -> None:
        self.canvas.set_result(self.doc.result, self.doc.settings.box)
        for view in self.preview_views:
            view.set_result(self.doc.result, self.doc.settings.box)

    def _on_zoom_changed(self, zoom: float) -> None:
        self.zoom_label.setText(f"{zoom * 100:.0f}%")

    def _on_cursor(self, x: int, y: int) -> None:
        if x < 0:
            return
        self.statusBar().showMessage(f"原图坐标 x={x}, y={y}", 1500)

    def _on_status(self, status: DocumentStatus) -> None:
        if not status.has_image:
            self.state_label.setText("尚未打开图片")
        else:
            lines = []
            state = "有结果" if status.has_result else "尚未计算"
            if status.stale and status.has_result:
                state = "预览已过期，需重新计算"
            lines.append(f"<b>{state}</b>")
            if self.doc.image is not None:
                h, w = self.doc.image.shape[:2]
                lines.append(f"原图：{w}×{h}")
            lines.append(f"选框：{'已设置' if status.has_box else '未设置'}")
            lines.append(f"确定前景像素：{status.fg_count} · 确定背景像素：{status.bg_count}")
            lines.append(f"笔迹操作：{len(self.doc.history) if self.doc.history else 0} 步")
            if status.last_error:
                lines.append(f"<span style='color:#b00020'>{status.last_error}</span>")
            self.state_label.setText("<br>".join(lines))
        self._update_buttons()

    def _update_buttons(self) -> None:
        status = self.doc.status()
        has_image = status.has_image
        has_result = status.has_result
        self.recompute_btn.setEnabled(has_image)
        self.undo_btn.setEnabled(has_image and self.doc.history.can_undo())
        self.redo_btn.setEnabled(has_image and self.doc.history.can_redo())
        self.export_fg_btn.setEnabled(has_result)
        self.export_alpha_btn.setEnabled(has_result)
        self.export_rec_btn.setEnabled(has_image and status.has_box)
        self.import_rec_btn.setEnabled(has_image)
        self._update_stale_badge()

    def _update_stale_badge(self) -> None:
        if not self.doc.has_image():
            return
        if self.doc.is_stale() and self.doc.result is not None:
            self.recompute_btn.setText("重新计算（预览已过期）")
            self.recompute_btn.setStyleSheet("font-weight: 600; color: #b34a00;")
        else:
            self.recompute_btn.setText("重新计算")
            self.recompute_btn.setStyleSheet("font-weight: 600;")

    def _refresh_all(self) -> None:
        self._on_content_changed()
        self._on_constraints_changed()
        self._on_result_changed()
        self._on_status(self.doc.status())
        self._set_backdrop("checker")

    def _show_message(self, text: str, level: str = "info") -> None:
        colors = {
            "info": ("#eef1f5", "#333"),
            "success": ("#e6f4ea", "#1b5e20"),
            "warn": ("#fff4e5", "#7a4a00"),
            "error": ("#fdecea", "#8a1c1c"),
        }
        bg, fg = colors.get(level, colors["info"])
        if not text:
            self.message_label.setVisible(False)
            return
        self.message_label.setText(text)
        self.message_label.setStyleSheet(
            f"padding: 8px 10px; border-radius: 6px; background: {bg}; color: {fg};"
        )
        self.message_label.setVisible(True)
        self.statusBar().showMessage(text.replace("\n", " "), 6000)
        if level == "error":
            self._update_stale_badge()

    # ----------------------------------------------------------- drag & drop
    def dragEnterEvent(self, event: QtGui.QDragEnterEvent) -> None:
        if event.mimeData().hasUrls():
            for url in event.mimeData().urls():
                if url.toLocalFile().lower().endswith((".png", ".jpg", ".jpeg")):
                    event.acceptProposedAction()
                    return
        event.ignore()

    def dropEvent(self, event: QtGui.QDropEvent) -> None:
        for url in event.mimeData().urls():
            path = url.toLocalFile()
            if path.lower().endswith((".png", ".jpg", ".jpeg")):
                try:
                    image = load_image_opencv(path)
                except MattingError as exc:
                    self._show_message(exc.message, "error")
                    return
                self._current_path = path
                self.doc.load_image(image, os.path.basename(path), source_path=path)
                return

    def closeEvent(self, event: QtGui.QCloseEvent) -> None:
        if self.doc.has_image() and self.doc.history and len(self.doc.history):
            answer = QtWidgets.QMessageBox.question(
                self,
                "退出",
                "当前标记尚未导出约束记录，退出后丢失。仍要退出吗？",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
                QtWidgets.QMessageBox.No,
            )
            if answer != QtWidgets.QMessageBox.Yes:
                event.ignore()
                return
        super().closeEvent(event)
