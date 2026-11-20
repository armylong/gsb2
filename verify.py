#!/usr/bin/env python3
"""可运行验证 — 在仓库根目录执行:  python verify.py

核对项与容许误差:
  1. 已知曝光亮度比例: 合成线性亮度 vs 独立参考, 各灰块相对误差 ≤ 5%
  2. 中性灰: 合成线性 RGB 通道间相对偏差 ≤ 0.5%;
     调色(饱和度 1.5)后仍 ≤ 0.5% (中性灰不应被调成彩色)
  3. 无效边缘排除: 重叠区裁剪矩形与理论值完全一致;
     边缘条带平均亮度相对误差 ≤ 10% (边缘无效像素不得当成黑色参与合成)
  4. 整组截断提示: 黑/白方块中心 valid=False 且 HDR 值为 0
  5. 数值健康: 极端参数下(零亮度/极亮像素)成品无 NaN/Inf, 值域 [0,1]
  6. 导出: PNG 尺寸 == 有效重叠区尺寸; JSON 含曝光档数/位移/调色参数
  7. GUI 冒烟: 离屏构建主窗口并完成一次合成 (未装 PySide6 时跳过)
"""
import json
import os
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hdr_tool import core, samples

TOL_GRAY = 0.05      # 灰块亮度相对误差
TOL_EDGE = 0.10      # 边缘条带平均亮度相对误差
TOL_NEUTRAL = 0.005  # 中性灰通道间相对偏差

_results = []


def check(name, ok, detail=""):
    _results.append((name, ok))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  {detail}")


