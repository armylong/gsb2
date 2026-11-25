# -*- coding: utf-8 -*-
"""像素预测对照工具 (PySide6)

演示两种可逆的邻近像素预测规则, 对预测误差做可逆压缩(zlib),
并与直接压缩原像素的真实文件大小对比。

约定(全文统一):
  - 图像: 8bit 灰度(C=1)或 RGB(C=3), 内存布局按行优先、像素内通道交错(RGBRGB...)。
  - 每个颜色通道独立预测, 不跨通道引用。
  - 邻居缺失时(图像边缘/每行开头)一律按 0 处理:
      规则 Sub   : 预测值 = 左邻; 每行第一个像素无左邻, 取上邻; 第一行第一列取 0。
      规则 Paeth : a=左邻, b=上邻, c=左上邻, 缺失的邻居取 0, 再按 Paeth 规则选择。
  - 误差 e = (原值 - 预测值) mod 256, 存为 uint8; 显示时映射为有符号数
    (e < 128 ? e : e - 256)。恢复: 原值 = (预测值 + e) mod 256。
    因此负误差同样逐像素可逆。

导出文件格式 (.pxp), 小端:
  偏移  长度  含义
  0     4     magic "PXP1"
  4     4     width  (uint32)
  8     4     height (uint32)
  12    1     channels (1=灰度, 3=RGB)
  13    1     rule (0=Sub, 1=Paeth)
  14    2     保留, 置 0
  16    4     raw_len: 未压缩误差数据字节数 (uint32)
  20    4     crc32: 未压缩误差数据的 CRC32 (uint32)
  24    ...   zlib 压缩后的误差数据
  文件头固定 24 字节, 之后全部为数据。
"""

import struct
import sys
import zlib

import numpy as np

MAGIC = b"PXP1"
HEADER_SIZE = 24
RULES = ["Sub (左邻)", "Paeth (左/上/左上)"]
MAX_DIM = 512  # 只接受小幅图像


# ---------------------------------------------------------------- 核心算法

def predict(img: np.ndarray, rule: int) -> np.ndarray:
    """对 (H,W,C) uint8 图像逐通道预测, 返回同形状 uint8 预测值。"""
    h, w, c = img.shape
    src = img.astype(np.int16)
    pred = np.zeros_like(src)
    left = np.zeros_like(src)
    up = np.zeros_like(src)
    upleft = np.zeros_like(src)
    left[:, 1:, :] = src[:, :-1, :]
    up[1:, :, :] = src[:-1, :, :]
    upleft[1:, 1:, :] = src[:-1, :-1, :]

    if rule == 0:  # Sub: 左邻, 每行开头取上邻, (0,0) 取 0
        pred[:, 1:, :] = left[:, 1:, :]
        pred[1:, 0, :] = up[1:, 0, :]
    elif rule == 1:  # Paeth
        a, b, cc = left, up, upleft
        p = a + b - cc
        pa = np.abs(p - a)
        pb = np.abs(p - b)
        pc = np.abs(p - cc)
        pred = np.where((pa <= pb) & (pa <= pc), a,
                        np.where(pb <= pc, b, cc))
    else:
        raise ValueError(f"未知预测规则: {rule}")
    return pred.astype(np.uint8)


def encode_error(img: np.ndarray, rule: int) -> np.ndarray:
    """返回 (pred, err): err = (img - pred) mod 256, uint8。"""
    pred = predict(img, rule)
    err = (img.astype(np.int16) - pred.astype(np.int16)) % 256
    return pred, err.astype(np.uint8)


def decode_image(pred: np.ndarray, err: np.ndarray) -> np.ndarray:
    """由预测值和误差恢复原图: (pred + err) mod 256。"""
    return ((pred.astype(np.int16) + err.astype(np.int16)) % 256).astype(np.uint8)


def err_to_signed(err: np.ndarray) -> np.ndarray:
    """uint8 误差 -> 有符号显示值 (-128..127)。"""
    e = err.astype(np.int16)
    return np.where(e < 128, e, e - 256)


