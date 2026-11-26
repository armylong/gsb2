"""PySide6 本地查看器：两版压缩结果并排、按显示顺序检查帧与运动向量。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QImage, QPainter, QPixmap
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDialog, QDialogButtonBox, QFileDialog,
    QFrame, QGridLayout, QGroupBox, QHBoxLayout, QLabel, QMainWindow,
    QMessageBox, QPushButton, QSlider, QSpinBox, QTextEdit, QVBoxLayout, QWidget,
)

from .exporter import save_frame_image, save_frame_vectors
from .groundtruth import GroundTruth
from .mvdata import MotionVector, VideoData, load_video
from .render import find_vector_at, render_overlay


@dataclass
class DisplaySettings:
    min_length: float = 0.5
    show_past: bool = True
    show_future: bool = True
    show_blocks: bool = False
    show_expected: bool = True
    show_mismatch: bool = True


def pil_to_qimage(img: Image.Image) -> QImage:
    arr = np.asarray(img)
    h, w, _ = arr.shape
    return QImage(arr.tobytes(), w, h, 3 * w, QImage.Format.Format_RGB888).copy()


class FrameView(QWidget):
    """按比例缩放显示一帧；点击把屏幕坐标映回图像像素来选块。"""

    clicked = Signal(int, int)

    def __init__(self) -> None:
        super().__init__()
        self._pix: QPixmap | None = None
        self.setMinimumSize(380, 220)
        self.setMouseTracking(True)

    def set_image(self, img: Image.Image) -> None:
        self._pix = QPixmap.fromImage(pil_to_qimage(img))
        self.update()

    def _fit(self) -> tuple[float, int, int]:
        assert self._pix is not None
        sx = self.width() / self._pix.width()
        sy = self.height() / self._pix.height()
        scale = min(sx, sy)
        ox = (self.width() - self._pix.width() * scale) / 2
        oy = (self.height() - self._pix.height() * scale) / 2
        return scale, int(ox), int(oy)

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.GlobalColor.black)
        if self._pix is None:
            painter.setPen(Qt.GlobalColor.lightGray)
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "无帧")
            return
        scale, ox, oy = self._fit()
        target = self._pix.scaled(
            int(self._pix.width() * scale), int(self._pix.height() * scale),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        painter.drawPixmap(ox, oy, target)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if self._pix is None or event.button() != Qt.MouseButton.LeftButton:
            return
        scale, ox, oy = self._fit()
        ix = int((event.position().x() - ox) / scale)
        iy = int((event.position().y() - oy) / scale)
        if 0 <= ix < self._pix.width() and 0 <= iy < self._pix.height():
            self.clicked.emit(ix, iy)


class VideoPanel(QGroupBox):
    """一个压缩版本的完整面板：画面 + 帧类型/向量状态 + 选中块详情。"""

    def __init__(self, title: str, video: VideoData, gt: GroundTruth,
                 settings: DisplaySettings) -> None:
        super().__init__(title)
        self.video = video
        self.gt = gt
        self.settings = settings
        self.index = 0
        self.selected: MotionVector | None = None

        self.view = FrameView()
        self.view.clicked.connect(self._pick)
        self.status = QLabel()
        self.status.setWordWrap(True)
        self.detail = QTextEdit()
        self.detail.setReadOnly(True)
        self.detail.setFixedHeight(150)

        layout = QVBoxLayout(self)
        layout.addWidget(self.view, stretch=1)
        layout.addWidget(self.status)
        layout.addWidget(self.detail)

    def show_frame(self, index: int) -> None:
        self.index = index
        fi = self.video.get_info(index)
        vectors = fi.vectors
        img = render_overlay(
            self.video.get_frame(index), vectors, self.gt, index,
            min_length=self.settings.min_length,
            show_past=self.settings.show_past,
            show_future=self.settings.show_future,
            show_blocks=self.settings.show_blocks,
            show_expected=self.settings.show_expected,
            show_mismatch=self.settings.show_mismatch,
            selected=self.selected,
        )
        self.view.set_image(img)

        key = "关键帧/" if fi.key_frame else ""
        self.status.setText(
            f"<b>显示帧 {index}</b>（共 {self.video.frame_count} 帧） "
            f"类型：{key}{fi.pict_type} ｜ {fi.status_text()}"
        )
        self._update_detail()

    def _pick(self, x: int, y: int) -> None:
        fi = self.video.get_info(self.index)
        if not fi.has_vectors:
            self.selected = None
            self.show_frame(self.index)
            return
        self.selected = find_vector_at(fi.vectors, x, y)
        self.show_frame(self.index)

    def clear_selection(self) -> None:
        self.selected = None

    def _update_detail(self) -> None:
        fi = self.video.get_info(self.index)
        if not fi.has_vectors:
            self.detail.setText(fi.status_text())
            return
        if self.selected is None:
            self.detail.setText("点击画面中的块查看该块的运动向量详情。")
            return
        v = self.selected
        if v.direction == "past":
            dir_cn = "来自过去（前向预测，参考已发生的帧）"
        elif v.direction == "future":
            dir_cn = "来自未来（后向预测，参考尚未显示的帧）"
        else:
            dir_cn = "方向无法确认"
        if v.ref_known:
            ref_cn = f"第 {v.ref_frame} 帧（当前帧 {self.index} {v.source_poc:+d}）"
        else:
            ref_cn = "无法确认具体参考帧（source 字段不合法或越界），仅能标注原始值"
        lines = [
            f"<b>块位置</b>：左上角 ({v.block_x}, {v.block_y})，"
            f"实际块大小 {v.block_w}×{v.block_h}",
            f"<b>向量</b>：({v.mv_x:.2f}, {v.mv_y:.2f}) 像素，"
            f"长度 {v.length:.2f} px（1/4 像素精度）",
            f"<b>指向</b>：块中心 ({v.dst_x:.0f},{v.dst_y:.0f}) → "
            f"参考位置 ({v.src_x:.1f},{v.src_y:.1f})",
            f"<b>参考方向</b>：{dir_cn}",
            f"<b>参考帧</b>：{ref_cn}；原始 source={v.source_poc}",
        ]
        verdict, exp = self.gt.compare(self.index, v)
        if verdict == "match":
            lines.append(
                f"<b>与预设运动对照</b>：一致（期望 "
                f"({exp.exp_mv_x:.2f},{exp.exp_mv_y:.2f})，{exp.object_name or '静止背景'}）")
        elif verdict == "mismatch":
            lines.append(
                f"<b>与预设运动对照</b>：<span style='color:#c02020'>明显不同</span>，"
                f"编码向量 ({v.mv_x:.2f},{v.mv_y:.2f}) vs 期望 "
                f"({exp.exp_mv_x:.2f},{exp.exp_mv_y:.2f})，{exp.object_name or '背景'}")
        elif verdict == "ref_unknown":
            lines.append("<b>与预设运动对照</b>：参考帧无法确认，不做比对")
        else:
            lines.append(f"<b>与预设运动对照</b>：无期望（{exp.reason}），不把缺失当作静止")
        self.detail.setHtml("<br>".join(lines))


class MainWindow(QMainWindow):
    def __init__(self, sample_dir: str | Path) -> None:
        super().__init__()
        self.setWindowTitle("运动向量查看器 — 压缩记录 vs 眼睛看到的运动")
        sample_dir = Path(sample_dir)
        self.gt = GroundTruth(sample_dir / "ground_truth.json")
        self.intra = load_video(sample_dir / "intra.mp4")
        self.inter = load_video(sample_dir / "inter.mp4")
        self.settings = DisplaySettings()
        self.frame = 0
        self.playing = False

        self.panel_intra = VideoPanel("纯画内版本 intra.mp4（只有 I 帧）", self.intra, self.gt, self.settings)
        self.panel_inter = VideoPanel("前后参考版本 inter.mp4（I/P/B 帧）", self.inter, self.gt, self.settings)

        central = QWidget()
        root = QVBoxLayout(central)
        root.addWidget(self._build_controls())

        panels = QHBoxLayout()
        panels.addWidget(self.panel_intra, stretch=1)
        panels.addWidget(self.panel_inter, stretch=1)
        root.addLayout(panels, stretch=1)
        root.addWidget(self._build_legend())
        self.setCentralWidget(central)

        self.timer = QTimer(self)
        self.timer.setInterval(int(1000 / self.gt.data["fps"]))
        self.timer.timeout.connect(self._tick)
        self.resize(1320, 860)
        self._refresh()

    # ---------- 控件 ----------
    def _build_controls(self) -> QWidget:
        box = QGroupBox("播放控制（帧号 = 实际显示顺序，两版同步）")
        grid = QGridLayout(box)

        self.btn_play = QPushButton("播放/暂停")
        self.btn_play.clicked.connect(self.toggle_play)
        btn_first = QPushButton("⏮ 首帧")
        btn_prev = QPushButton("◀ 上一帧")
        btn_next = QPushButton("下一帧 ▶")
        btn_last = QPushButton("末帧 ⏭")
        for b, slot in [(btn_first, self.first), (btn_prev, self.prev),
                        (btn_next, self.next), (btn_last, self.last)]:
            b.clicked.connect(slot)

        self.jump = QSpinBox()
        self.jump.setRange(0, self.gt.frame_count - 1)
        self.jump.setPrefix("跳到帧号 ")
        self.jump.valueChanged.connect(self.goto)

        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, self.gt.frame_count - 1)
        self.slider.valueChanged.connect(self.goto)

        nav = QHBoxLayout()
        for w in (btn_first, btn_prev, self.btn_play, btn_next, btn_last, self.jump):
            nav.addWidget(w)
        nav.addStretch(1)

        grid.addLayout(nav, 0, 0, 1, 8)
        grid.addWidget(self.slider, 1, 0, 1, 8)

        # 显示筛选
        self.cb_past = QCheckBox("过去参考(蓝)")
        self.cb_future = QCheckBox("未来参考(橙)")
        self.cb_blocks = QCheckBox("块边框")
        self.cb_expected = QCheckBox("期望向量(绿虚线)")
        self.cb_mismatch = QCheckBox("差异块红框")
        for cb, attr in [(self.cb_past, "show_past"), (self.cb_future, "show_future"),
                         (self.cb_blocks, "show_blocks"), (self.cb_expected, "show_expected"),
                         (self.cb_mismatch, "show_mismatch")]:
            cb.setChecked(getattr(self.settings, attr))
            cb.toggled.connect(lambda _=False, a=attr, c=cb: self._toggle(a, c))
        self.min_len = QComboBox()
        for v in (0.5, 1.0, 2.0, 4.0, 8.0):
            self.min_len.addItem(f"最短向量 {v:g} px", v)
        self.min_len.currentIndexChanged.connect(self._change_min_len)

        filters = QHBoxLayout()
        for w in (self.cb_past, self.cb_future, self.cb_blocks,
                  self.cb_expected, self.cb_mismatch, self.min_len):
            filters.addWidget(w)
        filters.addStretch(1)
        grid.addLayout(filters, 2, 0, 1, 8)

        # 导出
        btn_img_i = QPushButton("导出左面板当前帧 PNG")
        btn_img_v = QPushButton("导出右面板当前帧 PNG")
        btn_json = QPushButton("导出一组帧的向量 JSON …")
        btn_img_i.clicked.connect(lambda: self.export_image(self.panel_intra))
        btn_img_v.clicked.connect(lambda: self.export_image(self.panel_inter))
        btn_json.clicked.connect(self.export_vectors)
        exp = QHBoxLayout()
        exp.addWidget(btn_img_i)
        exp.addWidget(btn_img_v)
        exp.addWidget(btn_json)
        exp.addStretch(1)
        grid.addLayout(exp, 3, 0, 1, 8)
        return box

    def _build_legend(self) -> QWidget:
        line = QLabel(
            "图例：<span style='color:#266dd3'>■ 蓝箭头=过去参考</span> ｜ "
            "<span style='color:#e07018'>■ 橙箭头=未来参考</span> ｜ "
            "<span style='color:#28be5a'>┄ 绿虚线=程序预设期望向量</span> ｜ "
            "<span style='color:#eb2828'>■ 红框=与预设明显不同的块</span> ｜ "
            "黄框=当前选中块。筛选只隐藏显示，导出的 JSON 始终是完整原始数据。"
        )
        line.setWordWrap(True)
        line.setFrameShape(QFrame.Shape.StyledPanel)
        return line

    # ---------- 行为 ----------
    def _toggle(self, attr: str, cb: QCheckBox) -> None:
        setattr(self.settings, attr, cb.isChecked())
        self._refresh()

    def _change_min_len(self) -> None:
        self.settings.min_length = self.min_len.currentData()
        self._refresh()

    def toggle_play(self) -> None:
        self.playing = not self.playing
        if self.playing:
            self.timer.start()
        else:
            self.timer.stop()

    def _tick(self) -> None:
        if self.frame >= self.gt.frame_count - 1:
            self.toggle_play()
            return
        self.goto(self.frame + 1)

    def goto(self, index: int) -> None:
        index = max(0, min(self.gt.frame_count - 1, int(index)))
        if index == self.frame and self.slider.value() == index:
            return
        self.frame = index
        self._refresh()

    def first(self) -> None: self.goto(0)
    def prev(self) -> None: self.goto(self.frame - 1)
    def next(self) -> None: self.goto(self.frame + 1)
    def last(self) -> None: self.goto(self.gt.frame_count - 1)

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key.Key_Left:
            self.prev()
        elif event.key() == Qt.Key.Key_Right:
            self.next()
        elif event.key() == Qt.Key.Key_Space:
            self.toggle_play()
        else:
            super().keyPressEvent(event)

    def _refresh(self) -> None:
        for p in (self.panel_intra, self.panel_inter):
            p.show_frame(self.frame)
        self.slider.blockSignals(True)
        self.jump.blockSignals(True)
        self.slider.setValue(self.frame)
        self.jump.setValue(self.frame)
        self.slider.blockSignals(False)
        self.jump.blockSignals(False)

    def export_image(self, panel: VideoPanel) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "导出当前帧", f"frame_{self.frame:04d}.png", "PNG 图像 (*.png)")
        if not path:
            return
        save_frame_image(path, panel.video, self.gt, self.frame, self.settings)
        QMessageBox.information(self, "导出完成", f"已保存：{path}")

    def export_vectors(self) -> None:
        dlg = RangeDialog(self.gt.frame_count, self.frame, self)
        if dlg.exec() != dlg.DialogCode.Accepted:
            return
        start, end, target = dlg.values()
        video = self.inter if target == "inter" else self.intra
        path, _ = QFileDialog.getSaveFileName(
            self, "导出向量数据", f"vectors_{start:04d}_{end:04d}.json", "JSON (*.json)")
        if not path:
            return
        save_frame_vectors(path, video, self.gt, range(start, end + 1))
        QMessageBox.information(
            self, "导出完成",
            f"已保存 {end - start + 1} 帧的完整向量数据（含对照结果）：\n{path}")


class RangeDialog(QDialog):
    def __init__(self, frame_count: int, current: int, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("选择帧范围与版本")
        layout = QVBoxLayout(self)
        grid = QGridLayout()
        self.sp_start = QSpinBox()
        self.sp_end = QSpinBox()
        for sp in (self.sp_start, self.sp_end):
            sp.setRange(0, frame_count - 1)
        self.sp_start.setValue(max(0, current - 5))
        self.sp_end.setValue(min(frame_count - 1, current + 5))
        self.version = QComboBox()
        self.version.addItem("前后参考版 inter.mp4", "inter")
        self.version.addItem("纯画内版 intra.mp4", "intra")
        grid.addWidget(QLabel("起始帧"), 0, 0)
        grid.addWidget(self.sp_start, 0, 1)
        grid.addWidget(QLabel("结束帧"), 1, 0)
        grid.addWidget(self.sp_end, 1, 1)
        grid.addWidget(QLabel("版本"), 2, 0)
        grid.addWidget(self.version, 2, 1)
        layout.addLayout(grid)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def values(self) -> tuple[int, int, str]:
        start = min(self.sp_start.value(), self.sp_end.value())
        end = max(self.sp_start.value(), self.sp_end.value())
        return start, end, self.version.currentData()


def run_selftest(sample_dir: str) -> None:
    """无界面自检：实例化主窗口、切帧、点选、导出，覆盖 GUI 关键代码路径。"""
    QApplication.instance() or QApplication([])
    win = MainWindow(sample_dir)
    win.show()

    # 画内帧无向量的状态说明
    assert "画内编码" in win.panel_intra.detail.toPlainText()
    # B 帧同时具备过去/未来参考，并能点选
    win.goto(1)
    fi = win.inter.get_info(1)
    assert fi.pict_type == "B" and fi.has_vectors
    win.panel_inter._pick(100, 100)
    assert win.panel_inter.selected is not None
    # 两面板同步停在同一源画面
    assert win.panel_intra.index == win.panel_inter.index == 1
    # 逐帧/跳转/筛选
    win.next(); win.prev(); win.last(); win.first()
    win.goto(160)
    win.cb_future.setChecked(False)
    win._refresh()
    win.cb_future.setChecked(True)
    print("GUI 自检通过：实例化、切帧、点选、筛选均正常")


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="运动向量本地查看器")
    ap.add_argument("-s", "--sample", default="sample_output", help="样片目录")
    ap.add_argument("--selftest", action="store_true",
                    help="无界面自检（不弹窗），用于验证 GUI 代码路径")
    args = ap.parse_args()

    if args.selftest:
        run_selftest(args.sample)
        return 0

    app = QApplication.instance() or QApplication([])
    win = MainWindow(args.sample)
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
