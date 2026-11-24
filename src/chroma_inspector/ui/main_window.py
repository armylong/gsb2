"""主窗口：帧导航、三平面查看、两种色度解释的并排重建对比。"""
from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSpinBox,
    QSplitter,
    QStackedWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ..chroma import (
    ChromaSite,
    SITE_LABELS,
    is_supported,
    luma_to_chroma_weights,
    unsupported_reason,
    virtual_point,
)
from ..errors import MediaError, RawParamError
from ..formats import PIXEL_FORMATS
from ..media import MediaInfo, open_media, open_raw, parse_raw_filename
from ..patterns import generate_all
from ..reconstruct import reconstruct_rgb
from .views import PixelView

ALL_SITES = [
    ChromaSite.LEFT,
    ChromaSite.CENTER,
    ChromaSite.TOP,
    ChromaSite.TOP_LEFT,
    ChromaSite.BOTTOM_LEFT,
    ChromaSite.BOTTOM,
]


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("色度平面查看器 — chroma inspector")
        self.resize(1480, 900)

        self.media: MediaInfo | None = None
        self.frame_index = 0
        self._planes_cache: tuple | None = None
        self._cached_frame = -1
        self.locked_region: tuple[int, int, int, int] | None = None
        self._syncing = False

        self._build_actions()
        self._build_ui()

    # ------------------------------------------------------------------ UI
    def _build_actions(self):
        toolbar = self.addToolBar("main")
        toolbar.setMovable(False)
        act_open = QAction("打开视频…", self)
        act_open.setShortcut(QKeySequence.StandardKey.Open)
        act_open.triggered.connect(self.choose_file)
        toolbar.addAction(act_open)

        act_raw = QAction("打开裸 .yuv…", self)
        act_raw.triggered.connect(self.choose_raw)
        toolbar.addAction(act_raw)

        act_gen = QAction("生成内置图案短片…", self)
        act_gen.triggered.connect(self.generate_patterns)
        toolbar.addAction(act_gen)

        toolbar.addSeparator()
        self.act_export = QAction("导出并排检查图…", self)
        self.act_export.setShortcut(QKeySequence("Ctrl+E"))
        self.act_export.setEnabled(False)
        self.act_export.triggered.connect(self.export_image)
        toolbar.addAction(self.act_export)

    def _build_ui(self):
        central = QWidget()
        root = QHBoxLayout(central)

        # ---------- 左侧控制面板 ----------
        side = QWidget()
        side.setFixedWidth(330)
        side_layout = QVBoxLayout(side)

        self.file_label = QLabel("未打开文件")
        self.file_label.setWordWrap(True)
        side_layout.addWidget(self.file_label)

        nav = QGroupBox("帧导航")
        nav_form = QFormLayout(nav)
        self.frame_spin = QSpinBox()
        self.frame_spin.setMinimum(0)
        self.frame_spin.valueChanged.connect(self.on_frame_spin)
        nav_form.addRow("跳到帧号", self.frame_spin)
        nav_row = QHBoxLayout()
        self.btn_first = QPushButton("⏮")
        self.btn_prev = QPushButton("◀")
        self.btn_next = QPushButton("▶")
        self.btn_last = QPushButton("⏭")
        for b in (self.btn_first, self.btn_prev, self.btn_next, self.btn_last):
            nav_row.addWidget(b)
        nav_form.addRow(nav_row)
        self.btn_prev.clicked.connect(lambda: self._step_frame(-1))
        self.btn_next.clicked.connect(lambda: self._step_frame(1))
        self.btn_first.clicked.connect(lambda: self.frame_spin.setValue(0))
        self.btn_last.clicked.connect(
            lambda: self.frame_spin.setValue(max(0, self.frame_spin.maximum()))
        )
        side_layout.addWidget(nav)

        mode = QGroupBox("显示模式")
        mode_layout = QVBoxLayout(mode)
        self.rb_planes = QRadioButton("原始平面（Y / Cb / Cr）")
        self.rb_compare = QRadioButton("两种解释并排重建")
        self.rb_planes.setChecked(True)
        self.rb_planes.toggled.connect(self.switch_mode)
        mode_layout.addWidget(self.rb_planes)
        mode_layout.addWidget(self.rb_compare)
        side_layout.addWidget(mode)

        plane_box = QGroupBox("平面选择")
        plane_layout = QVBoxLayout(plane_box)
        self.plane_combo = QComboBox()
        self.plane_combo.addItems(["Y 亮度（全分辨率）", "Cb 色度 U（子采样分辨率）",
                                   "Cr 色度 V（子采样分辨率）"])
        self.plane_combo.currentIndexChanged.connect(self.refresh_planes_view)
        plane_layout.addWidget(self.plane_combo)
        side_layout.addWidget(plane_box)

        interp = QGroupBox("色度采样点解释")
        interp_layout = QVBoxLayout(interp)
        self.site_a = self._site_combo()
        self.site_b = self._site_combo()
        interp_layout.addWidget(QLabel("解释 A："))
        interp_layout.addWidget(self.site_a)
        interp_layout.addWidget(QLabel("解释 B："))
        interp_layout.addWidget(self.site_b)
        self.chk_diff = QComboBox()
        self.chk_diff.addItems(["仅并排画面", "附加差值热力图（B−A 色度幅度）"])
        self.chk_diff.currentIndexChanged.connect(self.refresh_compare)
        interp_layout.addWidget(self.chk_diff)
        side_layout.addWidget(interp)

        zoom_box = QGroupBox("锁定区域")
        zoom_layout = QVBoxLayout(zoom_box)
        zoom_hint = QLabel(
            "Alt+左键拖框：锁定放大区域\n"
            "Shift+左键或中键拖动：平移\n"
            "滚轮：缩放（对比双视图同步）\n"
            "对比模式下锁定区域可逐像素核对"
        )
        zoom_layout.addWidget(zoom_hint)
        self.region_label = QLabel("未锁定")
        zoom_layout.addWidget(self.region_label)
        btn_clear = QPushButton("清除锁定 / 复位缩放")
        btn_clear.clicked.connect(self.clear_region)
        zoom_layout.addWidget(btn_clear)
        side_layout.addWidget(zoom_box)

        decl = QGroupBox("媒体声明与实际选用")
        decl_layout = QVBoxLayout(decl)
        self.decl_text = QTextEdit()
        self.decl_text.setReadOnly(True)
        self.decl_text.setMinimumHeight(150)
        decl_layout.addWidget(self.decl_text)
        side_layout.addWidget(decl)

        side_layout.addStretch(1)

        # ---------- 右侧显示区 ----------
        self.stack = QStackedWidget()

        self.plane_view = PixelView("plane")
        self.plane_view.pixelClicked.connect(self.on_plane_pixel)
        self.plane_view.regionLocked.connect(self.on_region_locked)

        compare_widget = QWidget()
        self.compare_widget = compare_widget
        compare_layout = QVBoxLayout(compare_widget)
        compare_layout.setContentsMargins(0, 0, 0, 0)
        views_row = QHBoxLayout()
        self.view_a = PixelView("A")
        self.view_b = PixelView("B")
        self.view_a.pixelClicked.connect(lambda x, y: self.on_compare_pixel(x, y))
        self.view_b.pixelClicked.connect(lambda x, y: self.on_compare_pixel(x, y))
        self.view_a.regionLocked.connect(self.on_region_locked)
        self.view_b.regionLocked.connect(self.on_region_locked)
        self.view_a.transformChangedView.connect(
            lambda t: self._sync_transform(self.view_a, self.view_b, t)
        )
        self.view_b.transformChangedView.connect(
            lambda t: self._sync_transform(self.view_b, self.view_a, t)
        )
        self.view_a.setMinimumWidth(420)
        self.view_b.setMinimumWidth(420)
        views_row.addWidget(self.view_a)
        views_row.addWidget(self.view_b)
        compare_layout.addLayout(views_row, 1)
        self.diff_view = PixelView("diff")
        self.diff_view.setMaximumHeight(0)
        compare_layout.addWidget(self.diff_view)

        self.stack.addWidget(self.plane_view)
        self.stack.addWidget(self.compare_widget)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(side)
        splitter.addWidget(self.stack)
        splitter.setStretchFactor(1, 1)
        root.addWidget(splitter)
        self.setCentralWidget(central)

        self.status = self.statusBar()
        self.set_enabled_state(False)

    def _site_combo(self) -> QComboBox:
        combo = QComboBox()
        for site in ALL_SITES:
            combo.addItem(SITE_LABELS[site], site)
        combo.currentIndexChanged.connect(self._on_site_selection_changed)
        return combo

    def _on_site_selection_changed(self, _idx: int):
        if self.media is not None:
            self._update_declaration_panel()
            self.refresh_compare()

    def set_enabled_state(self, on: bool):
        for w in (
            self.frame_spin, self.btn_first, self.btn_prev, self.btn_next,
            self.btn_last, self.plane_combo, self.site_a, self.site_b,
            self.act_export, self.rb_planes, self.rb_compare, self.chk_diff,
        ):
            w.setEnabled(on)

    # ------------------------------------------------------------------ 文件
    def choose_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择短片",
            "",
            "视频/原始平面 (*.mp4 *.mkv *.mov *.avi *.webm *.yuv *.raw);;所有文件 (*)",
        )
        if not path:
            return
        try:
            if path.lower().endswith((".yuv", ".raw")):
                self._open_raw_path(path)
            else:
                self.load_media(open_media(path))
        except MediaError as e:
            QMessageBox.critical(self, "打开失败", str(e))

    def choose_raw(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择裸 .yuv", "", "原始平面 (*.yuv *.raw);;所有文件 (*)"
        )
        if not path:
            return
        self._open_raw_path(path)

    def _open_raw_path(self, path: str):
        guess = parse_raw_filename(path)
        dlg = RawParamsDialog(self, guess)
        if dlg.exec() != 1:
            return
        try:
            self.load_media(
                open_raw(path, dlg.width_value(), dlg.height_value(), dlg.format_value())
            )
        except RawParamError as e:
            QMessageBox.critical(self, "裸 .yuv 参数错误", str(e))
        except MediaError as e:
            QMessageBox.critical(self, "打开失败", str(e))

    def generate_patterns(self):
        out_dir = QFileDialog.getExistingDirectory(
            self, "选择图案短片输出目录", os.path.expanduser("~/Movies")
        )
        if not out_dir:
            return
        try:
            files = generate_all(out_dir)
        except MediaError as e:
            QMessageBox.critical(self, "生成失败", str(e))
            return
        names = "\n".join(os.path.basename(f) for f in files)
        if QMessageBox.question(
            self,
            "生成完成",
            f"已生成 {len(files)} 个文件：\n{names}\n\n是否立即打开水平偏移验证片？",
        ) == QMessageBox.StandardButton.Yes:
            target = next((f for f in files if f.endswith("pat_horizontal.mkv")), files[0])
            try:
                self.load_media(open_media(target))
            except MediaError as e:
                QMessageBox.critical(self, "打开失败", str(e))

    # ------------------------------------------------------------------ 装载
    def load_media(self, media: MediaInfo):
        # 每个文件独立对象：旧文件声明不会被沿用
        self.media = media
        self.frame_index = 0
        self._cached_frame = -1
        self._planes_cache = None
        self.locked_region = None
        self.file_label.setText(os.path.basename(media.path))
        self.frame_spin.blockSignals(True)
        self.frame_spin.setRange(0, max(0, media.frame_count - 1))
        self.frame_spin.setValue(0)
        self.frame_spin.blockSignals(False)
        self._configure_sites_for_format()
        self._update_declaration_panel()
        self.set_enabled_state(True)
        self.refresh_all()

    def _configure_sites_for_format(self):
        pf = self.media.pixel_format
        if pf.h_sub == 1:  # 4:4:4
            sites = [ChromaSite.LEFT]
        elif pf.v_sub == 1:  # 4:2:2
            sites = [ChromaSite.LEFT, ChromaSite.CENTER]
        else:
            sites = ALL_SITES
        for combo in (self.site_a, self.site_b):
            combo.blockSignals(True)
            combo.clear()
            for site in sites:
                combo.addItem(SITE_LABELS[site], site)
            combo.blockSignals(False)
        # 默认：A 跟随声明（若支持），B 取与 A 不同的常用对照
        declared = self.media.declared_site
        default_a = declared if (declared and is_supported(declared, pf.h_sub, pf.v_sub)) else None
        if pf.h_sub == 2 and pf.v_sub == 2:
            if default_a is None:
                default_a = ChromaSite.CENTER
            default_b = ChromaSite.LEFT if default_a != ChromaSite.LEFT else ChromaSite.CENTER
        elif pf.v_sub == 1:
            default_a = default_a or ChromaSite.CENTER
            default_b = ChromaSite.LEFT if default_a != ChromaSite.LEFT else ChromaSite.CENTER
        else:
            default_a = default_b = ChromaSite.LEFT
        self._set_combo(self.site_a, default_a)
        self._set_combo(self.site_b, default_b)

    @staticmethod
    def _set_combo(combo: QComboBox, site: ChromaSite):
        idx = combo.findData(site)
        if idx >= 0:
            combo.setCurrentIndex(idx)

    def _update_declaration_panel(self):
        m = self.media
        pf = m.pixel_format
        lines = [
            f"文件：{os.path.basename(m.path)}",
            f"尺寸：{m.width}×{m.height}　像素格式：{pf.name}（{pf.family}，8 位）",
            f"帧数：{m.frame_count}　帧率：{m.fps:g} fps",
            f"范围：{'全范围 JPEG' if m.full_range else '有限范围 TV'}　矩阵：{m.matrix_key}"
            + (f"（{m.matrix_note}）" if m.matrix_note else ""),
            "─" * 34,
            f"媒体声明的位置：{m.declaration_note}",
        ]
        if m.declared_site is not None:
            supported = is_supported(m.declared_site, pf.h_sub, pf.v_sub)
            if not supported:
                lines.append(f"　→ 声明不支持的原因：{unsupported_reason(m.declared_site)}")
        lines.append("─" * 34)
        lines.append("实际选用的解释：")
        for tag, combo in (("A", self.site_a), ("B", self.site_b)):
            site = combo.currentData()
            if site is None:
                lines.append(f"  {tag}: 不适用")
            elif is_supported(site, pf.h_sub, pf.v_sub):
                lines.append(f"  {tag}: {SITE_LABELS[site]}")
            else:
                lines.append(f"  {tag}: {SITE_LABELS[site]} —— {unsupported_reason(site)}")
        if m.is_raw:
            lines.append("─" * 34)
            lines.append("提示：裸 .yuv 无任何元数据，以上解释均为人工选择。")
        self.decl_text.setText("\n".join(lines))

    # ------------------------------------------------------------------ 帧
    def on_frame_spin(self, value: int):
        if self.media is None or value == self.frame_index:
            return
        self.frame_index = value
        self.refresh_all()

    def _step_frame(self, delta: int):
        self.frame_spin.setValue(
            min(self.frame_spin.maximum(), max(0, self.frame_spin.value() + delta))
        )

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key.Key_Left, Qt.Key.Key_Right) and self.media is not None:
            self._step_frame(1 if event.key() == Qt.Key.Key_Right else -1)
            return
        super().keyPressEvent(event)

    def _planes(self):
        if self._cached_frame != self.frame_index:
            self._planes_cache = self.media.read_frame_planes(self.frame_index)
            self._cached_frame = self.frame_index
        return self._planes_cache

    def refresh_all(self):
        if self.media is None:
            return
        if self.rb_planes.isChecked():
            self.refresh_planes_view()
        else:
            self.refresh_compare()
        self._update_declaration_panel()

    def switch_mode(self):
        if self.media is None:
            return
        self.stack.setCurrentWidget(
            self.plane_view if self.rb_planes.isChecked() else self.compare_widget
        )
        self.refresh_all()

    # ------------------------------------------------------------------ 平面
    def refresh_planes_view(self):
        if self.media is None:
            return
        y, u, v = self._planes()
        idx = self.plane_combo.currentIndex()
        plane = (y, u, v)[idx]
        self.plane_view.show_gray(plane)
        if self.locked_region:
            self._apply_lock_to_view(self.plane_view)
        self.status.showMessage(
            f"帧 {self.frame_index}/{self.media.frame_count - 1}　"
            f"当前平面：{('Y', 'Cb', 'Cr')[idx]}　尺寸 {plane.shape[1]}×{plane.shape[0]}"
        )

    def on_plane_pixel(self, x: int, y: int):
        m = self.media
        yp, up, vp = self._planes()
        idx = self.plane_combo.currentIndex()
        pf = m.pixel_format
        if idx == 0:
            # 亮度像素 -> 它在当前解释 A 下引用了哪些原始色度样本
            site = self.site_a.currentData()
            cw, ch = m.chroma_dims
            if pf.h_sub == 1:
                msg = f"亮度像素 ({x},{y})：4:4:4 色度与亮度同位，即色度样本 ({x},{y})"
            else:
                weights = luma_to_chroma_weights(
                    x, y, site, pf.h_sub, pf.v_sub, cw, ch
                )
                detail = "，".join(
                    f"({cx},{cy}) 权重 {w:.3f} @虚拟亮度坐标"
                    f"({virtual_point(site, cx, cy, pf.h_sub, pf.v_sub).x:g},"
                    f"{virtual_point(site, cx, cy, pf.h_sub, pf.v_sub).y:g})"
                    for cx, cy, w in weights
                )
                msg = (
                    f"亮度像素 ({x},{y})，Y={yp[y, x]}　解释 A={site.value}\n"
                    f"引用的原始色度位置：{detail}"
                )
        else:
            plane = (up, vp)[idx - 1]
            name = "Cb(U)" if idx == 1 else "Cr(V)"
            site = self.site_a.currentData()
            if pf.h_sub == 1:
                msg = (
                    f"{name} 色度样本 ({x},{y})，值={plane[y, x]}\n"
                    f"4:4:4 色度与亮度同位，虚拟位置即 ({x},{y})"
                )
            else:
                pt = virtual_point(site, x, y, pf.h_sub, pf.v_sub)
                msg = (
                    f"{name} 色度样本 ({x},{y})，值={plane[y, x]}\n"
                    f"在解释 A={site.value} 下对应亮度网格虚拟位置："
                    f"({pt.x:g}, {pt.y:g})"
                )
        self.status.showMessage(msg)
        self.status.setToolTip(msg)

    # ------------------------------------------------------------------ 对比
    def refresh_compare(self):
        if self.media is None:
            return
        m = self.media
        yp, up, vp = self._planes()
        pf = m.pixel_format
        site_a = self.site_a.currentData()
        site_b = self.site_b.currentData()

        for site, view, tag in ((site_a, self.view_a, "A"), (site_b, self.view_b, "B")):
            if site is None or not is_supported(site, pf.h_sub, pf.v_sub):
                view.show_placeholder(
                    f"解释 {tag} 不可用\n"
                    + (unsupported_reason(site) if site else "无子采样歧义")
                )
                continue
            rgb = reconstruct_rgb(
                yp, up, vp, pf, site, m.matrix_key, m.full_range
            )
            view.show_rgb(rgb)
            if self.locked_region:
                self._apply_lock_to_view(view)
        self._refresh_diff(yp, up, vp, site_a, site_b)
        neutral = self._neutral_check(up, vp)
        self.status.showMessage(
            f"帧 {self.frame_index}/{m.frame_count - 1}　"
            f"A={site_a.value if site_a else '-'}　B={site_b.value if site_b else '-'}　"
            f"中性检查：{neutral}"
        )

    def _refresh_diff(self, yp, up, vp, site_a, site_b):
        want_diff = self.chk_diff.currentIndex() == 1 and self.media is not None
        self.diff_view.setMaximumHeight(220 if want_diff else 0)
        if not want_diff:
            return
        m = self.media
        pf = m.pixel_format
        if not (is_supported(site_a, pf.h_sub, pf.v_sub)
                and is_supported(site_b, pf.h_sub, pf.v_sub)):
            self.diff_view.show_placeholder("其中一个解释不可用，无法计算差值")
            return
        from ..chroma import upsample_chroma
        h, w = yp.shape
        ua = upsample_chroma(up, site_a, pf.h_sub, pf.v_sub, h, w)
        ub = upsample_chroma(up, site_b, pf.h_sub, pf.v_sub, h, w)
        va = upsample_chroma(vp, site_a, pf.h_sub, pf.v_sub, h, w)
        vb = upsample_chroma(vp, site_b, pf.h_sub, pf.v_sub, h, w)
        mag = np.clip(
            np.round((np.abs(ua - ub) + np.abs(va - vb)) * 2.0), 0, 255
        ).astype(np.uint8)
        self.diff_view.show_gray(mag)

    def _neutral_check(self, u: np.ndarray, v: np.ndarray) -> str:
        """中性灰样例在两种解释下都保持中性：色度面恒定时必然成立。"""
        u_const = bool(np.all(u == u.flat[0]))
        v_const = bool(np.all(v == v.flat[0]))
        if u_const and v_const:
            return f"色度恒定（U={u.flat[0]}, V={v.flat[0]}），两种解释均保持中性 ✓"
        return "色度面含彩色信息（非中性样例）"

    def on_compare_pixel(self, x: int, y: int):
        m = self.media
        yp, up, vp = self._planes()
        pf = m.pixel_format
        cw, ch = m.chroma_dims
        lines = [f"亮度像素 ({x},{y})，Y={yp[y, x]}"]
        for tag, combo in (("A", self.site_a), ("B", self.site_b)):
            site = combo.currentData()
            if site is None or not is_supported(site, pf.h_sub, pf.v_sub):
                lines.append(f"解释 {tag}: 不可用")
                continue
            weights = luma_to_chroma_weights(
                x, y, site, pf.h_sub, pf.v_sub, cw, ch
            )
            detail = "，".join(
                f"({cx},{cy}) w={w:.2f}" for cx, cy, w in weights
            )
            lines.append(f"解释 {tag}={site.value}: {detail}")
        msg = "\n".join(lines)
        self.status.showMessage(msg)
        self.status.setToolTip(msg)

    # ------------------------------------------------------------------ 缩放
    def _sync_transform(self, src: PixelView, dst: PixelView, transform):
        if self._syncing:
            return
        self._syncing = True
        dst.sync_from(transform)
        self._syncing = False

    def on_region_locked(self, region):
        if region is None:
            self.clear_region()
            return
        self.locked_region = region
        x0, y0, x1, y1 = region
        self.region_label.setText(f"x {x0}:{x1}　y {y0}:{y1}　({x1-x0}×{y1-y0})")
        for view in (self.plane_view, self.view_a, self.view_b):
            self._apply_lock_to_view(view)

    def _apply_lock_to_view(self, view: PixelView):
        if self.locked_region is None:
            return
        from PySide6.QtCore import QRect, QRectF
        x0, y0, x1, y1 = self.locked_region
        view.fitInView(
            QRectF(x0, y0, x1 - x0, y1 - y0),
            Qt.AspectRatioMode.KeepAspectRatio,
        )
        # paintEvent 按场景坐标绘制锁定框
        view.locked_rect = QRect(x0, y0, x1 - x0, y1 - y0)

    def clear_region(self):
        self.locked_region = None
        self.region_label.setText("未锁定")
        for view in (self.plane_view, self.view_a, self.view_b, self.diff_view):
            view.locked_rect = None
            view.reset_zoom()

    # ------------------------------------------------------------------ 导出
    def export_image(self):
        if self.media is None:
            return
        m = self.media
        yp, up, vp = self._planes()
        pf = m.pixel_format
        site_a, site_b = self.site_a.currentData(), self.site_b.currentData()
        if not (is_supported(site_a, pf.h_sub, pf.v_sub)
                and is_supported(site_b, pf.h_sub, pf.v_sub)):
            QMessageBox.warning(self, "无法导出", "两个解释都可用时才能导出对比图。")
            return
        rgb_a = reconstruct_rgb(yp, up, vp, pf, site_a, m.matrix_key, m.full_range)
        rgb_b = reconstruct_rgb(yp, up, vp, pf, site_b, m.matrix_key, m.full_range)
        default_name = (
            f"{os.path.splitext(os.path.basename(m.path))[0]}"
            f"_frame{self.frame_index:04d}.png"
        )
        path, _ = QFileDialog.getSaveFileName(
            self, "导出并排检查图", default_name, "PNG (*.png)"
        )
        if not path:
            return
        try:
            from .export_png import render_png
            render_png(
                rgb_a, rgb_b,
                f"解释 A：{SITE_LABELS[site_a]}",
                f"解释 B：{SITE_LABELS[site_b]}",
                f"{os.path.basename(m.path)}　帧号 {self.frame_index} / {m.frame_count - 1}"
                f"　{pf.name}　范围 {'full' if m.full_range else 'limited'}",
                path,
                zoom_crop=self.locked_region,
            )
        except (OSError, MediaError) as e:
            QMessageBox.critical(self, "导出失败", str(e))
            return
        self.status.showMessage(f"已导出：{path}")


