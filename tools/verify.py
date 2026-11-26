#!/usr/bin/env python3
"""无头验证: 不启动事件循环, 核对最关键的不变量。

运行(仓库根目录):
    .venv/bin/python tools/verify.py

覆盖:
1. 自带样本: 奇数宽 / 重复色异号 / 半透明色号 / 真 4 位打包
2. 4 位与 8 位存盘 -> Pillow + chunk 双重读回, 索引逐项一致
3. 各色号像素数量、确切位置; 同色异号的高亮掩码互不重叠
4. 只改一个色号: 同色的另一个编号区域保持旧颜色
5. “交换外观”与“保外观重编号”的行为差异
6. 任意一步历史快照的颜色与编号都精确
7. 两个换色版本从同一编号图出发, 批量导出后读回核对, 重复色不被合并
8. 色表不足时给出索引出现坐标
9. 打开 RGBA 抛 NotIndexedPngError(UI 据此保留现有编辑)
"""

from __future__ import annotations

import struct
import sys
import tempfile
from pathlib import Path

# 允许直接 `python tools/verify.py`
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image  # noqa: E402

from idxpng.model import EditContext  # noqa: E402
from idxpng.png_io import (  # noqa: E402
    PNG_SIGNATURE,
    NotIndexedPngError,
    _chunk,
    all_passed,
    load_indexed_png,
    parse_chunks,
    verify_output,
    write_indexed_png,
)
from idxpng.render import render_rgba  # noqa: E402
from idxpng.sample import SAMPLE_ROWS, build_sample, ensure_sample_file  # noqa: E402

failures: list[str] = []
checks_count = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global checks_count
    checks_count += 1
    if cond:
        print(f"  \033[32mPASS\033[0m  {name}" + (f" — {detail}" if detail else ""))
    else:
        failures.append(name + (f" ({detail})" if detail else ""))
        print(f"  \033[31mFAIL\033[0m  {name}" + (f" — {detail}" if detail else ""))


