"""PySide6 图形界面:条带试修工具。

启动:  python app.py            (或 python app.py 视频路径)
"""
from __future__ import annotations

import sys

import cv2
import numpy as np
from PySide6.QtCore import Qt, QThread, QTimer, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFileDialog, QFormLayout, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QProgressDialog,
    QPushButton, QSlider, QSpinBox, QDoubleSpinBox, QVBoxLayout, QWidget,
)

from bandfix.core import detect_cuts, repair_frame, shot_of
from bandfix.exporter import export_video


class VideoSource:
    """随机访问的帧源(预览用,量小无所谓 seek 开销)。"""

    def __init__(self, path: str):
        self.path = path
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise IOError(f"无法打开视频: {path}")
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.n = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self._idx = -1

    def frame(self, i: int) -> np.ndarray:
        i = max(0, min(i, self.n - 1))
        if i != self._idx:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            self._idx = i
        ok, f = self.cap.read()
        if not ok:
            raise IOError(f"读取第 {i} 帧失败")
        self._idx = i + 1
        return f


class ExportWorker(QThread):
    progressed = Signal(int, int)
    done = Signal(dict)
    failed = Signal(str)

    def __init__(self, **kw):
        super().__init__()
        self.kw = kw

    def run(self):
        try:
            info = export_video(progress=lambda d, t: self.progressed.emit(d, t),
                                **self.kw)
            self.done.emit(info)
        except Exception as e:  # noqa: BLE001
            self.failed.emit(str(e))


