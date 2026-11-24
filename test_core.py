"""test_core — 核心链路自测 (无 GUI).

运行: python -I test_core.py   (在仓库目录下)
"""

import os
import tempfile

import numpy as np

import gamut_core as gc

failures = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name} {detail}")
    if not cond:
        failures.append(name)


# --- 1. 转换往返: sRGB -> XYZ -> sRGB 应为恒等 ---
rng = np.random.default_rng(7)
vals = rng.random((1000, 3))
lin = gc.GAMUTS["srgb"].decode(vals)
ideal, _ = gc.src_to_target_lin(lin, gc.GAMUTS["srgb"], gc.GAMUTS["srgb"])
check("sRGB->sRGB 恒等", np.abs(ideal - lin).max() < 1e-9,
      f"max={np.abs(ideal - lin).max():.2e}")

# --- 2. P3 纯绿在 sRGB 中超界 ---
p3_green = np.array([[[0.0, 1.0, 0.0]]])
ideal, _ = gc.src_to_target_lin(p3_green, gc.GAMUTS["p3"], gc.GAMUTS["srgb"])
oog = ~gc.in_gamut_mask(ideal)
check("P3 纯绿对 sRGB 超界", bool(oog[0, 0]),
      f"理想值={ideal[0, 0].round(4)}")

# --- 3. 截断与色相压缩都落回色域 ---
for method in ("clip", "hue"):
    mapped, oog_mask = gc.map_to_gamut(ideal, gc.GAMUTS["srgb"], method)
    check(f"{method} 映射后色域内", bool(gc.in_gamut_mask(mapped).all()))

# --- 4. 色相压缩保持色相: 压缩后 hue 角变化小 ---
mapped_h, _ = gc.map_to_gamut(ideal, gc.GAMUTS["srgb"], "hue")
lab_before = gc.xyz_to_lab(ideal @ gc.GAMUTS["srgb"].M.T)
lab_after = gc.xyz_to_lab(mapped_h @ gc.GAMUTS["srgb"].M.T)
h0 = np.arctan2(lab_before[..., 2], lab_before[..., 1])
h1 = np.arctan2(lab_after[..., 2], lab_after[..., 1])
dh = np.abs(np.degrees(h1 - h0))
check("色相压缩保 hue", dh.max() < 1.0, f"max Δh={dh.max():.3f}°")

# --- 5. 色域内像素两种映射都不变 ---
inside = np.array([[[0.2, 0.5, 0.7], [0.9, 0.1, 0.3]]])
for method in ("clip", "hue"):
    mapped, oog_mask = gc.map_to_gamut(inside, gc.GAMUTS["srgb"], method)
    check(f"色域内像素 {method} 不变",
          np.abs(mapped - inside).max() < 1e-6 and not oog_mask.any())

# --- 6. 样图可生成且尺寸非零 ---
for name, fn in gc.SAMPLES.items():
    img = fn()
    check(f"样图 {name}", img.ndim == 3 and img.shape[2] == 3 and img.size > 0,
          f"shape={img.shape}")

# --- 7. 鲜绿样图 P3->sRGB 截断后多块合并 (复现用户场景) ---
greens = gc.SAMPLES["鲜绿组合 (高色度绿)"]()
r = gc.pipeline(greens, gc.GAMUTS["p3"], gc.GAMUTS["srgb"], "clip")
uniq_before = len(np.unique(greens.reshape(-1, 3), axis=0))
uniq_after = len(np.unique(r["mapped_u8"].reshape(-1, 3), axis=0))
check("鲜绿截断后色块合并", uniq_after < uniq_before,
      f"{uniq_before} -> {uniq_after} 种")

# --- 8. 完整链路 + 导出 + 重新载入验证 (两种目标) ---
tmp = tempfile.mkdtemp()
for key in ("srgb", "p3"):
    tgt = gc.GAMUTS[key]
    res = gc.pipeline(gc.SAMPLES["饱和度递进 (6色相x8级)"](),
                      gc.GAMUTS["p3"], tgt, "hue")
    path = os.path.join(tmp, f"out_{key}.png")
    gc.write_png(path, res["mapped_u8"], tgt, {"Mapping": "hue"})
    ok, report = gc.verify_export(path, res["mapped_u8"], tgt)
    check(f"导出验证 ({tgt.label})", ok)
    if not ok:
        print(report)

# --- 9. PNG 读写往返: 编码值逐位一致 ---
arr = (rng.random((37, 53, 3)) * 255).astype(np.uint8)
p = os.path.join(tmp, "roundtrip.png")
gc.write_png(p, arr, gc.GAMUTS["p3"])
back = gc.read_png(p)["rgb"]
check("PNG 编码值往返一致", np.array_equal(arr, back))
check("ICC 描述可读", gc.read_png(p)["icc_desc"] == "pyGT Display P3",
      f"desc='{gc.read_png(p)['icc_desc']}'")

# --- 10. sRGB 导出带 sRGB 块 ---
p2 = os.path.join(tmp, "srgb.png")
gc.write_png(p2, arr, gc.GAMUTS["srgb"])
info = gc.read_png(p2)
check("sRGB 块写入", info["has_srgb"] and info["texts"].get("Target Gamut", "").startswith("sRGB"))

print()
if failures:
    print(f"失败 {len(failures)} 项: {failures}")
    raise SystemExit(1)
print("全部通过")