def compress(data: bytes) -> bytes:
    return zlib.compress(data, 9)


# ---------------------------------------------------------------- 文件格式

def export_pxp(img: np.ndarray, rule: int) -> bytes:
    """把图像按指定规则导出为 .pxp 字节串(头24字节 + zlib误差数据)。"""
    h, w, c = img.shape
    _, err = encode_error(img, rule)
    raw = err.tobytes()
    payload = compress(raw)
    header = MAGIC + struct.pack("<IIBBHII", w, h, c, rule, 0,
                                 len(raw), zlib.crc32(raw) & 0xFFFFFFFF)
    assert len(header) == HEADER_SIZE
    return header + payload


class PxpError(Exception):
    """导入文件损坏/不合法时抛出, 信息面向用户。"""


def import_pxp(data: bytes) -> tuple[np.ndarray, dict]:
    """解析 .pxp, 返回 (图像, 元信息)。数据损坏时抛 PxpError。"""
    if len(data) < HEADER_SIZE:
        raise PxpError(f"文件太短: 只有 {len(data)} 字节, 文件头就需要 {HEADER_SIZE} 字节")
    if data[:4] != MAGIC:
        raise PxpError("文件头魔数不是 PXP1, 这不是本工具导出的文件(或文件头已损坏)")
    w, h, c, rule, _res, raw_len, crc = struct.unpack("<IIBBHII", data[4:HEADER_SIZE])
    if not (1 <= w <= MAX_DIM and 1 <= h <= MAX_DIM):
        raise PxpError(f"文件头中的尺寸非法: {w}x{h}")
    if c not in (1, 3):
        raise PxpError(f"文件头中的通道数非法: {c} (只支持 1 或 3)")
    if rule not in (0, 1):
        raise PxpError(f"文件头中的预测规则非法: {rule}")
    if raw_len != w * h * c:
        raise PxpError(f"文件头自相矛盾: raw_len={raw_len}, 但 {w}x{h}x{c}={w*h*c}")
    payload = data[HEADER_SIZE:]
    try:
        raw = zlib.decompress(payload)
    except zlib.error as e:
        raise PxpError(f"误差数据解压失败, 数据区已损坏: {e}")
    if len(raw) != raw_len:
        raise PxpError(f"解压后长度不符: 期望 {raw_len} 字节, 实际 {len(raw)} 字节")
    if (zlib.crc32(raw) & 0xFFFFFFFF) != crc:
        raise PxpError("CRC32 校验失败: 误差数据与文件头记录不一致, 文件已损坏")
    err = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, c)
    img = reconstruct(err, rule)
    meta = dict(width=w, height=h, channels=c, rule=rule,
                header_size=HEADER_SIZE, data_size=len(payload))
    return img, meta


def reconstruct(err: np.ndarray, rule: int) -> np.ndarray:
    """仅由误差递推重建原图(预测依赖已重建的左/上邻居)。"""
    h, w, c = err.shape
    img = np.zeros((h, w, c), dtype=np.uint8)
    e = err_to_signed(err).astype(np.int32)
    out = img.astype(np.int32)
    for y in range(h):
        for x in range(w):
            a = out[y, x - 1] if x > 0 else 0
            b = out[y - 1, x] if y > 0 else 0
            cc = out[y - 1, x - 1] if (x > 0 and y > 0) else 0
            if rule == 0:
                p = a if x > 0 else (b if y > 0 else 0)
            else:
                p0 = a + b - cc
                pa, pb, pc = np.abs(p0 - a), np.abs(p0 - b), np.abs(p0 - cc)
                p = np.where((pa <= pb) & (pa <= pc), a,
                             np.where(pb <= pc, b, cc))
            out[y, x] = (p + e[y, x]) % 256
    return (out % 256).astype(np.uint8)


# ---------------------------------------------------------------- 内置样图