def expected_positions(index: int) -> list[tuple[int, int]]:
    ch = {0: ".", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7"}[index]
    return [
        (x, y)
        for y, row in enumerate(SAMPLE_ROWS)
        for x, c in enumerate(row)
        if c == ch
    ]


def offset(doc, xy: tuple[int, int]) -> int:
    x, y = xy
    return (y * doc.width + x) * 4


def test_sample_and_roundtrip(tmp: Path):
    print("\n[1] 样本与 4/8 位往返")
    doc = build_sample()
    check("宽度为奇数", doc.width % 2 == 1, f"width={doc.width}")
    check("样本尺寸 11x11", (doc.width, doc.height) == (11, 11))
    check("#2/#3 颜色完全相同", doc.palette[2] == doc.palette[3] == (239, 83, 80, 255))
    check("#4/#5 颜色完全相同", doc.palette[4] == doc.palette[5] == (66, 165, 245, 255))
    check("#7 是半透明(0<a<255)", 0 < doc.palette[7][3] < 255, f"alpha={doc.palette[7][3]}")
    check("#0 全透明", doc.palette[0][3] == 0)

    sample_path = ensure_sample_file()
    check("样本文件已生成", sample_path.exists(), str(sample_path))
    loaded4 = load_indexed_png(sample_path)
    check("样本 IHDR 位深=4", loaded4.bit_depth == 4, f"depth={loaded4.bit_depth}")
    check("4 位读回索引完全一致", loaded4.indices == doc.indices)
    check("4 位读回色板一致", loaded4.palette == doc.palette)

    p8 = tmp / "sample8.png"
    path8, depth8, _ = write_indexed_png(doc, p8, bit_depth="8")
    check("强制 8 位输出位深=8", depth8 == 8)
    loaded8 = load_indexed_png(path8)
    check("8 位读回索引完全一致", loaded8.indices == doc.indices)
    check("8 位读回透明度一致",
          [c[3] for c in loaded8.palette] == [c[3] for c in doc.palette])

    check("4 位奇数宽末列索引正确",
          all(loaded4.index_at(10, y) == doc.index_at(10, y) for y in range(doc.height)))
    return loaded4


def test_counts_and_highlight(doc) -> None:
    print("\n[2] 像素数量、位置与按索引高亮")
    counts = doc.counts()
    for i in range(8):
        pos = expected_positions(i)
        check(f"#{i} 数量={len(pos)}", counts[i] == len(pos), f"actual={counts[i]}")
        check(f"#{i} positions_of 与图案一致", doc.positions_of(i) == pos)

    pos2 = set(doc.positions_of(2))
    pos3 = set(doc.positions_of(3))
    check("同色的 #2/#3 覆盖区域不相交", pos2.isdisjoint(pos3))

    base = render_rgba(doc)
    hi2 = render_rgba(doc, highlight=2, dim_others=False, outline=False)
    changed = {p // 4 for p in range(0, len(base), 4) if base[p:p + 4] != hi2[p:p + 4]}
    expected_flat2 = {y * doc.width + x for x, y in pos2}
    check("高亮 #2 时画面变化的像素恰好是 #2 覆盖区", changed == expected_flat2,
          f"changed={len(changed)}, expected={len(pos2)}")

    hi2_dim = render_rgba(doc, highlight=2, dim_others=True, outline=False)
    x3, y3 = next(iter(pos3))
    o3 = (y3 * doc.width + x3) * 4
    check("点 #2 时同色的 #3 区域被淡化(不会一起亮)",
          hi2_dim[o3] < doc.palette[3][0] and hi2_dim[o3 + 3] < 255)


def test_color_edit_keeps_duplicate_region(doc) -> None:
    print("\n[3] 改一个色号, 同色异号区域保留")
    d = doc.clone()
    old3 = d.palette[3]
    d.set_color(2, (10, 200, 90, 255))
    check("#2 已改成新颜色", d.palette[2] == (10, 200, 90, 255))
    check("#3 仍是旧红色(编号独立)", d.palette[3] == old3 == (239, 83, 80, 255))
    check("改色不移动任何像素编号", d.indices == doc.indices)

    rendered = render_rgba(d, outline=False)
    o2 = offset(doc, doc.positions_of(2)[0])
    o3 = offset(doc, doc.positions_of(3)[0])
    check("#2 位置渲染为新色", tuple(rendered[o2:o2 + 3]) == (10, 200, 90))
    check("#3 位置仍渲染旧红", tuple(rendered[o3:o3 + 3]) == old3[:3])


def test_swap_vs_renumber(doc) -> None:
    print("\n[4] 交换外观 vs 保外观重编号")
    before_render = render_rgba(doc, outline=False)

    # (a) 交换两个“颜色不同”的格(#2 红 / #4 蓝):
    #     只换 palette, indices 不变 -> 图面两块颜色交换, 渲染变化
    a = doc.clone()
    idx_before = bytearray(a.indices)
    a.swap_appearance(2, 4)
    check("交换外观后像素编号不变", a.indices == idx_before)
    check("色表 #2/#4 的 RGBA 互换",
          a.palette[2] == doc.palette[4] and a.palette[4] == doc.palette[2])
    swapped_render = render_rgba(a, outline=False)
    check("交换异色两格后图面发生变化", swapped_render != before_render)
    o2 = offset(doc, doc.positions_of(2)[0])
    check("原 #2 区域现在显示 #4 的旧蓝色",
          tuple(swapped_render[o2:o2 + 3]) == doc.palette[4][:3])

    # (a2) 交换同色的 #2/#3: 编号不动, 因外观本来就相同, 图面也不变;
    #      但这与“重编号”不是一回事 —— 重编号会改动像素编号(见下)
    a2 = doc.clone()
    a2.swap_appearance(2, 3)
    check("交换同色两格外观后编号仍不变", a2.indices == doc.indices)
    check("交换同色两格外观后图面不变", render_rgba(a2, outline=False) == before_render)

    # (b) 重排编号: 必须是完整排列。交换 2/3 两个编号并同步重映射像素 -> 渲染逐字节一致,
    #     即使 #2/#3 同色, 编号也确实发生了迁移
    b = doc.clone()
    order = list(range(8))
    order[2], order[3] = order[3], order[2]
    b.apply_order(order)
    check("重编号后色表 #2 放的是旧 #3 外观", b.palette[2] == doc.palette[3])
    check("重编号后原 #2 像素已改号为 #3",
          all(b.index_at(x, y) == 3 for x, y in doc.positions_of(2)))
    check("重编号后原 #3 像素已改号为 #2",
          all(b.index_at(x, y) == 2 for x, y in doc.positions_of(3)))
    check("重编号后渲染与原图逐字节一致(图面不变)",
          render_rgba(b, outline=False) == before_render)

    # (c) move_slot: 把 #1 移到 #5, 同样必须保外观
    c = doc.clone()
    c.move_slot(1, 5)
    check("move_slot 后色表格数不变", len(c.palette) == len(doc.palette))
    check("move_slot 后渲染逐字节一致",
          render_rgba(c, outline=False) == before_render)
    check("move_slot 后旧 #1 像素改号为 5",
          all(c.index_at(x, y) == 5 for x, y in doc.positions_of(1)))

    # 非法排列应被拒绝
    bad = doc.clone()
    try:
        bad.apply_order([0, 1, 2])  # 长度不对
        check("非法排列被拒绝", False)
    except Exception:
        check("非法排列被拒绝", True)


def test_history_arbitrary_steps(doc) -> None:
    print("\n[5] 历史: 可跳回任意一步的颜色与编号")
    ctx = EditContext("master", "主图", doc, "读入样本")
    h = ctx.history
    original = ctx.doc.clone()

    d1 = ctx.doc.clone()
    d1.set_color(2, (1, 2, 3, 255))
    h.commit("改 #2", d1)

    d2 = ctx.doc.clone()
    d2.swap_appearance(4, 5)
    h.commit("交换 #4/#5 外观", d2)

    d3 = ctx.doc.clone()
    d3.move_slot(0, 3)
    h.commit("移动 #0 -> #3(保外观重编号)", d3)

    check("共 4 个历史步(含起点)", len(h.steps) == 4)
    check("当前在最后一步", h.cursor == 3)

    h.goto(0)
    check("跳回起点: 索引完全还原", h.current.indices == original.indices)
    check("跳回起点: 色板完全还原", h.current.palette == original.palette)

    h.goto(1)
    check("跳到第1步: #2 是改后颜色", h.current.palette[2] == (1, 2, 3, 255))
    check("跳到第1步: #3 仍是原色", h.current.palette[3] == original.palette[3])
    check("跳到第1步: 编号未被后续操作污染", h.current.indices == original.indices)

    h.goto(3)
    # move_slot(0 -> 3) 得到 order=[1,2,3,0,4,5,6,7], 旧 #2 迁到新 #1
    check("跳到第3步: 保留了 #2 改色(随重编号迁到新号 #1)",
          h.current.palette[1] == (1, 2, 3, 255))
    check("跳到第3步: 编号确实被重排", h.current.indices != original.indices)
    render3 = render_rgba(h.current, outline=False)
    # 第3步是在“已改色 + 交换外观”的基础上做保外观重编号,
    # 所以与第2步渲染一致
    h.goto(2)
    render2 = render_rgba(h.current, outline=False)
    check("第3步(保外观重编号)与第2步图面一致", render3 == render2)

    h.goto(0)
    h.redo()
    check("undo/redo 按钮路径可用", h.cursor == 1)


def test_versions_export(tmp: Path, doc) -> None:
    print("\n[6] 两个换色版本: 同一编号起点 + 批量导出 + 读回核对")
    # 模拟 UI: 从“当前编号图”一次性创建 A/B(此处先做一次重编号作为当前状态)
    current = doc.clone()
    current.move_slot(6, 2)

    ver_a = EditContext("A", "版本 A", current, "从当前编号图创建")
    ver_b = EditContext("B", "版本 B", current, "从当前编号图创建")
    check("A/B 起点索引完全相同", ver_a.base.indices == ver_b.base.indices == current.indices)
    check("A/B 起点色板完全相同", ver_a.base.palette == ver_b.base.palette)

    da = ver_a.doc.clone()
    da.set_color(2, (200, 30, 30, 255))
    da.set_color(7, (102, 187, 106, 96))
    ver_a.history.commit("A: 红/透明调整", da)

    db = ver_b.doc.clone()
    db.set_color(3, (30, 200, 120, 255))
    db.swap_appearance(0, 1)
    ver_b.history.commit("B: 改 #3 并交换 #0/#1 外观", db)

    out_dir = tmp / "export"
    results = []
    for ctx in (ver_a, ver_b):
        target = out_dir / f"{ctx.key}.png"
        path, depth, notes = write_indexed_png(ctx.doc, target, bit_depth="auto")
        check(f"{ctx.key} 导出为索引 PNG(4 位)", depth == 4, f"depth={depth}")
        # 用“实际写盘前 prepare 的 doc”作为核对基准
        from idxpng.png_io import prepare_for_export
        prepared, _ = prepare_for_export(ctx.doc)
        checks = verify_output(path, prepared)
        failed = [c.line() for c in checks if not c.ok]
        check(f"{ctx.key} 回读核对全部通过", all_passed(checks),
              "" if not failed else " | ".join(failed))
        for c in checks:
            if not c.ok:
                print("   ", c.line())
        results.append((path, prepared))

    # 再独立从磁盘读一次, 确认两个同色编号仍然都在、且像素各归各号
    for (path, prepared), ctx in zip(results, (ver_a, ver_b)):
        reread = load_indexed_png(path)
        check(f"{ctx.key}: 重新 load 的索引与编辑态一致",
              reread.indices == prepared.indices)
        rgb = [c[:3] for c in reread.palette]
        # 样本中 #2/#3 同红; A 只改了 #2, 所以现在不同; B 没动这组关系之外...
        # 关键通用断言: PLTE 格数 == 8, 没有任何槽位因同色被吃掉
        check(f"{ctx.key}: PLTE 仍是 8 格(未合并槽位)", len(reread.palette) == 8)
        check(f"{ctx.key}: tRNS 半透明项保留",
              reread.palette[7][3] == prepared.palette[7][3])

    # 强制 8 位再跑一轮核对, 覆盖另一条打包路径
    p8 = out_dir / "A8.png"
    path8, _, _ = write_indexed_png(ver_a.doc, p8, bit_depth="8")
    from idxpng.png_io import prepare_for_export
    prepared8, _ = prepare_for_export(ver_a.doc)
    check("A 的 8 位导出回读通过", all_passed(verify_output(path8, prepared8)))


def test_gap_palette(tmp: Path, doc) -> None:
    print("\n[7] 色表不足: 诊断索引出现位置")
    raw = (ROOT / "samples" / "sample_odd11_duplicate_alpha_4bit.png").read_bytes()
    full_info = parse_chunks(raw)

    # 手工把 PLTE/tRNS 截到 5 格, 制造 #5/#6/#7 越界
    out = bytearray(PNG_SIGNATURE)
    off = 8
    while off + 8 <= len(raw):
        ln = struct.unpack(">I", raw[off:off + 4])[0]
        typ = raw[off + 4:off + 8]
        data = raw[off + 8:off + 8 + ln]
        off += 12 + ln
        if typ == b"PLTE":
            data = data[: 5 * 3]
        elif typ == b"tRNS":
            data = data[:5]
        out += _chunk(typ, data)
    gap_path = tmp / "truncated_plte.png"
    gap_path.write_bytes(bytes(out))

    loaded = load_indexed_png(gap_path)
    check("PLTE 真实长度识别为 5", len(loaded.palette) == 5)
    gaps = loaded.gap_indices()
    check("发现越界色号 #5/#6/#7", gaps == [5, 6, 7], f"gaps={gaps}")
    positions7 = loaded.gap_positions()[7]
    check("#7 的位置与样本图案一致", positions7 == expected_positions(7))
    check("位置坐标可直接定位(示例)", loaded.index_at(*positions7[0]) == 7)


def test_rgba_refused(tmp: Path) -> None:
    print("\n[8] 普通 RGBA 图被拒绝(UI 保留现有编辑)")
    p = tmp / "rgba.png"
    Image.new("RGBA", (7, 5), (12, 34, 56, 128)).save(p)
    try:
        load_indexed_png(p)
        check("打开 RGBA 抛 NotIndexedPngError", False)
    except NotIndexedPngError as e:
        check("打开 RGBA 抛 NotIndexedPngError", True, e.mode)
        check("错误文案解释了原因", "没有色表" in e.user_message())
    except Exception as e:  # noqa: BLE001
        check("打开 RGBA 抛 NotIndexedPngError", False, f"实际 {type(e).__name__}: {e}")


def main() -> int:
    print("=" * 72)
    print("索引色 PNG 编辑器 — 核心不变量验证")
    print("=" * 72)
    with tempfile.TemporaryDirectory(prefix="idxpng_verify_") as td:
        tmp = Path(td)
        doc = test_sample_and_roundtrip(tmp)
        test_counts_and_highlight(doc)
        test_color_edit_keeps_duplicate_region(doc)
        test_swap_vs_renumber(doc)
        test_history_arbitrary_steps(doc)
        test_versions_export(tmp, doc)
        test_gap_palette(tmp, doc)
        test_rgba_refused(tmp)

    print("\n" + "=" * 72)
    if failures:
        print(f"\033[31m{len(failures)} 项失败 / 共 {checks_count} 项检查\033[0m")
        for f in failures:
            print("  -", f)
        return 1
    print(f"\033[32m全部 {checks_count} 项检查通过\033[0m")
    print("颜色重排(保外观)前后渲染逐字节一致; 导出文件索引与 tRNS 回读一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