def main():
    tmp = Path(tempfile.mkdtemp(prefix="hdr_verify_"))
    print(f"样例目录: {tmp}")
    meta = samples.generate(tmp)
    imgs = [core.load_image(tmp / f) for f in meta["files"]]
    evs = meta["evs"]
    shifts = [tuple(s) for s in meta["shifts"]]
    ref = np.load(tmp / "reference_linear.npy")  # 独立参考, 仅此处核对用
    hdr, valid, crop = core.merge_exposures(imgs, evs, shifts)
    x0, y0, x1, y1 = crop

    # 1. 已知曝光亮度比例
    gx, gy, gw, gh = samples.GRAY_ROW
    pw = gw // len(samples.GRAY_PATCHES)
    ok, details = True, []
    for k in range(len(samples.GRAY_PATCHES)):
        cx, cy = gx + k * pw + pw // 2, gy + gh // 2
        m = float(core.luminance(
            hdr[cy - y0 - 10:cy - y0 + 10, cx - x0 - 10:cx - x0 + 10]).mean())
        t = float(core.luminance(ref[cy - 10:cy + 10, cx - 10:cx + 10]).mean())
        rel = abs(m - t) / t
        ok &= rel <= TOL_GRAY
        details.append(f"块{k}={rel:.2%}")
    check("1 已知曝光亮度比例 (≤5%)", ok, " ".join(details))

    # 2. 中性灰 (线性合成结果 + 调色后)
    tone = core.tone_map(hdr, exposure=0.3, compression=0.5, saturation=1.5)
    ok_lin = ok_tone = True
    for k in range(len(samples.GRAY_PATCHES)):
        cx, cy = gx + k * pw + pw // 2, gy + gh // 2
        for arr, acc in ((hdr, "lin"), (tone, "tone")):
            reg = arr[cy - y0 - 10:cy - y0 + 10, cx - x0 - 10:cx - x0 + 10]
            means = reg.reshape(-1, 3).mean(axis=0)
            dev = float(np.abs(means - means.mean()).max() / means.mean())
            if acc == "lin":
                ok_lin &= dev <= TOL_NEUTRAL
            else:
                ok_tone &= dev <= TOL_NEUTRAL
    check("2 中性灰-线性 (≤0.5%)", ok_lin)
    check("2 中性灰-调色后(饱和1.5) (≤0.5%)", ok_tone)

    # 3. 无效边缘排除
    expected = core.overlap_rect(shifts, samples.W, samples.H)
    check("3 重叠区裁剪矩形正确", crop == expected,
          f"crop={crop} 期望={expected}")
    ok, details = True, []
    strips = {
        "上": (hdr[:10], ref[y0:y0 + 10, x0:x1]),
        "下": (hdr[-10:], ref[y1 - 10:y1, x0:x1]),
        "左": (hdr[:, :10], ref[y0:y1, x0:x0 + 10]),
        "右": (hdr[:, -10:], ref[y0:y1, x1 - 10:x1]),
    }
    for name, (a, b) in strips.items():
        ma = float(core.luminance(a).mean())
        mb = float(core.luminance(b).mean())
        rel = abs(ma - mb) / mb
        ok &= rel <= TOL_EDGE
        details.append(f"{name}={rel:.2%}")
    check("3 边缘条带未被当成黑色 (≤10%)", ok, " ".join(details))

    # 4. 整组截断提示
    for name, rect in (("白块", samples.WHITE_HOLE), ("黑块", samples.BLACK_HOLE)):
        rx, ry, rw, rh = rect
        cx, cy = rx + rw // 2, ry + rh // 2
        inv = not valid[cy - y0, cx - x0]
        zero = bool(np.all(hdr[cy - y0, cx - x0] == 0.0))
        check(f"4 整组截断-{name}标记无效", inv and zero)

    # 5. 数值健康 (零亮度 / 极亮 / 极端参数)
    test = np.array([[[0.0, 0.0, 0.0], [1e6, 1e6, 1e6], [5.0, 0.0, 0.0]]])
    out = core.tone_map(test, exposure=4.0, compression=1.0, saturation=2.0)
    ok = bool(np.all(np.isfinite(out)) and out.min() >= 0.0 and out.max() <= 1.0)
    check("5 极端参数无 NaN/Inf 且值域[0,1]", ok)

    # 6. 导出尺寸与 JSON
    u8 = (core.tone_map(hdr, 0.3, 0.5, 1.1) * 255.0 + 0.5).astype(np.uint8)
    u8[~valid] = (255, 0, 255)
    png = tmp / "export.png"
    core.write_export(png, u8, {
        "images": [{"file": f, "ev": e, "shift": list(s)}
                   for f, e, s in zip(meta["files"], evs, shifts)],
        "tone": {"exposure_stops": 0.3, "compression": 0.5, "saturation": 1.1},
        "crop_xyxy": list(crop),
        "size": [x1 - x0, y1 - y0],
    })
    back = cv2.imread(str(png), cv2.IMREAD_UNCHANGED)
    ok_size = back is not None and back.shape[:2] == (y1 - y0, x1 - x0)
    check("6 导出 PNG 尺寸 == 重叠区尺寸", ok_size,
          f"{back.shape[1]}x{back.shape[0]} 期望 {x1 - x0}x{y1 - y0}")
    j = json.loads(png.with_suffix(".json").read_text(encoding="utf-8"))
    ok_json = (j["size"] == [x1 - x0, y1 - y0]
               and {"images", "tone", "crop_xyxy"} <= j.keys()
               and all({"ev", "shift"} <= set(im) for im in j["images"]))
    check("6 导出 JSON 含曝光/位移/调色参数", ok_json)

    # 7. GUI 冒烟 (离屏)
    try:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        from PySide6.QtWidgets import QApplication
        from hdr_tool.app import MainWindow
        app = QApplication.instance() or QApplication([])
        w = MainWindow()
        w._load_paths([str(tmp / f) for f in meta["files"]], evs, shifts)
        w._merge_timer.stop()
        w._remerge()
        w._retonemap()
        check("7 GUI 冒烟 (离屏合成+调色)",
              w.hdr is not None and w.final_u8 is not None)
    except ImportError:
        print("[SKIP] 7 GUI 冒烟 (未安装 PySide6)")

    n_fail = sum(1 for _, ok in _results if not ok)
    print(f"\n{len(_results) - n_fail}/{len(_results)} 项通过")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