SAMPLE_SIZE = 128


def sample_gradient() -> np.ndarray:
    """纯渐变: 平滑线性渐变, 预测误差几乎恒定。"""
    s = SAMPLE_SIZE
    y, x = np.mgrid[0:s, 0:s]
    r = (x * 2) % 256
    g = (y * 2) % 256
    b = ((x + y)) % 256
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def sample_lines() -> np.ndarray:
    """细线: 深色底上的 1 像素亮线(水平/垂直/对角)。"""
    s = SAMPLE_SIZE
    img = np.full((s, s, 3), 24, dtype=np.uint8)
    img[::16, :, :] = 220          # 水平线
    img[:, ::16, :] = 220          # 垂直线
    idx = np.arange(s)
    img[idx, idx, :] = 255         # 主对角线
    img[idx, s - 1 - idx, :] = 180  # 副对角线
    return img


def sample_noise() -> np.ndarray:
    """随机颗粒: 固定种子的均匀噪声, 几乎不可预测。"""
    rng = np.random.default_rng(20261125)
    return rng.integers(0, 256, size=(SAMPLE_SIZE, SAMPLE_SIZE, 3), dtype=np.uint8)


SAMPLES = [("内置: 纯渐变", sample_gradient),
           ("内置: 细线", sample_lines),
           ("内置: 随机颗粒", sample_noise)]


# ---------------------------------------------------------------- 统计

def size_report(img: np.ndarray, rule: int) -> dict:
    """真实压缩数字: 直接压原像素 vs 压预测误差, 头/数据分列。"""
    raw = img.tobytes()
    _, err = encode_error(img, rule)
    err_raw = err.tobytes()
    direct_payload = compress(raw)
    pred_payload = compress(err_raw)
    return {
        "raw_bytes": len(raw),
        "direct_header": HEADER_SIZE,
        "direct_data": len(direct_payload),
        "direct_total": HEADER_SIZE + len(direct_payload),
        "pred_header": HEADER_SIZE,
        "pred_data": len(pred_payload),
        "pred_total": HEADER_SIZE + len(pred_payload),
    }


# ---------------------------------------------------------------- 自检

def selftest() -> None:
    for name, fn in SAMPLES:
        img = fn()
        for rule in (0, 1):
            pred, err = encode_error(img, rule)
            back = decode_image(pred, err)
            assert np.array_equal(back, img), f"{name} rule{rule} 预测路径不可逆"
            blob = export_pxp(img, rule)
            img2, meta = import_pxp(blob)
            assert np.array_equal(img2, img), f"{name} rule{rule} 文件往返不一致"
            rep = size_report(img, rule)
            print(f"{name:12s} rule{rule} 原始{rep['raw_bytes']:6d}B  "
                  f"直压{rep['direct_total']:6d}B(头{rep['direct_header']}+数据{rep['direct_data']})  "
                  f"预测压{rep['pred_total']:6d}B(头{rep['pred_header']}+数据{rep['pred_data']})")
        # 灰度也测一轮
        gray = img[..., :1].copy()
        blob = export_pxp(gray, 1)
        img2, _ = import_pxp(blob)
        assert np.array_equal(img2, gray), f"{name} 灰度往返不一致"

    # 损坏检测
    img = sample_gradient()
    blob = bytearray(export_pxp(img, 1))
    blob[-1] ^= 0xFF  # 翻转数据区最后一个字节
    try:
        import_pxp(bytes(blob))
        raise AssertionError("损坏的数据没有被发现")
    except PxpError as e:
        print(f"损坏检测正常: {e}")
    blob2 = bytearray(export_pxp(img, 1))
    blob2[0] = ord('X')  # 破坏魔数
    try:
        import_pxp(bytes(blob2))
        raise AssertionError("坏魔数没有被发现")
    except PxpError as e:
        print(f"魔数检测正常: {e}")
    print("自检全部通过")


# ---------------------------------------------------------------- GUI

