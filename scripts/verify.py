#!/usr/bin/env python3
"""无头验证：覆盖任务要求的全部关键行为，全部通过才返回 0。

在 offscreen Qt 下运行，不需要显示器。测试图由本工具自己生成到
独立目录 test_assets/，与源码目录分开。
"""

import os
import sys
import tempfile
import traceback

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import numpy as np

from lithophane.geometry import (
    BoardParams, GridLimitError, MAX_GRID_NODES, build_heightfield,
)
from lithophane.imaging import (
    apply_levels, load_image, make_staircase, make_thinline,
    resize_grid, rgb_to_gray, save_gray_png,
)
from lithophane.mapping import (
    DegenerateRangeError, ThicknessParams, ThicknessRangeError,
    thickness_from_gray,
)
from lithophane.mesh import (
    analyze_mesh, build_mesh, check_watertight, read_stl_binary,
    write_stl_binary,
)

PASS, FAIL = 0, 0
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name} {detail}")
        print(f"  ✗ {name} {detail}")


def section(title: str) -> None:
    print(f"\n== {title} ==")


def expect_error(name: str, exc_type, fn) -> None:
    try:
        fn()
    except exc_type as exc:
        check(f"{name}（抛出 {exc_type.__name__}）", True)
        print(f"      提示：{exc}")
        return
    except Exception as exc:  # noqa: BLE001
        check(f"{name}（抛出 {exc_type.__name__}）", False,
              f"实际抛出 {type(exc).__name__}: {exc}")
        return
    check(f"{name}（抛出 {exc_type.__name__}）", False, "未抛出任何异常")


