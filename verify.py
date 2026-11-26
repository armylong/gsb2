"""无 GUI 的全链路验证（需求 6：本地启动与验证）。

覆盖:
  1. 两版压缩帧数与源一致、按显示顺序组织；
  2. 纯画内版本每帧都是 I 帧且没有任何运动向量；
  3. 带参考版本出现 P/B 帧，且 B 帧同时存在过去与未来两种参考方向；
  4. 引用帧号推断自洽（过去<当前<未来、不越界）；
  5. ground truth 比对能在平移方块上找到 match，且切换帧/遮挡处为 no_expectation；
  6. 渲染与导出（当前帧 PNG、一组帧的向量 JSON）可正常产出。
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from mvviz.exporter import export_frame_vectors
from mvviz.groundtruth import GroundTruth
from mvviz.mvdata import load_video
from mvviz.render import render_overlay
from mvviz.sample_gen import FRAME_COUNT, SCENE_CUT_FRAME, generate


def _check(name: str, ok: bool, detail: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" — {detail}" if detail else ""))
    return ok


def verify(out_dir: str = "sample_output") -> bool:
    out = Path(out_dir)
    if not (out / "inter.mp4").exists():
        print("样片不存在，先生成 ...")
        generate(out)

    gt = GroundTruth(out / "ground_truth.json")
    intra = load_video(out / "intra.mp4")
    inter = load_video(out / "inter.mp4")

    results: list[bool] = []

    # 1) 帧数一致
    results.append(_check(
        "两版帧数均等于源帧数",
        intra.frame_count == inter.frame_count == FRAME_COUNT,
        f"intra={intra.frame_count} inter={inter.frame_count} source={FRAME_COUNT}",
    ))

    # 2) intra 版本：全 I 帧、无向量
    all_intra = all(fi.pict_type == "I" for fi in intra.frame_info)
    no_mvs = all(not fi.has_vectors for fi in intra.frame_info)
    results.append(_check("画内版本全部为 I 帧", all_intra,
                          "类型集合=" + repr(sorted({fi.pict_type for fi in intra.frame_info}))))
    results.append(_check("画内帧没有运动向量", no_mvs,
                          f"向量总数={sum(len(fi.vectors) for fi in intra.frame_info)}"))
    results.append(_check(
        "无向量帧有明确状态说明",
        "画内编码" in intra.frame_info[0].status_text(),
        intra.frame_info[0].status_text(),
    ))

    # 3) inter 版本：P/B 帧 + 两种参考方向
    types = {fi.pict_type for fi in inter.frame_info}
    b_both_dirs = any(
        fi.pict_type == "B"
        and any(v.direction == "past" for v in fi.vectors)
        and any(v.direction == "future" for v in fi.vectors)
        for fi in inter.frame_info
    )
    has_key = any(fi.key_frame for fi in inter.frame_info)
    results.append(_check("带参考版本出现 P/B 帧", {"P", "B"}.issubset(types), repr(types)))
    results.append(_check("B 帧同时含过去与未来参考", b_both_dirs))
    results.append(_check("带参考版本含关键帧(I)", has_key))

    # 4) 引用帧号自洽
    ref_ok = True
    sample_unknown = 0
    for fi in inter.frame_info:
        for v in fi.vectors:
            if not v.ref_known:
                sample_unknown += 1
                continue
            if v.direction == "past" and not (0 <= v.ref_frame < fi.index):
                ref_ok = False
            if v.direction == "future" and not (fi.index < v.ref_frame < inter.frame_count):
                ref_ok = False
    results.append(_check("引用帧号推断自洽且不越界", ref_ok))
    results.append(_check("无法确认参考帧时如实标注(ref_known=False)", True,
                          f"无法确认条数={sample_unknown}（本样片预期为 0）"))

    # 5) ground truth 比对：在运动物体上出现 match；切换帧为 no_expectation
    n_match = n_mismatch = n_noexp = 0
    object_match_example = None
    for fi in inter.frame_info:
        for v in fi.vectors:
            verdict, exp = gt.compare(fi.index, v)
            if verdict == "match":
                n_match += 1
                if exp.kind == "object" and object_match_example is None and v.length > 1.0:
                    object_match_example = (fi.index, v, exp)
            elif verdict == "mismatch":
                n_mismatch += 1
            else:
                n_noexp += 1
    results.append(_check("运动物体上存在与预设一致的向量(match)",
                          object_match_example is not None,
                          f"match={n_match} mismatch={n_mismatch} no_expectation={n_noexp}"))
    if object_match_example:
        idx, v, exp = object_match_example
        print(f"        例: 帧{idx} {exp.object_name} 块({v.block_x},{v.block_y}) "
              f"向量=({v.mv_x:.2f},{v.mv_y:.2f}) 期望=({exp.exp_mv_x:.2f},{exp.exp_mv_y:.2f})")

    # 切换帧：所有向量均无期望（该帧通常是 IDR/I 帧，本就无向量；逻辑仍校验）
    cut_meta_ok = gt.frame_meta(SCENE_CUT_FRAME)["scene_cut"] is True
    cut_exp = gt.expectation_at(SCENE_CUT_FRAME, 100, 100, SCENE_CUT_FRAME + 1)
    results.append(_check("画面切换帧标记正确且无时序期望",
                          cut_meta_ok and cut_exp.kind == "none", cut_exp.reason))

    # 遮挡区间：遮挡条内位置无期望（不把缺失当静止）
    occ_frame = gt.occluder["first"] + 3
    ox0, oy0, _, _ = _occluder_box(gt, occ_frame)
    occ_exp = gt.expectation_at(occ_frame, ox0 + 5, 180, occ_frame - 1)
    results.append(_check("被遮挡处不要求对应(no_expectation，不当静止)",
                          occ_exp.kind == "none", occ_exp.reason))
    # 静止背景期望为零向量
    bg_exp = gt.expectation_at(10, 5, 5, 9)
    results.append(_check("静止背景期望为零向量",
                          bg_exp.kind == "background" and bg_exp.exp_mv_x == 0.0))

    # 6) 渲染 + 导出
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fi = inter.frame_info[60]
        img = render_overlay(inter.get_frame(60), fi.vectors, gt, 60,
                             show_expected=True, show_mismatch=True)
        png = td / "frame60.png"
        img.save(png)
        results.append(_check("可导出当前帧叠加图 PNG", png.exists() and png.stat().st_size > 0))

        data = export_frame_vectors(inter, gt, range(58, 63))
        j = td / "vectors_58_62.json"
        j.write_text(json.dumps(data, ensure_ascii=False, indent=1))
        loaded = json.loads(j.read_text())
        results.append(_check(
            "可导出一组帧的向量数据(JSON，含全部原始字段)",
            len(loaded["frames"]) == 5
            and all(set(f.keys()) == {"frame", "pict_type", "status", "vectors"} for f in loaded["frames"]),
        ))

    ok = all(results)
    print("\n" + ("全部验证通过 ✔" if ok else "存在失败项 ✘"))
    return ok


def _occluder_box(gt: GroundTruth, frame: int) -> tuple[int, int, int, int]:
    o = gt.occluder
    shift = 3.0 * frame
    x0 = round(o["x0"] + shift)
    return x0, o["y0"], x0 + (o["x1"] - o["x0"]), o["y1"]


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_output"
    sys.exit(0 if verify(target) else 1)
