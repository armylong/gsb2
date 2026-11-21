"""短片核对器主界面 (PySide6)."""
from __future__ import annotations

import sys
from fractions import Fraction

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QImage, QKeySequence, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDialog, QDialogButtonBox, QFileDialog,
    QFormLayout, QGroupBox, QHBoxLayout, QLabel, QLineEdit, QMessageBox,
    QPushButton, QSplitter, QVBoxLayout, QWidget,
)

from . import exporter, generator, media, timecode
from .framesource import FrameSource
from .timecode import (
    DroppedFrameError, RateMode, Timecode, TimecodeError,
    format_tc, frame_to_tc, parse_tc, relative_time, tc_to_frame,
)


class Worker(QThread):
    done = Signal(object)
    failed = Signal(str)

    def __init__(self, fn, parent=None):
        super().__init__(parent)
        self._fn = fn

    def run(self):
        try:
            self.done.emit(self._fn())
        except Exception as e:  # noqa: BLE001 - 界面上统一报错
            self.failed.emit(str(e))


class GenerateDialog(QDialog):
    """生成带大号帧号的测试片."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("生成测试片")
        self.result_path = None
        lay = QFormLayout(self)
        self.mode = QComboBox()
        for m in RateMode:
            self.mode.addItem(m.value, m)
        self.start_tc = QLineEdit("23:59:50:00")
        self.seconds = QLineEdit("20")
        self.out = QLineEdit("testclip.mov")
        browse = QPushButton("选择…")
        browse.clicked.connect(self._browse)
        row = QHBoxLayout()
        row.addWidget(self.out)
        row.addWidget(browse)
        lay.addRow("制式", self.mode)
        lay.addRow("起始时间码", self.start_tc)
        lay.addRow("时长(秒)", self.seconds)
        lay.addRow("输出文件", row)
        self.hint = QLabel("")
        self.hint.setWordWrap(True)
        lay.addRow(self.hint)
        btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        lay.addRow(btns)

    def _browse(self):
        p, _ = QFileDialog.getSaveFileName(self, "输出文件", self.out.text(),
                                           "视频文件 (*.mov *.mp4)")
        if p:
            self.out.setText(p)

    def accept(self):
        mode = self.mode.currentData()
        try:
            tc = parse_tc(self.start_tc.text(), mode)
            secs = float(self.seconds.text())
            if not (0 < secs <= 600):
                raise ValueError("时长需在 0~600 秒之间")
        except (TimecodeError, ValueError) as e:
            self.hint.setText(f"输入有误: {e}")
            return
        self._mode, self._tc, self._secs = mode, tc, secs
        super().accept()


class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("短片核对器")
        self.resize(1280, 800)
        self.info: media.MediaInfo | None = None
        self.src: FrameSource | None = None
        self.mode = RateMode.NDF_25
        self.start_tc = Timecode(0, 0, 0, 0)
        self.cur = 0
        self.in_frame: int | None = None
        self.out_frame: int | None = None
        self._worker: Worker | None = None
        self._build_ui()

    # ---------- 界面 ----------

    def _build_ui(self):
        root = QHBoxLayout(self)
        split = QSplitter()
        root.addWidget(split)

        self.video = QLabel("打开素材后开始核对")
        self.video.setAlignment(Qt.AlignCenter)
        self.video.setMinimumSize(480, 320)
        self.video.setStyleSheet("background:#111; color:#888;")
        split.addWidget(self.video)

        panel = QWidget()
        panel.setMaximumWidth(420)
        v = QVBoxLayout(panel)
        split.addWidget(panel)
        split.setStretchFactor(0, 1)

        # 素材
        g1 = QGroupBox("素材")
        f1 = QVBoxLayout(g1)
        open_btn = QPushButton("打开素材…")
        open_btn.clicked.connect(self.open_file)
        self.info_label = QLabel("未加载")
        self.info_label.setWordWrap(True)
        f1.addWidget(open_btn)
        f1.addWidget(self.info_label)
        v.addWidget(g1)

        # 制式与起始时间码
        g2 = QGroupBox("时间码制式与片头")
        f2 = QFormLayout(g2)
        self.mode_combo = QComboBox()
        for m in RateMode:
            self.mode_combo.addItem(m.value, m)
        self.mode_combo.currentIndexChanged.connect(self._mode_changed)
        self.start_edit = QLineEdit("00:00:00:00")
        apply_start = QPushButton("设为片头")
        apply_start.clicked.connect(self._apply_start)
        self.embedded_btn = QPushButton("读不到内嵌时间码")
        self.embedded_btn.setEnabled(False)
        self.embedded_btn.clicked.connect(self._use_embedded)
        f2.addRow("制式", self.mode_combo)
        f2.addRow("起始时间码", self.start_edit)
        f2.addRow(apply_start)
        f2.addRow(self.embedded_btn)
        v.addWidget(g2)

        # 定位
        g3 = QGroupBox("定位")
        f3 = QFormLayout(g3)
        self.tc_label = QLabel("—")
        self.tc_label.setStyleSheet("font-size:22px; font-weight:bold; font-family:Menlo;")
        self.frame_label = QLabel("—")
        self.rel_label = QLabel("—")
        f3.addRow("素材时间码", self.tc_label)
        f3.addRow("帧序号(0起)", self.frame_label)
        f3.addRow("相对播放时间", self.rel_label)
        self.tc_seek = QLineEdit()
        self.tc_seek.setPlaceholderText("HH:MM:SS:FF 可带 +1天")
        tc_go = QPushButton("按时间码跳")
        tc_go.clicked.connect(self._seek_tc)
        row = QHBoxLayout()
        row.addWidget(self.tc_seek)
        row.addWidget(tc_go)
        f3.addRow(row)
        self.n_seek = QLineEdit()
        self.n_seek.setPlaceholderText("帧序号")
        n_go = QPushButton("按帧号跳")
        n_go.clicked.connect(self._seek_n)
        row2 = QHBoxLayout()
        row2.addWidget(self.n_seek)
        row2.addWidget(n_go)
        f3.addRow(row2)
        steps = QHBoxLayout()
        for label, delta in (("◀◀ 10", -10), ("◀ 1", -1), ("1 ▶", 1), ("10 ▶▶", 10)):
            b = QPushButton(label)
            b.clicked.connect(lambda _=False, d=delta: self.step(d))
            steps.addWidget(b)
        f3.addRow(steps)
        v.addWidget(g3)

        # 出入点与导出
        g4 = QGroupBox("入点 / 出点 / 导出")
        f4 = QFormLayout(g4)
        self.in_label = QLabel("未标")
        self.out_label = QLabel("未标")
        in_btn = QPushButton("标入点 (I)")
        in_btn.clicked.connect(self.mark_in)
        out_btn = QPushButton("标出点 (O)")
        out_btn.clicked.connect(self.mark_out)
        f4.addRow("入点", self.in_label)
        f4.addRow(in_btn)
        f4.addRow("出点", self.out_label)
        f4.addRow(out_btn)
        self.include_out = QCheckBox("出点包含在片段内 (勾选: 末帧=出点; 不勾: 末帧=出点前一帧)")
        self.include_out.setChecked(True)
        self.lossless = QCheckBox("无损导出 (ffv1, 可逐帧比对)")
        self.verify_after = QCheckBox("导出后自动逐帧核对")
        self.verify_after.setChecked(True)
        export_btn = QPushButton("导出片段及帧号清单…")
        export_btn.clicked.connect(self.export_segment)
        f4.addRow(self.include_out)
        f4.addRow(self.lossless)
        f4.addRow(self.verify_after)
        f4.addRow(export_btn)
        v.addWidget(g4)

        gen_btn = QPushButton("生成测试片 (大号帧号)…")
        gen_btn.clicked.connect(self.generate_clip)
        v.addWidget(gen_btn)

        self.status = QLabel("就绪")
        self.status.setWordWrap(True)
        self.status.setStyleSheet("color:#a66;")
        v.addWidget(self.status)
        v.addStretch(1)

        QShortcut(QKeySequence(Qt.Key_Left), self, activated=lambda: self.step(-1))
        QShortcut(QKeySequence(Qt.Key_Right), self, activated=lambda: self.step(1))
        QShortcut(QKeySequence("Shift+Left"), self, activated=lambda: self.step(-10))
        QShortcut(QKeySequence("Shift+Right"), self, activated=lambda: self.step(10))
        QShortcut(QKeySequence(Qt.Key_I), self, activated=self.mark_in)
        QShortcut(QKeySequence(Qt.Key_O), self, activated=self.mark_out)

    # ---------- 状态辅助 ----------

    def _say(self, msg: str):
        self.status.setText(msg)

    def _start_frame(self) -> int:
        return tc_to_frame(self.start_tc, self.mode)

    def _mode_changed(self):
        self.mode = self.mode_combo.currentData()
        self._refresh()

    def _apply_start(self):
        try:
            self.start_tc = parse_tc(self.start_edit.text(), self.mode)
        except DroppedFrameError as e:
            self._say(str(e))
            return
        except TimecodeError as e:
            self._say(str(e))
            return
        self._say(f"片头起始时间码: {format_tc(self.start_tc, self.mode)}")
        self._refresh()

    def _use_embedded(self):
        if self.info and self.info.embedded_timecode:
            self.start_edit.setText(self.info.embedded_timecode)
            self._apply_start()

    # ---------- 素材加载 ----------

    def open_file(self, path: str | None = None):
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "打开素材")
        if not path:
            return
        try:
            info = media.probe(path)
        except media.ProbeError as e:
            QMessageBox.critical(self, "无法读取素材", str(e))
            return
        if self.src:
            self.src.close()
        self.info = info
        self.src = FrameSource(info)
        self.cur = 0
        self.in_frame = self.out_frame = None
        self.in_label.setText("未标")
        self.out_label.setText("未标")

        fps = info.fps
        if fps == Fraction(25, 1):
            self.mode_combo.setCurrentIndex(0)
        elif fps == Fraction(30000, 1001):
            self.mode_combo.setCurrentIndex(2)  # 默认丢帧补偿, 可手动切不丢帧
        else:
            self._say(f"帧率 {fps} 不在支持范围 (25 或 30000/1001), 时间码仅供参考")
        self.mode = self.mode_combo.currentData()

        lines = [
            f"{info.width}x{info.height}  帧率 {fps.numerator}/{fps.denominator}"
            f"  帧数 {info.frame_count if info.frame_count is not None else '未知'}",
        ]
        if info.embedded_timecode:
            lines.append(f"内嵌时间码: {info.embedded_timecode}")
            self.embedded_btn.setText(f"使用内嵌 {info.embedded_timecode}")
            self.embedded_btn.setEnabled(True)
            self.start_edit.setText(info.embedded_timecode)
            self._apply_start()
        else:
            lines.append("无内嵌时间码, 请手动设置片头")
            self.embedded_btn.setText("读不到内嵌时间码")
            self.embedded_btn.setEnabled(False)
        if not info.is_cfr:
            lines.append(f"⚠ 非恒定帧率: {info.vfr_note}")
        self.info_label.setText("\n".join(lines))
        if not info.is_cfr:
            self._say("该素材为非恒定帧率, 本工具目前仅适用于恒定帧率素材, 对位结果不可靠")
        self._refresh()

    # ---------- 定位与显示 ----------

    def _refresh(self):
        if not self.src:
            return
        self._show_frame(self.cur)

    def _show_frame(self, n: int):
        data = self.src.frame(n)
        if data is None:
            self._say(f"帧 {n} 超出素材末尾")
            return
        self.cur = n
        img = QImage(data, self.info.width, self.info.height,
                     self.info.width * 3, QImage.Format_RGB888).copy()
        self.video.setPixmap(QPixmap.fromImage(img).scaled(
            self.video.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))
        src_tc = frame_to_tc(self._start_frame() + n, self.mode)
        self.tc_label.setText(format_tc(src_tc, self.mode))
        self.frame_label.setText(str(n))
        self.rel_label.setText(relative_time(n, self.mode))
        self.tc_seek.setText(format_tc(src_tc, self.mode))
        self.n_seek.setText(str(n))

    def step(self, delta: int):
        if not self.src:
            return
        target = max(0, self.cur + delta)
        self._show_frame(target)

    def _seek_tc(self):
        if not self.src:
            return
        try:
            tc = parse_tc(self.tc_seek.text(), self.mode)
            n = tc_to_frame(tc, self.mode) - self._start_frame()
        except DroppedFrameError as e:
            self._say(str(e))
            return
        except TimecodeError as e:
            self._say(str(e))
            return
        if n < 0:
            self._say(f"{format_tc(tc, self.mode)} 在片头 "
                      f"{format_tc(self.start_tc, self.mode)} 之前, 素材里不存在")
            return
        self._show_frame(n)

    def _seek_n(self):
        if not self.src:
            return
        try:
            n = int(self.n_seek.text())
        except ValueError:
            self._say("帧号须为整数")
            return
        if n < 0:
            self._say("帧号不能为负")
            return
        self._show_frame(n)

    # ---------- 出入点与导出 ----------

    def mark_in(self):
        if not self.src:
            return
        self.in_frame = self.cur
        self.in_label.setText(f"帧 {self.cur}  {self.tc_label.text()}")

    def mark_out(self):
        if not self.src:
            return
        self.out_frame = self.cur
        self.out_label.setText(f"帧 {self.cur}  {self.tc_label.text()}")

    def export_segment(self):
        if not self.src or self.in_frame is None or self.out_frame is None:
            self._say("请先标入点和出点")
            return
        if self.out_frame < self.in_frame:
            self._say("出点早于入点")
            return
        default = "segment.mkv" if self.lossless.isChecked() else "segment.mp4"
        out, _ = QFileDialog.getSaveFileName(self, "导出片段", default)
        if not out:
            return
        self._say("导出中…")
        args = (self.info, out, self.in_frame, self.out_frame,
                self.include_out.isChecked(), self.mode, self.start_tc,
                self.lossless.isChecked())
        self._worker = Worker(lambda: exporter.export_segment(*args), self)
        self._worker.done.connect(self._export_done)
        self._worker.failed.connect(lambda msg: self._say(f"导出失败: {msg}"))
        self._worker.start()

    def _export_done(self, result: exporter.ExportResult):
        msg = (f"已导出 {result.count} 帧 "
               f"(首帧 {result.first_frame} {result.first_tc} → "
               f"末帧 {result.last_frame} {result.last_tc}), 清单: {result.csv_path}")
        self._say(msg)
        if self.verify_after.isChecked():
            self._say(msg + " — 逐帧核对中…")
            self._worker = Worker(lambda: exporter.verify_export(self.info, result), self)
            self._worker.done.connect(self._verify_done)
            self._worker.failed.connect(lambda m: self._say(f"核对失败: {m}"))
            self._worker.start()

    def _verify_done(self, report: exporter.VerifyReport):
        if report.ok:
            QMessageBox.information(self, "逐帧核对", report.note)
            self._say(f"核对通过: {report.note}")
        else:
            detail = report.note
            if report.mismatches:
                detail += f"\n不一致的导出帧序号(前20): {report.mismatches[:20]}"
            QMessageBox.warning(self, "逐帧核对未通过", detail)
            self._say(f"核对未通过: {report.note}")

    # ---------- 测试片生成 ----------

    def generate_clip(self):
        dlg = GenerateDialog(self)
        if not dlg.exec():
            return
        self._say("生成测试片中…")
        self._worker = Worker(
            lambda: (generator.generate_test_clip(dlg.out.text(), dlg._tc, dlg._mode, dlg._secs),
                     dlg.out.text()), self)
        self._worker.done.connect(self._gen_done)
        self._worker.failed.connect(lambda m: self._say(f"生成失败: {m}"))
        self._worker.start()

    def _gen_done(self, res):
        total, path = res
        ans = QMessageBox.question(self, "生成完成",
                                   f"已生成 {total} 帧: {path}\n是否立即打开核对?")
        self._say(f"测试片已生成: {path} ({total} 帧)")
        if ans == QMessageBox.Yes:
            self.open_file(path)

    # ---------- 退出 ----------

    def closeEvent(self, event):
        if self.src:
            self.src.close()
        super().closeEvent(event)


def main():
    app = QApplication(sys.argv)
    w = MainWindow()
    w.show()
    if len(sys.argv) > 1:
        w.open_file(sys.argv[1])
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
