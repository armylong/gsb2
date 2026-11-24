"""verify_export — 命令行重新载入导出的 PNG 并验证编码值与色域说明.

用法:
  python verify_export.py 文件.png [期望参照.png]

  给出期望参照时, 逐像素比对编码值; 否则做结构与色域自检并输出报告.
"""

import sys

import numpy as np

import gamut_core as gc


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    expected = None
    if len(argv) > 2:
        try:
            expected = gc.read_png(argv[2])["rgb"]
        except gc.PNGError as e:
            print(f"参照文件无法载入: {e}")
            return 2
    # 根据内嵌标记推断目标色域; 推断不出则按 sRGB 自检
    tgt = None
    try:
        png = gc.read_png(path)
        desc = png["icc_desc"]
        if "P3" in desc:
            tgt = gc.GAMUTS["p3"]
        elif "sRGB" in desc or png["has_srgb"]:
            tgt = gc.GAMUTS["srgb"]
    except gc.PNGError:
        pass
    ok, report = gc.verify_export(path, expected, tgt)
    print(report)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
