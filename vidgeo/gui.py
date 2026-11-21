"""PySide6 图形界面。

布局：
- 左栏：四项关键信息（编码尺寸 / PAR / 显示方向 / 预计显示比例）、
  原始像素 vs 播放器显示对比、取整策略与边缘变化、四角标记表；
- 右栏：两个预览（原始像素 / 播放器显示），点击预览取坐标；
- 底部：导出、回读校验结果与运行日志。
"""
from __future__ import annotations

import os
import tempfile

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QAction, QFont
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtMultimediaWidgets import QVideoWidget
from PySide6.QtWidgets import (
    QApplication, QComboBox, QFileDialog, QFormLayout, QGridLayout, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton,
    QSplitter, QTabWidget, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from .geometry import VideoGeometry
from .pipeline import ExportOptions
from .probe import ProbeResult
from .workers import ExportThread, PreviewThread, ProbeThread, SamplesThread


class ClickableVideoWidget(QVideoWidget):
    """视频预览，点击处换算为画面归一化坐标 (u,v)。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._cb = None
        self.setMinimumHeight(260)
        self.setStyleSheet("background:#111;")

    def set_click_callback(self, cb):
        self._cb = cb

    def mousePressEvent(self, event):
        if self._cb is None:
            return super().mousePressEvent(event)
        rect = self.video_rect()
        if rect.width() <= 0 or not rect.contains(event.position().toPoint()):
            return
        u = (event.position().x() - rect.left()) / rect.width()
        v = (event.position().y() - rect.top()) / rect.height()
        self._cb(max(0.0, min(1.0, u)), max(0.0, min(1.0, v)))


class PlayerPane(QWidget):
    """一个预览页：视频 + 播放控制 + 点击坐标回显。"""

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.video = ClickableVideoWidget()
        self.player = QMediaPlayer(self)
        self.audio = QAudioOutput(self)
        self.player.setVideoOutput(self.video)
        self.player.setAudioOutput(self.audio)
        self.audio.setMuted(True)

        self.btn_play = QPushButton("播放/暂停")
        self.btn_play.clicked.connect(self._toggle)
        self.btn_stop = QPushButton("回到开头")
        self.btn_stop.clicked.connect(lambda: self.player.setPosition(0))
        self.click_label = QLabel("在画面上点击以选取坐标")
        self.click_label.setWordWrap(True)
        self.click_label.setStyleSheet("color:#0a6; font-weight:bold;")

        bar = QHBoxLayout()
        bar.addWidget(self.btn_play)
        bar.addWidget(self.btn_stop)
        bar.addStretch(1)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(title))
        layout.addWidget(self.video, 1)
        layout.addLayout(bar)
        layout.addWidget(self.click_label)

    def _toggle(self):
        if self.player.playbackState() == QMediaPlayer.PlayingState:
            self.player.pause()
        else:
            self.player.play()

    def set_source(self, path: str):
        self.player.setSource(QUrl.fromLocalFile(path))
        self.player.setPosition(0)

    def shutdown(self):
        self.player.stop()
        self.player.setSource(QUrl())


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("VidGeo — 像素形状与显示方向校正工具")
        self.resize(1280, 860)

        self.probe_result = None  # type: ProbeResult | None
        self._proxies = {}
        self._threads = []
        self._proxy_files = []
        self._picked = None

        self._build_ui()

    # ------------------------------------------------------------------ #
    # UI 搭建
    # ------------------------------------------------------------------ #
    def _build_ui(self):
        toolbar = self.addToolBar("main")
        act_open = QAction("导入 mp4/mov…", self)
        act_open.triggered.connect(self.choose_file)
        toolbar.addAction(act_open)
        act_samples = QAction("生成内置测试素材…", self)
        act_samples.triggered.connect(self.generate_samples)
        toolbar.addAction(act_samples)

        splitter = QSplitter(Qt.Horizontal)

        # 左栏：信息与设置
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(8, 8, 8, 8)

        self.info_box = QGroupBox("1. 文件诊断")
        self.info_form = QFormLayout(self.info_box)
        self.lbl_coded = QLabel("—")
        self.lbl_par = QLabel("—")
        self.lbl_rotation = QLabel("—")
        self.lbl_dar = QLabel("—")
        self.lbl_compare = QLabel("导入文件后显示")
        self.lbl_compare.setWordWrap(True)
        self.lbl_compare.setTextInteractionFlags(Qt.TextSelectableByMouse)
        for lbl in (self.lbl_coded, self.lbl_par, self.lbl_rotation, self.lbl_dar):
            lbl.setTextInteractionFlags(Qt.TextSelectableByMouse)
            f = QFont(); f.setBold(True); lbl.setFont(f)
        self.info_form.addRow("编码尺寸（存储像素）", self.lbl_coded)
        self.info_form.addRow("像素宽高比 PAR", self.lbl_par)
        self.info_form.addRow("显示方向", self.lbl_rotation)
        self.info_form.addRow("预计显示比例 DAR", self.lbl_dar)
        self.info_form.addRow("原始像素 vs 播放器", self.lbl_compare)
        self.lbl_warn = QLabel("")
        self.lbl_warn.setWordWrap(True)
        self.lbl_warn.setStyleSheet("color:#c33; font-weight:bold;")
        self.info_form.addRow("支持范围", self.lbl_warn)
        left_layout.addWidget(self.info_box)

        opt_box = QGroupBox("2. 导出设置（PAR 与方向都烘焙进像素）")
        opt_form = QFormLayout(opt_box)
        self.cmb_round = QComboBox()
        self.cmb_round.addItem("四舍五入到最近偶数", "nearest")
        self.cmb_round.addItem("向下取偶（只裁不补）", "down")
        self.cmb_round.currentIndexChanged.connect(self.refresh_output_info)
        opt_form.addRow("宽高取整策略", self.cmb_round)
        self.lbl_out_size = QLabel("—")
        self.lbl_edge = QLabel("—")
        self.lbl_edge.setWordWrap(True)
        opt_form.addRow("成片尺寸", self.lbl_out_size)
        opt_form.addRow("取整边缘变化", self.lbl_edge)
        left_layout.addWidget(opt_box)

        marker_box = QGroupBox("3. 四角标记点（编号按播放画面，转换前后不变）")
        marker_layout = QVBoxLayout(marker_box)
        self.tbl_markers = QTableWidget(0, 4)
        self.tbl_markers.setHorizontalHeaderLabels(
            ["编号", "归一化(u,v)", "成片像素(x,y)", "源存储像素(x,y)"]
        )
        self.tbl_markers.horizontalHeader().setStretchLastSection(True)
        marker_layout.addWidget(self.tbl_markers)
        left_layout.addWidget(marker_box, 1)

        # 右栏：预览 + 日志
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(8, 8, 8, 8)

        self.tabs = QTabWidget()
        self.pane_display = PlayerPane(
            "播放器方式显示（PAR + 方向均生效）—— 点击取坐标的基准"
        )
        self.pane_coded = PlayerPane(
            "按原始像素显示（文件里实际存的矩阵，保留 PAR 形变、不转方向）"
        )
        self.pane_display.video.set_click_callback(self.on_pick_display)
        self.tabs.addTab(self.pane_display, "播放器显示")
        self.tabs.addTab(self.pane_coded, "原始像素")
        right_layout.addWidget(self.tabs, 3)

        self.pick_box = QGroupBox("4. 坐标拾取")
        pick_form = QFormLayout(self.pick_box)
        self.lbl_pick_uv = QLabel("尚未选取")
        self.lbl_pick_out = QLabel("—")
        self.lbl_pick_coded = QLabel("—")
        pick_form.addRow("播放画面归一化 (u,v)", self.lbl_pick_uv)
        pick_form.addRow("对应成片像素位置", self.lbl_pick_out)
        pick_form.addRow("对应源存储像素位置", self.lbl_pick_coded)
        right_layout.addWidget(self.pick_box)

        export_row = QHBoxLayout()
        self.btn_export = QPushButton("5. 导出校正片并回读校验…")
        self.btn_export.setEnabled(False)
        self.btn_export.setMinimumHeight(40)
        self.btn_export.clicked.connect(self.choose_output_and_export)
        export_row.addWidget(self.btn_export)
        right_layout.addLayout(export_row)

        self.verify_box = QGroupBox("6. 回读校验")
        verify_layout = QVBoxLayout(self.verify_box)
        self.txt_verify = QPlainTextEdit()
        self.txt_verify.setReadOnly(True)
        self.txt_verify.setMaximumHeight(150)
        verify_layout.addWidget(self.txt_verify)
        right_layout.addWidget(self.verify_box)

        log_box = QGroupBox("运行日志")
        log_layout = QVBoxLayout(log_box)
        self.txt_log = QPlainTextEdit()
        self.txt_log.setReadOnly(True)
        self.txt_log.setMaximumHeight(120)
        log_layout.addWidget(self.txt_log)
        right_layout.addWidget(log_box)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([520, 760])
        self.setCentralWidget(splitter)
        self.statusBar().showMessage("就绪。导入一个 mp4/mov 开始。")

    # ------------------------------------------------------------------ #
    # 导入与探测
    # ------------------------------------------------------------------ #
    def choose_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择视频文件", "",
            "视频文件 (*.mp4 *.mov *.m4v *.MP4 *.MOV);;所有文件 (*)",
        )
        if not path:
            return
        self.load_file(path)

    def load_file(self, path: str):
        self.statusBar().showMessage(f"探测中：{os.path.basename(path)} …")
        thread = ProbeThread(path)
        thread.ok.connect(self.on_probed)
        thread.failed.connect(self.on_probe_failed)
        self._track(thread)
        thread.start()

    def on_probed(self, result: ProbeResult):
        self.probe_result = result
        g = result.geometry
        self.statusBar().showMessage("已加载：" + os.path.basename(result.path))
        self.log(f"探测完成：{result.path}")

        self.lbl_coded.setText(
            f"{g.coded_width} × {g.coded_height} px"
            f"（{result.video_codec}）"
        )
        par_text = f"{g.par_num}:{g.par_den}"
        if g.is_square_pixel:
            par_text += "（方形像素）"
        else:
            par_text += f"（非方形，单个像素宽是高的 {float(g.par):.4f} 倍）"
        self.lbl_par.setText(par_text)

        if result.raw_rotation is None:
            self.lbl_rotation.setText("无方向元数据（rotation=0°）")
        else:
            self.lbl_rotation.setText(
                f"旋转 {result.raw_rotation:g}°（逆时针，播放器显示时生效）"
                + ("" if g.is_supported else "【非直角】")
            )

        raw_w, raw_h = g.raw_display_size
        disp_w, disp_h = g.display_size
        self.lbl_dar.setText(
            f"{_frac_str(g.display_dar)}（显示 {disp_w}×{disp_h} px 逻辑尺寸）"
        )
        self.lbl_compare.setText(
            f"按原始像素铺开：{raw_w}×{raw_h}，"
            f"比例 {_frac_str(g.coded_dar)}\n"
            f"按播放器显示：{disp_w}×{disp_h}，"
            f"比例 {_frac_str(g.display_dar)}\n"
            + (
                "两者尺寸相同，但 PAR 非 1:1，直接按像素看会被拉扁。"
                if not g.is_rotated and not g.is_square_pixel
                else ""
            )
            + (
                "方向元数据使宽高互换，文件里存的是横向矩阵、播放器竖屏显示。"
                if g.is_rotated
                else ""
            )
        )

        if g.is_supported:
            self.lbl_warn.setText("支持，可导出")
            self.lbl_warn.setStyleSheet("color:#073; font-weight:bold;")
            self.btn_export.setEnabled(True)
        else:
            self.lbl_warn.setText("不支持：" + (g.unsupported_detail or "未知方向"))
            self.lbl_warn.setStyleSheet("color:#c33; font-weight:bold;")
            self.btn_export.setEnabled(False)

        self.refresh_output_info()
        self.refresh_marker_table()
        self.start_previews(result)

    def on_probe_failed(self, message: str):
        self.statusBar().showMessage("探测失败")
        QMessageBox.critical(self, "探测失败", message)

    # ------------------------------------------------------------------ #
    # 预览代理
    # ------------------------------------------------------------------ #
    def start_previews(self, result: ProbeResult):
        for pane in (self.pane_display, self.pane_coded):
            pane.shutdown()
        self._proxies.clear()
        thread = PreviewThread(
            result.path, result.geometry, ["display", "coded"]
        )
        thread.ready.connect(self.on_preview_ready)
        thread.failed.connect(lambda mode, msg: self.log(f"预览[{mode}]失败：{msg}"))
        self._track(thread)
        thread.start()

    def on_preview_ready(self, mode: str, proxy_path: str):
        self._proxies[mode] = proxy_path
        self._proxy_files.append(proxy_path)
        if mode == "display":
            self.pane_display.set_source(proxy_path)
        else:
            self.pane_coded.set_source(proxy_path)
        self.log(f"预览代理就绪[{mode}]：{os.path.basename(proxy_path)}")

    # ------------------------------------------------------------------ #
    # 输出信息、标记表、坐标拾取
    # ------------------------------------------------------------------ #
    def _current_policy(self) -> str:
        return self.cmb_round.currentData()

    def refresh_output_info(self):
        if not self.probe_result:
            return
        g = self.probe_result.geometry
        if not g.is_supported:
            self.lbl_out_size.setText("方向不支持，无法规划")
            self.lbl_edge.setText("—")
            return
        policy = self._current_policy()
        ow, oh = g.output_size(policy)
        iw, ih = g.ideal_output_size()
        self.lbl_out_size.setText(
            f"{ow} × {oh} px（理论值 {float(iw):.2f} × {float(ih):.2f}）"
        )
        d = g.edge_deltas(policy)
        self.lbl_edge.setText(
            f"左右各 {_signed(d['left'])} px，上下各 {_signed(d['top'])} px"
            "（正=补边/负=裁切，对称分摊；误差仅取整量级）"
        )
        self.refresh_marker_table()
        if self._picked is not None:
            self._update_pick_labels(*self._picked)

    def refresh_marker_table(self):
        if not self.probe_result:
            self.tbl_markers.setRowCount(0)
            return
        g = self.probe_result.geometry
        rows = g.corner_markers(self._current_policy()) if g.is_supported else []
        self.tbl_markers.setRowCount(len(rows))
        for i, row in enumerate(rows):
            vals = [
                str(row["marker"]),
                f"({row['u']:.3f}, {row['v']:.3f})",
                f"({row['output_xy'][0]}, {row['output_xy'][1]})",
                f"({row['coded_xy'][0]}, {row['coded_xy'][1]})",
            ]
            for j, v in enumerate(vals):
                item = QTableWidgetItem(v)
                item.setFlags(item.flags() & ~Qt.ItemIsEditable)
                self.tbl_markers.setItem(i, j, item)

    def on_pick_display(self, u: float, v: float):
        self._picked = (u, v)
        self._update_pick_labels(u, v)

    def _update_pick_labels(self, u: float, v: float):
        g = self.probe_result.geometry
        policy = self._current_policy()
        self.lbl_pick_uv.setText(f"({u:.4f}, {v:.4f})")
        if g.is_supported:
            ox, oy = g.display_to_output(u, v, policy)
            self.lbl_pick_out.setText(f"({ox:.1f}, {oy:.1f}) px")
        else:
            self.lbl_pick_out.setText("方向不支持，无法映射")
        cx, cy = g.display_to_coded(u, v)
        self.lbl_pick_coded.setText(f"({cx:.1f}, {cy:.1f}) px")

    # ------------------------------------------------------------------ #
    # 导出 + 校验
    # ------------------------------------------------------------------ #
    def choose_output_and_export(self):
        if not self.probe_result:
            return
        base = os.path.splitext(os.path.basename(self.probe_result.path))[0]
        default = os.path.join(
            os.path.dirname(self.probe_result.path),
            base + "_corrected.mp4",
        )
        path, _ = QFileDialog.getSaveFileName(
            self, "保存校正片", default, "MP4 (*.mp4)"
        )
        if not path:
            return
        opts = ExportOptions(
            output_path=path, even_policy=self._current_policy()
        )
        self.btn_export.setEnabled(False)
        self.statusBar().showMessage("导出中…")
        thread = ExportThread(self.probe_result, opts)
        thread.log_line.connect(self.log)
        thread.finished_ok.connect(self.on_exported)
        thread.failed.connect(self.on_export_failed)
        self._track(thread)
        thread.start()

    def on_exported(self, path: str, report):
        self.btn_export.setEnabled(True)
        self.statusBar().showMessage(
            ("导出并校验通过：" if report.ok else "导出完成，但校验有失败项：")
            + os.path.basename(path)
        )
        title = "✅ 校验通过" if report.ok else "❌ 校验未通过"
        self.txt_verify.setPlainText(
            title + "\n" + "\n".join(report.summary_lines())
        )
        self.log(f"导出结束：{path}")

    def on_export_failed(self, message: str):
        self.btn_export.setEnabled(True)
        self.statusBar().showMessage("导出失败")
        self.txt_verify.setPlainText("导出失败\n" + message)
        QMessageBox.critical(self, "导出失败", message)

    # ------------------------------------------------------------------ #
    # 内置素材
    # ------------------------------------------------------------------ #
    def generate_samples(self):
        out_dir = QFileDialog.getExistingDirectory(
            self, "选择素材输出目录（建议新建空目录）",
            tempfile.gettempdir(),
        )
        if not out_dir:
            return
        thread = SamplesThread(out_dir)
        thread.progress.connect(
            lambda d, t, name: self.statusBar().showMessage(
                f"生成素材 {d}/{t}：{name}"
            )
        )
        thread.finished_ok.connect(self.on_samples_done)
        thread.failed.connect(
            lambda msg: QMessageBox.critical(self, "素材生成失败", msg)
        )
        self._track(thread)
        thread.start()

    def on_samples_done(self, paths: list):
        self.statusBar().showMessage(f"已生成 {len(paths)} 条素材")
        self.log("素材目录：" + os.path.dirname(paths[0]))
        for p in paths:
            self.log("  " + os.path.basename(p))
        # 自动加载“两种变化叠加”的那条
        combo = next((p for p in paths if p.endswith("par_rot.mov")), paths[0])
        self.load_file(combo)
        QMessageBox.information(
            self, "素材已生成",
            "共 5 条：\n"
            "• par_only.mp4 — 非方形像素 40:33\n"
            "• rot_only.mov — 旋转 90°\n"
            "• par_rot.mov — 两者叠加（已自动加载）\n"
            "• rot_180.mp4 — 旋转 180°\n"
            "• unsupported.mov — 45°，验证不支持提示\n"
            f"\n目录：{os.path.dirname(paths[0])}",
        )

    # ------------------------------------------------------------------ #
    def log(self, msg: str):
        self.txt_log.appendPlainText(msg)

    def _track(self, thread):
        # 先登记再连接，避免线程极快结束时 finished 早于注册触发
        self._threads.append(thread)
        thread.finished.connect(lambda t=thread: self._discard(t))

    def _discard(self, thread):
        try:
            self._threads.remove(thread)
        except ValueError:
            pass

    def closeEvent(self, event):
        for pane in (self.pane_display, self.pane_coded):
            pane.shutdown()
        # 等后台线程结束，避免 QThread 仍在运行时被析构
        for thread in list(self._threads):
            if thread.isRunning():
                if hasattr(thread, "request_abort"):
                    thread.request_abort()
                thread.quit()
                thread.wait(5000)
        for p in self._proxy_files:
            try:
                os.remove(p)
            except OSError:
                pass
        super().closeEvent(event)


def _frac_str(value) -> str:
    return f"{value.numerator}:{value.denominator}（{float(value):.4f}）"


def _signed(value) -> str:
    v = float(value)
    if abs(v) < 1e-9:
        return "0"
    return f"{v:+.2f}"


def main():
    import sys

    app = QApplication(sys.argv)
    win = MainWindow()
    if len(sys.argv) > 1:
        win.load_file(sys.argv[1])
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
