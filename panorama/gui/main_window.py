"""主窗口：照片管理、配对可信度、全局画布、警告与导出。"""
from __future__ import annotations

from pathlib import Path

import cv2
from PySide6.QtCore import Qt, QSize
from PySide6.QtGui import QAction, QIcon
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QListWidget,
    QListWidgetItem, QLabel, QFileDialog, QSplitter, QGroupBox,
    QRadioButton, QButtonGroup, QCheckBox, QTextEdit, QComboBox,
)

from .. import blend
from ..config import Config
from ..engine import PanoramaEngine
from .canvas_view import CanvasView
from .helpers import cv_to_qpixmap, safe_message, start_build
from .match_dialog import MatchDialog


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("平面/远景全景拼接工具")
        self.resize(1400, 900)
        self.engine = PanoramaEngine(Config())
        self._thread = None
        self._build_ui()

    # ---------------- UI 搭建 ----------------
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        splitter = QSplitter(Qt.Horizontal)
        root.addWidget(splitter)

        # ---- 左栏：照片管理 ----
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.addWidget(QLabel("照片列表（缩略图 / 原始尺寸）"))
        self.photo_list = QListWidget()
        self.photo_list.setIconSize(QSize(96, 72))
        ll.addWidget(self.photo_list, 1)
        row = QHBoxLayout()
        for text, slot in (
            ("加入照片", self._add_photos),
            ("移除选中", self._remove_photo),
            ("上移", lambda: self._move(-1)),
            ("下移", lambda: self._move(1)),
        ):
            btn = QPushButton(text)
            btn.clicked.connect(slot)
            row.addWidget(btn)
        ll.addLayout(row)

        ll.addWidget(QLabel("配对关系（可信度 / 状态）"))
        self.pair_list = QListWidget()
        self.pair_list.itemDoubleClicked.connect(self._open_pair)
        ll.addWidget(self.pair_list, 1)
        inspect_btn = QPushButton("检查/编辑选中配对")
        inspect_btn.clicked.connect(self._open_pair_current)
        ll.addWidget(inspect_btn)

        build_btn = QPushButton("开始拼接 / 应用修改")
        build_btn.setStyleSheet("font-weight:bold; padding:8px;")
        build_btn.clicked.connect(self._rebuild)
        ll.addWidget(build_btn)
        splitter.addWidget(left)

        # ---- 中栏：画布 ----
        center = QWidget()
        cl = QVBoxLayout(center)
        mode_box = QGroupBox("显示模式")
        mode_row = QHBoxLayout(mode_box)
        self.mode_group = QButtonGroup(self)
        for k, text in enumerate(("融合结果", "未融合叠加", "有效像素区域")):
            rb = QRadioButton(text)
            if k == 0:
                rb.setChecked(True)
            rb.toggled.connect(self._mode_changed)
            self.mode_group.addButton(rb, k)
            mode_row.addWidget(rb)
        self.chk_border = QCheckBox("显示照片边框")
        self.chk_border.setChecked(True)
        self.chk_border.toggled.connect(self._border_changed)
        self.chk_ghost = QCheckBox("高亮潜在重影")
        self.chk_ghost.toggled.connect(self._ghost_changed)
        mode_row.addWidget(self.chk_border)
        mode_row.addWidget(self.chk_ghost)
        cl.addWidget(mode_box)

        self.canvas_view = CanvasView()
        cl.addWidget(self.canvas_view, 1)

        export_row = QHBoxLayout()
        self.ref_combo = QComboBox()
        self.ref_combo.currentIndexChanged.connect(self._ref_changed)
        export_row.addWidget(QLabel("参考照片:"))
        export_row.addWidget(self.ref_combo)
        export_row.addStretch(1)
        btn_full = QPushButton("导出完整画布（含透明边界）")
        btn_full.clicked.connect(self._export_full)
        btn_crop = QPushButton("导出有效矩形裁剪")
        btn_crop.clicked.connect(self._export_crop)
        export_row.addWidget(btn_full)
        export_row.addWidget(btn_crop)
        cl.addLayout(export_row)
        splitter.addWidget(center)

        # ---- 右栏：状态/警告 ----
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.addWidget(QLabel("状态与判定依据"))
        self.status_text = QTextEdit()
        self.status_text.setReadOnly(True)
        rl.addWidget(self.status_text, 1)
        splitter.addWidget(right)
        splitter.setSizes([320, 760, 320])

        self._add_menu()
        self._refresh_photo_list()

    def _add_menu(self):
        menu = self.menuBar().addMenu("场景")
        gen_action = QAction("生成内置测试场景（5帧+不相干图）", self)
        gen_action.triggered.connect(self._generate_builtin)
        menu.addAction(gen_action)
        loop_action = QAction("生成闭环测试场景", self)
        loop_action.triggered.connect(self._generate_loop)
        menu.addAction(loop_action)

    # ---------------- 照片管理 ----------------
    def _add_photos(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择照片", "",
            "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)",
        )
        for p in paths:
            try:
                self.engine.add_photo(p)
            except ValueError as exc:
                safe_message(self, "warning", "读取失败", str(exc))
        self._refresh_photo_list()

    def _remove_photo(self):
        row = self.photo_list.currentRow()
        if row < 0:
            return
        self.engine.remove_photo(self.engine.photos[row].pid)
        self._refresh_photo_list()

    def _move(self, delta):
        row = self.photo_list.currentRow()
        target = row + delta
        if row < 0 or not (0 <= target < self.engine.n):
            return
        pid = self.engine.photos[row].pid
        self.engine.move_photo(pid, target)
        self._refresh_photo_list()
        self.photo_list.setCurrentRow(target)

    def _refresh_photo_list(self):
        self.photo_list.clear()
        self.ref_combo.clear()
        for k, p in enumerate(self.engine.photos):
            h, w = p.image.shape[:2]
            item = QListWidgetItem(f"[{k}] {p.name}  ({w}×{h})")
            thumb = cv2.resize(p.image, (96, 72))
            item.setIcon(QIcon(cv_to_qpixmap(thumb)))
            self.photo_list.addItem(item)
            self.ref_combo.addItem(f"[{k}] {p.name}")

    # ---------------- 场景生成 ----------------
    def _generate_builtin(self):
        self._generate(closed=False)

    def _generate_loop(self):
        self._generate(closed=True)

    def _generate(self, closed: bool):
        from ..synthetic import build_synthetic_scene

        d = QFileDialog.getExistingDirectory(self, "选择场景输出目录")
        if not d:
            return
        out = Path(d) / ("loop_scene" if closed else "synthetic_scene")
        meta = build_synthetic_scene(out, n_frames=5, closed_loop=closed)
        self.engine = PanoramaEngine(Config())
        for f in meta["frames"]:
            self.engine.add_photo(str(out / f["file"]))
        self.engine.add_photo(str(out / meta["unrelated"]))
        self._refresh_photo_list()
        self._set_status(f"已生成场景到 {out}，点击「开始拼接」。")

    # ---------------- 拼接 ----------------
    def _rebuild(self):
        if self.engine.n < 2:
            safe_message(self, "information", "提示", "请先加入至少两张照片")
            return
        self._set_status("正在拼接（特征匹配 + 全局优化 + 融合）…")
        self._thread = start_build(
            self.engine, self._on_build_done, self._on_build_failed
        )

    def _on_build_failed(self, msg: str):
        safe_message(self, "critical", "拼接异常", msg)
        self._set_status(f"异常：{msg}")

    def _on_build_done(self, report):
        self._refresh_pair_list(report)
        lines = []
        if report.ok:
            lines.append("✅ 本次拼接成功并已保存为「上次有效结果」")
        else:
            lines.append("❌ 本次拼接未通过校验")
            lines.extend("原因：" + r for r in report.reasons)
        if report.rolled_back:
            lines.append("⚠️ 已回退到上次有效结果，当前画布仍可导出该可信版本")
        if report.excluded:
            names = [self.engine._name(p) for p in report.excluded]
            lines.append(f"🚫 已排除（无可信重叠，未强行贴入）：{', '.join(names)}")
        if report.warnings:
            lines.extend("提示：" + w for w in report.warnings)
        if report.layout:
            lines.append(
                f"全局重投影 RMSE：{report.layout.global_rmse:.2f}px；"
                f"闭环：{'是' if report.layout.has_loop else '否'}"
            )
        self._set_status("\n".join(lines))

        if report.canvas and report.layout:
            self.canvas_view.set_result(
                report.canvas, report.layout.globals_H,
                {p.pid: p.size for p in self.engine.photos},
                [p.pid for p in self.engine.photos
                 if p.pid in report.layout.globals_H],
                report.canvas.bounds,
            )
            self._mode_changed()

    def _refresh_pair_list(self, report):
        self.pair_list.clear()
        for key, m in report.pair_matches.items():
            name_i = self.engine._name(m.i)
            name_j = self.engine._name(m.j)
            mark = "✅" if m.accepted else "❌"
            item = QListWidgetItem(
                f"{mark} {name_i} ↔ {name_j} | 内点 {m.n_inliers}/"
                f"{m.n_raw} | RMSE {m.rmse:.1f} | 可信 {m.confidence:.2f}"
            )
            item.setData(Qt.UserRole, key)
            self.pair_list.addItem(item)

    def _open_pair(self, item=None):
        if item is None:
            item = self.pair_list.currentItem()
        if item is None:
            return
        i, j = item.data(Qt.UserRole)
        dlg = MatchDialog(self.engine, i, j, self)
        dlg.controls_changed.connect(lambda: None)
        if dlg.exec():
            self._rebuild()

    def _open_pair_current(self):
        self._open_pair()

    # ---------------- 视图模式 ----------------
    def _mode_changed(self):
        idx = self.mode_group.checkedId()
        self.canvas_view.set_mode(
            {0: "blend", 1: "overlay", 2: "valid"}[idx]
        )

    def _border_changed(self):
        self.canvas_view.set_show_borders(self.chk_border.isChecked())

    def _ghost_changed(self):
        self.canvas_view.set_show_ghost(self.chk_ghost.isChecked())

    def _ref_changed(self):
        self.engine.cfg.ref_index = self.ref_combo.currentIndex()

    # ---------------- 导出 ----------------
    def _require_canvas(self):
        rep = self.engine.last_report
        if rep is None or rep.canvas is None or not rep.ok:
            self._warn(
                "无法导出",
                "当前没有通过校验的全景结果，不能导出无可信位置关系的图像",
            )
            return None
        return rep

    def _warn(self, title: str, text: str):
        return safe_message(self, "warning", title, text)

    def _export_full(self):
        rep = self._require_canvas()
        if rep is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出完整画布", "panorama_full.png",
                                              "PNG (*.png)")
        if not path:
            return
        try:
            img = blend.export_full_canvas(rep.canvas, self.engine.cfg)
            cv2.imwrite(path, img)
        except Exception as exc:
            safe_message(self, "critical", "导出失败", str(exc))
            return
        safe_message(self, "information", "完成", f"已导出完整画布：{path}")

    def _export_crop(self):
        rep = self._require_canvas()
        if rep is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出有效裁剪", "panorama_crop.png",
                                              "PNG (*.png)")
        if not path:
            return
        try:
            crop, rect = blend.export_valid_crop(rep.canvas, self.engine.cfg)
            cv2.imwrite(path, crop)
        except Exception as exc:
            safe_message(self, "critical", "导出失败", str(exc))
            return
        x, y, w, h = rect
        safe_message(
            self, "information", "完成",
            f"已导出无空洞有效裁剪：{path}\n矩形 x={x}, y={y}, {w}×{h}",
        )

    def _set_status(self, text: str):
        self.status_text.setPlainText(text)
