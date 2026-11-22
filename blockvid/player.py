"""PySide6 图形界面: 编码、按帧时刻回放、块检视、损坏演示、存储对照、导出核对。"""
import os

import numpy as np
from PySide6.QtCore import Qt, QThread, QTimer, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QFileDialog, QFormLayout, QGroupBox, QHBoxLayout,
    QLabel, QMainWindow, QMessageBox, QProgressBar, QPushButton, QSlider,
    QSpinBox, QSplitter, QTextEdit, QVBoxLayout, QWidget,
)

from .decoder import CorruptError, Decoder
from .encoder import encode
from .synth import make_corrupt_copy, make_synth


def fmt_bytes(n):
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


class EncodeThread(QThread):
    done = Signal(dict)
    failed = Signal(str)

    def __init__(self, src, out, bw, bh, keyint):
        super().__init__()
        self.args = (src, out, bw, bh, keyint)

    def run(self):
        try:
            self.done.emit(encode(*self.args))
        except Exception as e:
            self.failed.emit(str(e))


class TimelineSlider(QSlider):
    """带关键帧刻度(绿)和损坏区间(红)的进度条。"""

    def __init__(self):
        super().__init__(Qt.Horizontal)
        self.key_frames = []
        self.bad_ranges = []

    def paintEvent(self, ev):
        super().paintEvent(ev)
        if self.maximum() <= 0:
            return
        p = QPainter(self)
        w = self.width()
        for k in self.key_frames:
            x = int(k / self.maximum() * (w - 8)) + 4
            p.setPen(QPen(QColor(60, 200, 90), 2))
            p.drawLine(x, self.height() - 8, x, self.height() - 2)
        p.setPen(QPen(QColor(220, 60, 60), 3))
        for lo, hi in self.bad_ranges:
            x1 = int(lo / self.maximum() * (w - 8)) + 4
            x2 = int(max(hi - 1, lo) / self.maximum() * (w - 8)) + 4
            p.drawLine(x1, 4, x2, 4)
        p.end()


class VideoLabel(QLabel):
    """显示帧画面, 可叠加已保存小块的矩形框。"""

    def __init__(self):
        super().__init__("打开或编码一段视频开始")
        self.setAlignment(Qt.AlignCenter)
        self.setMinimumSize(320, 180)
        self.setStyleSheet("background:#111; color:#888;")
        self._frame = None
        self._blocks = []
        self.show_blocks = True

    def set_frame(self, rgba: np.ndarray, blocks):
        self._frame = rgba
        self._blocks = blocks
        self._render()

    def set_message(self, text):
        self._frame = None
        self.setText(text)

    def resizeEvent(self, ev):
        super().resizeEvent(ev)
        self._render()

    def _render(self):
        if self._frame is None:
            return
        h, w = self._frame.shape[:2]
        img = QImage(self._frame.data, w, h, w * 4,
                     QImage.Format_RGBA8888).copy()
        pm = QPixmap.fromImage(img).scaled(
            self.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation)
        if self.show_blocks and self._blocks:
            sx = pm.width() / w
            sy = pm.height() / h
            p = QPainter(pm)
            p.setPen(QPen(QColor(255, 200, 40, 200), 1))
            for x, y, bw, bh in self._blocks:
                p.drawRect(int(x * sx), int(y * sy),
                           max(1, int(bw * sx)), max(1, int(bh * sy)))
            p.end()
        self.setPixmap(pm)


