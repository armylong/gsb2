"""PySide6 主窗口。

布局:
- 左上: 原图/起点 与 现图 两个同步平移缩放的画布, 点击任意处同时读两个索引
- 左下: 历史步骤(可点任意一步跳回) + 诊断日志
- 右侧: 色表(色号/色块/RGBA/数量/透明度)、改色、两种重排操作、换色版本与批量导出
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, QTimer, QUrl, QSize
from PySide6.QtGui import QColor, QDesktopServices, QIcon, QKeySequence, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from .model import EditContext, History, IndexedImage, swapped_number_order
from .png_io import (
    CheckResult,
    NotIndexedPngError,
    all_passed,
    load_indexed_png,
    prepare_for_export,
    verify_output,
    write_indexed_png,
)
from .render import render_qimage
from .sample import SAMPLE_DIR, ensure_sample_file
from .widgets import PixelCanvas, ViewState

ROOT = Path(__file__).resolve().parent.parent


def _ensure_output_dir() -> Path:
    out = ROOT / "output"
    out.mkdir(parents=True, exist_ok=True)
    return out


# ---------------------------------------------------------------------------
# 小部件辅助
# ---------------------------------------------------------------------------


def swatch_pixmap(rgba: tuple[int, int, int, int], w: int = 54, h: int = 22) -> QPixmap:
    """画一个带棋盘底的色块(透明/半透明也能看出来)。"""
    from PySide6.QtGui import QPainter

    pm = QPixmap(w, h)
    p = QPainter(pm)
    tile = 8
    for y in range(0, h, tile):
        for x in range(0, w, tile):
            odd = ((x // tile) + (y // tile)) % 2 == 0
            p.fillRect(x, y, tile, tile, QColor("#ffffff" if odd else "#c9c9d1"))
    r, g, b, a = rgba
    p.fillRect(0, 0, w, h, QColor(r, g, b, a))
    p.setPen(QColor(0, 0, 0, 160))
    p.drawRect(0, 0, w - 1, h - 1)
    p.end()
    return pm


def alpha_text(a: int) -> str:
    if a == 0:
        return "0 · 全透明"
    if a < 255:
        return f"{a} · 半透明"
    return "255 · 不透明"


def rgba_hex(rgba: tuple[int, int, int, int]) -> str:
    r, g, b, a = rgba
    return f"#{r:02X}{g:02X}{b:02X}" + (f"{a:02X}" if a != 255 else "")


class TwoIndexDialog(QDialog):
    """选择两个色号; 文案说明这一次操作的语义。"""

    def __init__(self, palette, first: int, title: str, hint: str, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setMinimumWidth(420)
        layout = QVBoxLayout(self)
        tip = QLabel(hint)
        tip.setWordWrap(True)
        tip.setStyleSheet("color: #555;")
        layout.addWidget(tip)

        row = QHBoxLayout()
        self.cb_a = QComboBox()
        self.cb_b = QComboBox()
        for i, rgba in enumerate(palette):
            text = f"#{i}   {rgba_hex(rgba)}   α={rgba[3]}"
            self.cb_a.addItem(QIcon(swatch_pixmap(rgba, 40, 18)), text)
            self.cb_b.addItem(QIcon(swatch_pixmap(rgba, 40, 18)), text)
        n = len(palette)
        self.cb_a.setCurrentIndex(max(0, min(first, n - 1)))
        self.cb_b.setCurrentIndex((first + 1) % n if n > 1 else 0)
        row.addWidget(QLabel("色号 A:"))
        row.addWidget(self.cb_a, 1)
        row.addWidget(QLabel("色号 B:"))
        row.addWidget(self.cb_b, 1)
        layout.addLayout(row)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def indexes(self) -> tuple[int, int]:
        return self.cb_a.currentIndex(), self.cb_b.currentIndex()


class ReportDialog(QDialog):
    """导出后从磁盘回读的核对报告。"""

    def __init__(self, records: list[tuple[str, Path, list[CheckResult]]], parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("导出 → 重新读回核对报告")
        self.resize(760, 560)
        self._dir = records[0][1].parent if records else None

        layout = QVBoxLayout(self)
        all_ok = all(all_passed(checks) for _, _, checks in records)
        headline = QLabel(
            ("✅ 全部文件回读核对通过：索引、PLTE、tRNS 均与编辑结果一致。"
             if all_ok else
             "⚠️ 存在核对失败项，请看下面的 FAIL 行。")
        )
        headline.setWordWrap(True)
        headline.setStyleSheet("font-weight: 600; padding: 4px;")
        layout.addWidget(headline)

        view = QPlainTextEdit()
        view.setReadOnly(True)
        from PySide6.QtGui import QFontDatabase

        view.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont))
        parts: list[str] = []
        for title, path, checks in records:
            parts.append("=" * 78)
            parts.append(f"{title}  ->  {path}")
            parts.append("-" * 78)
            parts.extend(c.line() for c in checks)
            parts.append("")
        view.setPlainText("\n".join(parts))
        layout.addWidget(view, 1)

        row = QHBoxLayout()
        if self._dir is not None:
            reveal = QPushButton("在访达/文件管理器中显示输出目录")
            reveal.clicked.connect(
                lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(self._dir)))
            )
            row.addWidget(reveal)
        row.addStretch(1)
        close = QPushButton("关闭")
        close.clicked.connect(self.accept)
        row.addWidget(close)
        layout.addLayout(row)


# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("索引色 PNG 编辑器 — 保住每个像素选的是几号色")
        self.resize(1440, 940)

        self.master: Optional[EditContext] = None
        self.versions: list[EditContext] = []
        self.ctx: Optional[EditContext] = None
        self.selected_index: Optional[int] = None

        self.last_export_records: list[tuple[str, Path, list[CheckResult]]] = []
        # 导出路径 -> 写盘时实际 PLTE/索引的预期快照, 供之后重新读回核对
        self.expected_snapshots: dict[str, IndexedImage] = {}

        self._syncing_spins = False
        self._building_table = False
        self._building_contexts = False
        self._building_history = False
        self._fitted_once = False
        self._last_open_dir = str(SAMPLE_DIR)

        self.view_state = ViewState()

        self._build_ui()
        self._connect_signals()

        # 启动即载入自带样本, 窗口不是空的
        try:
            path = ensure_sample_file()
            self.open_path(path, confirm_discard=False)
        except Exception as exc:  # noqa: BLE001
            self.log(f"样本生成失败: {exc!r}")

    # =====================================================================
    # UI 构建
    # =====================================================================
    def _build_ui(self) -> None:
        root = QSplitter(Qt.Orientation.Horizontal)

        # ---------- 左: 双画布 + 底部标签页 ----------
        left = QSplitter(Qt.Orientation.Vertical)

        views_widget = QWidget()
        vw = QVBoxLayout(views_widget)
        vw.setContentsMargins(6, 6, 6, 2)

        bars = QHBoxLayout()
        self.btn_zoom_out = QPushButton("－")
        self.btn_zoom_in = QPushButton("＋")
        self.btn_fit = QPushButton("适应窗口")
        self.btn_1to1 = QPushButton("1:1")
        for b in (self.btn_zoom_out, self.btn_zoom_in, self.btn_fit, self.btn_1to1):
            b.setFixedHeight(26)
            bars.addWidget(b)
        self.chk_highlight = QCheckBox("高亮所选色号")
        self.chk_highlight.setChecked(True)
        self.chk_dim = QCheckBox("淡化其他索引")
        self.chk_dim.setChecked(True)
        bars.addWidget(self.chk_highlight)
        bars.addWidget(self.chk_dim)
        bars.addStretch(1)
        self.zoom_label = QLabel("")
        self.zoom_label.setStyleSheet("color: #666;")
        bars.addWidget(self.zoom_label)
        vw.addLayout(bars)

        self.canvas_orig = PixelCanvas(self.view_state, "原图 / 起点")
        self.canvas_cur = PixelCanvas(self.view_state, "现图")
        self.box_orig = QGroupBox("原图 / 起点（只读）")
        lo = QVBoxLayout(self.box_orig)
        lo.setContentsMargins(4, 6, 4, 4)
        lo.addWidget(self.canvas_orig)
        self.box_cur = QGroupBox("现图（颜色/编号编辑结果）")
        lc = QVBoxLayout(self.box_cur)
        lc.setContentsMargins(4, 6, 4, 4)
        lc.addWidget(self.canvas_cur)

        self.view_splitter = QSplitter(Qt.Orientation.Horizontal)
        self.view_splitter.addWidget(self.box_orig)
        self.view_splitter.addWidget(self.box_cur)
        self.view_splitter.setStretchFactor(0, 1)
        self.view_splitter.setStretchFactor(1, 1)
        vw.addWidget(self.view_splitter, 1)

        self.readout = QLabel("在图上点任意像素，这里同时显示原图与现图的色号")
        self._readout_placeholder = self.readout.text()
        self.readout.setWordWrap(True)
        self.readout.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        from PySide6.QtGui import QFontDatabase

        self.readout.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont))
        self.readout.setStyleSheet(
            "background: #f4f4f8; border: 1px solid #d8d8e0; border-radius: 4px;"
            " padding: 5px 8px;"
        )
        vw.addWidget(self.readout)

        left.addWidget(views_widget)

        self.tabs = QTabWidget()
        self.history_list = QListWidget()
        self.history_list.setToolTip("点任意一步即可跳回该步的颜色与编号状态")
        self.tabs.addTab(self.history_list, "历史步骤（点任意一步跳回）")

        self.log_view = QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumBlockCount(2000)
        self.tabs.addTab(self.log_view, "诊断 / 日志")
        left.addWidget(self.tabs)
        left.setStretchFactor(0, 4)
        left.setStretchFactor(1, 1)
        left.setSizes([620, 210])

        root.addWidget(left)

        # ---------- 右: 控制面板(可滚动) ----------
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(8, 8, 8, 8)
        rv.setSpacing(8)

        rv.addWidget(self._build_context_box())
        rv.addWidget(self._build_palette_box(), 2)
        rv.addWidget(self._build_color_box())
        rv.addWidget(self._build_ops_box())
        rv.addWidget(self._build_versions_box())
        rv.addStretch(1)

        self.right_scroll = QScrollArea()
        self.right_scroll.setWidgetResizable(True)
        self.right_scroll.setWidget(right)
        self.right_scroll.setMinimumWidth(410)
        self.right_scroll.setMaximumWidth(520)
        root.addWidget(self.right_scroll)
        root.setStretchFactor(0, 1)
        root.setStretchFactor(1, 0)

        self.setCentralWidget(root)
        self._build_menus()
        self.statusBar().showMessage("就绪")

    def _build_context_box(self) -> QGroupBox:
        box = QGroupBox("编辑上下文（主编号图 / 两个换色版本）")
        v = QVBoxLayout(box)
        self.context_list = QListWidget()
        self.context_list.setMaximumHeight(74)
        v.addWidget(self.context_list)
        return box

    def _build_palette_box(self) -> QGroupBox:
        box = QGroupBox("色表：每个色号独立（同色也能单独点）")
        v = QVBoxLayout(box)
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["色号", "颜色", "像素数", "透明度"])
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setIconSize(QSize(50, 20))
        hdr = self.table.horizontalHeader()
        hdr.setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        self.table.setColumnWidth(0, 52)
        hdr.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        hdr.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        hdr.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.table.setMinimumHeight(188)
        v.addWidget(self.table)
        return box

    def _build_color_box(self) -> QGroupBox:
        box = QGroupBox("① 修改选中色号的颜色 / 透明度")
        v = QVBoxLayout(box)
        grid = QGridLayout()
        self.spin_r = self._color_spin()
        self.spin_g = self._color_spin()
        self.spin_b = self._color_spin()
        self.spin_a = self._color_spin()
        for col, (lab, w) in enumerate(
            [("R", self.spin_r), ("G", self.spin_g), ("B", self.spin_b), ("A", self.spin_a)]
        ):
            grid.addWidget(QLabel(lab), 0, col * 2)
            grid.addWidget(w, 0, col * 2 + 1)
        v.addLayout(grid)
        self.btn_pick_color = QPushButton("打开取色器（可精确设置 Alpha 透明度）…")
        v.addWidget(self.btn_pick_color)
        hint = QLabel("改的是这一个色号；与它 RGB 相同的其他编号区域不会被改动。")
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #777; font-size: 12px;")
        v.addWidget(hint)
        return box

    @staticmethod
    def _color_spin() -> QSpinBox:
        s = QSpinBox()
        s.setRange(0, 255)
        return s

    def _build_ops_box(self) -> QGroupBox:
        box = QGroupBox("② 色表结构操作（两种语义不同，历史分别记录）")
        v = QVBoxLayout(box)

        v.addWidget(QLabel("A. 交换两格的“外观”：编号不动 → 两块区域交换颜色"))
        self.btn_swap_appearance = QPushButton("交换两个色号的外观…")
        v.addWidget(self.btn_swap_appearance)

        line = QFrame()
        line.setFrameShape(QFrame.Shape.HLine)
        v.addWidget(line)

        v.addWidget(QLabel("B. 重排“编号”并保住外观：像素同步改号 → 画面完全不变"))
        row = QHBoxLayout()
        self.btn_move_up = QPushButton("选中号上移一位")
        self.btn_move_down = QPushButton("选中号下移一位")
        self.btn_move_to = QPushButton("移动到编号…")
        row.addWidget(self.btn_move_up)
        row.addWidget(self.btn_move_down)
        row.addWidget(self.btn_move_to)
        v.addLayout(row)
        self.btn_swap_numbers = QPushButton("交换两个编号（保外观，像素跟着改号）…")
        v.addWidget(self.btn_swap_numbers)
        return box

    def _build_versions_box(self) -> QGroupBox:
        box = QGroupBox("③ 两个换色版本与批量输出")
        v = QVBoxLayout(box)
        self.btn_create_ab = QPushButton("从当前编号图创建 A / B 两个版本")
        self.btn_create_ab.setStyleSheet("font-weight: 600;")
        v.addWidget(self.btn_create_ab)

        depth_row = QHBoxLayout()
        depth_row.addWidget(QLabel("输出位深:"))
        self.combo_depth = QComboBox()
        self.combo_depth.addItem("自动（4 位原图仍输出 4 位）", "auto")
        self.combo_depth.addItem("8 位索引色", "8")
        self.combo_depth.addItem("4 位索引色（≤16 格时）", "4")
        depth_row.addWidget(self.combo_depth, 1)
        v.addLayout(depth_row)

        row = QHBoxLayout()
        self.btn_export_all = QPushButton("批量导出全部版本…")
        self.btn_export_all.setStyleSheet("font-weight: 600;")
        self.btn_export_current = QPushButton("只导出当前上下文…")
        row.addWidget(self.btn_export_all)
        row.addWidget(self.btn_export_current)
        v.addLayout(row)

        self.btn_reread = QPushButton("重新读回上次导出的文件并核对索引/透明项")
        v.addWidget(self.btn_reread)
        return box

    def _build_menus(self) -> None:
        m_file = self.menuBar().addMenu("文件(&F)")
        act_open = m_file.addAction("打开 4/8 位索引色 PNG…")
        act_open.triggered.connect(self.choose_and_open)
        act_sample = m_file.addAction("生成并载入自带样本")
        act_sample.triggered.connect(lambda: self.open_path(ensure_sample_file()))
        m_file.addSeparator()
        act_export_cur = m_file.addAction("导出当前上下文为索引色 PNG…")
        act_export_cur.triggered.connect(self.export_current)
        act_export_all = m_file.addAction("批量导出 A/B 版本…")
        act_export_all.triggered.connect(self.export_versions)
        m_file.addSeparator()
        act_quit = m_file.addAction("退出")
        act_quit.triggered.connect(self.close)

        m_edit = self.menuBar().addMenu("编辑(&E)")
        self.act_undo = m_edit.addAction("撤销")
        self.act_undo.setShortcut(QKeySequence.StandardKey.Undo)
        self.act_undo.triggered.connect(self.undo)
        self.act_redo = m_edit.addAction("重做")
        self.act_redo.setShortcuts([
            QKeySequence(QKeySequence.StandardKey.Redo),
            QKeySequence("Ctrl+Y"),
        ])
        self.act_redo.triggered.connect(self.redo)

        m_help = self.menuBar().addMenu("帮助(&H)")
        act_about = m_help.addAction("关于 / 数据模型说明")
        act_about.triggered.connect(self.show_about)

    def _connect_signals(self) -> None:
        self.btn_zoom_in.clicked.connect(lambda: self.canvas_cur.zoom_center(1.25))
        self.btn_zoom_out.clicked.connect(lambda: self.canvas_cur.zoom_center(1 / 1.25))
        self.btn_fit.clicked.connect(self.fit_views)
        self.btn_1to1.clicked.connect(self.actual_size)
        self.view_state.changed.connect(self._update_zoom_label)

        self.chk_highlight.toggled.connect(self.refresh_images)
        self.chk_dim.toggled.connect(self.refresh_images)

        self.table.itemSelectionChanged.connect(self.on_palette_selection_changed)

        for s in (self.spin_r, self.spin_g, self.spin_b, self.spin_a):
            s.valueChanged.connect(self.on_spin_changed)
        self.btn_pick_color.clicked.connect(self.pick_color)

        self.btn_swap_appearance.clicked.connect(self.swap_appearance_dialog)
        self.btn_swap_numbers.clicked.connect(self.swap_numbers_dialog)
        self.btn_move_up.clicked.connect(lambda: self.move_selected(-1))
        self.btn_move_down.clicked.connect(lambda: self.move_selected(1))
        self.btn_move_to.clicked.connect(self.move_selected_to_dialog)

        self.history_list.currentRowChanged.connect(self.on_history_row_changed)
        self.context_list.currentRowChanged.connect(self.on_context_row_changed)

        self.btn_create_ab.clicked.connect(self.create_ab_versions)
        self.btn_export_all.clicked.connect(self.export_versions)
        self.btn_export_current.clicked.connect(self.export_current)
        self.btn_reread.clicked.connect(self.reread_last)

        for c in (self.canvas_orig, self.canvas_cur):
            c.pixelClicked.connect(self.inspect_pixel)
            c.hoverPixel.connect(self.on_hover_pixel)

    # =====================================================================
    # 通用
    # =====================================================================
    def log(self, text: str) -> None:
        self.log_view.appendPlainText(text)

    def show_about(self) -> None:
        QMessageBox.information(
            self,
            "关于",
            "本编辑器的核心不变量：\n\n"
            "    外观颜色 = 色表[像素保存的色号]\n\n"
            "• 两个色号可以是完全相同的 RGBA，但编号始终独立，不会合并；\n"
            "• 改一个色号只影响引用该号的像素；\n"
            "• “交换外观”只换色表 RGBA，编号不动；\n"
            "• “重排编号”同时重映射像素，因此画面逐像素不变；\n"
            "• 历史保存完整快照，可跳回任意一步的颜色与编号；\n"
            "• 导出只写 color type 3 索引色 PNG，并重新读回核对。\n\n"
            "命令行自检： .venv/bin/python tools/verify.py",
        )

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        if not self._fitted_once:
            self._fitted_once = True
            # 布局/分割条落定后再 fit 一次, 避免拿到初始的错误尺寸
            QTimer.singleShot(0, self.fit_views)
            QTimer.singleShot(140, self.fit_views)

    # =====================================================================
    # 文件打开
    # =====================================================================
    def choose_and_open(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开索引色 PNG", self._last_open_dir, "PNG 图片 (*.png)"
        )
        if path:
            self._last_open_dir = str(Path(path).parent)
            self.open_path(Path(path))

    def _has_unfinished_work(self) -> bool:
        if self.master is None:
            return False
        if len(self.master.history.steps) > 1:
            return True
        return any(len(v.history.steps) > 1 for v in self.versions)

    def open_path(self, path, confirm_discard: bool = True) -> None:
        p = Path(path)
        try:
            doc = load_indexed_png(p)
        except NotIndexedPngError as exc:
            # 关键: 直接返回, self.master / self.ctx 原封不动
            QMessageBox.warning(self, "这不是索引色 PNG — 现有编辑已保留", exc.user_message())
            self.log(f"[拒绝打开] {exc}")
            return
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "读取失败", f"无法读取 {p}:\n{exc!r}")
            self.log(f"[打开失败] {p}: {exc!r}")
            return

        if confirm_discard and self._has_unfinished_work():
            ret = QMessageBox.question(
                self,
                "替换当前编辑？",
                "当前主图或版本里还有编辑步骤。打开新的索引色图会替换它们"
                "（需要的话请先批量导出）。\n\n确定继续吗？",
            )
            if ret != QMessageBox.StandardButton.Yes:
                return

        self.master = EditContext("master", "主编号图", doc, f"读入 {doc.title}")
        self.versions = []
        self.ctx = self.master
        self.last_export_records = []
        self.selected_index = self._first_used_index(doc)

        self.log(
            f"[打开] {p}\n"
            f"       {doc.width}x{doc.height}, IHDR 位深={doc.bit_depth}, "
            f"色表 {len(doc.palette)} 格"
        )
        self.readout.setText(self._readout_placeholder)
        self.refresh_all()
        self.fit_views()
        self._report_gap_indices(doc)

    @staticmethod
    def _first_used_index(doc: IndexedImage) -> int:
        """默认选中: 优先选“与另一格同色”的已使用色号, 直接展示核心特性。"""
        counts = doc.counts()
        used = [i for i in range(len(doc.palette)) if counts[i] > 0]
        if not used:
            return 0
        color_slots: dict[tuple, list[int]] = {}
        for i in used:
            color_slots.setdefault(doc.palette[i], []).append(i)
        for ids in color_slots.values():
            if len(ids) > 1:
                return ids[0]
        for i in used:
            if doc.palette[i][3] > 0:
                return i
        return used[0]

    def _report_gap_indices(self, doc: IndexedImage) -> None:
        gaps = doc.gap_positions()
        if not gaps:
            return
        lines = ["发现像素引用了色表中不存在的色号（PLTE 条目不足）："]
        detail_lines = list(lines)
        for idx in sorted(gaps):
            positions = gaps[idx]
            all_positions = doc.gap_positions()[idx]
            preview = ", ".join(f"(x={x},y={y})" for x, y in positions[:12])
            lines.append(f"  · 色号 #{idx}：共 {len(all_positions)} 处，例如 {preview}")
            detail_lines.append(f"#{idx}: " + ", ".join(f"({x},{y})" for x, y in all_positions))
        lines.append("")
        lines.append("这些位置用品红色占位显示；导出时会补上品红 PLTE 槽位以保留原始编号。")
        self.log("\n".join(lines))
        msg = QMessageBox(self)
        msg.setIcon(QMessageBox.Icon.Warning)
        msg.setWindowTitle("色表不足：部分索引缺少颜色")
        msg.setText("\n".join(lines))
        msg.setDetailedText("\n".join(detail_lines))
        msg.exec()

    # =====================================================================
    # 刷新
    # =====================================================================
    def refresh_all(self) -> None:
        self.refresh_context_list()
        self.refresh_palette_table()
        self.refresh_images()
        self.refresh_history()
        self._update_zoom_label()

    def refresh_context_list(self) -> None:
        self._building_contexts = True
        self.context_list.clear()
        if self.master is not None:
            dirty = len(self.master.history.steps) > 1
            self.context_list.addItem(
                QListWidgetItem(f"★ 主编号图：{self.master.base.title}" + ("  [已编辑]" if dirty else ""))
            )
        for v in self.versions:
            dirty = len(v.history.steps) > 1
            self.context_list.addItem(
                QListWidgetItem(f"🎨 版本 {v.key}：{v.title}" + ("  [已换色]" if dirty else ""))
            )
        if self.ctx is self.master:
            row = 0
        else:
            row = next((k + 1 for k, v in enumerate(self.versions) if v is self.ctx), -1)
        if row >= 0:
            self.context_list.setCurrentRow(row)
        self._building_contexts = False

    def _active_doc(self) -> Optional[IndexedImage]:
        return self.ctx.doc if self.ctx is not None else None

    def refresh_palette_table(self) -> None:
        self._building_table = True
        doc = self._active_doc()
        if doc is None:
            self.table.setRowCount(0)
            self._building_table = False
            return

        counts = doc.counts()
        n = len(doc.palette)
        if self.selected_index is None or not (0 <= self.selected_index < n):
            self.selected_index = self._first_used_index(doc)

        self.table.setRowCount(n)
        for i, rgba in enumerate(doc.palette):
            r, g, b, a = rgba
            item_id = QTableWidgetItem(f"#{i}")
            if counts[i] == 0:
                item_id.setForeground(QColor("#999"))
            self.table.setItem(i, 0, item_id)

            item_color = QTableWidgetItem(f"  {rgba_hex(rgba)}")
            item_color.setIcon(QIcon(swatch_pixmap(rgba)))
            item_color.setToolTip(
                f"色号 #{i}\nRGBA = ({r}, {g}, {b}, {a})\n"
                f"HEX = {rgba_hex(rgba)}\n像素数 = {counts[i]}"
            )
            self.table.setItem(i, 1, item_color)

            item_count = QTableWidgetItem(f"{counts[i]}")
            item_count.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.table.setItem(i, 2, item_count)

            item_alpha = QTableWidgetItem(alpha_text(a))
            if a == 0:
                item_alpha.setForeground(QColor("#888"))
            elif a < 255:
                item_alpha.setForeground(QColor("#1a7f37"))
            self.table.setItem(i, 3, item_alpha)

        self.table.setCurrentCell(self.selected_index, 0)
        self._building_table = False
        self.sync_spins_from_selection()

    def sync_spins_from_selection(self) -> None:
        self._syncing_spins = True
        doc = self._active_doc()
        i = self.selected_index
        enabled = doc is not None and i is not None and 0 <= i < len(doc.palette)
        for w in (self.spin_r, self.spin_g, self.spin_b, self.spin_a, self.btn_pick_color):
            w.setEnabled(bool(enabled))
        if enabled:
            r, g, b, a = doc.palette[i]  # type: ignore[index]
            self.spin_r.setValue(r)
            self.spin_g.setValue(g)
            self.spin_b.setValue(b)
            self.spin_a.setValue(a)
        self._syncing_spins = False

    def refresh_images(self) -> None:
        if self.ctx is None:
            self.canvas_orig.set_image(None)
            self.canvas_cur.set_image(None)
            return
        hi = self.selected_index if self.chk_highlight.isChecked() else None
        dim = self.chk_dim.isChecked()
        self.canvas_orig.set_image(render_qimage(self.ctx.base, highlight=hi, dim_others=dim))
        self.canvas_cur.set_image(render_qimage(self.ctx.doc, highlight=hi, dim_others=dim))
        if hi is not None:
            self.canvas_orig.set_outline_cells(self.ctx.base.positions_of(hi))
            self.canvas_cur.set_outline_cells(self.ctx.doc.positions_of(hi))
        else:
            self.canvas_orig.set_outline_cells(None)
            self.canvas_cur.set_outline_cells(None)
        which = "原图 / 起点（只读）" if self.ctx is self.master else f"版本 {self.ctx.key} 的起点（同一当前编号图）"
        self.box_orig.setTitle(which)

    def refresh_history(self) -> None:
        self._building_history = True
        self.history_list.clear()
        if self.ctx is not None:
            h: History = self.ctx.history
            for k, step in enumerate(h.steps):
                self.history_list.addItem(QListWidgetItem(f"{k}. {step.label}"))
            self.history_list.setCurrentRow(h.cursor)
        self._building_history = False
        is_master = self.ctx is not None
        self.act_undo.setEnabled(is_master and self.ctx.history.can_undo())
        self.act_redo.setEnabled(is_master and self.ctx.history.can_redo())

    def _update_zoom_label(self) -> None:
        self.zoom_label.setText(f"缩放 {self.view_state.scale * 100:.0f}%")

    def fit_views(self) -> None:
        doc = self._active_doc()
        if doc is None:
            return
        vw = min(max(self.canvas_orig.width(), 200), max(self.canvas_cur.width(), 200))
        vh = min(max(self.canvas_orig.height(), 180), max(self.canvas_cur.height(), 180))
        self.view_state.fit(doc.width, doc.height, vw, vh)

    def actual_size(self) -> None:
        doc = self._active_doc()
        if doc is None:
            return
        self.view_state.actual_size(
            doc.width, doc.height, self.canvas_cur.width(), self.canvas_cur.height()
        )

    # =====================================================================
    # 选择 / 取色 / 像素对照
    # =====================================================================
    def on_palette_selection_changed(self) -> None:
        if self._building_table:
            return
        row = self.table.currentRow()
        if row < 0:
            return
        self.selected_index = row
        self.sync_spins_from_selection()
        self.refresh_images()

    def on_spin_changed(self) -> None:
        if self._syncing_spins or self.ctx is None or self.selected_index is None:
            return
        i = self.selected_index
        doc = self.ctx.doc
        if not (0 <= i < len(doc.palette)):
            return
        rgba = (self.spin_r.value(), self.spin_g.value(), self.spin_b.value(), self.spin_a.value())
        if doc.palette[i] == rgba:
            return
        new_doc = doc.clone()
        new_doc.set_color(i, rgba)
        self.ctx.history.commit(
            f"修改 #{i} 颜色/透明度为 {rgba_hex(rgba)}",
            new_doc,
            key=f"color:{self.ctx.key}:{i}",
        )
        self.after_edit()

    def pick_color(self) -> None:
        if self.ctx is None or self.selected_index is None:
            return
        i = self.selected_index
        r, g, b, a = self.ctx.doc.palette[i]
        color = QColorDialog_get(QColor(r, g, b, a), self)
        if not color.isValid():
            return
        rgba = (color.red(), color.green(), color.blue(), color.alpha())
        new_doc = self.ctx.doc.clone()
        new_doc.set_color(i, rgba)
        self.ctx.history.commit(f"取色器修改 #{i} → {rgba_hex(rgba)}", new_doc)
        self.after_edit()

    def inspect_pixel(self, x: int, y: int) -> None:
        if self.ctx is None:
            return
        base, cur = self.ctx.base, self.ctx.doc

        def describe(doc: IndexedImage) -> str:
            idx = doc.index_at(x, y)
            if idx < len(doc.palette):
                r, g, b, a = doc.palette[idx]
                # 透明色的方块本身不可见, 用边框把“透明槽位”标出来
                chip = (
                    f"<span style='color:rgba({r},{g},{b},{a / 255:.2f});"
                    f" font-size:15px; border:1px solid #999; padding:0 1px;'>■</span>"
                )
                return f"#{idx} {chip} rgba({r},{g},{b},{a}) {rgba_hex((r, g, b, a))}"
            return (f"#{idx} <span style='color:#f0f'>■</span> "
                    f"<b style='color:#c00'>色表缺失该号</b>")

        self.readout.setText(
            f"位置 (x={x}, y={y})　　"
            f"原图/起点索引 → {describe(base)}　　|　　"
            f"现图索引 → {describe(cur)}"
        )

        cur_idx = cur.index_at(x, y)
        if cur_idx < len(cur.palette):
            self.selected_index = cur_idx
            self.table.setCurrentCell(cur_idx, 0)  # 触发选择刷新
        else:
            self.log(f"[诊断] 点击的 ({x},{y}) 引用缺失色号 #{cur_idx}")

    def on_hover_pixel(self, xy) -> None:
        if xy is None or self.ctx is None:
            self.statusBar().showMessage("")
            return
        x, y = xy
        bi = self.ctx.base.index_at(x, y)
        ci = self.ctx.doc.index_at(x, y)
        self.statusBar().showMessage(f"x={x}, y={y}    原图索引 #{bi}    现图索引 #{ci}")

    # =====================================================================
    # 结构操作
    # =====================================================================
    def _require_selection(self) -> Optional[int]:
        if self.ctx is None:
            return None
        i = self.selected_index
        if i is None or not (0 <= i < len(self.ctx.doc.palette)):
            QMessageBox.information(self, "先选一个色号", "请先在右侧色表里点选一个色号。")
            return None
        return i

    def swap_appearance_dialog(self) -> None:
        if self.ctx is None:
            return
        i = self._require_selection()
        if i is None:
            return
        dlg = TwoIndexDialog(
            self.ctx.doc.palette, i,
            "交换两格的外观（编号不动）",
            "只交换色表里这两格的 RGBA，所有像素保存的色号不变。\n"
            "结果：引用 A 号的区域改成 B 的旧颜色，两块区域交换外观。",
            self,
        )
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        a, b = dlg.indexes()
        if a == b:
            return
        new_doc = self.ctx.doc.clone()
        new_doc.swap_appearance(a, b)
        self.ctx.history.commit(f"交换外观 #{a} ↔ #{b}（编号不动）", new_doc)
        self.selected_index = a
        self.after_edit()

    def swap_numbers_dialog(self) -> None:
        if self.ctx is None:
            return
        i = self._require_selection()
        if i is None:
            return
        dlg = TwoIndexDialog(
            self.ctx.doc.palette, i,
            "交换两个编号（保外观重排）",
            "色表两格换位，同时把像素里的 A/B 编号也互换，"
            "因此画面看起来完全不变，只是颜色对应的编号变了。",
            self,
        )
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        a, b = dlg.indexes()
        if a == b:
            return
        n = len(self.ctx.doc.palette)
        new_doc = self.ctx.doc.clone()
        new_doc.apply_order(swapped_number_order(n, a, b))
        self.ctx.history.commit(f"重编号：交换编号 #{a} ↔ #{b}（保外观）", new_doc)
        self.selected_index = a
        self.after_edit()
        self.log(f"[重编号] 交换编号 {a}↔{b}，画面保持一致，像素索引已同步重映射。")

    def move_selected(self, delta: int) -> None:
        if self.ctx is None:
            return
        i = self._require_selection()
        if i is None:
            return
        j = i + delta
        n = len(self.ctx.doc.palette)
        if not (0 <= j < n):
            self.statusBar().showMessage("已经到色表边界", 2000)
            return
        new_doc = self.ctx.doc.clone()
        new_doc.move_slot(i, j)
        self.ctx.history.commit(f"重编号：#{i} 移动到 #{j}（保外观）", new_doc)
        self.selected_index = j
        self.after_edit()

    def move_selected_to_dialog(self) -> None:
        if self.ctx is None:
            return
        i = self._require_selection()
        if i is None:
            return
        n = len(self.ctx.doc.palette)
        from PySide6.QtWidgets import QInputDialog

        j, ok = QInputDialog.getInt(
            self, "移动到编号", f"把 #{i} 槽位移动到第几个编号？(0..{n - 1})",
            value=i, minValue=0, maxValue=n - 1,
        )
        if not ok or j == i:
            return
        new_doc = self.ctx.doc.clone()
        new_doc.move_slot(i, j)
        self.ctx.history.commit(f"重编号：#{i} 移动到 #{j}（保外观）", new_doc)
        self.selected_index = j
        self.after_edit()

    # =====================================================================
    # 历史 / 上下文
    # =====================================================================
    def after_edit(self) -> None:
        self.refresh_palette_table()
        self.refresh_images()
        self.refresh_history()
        self.refresh_context_list()

    def undo(self) -> None:
        if self.ctx is None or not self.ctx.history.can_undo():
            return
        self.ctx.history.undo()
        self.selected_index = self._clamp_selection()
        self.refresh_all()

    def redo(self) -> None:
        if self.ctx is None or not self.ctx.history.can_redo():
            return
        self.ctx.history.redo()
        self.selected_index = self._clamp_selection()
        self.refresh_all()

    def _clamp_selection(self) -> int:
        doc = self._active_doc()
        if doc is None:
            return 0
        if self.selected_index is not None and 0 <= self.selected_index < len(doc.palette):
            return self.selected_index
        return self._first_used_index(doc)

    def on_history_row_changed(self, row: int) -> None:
        if self._building_history or self.ctx is None or row < 0:
            return
        if row == self.ctx.history.cursor:
            return
        self.ctx.history.goto(row)
        self.selected_index = self._clamp_selection()
        self.refresh_palette_table()
        self.refresh_images()
        self.refresh_history()
        self.act_undo.setEnabled(self.ctx.history.can_undo())
        self.act_redo.setEnabled(self.ctx.history.can_redo())

    def on_context_row_changed(self, row: int) -> None:
        if self._building_contexts:
            return
        if self.master is None:
            return
        if row == 0:
            self.ctx = self.master
        elif 1 <= row <= len(self.versions):
            self.ctx = self.versions[row - 1]
        else:
            return
        self.selected_index = self._first_used_index(self.ctx.doc)
        self.readout.setText(self._readout_placeholder)
        self.refresh_palette_table()
        self.refresh_images()
        self.refresh_history()

    # =====================================================================
    # 版本 / 导出 / 回读
    # =====================================================================
    def create_ab_versions(self) -> None:
        if self.master is None:
            return
        if self.versions and any(len(v.history.steps) > 1 for v in self.versions):
            ret = QMessageBox.question(
                self, "重新创建 A/B？", "已有的 A/B 版本编辑会被覆盖，确定吗？"
            )
            if ret != QMessageBox.StandardButton.Yes:
                return
        # 关键: 两个版本都从 master 的“同一个当前编号图”快照出发
        start = self.master.doc
        self.versions = [
            EditContext("A", "换色版本 A", start, "从同一当前编号图创建"),
            EditContext("B", "换色版本 B", start, "从同一当前编号图创建"),
        ]
        self.ctx = self.versions[0]
        self.selected_index = self._first_used_index(self.ctx.doc)
        self.last_export_records = []
        self.readout.setText(self._readout_placeholder)
        self.refresh_all()
        self.log("[版本] 已从同一个当前编号图创建 A / B；在上方上下文列表切换后分别换色。")
        QMessageBox.information(
            self, "已创建 A / B",
            "两个版本拥有完全相同的起点（编号与色表一致）。\n\n"
            "在右上角“编辑上下文”列表里切换到版本 A 或 B，\n"
            "用色表和取色器分别做换色，然后点“批量导出全部版本”。",
        )

    def _output_stem(self) -> str:
        if self.master and self.master.base.source_path:
            return Path(self.master.base.source_path).stem
        return "indexed"

    def export_versions(self) -> None:
        if not self.versions:
            QMessageBox.information(
                self, "还没有版本",
                "请先点“从当前编号图创建 A / B 两个版本”，分别换色后再批量导出。",
            )
            return
        out_dir = QFileDialog.getExistingDirectory(
            self, "选择批量输出目录", str(_ensure_output_dir())
        )
        if not out_dir:
            return
        depth_pref = self.combo_depth.currentData()
        stem = self._output_stem()
        records: list[tuple[str, Path, list[CheckResult]]] = []
        for ctx in self.versions:
            target = Path(out_dir) / f"{stem}__version_{ctx.key}.png"
            try:
                written, depth, notes = write_indexed_png(ctx.doc, target, depth_pref)
                prepared, prep_notes = prepare_for_export(ctx.doc)
                checks = verify_output(written, prepared)
                self.expected_snapshots[str(written)] = prepared
                records.append((f"版本 {ctx.key}（{depth} 位）", written, checks))
                for note in notes + prep_notes:
                    self.log(f"[导出 {ctx.key}] {note}")
                self.log(f"[导出] {written} ({depth} 位)")
            except Exception as exc:  # noqa: BLE001
                QMessageBox.critical(self, f"版本 {ctx.key} 导出失败", repr(exc))
                self.log(f"[导出失败 {ctx.key}] {exc!r}")
                return
        self.last_export_records = records
        self._show_report(records)

    def export_current(self) -> None:
        if self.ctx is None:
            return
        default_name = f"{self._output_stem()}__{self.ctx.key}.png"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出索引色 PNG",
            str(_ensure_output_dir() / default_name), "PNG (*.png)",
        )
        if not path:
            return
        try:
            written, depth, _ = write_indexed_png(self.ctx.doc, path, self.combo_depth.currentData())
            prepared, _ = prepare_for_export(self.ctx.doc)
            checks = verify_output(written, prepared)
            self.expected_snapshots[str(written)] = prepared
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", repr(exc))
            return
        record = [(f"当前上下文 {self.ctx.key}（{depth} 位）", written, checks)]
        self.last_export_records = record
        self.log(f"[导出] {written} ({depth} 位)")
        self._show_report(record)

    def reread_last(self) -> None:
        if not self.last_export_records:
            QMessageBox.information(self, "还没有导出记录", "请先导出一次，再用本按钮从磁盘重新读回核对。")
            return
        fresh: list[tuple[str, Path, list[CheckResult]]] = []
        for title, path, _old in self.last_export_records:
            # 以导出时保存的预期快照为准重新核对磁盘上的字节
            expected = self.expected_snapshots.get(str(path))
            if expected is None:
                # 退化为结构核对: 重新载入后与自身 PLTE 核对
                try:
                    doc = load_indexed_png(path)
                    checks = verify_output(path, doc)
                except Exception as exc:  # noqa: BLE001
                    checks = [CheckResult("重新读取", False, repr(exc))]
            else:
                checks = verify_output(path, expected)
            fresh.append((title + " · 重新读回", path, checks))
        self._show_report(fresh)

    def _show_report(self, records) -> None:
        dlg = ReportDialog(records, self)
        dlg.exec()


# QColorDialog 单独包一层方便打桩/阅读
def QColorDialog_get(initial: QColor, parent) -> QColor:
    from PySide6.QtWidgets import QColorDialog

    return QColorDialog.getColor(
        initial,
        parent,
        "修改颜色与透明度",
        QColorDialog.ColorDialogOption.ShowAlphaChannel
        | QColorDialog.ColorDialogOption.DontUseNativeDialog,
    )
