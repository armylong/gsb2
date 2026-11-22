"""PySide6 界面: 对照预览、像素探针、亮部告警、灰阶采样、导出与回读校验。"""
import os

import numpy as np
from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QDoubleSpinBox, QFileDialog, QHBoxLayout,
    QLabel, QMainWindow, QMessageBox, QProgressBar, QPushButton, QScrollArea,
    QSlider, QSplitter, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from . import color, testgen, verify, video


def to_qimage(rgb8):
    a = np.ascontiguousarray(rgb8)
    img = QImage(a.data, a.shape[1], a.shape[0], a.strides[0], QImage.Format_RGB888)
    return img.copy()  # 拷贝, 脱离 numpy 缓冲生命周期


class ImageView(QLabel):
    pixelClicked = Signal(int, int)

    def __init__(self, title):
        super().__init__(title)
        self.setAlignment(Qt.AlignCenter)
        self.setMinimumSize(320, 200)
        self.setStyleSheet("background:#202020; color:#aaa;")
        self._img = None
        self._scale = 1.0
        self._off = (0, 0)

    def set_frame(self, rgb8):
        self._img = to_qimage(rgb8)
        self._refresh()

    def resizeEvent(self, e):
        self._refresh()
        super().resizeEvent(e)

    def _refresh(self):
        if self._img is None:
            return
        pm = QPixmap.fromImage(self._img).scaled(
            self.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation)
        self._scale = pm.width() / self._img.width()
        self._off = ((self.width() - pm.width()) // 2, (self.height() - pm.height()) // 2)
        self.setPixmap(pm)

    def mousePressEvent(self, e):
        if self._img is not None and self.pixmap() is not None:
            x = int((e.position().x() - self._off[0]) / self._scale)
            y = int((e.position().y() - self._off[1]) / self._scale)
            if 0 <= x < self._img.width() and 0 <= y < self._img.height():
                self.pixelClicked.emit(x, y)
        super().mousePressEvent(e)


class ExportThread(QThread):
    progressed = Signal(int, int)
    finished_ok = Signal(int)
    failed = Signal(str)

    def __init__(self, src, dst, meta, transfer, primaries, settings, t0, t1):
        super().__init__()
        self.args = (src, dst, meta, transfer, primaries, settings, t0, t1)

    def run(self):
        try:
            n = video.export_sdr(*self.args,
                                 progress=lambda a, b: self.progressed.emit(a, b))
            self.finished_ok.emit(n)
        except Exception as ex:  # noqa: BLE001
            self.failed.emit(str(ex))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"HDR→SDR 亮部映射检查 (管线 v{color.PIPELINE_VERSION})")
        self.resize(1400, 860)
        self.meta = None
        self.transfer = "smpte2084"
        self.primaries = "bt2020"
        self.src_peak = 10000.0
        self.rgb_nits = None       # 当前帧源亮度 (nits)
        self.mapped8 = None        # 当前帧映射输出 (8bit)
        self.ref8 = None           # 对照: 直接裁切
        self.time = 0.0
        self.last_export = None
        self._build_ui()

    # ---------- UI ----------
    def _build_ui(self):
        root = QSplitter()
        panel = QWidget()
        lay = QVBoxLayout(panel)

        self.btn_open = QPushButton("打开视频…")
        self.btn_open.clicked.connect(self.open_file)
        lay.addWidget(self.btn_open)
        row = QHBoxLayout()
        b1 = QPushButton("生成灰阶测试片")
        b1.clicked.connect(lambda: self.make_test("chart"))
        b2 = QPushButton("生成梯度+移动亮块")
        b2.clicked.connect(lambda: self.make_test("gradient"))
        row.addWidget(b1); row.addWidget(b2)
        lay.addLayout(row)

        self.lbl_meta = QLabel("未加载视频")
        self.lbl_meta.setWordWrap(True)
        self.lbl_meta.setStyleSheet("font-family: monospace;")
        lay.addWidget(self.lbl_meta)

        lay.addWidget(QLabel("传递曲线 / 色域 (缺失时手动指定):"))
        row = QHBoxLayout()
        self.cmb_transfer = QComboBox()
        self.cmb_transfer.addItems(["自动", "smpte2084 (PQ)", "hlg", "bt709"])
        self.cmb_transfer.currentIndexChanged.connect(self.reload_frame)
        self.cmb_prim = QComboBox()
        self.cmb_prim.addItems(["自动", "bt2020", "bt709"])
        self.cmb_prim.currentIndexChanged.connect(self.reload_frame)
        row.addWidget(self.cmb_transfer); row.addWidget(self.cmb_prim)
        lay.addLayout(row)

        lay.addWidget(QLabel("亮部映射曲线:"))
        self.cmb_curve = QComboBox()
        self.cmb_curve.addItems([color.CURVES["A"], color.CURVES["B"]])
        self.cmb_curve.currentIndexChanged.connect(self.update_views)
        lay.addWidget(self.cmb_curve)

        row = QHBoxLayout()
        row.addWidget(QLabel("目标峰值(nit):"))
        self.spin_peak = QDoubleSpinBox()
        self.spin_peak.setRange(50.0, 500.0)
        self.spin_peak.setValue(100.0)
        self.spin_peak.valueChanged.connect(self.update_views)
        row.addWidget(self.spin_peak)
        lay.addLayout(row)

        row = QHBoxLayout()
        row.addWidget(QLabel("压缩开始(拐点%):"))
        self.slider_knee = QSlider(Qt.Horizontal)
        self.slider_knee.setRange(10, 95)
        self.slider_knee.setValue(60)
        self.lbl_knee = QLabel("60%")
        self.slider_knee.valueChanged.connect(
            lambda v: (self.lbl_knee.setText(f"{v}%"), self.update_views()))
        row.addWidget(self.slider_knee); row.addWidget(self.lbl_knee)
        lay.addLayout(row)

        self.chk_warn = QCheckBox("亮部告警叠加 (黄=仍可细分, 红=挤到上限)")
        self.chk_warn.stateChanged.connect(self.update_views)
        lay.addWidget(self.chk_warn)
        self.lbl_warn = QLabel("")
        lay.addWidget(self.lbl_warn)

        self.btn_chart = QPushButton("采样灰阶图 (验证读数)")
        self.btn_chart.clicked.connect(self.sample_chart)
        lay.addWidget(self.btn_chart)

        lay.addWidget(QLabel("时间位置:"))
        self.slider_time = QSlider(Qt.Horizontal)
        self.slider_time.setRange(0, 0)
        self.slider_time.valueChanged.connect(self.seek)
        lay.addWidget(self.slider_time)
        self.lbl_time = QLabel("0.00s / 0帧")
        lay.addWidget(self.lbl_time)

        self.btn_export = QPushButton("导出 SDR 短片…")
        self.btn_export.clicked.connect(self.export_sdr)
        lay.addWidget(self.btn_export)
        self.progress = QProgressBar()
        self.progress.setVisible(False)
        lay.addWidget(self.progress)
        self.btn_verify = QPushButton("回读成片校验")
        self.btn_verify.clicked.connect(self.verify_export)
        lay.addWidget(self.btn_verify)

        lay.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setMaximumWidth(400)
        root.addWidget(scroll)

        right = QWidget()
        rl = QVBoxLayout(right)
        views = QHBoxLayout()
        self.view_ref = ImageView("源 (直接裁切到目标峰值)")
        self.view_map = ImageView("映射后")
        self.view_ref.pixelClicked.connect(self.probe_pixel)
        self.view_map.pixelClicked.connect(self.probe_pixel)
        v1 = QVBoxLayout(); v1.addWidget(QLabel("源 (直接裁切)")); v1.addWidget(self.view_ref)
        v2 = QVBoxLayout(); v2.addWidget(QLabel("映射后 (当前曲线)")); v2.addWidget(self.view_map)
        views.addLayout(v1); views.addLayout(v2)
        rl.addLayout(views)
        self.lbl_probe = QLabel("点击画面任意像素查看亮度变化")
        self.lbl_probe.setStyleSheet("font-family: monospace;")
        rl.addWidget(self.lbl_probe)
        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(
            ["类型", "档位(标称)", "实测源nit", "映射后nit", "输出码值"])
        self.table.setMaximumHeight(220)
        rl.addWidget(self.table)
        root.addWidget(right)
        root.setStretchFactor(1, 1)
        self.setCentralWidget(root)

    # ---------- 设置 ----------
    def settings(self):
        return {
            "target_peak": self.spin_peak.value(),
            "knee_frac": self.slider_knee.value() / 100.0,
            "curve": "A" if self.cmb_curve.currentIndex() == 0 else "B",
            "src_peak": self.src_peak,
        }

    def _transfer_override(self):
        i = self.cmb_transfer.currentIndex()
        return [None, "smpte2084", "hlg", "bt709"][i]

    def _prim_override(self):
        i = self.cmb_prim.currentIndex()
        return [None, "bt2020", "bt709"][i]

    # ---------- 文件 ----------
    def open_file(self, path=None):
        if not path:
            path, _ = QFileDialog.getOpenFileName(
                self, "打开视频", "", "视频 (*.mp4 *.mov *.mkv *.mxf *.webm);;所有文件 (*)")
        if not path:
            return
        try:
            self.meta = video.probe(path)
            self._apply_meta()
            self.slider_time.setRange(0, max(0, self.meta["nb_frames"] - 1))
            self.slider_time.setValue(0)
            self.load_frame(0.0)
        except Exception as ex:  # noqa: BLE001
            QMessageBox.critical(self, "打开失败", str(ex))

    def _apply_meta(self):
        m = self.meta
        self.transfer, why_t = video.resolve_transfer(m, self._transfer_override())
        self.primaries, why_p = video.resolve_primaries(m, self._prim_override())
        self.src_peak, why_s = video.src_peak_nits(m, self.transfer)
        self.lbl_meta.setText(
            f"{os.path.basename(m['path'])}\n"
            f"{m['width']}x{m['height']} @{m['fps']:.3f}fps "
            f"{m['nb_frames']}帧 {m['pix_fmt']}\n"
            f"传递曲线: {self.transfer}\n  依据: {why_t}\n"
            f"色域: {self.primaries}\n  依据: {why_p}\n"
            f"量化范围: {m['color_range']}\n"
            f"源峰值: {self.src_peak:.0f}nit ({why_s})")

    def reload_frame(self):
        if self.meta:
            self._apply_meta()
            self.load_frame(self.time)

    def seek(self, frame_idx):
        if self.meta:
            self.load_frame(frame_idx / self.meta["fps"])

    def load_frame(self, t):
        try:
            self.time = t
            self.rgb_nits = video.decode_frame_nits(
                self.meta["path"], t, self.meta, self.transfer, self.primaries)
            self.lbl_time.setText(
                f"{t:.2f}s / 第{int(round(t * self.meta['fps']))}帧")
            self.update_views()
        except Exception as ex:  # noqa: BLE001
            self.lbl_probe.setText(f"解码失败: {ex}")

    # ---------- 映射与显示 ----------
    def update_views(self):
        if self.rgb_nits is None:
            return
        s = self.settings()
        peak = s["target_peak"]
        # 对照: 不做曲线, 直接裁切到目标峰值
        ref = np.clip(self.rgb_nits / peak, 0.0, 1.0)
        if self.primaries == "bt2020":
            ref = np.clip(ref @ color.M_2020_TO_709.T, 0.0, 1.0)
        self.ref8 = color.sdr_encode(ref)
        lin = color.tonemap_frame(self.rgb_nits, self.primaries, peak,
                                  s["knee_frac"], s["curve"], s["src_peak"])
        self.mapped8 = color.sdr_encode(lin)
        show = self.mapped8
        if self.chk_warn.isChecked():
            y_nits = self.rgb_nits @ (color.LUMA_2020 if self.primaries == "bt2020"
                                      else color.LUMA_709)
            cls, stats = color.highlight_classes(
                y_nits, self.mapped8, s["knee_frac"] * peak)
            overlay = self.mapped8.astype(np.float64).copy()
            overlay[cls == 1] = 0.5 * overlay[cls == 1] + 0.5 * np.array([255, 220, 0])
            overlay[cls == 2] = 0.5 * overlay[cls == 2] + 0.5 * np.array([255, 0, 0])
            show = overlay.astype(np.uint8)
            self.lbl_warn.setText(
                f"亮部像素 {stats['highlight_pct']:.1f}% | "
                f"仍可细分 {stats['separable_pct']:.1f}% | "
                f"挤到上限 {stats['clipped_pct']:.1f}%")
        else:
            self.lbl_warn.setText("")
        self.view_ref.set_frame(self.ref8)
        self.view_map.set_frame(show)

    def probe_pixel(self, x, y):
        if self.rgb_nits is None:
            return
        s = self.settings()
        luma = color.LUMA_2020 if self.primaries == "bt2020" else color.LUMA_709
        src_y = float(self.rgb_nits[y, x] @ luma)
        out_y = float(color.map_luminance(
            np.array([src_y]), s["target_peak"], s["knee_frac"],
            s["curve"], s["src_peak"])[0])
        code = float(self.mapped8[y, x] @ np.array([0.2126, 0.7152, 0.0722]))
        knee_nits = s["knee_frac"] * s["target_peak"]
        state = "亮部压缩区" if src_y > knee_nits else "拐点以下(线性)"
        if code >= 254:
            state += ", 已挤到显示上限"
        self.lbl_probe.setText(
            f"像素({x},{y})  源 {src_y:8.2f} nit → 映射 {out_y:7.2f} nit "
            f"(码值 {code:5.1f}/255)  [{state}]  "
            f"拐点 {knee_nits:.0f}nit, 峰值 {s['target_peak']:.0f}nit")

    # ---------- 灰阶采样 ----------
    def sample_chart(self):
        if self.rgb_nits is None:
            return
        s = self.settings()
        h, w = self.rgb_nits.shape[:2]
        pts = testgen.chart_points(w, h)
        luma = color.LUMA_2020 if self.primaries == "bt2020" else color.LUMA_709
        self.table.setRowCount(len(pts))
        for i, pt in enumerate(pts):
            patch = verify.sample_patch(self.rgb_nits, pt["x"], pt["y"])
            src_y = float(patch @ luma)
            out_y = float(color.map_luminance(
                np.array([src_y]), s["target_peak"], s["knee_frac"],
                s["curve"], s["src_peak"])[0])
            code = float(color.bt709_oetf(out_y / s["target_peak"]) * 255.0)
            vals = [pt["kind"], pt["label"], f"{src_y:.2f}", f"{out_y:.2f}", f"{code:.1f}"]
            for j, v in enumerate(vals):
                self.table.setItem(i, j, QTableWidgetItem(v))
        self.lbl_probe.setText("灰阶采样完成: 表内为 标称→实测源→映射后 读数, "
                               "实测源nit 应与标称值接近(编码误差内)")

    # ---------- 导出 ----------
    def export_sdr(self):
        if self.meta is None:
            return
        dst, _ = QFileDialog.getSaveFileName(self, "导出 SDR 短片", "sdr_out.mp4",
                                             "MP4 (*.mp4)")
        if not dst:
            return
        self.progress.setVisible(True)
        self.progress.setValue(0)
        self.btn_export.setEnabled(False)
        self._exp = ExportThread(self.meta["path"], dst, self.meta, self.transfer,
                                 self.primaries, self.settings(), 0.0,
                                 self.meta["duration"])
        self._exp.progressed.connect(
            lambda a, b: (self.progress.setMaximum(b), self.progress.setValue(a)))
        self._exp.finished_ok.connect(self._export_done)
        self._exp.failed.connect(self._export_failed)
        self._exp.start()

    def _export_done(self, n):
        self.progress.setVisible(False)
        self.btn_export.setEnabled(True)
        self.last_export = self._exp.args[1]
        QMessageBox.information(self, "导出完成",
                                f"已导出 {n} 帧到:\n{self.last_export}\n可点“回读成片校验”核对。")

    def _export_failed(self, msg):
        self.progress.setVisible(False)
        self.btn_export.setEnabled(True)
        QMessageBox.critical(self, "导出失败", msg)

    # ---------- 回读校验 ----------
    def verify_export(self):
        path = self.last_export
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "选择导出的成片", "",
                                                  "MP4 (*.mp4);;所有文件 (*)")
        if not path or self.meta is None:
            return
        try:
            comment = verify.probe_comment(path)
            ver_ok = f"pipeline={color.PIPELINE_VERSION}" in comment
            out_meta = video.probe(path)
            w, h = self.meta["width"], self.meta["height"]
            pts = testgen.chart_points(w, h)
            s = self.settings()
            times = [self.meta["duration"] * f for f in (0.1, 0.5, 0.9)]
            all_rows, order_msgs = [], []
            for t in times:
                rgb_nits = video.decode_frame_nits(
                    self.meta["path"], t, self.meta, self.transfer, self.primaries)
                lin = color.tonemap_frame(rgb_nits, self.primaries, s["target_peak"],
                                          s["knee_frac"], s["curve"], s["src_peak"])
                preview8 = color.sdr_encode(lin)
                back8 = verify.readback_frame_rgb(path, t, out_meta["width"],
                                                  out_meta["height"])
                rows = verify.compare_points(pts, preview8, back8)
                ok, bad = verify.check_order(rows)
                order_msgs.append(f"t={t:.2f}s 灰阶顺序 {'正常' if ok else '异常: ' + '; '.join(bad)}")
                for r in rows:
                    r["t"] = t
                all_rows.extend(rows)
            self._show_verify(path, comment, ver_ok, all_rows, order_msgs)
        except Exception as ex:  # noqa: BLE001
            QMessageBox.critical(self, "校验失败", str(ex))

    def _show_verify(self, path, comment, ver_ok, rows, order_msgs):
        dlg = QDialog(self)
        dlg.setWindowTitle("回读校验")
        dlg.resize(760, 560)
        lay = QVBoxLayout(dlg)
        n_bad = sum(1 for r in rows if not r["ok"])
        lay.addWidget(QLabel(
            f"文件: {os.path.basename(path)}\n"
            f"管线版本 {'一致' if ver_ok else '不一致!'} ({comment or '无标记'})\n"
            + "\n".join(order_msgs) + "\n"
            f"读数超差(±{verify.TOLERANCE_CODE}码值)的点: {n_bad}/{len(rows)}"))
        table = QTableWidget(len(rows), 7)
        table.setHorizontalHeaderLabels(
            ["t(s)", "类型", "档位", "预览码值", "回读码值", "Δ", "判定"])
        for i, r in enumerate(rows):
            vals = [f"{r['t']:.2f}", r["kind"], r["label"],
                    f"{r['preview_code']:.1f}", f"{r['back_code']:.1f}",
                    f"{r['delta']:+.1f}", "OK" if r["ok"] else "超差"]
            for j, v in enumerate(vals):
                table.setItem(i, j, QTableWidgetItem(v))
        lay.addWidget(table)
        dlg.exec()
