"""PySide6 GUI：单片声画时间检查器。

时间轴约定：t=0 为视频流起点；音频波形按“音频流相对视频的起点偏移 +
采样时间”绘制，音频早于视频时波形延伸到负时间区（视图保留负偏移）。
点击帧条读闪光帧时间、点击波形读蜂鸣时间，差值可一键设为整体音轨修正量；
预览（波形重影 + 滤镜串）与导出共用 media.build_audio_filter 的同一规则。
"""
from __future__ import annotations

import os
import sys

import numpy as np
from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication, QComboBox, QFileDialog, QHBoxLayout, QInputDialog, QLabel,
    QMainWindow, QMessageBox, QPlainTextEdit, QPushButton, QScrollArea,
    QSpinBox, QVBoxLayout, QWidget,
)

from . import media

PPS = 100          # 每秒像素数
MARGIN = 0.5       # 时间轴两端余量（秒）
STRIP_H = 90
WAVE_H = 140
RULER_H = 24


# ---------------------------------------------------------------- 后台任务

class Worker(QThread):
    done = Signal(object)
    failed = Signal(str)

    def __init__(self, fn, *args):
        super().__init__()
        self._fn, self._args = fn, args

    def run(self):
        try:
            self.done.emit(self._fn(*self._args))
        except Exception as e:  # noqa: BLE001
            self.failed.emit(str(e))


# ---------------------------------------------------------------- 时间轴部件

class TimelineWidget(QWidget):
    """所有时间轴部件共用：t0 起、pps 像素/秒、固定宽度。"""

    def __init__(self, height):
        super().__init__()
        self.t0 = -MARGIN
        self.pps = PPS
        self.setFixedHeight(height)

    def set_range(self, t0, t1):
        self.t0 = t0
        self.setFixedWidth(max(1, round((t1 - t0) * self.pps)))
        self.update()

    def x_of(self, t):
        return (t - self.t0) * self.pps

    def t_of(self, x):
        return self.t0 + x / self.pps


class Ruler(TimelineWidget):
    def __init__(self):
        super().__init__(RULER_H)

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(40, 40, 40))
        p.setPen(QColor(200, 200, 200))
        t = int(self.t0) - 1
        while True:
            x = self.x_of(t)
            if x > self.width():
                break
            p.drawLine(int(x), RULER_H - 8, int(x), RULER_H)
            p.drawText(int(x) + 3, RULER_H - 10, f"{t}s")
            t += 1
        # t=0 参考线
        p.setPen(QPen(QColor(90, 160, 255), 1))
        x0 = int(self.x_of(0.0))
        p.drawLine(x0, 0, x0, RULER_H)
        p.end()


class FrameStrip(TimelineWidget):
    """帧条：按真实显示时间排布缩略帧，点击读取该帧起点时间。"""

    clicked = Signal(float)

    def __init__(self):
        super().__init__(STRIP_H)
        self.frames: list[QImage] = []
        self.fps = media.FPS
        self.vstart = 0.0
        self.marker = None

    def set_frames(self, frames, fps, vstart):
        self.frames = frames
        self.fps = fps
        self.vstart = vstart
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(24, 24, 24))
        if not self.frames:
            p.setPen(QColor(160, 160, 160))
            p.drawText(self.rect(), Qt.AlignCenter, "未加载视频")
            p.end()
            return
        fw = self.pps / self.fps
        for i, img in enumerate(self.frames):
            x = self.x_of(self.vstart + i / self.fps)
            if x + fw < 0 or x > self.width():
                continue
            p.drawImage(int(x), 0, img.scaled(max(1, int(fw) + 1), STRIP_H))
        if self.marker is not None:
            p.setPen(QPen(QColor(255, 80, 80), 2))
            x = int(self.x_of(self.marker))
            p.drawLine(x, 0, x, STRIP_H)
        p.end()

    def mousePressEvent(self, e):
        if not self.frames:
            return
        t = self.t_of(e.position().x())
        i = int((t - self.vstart) * self.fps)
        i = min(max(i, 0), len(self.frames) - 1)
        self.marker = self.vstart + i / self.fps   # 帧起点显示时间
        self.clicked.emit(self.marker)
        self.update()


