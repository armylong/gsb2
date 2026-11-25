"""PySide6 画布: 显示原图、面板框、缝、序号与跨行标记, 处理鼠标交互。

所有模型坐标都是原图像素; 屏幕坐标通过 scale/offset 显式换算,
缩放只改显示, 绝不回写模型矩形。
"""

from __future__ import annotations

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QImage,
    QMouseEvent,
    QPainter,
    QPen,
    QPixmap,
    QWheelEvent,
)
from PySide6.QtWidgets import QWidget

from ..ordering import OrderInfo
from ..segmentation import Cut
from ..model import PageModel

MODE_SELECT = "select"
MODE_DRAG_SEAM = "drag_seam"
MODE_SPLIT_H = "split_h"
MODE_SPLIT_V = "split_v"
MODE_MERGE = "merge"
MODE_REORDER = "reorder"

_SEAM_TOL = 8  # 屏幕像素, 捕捉缝的容差


def _qimage_from_bgr(image_bgr) -> QImage:
    h, w = image_bgr.shape[:2]
    # QImage 要连续内存且按 RGB 排布
    rgb = image_bgr[:, :, ::-1].copy()
    return QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()


class CanvasWidget(QWidget):
    panels_changed = Signal()
    status_message = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMouseTracking(True)
        self.setMinimumSize(480, 640)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

        self._pixmap: QPixmap | None = None
        self.image_shape: tuple[int, int] = (0, 0)
        self.model: PageModel | None = None
        self.order_info: OrderInfo | None = None
        self.auto_cuts: list[Cut] = []
        self.partial_cuts: list[Cut] = []

        self.mode = MODE_SELECT
        self.scale = 1.0
        self.offset = QPointF(0, 0)

        # 交互临时状态
        self._drag: dict | None = None
        self._merge_box: QRectF | None = None
        self._hover_seam: tuple[str, int] | None = None

    # ---------- 数据装载 ----------
    def set_image(self, image_bgr, model: PageModel,
                  cuts: list[Cut], partials: list[Cut]) -> None:
        self._pixmap = QPixmap.fromImage(_qimage_from_bgr(image_bgr))
        self.image_shape = image_bgr.shape[:2]
        self.model = model
        self.auto_cuts = cuts
        self.partial_cuts = partials
        self.fit_to_view()
        self.update()

    def set_order_info(self, info: OrderInfo) -> None:
        self.order_info = info
        self.update()

    def set_mode(self, mode: str) -> None:
        self.mode = mode
        self.setCursor(
            Qt.CursorShape.CrossCursor
            if mode in (MODE_SPLIT_H, MODE_SPLIT_V, MODE_MERGE)
            else Qt.CursorShape.ArrowCursor
        )
        self.update()

    # ---------- 坐标换算 ----------
    def fit_to_view(self) -> None:
        if self._pixmap is None:
            return
        sw = max(1, self.width() - 20)
        sh = max(1, self.height() - 20)
        self.scale = min(sw / self._pixmap.width(), sh / self._pixmap.height())
        self.offset = QPointF(
            (self.width() - self._pixmap.width() * self.scale) / 2,
            (self.height() - self._pixmap.height() * self.scale) / 2,
        )
        self.update()

    def to_image(self, pos: QPoint) -> tuple[int, int]:
        x = (pos.x() - self.offset.x()) / self.scale
        y = (pos.y() - self.offset.y()) / self.scale
        return int(round(x)), int(round(y))

    def to_screen(self, x: float, y: float) -> QPointF:
        return QPointF(self.offset.x() + x * self.scale,
                       self.offset.y() + y * self.scale)

    def resizeEvent(self, event):
        self.fit_to_view()
        super().resizeEvent(event)

    def wheelEvent(self, event: QWheelEvent) -> None:
        if self._pixmap is None:
            return
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        new_scale = max(0.05, min(8.0, self.scale * factor))
        anchor = event.position()
        img_x = (anchor.x() - self.offset.x()) / self.scale
        img_y = (anchor.y() - self.offset.y()) / self.scale
        self.scale = new_scale
        self.offset = QPointF(
            anchor.x() - img_x * new_scale,
            anchor.y() - img_y * new_scale,
        )
        self.update()

    # ---------- 缝捕捉 ----------
    def _nearest_seam(self, ix: int, iy: int) -> tuple[str, int] | None:
        """返回 (orientation, 原图坐标 pos), 优先贴合面板边界。"""
        if self.model is None:
            return None
        tol = _SEAM_TOL / self.scale
        best: tuple[str, int] | None = None
        best_d = tol
        for (x0, y0, x1, y1) in self.model.panels:
            for pos, orient, on_path in (
                (y0, "h", x0 <= ix <= x1),
                (y1, "h", x0 <= ix <= x1),
                (x0, "v", y0 <= iy <= y1),
                (x1, "v", y0 <= iy <= y1),
            ):
                if not on_path:
                    continue
                d = abs(iy - pos) if orient == "h" else abs(ix - pos)
                if d <= best_d:
                    best_d, best = d, (orient, pos)
        return best

    # ---------- 鼠标 ----------
    def mousePressEvent(self, event: QMouseEvent) -> None:
        if self.model is None:
            return
        ix, iy = self.to_image(event.position().toPoint())

        if event.button() == Qt.MouseButton.MiddleButton:
            self._drag = {"kind": "pan", "start": event.position()}
            return

        if self.mode == MODE_DRAG_SEAM:
            seam = self._nearest_seam(ix, iy)
            if seam:
                orient, pos = seam
                self._drag = {
                    "kind": "seam", "orient": orient,
                    "old_pos": pos, "hit": event.position(),
                }
            else:
                self.status_message.emit("没有捕捉到附近的缝")
            return

        if self.mode in (MODE_SPLIT_H, MODE_SPLIT_V):
            want = "h" if self.mode == MODE_SPLIT_H else "v"
            # 优先: 点中同方向的断缝虚线, 按检测位置精确补刀
            tol = _SEAM_TOL / self.scale
            for cut in self.partial_cuts:
                if cut.orientation != want:
                    continue
                near = (
                    abs(ix - cut.pos) <= tol
                    if want == "v"
                    else abs(iy - cut.pos) <= tol
                )
                along = (
                    cut.start - tol <= iy <= cut.end + tol
                    if want == "v"
                    else cut.start - tol <= ix <= cut.end + tol
                )
                if near and along:
                    hint = self.model.apply_partial_cut(cut)
                    if hint.dirty is not None:
                        self.status_message.emit(
                            f"已按断缝提示补 {want} 缝 @ {cut.pos}"
                        )
                        self.panels_changed.emit()
                    else:
                        self.status_message.emit("该断缝已在边界上, 无需补")
                    return

            idx = self.model.panel_at(ix, iy)
            if idx < 0:
                self.status_message.emit("请在某个格子内部下刀")
                return
            hint = self.model.split_panel(idx, want, iy if want == "h" else ix)
            if hint.dirty is None:
                self.status_message.emit("下刀位置太靠边, 无法切分")
            else:
                self.status_message.emit(
                    f"已补 {want} 缝, 格子 {idx} 一分为二"
                )
                self.panels_changed.emit()
            return

        if self.mode == MODE_MERGE:
            self._merge_box = QRectF(event.position(), event.position())
            self.update()
            return

        if self.mode == MODE_REORDER:
            idx = self.model.panel_at(ix, iy)
            if idx >= 0 and self.order_info is not None:
                order = list(
                    self.model.manual_order
                    if self.model.manual_order is not None
                    else self.order_info.order
                )
                pos = order.index(idx)
                if pos > 0:
                    order[pos - 1], order[pos] = order[pos], order[pos - 1]
                    self.model.set_manual_order(order)
                    self.panels_changed.emit()
                    self.status_message.emit(
                        f"格 {idx} 在阅读顺序中前移一位"
                    )
            return

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._pixmap is None:
            return
        if self._drag and self._drag["kind"] == "pan":
            delta = event.position() - self._drag["start"]
            self.offset += delta
            self._drag["start"] = event.position()
            self.update()
            return

        if self._drag and self._drag["kind"] == "seam":
            self._drag["hit"] = event.position()
            self.update()
            return

        if self._merge_box is not None:
            self._merge_box.setBottomRight(event.position())
            self.update()
            return

        if self.mode == MODE_DRAG_SEAM:
            ix, iy = self.to_image(event.position().toPoint())
            self._hover_seam = self._nearest_seam(ix, iy)
            self.setCursor(
                Qt.CursorShape.SizeVerCursor
                if self._hover_seam and self._hover_seam[0] == "h"
                else Qt.CursorShape.SizeHorCursor
                if self._hover_seam
                else Qt.CursorShape.ArrowCursor
            )
            self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if self._drag and self._drag["kind"] == "seam":
            ix, iy = self.to_image(event.position().toPoint())
            d = self._drag
            new_pos = iy if d["orient"] == "h" else ix
            if new_pos != d["old_pos"]:
                tol = _SEAM_TOL / self.scale
                self.model.drag_seam(
                    d["orient"], d["old_pos"], new_pos, int(tol)
                )
                self.status_message.emit(
                    f"缝已移动到 {new_pos} (原图像素)"
                )
                self.panels_changed.emit()
            self._drag = None
            self.update()
            return

        if self._merge_box is not None:
            self._finish_merge()
            self._merge_box = None
            self.update()
            return

        self._drag = None

    def _finish_merge(self) -> None:
        rect = self._merge_box.normalized()
        tl = self.to_image(rect.topLeft().toPoint())
        br = self.to_image(rect.bottomRight().toPoint())
        x0, y0 = tl
        x1, y1 = br
        if x1 - x0 < 4 or y1 - y0 < 4:
            self.status_message.emit("框选范围太小, 取消合并")
            return
        hit = [
            i for i, (px0, py0, px1, py1) in enumerate(self.model.panels)
            if px0 < x1 and px1 > x0 and py0 < y1 and py1 > y0
        ]
        if len(hit) < 2:
            self.status_message.emit("框内不足两个格子, 无法合并")
            return
        self.model.merge_panels(hit)
        self.status_message.emit(f"已合并 {len(hit)} 个格子")
        self.panels_changed.emit()

    # ---------- 外部触发的重排 ----------
    def swap_order(self, idx_a: int, idx_b: int) -> None:
        """拖序: 交换两个面板在阅读顺序里的位置。"""
        if self.model is None or self.order_info is None:
            return
        order = list(
            self.model.manual_order
            if self.model.manual_order is not None
            else self.order_info.order
        )
        if idx_a in order and idx_b in order:
            pa, pb = order.index(idx_a), order.index(idx_b)
            order[pa], order[pb] = order[pb], order[pa]
            self.model.set_manual_order(order)
            self.panels_changed.emit()
            self.status_message.emit("阅读顺序已手动调整")

    # ---------- 绘制 ----------
    def paintEvent(self, event):
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(38, 40, 46))
        if self._pixmap is None or self.model is None:
            painter.setPen(QColor(200, 200, 200))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                             "打开图片或生成演示页开始")
            return

        painter.save()
        painter.translate(self.offset)
        painter.scale(self.scale, self.scale)
        painter.drawPixmap(0, 0, self._pixmap)

        # 检测到的局部断缝: 橙色虚线提示
        pen = QPen(QColor(255, 150, 40), 2.0 / self.scale, Qt.PenStyle.DashLine)
        painter.setPen(pen)
        for cut in self.partial_cuts:
            self._paint_cut(painter, cut)

        # 面板框 + 序号
        seq_of = self._seq_map()
        for i, (x0, y0, x1, y1) in enumerate(self.model.panels):
            spanning = bool(
                self.order_info and i in self.order_info.spanning
            )
            color = (
                QColor(255, 140, 0) if spanning
                else QColor(60, 180, 90)
            )
            pen = QPen(color, 2.5 / self.scale)
            painter.setPen(pen)
            painter.drawRect(QRectF(x0, y0, x1 - x0, y1 - y0))

            seq = seq_of.get(i)
            if seq is not None:
                self._paint_seq_tag(painter, x0, y0, seq, spanning, color)

        # 拖动中的缝预览
        if self._drag and self._drag["kind"] == "seam":
            d = self._drag
            ix, iy = self.to_image(d["hit"].toPoint())
            pen = QPen(QColor(80, 170, 255), 2.0 / self.scale,
                       Qt.PenStyle.DashLine)
            painter.setPen(pen)
            if d["orient"] == "h":
                painter.drawLine(0, iy, self._pixmap.width(), iy)
            else:
                painter.drawLine(ix, 0, ix, self._pixmap.height())

        # 合并框: 屏幕坐标系, 单独 save/restore 不动图像变换栈
        if self._merge_box is not None:
            painter.save()
            painter.resetTransform()
            pen = QPen(QColor(255, 210, 60), 2)
            painter.setPen(pen)
            painter.drawRect(self._merge_box.normalized())
            painter.restore()

        painter.restore()

    def _paint_cut(self, painter: QPainter, cut: Cut) -> None:
        if cut.orientation == "h":
            painter.drawLine(cut.start, cut.pos, cut.end, cut.pos)
        else:
            painter.drawLine(cut.pos, cut.start, cut.pos, cut.end)

    def _seq_map(self) -> dict[int, int]:
        if self.order_info is None:
            return {}
        if self.model.manual_order is not None:
            order = self.model.manual_order
        else:
            order = self.order_info.order
        return {idx: seq for seq, idx in enumerate(order, start=1)}

    def _paint_seq_tag(self, painter, x, y, seq, spanning, color):
        font = QFont()
        fs = max(14, self.image_shape[1] // 55)
        font.setPixelSize(fs)
        painter.setFont(font)
        tag = f"#{seq}" + (" T" if spanning else "")
        fm = painter.fontMetrics()
        tw = fm.horizontalAdvance(tag)
        th = fm.height()
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(20, 20, 20, 210))
        painter.drawRect(QRectF(x + 2, y + 2, tw + 10, th + 4))
        painter.setPen(QColor(255, 255, 255))
        painter.drawText(QPointF(x + 7, y + th), tag)
        painter.setBrush(Qt.BrushStyle.NoBrush)
