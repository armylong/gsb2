"""程序预设的真实运动模型，以及与压缩运动向量的逐块比对.

设计原则（对应需求 5）:
  * 期望运动来自样片生成时记录的物体速度，几何位置可逐块复算；
  * 画面切换帧、被遮挡条盖住的块、参考点出画/被盖住的块 -> “无期望”，
    缺失数据不被当作静止，也不参与“明显不同”判定；
  * 只有编码器向量与期望向量都存在、且参考帧可确认时才比对。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from .mvdata import MotionVector

# 向量与期望之差（欧氏距离，像素）超过该值判为“明显不同”
MISMATCH_THRESHOLD_PX = 3.0


@dataclass
class Expectation:
    kind: str                 # "object" | "background" | "none"
    exp_mv_x: float = 0.0
    exp_mv_y: float = 0.0
    object_name: str | None = None
    reason: str = ""          # kind == "none" 时说明原因


class GroundTruth:
    def __init__(self, path: str | Path):
        self.data = json.loads(Path(path).read_text())
        self.width: int = self.data["width"]
        self.height: int = self.data["height"]
        self.frame_count: int = self.data["frame_count"]
        self.scene_cut_frame: int = self.data["scene_cut_frame"]
        self.occluder = self.data["occluder"]

    def frame_meta(self, frame: int) -> dict:
        return self.data["frames"][frame]

    def _occluder_active(self, frame: int) -> bool:
        o = self.occluder
        return o["first"] <= frame <= o["last"]

    def _occluder_box(self, frame: int) -> tuple[int, int, int, int]:
        o = self.occluder
        shift = 3.0 * frame  # 与 sample_gen 中遮挡条 vx 保持一致
        x0 = round(o["x0"] + shift)
        return x0, o["y0"], x0 + (o["x1"] - o["x0"]), o["y1"]

    def expectation_at(self, frame: int, x: float, y: float,
                       ref_frame: int | None) -> Expectation:
        """求当前帧 (x,y) 处、指向 ref_frame 的期望运动向量（像素单位）。"""
        meta = self.frame_meta(frame)

        # 画面切换帧：切换瞬间没有任何时序对应
        if meta["scene_cut"]:
            return Expectation("none", reason="画面切换帧，无时序对应")

        # 参考帧无法确认时不做比对（如实标出，见 viewer 详情）
        if ref_frame is None:
            return Expectation("none", reason="参考帧无法确认，不做比对")

        ref_meta = self.frame_meta(ref_frame)
        if ref_meta["scene_cut"] or (frame < self.scene_cut_frame) != (ref_frame < self.scene_cut_frame):
            return Expectation("none", reason="参考点跨画面切换，无时序对应")

        # 当前位置被遮挡条盖住：盖住处不要求有对应，不当作静止
        if self._occluder_active(frame):
            ox0, oy0, ox1, oy1 = self._occluder_box(frame)
            if ox0 <= x < ox1 and oy0 <= y < oy1:
                return Expectation("none", reason="该位置当前帧被遮挡条盖住")

        # 找当前位置所在的运动物体（遮挡条本身也是平移物体）
        owner = None
        for obj in meta["objects"]:
            bx0, by0, bx1, by1 = obj["box"]
            if bx0 <= x < bx1 and by0 <= y < by1:
                owner = obj
                break

        if owner is not None:
            # 参考点 = 当前位置沿视觉速度走到参考帧
            span = ref_frame - frame  # 负数=参考过去，正数=参考未来
            rx = x + owner["vx"] * span
            ry = y + owner["vy"] * span
            if not (0 <= rx < self.width and 0 <= ry < self.height):
                return Expectation("none", reason=f"物体参考点出画（{owner['name']}）")
            # 参考点在参考帧被遮挡条盖住 -> 不要求有对应
            if self._occluder_active(ref_frame):
                ox0, oy0, ox1, oy1 = self._occluder_box(ref_frame)
                if ox0 <= rx < ox1 and oy0 <= ry < oy1:
                    return Expectation("none", reason="参考点在参考帧被遮挡条盖住")
            # 运动向量从当前块指向参考块
            return Expectation(
                "object",
                exp_mv_x=rx - x,
                exp_mv_y=ry - y,
                object_name=owner["name"],
            )

        # 静止背景：期望为零向量。先确认参考位置仍在画面内
        if not (0 <= x < self.width and 0 <= y < self.height):
            return Expectation("none", reason="背景参考点出画")
        return Expectation("background", exp_mv_x=0.0, exp_mv_y=0.0)

    def compare(self, frame: int, mv: MotionVector) -> tuple[str, Expectation]:
        """返回 (verdict, expectation)；verdict 见 compare_vector。"""
        exp = self.expectation_at(frame, mv.dst_x, mv.dst_y, mv.ref_frame)
        return compare_vector(mv, exp), exp


def compare_vector(mv: MotionVector, exp: Expectation) -> str:
    """判定结果: match | mismatch | no_expectation | ref_unknown。"""
    if exp.kind == "none":
        if "参考帧无法确认" in exp.reason:
            return "ref_unknown"
        return "no_expectation"
    dist = math.hypot(mv.mv_x - exp.exp_mv_x, mv.mv_y - exp.exp_mv_y)
    return "mismatch" if dist > MISMATCH_THRESHOLD_PX else "match"
