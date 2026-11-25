"""照片马赛克工坊主窗口。

所有“不弹文件框”的核心动作都拆成了可直接调用的方法
（load_assets / recompute / select_cell / fix_cell_to_tile / export_to …），
offscreen 冒烟测试因此可以完整驱动界面逻辑。
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, QTimer, QUrl, QSize
from PySide6.QtGui import QAction, QDesktopServices, QIcon
from PySide6.QtWidgets import (
    QComboBox, QFileDialog, QFormLayout, QFrame, QGroupBox, QHBoxLayout,
    QInputDialog, QLabel, QListWidget, QListWidgetItem, QMainWindow,
    QMessageBox, QPushButton, QScrollArea, QSpinBox, QSplitter, QStackedWidget,
    QSlider, QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget,
    QHeaderView, QAbstractItemView, QApplication,
)

from .. import __version__, generator, projectio, render, report
from ..config import UNLIMITED
from ..gui.preview_view import MosaicGraphicsView
from ..gui.qt_utils import pil_to_qicon, pil_to_qpixmap
from ..session import MosaicSession

REPO_ROOT = Path(__file__).resolve().parents[2]


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"照片马赛克工坊 v{__version__}")
        self.resize(1480, 940)

        self.session = MosaicSession()
        self.selected_cell: int | None = None
        self._icon_cache: dict[str, QIcon] = {}
        self._busy = False
        self._tile_highlight: str | None = None

        self._build_actions()
        self._build_ui()
        self._build_menus()

        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.recompute)

        self._set_controls_from_params()
        self._show_placeholder("还没有素材\n\n"
                               "点左侧「一键载入内置示例」快速开始，\n"
                               "或分别读取底图、选择样块文件夹。")

    # ===================================================================
    # UI 搭建
    # ===================================================================
    def _build_actions(self) -> None:
        self.act_open_base = QAction("打开底图…", self)
        self.act_open_tiles = QAction("选择样块文件夹…", self)
        self.act_bundled = QAction("一键载入内置示例", self)
        self.act_generate = QAction("生成程序样块…", self)
        self.act_qc = QAction("打开配额冲突例子", self)
        self.act_export = QAction("导出成品与记录…", self)
        self.act_save_plan = QAction("保存方案…", self)
        self.act_load_plan = QAction("读取方案…", self)
        self.act_about = QAction("使用说明", self)

        self.act_open_base.triggered.connect(self.choose_base)
        self.act_open_tiles.triggered.connect(self.choose_tile_folder)
        self.act_bundled.triggered.connect(self.load_bundled_demo)
        self.act_generate.triggered.connect(self.generate_samples_dialog)
        self.act_qc.triggered.connect(self.load_quota_conflict_example)
        self.act_export.triggered.connect(self.export_dialog)
        self.act_save_plan.triggered.connect(self.save_plan_dialog)
        self.act_load_plan.triggered.connect(self.load_plan_dialog)
        self.act_about.triggered.connect(self.show_about)

    def _build_menus(self) -> None:
        m_file = self.menuBar().addMenu("文件")
        m_file.addAction(self.act_open_base)
        m_file.addAction(self.act_open_tiles)
        m_file.addSeparator()
        m_file.addAction(self.act_export)
        m_file.addAction(self.act_save_plan)
        m_file.addAction(self.act_load_plan)
        m_file.addSeparator()
        m_file.addAction("退出", self.close)

        m_sample = self.menuBar().addMenu("示例")
        m_sample.addAction(self.act_bundled)
        m_sample.addAction(self.act_generate)
        m_sample.addAction(self.act_qc)

        m_help = self.menuBar().addMenu("帮助")
        m_help.addAction(self.act_about)

    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal)

        splitter.addWidget(self._build_left_panel())
        splitter.addWidget(self._build_center())
        splitter.addWidget(self._build_right_panel())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 0)
        splitter.setSizes([300, 820, 360])
        self.setCentralWidget(splitter)
        self.statusBar().showMessage("就绪")

    def _build_left_panel(self) -> QWidget:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(308)
        scroll.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        host = QWidget()
        v = QVBoxLayout(host)
        v.setContentsMargins(10, 10, 10, 10)
        v.setSpacing(10)

        # ---- 素材 ----
        box_src = QGroupBox("素材")
        f = QFormLayout(box_src)
        self.base_edit = QLabel("（未选择）")
        self.base_edit.setWordWrap(True)
        self.base_edit.setStyleSheet("color:#555;")
        btn_base = QPushButton("读取底图…")
        btn_base.clicked.connect(self.choose_base)
        self.tiles_edit = QLabel("（未选择）")
        self.tiles_edit.setWordWrap(True)
        self.tiles_edit.setStyleSheet("color:#555;")
        btn_tiles = QPushButton("选择样块文件夹…")
        btn_tiles.clicked.connect(self.choose_tile_folder)
        btn_demo = QPushButton("✨ 一键载入内置示例")
        btn_demo.setStyleSheet("font-weight:600;")
        btn_demo.clicked.connect(self.load_bundled_demo)
        btn_gen = QPushButton("程序生成样块到文件夹…")
        btn_gen.clicked.connect(self.generate_samples_dialog)
        f.addRow("底图", self.base_edit)
        f.addRow(btn_base)
        f.addRow("样块", self.tiles_edit)
        f.addRow(btn_tiles)
        f.addRow(btn_demo)
        f.addRow(btn_gen)
        v.addWidget(box_src)

        # ---- 格子与约束 ----
        box_par = QGroupBox("格子 / 配额 / 约束")
        pf = QFormLayout(box_par)

        cell_row = QWidget()
        ch = QHBoxLayout(cell_row)
        ch.setContentsMargins(0, 0, 0, 0)
        self.cell_slider = QSlider(Qt.Orientation.Horizontal)
        self.cell_slider.setRange(12, 240)
        self.cell_spin = QSpinBox()
        self.cell_spin.setRange(8, 400)
        self.cell_spin.setSuffix(" px")
        self.cell_spin.setFixedWidth(86)
        ch.addWidget(self.cell_slider)
        ch.addWidget(self.cell_spin)
        pf.addRow("格子大小", cell_row)
        self.grid_info = QLabel("尚未划分格子")
        self.grid_info.setStyleSheet("color:#666;")
        pf.addRow(self.grid_info)

        self.quota_spin = QSpinBox()
        self.quota_spin.setRange(0, 99999)
        self.quota_spin.setSpecialValueText("自动")
        self.quota_spin.setToolTip("每块样块全图最多使用次数；0 = 按格子和样块数自动")
        pf.addRow("每块最多用", self.quota_spin)

        self.radius_spin = QSpinBox()
        self.radius_spin.setRange(0, 3)
        self.radius_spin.setToolTip("同一样块在多大邻域内不能重复：1=八邻域，0=不限制")
        pf.addRow("相邻限制半径", self.radius_spin)

        tex_row = QWidget()
        th = QHBoxLayout(tex_row)
        th.setContentsMargins(0, 0, 0, 0)
        self.tex_slider = QSlider(Qt.Orientation.Horizontal)
        self.tex_slider.setRange(0, 60)
        self.tex_value = QLabel("30%")
        self.tex_value.setFixedWidth(42)
        th.addWidget(self.tex_slider)
        th.addWidget(self.tex_value)
        pf.addRow("纹理权重", tex_row)

        seed_row = QWidget()
        sh = QHBoxLayout(seed_row)
        sh.setContentsMargins(0, 0, 0, 0)
        self.seed_spin = QSpinBox()
        self.seed_spin.setRange(0, 2_000_000_000)
        btn_dice = QPushButton("换一个")
        btn_dice.setFixedWidth(72)
        btn_dice.clicked.connect(self.randomize_seed)
        sh.addWidget(self.seed_spin)
        sh.addWidget(btn_dice)
        pf.addRow("随机种子", seed_row)

        self.btn_recompute = QPushButton("🔄 重新计算排版")
        self.btn_recompute.setStyleSheet(
            "QPushButton{background:#2d6cdf;color:white;padding:8px;"
            "border-radius:6px;font-weight:600;}"
            "QPushButton:disabled{background:#9bb6e6;}")
        self.btn_recompute.clicked.connect(self.recompute)
        pf.addRow(self.btn_recompute)
        v.addWidget(box_par)

        # ---- 导出 / 方案 ----
        box_out = QGroupBox("导出 / 方案")
        of = QVBoxLayout(box_out)
        btn_export = QPushButton("🖼 导出成品与格子使用记录…")
        btn_export.clicked.connect(self.export_dialog)
        btn_save = QPushButton("保存方案（含固定格/种子）…")
        btn_save.clicked.connect(self.save_plan_dialog)
        btn_load = QPushButton("读取方案…")
        btn_load.clicked.connect(self.load_plan_dialog)
        btn_qc = QPushButton("⚠ 打开配额冲突例子")
        btn_qc.clicked.connect(self.load_quota_conflict_example)
        of.addWidget(btn_export)
        of.addWidget(btn_save)
        of.addWidget(btn_load)
        of.addWidget(btn_qc)
        v.addWidget(box_out)
        v.addStretch(1)

        scroll.setWidget(host)

        # 控件变化 -> 防抖重算
        self.cell_slider.valueChanged.connect(self.cell_spin.setValue)
        self.cell_spin.valueChanged.connect(self._on_cell_control)
        self.quota_spin.valueChanged.connect(self.schedule_recompute)
        self.radius_spin.valueChanged.connect(self.schedule_recompute)
        self.seed_spin.valueChanged.connect(self.schedule_recompute)
        self.tex_slider.valueChanged.connect(self._on_texture_slider)
        return scroll

    def _build_center(self) -> QWidget:
        wrap = QWidget()
        v = QVBoxLayout(wrap)
        v.setContentsMargins(6, 6, 6, 6)
        v.setSpacing(6)

        bar = QHBoxLayout()
        bar.addWidget(QLabel("预览:"))
        self.view_combo = QComboBox()
        self.view_combo.addItem("成品马赛克", "final")
        self.view_combo.addItem("相似度热力（绿=像 红=差）", "similarity")
        self.view_combo.addItem("按样块来源着色/定位", "source")
        self.view_combo.currentIndexChanged.connect(self.refresh_preview)
        bar.addWidget(self.view_combo)

        bar.addWidget(QLabel("来源:"))
        self.source_combo = QComboBox()
        self.source_combo.setMinimumWidth(150)
        self.source_combo.currentIndexChanged.connect(self._on_source_combo)
        bar.addWidget(self.source_combo)

        self.tile_locate_label = QLabel("")
        self.tile_locate_label.setStyleSheet("color:#b26a00;font-weight:600;")
        bar.addWidget(self.tile_locate_label)
        self.btn_clear_locate = QPushButton("清除定位")
        self.btn_clear_locate.setVisible(False)
        self.btn_clear_locate.clicked.connect(self.clear_highlight)
        bar.addWidget(self.btn_clear_locate)

        bar.addSpacing(12)
        bar.addWidget(QLabel("圈出最差"))
        self.worst_spin = QSpinBox()
        self.worst_spin.setRange(0, 500)
        self.worst_spin.setValue(12)
        self.worst_spin.setSuffix(" 格")
        self.worst_spin.valueChanged.connect(self.refresh_preview)
        bar.addWidget(self.worst_spin)
        bar.addStretch(1)

        btn_out = QPushButton("－")
        btn_out.setFixedWidth(34)
        btn_out.clicked.connect(lambda: self.preview.zoom_by(1 / 1.2))
        btn_fit = QPushButton("适应窗口")
        btn_fit.clicked.connect(lambda: self.preview.reset_zoom())
        btn_in = QPushButton("＋")
        btn_in.setFixedWidth(34)
        btn_in.clicked.connect(lambda: self.preview.zoom_by(1.2))
        bar.addWidget(btn_out)
        bar.addWidget(btn_fit)
        bar.addWidget(btn_in)
        v.addLayout(bar)

        self.stack = QStackedWidget()
        self.placeholder = QLabel()
        self.placeholder.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.placeholder.setStyleSheet(
            "background:#2b2d33;color:#cfd3dc;font-size:20px;"
            "border-radius:10px;")
        self.preview = MosaicGraphicsView()
        self.preview.cell_clicked.connect(self.on_preview_cell_clicked)
        self.stack.addWidget(self.placeholder)
        self.stack.addWidget(self.preview)
        v.addWidget(self.stack, 1)

        hint = QLabel("操作：单击格子检查/固定样块；按住拖动平移；滚轮缩放。"
                       "蓝色框=已固定，红斜纹=未匹配。")
        hint.setStyleSheet("color:#777;")
        v.addWidget(hint)
        return wrap

    def _build_right_panel(self) -> QWidget:
        self.tabs = QTabWidget()
        self.tabs.setFixedWidth(372)

        # ---- 格子检查 ----
        tab_cell = QWidget()
        cv = QVBoxLayout(tab_cell)
        self.cell_info = QLabel("尚未选中格子。\n在中间预览里单击一个格子。")
        self.cell_info.setWordWrap(True)
        self.cell_info.setStyleSheet("padding:6px;background:#f4f6fa;"
                                     "border-radius:6px;")
        cv.addWidget(self.cell_info)

        self.current_tile_label = QLabel()
        self.current_tile_label.setFixedHeight(84)
        self.current_tile_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        cv.addWidget(self.current_tile_label)

        cv.addWidget(QLabel("候选样块（按相似度排序，双击即固定）："))
        self.candidate_list = QListWidget()
        self.candidate_list.setIconSize(QSize(54, 54))
        self.candidate_list.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.candidate_list.setWordWrap(False)
        self.candidate_list.setTextElideMode(Qt.TextElideMode.ElideRight)
        self.candidate_list.itemDoubleClicked.connect(
            lambda _it: self.fix_selected_candidate())
        cv.addWidget(self.candidate_list, 1)

        row = QHBoxLayout()
        btn_fix = QPushButton("固定为选中候选")
        btn_fix.setStyleSheet("font-weight:600;")
        btn_fix.clicked.connect(self.fix_selected_candidate)
        btn_unfix = QPushButton("取消固定/恢复自动")
        btn_unfix.clicked.connect(self.unfix_selected_cell)
        row.addWidget(btn_fix)
        row.addWidget(btn_unfix)
        cv.addLayout(row)
        self.tabs.addTab(tab_cell, "格子检查")

        # ---- 问题定位 ----
        tab_issue = QWidget()
        iv = QVBoxLayout(tab_issue)
        self.issue_summary = QLabel("计算后这里给出配额缺口与冲突摘要。")
        self.issue_summary.setWordWrap(True)
        self.issue_summary.setStyleSheet("padding:6px;")
        iv.addWidget(self.issue_summary)

        fh = QHBoxLayout()
        fh.addWidget(QLabel("范围:"))
        self.issue_filter = QComboBox()
        self.issue_filter.addItem("未匹配 + 最差若干", "all")
        self.issue_filter.addItem("仅未匹配格", "unmatched")
        self.issue_filter.addItem("仅相似度最差", "worst")
        self.issue_filter.currentIndexChanged.connect(self.refresh_issues)
        fh.addWidget(self.issue_filter, 1)
        self.issue_worst_spin = QSpinBox()
        self.issue_worst_spin.setRange(1, 300)
        self.issue_worst_spin.setValue(24)
        self.issue_worst_spin.valueChanged.connect(self.refresh_issues)
        fh.addWidget(self.issue_worst_spin)
        iv.addLayout(fh)

        self.issue_list = QListWidget()
        self.issue_list.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.issue_list.setWordWrap(True)
        self.issue_list.itemClicked.connect(self._on_issue_clicked)
        self.issue_list.itemDoubleClicked.connect(
            lambda it: self.select_cell(
                int(it.data(Qt.ItemDataRole.UserRole)), True))
        iv.addWidget(self.issue_list, 1)
        prev_next = QHBoxLayout()
        btn_prev = QPushButton("上一个问题格")
        btn_prev.clicked.connect(lambda: self.jump_issue(-1))
        btn_next = QPushButton("下一个问题格")
        btn_next.clicked.connect(lambda: self.jump_issue(1))
        btn_conflicts = QPushButton("查看冲突说明")
        btn_conflicts.clicked.connect(self.show_conflict_details)
        prev_next.addWidget(btn_prev)
        prev_next.addWidget(btn_next)
        prev_next.addWidget(btn_conflicts)
        iv.addLayout(prev_next)
        self.tabs.addTab(tab_issue, "问题定位")

        # ---- 配额用量 ----
        tab_q = QWidget()
        qv = QVBoxLayout(tab_q)
        self.quota_table = QTableWidget(0, 6)
        self.quota_table.setHorizontalHeaderLabels(
            ["样块", "来源", "配额", "已用", "固定", "剩余"])
        self.quota_table.setSelectionBehavior(
            QAbstractItemView.SelectionBehavior.SelectRows)
        self.quota_table.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection)
        self.quota_table.setEditTriggers(
            QAbstractItemView.EditTrigger.NoEditTriggers)
        hdr = self.quota_table.horizontalHeader()
        hdr.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        hdr.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        for col in range(2, 6):
            hdr.setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)
        self.quota_table.itemSelectionChanged.connect(self._on_quota_row_selected)
        self.quota_table.cellDoubleClicked.connect(
            lambda _r, _c: self.locate_selected_tile())
        qv.addWidget(self.quota_table, 1)

        qrow = QHBoxLayout()
        qrow.addWidget(QLabel("选中样块配额"))
        self.tile_quota_spin = QSpinBox()
        self.tile_quota_spin.setRange(-1, 999999)
        self.tile_quota_spin.setSpecialValueText("不限")
        qrow.addWidget(self.tile_quota_spin)
        btn_apply_q = QPushButton("应用")
        btn_apply_q.clicked.connect(self.apply_tile_quota)
        qrow.addWidget(btn_apply_q)
        qv.addLayout(qrow)

        qrow2 = QHBoxLayout()
        btn_reset_q = QPushButton("恢复该样块默认")
        btn_reset_q.clicked.connect(self.reset_tile_quota)
        btn_reset_all = QPushButton("全部恢复默认")
        btn_reset_all.clicked.connect(self.reset_all_quotas)
        btn_locate_tile = QPushButton("在预览中定位该样块")
        btn_locate_tile.setStyleSheet("font-weight:600;")
        btn_locate_tile.clicked.connect(self.locate_selected_tile)
        qrow2.addWidget(btn_reset_q)
        qrow2.addWidget(btn_reset_all)
        qv.addLayout(qrow2)
        qv.addWidget(btn_locate_tile)
        qv.addWidget(QLabel("提示：双击表格行也可以在预览中定位该样块的所有用处。"))
        self.tabs.addTab(tab_q, "配额用量")

        return self.tabs

    # ===================================================================
    # 控件 <-> 参数
    # ===================================================================
    def _set_controls_from_params(self) -> None:
        p = self.session.params
        for w in (self.cell_slider, self.cell_spin, self.quota_spin,
                  self.radius_spin, self.seed_spin, self.tex_slider):
            w.blockSignals(True)
        self.cell_slider.setValue(p.cell_size)
        self.cell_spin.setValue(p.cell_size)
        self.quota_spin.setValue(p.max_uses)
        self.radius_spin.setValue(p.adjacency_radius)
        self.seed_spin.setValue(p.seed)
        tex_pct = int(round(p.texture_weight * 100))
        self.tex_slider.setValue(tex_pct)
        self.tex_value.setText(f"{tex_pct}%")
        for w in (self.cell_slider, self.cell_spin, self.quota_spin,
                  self.radius_spin, self.seed_spin, self.tex_slider):
            w.blockSignals(False)

    def _on_cell_control(self, value: int) -> None:
        self.cell_slider.blockSignals(True)
        self.cell_slider.setValue(value)
        self.cell_slider.blockSignals(False)
        self.schedule_recompute()

    def _on_texture_slider(self, value: int) -> None:
        self.tex_value.setText(f"{value}%")
        self.schedule_recompute()

    def randomize_seed(self) -> None:
        import random
        self.seed_spin.setValue(random.randrange(1, 2_000_000_000))

    def schedule_recompute(self, *_args) -> None:
        if self._busy:
            return
        self._timer.start(280)

    def _read_controls_into_session(self) -> None:
        p = self.session.params
        new_cell = int(self.cell_spin.value())
        if self.session.grid is not None and new_cell != p.cell_size:
            self.session.regrid(new_cell)
        else:
            p.cell_size = new_cell
        p.max_uses = int(self.quota_spin.value())
        p.adjacency_radius = int(self.radius_spin.value())
        p.seed = int(self.seed_spin.value())
        self.session.set_texture_weight(self.tex_slider.value() / 100.0)

    # ===================================================================
    # 素材动作（含可直接测试的无对话框入口）
    # ===================================================================
    def choose_base(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择底图", str(REPO_ROOT),
            "图片 (*.png *.jpg *.jpeg *.bmp *.webp *.tif *.tiff)")
        if path:
            try:
                self.load_base_path(path)
            except Exception as exc:
                QMessageBox.critical(self, "读取底图失败", str(exc))

    def choose_tile_folder(self) -> None:
        path = QFileDialog.getExistingDirectory(
            self, "选择样块文件夹（会递归读取子目录）", str(REPO_ROOT))
        if path:
            try:
                self.load_tile_folder_path(path)
            except Exception as exc:
                QMessageBox.critical(self, "读取样块失败", str(exc))

    def load_base_path(self, path: str | Path) -> None:
        self.session.load_base(path)
        self.base_edit.setText(str(path))
        self.base_edit.setStyleSheet("color:#1a5fb4;")
        self._after_assets_changed()

    def load_tile_folder_path(self, path: str | Path) -> None:
        tiles = self.session.load_tile_folder(path)
        self.tiles_edit.setText(f"{path}\n（{len(tiles)} 块，含子目录来源分组）")
        self.tiles_edit.setStyleSheet("color:#1a7f37;")
        self._icon_cache.clear()
        self._reload_source_combo()
        self._after_assets_changed()

    def load_assets(self, base_path: str | Path, tile_dir: str | Path,
                    solve: bool = True) -> None:
        """测试 / 脚本用：一次载入底图与样块目录。"""
        self.session.load_base(base_path)
        self.base_edit.setText(str(base_path))
        self.session.load_tile_folder(tile_dir)
        self.tiles_edit.setText(f"{tile_dir}（{len(self.session.tiles)} 块）")
        self._icon_cache.clear()
        self._reload_source_combo()
        if solve:
            self.recompute()

    def load_bundled_demo(self) -> None:
        try:
            paths = generator.ensure_bundled_assets(REPO_ROOT)
        except Exception as exc:
            QMessageBox.critical(self, "生成内置素材失败", str(exc))
            return
        self.session.params.cell_size = 40
        self.session.params.seed = 20261126
        self._set_controls_from_params()
        self.load_assets(paths["base"], paths["tiles"])
        self.statusBar().showMessage(
            "已载入内置示例：60 块程序样块（含 9 块同色异纹对照）与海报底图", 6000)

    def load_quota_conflict_example(self) -> None:
        res = self.open_quota_conflict()
        if res is None:
            return
        QMessageBox.information(
            self, "配额冲突例子",
            f"{res.cell_count} 个格子，但 5 块样块每块最多 2 次，"
            f"总容量只有 10；再叠加八邻域限制。\n\n"
            f"实际匹配 {res.assigned_count} 格、"
            f"{res.unmatched_count} 格未匹配。\n"
            f"左侧「问题定位」已逐格列出原因，点击任意一条可在预览中定位。\n"
            f"第 1 行第 1 列是预置固定格，配额已把它计入。")

    def open_quota_conflict(self):
        """载入并计算配额冲突例子，但不弹说明框（测试/脚本用）。"""
        try:
            paths = generator.ensure_bundled_assets(REPO_ROOT)
            scenario = paths["quota_conflict"] / "scenario.json"
            projectio.apply_project(self.session, scenario, solve=True)
        except Exception as exc:
            QMessageBox.critical(self, "打开配额冲突例子失败", str(exc))
            return None
        self.base_edit.setText(self.session.base_path or "")
        self.tiles_edit.setText(
            f"{self.session.tile_folder}（{len(self.session.tiles)} 块）")
        self._icon_cache.clear()
        self._set_controls_from_params()
        self._reload_source_combo()
        self.selected_cell = None
        self.refresh_all()
        self.tabs.setCurrentIndex(1)
        return self.session.result

    def generate_samples_dialog(self) -> None:
        default_dir = str(REPO_ROOT / "sample_assets" / "generated")
        directory = QFileDialog.getExistingDirectory(
            self, "选择程序样块的生成目录（建议新建空文件夹）", default_dir)
        if not directory:
            return
        count, ok = QInputDialog.getInt(
            self, "生成样块数量", "生成多少块样块？（始终包含 9 块同色异纹对照）",
            60, 9, 200, 1)
        if not ok:
            return
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            paths = generator.generate_tiles(directory, count=count)
        except Exception as exc:
            QApplication.restoreOverrideCursor()
            QMessageBox.critical(self, "生成样块失败", str(exc))
            return
        QApplication.restoreOverrideCursor()
        ret = QMessageBox.question(
            self, "生成完成",
            f"已在\n{directory}\n生成 {len(paths)} 块样块。是否立即作为样块文件夹载入？")
        if ret == QMessageBox.StandardButton.Yes:
            self.load_tile_folder_path(directory)

    def _after_assets_changed(self) -> None:
        ok, msg = self.session.can_solve()
        if ok:
            self.recompute()
        else:
            self._show_placeholder(msg)

    # ===================================================================
    # 计算与刷新
    # ===================================================================
    def recompute(self) -> None:
        if self._busy:
            return
        self._timer.stop()
        self._read_controls_into_session()
        ok, msg = self.session.can_solve()
        if not ok:
            self._show_placeholder(msg)
            self.statusBar().showMessage(msg)
            return
        self._busy = True
        self.btn_recompute.setEnabled(False)
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        QApplication.processEvents()
        try:
            res = self.session.solve()
        except Exception as exc:
            QApplication.restoreOverrideCursor()
            self._busy = False
            self.btn_recompute.setEnabled(True)
            QMessageBox.critical(self, "计算失败", str(exc))
            return
        QApplication.restoreOverrideCursor()
        self._busy = False
        self.btn_recompute.setEnabled(True)
        self.refresh_all()
        self.statusBar().showMessage(
            f"计算完成：{res.assigned_count}/{res.cell_count} 格已匹配，"
            f"{res.unmatched_count} 格未匹配，用时 {res.elapsed_ms} ms，"
            f"种子 {res.seed}", 8000)

    def refresh_all(self) -> None:
        if self.session.grid is not None:
            self.grid_info.setText(
                f"{self.session.grid.cols} 列 × {self.session.grid.rows} 行"
                f" = {self.session.grid.count} 格")
        self.refresh_preview()
        self.refresh_inspector()
        self.refresh_issues()
        self.refresh_quota_table()

    def _show_placeholder(self, text: str) -> None:
        self.placeholder.setText(text)
        self.stack.setCurrentIndex(0)

    def _reload_source_combo(self) -> None:
        # 换素材后旧的“单块定位”可能已不存在，必须清掉，否则会把整图压暗。
        self._tile_highlight = None
        if hasattr(self, "tile_locate_label"):
            self.tile_locate_label.setText("")
            self.btn_clear_locate.setVisible(False)
        self.source_combo.blockSignals(True)
        self.source_combo.clear()
        self.source_combo.addItem("全部来源着色", None)
        groups = sorted({t.source_group for t in self.session.tiles})
        for g in groups:
            self.source_combo.addItem(f"仅高亮：{g}", g)
        self.source_combo.blockSignals(False)

    # ---- 预览 ----
    def _current_worst_set(self) -> set[int]:
        if self.session.result is None:
            return set()
        n = int(self.worst_spin.value())
        matched = [o for o in self.session.result.outcomes if o.cost is not None]
        matched.sort(key=lambda o: -o.cost)  # type: ignore[operator]
        return {o.cell for o in matched[:n]}

    def refresh_preview(self) -> None:
        if self.session.result is None:
            return
        mode = self.view_combo.currentData() or "final"
        src = self.source_combo.currentData()
        tile_hl = self._tile_highlight
        if tile_hl and tile_hl not in self.session.tile_by_id:
            tile_hl = None
        opts = render.RenderOptions(
            mode=mode,
            highlight_source=src if isinstance(src, str) else None,
            highlight_tile=tile_hl,
            worst_cells=self._current_worst_set() if mode == "similarity" else set(),
        )
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            img, cell_px = render.render_mosaic(self.session, opts)
            pix = pil_to_qpixmap(img)
        finally:
            QApplication.restoreOverrideCursor()
        self.stack.setCurrentIndex(1)
        self.preview.set_pixmap(
            pix, self.session.grid.cols, self.session.grid.rows, cell_px)
        self.preview.set_selected(self.selected_cell)

    def _on_source_combo(self, _idx: int) -> None:
        # 手动选来源分组时清掉单块样块定位。
        self._tile_highlight = None
        self.tile_locate_label.setText("")
        self.btn_clear_locate.setVisible(False)
        if self.view_combo.currentData() != "source":
            self.view_combo.setCurrentIndex(2)
        else:
            self.refresh_preview()

    def clear_highlight(self) -> None:
        self._tile_highlight = None
        self.tile_locate_label.setText("")
        self.btn_clear_locate.setVisible(False)
        self.refresh_preview()

    def set_view_mode(self, mode: str) -> None:
        idx = self.view_combo.findData(mode)
        if idx >= 0:
            self.view_combo.setCurrentIndex(idx)

    # ---- 格子检查 ----
    def on_preview_cell_clicked(self, index: int, _button: int = 1) -> None:
        self.select_cell(index, focus_inspector=True)

    def select_cell(self, index: int | None, focus_inspector: bool = True) -> None:
        self.selected_cell = index
        self.preview.set_selected(index)
        self.refresh_inspector()
        if focus_inspector:
            self.tabs.setCurrentIndex(0)

    def _tile_icon(self, tile) -> QIcon:
        if tile.id not in self._icon_cache:
            self._icon_cache[tile.id] = pil_to_qicon(tile.thumb, 54)
        return self._icon_cache[tile.id]

    def refresh_inspector(self) -> None:
        idx = self.selected_cell
        self.candidate_list.clear()
        if idx is None or self.session.result is None:
            self.cell_info.setText("尚未选中格子。\n在中间预览里单击一个格子。")
            self.current_tile_label.clear()
            return
        o = self.session.result.outcomes[idx]
        g = self.session.grid
        r, c = divmod(idx, g.cols)
        if o.tile is not None:
            t = self.session.tiles[o.tile]
            status_cn = {"fixed": "🔵 手动固定", "matched": "自动匹配"}[o.status]
            sim = f"{(1 - o.cost) * 100:.1f}%" if o.cost is not None else "-"
            self.cell_info.setText(
                f"第 {r + 1} 行 第 {c + 1} 列（index={idx}）\n"
                f"状态：{status_cn}　相似度：{sim}\n"
                f"当前样块：{t.name}\n来源：{t.source_group}\n"
                f"实际裁切框（原图坐标）：{t.crop_box}")
            pix = pil_to_qpixmap(t.thumb.resize((84, 84)))
            self.current_tile_label.setPixmap(pix)
        else:
            self.cell_info.setText(
                f"第 {r + 1} 行 第 {c + 1} 列（index={idx}）\n"
                f"状态：🟥 未匹配\n原因：{o.reason}")
            self.current_tile_label.setText("（无样块）")

        # 候选列表：全部样块按相似度排序。
        quota = self.session.result.quota
        usage = self.session.result.usage
        fixed_id = self.session.fixed.get(idx)
        select_row = 0
        for row_i, cand in enumerate(self.session.candidates(idx)):
            t = cand.tile
            j = t.ordinal
            q = quota[j]
            remain = ("不限" if q == UNLIMITED else str(q - usage[j]))
            pinned = "📌 " if fixed_id == t.id else ""
            item = QListWidgetItem(
                self._tile_icon(t),
                f"{pinned}{t.name}\n"
                f"相似度 {cand.similarity * 100:5.1f}%　"
                f"剩余配额 {remain:>4}　来源 {t.source_group}"
            )
            item.setData(Qt.ItemDataRole.UserRole, t.id)
            item.setToolTip(
                f"{t.name}\n完整路径：{t.path}\n来源：{t.source_group}\n"
                f"实际裁切框：{t.crop_box}\n相似度："
                f"{cand.similarity * 100:.2f}%　距离：{cand.distance:.4f}\n"
                f"配额：{'不限' if q == UNLIMITED else q}，"
                f"已用 {usage[j]}")
            self.candidate_list.addItem(item)
            if fixed_id == t.id:
                select_row = row_i
        self.candidate_list.setCurrentRow(select_row)

    def _chosen_candidate_id(self) -> str | None:
        item = self.candidate_list.currentItem()
        return item.data(Qt.ItemDataRole.UserRole) if item else None

    def fix_selected_candidate(self) -> None:
        if self.selected_cell is None:
            QMessageBox.information(self, "提示", "请先在预览里点选一个格子。")
            return
        tile_id = self._chosen_candidate_id()
        if tile_id is None:
            return
        self.fix_cell_to_tile(self.selected_cell, tile_id)

    def fix_cell_to_tile(self, cell_index: int, tile_id: str) -> None:
        """固定某格为指定样块并重算（测试也走这里）。"""
        self.session.set_fixed(cell_index, tile_id)
        self.selected_cell = cell_index
        self.recompute()

    def unfix_selected_cell(self) -> None:
        if self.selected_cell is None:
            return
        self.session.set_fixed(self.selected_cell, None)
        self.recompute()

    # ---- 问题定位 ----
    def refresh_issues(self) -> None:
        self.issue_list.clear()
        res = self.session.result
        if res is None:
            self.issue_summary.setText("计算后这里给出配额缺口与冲突摘要。")
            return
        mode = self.issue_filter.currentData()
        worst_n = int(self.issue_worst_spin.value())

        unmatched = [o for o in res.outcomes if o.status == "unmatched"]
        matched = [o for o in res.outcomes if o.cost is not None]
        matched.sort(key=lambda o: -o.cost)  # type: ignore[operator]
        worst = matched[:worst_n]

        lines = [
            f"共 {res.cell_count} 格；已匹配 {res.assigned_count}，"
            f"未匹配 <span style='color:#c0392b;font-weight:700'>"
            f"{res.unmatched_count}</span>。",
        ]
        if res.free_deficit > 0:
            lines.append(
                f"<span style='color:#c0392b'>扣除固定格后，全图配额总缺口约 "
                f"{res.free_deficit} 格</span>（样块不够用，下列未匹配格会说明原因）。")
        else:
            lines.append("配额总量充足，没有整体性缺口。")
        if res.fixed_conflicts:
            lines.append(
                f"<span style='color:#b26a00'>有 {len(res.fixed_conflicts)} "
                f"条固定格冲突（超额或相邻），点下方按钮查看。</span>")
        self.issue_summary.setText("<br>".join(lines))

        entries: list[tuple[int, str, str]] = []
        if mode in ("all", "unmatched"):
            for o in unmatched:
                if o.reason_code == "adjacency":
                    short = "邻接限制：有配额的样块都在相邻位"
                elif o.reason_code == "mixed":
                    short = "配额用尽 + 邻接限制共同阻挡"
                elif o.reason_code == "no_tiles":
                    short = "没有可用样块"
                else:
                    short = f"配额不足：{len(o.quota_blockers)} 块样块配额均已用尽"
                entries.append((
                    o.cell,
                    f"🟥 第{o.row + 1}行第{o.col + 1}列　{short}",
                    o.reason))
        if mode in ("all", "worst"):
            for rank, o in enumerate(worst, 1):
                sim = (1 - o.cost) * 100  # type: ignore[operator]
                tile = self.session.tiles[o.tile] if o.tile is not None else None
                entries.append((
                    o.cell,
                    f"🟡 最差#{rank} 第{o.row + 1}行第{o.col + 1}列　"
                    f"相似度{sim:.0f}% — {tile.name if tile else '-'}",
                    f"距离代价 {o.cost:.4f}"))
        for cell, text, tip in entries:
            item = QListWidgetItem(text)
            item.setData(Qt.ItemDataRole.UserRole, cell)
            item.setToolTip(tip)
            self.issue_list.addItem(item)

    def _on_issue_clicked(self, item: QListWidgetItem) -> None:
        idx = item.data(Qt.ItemDataRole.UserRole)
        if idx is not None:
            # 单击只在预览上定位，保留在“问题定位”页方便连续跳转；
            # 双击条目会跳到“格子检查”页进行固定操作。
            self.select_cell(int(idx), focus_inspector=False)

    def jump_issue(self, direction: int) -> None:
        row = self.issue_list.currentRow()
        count = self.issue_list.count()
        if count == 0:
            return
        row = 0 if row < 0 else (row + direction) % count
        self.issue_list.setCurrentRow(row)
        item = self.issue_list.item(row)
        self._on_issue_clicked(item)

    def show_conflict_details(self) -> None:
        res = self.session.result
        if res is None:
            return
        if not res.fixed_conflicts:
            QMessageBox.information(self, "冲突说明", "当前没有固定格冲突。")
            return
        QMessageBox.warning(
            self, "固定格冲突",
            "\n\n".join(fc.detail for fc in res.fixed_conflicts))

    # ---- 配额表 ----
    def refresh_quota_table(self) -> None:
        rows = self.session.usage_rows()
        self.quota_table.setRowCount(len(rows))
        for r, row in enumerate(rows):
            vals = [
                row["name"], row["group"],
                "不限" if row["quota"] == UNLIMITED else str(row["quota"]),
                str(row["used"]), str(row["fixed"]),
                "不限" if row["remaining"] is None else str(row["remaining"]),
            ]
            for c, v in enumerate(vals):
                item = QTableWidgetItem(v)
                if c == 0:
                    item.setData(Qt.ItemDataRole.UserRole, row["tile_id"])
                if c >= 2:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                self.quota_table.setItem(r, c, item)

    def _selected_quota_tile_id(self) -> str | None:
        row = self.quota_table.currentRow()
        if row < 0:
            return None
        item = self.quota_table.item(row, 0)
        return item.data(Qt.ItemDataRole.UserRole) if item else None

    def _on_quota_row_selected(self) -> None:
        tile_id = self._selected_quota_tile_id()
        if tile_id is None:
            return
        q = self.session.quota_for_tile(tile_id)
        self.tile_quota_spin.blockSignals(True)
        self.tile_quota_spin.setValue(q)
        self.tile_quota_spin.blockSignals(False)

    def apply_tile_quota(self) -> None:
        tile_id = self._selected_quota_tile_id()
        if tile_id is None:
            QMessageBox.information(self, "提示", "请先在表格里选中一块样块。")
            return
        self.session.quota_overrides[tile_id] = int(self.tile_quota_spin.value())
        self.recompute()

    def reset_tile_quota(self) -> None:
        tile_id = self._selected_quota_tile_id()
        if tile_id:
            self.session.quota_overrides.pop(tile_id, None)
            self.recompute()

    def reset_all_quotas(self) -> None:
        self.session.quota_overrides.clear()
        self.recompute()

    def locate_selected_tile(self) -> None:
        tile_id = self._selected_quota_tile_id()
        if not tile_id:
            return
        self._tile_highlight = tile_id
        tile = self.session.tile_by_id[tile_id]
        self.tile_locate_label.setText(f"正在定位：{tile.name}")
        self.btn_clear_locate.setVisible(True)
        self.set_view_mode("source")
        # 来源下拉保持不动，单块定位优先级更高。
        self.refresh_preview()

    # ===================================================================
    # 导出 / 方案 / 关于
    # ===================================================================
    def export_dialog(self) -> None:
        if self.session.result is None:
            QMessageBox.information(self, "还不能导出", "请先载入素材并完成计算。")
            return
        long_edge, ok = QInputDialog.getInt(
            self, "导出清晰度", "成品长边像素（越大越清晰、文件越大）：",
            3600, 800, 12000, 100)
        if not ok:
            return
        default = str(REPO_ROOT / "mosaic_poster.png")
        path, selected_filter = QFileDialog.getSaveFileName(
            self, "导出成品 PNG / JPEG", default,
            "PNG 图片 (*.png);;JPEG 图片 (*.jpg)")
        if not path:
            return
        if selected_filter.startswith("JPEG") and not path.lower().endswith(
                (".jpg", ".jpeg")):
            path += ".jpg"
        elif not Path(path).suffix:
            path += ".png"
        try:
            image_path, cell_px, size, record_paths = self.export_to(
                path, long_edge=long_edge)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        box = QMessageBox(self)
        box.setWindowTitle("导出完成")
        box.setText(
            f"成品：{image_path}\n尺寸：{size[0]}×{size[1]}（每格 {cell_px}px）\n\n"
            f"格子记录：{record_paths['cells_csv'].name}\n"
            f"样块用量：{record_paths['tiles_csv'].name}\n"
            f"完整报告：{record_paths['json'].name}")
        btn_open = box.addButton("打开所在文件夹",
                                 QMessageBox.ButtonRole.AcceptRole)
        box.addButton("好的", QMessageBox.ButtonRole.RejectRole)
        box.exec()
        if box.clickedButton() is btn_open:
            QDesktopServices.openUrl(
                QUrl.fromLocalFile(str(Path(image_path).parent)))

    def export_to(self, image_path: str | Path, long_edge: int = 3600):
        """无对话框导出，供测试/脚本调用。"""
        image_path, cell_px, size = render.export_final_image(
            self.session, image_path, long_edge=long_edge)
        record_paths = report.export_records(self.session, image_path)
        return image_path, cell_px, size, record_paths

    def save_plan_dialog(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "保存方案", str(REPO_ROOT / "mosaic_plan.json"),
            "JSON 方案 (*.json)")
        if path:
            self.save_plan_to(path)

    def save_plan_to(self, path: str | Path) -> Path:
        return projectio.save_project(self.session, path)

    def load_plan_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "读取方案", str(REPO_ROOT), "JSON 方案 (*.json)")
        if path:
            try:
                projectio.apply_project(self.session, path, solve=True)
            except Exception as exc:
                QMessageBox.critical(self, "读取方案失败", str(exc))
                return
            self.base_edit.setText(self.session.base_path or "")
            self.tiles_edit.setText(self.session.tile_folder or "")
            self._set_controls_from_params()
            self._reload_source_combo()
            self.refresh_all()

    def show_about(self) -> None:
        QMessageBox.about(
            self, "使用说明",
            "<h3>照片马赛克工坊</h3>"
            "<p>本地运行，素材不上传。流程：</p>"
            "<ol>"
            "<li>读取底图、选择样块文件夹（会递归读取子目录，子目录即来源），"
            "或直接点「一键载入内置示例」。</li>"
            "<li>调整格子大小、每块配额、相邻限制半径和种子，排版会自动重算。</li>"
            "<li>在预览里点格子，右侧挑选样块并双击固定；其他格子重算时"
            "会尊重固定格和剩余配额。</li>"
            "<li>用顶部「相似度热力」「按来源」视图和「问题定位」页找问题格。</li>"
            "<li>导出高清成品 PNG/JPEG，同时得到每格使用记录 CSV、"
            "样块用量 CSV 和含种子/裁切框的 JSON 报告。</li>"
            "</ol>"
            "<p>菜单「示例 → 配额冲突例子」演示配额不足时如何逐格说明。</p>")
