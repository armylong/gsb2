"""生成自带经纬线、斜线和方向标记的 2:1 测试全景图(纯 numpy).

斜线周期整除图宽, 保证图案本身跨过左右接缝连续, 便于检查重投影后的接缝.
"""
import numpy as np


def make_sample(w=2048):
    """生成 w × w/2 的测试全景图, 返回 uint8 RGB 数组."""
    if w % 2:
        raise ValueError("宽度必须为偶数")
    h = w // 2
    yy, xx = np.mgrid[0:h, 0:w]
    img = np.zeros((h, w, 3), np.uint8)

    # 底色: 天(亮蓝)到地(暗红)的竖直渐变
    img[..., 0] = (40 + yy * 80.0 / h).astype(np.uint8)
    img[..., 1] = (60 + yy * 40.0 / h).astype(np.uint8)
    img[..., 2] = (160 - yy * 80.0 / h).astype(np.uint8)

    # 两组斜线, 周期 128 整除常见图宽, 跨过左右接缝连续
    p = 128
    d1 = ((xx + 2 * yy) % p) < 6
    d2 = ((xx - 2 * yy) % p) < 6
    img[d1] = (235, 180, 40)
    img[d2] = (200, 90, 160)

    # 经纬线每 15° 一根
    lon_line = (xx % (w // 24)) < 2
    lat_line = (yy % (h // 12)) < 2
    img[lon_line | lat_line] = (245, 245, 245)
    # 赤道加粗(青色)
    img[h // 2 - 1:h // 2 + 1] = (60, 220, 220)

    # 极区色带: 天顶品红, 天底青
    img[:4] = (255, 0, 255)
    img[-4:] = (0, 255, 255)

    # 方向圆盘(跨接缝安全的距离计算)
    def disc(lon_deg, lat_deg, color, r=None):
        r = r or max(6, w // 64)
        u = (lon_deg + 180.0) / 360.0 * w
        v = (90.0 - lat_deg) / 180.0 * h
        dx = (xx - u + w / 2.0) % w - w / 2.0
        m = dx * dx + (yy - v) ** 2 <= r * r
        img[m] = color

    disc(0, 0, (40, 220, 40))        # 正前方: 绿
    disc(90, 0, (60, 90, 235))       # 左方: 蓝
    disc(-90, 0, (245, 225, 60))     # 右方: 黄
    disc(180, 0, (235, 60, 60))      # 正后方(落在接缝上): 红
    disc(45, 45, (255, 255, 255), r=max(4, w // 128))
    disc(-120, -30, (0, 0, 0), r=max(4, w // 128))
    return img


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "sample_pano.png"
    w = int(sys.argv[2]) if len(sys.argv) > 2 else 2048
    try:
        from PySide6.QtGui import QImage
        arr = make_sample(w)
        h = arr.shape[0]
        QImage(arr.data, w, h, 3 * w, QImage.Format_RGB888).save(path)
        print("已生成", path)
    except ImportError:
        raise SystemExit("需要 PySide6 来写出 PNG: pip install PySide6")