class MainWindow(QMainWindow):
    def __init__(self, path: str | None = None):
        super().__init__()
        self.setWindowTitle("条带试修 bandfix")
        self.src: VideoSource | None = None
        self.cuts: list[int] = []
        self.idx = 0
        self.show_original = False

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._next_frame)

        # ---- 画面区
        self.video = QLabel("打开视频或先生成样例:\npython -m bandfix.cli sample --outdir samples")
        self.video.setAlignment(Qt.AlignCenter)
        self.video.setMinimumSize(640, 360)
        self.video.setStyleSheet("background:#202020;color:#aaa")

        # ---- 走带控制
        self.pos = QSlider(Qt.Horizontal)
        self.pos.sliderMoved.connect(self._seek)
        self.btn_play = QPushButton("播放")
        self.btn_play.clicked.connect(self._toggle_play)
        self.btn_prev = QPushButton("⟨ 上一帧")
        self.btn_prev.clicked.connect(lambda: self._step(-1))
        self.btn_next = QPushButton("下一帧 ⟩")
        self.btn_next.clicked.connect(lambda: self._step(1))
        self.lbl_frame = QLabel("-")
        self.lbl_shot = QLabel("")

        transport = QHBoxLayout()
        for w in (self.btn_play, self.btn_prev, self.btn_next, self.pos,
                  self.lbl_frame):
            transport.addWidget(w)

        # ---- 参数区
        self.sp_y0 = QSpinBox(maximum=10000, value=168)
        self.sp_y1 = QSpinBox(maximum=10000, value=184)
        self.cb_method = QComboBox()
        self.cb_method.addItem("A · 空间插值(仅当前帧)", "spatial")
        self.cb_method.addItem("B · 时域参考(同镜头邻帧)", "temporal")
        self.cb_method.setCurrentIndex(1)
        self.sl_strength = QSlider(Qt.Horizontal, minimum=0, maximum=100, value=85)
        self.lbl_strength = QLabel("0.85")
        self.sl_strength.valueChanged.connect(
            lambda v: self.lbl_strength.setText(f"{v / 100:.2f}"))
        self.sp_radius = QSpinBox(minimum=1, maximum=8, value=2)
        self.sp_cut = QDoubleSpinBox(minimum=0.05, maximum=1.0, singleStep=0.05,
                                     value=0.15)
        self.sp_cut.valueChanged.connect(self._recut)

        form = QFormLayout()
        row = QHBoxLayout()
        row.addWidget(self.sp_y0)
        row.addWidget(QLabel("到"))
        row.addWidget(self.sp_y1)
        form.addRow("条带行 y", row)
        form.addRow("重建方案", self.cb_method)
        row2 = QHBoxLayout()
        row2.addWidget(self.sl_strength)
        row2.addWidget(self.lbl_strength)
        form.addRow("修复强度", row2)
        form.addRow("时域半径(帧)", self.sp_radius)
        form.addRow("切镜阈值", self.sp_cut)
        form.addRow("", self.lbl_shot)

        self.chk_orig = QCheckBox("对照原片(同一帧,不改播放位置)")
        self.chk_orig.toggled.connect(self._toggle_orig)

        self.btn_open = QPushButton("打开视频…")
        self.btn_open.clicked.connect(self._open)
        self.btn_export = QPushButton("导出修复(无损 mkv + 原音轨)")
        self.btn_export.clicked.connect(self._export)
        self.btn_export.setEnabled(False)

        side = QVBoxLayout()
        side.addWidget(self.btn_open)
        g = QGroupBox("修复参数")
        g.setLayout(form)
        side.addWidget(g)
        side.addWidget(self.chk_orig)
        side.addWidget(self.btn_export)
        side.addStretch(1)

        root = QVBoxLayout()
        body = QHBoxLayout()
        body.addWidget(self.video, 1)
        body.addLayout(side)
        root.addLayout(body, 1)
        root.addLayout(transport)
        w = QWidget()
        w.setLayout(root)
        self.setCentralWidget(w)

        for sig in (self.sp_y0.valueChanged, self.sp_y1.valueChanged,
                    self.sp_radius.valueChanged):
            sig.connect(self._refresh)
        self.cb_method.currentIndexChanged.connect(self._refresh)
        self.sl_strength.valueChanged.connect(self._refresh)

        if path:
            self._load(path)

    # ------------------------------------------------------------ 装载
    def _open(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开视频", "", "视频 (*.mkv *.mp4 *.mov *.avi);;全部 (*)")
        if path:
            self._load(path)

    def _load(self, path: str):
        try:
            self.src = VideoSource(path)
            self.cuts = detect_cuts(path, thresh=self.sp_cut.value())
        except Exception as e:  # noqa: BLE001
            QMessageBox.critical(self, "打开失败", str(e))
            return
        self.sp_y0.setMaximum(self.src.h - 1)
        self.sp_y1.setMaximum(self.src.h)
        self.pos.setMaximum(self.src.n - 1)
        self.btn_export.setEnabled(True)
        self.idx = 0
        self.setWindowTitle(f"条带试修 — {path}")
        self._refresh()

    def _recut(self):
        if self.src:
            self.cuts = detect_cuts(self.src.path, thresh=self.sp_cut.value())
            self._refresh()

    # ------------------------------------------------------------ 走带
    def _toggle_play(self):
        if self.timer.isActive():
            self.timer.stop()
            self.btn_play.setText("播放")
        elif self.src:
            self.timer.start(int(1000 / self.src.fps))
            self.btn_play.setText("暂停")

    def _next_frame(self):
        if not self.src:
            return
        if self.idx >= self.src.n - 1:
            self._toggle_play()
            return
        self.idx += 1
        self._refresh()

    def _step(self, d: int):
        if self.src:
            self.idx = max(0, min(self.idx + d, self.src.n - 1))
            self._refresh()

    def _seek(self, v: int):
        self.idx = v
        self._refresh()

    def _toggle_orig(self, on: bool):
        # 只切换显示内容,帧号/播放状态一律不动
        self.show_original = on
        self._refresh()

    # ------------------------------------------------------------ 渲染
    def _current(self) -> np.ndarray:
        f = self.src.frame(self.idx)
        if self.show_original:
            return f
        return repair_frame(self.src.frame, self.idx,
                            self.sp_y0.value(), self.sp_y1.value(),
                            method=self.cb_method.currentData(),
                            strength=self.sl_strength.value() / 100,
                            radius=self.sp_radius.value(), cuts=self.cuts)

    def _refresh(self):
        if not self.src:
            return
        frame = self._current()
        # 条带选区描边(画在显示副本上,不进算法)
        disp = frame.copy()
        y0, y1 = self.sp_y0.value(), self.sp_y1.value()
        cv2.rectangle(disp, (0, y0), (self.src.w - 1, y1 - 1), (0, 0, 255), 1)
        rgb = cv2.cvtColor(disp, cv2.COLOR_BGR2RGB)
        img = QImage(rgb.data, self.src.w, self.src.h,
                     self.src.w * 3, QImage.Format_RGB888)
        self.video.setPixmap(QPixmap.fromImage(img).scaled(
            self.video.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))
        self.pos.blockSignals(True)
        self.pos.setValue(self.idx)
        self.pos.blockSignals(False)
        self.lbl_frame.setText(f"{self.idx + 1}/{self.src.n}"
                               + (" ·原片" if self.show_original else ""))
        s, e = shot_of(self.idx, self.cuts)
        end = str(e) if e < (1 << 30) else "尾"
        self.lbl_shot.setText(
            f"镜头 [{s}, {end}) · 切点 {self.cuts if self.cuts else '无'}")

    # ------------------------------------------------------------ 导出
    def _export(self):
        dst, _ = QFileDialog.getSaveFileName(
            self, "导出到", "repaired.mkv", "Matroska (*.mkv)")
        if not dst:
            return
        dlg = QProgressDialog("导出中…", "取消", 0, self.src.n, self)
        dlg.setWindowModality(Qt.WindowModal)
        self.worker = ExportWorker(
            src=self.src.path, dst=dst,
            y0=self.sp_y0.value(), y1=self.sp_y1.value(),
            method=self.cb_method.currentData(),
            strength=self.sl_strength.value() / 100,
            radius=self.sp_radius.value(),
            cut_thresh=self.sp_cut.value())
        self.worker.progressed.connect(
            lambda d, t: (dlg.setMaximum(t), dlg.setValue(d)))
        self.worker.done.connect(
            lambda info: (dlg.close(), QMessageBox.information(
                self, "导出完成",
                f"{info['dst']}\n帧数 {info['frames']} · 切点 {info['cuts']}\n"
                f"可用 python -m bandfix.cli verify 核对")))
        self.worker.failed.connect(
            lambda msg: (dlg.close(), QMessageBox.critical(self, "导出失败", msg)))
        dlg.canceled.connect(self.worker.terminate)
        self.worker.start()
        dlg.show()


def main():
    app = QApplication(sys.argv)
    win = MainWindow(sys.argv[1] if len(sys.argv) > 1 else None)
    win.resize(1100, 520)
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
