"""端到端人工/CI 验证脚本（不依赖 pytest）：

  1. 量化抠像质量：绿幕去除、发丝保留、近色小球保护、反光抑制；
  2. 用当前默认参数导出视频并回读，核对尺寸/帧数/音轨；
  3. 逐帧比较“预览 process_frame”与“导出解码画面”的一致性；
  4. 导出几张调参对比 PNG，方便肉眼检查边缘与反光效果。

用法：python scripts/verify_end_to_end.py <素材目录> <输出目录>
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from greenscreen.exporter import export_video  # noqa: E402
from greenscreen.keying import KeyingParams, compute_alpha, despill, process_frame  # noqa: E402
from greenscreen.media import VideoReader, load_image, probe_video  # noqa: E402


def main(asset_dir: str, out_dir: str) -> int:
    asset_dir, out_dir = Path(asset_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    video = asset_dir / "test_greenscreen.mp4"
    bg_path = asset_dir / "test_background.png"

    reader = VideoReader(str(video))
    background = load_image(str(bg_path))
    params = KeyingParams()
    n = reader.frame_count
    h, w = reader.info.height, reader.info.width
    print(f"源视频 {reader.info.width}x{reader.info.height} "
          f"{reader.fps}fps {n}帧 音轨={reader.info.has_audio}")

    # ---- 1. 全帧量化检查 ----
    import math
    sum_corner_alpha = 0.0
    sum_body_alpha = 0.0
    ball_kept_on = ball_kept_off = 0.0
    spill_reduced = 0
    fps = reader.fps
    duration = n / fps
    for j, i in enumerate(range(0, n, 4)):
        frame = reader.read_frame(i)
        alpha = compute_alpha(frame, params)
        sum_corner_alpha += float(alpha[0:10, 0:10].mean())

        # 人物中心随时间横向移动，按生成公式实时定位，避免采到身体边缘
        t = i / fps
        cx = w // 2 + int(60 * math.sin(t * 2 * math.pi / duration))
        cy = h // 2 - 10
        # 躯干中心条带始终被红色衣服实心覆盖
        sum_body_alpha += float(
            alpha[cy + 130:cy + 170, cx - 20:cx + 20].mean())

        on = compute_alpha(frame, KeyingParams(protection_on=True, protection=1.0))
        off = compute_alpha(frame, KeyingParams(protection_on=False))
        bx, by = cx + 30, cy + 120
        ball_kept_on += float(on[by - 8:by + 8, bx - 8:bx + 8].mean())
        ball_kept_off += float(off[by - 8:by + 8, bx - 8:bx + 8].mean())

        corrected = despill(frame, alpha, params)
        g_before = frame[:, :, 1].astype(np.int16)
        g_after = corrected[:, :, 1].astype(np.int16)
        spill_reduced += int((g_before - g_after).max() > 0)

    steps = len(range(0, n, 4))
    metrics = {
        "绿幕角落实测 alpha(应<0.15)": sum_corner_alpha / steps,
        "人物身体 alpha(应>0.9)": sum_body_alpha / steps,
        "小球保护开启 alpha(应高)": ball_kept_on / steps,
        "小球保护关闭 alpha(应低)": ball_kept_off / steps,
        "存在反光抑制的帧占比(应=1.0)": spill_reduced / steps,
    }
    print("\n== 抠像质量指标 ==")
    ok = True
    for k, v in metrics.items():
        print(f"  {k}: {v:.3f}")
    ok &= metrics["绿幕角落实测 alpha(应<0.15)"] < 0.15
    ok &= metrics["人物身体 alpha(应>0.9)"] > 0.9
    ok &= metrics["小球保护开启 alpha(应高)"] > 0.7
    ok &= metrics["小球保护关闭 alpha(应低)"] < 0.4
    ok &= metrics["存在反光抑制的帧占比(应=1.0)"] == 1.0

    # ---- 2. 导出 + 回读 ----
    out_video = out_dir / "verified_composed.mp4"
    result = export_video(str(video), str(bg_path), str(out_video), params)
    print("\n== 导出回读 ==")
    for k in ("width", "height", "fps", "frames_expected",
              "frames_decoded", "has_audio", "verified"):
        print(f"  {k}: {result[k]}")
    ok &= result["verified"]
    ok &= result["frames_decoded"] >= result["frames_expected"] - 2
    ok &= result["has_audio"] is True

    # ---- 3. 预览 vs 导出 逐帧一致性 ----
    cap = cv2.VideoCapture(str(out_video))
    diffs = []
    idx = 0
    preview_frames = []
    while True:
        got, exported = cap.read()
        if not got:
            break
        src = reader.read_frame(idx)
        if src is None:
            break
        preview = process_frame(src, background, params)["composite"]
        diffs.append(np.abs(preview.astype(int) - exported.astype(int)).mean())
        if idx in (0, n // 2, n - 1):
            preview_frames.append((idx, preview, exported))
        idx += 1
    cap.release()
    max_diff, mean_diff = max(diffs), float(np.mean(diffs))
    print(f"\n== 预览/导出一致性 ==  平均差={mean_diff:.3f} 最大差={max_diff:.3f}（H.264 有损，<6 视为一致）")
    ok &= mean_diff < 6.0

    # ---- 4. 调参对比图 ----
    frame0 = reader.read_frame(0)
    variants = {
        "00_original": frame0,
        "01_default": process_frame(frame0, background, params)["composite"],
        "02_soft_edge": process_frame(
            frame0, background,
            KeyingParams(edge_feather=0.8, smoothness=0.6))["composite"],
        "03_hard_edge": process_frame(
            frame0, background,
            KeyingParams(edge_feather=0.0, edge_choke=0.5, smoothness=0.05))[
            "composite"],
        "04_no_despill": process_frame(
            frame0, background, KeyingParams(despill_on=False))["composite"],
        "05_no_protection": process_frame(
            frame0, background, KeyingParams(protection_on=False))["composite"],
    }
    for name, img in variants.items():
        cv2.imwrite(str(out_dir / f"{name}.png"), img)
    print(f"\n对比图已写入 {out_dir}/00~05_*.png")
    reader.close()

    print("\n结果：", "全部通过 ✅" if ok else "存在失败项 ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    asset = sys.argv[1] if len(sys.argv) > 1 else "test_assets"
    out = sys.argv[2] if len(sys.argv) > 2 else "verify_out"
    raise SystemExit(main(asset, out))
