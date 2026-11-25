"""无头冒烟测试, 不启动 Qt: python -m tests.test_headless"""

from __future__ import annotations

import json
import os
import tempfile

import cv2

from panel_splitter.demo_image import GROUND_TRUTH, generate_demo_page
from panel_splitter.exporting import export_panels
from panel_splitter.model import PageModel
from panel_splitter.ordering import compute_order
from panel_splitter.segmentation import segment_image


def match_gt(panels, gt):
    # 检测面板含页边白边, 用「GT 内容区被某个面板完整包含」做匹配
    for name, truth in gt.items():
        tx0, ty0, tx1, ty1 = truth
        ok = any(
            p[0] <= tx0 and p[1] <= ty0 and p[2] >= tx1 and p[3] >= ty1
            for p in panels
        )
        assert ok, f"{name} 未被任何切出的面板包含"


def test_initial_segmentation():
    img = generate_demo_page()
    result = segment_image(img)
    print(f"[初次切分] 检测到 {len(result.panels)} 格, {len(result.cuts)} 条缝, "
          f"Otsu 阈值 {result.background_threshold}")
    for i, p in enumerate(result.panels):
        print("  panel", i, p, f"{p[2]-p[0]}x{p[3]-p[1]}")

    # 预期: 断缝导致 B 与 C/E 连成一大格 (1 个), 假缝把 G 切成 2 个,
    # 加 A、D、F => 共 6 格
    assert len(result.panels) == 6, f"预期 6 格, 实际 {len(result.panels)}"

    # 断缝应作为局部缝提示 (x≈432 的竖缝, 覆盖明显不满但又有大段留白)
    broken = [
        c for c in result.partial_cuts
        if c.orientation == "v" and 420 < c.pos < 445
    ]
    assert broken, "断缝未被识别为局部缝提示"
    assert broken[0].coverage < 0.98, "断缝覆盖率应明显低于通缝"
    print(f"[断缝提示] OK: x={broken[0].pos} 覆盖率 {broken[0].coverage:.2f}, "
          f"虚线范围 y={broken[0].start}..{broken[0].end}")

    # 浅灰横缝应被识别 (至少一条 h 缝 coverage>=0.9 落在 y=342 附近)
    gray_seam = [
        c for c in result.cuts
        if c.orientation == "h" and 320 < c.pos < 365 and c.coverage >= 0.9
    ]
    assert gray_seam, "浅灰横缝未被识别"

    # 浅灰缝不该被当内容: 右区 (竖切 x≈705 之后) 应横切出 C/D 与 E/F 两格
    right_panels = [p for p in result.panels if p[0] >= 700]
    assert len(right_panels) == 2, f"右区应 2 格, 实际 {len(right_panels)}"
    # 连体大格: B+C+E (断缝 x≈432 没切开)
    merged = [p for p in result.panels if p[0] < 705 and 342 <= p[1] < 1000]
    assert len(merged) == 1 and merged[0][2] > 700, "断缝应导致 B/C/E 连体"
    print("[初次切分] OK: T 形接版 / 浅灰缝 / 断缝 / 假缝 行为符合预期")
    return img, result


def test_manual_fixes(img, seg):
    model = PageModel(img.shape, seg.panels)

    # 1) 补断缝: 找到 B+C+E 连体大格, 在 x=432 处竖切
    big = max(
        range(len(model.panels)),
        key=lambda i: (
            (model.panels[i][2] - model.panels[i][0])
            * (model.panels[i][3] - model.panels[i][1])
        ),
    )
    rect = model.panels[big]
    before = list(model.panels)
    hint = model.split_panel(big, "v", 432)
    assert len(model.panels) == len(before) + 1
    # 其它格子坐标原样保留
    untouched = [p for i, p in enumerate(before) if i != big]
    assert all(p in model.panels for p in untouched), "补缝误伤了其它格子"
    assert hint.dirty == rect
    print("[补断缝] OK: 只改连体区域, 其它格坐标不变")

    # 2) 合并假缝误切的两个 G (底行 y>=1058 的两块)
    g_parts = [
        i for i, p in enumerate(model.panels)
        if p[1] >= 1058
    ]
    assert len(g_parts) == 2, f"预期找到 2 个 G 碎片, 实际 {g_parts}"
    merged_hint = model.merge_panels(g_parts)
    assert len(model.panels) == 6
    merged = model.panels[merged_hint.panels_added[0]]
    # 合并结果 = 两碎片的外接矩形, 且完整包含 G 内容区
    gx0, gy0, gx1, gy1 = GROUND_TRUTH["G"]
    assert (
        merged[0] <= gx0 and merged[1] <= gy0
        and merged[2] >= gx1 and merged[3] >= gy1
    )
    print("[合并误切] OK: G 还原为", merged)

    # 3) 拖缝: 小幅拖动 A 下边界, 只动共缝的格 (位移足够小, 不破坏内容包含)
    old_seam, target = 342, 348
    hits_before = model.find_seam("h", old_seam, tolerance=4)
    assert hits_before, "没找到 A 下方的横缝"
    saved = {i: model.panels[i] for i in range(len(model.panels))
             if i not in hits_before}
    model.drag_seam("h", old_seam, target, tolerance=4)
    for i, rect_before in saved.items():
        assert model.panels[i] == rect_before, f"拖缝牵动了无关格 {i}"
    print("[拖缝] OK: 共缝格联动, 其余格保留; 新位置 y =", target)

    # undo/redo: 全部撤销回到初态, 全部重做应与撤销前完全一致
    assert model.can_undo
    final_state = list(model.panels)
    while model.undo():
        pass
    assert len(model.panels) == 6, "完全撤销后应回到初次切分的 6 格"
    while model.redo():
        pass
    assert model.panels == final_state, "完全重做后状态与撤销前不一致"
    # 6 格初态 -> 补缝 +1 -> 合并 -1, 最终仍是 6 个面板 (但内容对应 7 个格)
    assert len(model.panels) == 6
    print("[撤销/重做] OK: 状态往返一致")

    match_gt(model.panels, GROUND_TRUTH)
    print("[人工纠正] OK: 最终面板覆盖全部 7 个标注内容格")
    return model