def run_gui() -> None:
    from PySide6.QtCore import Qt, QPoint
    from PySide6.QtGui import QImage, QPixmap, QMouseEvent, QPainter, QPen, QColor
    from PySide6.QtWidgets import (QApplication, QComboBox, QFileDialog,
                                   QGridLayout, QGroupBox, QHBoxLayout, QLabel,
                                   QMainWindow, QMessageBox, QPushButton,
                                   QVBoxLayout, QWidget)

    ZOOM = 3

    def to_qimage(arr: np.ndarray) -> QImage:
        a = np.ascontiguousarray(arr)
        h, w, c = a.shape
        if c == 1:
            q = QImage(a.data, w, h, w, QImage.Format_Grayscale8)
        else:
            q = QImage(a.data, w, h, w * 3, QImage.Format_RGB888)
        return q.copy()

    class PixelView(QLabel):
        """可缩放显示 + 鼠标位置上报的图像视图。"""
        def __init__(self, title, on_hover):
            super().__init__()
            self.setAlignment(Qt.AlignCenter)
            self.setMinimumSize(SAMPLE_SIZE * ZOOM // 2, SAMPLE_SIZE * ZOOM // 2)
            self.on_hover = on_hover
            self.title = title
            self.arr = None
            self.cursor = None
            self.setMouseTracking(True)

        def set_array(self, arr):
            self.arr = arr
            self.repaint()

        def paintEvent(self, ev):
            super().paintEvent(ev)
            if self.arr is None:
                return
            p = QPainter(self)
            pm = QPixmap.fromImage(to_qimage(self.arr)).scaled(
                self.arr.shape[1] * ZOOM, self.arr.shape[0] * ZOOM,
                Qt.IgnoreAspectRatio, Qt.FastTransformation)
            ox = (self.width() - pm.width()) // 2
            oy = (self.height() - pm.height()) // 2
            p.drawPixmap(ox, oy, pm)
            if self.cursor is not None:
                x, y = self.cursor
                p.setPen(QPen(QColor(255, 0, 0), 1))
                p.drawRect(ox + x * ZOOM - 1, oy + y * ZOOM - 1, ZOOM + 2, ZOOM + 2)
            p.end()
            self._origin = (ox, oy)

        def mouseMoveEvent(self, ev: QMouseEvent):
            if self.arr is None:
                return
            ox, oy = getattr(self, "_origin", (0, 0))
            x = (ev.position().x() - ox) // ZOOM
            y = (ev.position().y() - oy) // ZOOM
            h, w = self.arr.shape[:2]
            if 0 <= x < w and 0 <= y < h:
                self.on_hover(int(x), int(y))

    class MainWindow(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("像素预测对照 (可逆预测 + zlib)")
            self.img = None          # 当前原图 (H,W,C) uint8
            self.reopened = None     # 从导出文件重开的图
            self.cursor = None

            # --- 控制区
            self.src_combo = QComboBox()
            for name, _ in SAMPLES:
                self.src_combo.addItem(name)
            self.src_combo.addItem("打开 PNG 文件…")
            self.src_combo.currentIndexChanged.connect(self.load_source)

            self.rule_combo = QComboBox()
            for i, r in enumerate(RULES):
                self.rule_combo.addItem(f"规则{i}: {r}")
            self.rule_combo.currentIndexChanged.connect(self.refresh)

            self.btn_export = QPushButton("导出 .pxp…")
            self.btn_export.clicked.connect(self.do_export)
            self.btn_reopen = QPushButton("从 .pxp 重开…")
            self.btn_reopen.clicked.connect(self.do_reopen)
            self.btn_verify = QPushButton("逐像素核对(原图 vs 重开)")
            self.btn_verify.clicked.connect(self.do_verify)

            ctrl = QHBoxLayout()
            ctrl.addWidget(QLabel("图像:"))
            ctrl.addWidget(self.src_combo, 1)
            ctrl.addWidget(QLabel("预测规则:"))
            ctrl.addWidget(self.rule_combo, 1)
            ctrl.addWidget(self.btn_export)
            ctrl.addWidget(self.btn_reopen)
            ctrl.addWidget(self.btn_verify)

            # --- 三个联动视图
            self.views = []
            grid = QGridLayout()
            for i, t in enumerate(("原图", "预测值", "误差(128=零)")):
                box = QGroupBox(t)
                v = QVBoxLayout()
                view = PixelView(t, self.on_hover)
                v.addWidget(view)
                box.setLayout(v)
                grid.addWidget(box, 0, i)
                self.views.append(view)

            # --- 统计
            self.stats = QLabel("")
            self.stats.setTextInteractionFlags(Qt.TextSelectableByMouse)
            self.stats.setStyleSheet("font-family: Menlo, monospace;")
            self.hover_label = QLabel("把鼠标移到任意视图上查看像素")
            self.hover_label.setStyleSheet("font-family: Menlo, monospace;")

            root = QVBoxLayout()
            root.addLayout(ctrl)
            root.addLayout(grid, 1)
            root.addWidget(self.stats)
            root.addWidget(self.hover_label)
            w = QWidget()
            w.setLayout(root)
            self.setCentralWidget(w)
            self.statusBar()

            self.load_source(0)

        # ---------------- 数据加载
        def load_source(self, idx):
            if idx < len(SAMPLES):
                self.img = SAMPLES[idx][1]()
                self.reopened = None
                self.refresh()
            else:
                path, _ = QFileDialog.getOpenFileName(
                    self, "打开 PNG", "", "PNG 图片 (*.png)")
                if path:
                    self.load_png(path)
                else:
                    self.src_combo.blockSignals(True)
                    self.src_combo.setCurrentIndex(0)
                    self.src_combo.blockSignals(False)

        def load_png(self, path):
            q = QImage(path)
            if q.isNull():
                QMessageBox.critical(self, "打开失败", f"无法解码 PNG:\n{path}")
                return
            if q.width() > MAX_DIM or q.height() > MAX_DIM:
                QMessageBox.warning(self, "图片过大",
                                    f"只支持不超过 {MAX_DIM}x{MAX_DIM} 的小图, "
                                    f"此图 {q.width()}x{q.height()}")
                return
            if q.hasAlphaChannel():
                QMessageBox.warning(self, "格式不支持",
                                    "只接受灰度或 RGB, 此 PNG 含 Alpha 通道。")
                return
            if q.isGrayscale():
                q = q.convertToFormat(QImage.Format_Grayscale8)
                arr = np.frombuffer(q.bits(), dtype=np.uint8,
                                    count=q.bytesPerLine() * q.height())
                arr = arr.reshape(q.height(), q.bytesPerLine())[:, :q.width()]
                self.img = arr.reshape(q.height(), q.width(), 1).copy()
            else:
                q = q.convertToFormat(QImage.Format_RGB888)
                arr = np.frombuffer(q.bits(), dtype=np.uint8,
                                    count=q.bytesPerLine() * q.height())
                arr = arr.reshape(q.height(), q.bytesPerLine())[:, :q.width() * 3]
                self.img = arr.reshape(q.height(), q.width(), 3).copy()
            self.reopened = None
            self.refresh()

        # ---------------- 刷新
        def refresh(self):
            if self.img is None:
                return
            rule = self.rule_combo.currentIndex()
            pred, err = encode_error(self.img, rule)
            err_vis = (err_to_signed(err) + 128).clip(0, 255).astype(np.uint8)
            self.views[0].set_array(self.img)
            self.views[1].set_array(pred)
            self.views[2].set_array(err_vis)
            self.pred, self.err = pred, err

            rep = size_report(self.img, rule)
            save = rep["direct_total"] - rep["pred_total"]
            pct = 100.0 * save / rep["direct_total"] if rep["direct_total"] else 0
            h, w, c = self.img.shape
            self.stats.setText(
                f"图像 {w}x{h}, {'灰度' if c == 1 else 'RGB'}, 规则{rule} "
                f"({RULES[rule]})\n"
                f"原始像素: {rep['raw_bytes']} B\n"
                f"直接压缩: 头 {rep['direct_header']} B + 数据 {rep['direct_data']} B"
                f" = {rep['direct_total']} B\n"
                f"预测压缩: 头 {rep['pred_header']} B + 数据 {rep['pred_data']} B"
                f" = {rep['pred_total']} B   "
                f"(比直压{'省' if save >= 0 else '多'} {abs(save)} B, {pct:+.1f}%)"
            )
            self.on_hover(*(self.cursor or (0, 0)))

        def on_hover(self, x, y):
            self.cursor = (x, y)
            for v in self.views:
                v.cursor = (x, y)
                v.repaint()
            if self.img is None:
                return
            o = self.img[y, x]
            p = self.pred[y, x]
            e = err_to_signed(self.err)[y, x]
            fmt = lambda v: str(v.tolist()) if v.ndim else str(int(v))
            self.hover_label.setText(
                f"像素 (x={x}, y={y})   原值 {fmt(o)}   预测 {fmt(p)}   误差 {fmt(e)}"
            )

        # ---------------- 导出 / 重开 / 核对
        def do_export(self):
            if self.img is None:
                return
            path, _ = QFileDialog.getSaveFileName(
                self, "导出 .pxp", "out.pxp", "像素预测文件 (*.pxp)")
            if not path:
                return
            blob = export_pxp(self.img, self.rule_combo.currentIndex())
            with open(path, "wb") as f:
                f.write(blob)
            self.statusBar().showMessage(
                f"已导出 {path} ({HEADER_SIZE} B 头 + {len(blob) - HEADER_SIZE} B 数据)", 8000)

        def do_reopen(self):
            path, _ = QFileDialog.getOpenFileName(
                self, "打开 .pxp", "", "像素预测文件 (*.pxp)")
            if not path:
                return
            try:
                with open(path, "rb") as f:
                    img, meta = import_pxp(f.read())
            except PxpError as e:
                QMessageBox.critical(self, "文件损坏", str(e))
                return
            except OSError as e:
                QMessageBox.critical(self, "读取失败", str(e))
                return
            self.reopened = img
            self.statusBar().showMessage(
                f"已从文件重开: {meta['width']}x{meta['height']}, "
                f"{'灰度' if meta['channels'] == 1 else 'RGB'}, "
                f"规则{meta['rule']}, 头 {meta['header_size']} B + "
                f"数据 {meta['data_size']} B。可点“逐像素核对”。", 10000)

        def do_verify(self):
            if self.reopened is None:
                QMessageBox.information(self, "没有重开的图", "请先用“从 .pxp 重开”加载一个导出文件。")
                return
            if self.img is None:
                QMessageBox.information(self, "没有原图", "当前没有已打开的原图可对照。")
                return
            if self.reopened.shape != self.img.shape:
                QMessageBox.warning(self, "尺寸不一致",
                                    f"原图 {self.img.shape}, 重开图 {self.reopened.shape}")
                return
            diff = np.argwhere(np.any(self.reopened != self.img, axis=-1))
            if len(diff) == 0:
                QMessageBox.information(self, "核对通过",
                                        f"逐像素核对 {self.img.size} 个样本值, 全部一致, 无损。")
            else:
                y, x = diff[0]
                QMessageBox.critical(
                    self, "核对失败",
                    f"共 {len(diff)} 个像素不一致, 第一个在 (x={x}, y={y}):\n"
                    f"原图 {self.img[y, x].tolist()} vs 重开 {self.reopened[y, x].tolist()}")

    app = QApplication(sys.argv)
    win = MainWindow()
    win.resize(1100, 640)
    win.show()
    app.exec()


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        run_gui()
