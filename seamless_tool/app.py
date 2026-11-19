"""PySide6 主窗口:无缝纹理调整工具。"""
from __future__ import annotations

import cv2
import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QFileDialog, QGroupBox, QHBoxLayout, QLabel,
    QMainWindow, QMessageBox, QPushButton, QRadioButton, QScrollArea,
    QSlider, QSpinBox, QVBoxLayout, QWidget,
)

from . import __version__
from .core import (ImageValidationError, boundary_metrics, conflict_mask,
                   make_seamless, roll_image, tile3)
from .export import export_tile, load_image
from .textures import GENERATORS
from .widgets import ImageView, compose_overlay

VIEW_ORIG, VIEW_PROC, VIEW_TILED = 0, 1, 2


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"无缝纹理调整工具 v{__version__}")
        self.resize(1280, 860)

        # ---- 状态 ----
        self.image: np.ndarray | None = None   # 当前工作图(已含循环偏移)
        self.mask: np.ndarray | None = None    # 保护区(bool),随偏移一起环绕
        self.processed: np.ndarray | None = None
        self.offset_dx = 0
        self.offset_dy = 0
        self.view_mode = VIEW_PROC
        self.source_info: dict = {"kind": "none"}

        self._build_ui()
        self._recompute()

    # ================= UI =================
    def _build_ui(self):
        central = QWidget()
        root = QHBoxLayout(central)
        self.view = ImageView()
        root.addWidget(self._build_panel(), 0)
        self.view.pixel_picked.connect(self._on_pick)
        self.view.paint_stroke.connect(self._on_paint)
        self.view.paint_finished.connect(self._recompute)
        root.addWidget(self.view, 1)
        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪")

    def _build_panel(self) -> QWidget:
        panel = QWidget()
        lay = QVBoxLayout(panel)
        lay.setAlignment(Qt.AlignmentFlag.AlignTop)

        # 文件 / 生成
        gb = QGroupBox("图片")
        v = QVBoxLayout(gb)
        btn_open = QPushButton("打开 PNG / JPEG…")
        btn_open.clicked.connect(self._open_file)
        v.addWidget(btn_open)
        row = QHBoxLayout()
        self.gen_combo = QComboBox()
        for key, (label, _) in GENERATORS.items():
            self.gen_combo.addItem(label, key)
        self.seed_spin = QSpinBox()
        self.seed_spin.setRange(0, 999999)
        self.seed_spin.setValue(42)
        self.seed_spin.setPrefix("种子 ")
        btn_gen = QPushButton("生成测试纹理")
        btn_gen.clicked.connect(self._generate)
        row.addWidget(self.gen_combo)
        row.addWidget(self.seed_spin)
        row.addWidget(btn_gen)
        v.addLayout(row)
        lay.addWidget(gb)

        # 视图
        gb = QGroupBox("视图")
        v = QVBoxLayout(gb)
        self.rb_orig = QRadioButton("原纹理(当前偏移)")
        self.rb_proc = QRadioButton("处理后单块")
        self.rb_tiled = QRadioButton("3×3 平铺预览")
        self.rb_proc.setChecked(True)
        for rb, mode in ((self.rb_orig, VIEW_ORIG), (self.rb_proc, VIEW_PROC),
                         (self.rb_tiled, VIEW_TILED)):
            rb.toggled.connect(lambda checked, m=mode: checked and self._set_view(m))
            v.addWidget(rb)
        self.chk_grid = QCheckBox("显示块边界")
        self.chk_grid.setChecked(True)
        self.chk_grid.toggled.connect(self._refresh_view)
        self.chk_mask = QCheckBox("显示保护区叠加")
        self.chk_mask.setChecked(True)
        self.chk_mask.toggled.connect(self._refresh_view)
        btn_fit = QPushButton("适配窗口")
        btn_fit.clicked.connect(self.view.fit)
        v.addWidget(self.chk_grid)
        v.addWidget(self.chk_mask)
        v.addWidget(btn_fit)
        lay.addWidget(gb)

        # 接缝处理
        gb = QGroupBox("接缝处理")
        v = QVBoxLayout(gb)
        self.chk_h = QCheckBox("水平接缝(上下边界)")
        self.chk_h.setChecked(True)
        self.chk_v = QCheckBox("垂直接缝(左右边界)")
        self.chk_v.setChecked(True)
        self.chk_h.toggled.connect(self._recompute)
        self.chk_v.toggled.connect(self._recompute)
        v.addWidget(self.chk_h)
        v.addWidget(self._width_row("h"))
        v.addWidget(self.chk_v)
        v.addWidget(self._width_row("v"))
        lay.addWidget(gb)

        # 循环偏移
        gb = QGroupBox("循环偏移(环绕检查)")
        v = QVBoxLayout(gb)
        row = QHBoxLayout()
        self.spin_ox = QSpinBox()
        self.spin_oy = QSpinBox()
        for s in (self.spin_ox, self.spin_oy):
            s.setRange(-8192, 8192)
        self.spin_ox.setPrefix("X ")
        self.spin_oy.setPrefix("Y ")
        self.spin_ox.valueChanged.connect(self._offset_changed)
        self.spin_oy.valueChanged.connect(self._offset_changed)
        btn_reset = QPushButton("恢复默认")
        btn_reset.clicked.connect(self._reset_offset)
        row.addWidget(self.spin_ox)
        row.addWidget(self.spin_oy)
        row.addWidget(btn_reset)
        v.addLayout(row)
        self.lbl_offset = QLabel("当前偏移: (0, 0)")
        v.addWidget(self.lbl_offset)
        lay.addWidget(gb)

        # 保护区画笔
        gb = QGroupBox("保护区画笔")
        v = QVBoxLayout(gb)
        row = QHBoxLayout()
        self.brush_combo = QComboBox()
        self.brush_combo.addItems(["关闭", "画笔", "擦除"])
        self.brush_combo.currentIndexChanged.connect(self._brush_changed)
        self.brush_size = QSpinBox()
        self.brush_size.setRange(2, 128)
        self.brush_size.setValue(20)
        self.brush_size.setPrefix("半径 ")
        row.addWidget(self.brush_combo)
        row.addWidget(self.brush_size)
        v.addLayout(row)
        btn_clear = QPushButton("清除全部保护区")
        btn_clear.clicked.connect(self._clear_mask)
        v.addWidget(btn_clear)
        lay.addWidget(gb)

        # 指标
        gb = QGroupBox("边界指标(原图 → 处理后)")
        v = QVBoxLayout(gb)
        self.lbl_metrics = QLabel("—")
        self.lbl_metrics.setTextFormat(Qt.TextFormat.RichText)
        self.lbl_metrics.setWordWrap(True)
        v.addWidget(self.lbl_metrics)
        lay.addWidget(gb)

        # 冲突警告
        self.lbl_warn = QLabel("")
        self.lbl_warn.setWordWrap(True)
        self.lbl_warn.setStyleSheet("color: #ff9f1a; font-weight: bold;")
        lay.addWidget(self.lbl_warn)

        # 导出
        btn_export = QPushButton("导出单块 PNG + 参数 + 掩码…")
        btn_export.clicked.connect(self._export)
        lay.addWidget(btn_export)

        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setMinimumWidth(340)
        scroll.setMaximumWidth(420)
        return scroll

    def _width_row(self, axis: str) -> QWidget:
        w = QWidget()
        row = QHBoxLayout(w)
        row.setContentsMargins(16, 0, 0, 0)
        row.addWidget(QLabel("过渡宽度"))
        slider = QSlider(Qt.Orientation.Horizontal)
        slider.setRange(1, 64)
        slider.setValue(16)
        spin = QSpinBox()
        spin.setRange(1, 512)
        spin.setValue(16)
        slider.valueChanged.connect(spin.setValue)
        spin.valueChanged.connect(slider.setValue)
        spin.valueChanged.connect(self._recompute)
        row.addWidget(slider)
        row.addWidget(spin)
        setattr(self, f"w_{axis}", spin)
        return w

    # ================= 状态变更 =================
    def _set_image(self, img: np.ndarray, source: dict):
        self.image = img
        self.mask = np.zeros(img.shape[:2], dtype=bool)
        self.offset_dx = 0
        self.offset_dy = 0
        self.spin_ox.blockSignals(True)
        self.spin_oy.blockSignals(True)
        self.spin_ox.setValue(0)
        self.spin_oy.setValue(0)
        self.spin_ox.blockSignals(False)
        self.spin_oy.blockSignals(False)
        self.source_info = source
        self._recompute()
        self.view.fit()

    def _open_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开纹理图片", "", "图片 (*.png *.jpg *.jpeg)")
        if not path:
            return
        try:
            img = load_image(path)
        except ImageValidationError as e:
            QMessageBox.warning(self, "无法使用图片", str(e))
            return
        self._set_image(img, {"kind": "file", "path": path})

    def _generate(self):
        key = self.gen_combo.currentData()
        _, fn = GENERATORS[key]
        seed = self.seed_spin.value()
        self._set_image(fn(seed=seed),
                        {"kind": "generated", "generator": key, "seed": seed})

    def _set_view(self, mode: int):
        self.view_mode = mode
        self._refresh_view()

    def _brush_changed(self, _idx):
        self._refresh_view()

    def _clear_mask(self):
        if self.mask is not None:
            self.mask[:] = False
            self._recompute()

    def _offset_changed(self, _value):
        if self.image is None:
            return
        dx = self.spin_ox.value() - self.offset_dx
        dy = self.spin_oy.value() - self.offset_dy
        if dx == 0 and dy == 0:
            return
        # 环绕移动:图像与保护掩码一起滚,不丢内容不补黑边
        self.image = roll_image(self.image, dx, dy)
        self.mask = roll_image(self.mask.astype(np.uint8), dx, dy).astype(bool)
        self.offset_dx += dx
        self.offset_dy += dy
        self._recompute()

    def _reset_offset(self):
        self.spin_ox.setValue(0)
        self.spin_oy.setValue(0)  # 触发 _offset_changed 回滚

    # ================= 处理与显示 =================
    def _settings(self):
        return dict(h_on=self.chk_h.isChecked(), h_w=self.w_h.value(),
                    v_on=self.chk_v.isChecked(), v_w=self.w_v.value())

    def _recompute(self):
        if self.image is None:
            self._refresh_view()
            return
        s = self._settings()
        self.processed = make_seamless(self.image, self.mask, **s)
        self._update_metrics()
        self._update_warning()
        self._refresh_view()

    def _update_metrics(self):
        before = boundary_metrics(self.image)
        after = boundary_metrics(self.processed)

        def row(name, b, a):
            return (f"<tr><td>{name}</td>"
                    f"<td>{b['color_mean']:.2f} → <b>{a['color_mean']:.2f}</b></td>"
                    f"<td>{b['color_max']:.1f} → <b>{a['color_max']:.1f}</b></td>"
                    f"<td>{b['grad_mean']:.2f} → <b>{a['grad_mean']:.2f}</b></td>"
                    f"<td>{b['grad_max']:.1f} → <b>{a['grad_max']:.1f}</b></td></tr>")

        self.lbl_metrics.setText(
            "<table cellspacing=2>"
            "<tr><th>边界</th><th>颜色差<br>均值</th><th>颜色差<br>最大</th>"
            "<th>梯度突变<br>均值</th><th>梯度突变<br>最大</th></tr>"
            + row("水平(上下)", before["h"], after["h"])
            + row("垂直(左右)", before["v"], after["v"])
            + "</table>"
            f"<small>内部梯度突变参考: 水平 {after['h']['interior_grad_mean']:.2f},"
            f" 垂直 {after['v']['interior_grad_mean']:.2f}</small>")

    def _update_warning(self):
        s = self._settings()
        conf = conflict_mask(self.mask, **s)
        n = int(conf.sum()) if conf is not None else 0
        if n > 0:
            self.lbl_warn.setText(
                f"⚠ 保护区与接缝过渡带重叠 {n} 像素(图中橙色)。"
                "这些像素保持原值不变,但此处的接缝无法同时保证连续,"
                "边界指标会反映残余断裂。")
        else:
            self.lbl_warn.setText("")

    def _refresh_view(self):
        if self.image is None:
            self.view.set_image(None)
            return
        tiled = self.view_mode == VIEW_TILED
        # 画笔只在单块视图可用,平铺视图左键用于平移/点选
        self.view.paint_enabled = (not tiled
                                   and self.brush_combo.currentIndex() != 0)
        self.view.erase_mode = self.brush_combo.currentIndex() == 2
        if tiled:
            img = tile3(self.processed)
            grid = (self.image.shape[1], self.image.shape[0]) \
                if self.chk_grid.isChecked() else None
            self.view.set_image(img, grid_step=grid)
            return
        base = self.image if self.view_mode == VIEW_ORIG else self.processed
        s = self._settings()
        conf = conflict_mask(self.mask, **s)
        if self.chk_mask.isChecked():
            disp = compose_overlay(base, self.mask, conf)
        else:
            disp = compose_overlay(base, None, conf)
        grid = None
        if self.chk_grid.isChecked():
            grid = (self.image.shape[1], self.image.shape[0])
        self.view.set_image(disp, grid_step=grid)

    # ================= 交互 =================
    def _on_paint(self, x: int, y: int, erase: bool):
        if self.mask is None:
            return
        val = 0 if erase else 255
        canvas = self.mask.astype(np.uint8) * 255
        cv2.circle(canvas, (x, y), self.brush_size.value(), val, -1)
        self.mask = canvas > 0
        self._recompute()

    def _on_pick(self, x: int, y: int):
        if self.image is None:
            return
        h, w = self.image.shape[:2]
        if self.view_mode == VIEW_TILED:
            ti, tj = x // w, y // h
            tx, ty = x % w, y % h
            src = self.processed
            where = f"块({ti},{tj}) "
        else:
            tx, ty = x, y
            src = self.image if self.view_mode == VIEW_ORIG else self.processed
            where = ""
        r, g, b = (int(c) for c in src[ty, tx])
        prot = " [保护区]" if self.mask[ty, tx] else ""
        self.statusBar().showMessage(
            f"{where}纹理坐标 ({tx}, {ty})  RGB({r}, {g}, {b}){prot}"
            f"   缩放 {self.view.zoom:.2f}x")

    # ================= 导出 =================
    def _export(self):
        if self.processed is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出单块", "seamless_tile.png", "PNG (*.png)")
        if not path:
            return
        s = self._settings()
        conf = conflict_mask(self.mask, **s)
        params = {
            "app": "seamless-texture-tool",
            "version": __version__,
            "image": {"width": int(self.image.shape[1]),
                      "height": int(self.image.shape[0])},
            "offset": {"dx": self.offset_dx, "dy": self.offset_dy},
            "seam": {
                "horizontal": {"enabled": s["h_on"], "width": s["h_w"]},
                "vertical": {"enabled": s["v_on"], "width": s["v_w"]},
            },
            "protect": {
                "protected_pixels": int(self.mask.sum()),
                "conflict_pixels": int(conf.sum()) if conf is not None else 0,
            },
            "source": self.source_info,
            "metrics_after": boundary_metrics(self.processed),
        }
        try:
            files = export_tile(path, self.processed, self.mask, params)
        except IOError as e:
            QMessageBox.warning(self, "导出失败", str(e))
            return
        self.statusBar().showMessage(
            "已导出: " + ", ".join(files.values()), 8000)