def index_of_gt(panels, gt, name):
    tx0, ty0, tx1, ty1 = gt[name]
    for i, p in enumerate(panels):
        if p[0] <= tx0 and p[1] <= ty0 and p[2] >= tx1 and p[3] >= ty1:
            return i
    raise AssertionError(f"找不到包含 {name} 的面板")


def test_ordering(model):
    panels = model.panels
    ltr = compute_order(panels, "ltr")
    rtl = compute_order(panels, "rtl")
    assert len(ltr.order) == 6
    assert ltr.order[0] == index_of_gt(panels, GROUND_TRUTH, "A")
    # B 是跨行格
    b_idx = index_of_gt(panels, GROUND_TRUTH, "B")
    assert b_idx in ltr.spanning, "B 应被判为跨行格"
    assert ltr.owner_band[b_idx] == 1, "B 应归属顶部所在带"
    # 带内 LTR 与 RTL 顺序相反
    band1 = dict(ltr.bands)[1]
    band1_rtl = dict(rtl.bands)[1]
    assert band1 == list(reversed(band1_rtl))
    print(f"[顺序 LTR] {ltr.order}  跨行={sorted(ltr.spanning)} "
          f"归属带={ltr.owner_band}")
    print(f"[顺序 RTL] {rtl.order}")

    # 手工拖动排序: 把最后一格挪到最前
    new_order = [ltr.order[-1]] + ltr.order[:-1]
    model.set_manual_order(new_order)
    assert model.manual_order == new_order
    model.clear_manual_order()
    print("[手工排序] OK: 覆盖与清除生效")
    return ltr


def test_export(img, model, order_info):
    # 先手工把最后一格挪到最前, 验证导出清单按新顺序
    swapped = [order_info.order[-1]] + order_info.order[:-1]
    model.set_manual_order(swapped)
    with tempfile.TemporaryDirectory() as tmp:
        items, manifest_path, review_path = export_panels(
            img, model.panels, order_info, tmp, margin_px=6,
            order_override=swapped,
        )
        files = sorted(os.listdir(tmp))
        assert len(items) == len(model.panels)
        # 导出首项应等于手工顺序的第一个面板
        assert items[0].panel_index == swapped[0]
        # 6 张小图 + review.png
        assert len([f for f in files if f.endswith(".png")]) == len(items) + 1
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        assert manifest["count"] == len(items)
        assert manifest["panels"][0]["panel_index"] == swapped[0]
        # 留边被夹在图像边界内
        first = manifest["panels"][0]
        assert 0 <= first["x0"] < first["x1"] <= img.shape[1]
        review = cv2.imread(review_path)
        assert review.shape == img.shape
        crop = cv2.imread(os.path.join(tmp, items[0].filename))
        assert crop.shape[0] == first["height"]
        assert crop.shape[1] == first["width"]
    model.clear_manual_order()
    print(f"[导出] OK: {len(items)} 张小图 + manifest(json/csv) + review.png, "
          f"手工改序后清单首项 = 格 {swapped[0]}, 留边 6px")


def test_apply_partial_cut(img):
    seg = segment_image(img)
    assert seg.partial_cuts, "演示图应至少有一条断缝提示"
    model = PageModel(img.shape, seg.panels)
    n0 = len(model.panels)
    cut = next(c for c in seg.partial_cuts if c.orientation == "v")
    hint = model.apply_partial_cut(cut)
    assert hint.dirty is not None
    assert len(model.panels) == n0 + 1
    # 新缝坐标精确落在检测位置
    assert any(abs(p[2] - cut.pos) <= 1 or abs(p[0] - cut.pos) <= 1
               for p in model.panels)
    # 再补一次同位置应被跳过 (已在边界)
    hint2 = model.apply_partial_cut(cut)
    assert hint2.dirty is None
    assert len(model.panels) == n0 + 1
    print(f"[断缝补刀] OK: 在 x={cut.pos} 精确切开, 重复补刀被正确跳过")


def main():
    img, seg = test_initial_segmentation()
    test_apply_partial_cut(img)
    model = test_manual_fixes(img, seg)
    order_info = test_ordering(model)
    test_export(img, model, order_info)
    print("\n全部无头测试通过 ✔")


if __name__ == "__main__":
    main()