def main() -> int:
    workdir = tempfile.mkdtemp(prefix="lithophane_verify_")
    asset_dir = os.path.join(REPO, "test_assets")
    os.makedirs(asset_dir, exist_ok=True)
    stair_png = os.path.join(asset_dir, "staircase.png")
    thin_png = os.path.join(asset_dir, "thinline.png")
    save_gray_png(stair_png, make_staircase(256))
    save_gray_png(thin_png, make_thinline(256))

    # 1. 读图：灰度与彩色亮度 -----------------------------------------
    section("1. 灰度/彩色输入")
    g_gray, color = load_image(stair_png)
    check("灰度图载入形状 256×256", g_gray.shape == (256, 256))
    check("灰度图标记为非彩色", color is False)
    rgb = np.zeros((4, 4, 3), dtype=np.uint8)
    rgb[..., 0] = 255  # 纯红
    lum = rgb_to_gray(rgb)
    check("彩色按 Rec.709 折算亮度", abs(float(lum[0, 0]) - 0.2126) < 1e-9)
    check("灰度取值范围 [0,1]", g_gray.min() >= 0.0 and g_gray.max() <= 1.0)

    # 2. 黑白点、方向、厚度范围 ---------------------------------------
    section("2. 色阶与厚度方向")
    stair = make_staircase(256, 8).astype(np.float64) / 255.0
    tp = ThicknessParams(t_min=1.0, t_max=3.0, dark_thick=True)
    t_dark = thickness_from_gray(stair, tp)
    check("暗部更厚：最暗列厚度=t_max", np.isclose(t_dark[:, 0].max(), 3.0))
    check("暗部更厚：最亮列厚度=t_min", np.isclose(t_dark[:, -1].min(), 1.0))
    tp2 = ThicknessParams(t_min=1.0, t_max=3.0, dark_thick=False)
    t_light = thickness_from_gray(stair, tp2)
    check("翻转方向：最暗列厚度=t_min", np.isclose(t_light[:, 0].min(), 1.0))
    check("翻转方向：最亮列厚度=t_max", np.isclose(t_light[:, -1].max(), 3.0))
    check("翻转后同像素厚度互补",
          np.allclose(t_dark + t_light, 4.0))  # t_min+t_max
    squeezed = apply_levels(stair, 0.2, 0.8)
    check("黑白点拉伸后仍在 [0,1]", squeezed.min() == 0.0 and
          squeezed.max() == 1.0)
    expect_error("黑白点冲突", DegenerateRangeError,
                 lambda: apply_levels(stair, 0.7, 0.3))
    expect_error("厚度上下限冲突", ThicknessRangeError,
                 lambda: ThicknessParams(t_min=2.0, t_max=2.0).validate())
    expect_error("厚度下限为负", ThicknessRangeError,
                 lambda: ThicknessParams(t_min=-1.0, t_max=2.0).validate())

    # 3. 极端参数下细线仍可分辨 ---------------------------------------
    section("3. 细线在极端参数下的可分辨性")
    thin = make_thinline(256).astype(np.float64) / 255.0
    extreme = ThicknessParams(t_min=0.999, t_max=1.001,
                              black_point=0.05, white_point=0.95,
                              dark_thick=True)
    field = build_heightfield(thin, BoardParams(width_mm=100, height_mm=100,
                                                cols=256, rows=256,
                                                border_mm=0.0,
                                                border_thickness_mm=1.0),
                              extreme)
    row = field.thickness[128, :]
    check("极端参数下整行厚度极差 > 0", float(row.max() - row.min()) > 0.0)
    check("1px 暗线处（x≈64）比相邻白底厚",
          float(row[64]) > float(row[70]))
    check("厚度极差即使很小也保留（< 0.002mm 仍非零）",
          0.0 < float(row.max() - row.min()) < 0.002)

    # 4. 物理尺寸与采样密度独立 ---------------------------------------
    section("4. 分辨率切换不改变实体尺寸")
    bp_lo = BoardParams(width_mm=120.0, height_mm=90.0, cols=60, rows=45,
                        border_mm=4.0, border_thickness_mm=3.0)
    bp_hi = BoardParams(width_mm=120.0, height_mm=90.0, cols=300, rows=225,
                        border_mm=4.0, border_thickness_mm=3.0)
    f_lo = build_heightfield(thin, bp_lo, ThicknessParams())
    f_hi = build_heightfield(thin, bp_hi, ThicknessParams())
    check("低密度 x 范围 0~120mm",
          np.isclose(f_lo.x_coords[0], 0.0) and np.isclose(f_lo.x_coords[-1], 120.0))
    check("高密度 x 范围仍为 0~120mm（不是像素数）",
          np.isclose(f_hi.x_coords[-1], 120.0))
    check("两种密度 y 范围一致 0~90mm",
          np.isclose(f_lo.y_coords[0], 90.0) and np.isclose(f_hi.y_coords[0], 90.0))
    check("板内平均厚度两种密度接近",
          abs(float(f_lo.thickness[~f_lo.is_border].mean()) -
              float(f_hi.thickness[~f_hi.is_border].mean())) < 0.05)

    # 5. 边框与板身接合 -----------------------------------------------
    section("5. 边框与板身接合")
    bp = BoardParams(width_mm=100, height_mm=80, cols=200, rows=160,
                     border_mm=5.0, border_thickness_mm=2.5)
    f = build_heightfield(thin, bp, ThicknessParams(t_min=1.0, t_max=3.0))
    check("首行为边框且厚度等于边框厚度",
          bool(f.is_border[0, :].all()) and
          np.allclose(f.thickness[0, :], 2.5))
    check("末行为边框", bool(f.is_border[-1, :].all()))
    check("左右两列为边框",
          bool(f.is_border[:, 0].all()) and bool(f.is_border[:, -1].all()))
    check("边框内侧紧邻板身（无空隙：每列都被赋值）",
          bool((~f.is_border).any()) and not np.any(np.isnan(f.thickness)))
    # 边框宽度的物理位置
    inner_cols = np.where(~f.is_border[80, :])[0]
    x_inner0, x_inner1 = f.x_coords[inner_cols[0]], f.x_coords[inner_cols[-1]]
    check("边框物理宽度约 5mm",
          abs(x_inner0 - 5.0) < 1.0 and abs((100.0 - x_inner1) - 5.0) < 1.0)

    # 6. 等比例留边 ---------------------------------------------------
    section("6. 非正方形图等比例留边")
    wide = np.linspace(0, 1, 200, dtype=np.float64)[None, :].repeat(50, axis=0)
    bp_fit = BoardParams(width_mm=100, height_mm=100, cols=150, rows=150,
                         border_mm=0.0, border_thickness_mm=2.0,
                         keep_aspect=True)
    f_fit = build_heightfield(wide, bp_fit,
                              ThicknessParams(t_min=1.0, t_max=3.0))
    border_rows = np.where(f_fit.is_border[:, 75])[0]
    inner_rows = np.where(~f_fit.is_border[:, 75])[0]
    check("留边模式下存在上下留边", border_rows.size > 0 and inner_rows.size > 0)
    check("留边区为边框厚度 2.0mm",
          np.allclose(f_fit.thickness[border_rows, 75], 2.0))
    win_h = (f_fit.y_coords[inner_rows[0]] -
             f_fit.y_coords[inner_rows[-1]])
    check("图像窗口保持 4:1 纵横比（宽100 → 高25mm）",
          abs(win_h - 25.0) < 2.0)
    f_stretch = build_heightfield(
        wide, BoardParams(100, 100, 150, 150, 0.0, 2.0, keep_aspect=False),
        ThicknessParams(t_min=1.0, t_max=3.0))
    check("非留边模式图像铺满内框", not f_stretch.is_border.any())

    # 7. 退化输入 -----------------------------------------------------
    section("7. 退化输入处理")
    one_col = np.full((64, 1), 0.5)
    f_col = build_heightfield(one_col,
                              BoardParams(80, 80, 100, 100, 2.0, 2.0),
                              ThicknessParams())
    check("单列图不报错且网格形状正确", f_col.thickness.shape == (100, 100))
    body_col = f_col.thickness[~f_col.is_border]
    check("单列图板身厚度一致（uniform 标记含边框差异故单独验证）",
          np.allclose(body_col, body_col.flat[0]))
    uniform = np.full((48, 48), 0.3)
    f_uni = build_heightfield(uniform,
                              BoardParams(80, 80, 96, 96, 0.0, 2.0),
                              ThicknessParams())
    check("完全同色图标记 uniform", f_uni.uniform is True)
    check("完全同色厚度映射正确",
          np.allclose(f_uni.thickness,
                      thickness_from_gray(np.full((1,), 0.3),
                                          ThicknessParams())))
    one_row = np.full((1, 64), 0.7)
    f_row = build_heightfield(one_row,
                              BoardParams(80, 80, 100, 100, 2.0, 2.0),
                              ThicknessParams())
    check("单行图同样安全处理", f_row.thickness.shape == (100, 100))
    expect_error("网格规模超限", GridLimitError,
                 lambda: build_heightfield(
                     thin, BoardParams(80, 80, 2000, 2000), ThicknessParams()))
    check(f"上限常量为 {MAX_GRID_NODES:,}", MAX_GRID_NODES == 1_000_000)

    # 8. 重采样退化安全性 ---------------------------------------------
    section("8. 重采样边界情况")
    r1 = resize_grid(one_col, 100, 100)
    check("单列重采样到 100×100 不崩溃", r1.shape == (100, 100))
    check("单列重采样值保持", np.allclose(r1, 0.5))
    r2 = resize_grid(thin, 33, 47)
    check("下采样/上采样任意尺寸", r2.shape == (33, 47))

    # 9. STL 闭合网格 -------------------------------------------------
    section("9. 闭合三角网格与 STL 往返")
    f = build_heightfield(thin,
                          BoardParams(100, 80, 120, 96, 4.0, 3.0),
                          ThicknessParams(t_min=1.0, t_max=3.0))
    mesh = build_mesh(f.thickness, f.x_coords, f.y_coords)
    rows, cols = f.thickness.shape
    # 正面 (rows-1)(cols-1)*2 + 背面同数 + 四壁 2*(rows-1+cols-1)*2
    expected_tris = 2 * (rows - 1) * (cols - 1) * 2 + \
        2 * (2 * (rows - 1) + 2 * (cols - 1))
    check("三角数 = 正面+背面+四壁",
          mesh.n_triangles == expected_tris,
          f"{mesh.n_triangles} vs {expected_tris}")
    watertight, boundary = check_watertight(mesh)
    check("网格闭合（每条边恰好两个面）", watertight, f"边界边 {boundary}")
    # 等厚板上检查法向：正背面水平、四壁竖直
    flat = np.full((24, 30), 2.0)
    x_flat = np.linspace(0, 100, 30)
    y_flat = np.linspace(80, 0, 24)
    m_flat = build_mesh(flat, x_flat, y_flat)
    nf = m_flat.normals
    horiz = np.isclose(nf[:, 0], 0, atol=1e-8) & np.isclose(nf[:, 1], 0, atol=1e-8)
    check("等厚板正背面三角均水平", bool(horiz.any()) and
          np.allclose(np.abs(nf[horiz, 2]), 1.0))
    check("等厚板朝上/朝下三角数相等",
          int((nf[horiz, 2] > 0).sum()) == int((nf[horiz, 2] < 0).sum()))
    check("等厚板四壁法向水平（z 分量为 0）",
          np.allclose(nf[~horiz, 2], 0.0, atol=1e-8))
    # 斜面上的壁面允许带 z 分量（物理即斜坡），只需保证整体闭合
    check("存在朝上正面与朝下背面",
          (mesh.normals[:, 2] > 0.9).any() and (mesh.normals[:, 2] < -0.9).any())
    up_frac = float((mesh.normals[:, 2] > 0.9).mean())
    check("正面法向占比约 1/2（正背面面积相等）", 0.45 < up_frac < 0.55)

    stl_path = os.path.join(workdir, "plate.stl")
    write_stl_binary(stl_path, mesh)
    check("STL 文件大小符合二进制格式",
          os.path.getsize(stl_path) == 84 + mesh.n_triangles * 50)
    mesh2 = read_stl_binary(stl_path)
    check("读回三角数一致", mesh2.n_triangles == mesh.n_triangles)
    check("读回顶点被正确焊接", mesh2.vertices.shape[0] == rows * cols * 2)
    analysis = analyze_mesh(mesh2, rows, cols)
    check("读回闭合性", analysis.watertight)
    check("读回宽=100mm", abs(analysis.width - 100.0) < 0.01,
          f"got {analysis.width}")
    check("读回高=80mm", abs(analysis.height - 80.0) < 0.01)
    check("读回厚度范围=3.0mm（z 从 0 起）",
          abs(analysis.depth - 3.0) < 0.01, f"got {analysis.depth}")
    check("背面位于 z=0", abs(analysis.bbox_min[2]) < 1e-6)
    check("最薄≈1.0mm", abs(analysis.t_min - 1.0) < 0.01)
    check("最厚≈3.0mm（边框）", abs(analysis.t_max - 3.0) < 0.01)

    # 10. 上下方向与厚度位置往返一致 ----------------------------------
    section("10. 方向与厚度位置往返")
    grid_diff = np.abs(analysis.thickness_grid - f.thickness)
    check("读回厚度逐点最大偏差 < 0.01mm（float32 精度）",
          float(grid_diff.max()) < 0.01, f"max={grid_diff.max()}")
    # 顶部方向标记（细线图左上角暗块）应在读回网格顶部同样最厚
    marker_src = f.thickness[8:29, 8:29]
    marker_rb = analysis.thickness_grid[8:29, 8:29]
    check("左上角方向标记位置厚度一致",
          np.allclose(marker_src, marker_rb, atol=0.01))
    check("顶部行平均厚度 > 底部行（标记在顶部，暗=厚）",
          analysis.thickness_grid[:20].mean() >
          analysis.thickness_grid[-20:].mean())
    # 翻转方向后最薄最厚位置互换（无边框板，避免边框厚度干扰）
    # 用与网格同尺寸的图，避免重采样插值混入标记边界
    thin_native = make_thinline(96).astype(np.float64) / 255.0
    f_flip = build_heightfield(
        thin_native, BoardParams(100, 80, 96, 96, 0.0, 3.0),
        ThicknessParams(t_min=1.0, t_max=3.0, dark_thick=False))
    # 暗像素值 dark=40/255，亮部更厚时其厚度 = t_min + span*(40/255)
    expected_dark_t = 1.0 + 2.0 * (40.0 / 255.0)
    check("翻转后暗标记处变为薄板（亮部更厚时暗部取映射下限端）",
          np.allclose(f_flip.thickness[3:11, 3:11],
                      expected_dark_t, atol=0.02),
          f"got min={f_flip.thickness[3:11, 3:11].min():.4f}")
    mesh_flip = build_mesh(f_flip.thickness, f_flip.x_coords, f_flip.y_coords)
    flip_path = os.path.join(workdir, "plate_flip.stl")
    write_stl_binary(flip_path, mesh_flip)
    a_flip = analyze_mesh(read_stl_binary(flip_path), 96, 96)
    check("翻转后读回最薄处落在暗标记区域",
          a_flip.min_pos[0] < 30 and a_flip.min_pos[1] < 30)

    # 11. GUI 冒烟测试（offscreen）------------------------------------
    section("11. GUI offscreen 冒烟")
    from PySide6.QtWidgets import QApplication
    from lithophane.app import MainWindow, thickness_colormap, backlight_qimage
    app = QApplication.instance() or QApplication(sys.argv)
    win = MainWindow()
    win._load_array(make_thinline(256), "细线测试图")
    app.processEvents()
    check("GUI 载入后生成高度场", win.field is not None)
    check("三视图均有图像",
          win.view_thick._image is not None and
          win.view_back._image is not None and
          win.view_gray._image is not None)
    win.on_row_selected(0.25)
    app.processEvents()
    gui_cols = win.field.thickness.shape[1]
    check("选行后剖面数据更新",
          win.profile._thick_row is not None and
          win.profile._thick_row.shape[0] == gui_cols)
    # 触发超限：保留旧预览
    old = win.field
    win.sp_cols.setValue(2000)
    win.sp_rows.setValue(2000)
    win.recompute()
    app.processEvents()
    check("超限时保留旧预览", win.field is old)
    # 触发厚度冲突：保留旧预览
    win.sp_tmin.setValue(2.5)
    win.recompute()
    app.processEvents()
    check("厚度冲突时保留旧预览", win.field is old)
    win.sp_tmin.setValue(0.8)
    # 完整导出 + 自动读回路径
    gui_stl = os.path.join(workdir, "gui_plate.stl")
    from PySide6.QtWidgets import QFileDialog
    QFileDialog.getSaveFileName = staticmethod(
        lambda *a, **k: (gui_stl, ""))
    win.on_export()
    app.processEvents()
    check("GUI 导出 STL 落盘", os.path.exists(gui_stl))
    check("GUI 读回厚度图已渲染", win.view_readback._image is not None)
    check("GUI 读回信息含实体范围", "实体范围" in win.lbl_readback.text())
    check("GUI 读回方向核对通过", "上下方向核对：一致" in win.lbl_readback.text())
    # 伪彩/背光渲染不崩溃且有层次
    cmap_img = thickness_colormap(f.thickness, 1.0, 3.0)
    check("厚度伪彩图尺寸正确", cmap_img.width() == cols)
    bl = backlight_qimage(f)
    check("背光预览尺寸正确", bl.width() == cols)

    print(f"\n结果：{PASS} 通过，{FAIL} 失败")
    if FAIL:
        print("失败项：")
        for item in FAILURES:
            print("  -", item)
        return 1
    print("全部验证通过。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        raise SystemExit(2)
