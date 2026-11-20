"""把自生成演示素材落盘，便于不开 GUI 直接验证。

用法（在仓库根目录）：
    python scripts/generate_demo_assets.py [输出目录，默认 demo_assets]

生成：
    demo_scene.png            背景纹理 + 可辨认主体 + 独立颜色标记
    blocked_mask.png          全宽横向保护带（白色=保护），阻断一切接缝
    partial_band_mask.png     中部保护带，删若干缝后才不可行
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from content_aware import demos  # noqa: E402


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "demo_assets")
    out.mkdir(parents=True, exist_ok=True)

    image, markers = demos.make_demo_scene()
    h, w = image.shape[:2]
    cv2.imwrite(str(out / "demo_scene.png"), image)

    blocked = demos.make_blocked_mask(h, w)
    partial = demos.make_partial_band_mask(h, w)
    cv2.imwrite(str(out / "blocked_mask.png"), blocked.astype("uint8") * 255)
    cv2.imwrite(str(out / "partial_band_mask.png"), partial.astype("uint8") * 255)

    print(f"演示图 {w}x{h} 已写入 {out.resolve()}")
    print("独立颜色标记（源图坐标 x,y, 边长, BGR）：")
    for m in markers:
        print("  ", m)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