class MainWindow(QMainWindow):
    def __init__(self, bvd_path=None):
        super().__init__()
        self.setWindowTitle("块式录屏草稿回放实验")
        self.resize(1100, 720)
        self.dec = None
        self.cur = 0
        self.playing = False
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self._tick)

        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        # 左侧: 画面 + 时间轴 + 播放控制
        left = QVBoxLayout()
        self.video = VideoLabel()
        left.addWidget(self.video, 1)
        self.slider = TimelineSlider()
        self.slider.sliderMoved.connect(self._seek)
        left.addWidget(self.slider)
        controls = QHBoxLayout()
        self.btn_play = QPushButton("播放")
        self.btn_play.clicked.connect(self.toggle_play)
        btn_prev = QPushButton("◀ 上一帧")
        btn_prev.clicked.connect(lambda: self.step(-1))
        btn_next = QPushButton("下一帧 ▶")
        btn_next.clicked.connect(lambda: self.step(1))
        self.chk_blocks = QCheckBox("显示已保存小块")
        self.chk_blocks.setChecked(True)
        self.chk_blocks.toggled.connect(self._refresh)
        self.lbl_time = QLabel("--:-- / --:--")
        for wdg in (btn_prev, self.btn_play, btn_next, self.chk_blocks):
            controls.addWidget(wdg)
        controls.addStretch(1)
        controls.addWidget(self.lbl_time)
        left.addLayout(controls)
        self.lbl_frame = QLabel("帧: -")
        left.addWidget(self.lbl_frame)

        # 右侧: 操作 + 信息
        right = QVBoxLayout()
        grp_file = QGroupBox("文件")
        fl = QVBoxLayout(grp_file)
        btn_open_v = QPushButton("打开视频并编码…")
        btn_open_v.clicked.connect(self.open_video)
        btn_open_b = QPushButton("打开 .bvd…")
        btn_open_b.clicked.connect(self.open_bvd)
        btn_synth = QPushButton("生成合成测试片并编码")
        btn_synth.clicked.connect(self.make_synth)
        btn_corrupt = QPushButton("生成损坏副本并打开")
        btn_corrupt.clicked.connect(self.make_corrupt)
        for b in (btn_open_v, btn_open_b, btn_synth, btn_corrupt):
            fl.addWidget(b)
        form = QFormLayout()
        self.spin_bw = QSpinBox(); self.spin_bw.setRange(8, 512); self.spin_bw.setValue(64)
        self.spin_bh = QSpinBox(); self.spin_bh.setRange(8, 512); self.spin_bh.setValue(64)
        self.spin_key = QSpinBox(); self.spin_key.setRange(1, 1000); self.spin_key.setValue(30)
        form.addRow("块宽", self.spin_bw)
        form.addRow("块高", self.spin_bh)
        form.addRow("关键帧间隔", self.spin_key)
        fl.addLayout(form)
        self.progress = QProgressBar()
        self.progress.setVisible(False)
        fl.addWidget(self.progress)
        right.addWidget(grp_file)

        grp_info = QGroupBox("存储对照 / 帧信息")
        il = QVBoxLayout(grp_info)
        self.txt_info = QTextEdit()
        self.txt_info.setReadOnly(True)
        il.addWidget(self.txt_info)
        right.addWidget(grp_info, 1)

        grp_exp = QGroupBox("导出核对")
        el = QVBoxLayout(grp_exp)
        self.spin_exp = QSpinBox()
        self.spin_exp.setRange(0, 0)
        row = QHBoxLayout()
        row.addWidget(QLabel("帧号"))
        row.addWidget(self.spin_exp)
        btn_exp = QPushButton("导出该帧 PNG")
        btn_exp.clicked.connect(self.export_frame)
        row.addWidget(btn_exp)
        el.addLayout(row)
        self.cmb_src = QComboBox()
        self.cmb_src.setEditable(True)
        el.addWidget(self.cmb_src)
        btn_verify = QPushButton("与源视频逐像素核对")
        btn_verify.clicked.connect(self.verify_all)
        el.addWidget(btn_verify)
        right.addWidget(grp_exp)
        right.addStretch(1)

        split = QSplitter()
        lw = QWidget(); lw.setLayout(left)
        rw = QWidget(); rw.setLayout(right); rw.setMinimumWidth(320)
        split.addWidget(lw); split.addWidget(rw)
        split.setStretchFactor(0, 1)
        root.addWidget(split)

        self.src_path = None
        if bvd_path:
            self.load_bvd(bvd_path)

    # ---- 文件操作 ----

    def open_video(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择视频(≤30s)", "", "视频 (*.mp4 *.mov *.mkv *.avi *.webm);;所有文件 (*)")
        if path:
            self.src_path = path
            self.encode_video(path)

    def encode_video(self, path):
        out = os.path.splitext(path)[0] + ".bvd"
        self.progress.setVisible(True)
        self.progress.setRange(0, 0)
        self.enc_thread = EncodeThread(
            path, out, self.spin_bw.value(), self.spin_bh.value(),
            self.spin_key.value())
        self.enc_thread.done.connect(lambda s: self._encoded(out, s))
        self.enc_thread.failed.connect(self._error)
        self.enc_thread.start()

    def _encoded(self, out, stats):
        self.progress.setVisible(False)
        self.load_bvd(out)

    def open_bvd(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开 .bvd", "", "BVD (*.bvd);;所有文件 (*)")
        if path:
            self.load_bvd(path)

    def make_synth(self):
        out, _ = QFileDialog.getSaveFileName(
            self, "保存合成测试片", "synth.mp4", "MP4 (*.mp4)")
        if not out:
            return
        try:
            make_synth(out)
        except Exception as e:
            self._error(str(e))
            return
        self.src_path = out
        self.encode_video(out)

    def make_corrupt(self):
        if not self.dec:
            self._error("请先打开一个 .bvd")
            return
        try:
            out, idx = make_corrupt_copy(self.bvd_path)
        except Exception as e:
            self._error(str(e))
            return
        QMessageBox.information(
            self, "损坏副本", f"已破坏第 {idx} 帧的记录并生成:\n{out}")
        self.load_bvd(out)

    def load_bvd(self, path):
        try:
            self.dec = Decoder(path)
        except Exception as e:
            self._error(str(e))
            return
        self.bvd_path = path
        self.pause()
        self.cur = 0
        n = self.dec.max_frame
        self.slider.setMaximum(max(n, 0))
        self.slider.key_frames = [f.index for f in self.dec.frames if f.is_key]
        self.slider.bad_ranges = self.dec.affected_ranges
        self.spin_exp.setRange(0, max(n, 0))
        self._show_stats()
        self._show_frame(0)

    # ---- 播放 ----

    def toggle_play(self):
        if self.playing:
            self.pause()
        else:
            self.play()

    def play(self):
        if not self.dec:
            return
        self.playing = True
        self.btn_play.setText("暂停")
        self._schedule_next()

    def pause(self):
        self.playing = False
        self.timer.stop()
        self.btn_play.setText("播放")

    def _schedule_next(self):
        """按原片帧时刻调度下一帧。"""
        if not self.playing or self.dec is None:
            return
        nxt = self.cur + 1
        if nxt > self.dec.max_frame:
            self.pause()
            return
        cur_pts = self.dec._by_index[self.cur].pts_ms if self.cur in self.dec._by_index else 0
        nxt_pts = self.dec._by_index[nxt].pts_ms if nxt in self.dec._by_index else cur_pts + 33
        self.timer.start(max(1, nxt_pts - cur_pts))

    def _tick(self):
        if self.cur < self.dec.max_frame:
            self._show_frame(self.cur + 1)
        self._schedule_next()

    def step(self, delta):
        """暂停后单步, 支持正反两个方向。"""
        if not self.dec:
            return
        self.pause()
        n = min(max(self.cur + delta, 0), self.dec.max_frame)
        self._show_frame(n)

    def _seek(self, pos):
        if not self.dec:
            return
        self._show_frame(pos)

    def _show_frame(self, n):
        self.cur = n
        self.slider.blockSignals(True)
        self.slider.setValue(n)
        self.slider.blockSignals(False)
        fi = self.dec._by_index.get(n)
        pts = fi.pts_ms if fi else n * 33
        total_pts = (self.dec.frames[-1].pts_ms if self.dec.frames else 0)
        self.lbl_time.setText(
            f"{pts/1000:6.2f}s / {total_pts/1000:.2f}s")
        try:
            frame = self.dec.get_frame(n)
            blocks = self.dec.frame_blocks(n)
            self.video.show_blocks = self.chk_blocks.isChecked()
            self.video.set_frame(frame, blocks)
            kind = "关键帧" if fi.is_key else f"增量帧, 保存 {len(blocks)} 块"
            self.lbl_frame.setText(
                f"帧 {n}  pts={pts}ms  [{kind}]  "
                f"记录 {fi.record_len} B")
        except CorruptError as e:
            self.video.set_message(f"帧 {n} 数据损坏/缺失\n受影响范围: {e.ranges}")
            self.lbl_frame.setText(f"帧 {n}  [损坏]")
        self._show_frame_info(n)

    def _refresh(self):
        if self.dec:
            self._show_frame(self.cur)

    # ---- 信息面板 ----

    def _show_stats(self):
        s = self.dec.stats()
        ratio = s["file_bytes"] / s["raw_bytes"] if s["raw_bytes"] else 0
        lines = [
            f"画面: {self.dec.width}x{self.dec.height}  "
            f"块: {self.dec.header['block_w']}x{self.dec.header['block_h']}  "
            f"关键帧间隔: {self.dec.header['keyint']}",
            f"帧数: {s['frames']} (关键帧 {s['key_frames']}, 增量帧 {s['delta_frames']})",
            "",
            f"完整帧存储:   {fmt_bytes(s['key_bytes'])}",
            f"变化内容存储: {fmt_bytes(s['delta_bytes'])}  (共 {s['blocks_saved']} 块)",
            f".bvd 总大小:  {fmt_bytes(s['file_bytes'])}",
            f"原始 RGBA:    {fmt_bytes(s['raw_bytes'])}",
            f"压缩比:       {ratio:.2%}",
        ]
        if s["affected_ranges"]:
            lines += ["", "⚠ 损坏影响范围(帧号区间, 前闭后开):"]
            lines += [f"  [{lo}, {hi})" for lo, hi in s["affected_ranges"]]
            lines += [f"  原因: {c['reason']} @0x{c['offset']:x}"
                      for c in s["corrupt_records"]]
        self.txt_info.setPlainText("\n".join(lines))

    def _show_frame_info(self, n):
        base = self.txt_info.toPlainText().split("\n── 当前帧")[0]
        fi = self.dec._by_index.get(n)
        extra = ["", f"── 当前帧 {n} ──"]
        if fi is None:
            extra.append("记录缺失")
        else:
            extra.append(
                f"类型: {'关键帧' if fi.is_key else '增量帧'}  "
                f"pts={fi.pts_ms}ms  记录 {fi.record_len} B  "
                f"{'⚠受影响' if fi.affected else '完好'}")
            if not fi.is_key and not fi.affected:
                try:
                    for x, y, w, h in self.dec.frame_blocks(n):
                        extra.append(f"  块 @({x},{y}) {w}x{h}")
                except Exception as e:
                    extra.append(f"  块解析失败: {e}")
        self.txt_info.setPlainText(base + "\n".join(extra))

    # ---- 导出与核对 ----

    def export_frame(self):
        if not self.dec:
            return
        from .verify import export_frames
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        idx = self.spin_exp.value()
        src = self.cmb_src.currentText().strip() or None
        try:
            rows = export_frames(self.bvd_path, out_dir, [idx], src)
            QMessageBox.information(
                self, "导出完成",
                "\n".join(f"{r['restored']}"
                          + (f"  一致={r.get('identical')}" if "identical" in r else "")
                          for r in rows))
        except Exception as e:
            self._error(str(e))

    def verify_all(self):
        if not self.dec:
            return
        src = self.cmb_src.currentText().strip() or self.src_path
        if not src:
            src, _ = QFileDialog.getOpenFileName(self, "选择源视频")
            if not src:
                return
        from .verify import verify
        self.progress.setVisible(True)
        self.progress.setRange(0, 0)
        try:
            rep = verify(self.bvd_path, src)
        except Exception as e:
            self._error(str(e))
            return
        finally:
            self.progress.setVisible(False)
        if rep["mismatch"] or rep["corrupt"]:
            QMessageBox.warning(
                self, "核对结果",
                f"共 {rep['total']} 帧\n不一致: {rep['mismatch'][:10]}\n"
                f"损坏: {rep['corrupt'][:10]}")
        else:
            QMessageBox.information(
                self, "核对结果",
                f"{rep['total']} 帧全部逐像素一致, 无损模式没有丢小变化")

    def _error(self, msg):
        self.progress.setVisible(False)
        QMessageBox.critical(self, "错误", msg)


def run(bvd_path=None):
    import sys
    from PySide6.QtWidgets import QApplication
    app = QApplication(sys.argv)
    win = MainWindow(bvd_path)
    win.show()
    sys.exit(app.exec())