class WaveformView(TimelineWidget):
    """波形：按音频流相对视频的偏移定位；叠加修正后的预览重影。"""

    clicked = Signal(float)

    def __init__(self):
        super().__init__(WAVE_H)
        self.audio: np.ndarray | None = None
        self.sr = media.SR
        self.astart = 0.0
        self.shift = 0.0          # 预览用修正量（秒），与导出同一规则
        self.marker = None
        self._cache_key = None
        self._minmax = None

    def set_audio(self, data, sr, astart):
        self.audio, self.sr, self.astart = data, sr, astart
        self._cache_key = None
        self.update()

    def set_shift(self, shift):
        self.shift = shift
        self.update()

    def _minmax_per_px(self):
        key = (self.width(), self.pps, id(self.audio))
        if self._cache_key == key:
            return self._minmax
        n = self.width()
        mn = np.zeros(n, np.float32)
        mx = np.zeros(n, np.float32)
        if self.audio is not None and len(self.audio):
            idx0 = ((self.t_of(np.arange(n)) - self.astart) * self.sr).astype(np.int64)
            idx1 = idx0 + max(1, int(self.sr / self.pps))
            for x in range(n):
                a, b = max(idx0[x], 0), min(idx1[x], len(self.audio))
                if a < b:
                    seg = self.audio[a:b]
                    mn[x], mx[x] = seg.min(), seg.max()
        self._cache_key = key
        self._minmax = (mn / 32768.0, mx / 32768.0)
        return self._minmax

    def _draw_wave(self, p, color, dx_px=0):
        mn, mx = self._minmax_per_px()
        mid = WAVE_H / 2
        amp = WAVE_H / 2 - 4
        p.setPen(QPen(color, 1))
        n = self.width()
        for x in range(n):
            y0 = mid - mx[x] * amp
            y1 = mid - mn[x] * amp
            p.drawLine(x + dx_px, int(y0), x + dx_px, int(max(y1, y0 + 1)))

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(18, 24, 18))
        # t=0 参考线
        p.setPen(QPen(QColor(90, 160, 255), 1))
        x0 = int(self.x_of(0.0))
        p.drawLine(x0, 0, x0, WAVE_H)
        if self.audio is None:
            p.setPen(QColor(160, 160, 160))
            p.drawText(self.rect(), Qt.AlignCenter, "未加载音频")
            p.end()
            return
        # 预览重影：按修正量平移后的波形（与导出同一规则）
        if abs(self.shift) > 1e-9:
            self._draw_wave(p, QColor(230, 200, 60, 110),
                            dx_px=int(round(self.shift * self.pps)))
        self._draw_wave(p, QColor(90, 220, 120))
        if self.marker is not None:
            p.setPen(QPen(QColor(80, 160, 255), 2))
            x = int(self.x_of(self.marker))
            p.drawLine(x, 0, x, WAVE_H)
        p.end()

    def mousePressEvent(self, e):
        if self.audio is None:
            return
        self.marker = self.t_of(e.position().x())
        self.clicked.emit(self.marker)
        self.update()


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("单片声画时间检查器")
        self.resize(1100, 760)
        self.path = None
        self.info = None
        self._worker = None
        self._diff = None
        self._last_export = None

        # 顶部按钮
        bar = QHBoxLayout()
        for text, fn in [
            ("生成样例…", self.make_sample),
            ("打开视频…", self.open_file),
            ("自动检测标记", self.auto_detect),
            ("导出修正结果…", self.do_export),
            ("验证输出", self.verify_output),
        ]:
            b = QPushButton(text)
            b.clicked.connect(fn)
            bar.addWidget(b)
        bar.addStretch(1)

        # 时间轴
        self.ruler = Ruler()
        self.strip = FrameStrip()
        self.wave = WaveformView()
        self.strip.clicked.connect(self.on_video_marker)
        self.wave.clicked.connect(self.on_audio_marker)
        tl = QVBoxLayout()
        tl.setSpacing(0)
        tl.addWidget(self.ruler)
        tl.addWidget(self.strip)
        tl.addWidget(self.wave)
        tl_widget = QWidget()
        tl_widget.setLayout(tl)
        scroll = QScrollArea()
        scroll.setWidget(tl_widget)
        scroll.setWidgetResizable(True)

        # 控制面板
        self.lbl_v = QLabel("闪光帧: —")
        self.lbl_a = QLabel("蜂鸣: —")
        self.lbl_diff = QLabel("差值(图-声): —")
        self.spin_corr = QSpinBox()
        self.spin_corr.setRange(-60000, 60000)
        self.spin_corr.setSuffix(" ms")
        self.spin_corr.setSingleStep(10)
        self.btn_apply = QPushButton("把差值设为修正量")
        self.btn_apply.clicked.connect(self.apply_diff)
        self.combo_head = QComboBox()
        self.combo_head.addItems(["头部: 截断 (truncate)", "头部: 补静音 (pad)"])
        self.combo_tail = QComboBox()
        self.combo_tail.addItems(["尾部: 截断 (truncate)", "尾部: 补静音 (pad)"])
        self.lbl_rule = QLabel("修正规则: —")
        self.lbl_rule.setWordWrap(True)
        self.spin_corr.valueChanged.connect(self.update_rule)
        self.combo_head.currentIndexChanged.connect(self.update_rule)
        self.combo_tail.currentIndexChanged.connect(self.update_rule)

        ctl = QHBoxLayout()
        for w in (self.lbl_v, self.lbl_a, self.lbl_diff, QLabel("修正量:"),
                  self.spin_corr, self.btn_apply, self.combo_head, self.combo_tail):
            ctl.addWidget(w)
        ctl.addStretch(1)

        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(2000)

        root = QVBoxLayout()
        root.addLayout(bar)
        root.addWidget(scroll, stretch=1)
        root.addLayout(ctl)
        root.addWidget(self.lbl_rule)
        root.addWidget(self.log, stretch=1)
        w = QWidget()
        w.setLayout(root)
        self.setCentralWidget(w)
        self.set_range(-MARGIN, media.DURATION + MARGIN)
        self.update_rule()
        self.statusBar().showMessage("就绪：可先生成一个内置样例")

    # ------------------------------------------------------------ 工具

    def set_range(self, t0, t1):
        for w in (self.ruler, self.strip, self.wave):
            w.set_range(t0, t1)

    def println(self, msg):
        self.log.appendPlainText(msg)
        self.statusBar().showMessage(msg.splitlines()[-1][:120])

    def _run(self, fn, *args, on_done=None, busy="处理中…"):
        self.statusBar().showMessage(busy)
        self._worker = Worker(fn, *args)
        if on_done:
            self._worker.done.connect(on_done)
        self._worker.failed.connect(
            lambda msg: (QMessageBox.critical(self, "错误", msg),
                         self.statusBar().showMessage("失败")))
        self._worker.start()

    def head_tail(self):
        head = "truncate" if self.combo_head.currentIndex() == 0 else "pad"
        tail = "truncate" if self.combo_tail.currentIndex() == 0 else "pad"
        return head, tail

    def corr_s(self):
        return self.spin_corr.value() / 1000.0

    # ------------------------------------------------------------ 时间轴加载

    def load_path(self, path):
        def job(p):
            frames, fps, vstart = media.decode_frames(p)
            audio, sr, astart = media.extract_audio(p)
            info = media.probe(p)
            return frames, fps, vstart, audio, sr, astart, info

        def done(res):
            frames, fps, vstart, audio, sr, astart, info = res
            self.path, self.info = path, info
            imgs = [QImage(f.data, f.shape[1], f.shape[0], f.shape[1] * 3,
                           QImage.Format_RGB888).copy() for f in frames]
            self.strip.set_frames(imgs, fps, vstart)
            self.wave.set_audio(audio, sr, astart)
            a_end = astart + len(audio) / sr
            v_end = vstart + len(frames) / fps
            self.set_range(min(0.0, astart) - MARGIN, max(v_end, a_end) + MARGIN)
            self.println(f"已加载 {path}\n  视频 {len(frames)} 帧 @{fps:.3f}fps，"
                         f"音频相对视频起点 {astart * 1000:+.1f} ms"
                         f"（负值=音频更早，波形延伸到负时间区）")
            self.update_rule()

        self._run(job, path, on_done=done, busy="解码中…")

    # ------------------------------------------------------------ 动作

    def make_sample(self):
        off, ok = QInputDialog.getInt(
            self, "生成样例", "音轨偏移(ms)，正=声音晚，负=声音早:", 350, -5000, 5000, 50)
        if not ok:
            return
        os.makedirs("samples", exist_ok=True)
        path = os.path.abspath(os.path.join("samples", f"sample_{off:+d}ms.mp4"))
        self._run(media.make_sample, path, off,
                  on_done=lambda p: (self.println(f"样例已生成: {p}"), self.load_path(p)),
                  busy="生成样例中…")

    def open_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开视频", "", "视频文件 (*.mp4 *.mov *.mkv *.avi);;所有文件 (*)")
        if path:
            self.load_path(path)

    def on_video_marker(self, t):
        self.strip.marker = t
        self.strip.update()
        self.lbl_v.setText(f"闪光帧: {t:.3f}s")
        self.update_diff()

    def on_audio_marker(self, t):
        self.wave.marker = t
        self.wave.update()
        self.lbl_a.setText(f"蜂鸣: {t:.3f}s")
        self.update_diff()

    def update_diff(self):
        if self.strip.marker is not None and self.wave.marker is not None:
            d = self.strip.marker - self.wave.marker
            self.lbl_diff.setText(f"差值(图-声): {d * 1000:+.1f}ms")
            self._diff = d

    def apply_diff(self):
        if self._diff is None:
            QMessageBox.information(self, "提示", "请先各点一个闪光帧和一个蜂鸣脉冲")
            return
        self.spin_corr.setValue(round(self._diff * 1000))

    def update_rule(self):
        if not self.info:
            dur = media.DURATION
        else:
            dur = self.info.duration
        head, tail = self.head_tail()
        corr = self.corr_s()
        # 头部选项只在音轨前移(负修正)时有意义；正修正时头部必然补静音
        self.combo_head.setEnabled(corr < 0)
        chain = media.build_audio_filter(corr, head, tail, dur)
        self.wave.set_shift(corr)
        self.lbl_rule.setText(
            f"修正规则（预览重影与导出共用）: 音轨 {'后移' if corr > 0 else '前移' if corr < 0 else '不动'} "
            f"{abs(corr) * 1000:.0f} ms | head={head} tail={tail} | 滤镜: {chain}")

    def auto_detect(self):
        if not self.path:
            QMessageBox.information(self, "提示", "请先加载视频")
            return

        def done(est):
            pairs = est["pairs"]
            f0, b0, _ = pairs[0]
            self.strip.marker = f0
            self.wave.marker = b0
            self.on_video_marker(f0)
            self.on_audio_marker(b0)
            self.strip.update()
            self.wave.update()
            self.spin_corr.setValue(round(est["correction_s"] * 1000))
            lines = [f"检测到 {len(pairs)} 对标记:"]
            for i, (f, b, d) in enumerate(pairs):
                lines.append(f"  #{i} 闪光 {f:.3f}s  蜂鸣 {b:.3f}s  差 {d * 1000:+.1f}ms")
            lines.append(f"建议修正量(中位数): {est['correction_s'] * 1000:+.1f} ms")
            self.println("\n".join(lines))

        self._run(media.suggest_correction, self.path, on_done=done, busy="检测标记中…")

    def do_export(self):
        if not self.path:
            QMessageBox.information(self, "提示", "请先加载视频")
            return
        dst, _ = QFileDialog.getSaveFileName(self, "导出修正结果", "corrected.mp4",
                                             "MP4 (*.mp4)")
        if not dst:
            return
        head, tail = self.head_tail()
        corr = self.corr_s()
        dur = self.info.duration
        self._last_export = (dst, corr, head, tail)
        self._run(media.export, self.path, dst, corr, head, tail, dur,
                  on_done=lambda p: self.println(f"已导出: {p}\n可点“验证输出”检查误差"),
                  busy="重新解码导出中…")

    def verify_output(self):
        if not self._last_export:
            QMessageBox.information(self, "提示", "请先导出")
            return
        dst, corr, head, tail = self._last_export

        def done(est):
            lines = [f"输出文件重新解码检测: {dst}",
                     f"修正量 {corr * 1000:+.0f} ms (head={head}, tail={tail})",
                     f"{'#':>3} {'闪光t(s)':>10} {'蜂鸣t(s)':>10} {'误差(ms)':>9}"]
            errs = [d for _, _, d in est["pairs"]]
            for i, (f, b, d) in enumerate(est["pairs"]):
                lines.append(f"{i:>3} {f:>10.3f} {b:>10.3f} {d * 1000:>+9.1f}")
            arr = np.abs(np.array(errs)) * 1000
            lines.append(f"最大|误差| {arr.max():.1f} ms（容差约 ±45 ms）")
            self.println("\n".join(lines))

        self._run(media.suggest_correction, dst, on_done=done, busy="验证输出中…")


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    if len(sys.argv) > 1:
        win.load_path(sys.argv[1])
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
