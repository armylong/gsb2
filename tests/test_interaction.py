"""交互层测试（offscreen）：模拟在图上拖拽画框、移动/缩放、角色与停用切换。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtCore import QEvent, QPoint, QPointF, Qt
from PySide6.QtGui import QMouseEvent, QPixmap
from PySide6.QtWidgets import QApplication

from colorcalib.gui.imageview import ImageView
from colorcalib.gui.qtimage import to_qimage
from colorcalib.sampleimage import build_sample_image

app = QApplication([])


def make_view() -> ImageView:
    sample = build_sample_image()
    qimg, _ = to_qimage(sample.image)
    view = ImageView()
    view.set_image(QPixmap.fromImage(qimg))
    view.resize(900, 700)
    app.processEvents()
    return view, sample


def mouse_event(kind: QEvent.Type, pos: QPoint) -> QMouseEvent:
    return QMouseEvent(
        kind,
        QPointF(pos),
        QPointF(pos),
        Qt.MouseButton.LeftButton,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )


view, sample = make_view()

# --- 1. 拖拽绘制 B2 的取样框 ---
view.set_draw_target("B2")
p0 = view.mapFromScene(QPointF(120, 120))
p1 = view.mapFromScene(QPointF(180, 190))
view.mousePressEvent(mouse_event(QEvent.Type.MouseButtonPress, p0))
view.mouseMoveEvent(mouse_event(QEvent.Type.MouseMove, p1))
view.mouseReleaseEvent(mouse_event(QEvent.Type.MouseButtonRelease, p1))
rois = view.get_rois()
assert len(rois) == 1 and rois[0].patch_id == "B2"
assert rois[0].x0 == 120 and rois[0].y1 == 190
assert view._draw_target is None  # 画完自动退出绘制模式
print("[interaction] 拖拽画框 OK")

# --- 2. 对同一色格再画一次，应替换而不是叠加 ---
view.set_draw_target("B2")
p2 = view.mapFromScene(QPointF(200, 200))
p3 = view.mapFromScene(QPointF(260, 250))
view.mousePressEvent(mouse_event(QEvent.Type.MouseButtonPress, p2))
view.mouseMoveEvent(mouse_event(QEvent.Type.MouseMove, p3))
view.mouseReleaseEvent(mouse_event(QEvent.Type.MouseButtonRelease, p3))
assert len(view.get_rois()) == 1
assert view.get_rois()[0].x0 == 200
print("[interaction] 同格重画替换 OK")

# --- 3. 右键菜单的底层动作：角色与停用切换 ---
item = view._roi_items["B2"]
item.apply_role("check")
assert view.get_rois()[0].role == "check"
item.apply_enabled(False)
assert view.get_rois()[0].enabled is False
item.apply_enabled(True)
assert view.get_rois()[0].enabled is True
print("[interaction] 角色/停用切换 OK")

# --- 4. 拖到图外的坐标被夹到图像范围内 ---
view.set_draw_target("A1")
big0 = view.mapFromScene(QPointF(10, 10))
big1 = view.mapFromScene(QPointF(9999, 9999))
view.mousePressEvent(mouse_event(QEvent.Type.MouseButtonPress, big0))
view.mouseMoveEvent(mouse_event(QEvent.Type.MouseMove, big1))
view.mouseReleaseEvent(mouse_event(QEvent.Type.MouseButtonRelease, big1))
roi = next(r for r in view.get_rois() if r.patch_id == "A1")
assert roi.x0 == 10 and roi.y0 == 10
assert roi.x1 == sample.image.shape[1] and roi.y1 == sample.image.shape[0]
print("[interaction] 越界夹取 OK")

# --- 5. 删除 ---
view.remove_roi("A1")
assert all(r.patch_id != "A1" for r in view.get_rois())
view.clear_rois()
assert view.get_rois() == []
print("[interaction] 删除/清空 OK")

print("交互层测试全部通过")
