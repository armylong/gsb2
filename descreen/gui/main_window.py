"""主窗口：框选分析 → 频谱选点 → 分组陷波 → 对比导出。"""

from __future__ import annotations

import json
import math
import os

import numpy as np
from PySide6.QtCore import Qt, QTimer, QPointF, QRectF
from PySide6.QtGui import QAction, QPen, QBrush, QColor, QPixmap, QFont
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QSplitter, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QListWidget, QListWidgetItem,
    QFileDialog, QMessageBox, QGroupBox, QSpinBox, QDoubleSpinBox,
    QRadioButton, QButtonGroup, QStatusBar, QToolBar, QInputDialog,
)

from ..core import (
    Notch, NotchGroup, Peak, Spectrum, compute_spectrum, find_peaks,
    notch_from_pixels, ellipse_from_pixel_rect,
)
from ..synth import make_halftone_test, make_parallel_lines_test
from .image_utils import ndarray_to_qimage, load_image, save_image
from .widgets import ImageViewer, SpectrumView, CompareViewer
from .worker import ProcessWorker

GROUP_COLORS = [
    QColor(255, 90, 90), QColor(90, 200, 255), QColor(120, 230, 120),
    QColor(240, 200, 70), QColor(210, 130, 240), QColor(255, 150, 70),
]
PEAK_COLOR = QColor(255, 255, 255)
PAIR_COLOR = QColor(255, 140, 0)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("本地去斜网纹工具（频域陷波）")
        self.resize(1480, 920)

        # ---- 状态 ----
        self.image: np.ndarray | None = None
        self.image_path: str | None = None
        self.region: tuple[int, int, int, int] | None = None
        self.spec: Spectrum | None = None
        self.peaks: list[Peak] = []
        self.groups: list[NotchGroup] = []
        self.worker: ProcessWorker | None = None
        self._processed: np.ndarray | None = None
        self._diff: np.ndarray | None = None
        self._queued = False
        self._overlay_items = []
        self._suspend_process = False

        self._build_ui()
        self._build_toolbar()
        self.setStatusBar(QStatusBar(self))

        # 参数变化后防抖 200ms 再重算
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.timeout.connect(self._start_process)

        self._new_group()

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # 左：原图 + 对比
        left = QSplitter(Qt.Orientation.Vertical)
        self.image_view = ImageViewer()
        self.image_view.regionChanged.connect(self._on_region_changed)
        left.addWidget(self._titled("原图（左键框选分析区域，右键/中键拖动，滚轮缩放）",
                                    self.image_view))

        self.compare_view = CompareViewer()
        mode_row = QHBoxLayout()
        mode_row.addWidget(QLabel("对比视图："))
        self.mode_group = QButtonGroup(self)
        for i, name in enumerate(("处理后", "原图", "差图")):
            rb = QRadioButton(name)
            if i == 0:
                rb.setChecked(True)
            rb.toggled.connect(self._refresh_compare)
            self.mode_group.addButton(rb, i)
            mode_row.addWidget(rb)
        mode_row.addStretch(1)
        mode_row.addWidget(QLabel("差图增益"))
        self.gain_spin = QDoubleSpinBox()
        self.gain_spin.setRange(1.0, 32.0)
        self.gain_spin.setValue(4.0)
        self.gain_spin.setSingleStep(0.5)
        self.gain_spin.valueChanged.connect(self._schedule_process)
        mode_row.addWidget(self.gain_spin)
        compare_box = QWidget()
        cv = QVBoxLayout(compare_box)
        cv.setContentsMargins(0, 0, 0, 0)
        cv.addLayout(mode_row)
        cv.addWidget(self.compare_view, 1)
        left.addWidget(self._titled("前后对比（双击适应窗口）", compare_box))
        splitter.addWidget(left)

        # 中：频谱
        center = QWidget()
        cl = QVBoxLayout(center)
        self.spectrum_view = SpectrumView()
        self.spectrum_view.set_mode("point")
        self.spectrum_view.scenePoint.connect(self._on_spectrum_point)
        self.spectrum_view.sceneRect.connect(self._on_spectrum_rect)
        self.spectrum_view.cursorMoved.connect(self._on_spectrum_cursor)
        cl.addWidget(self._titled("二维频谱（中心=零频，点选/框选添加陷波）",
                                  self.spectrum_view), 1)
        self.cursor_label = QLabel("频率: -")
        self.cursor_label.setFont(QFont("Menlo", 10))
        cl.addWidget(self.cursor_label)
        self.peak_label = QLabel("候选峰: -")
        self.peak_label.setWordWrap(True)
        cl.addWidget(self.peak_label)
        splitter.addWidget(center)

        # 右：控制
        right = QWidget()
        rl = QVBoxLayout(right)

        # 交互模式
        mode_box = QGroupBox("频谱交互")
        mb = QVBoxLayout(mode_box)
        self.interaction_group = QButtonGroup(self)
        for i, (name, tip) in enumerate((
                ("点选陷波点", "point"), ("框选椭圆范围", "ellipse"),
                ("仅平移视图", "pan"))):
            rb = QRadioButton(name)
            if i == 0:
                rb.setChecked(True)
            rb.toggled.connect(lambda _=False, t=tip: self.spectrum_view.set_mode(t))
            self.interaction_group.addButton(rb, i)
            mb.addWidget(rb)
        row = QHBoxLayout()
        row.addWidget(QLabel("点选半径(频谱像素)"))
        self.radius_spin = QSpinBox()
        self.radius_spin.setRange(2, 120)
        self.radius_spin.setValue(8)
        row.addWidget(self.radius_spin)
        mb.addLayout(row)
        rl.addWidget(mode_box)

        # 分析参数
        ana_box = QGroupBox("频谱分析")
        ab = QVBoxLayout(ana_box)
        row = QHBoxLayout()
        row.addWidget(QLabel("峰值阈值(相对直流%)"))
        self.thresh_spin = QDoubleSpinBox()
        self.thresh_spin.setRange(0.1, 50.0)
        self.thresh_spin.setValue(2.0)
        self.thresh_spin.setSingleStep(0.5)
        self.thresh_spin.valueChanged.connect(self._recompute_peaks)
        row.addWidget(self.thresh_spin)
        ab.addLayout(row)
        rl.addWidget(ana_box)

        # 陷波分组
        grp_box = QGroupBox("陷波分组（可保存多组、临时关闭）")
        gb = QVBoxLayout(grp_box)
        self.group_list = QListWidget()
        self.group_list.currentRowChanged.connect(self._on_group_selected)
        self.group_list.itemChanged.connect(self._on_group_check)
        gb.addWidget(self.group_list)
        grow = QHBoxLayout()
        for text, slot in (
                ("新建组", self._new_group),
                ("删除组", self._delete_group),
                ("重命名", self._rename_group)):
            btn = QPushButton(text)
            btn.clicked.connect(slot)
            grow.addWidget(btn)
        gb.addLayout(grow)
        self.notch_list = QListWidget()
        gb.addWidget(QLabel("当前组的选区："))
        gb.addWidget(self.notch_list, 1)
        nrow = QHBoxLayout()
        btn_del = QPushButton("删除选中选区")
        btn_del.clicked.connect(self._delete_notch)
        nrow.addWidget(btn_del)
        btn_clear = QPushButton("清空当前组")
        btn_clear.clicked.connect(self._clear_group)
        nrow.addWidget(btn_clear)
        gb.addLayout(nrow)
        rl.addWidget(grp_box, 1)

        # 滤波参数
        filt_box = QGroupBox("滤波参数（改动均从原图重新计算）")
        fb = QVBoxLayout(filt_box)
        row = QHBoxLayout()
        row.addWidget(QLabel("边缘过渡宽度"))
        self.feather_spin = QDoubleSpinBox()
        self.feather_spin.setRange(0.0005, 0.05)
        self.feather_spin.setDecimals(4)
        self.feather_spin.setSingleStep(0.0005)
        self.feather_spin.setValue(0.004)
        self.feather_spin.valueChanged.connect(self._schedule_process)
        row.addWidget(self.feather_spin)
        fb.addLayout(row)
        self.feather_hint = QLabel("单位 cycles/pixel，越大过渡越柔和")
        self.feather_hint.setStyleSheet("color: gray; font-size: 11px;")
        fb.addWidget(self.feather_hint)
        rl.addWidget(filt_box)

        # 配置 / 导出
        cfg_row = QHBoxLayout()
        btn_save_cfg = QPushButton("保存选区配置")
        btn_save_cfg.clicked.connect(self._save_config)
        btn_load_cfg = QPushButton("载入配置")
        btn_load_cfg.clicked.connect(self._load_config)
        cfg_row.addWidget(btn_save_cfg)
        cfg_row.addWidget(btn_load_cfg)
        rl.addLayout(cfg_row)

        btn_export = QPushButton("导出处理后的图…")
        btn_export.setMinimumHeight(34)
        btn_export.clicked.connect(self._export)
        rl.addWidget(btn_export)
        rl.addStretch(1)

        splitter.addWidget(right)
        splitter.setSizes([520, 520, 360])
        self.setCentralWidget(splitter)

    def _titled(self, title: str, widget: QWidget) -> QWidget:
        box = QGroupBox(title)
        lay = QVBoxLayout(box)
        lay.setContentsMargins(4, 10, 4, 4)
        lay.addWidget(widget)
        return box

    def _build_toolbar(self):
        tb = QToolBar("文件")
        self.addToolBar(tb)
        act_open = QAction("打开图片", self)
        act_open.triggered.connect(self._open_image)
        tb.addAction(act_open)
        tb.addSeparator()
        act_t1 = QAction("生成测试图：斜网纹", self)
        act_t1.triggered.connect(lambda: self._open_synth("halftone"))
        tb.addAction(act_t1)
        act_t2 = QAction("生成测试图：平行细线", self)
        act_t2.triggered.connect(lambda: self._open_synth("lines"))
        tb.addAction(act_t2)
        tb.addSeparator()
        act_export_t = QAction("导出两张测试图到文件夹…", self)
        act_export_t.triggered.connect(self._export_test_images)
        tb.addAction(act_export_t)

    # -------------------------------------------------------------- 关闭
    def closeEvent(self, event):
        if self.worker is not None and self.worker.isRunning():
            self.statusBar().showMessage("等待后台处理结束…")
            self.worker.wait(5000)
        event.accept()

    # -------------------------------------------------------------- 文件
    def _open_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开图片", "",
            "图片 (*.png *.tif *.tiff *.bmp *.jpg *.jpeg *.gif)")
        if not path:
            return
        try:
            img = load_image(path)
        except IOError as e:
            QMessageBox.warning(self, "打开失败", str(e))
            return
        self._set_image(img, path)

    def _open_synth(self, kind: str):
        if kind == "halftone":
            img = make_halftone_test()
            name = "synthetic_halftone.png"
        else:
            img = make_parallel_lines_test()
            name = "synthetic_parallel_lines.png"
        self._set_image(img, name)
        self.statusBar().showMessage(
            "已生成合成测试图（未保存到磁盘），可直接框选分析", 4000)

    def _export_test_images(self):
        d = QFileDialog.getExistingDirectory(self, "选择测试图保存目录")
        if not d:
            return
        p1 = os.path.join(d, "test_halftone.png")
        p2 = os.path.join(d, "test_parallel_lines.png")
        save_image(make_halftone_test(), p1)
        save_image(make_parallel_lines_test(), p2)
        self.statusBar().showMessage(f"已写出: {p1} ; {p2}", 8000)
        QMessageBox.information(
            self, "测试图已导出",
            f"{p1}\n含已知斜网纹（周期 8px、45°），用于验证去网效果。\n\n"
            f"{p2}\n含真实平行细线（基频 1/5 px、20°），用于检查误伤：\n"
            f"若差图上细线位置出现规律亮暗，说明陷波选宽了。")

    def _set_image(self, img: np.ndarray, path: str):
        self.image = img
        self.image_path = path
        self.setWindowTitle(f"本地去斜网纹工具 — {os.path.basename(path)}")
        self.image_view.set_pixmap(QPixmap.fromImage(ndarray_to_qimage(img)))
        self.compare_view.set_pixmap(None)

        h, w = img.shape[:2]
        side = min(h, w)          # 小图直接用整幅
        x0 = max(0, (w - side) // 2)
        y0 = max(0, (h - side) // 2)
        x1, y1 = min(w, x0 + side), min(h, y0 + side)
        # 极小图兜底：至少 8×8 才做 FFT
        if x1 - x0 < 8 or y1 - y0 < 8:
            self.image_view.set_pixmap(QPixmap.fromImage(ndarray_to_qimage(img)))
            self.statusBar().showMessage("图片过小，无法做频谱分析", 6000)
            return
        self._on_region_changed(x0, y0, x1, y1)
        self.groups = []
        self._new_group()
        self._schedule_process()

    # -------------------------------------------------------------- 分析
    def _on_region_changed(self, x0: int, y0: int, x1: int, y1: int):
        if self.image is None:
            return
        self.region = (x0, y0, x1, y1)
        region_img = self.image[y0:y1, x0:x1]
        self.statusBar().showMessage("正在计算频谱…")
        self.spec = compute_spectrum(region_img)
        self._show_spectrum()
        self._recompute_peaks()
        self.statusBar().showMessage(
            f"分析区域 {x1-x0}×{y1-y0}，频谱 {self.spec.w}×{self.spec.h}", 4000)

    def _show_spectrum(self):
        assert self.spec is not None
        qimg = ndarray_to_qimage(
            np.round(self.spec.display * 255).astype(np.uint8))
        self.spectrum_view.set_pixmap(QPixmap.fromImage(qimg))
        self._rebuild_overlay()

    def _recompute_peaks(self):
        if self.spec is None:
            return
        thr = self.thresh_spin.value() / 100.0
        self.peaks = find_peaks(self.spec, relative_threshold=thr)
        lines = []
        for pk in self.peaks[:8]:
            pair = "成对" if pk.paired else "单峰"
            lines.append(
                f"f=({pk.u:+.4f},{pk.v:+.4f}) 间距{pk.period_px:6.1f}px "
                f"方向{pk.angle_deg:6.1f}° [{pair}]")
        self.peak_label.setText(
            "候选峰（方向=条纹走向，间距=重复周期）:\n" +
            ("\n".join(lines) if lines else "未发现显著周期峰，可降低阈值"))
        self._rebuild_overlay()

    def _rebuild_overlay(self):
        scene = self.spectrum_view.scene()
        if scene is None or self.spec is None:
            return
        for item in self._overlay_items:
            scene.removeItem(item)
        self._overlay_items.clear()

        def add(item):
            item.setZValue(5)
            self._overlay_items.append(item)

        # 候选峰：白圈 + 共轭对连线
        for pk in self.peaks:
            x, y = self.spec.to_pixel(pk.u, pk.v)
            pen = QPen(PEAK_COLOR, 0)
            pen.setCosmetic(True)
            add(scene.addEllipse(QRectF(x - 6, y - 6, 12, 12), pen))
            if pk.paired:
                x2, y2 = self.spec.to_pixel(-pk.u, -pk.v)
                pen2 = QPen(PAIR_COLOR, 0)
                pen2.setCosmetic(True)
                pen2.setStyle(Qt.PenStyle.DotLine)
                add(scene.addLine(float(x), float(y),
                                  float(x2), float(y2), pen2))

        # 陷波选区（当前组高亮，其他组半透明）；自动画出共轭配对
        cur = self._current_group()
        for gi, grp in enumerate(self.groups):
            color = GROUP_COLORS[gi % len(GROUP_COLORS)]
            for n in grp.notches:
                active = grp.enabled
                c = QColor(color)
                c.setAlpha(220 if (active and grp is cur) else
                           (120 if active else 50))
                pen = QPen(c, 0)
                pen.setCosmetic(True)
                brush = QBrush(QColor(c.red(), c.green(), c.blue(),
                                      45 if active else 18))
                for u, v in ((n.u, n.v), (-n.u, -n.v)):
                    x, y = self.spec.to_pixel(u, v)
                    rx = max(n.ru * self.spec.w, 2.0)
                    ry = max(n.rv * self.spec.h, 2.0)
                    add(scene.addEllipse(
                        QRectF(x - rx, y - ry, 2 * rx, 2 * ry), pen, brush))

    def _on_spectrum_cursor(self, x: float, y: float):
        if self.spec is None:
            return
        u, v = self.spec.to_freq(x, y)
        f = math.hypot(u, v)
        period = 1.0 / f if f > 1e-9 else float("inf")
        angle = math.degrees(math.atan2(-u, v))
        self.cursor_label.setText(
            f"频谱像素({x:6.1f},{y:6.1f})  频率({u:+.4f},{v:+.4f}) cyc/px"
            f"  间距 {period:7.1f}px  方向 {angle:6.1f}°")

    # -------------------------------------------------------------- 选区
    def _on_spectrum_point(self, x: float, y: float):
        if self.spec is None or (grp := self._current_group()) is None:
            return
        n = notch_from_pixels(x, y, self.spec, float(self.radius_spin.value()))
        grp.notches.append(n)
        self._after_notch_changed()

    def _on_spectrum_rect(self, x0: float, y0: float, x1: float, y1: float):
        if self.spec is None or (grp := self._current_group()) is None:
            return
        n = ellipse_from_pixel_rect(x0, y0, x1, y1, self.spec)
        grp.notches.append(n)
        self._after_notch_changed()

    def _after_notch_changed(self):
        self._refresh_notch_list()
        self._rebuild_overlay()
        self._schedule_process()

    # -------------------------------------------------------------- 分组
    def _current_group(self) -> NotchGroup | None:
        row = self.group_list.currentRow()
        if 0 <= row < len(self.groups):
            return self.groups[row]
        return self.groups[0] if self.groups else None

    def _new_group(self):
        idx = len(self.groups) + 1
        grp = NotchGroup(name=f"组 {idx}")
        self.groups.append(grp)
        self._refresh_group_list()
        self.group_list.setCurrentRow(len(self.groups) - 1)
        self._schedule_process()

    def _delete_group(self):
        row = self.group_list.currentRow()
        if not 0 <= row < len(self.groups) or len(self.groups) == 1:
            self.statusBar().showMessage("至少保留一个组", 3000)
            return
        del self.groups[row]
        self._refresh_group_list()
        self.group_list.setCurrentRow(min(row, len(self.groups) - 1))
        self._schedule_process()

    def _rename_group(self):
        grp = self._current_group()
        if grp is None:
            return
        name, ok = QInputDialog.getText(self, "重命名组", "组名：", text=grp.name)
        if ok and name.strip():
            grp.name = name.strip()
            self._refresh_group_list()

    def _on_group_selected(self, _row: int):
        self._refresh_notch_list()
        self._rebuild_overlay()

    def _refresh_group_list(self):
        self._suspend_process = True
        # 重建列表期间屏蔽 itemChanged，避免每个条目都触发一次重算
        self.group_list.blockSignals(True)
        self.group_list.clear()
        for gi, grp in enumerate(self.groups):
            item = QListWidgetItem(
                f"{'●' if grp.enabled else '○'} {grp.name}"
                f"（{len(grp.notches)} 个选区）")
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            item.setCheckState(Qt.CheckState.Checked
                               if grp.enabled else Qt.CheckState.Unchecked)
            item.setForeground(GROUP_COLORS[gi % len(GROUP_COLORS)])
            self.group_list.addItem(item)
        self.group_list.blockSignals(False)
        self._suspend_process = False
        self._refresh_notch_list()

    def _on_group_check(self, item: QListWidgetItem):
        row = self.group_list.row(item)
        if 0 <= row < len(self.groups):
            self.groups[row].enabled = (
                item.checkState() == Qt.CheckState.Checked)
            item.setText(f"{'●' if self.groups[row].enabled else '○'} "
                         f"{self.groups[row].name}"
                         f"（{len(self.groups[row].notches)} 个选区）")
            self._rebuild_overlay()
            if not self._suspend_process:
                self._schedule_process()

    def _refresh_notch_list(self):
        self.notch_list.clear()
        grp = self._current_group()
        if grp is None:
            return
        for i, n in enumerate(grp.notches):
            kind = "点" if n.kind == "point" else "椭圆"
            self.notch_list.addItem(
                f"#{i+1} {kind} @ ({n.u:+.4f},{n.v:+.4f})"
                f" r=({n.ru:.4f},{n.rv:.4f})，自动含共轭对")

    def _delete_notch(self):
        grp = self._current_group()
        row = self.notch_list.currentRow()
        if grp is None or not 0 <= row < len(grp.notches):
            return
        del grp.notches[row]
        self._after_notch_changed()

    def _clear_group(self):
        grp = self._current_group()
        if grp is None:
            return
        grp.notches.clear()
        self._after_notch_changed()

    # -------------------------------------------------------------- 处理
    def _schedule_process(self):
        if self.image is None or self._suspend_process:
            return
        self._debounce.start(200)

    def _start_process(self):
        if self.image is None or self._suspend_process:
            return
        if self.worker is not None and self.worker.isRunning():
            self._queued = True
            return
        self.statusBar().showMessage("正在从原图重新计算…")
        self.worker = ProcessWorker(
            self.image, self.groups,
            self.feather_spin.value(), self.gain_spin.value(), self)
        self.worker.done.connect(self._on_process_done)
        self.worker.failed.connect(self._on_process_failed)
        self.worker.finished.connect(self._on_worker_finished)
        self.worker.start()

    def _on_worker_finished(self):
        if self._queued:
            self._queued = False
            QTimer.singleShot(0, self._start_process)

    def _on_process_done(self, processed: np.ndarray, diff: np.ndarray):
        self._processed = processed
        self._diff = diff
        self._refresh_compare()
        n = sum(len(g.notches) for g in self.groups if g.enabled)
        self.statusBar().showMessage(
            f"完成：{n} 个启用选区，所有通道均从原图重算", 4000)

    def _on_process_failed(self, msg: str):
        self.statusBar().showMessage(f"处理失败: {msg}", 10000)
        QMessageBox.warning(self, "处理失败", msg)

    def _refresh_compare(self):
        if self.image is None:
            return
        mode = self.mode_group.checkedId()
        if mode == 1:
            arr = self.image
        elif mode == 2:
            arr = getattr(self, "_diff", None)
            if arr is None:
                return
        else:
            arr = getattr(self, "_processed", None)
            if arr is None:
                self.compare_view.set_pixmap(None)
                return
        self.compare_view.set_pixmap(
            QPixmap.fromImage(ndarray_to_qimage(arr)))

    # -------------------------------------------------------------- 配置
    def _save_config(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "保存选区配置", "notches.json", "JSON (*.json)")
        if not path:
            return
        data = {
            "feather_cpp": self.feather_spin.value(),
            "groups": [g.to_dict() for g in self.groups],
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.statusBar().showMessage(f"配置已保存: {path}", 4000)

    def _load_config(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "载入选区配置", "", "JSON (*.json)")
        if not path:
            return
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            self.groups = [NotchGroup.from_dict(g) for g in data["groups"]]
            if "feather_cpp" in data:
                self.feather_spin.setValue(float(data["feather_cpp"]))
        except (OSError, KeyError, TypeError, ValueError) as e:
            QMessageBox.warning(self, "载入失败", f"配置文件无效: {e}")
            return
        self._refresh_group_list()
        self.group_list.setCurrentRow(0)
        self._rebuild_overlay()
        self._schedule_process()

    # -------------------------------------------------------------- 导出
    def _export(self):
        if self.image is None:
            return
        arr = getattr(self, "_processed", None)
        if arr is None:
            QMessageBox.information(self, "提示", "还没有处理结果")
            return
        base, ext = os.path.splitext(self.image_path or "image.png")
        default = base + "_descreen.png"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出处理后的图", default,
            "PNG (*.png);;TIFF (*.tif);;BMP (*.bmp);;JPEG (*.jpg)")
        if not path:
            return
        try:
            save_image(arr, path)
        except IOError as e:
            QMessageBox.warning(self, "导出失败", str(e))
            return
        self.statusBar().showMessage(f"已导出: {path}", 6000)