class RawParamsDialog(QDialog):
    """裸 .yuv 参数对话框。"""

    def __init__(self, parent, guess):
        super().__init__(parent)
        self.setWindowTitle("裸 .yuv 参数")
        layout = QVBoxLayout(self)
        form = QFormLayout()
        self.width_spin = QSpinBox()
        self.width_spin.setRange(2, 7680)
        self.height_spin = QSpinBox()
        self.height_spin.setRange(2, 4320)
        self.format_combo = QComboBox()
        for name in PIXEL_FORMATS:
            self.format_combo.addItem(name)
        if guess:
            w, h, fmt = guess
            self.width_spin.setValue(w)
            self.height_spin.setValue(h)
            idx = self.format_combo.findText(fmt)
            if idx >= 0:
                self.format_combo.setCurrentIndex(idx)
        else:
            self.width_spin.setValue(1920)
            self.height_spin.setValue(1080)
        form.addRow("宽度", self.width_spin)
        form.addRow("高度", self.height_spin)
        form.addRow("像素格式", self.format_combo)
        layout.addLayout(form)
        hint = QLabel("也可以把参数写进文件名，例如 clip_1920x1080_yuv420p.yuv")
        layout.addWidget(hint)
        row = QHBoxLayout()
        ok = QPushButton("打开")
        cancel = QPushButton("取消")
        ok.clicked.connect(self.accept)
        cancel.clicked.connect(self.reject)
        row.addStretch(1)
        row.addWidget(ok)
        row.addWidget(cancel)
        layout.addLayout(row)

    def width_value(self) -> int:
        return self.width_spin.value()

    def height_value(self) -> int:
        return self.height_spin.value()

    def format_value(self) -> str:
        return self.format_combo.currentText()
