"""交错素材的场/帧时间模型。

所有定位都基于 ffprobe 实测的输入帧 pts, 再按用户选择的场序推导每个场的
内容时间, 绝不使用「平均帧率 × 帧号」反推。

约定 (与 ffmpeg tinterlace/yadif 语义一致, 已由实验验证):
  输入交错帧 i 含两个场, 帧 pts 为 t_i;
  TFF: 顶场时间 = t_i,          底场时间 = t_i + 半场间隔;
  BFF: 底场时间 = t_i,          顶场时间 = t_i + 半场间隔。
即一场的时间宽度恒为输入帧间隔的一半。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Parity = Literal["tff", "bff"]
Mode = Literal["raw", "single", "double"]


@dataclass(frozen=True)
class FieldTime:
    """一个输出帧所对应的场时间信息。"""

    index: int            # 0 基场序号 (全局, 跨所有输入帧)
    time: float           # 该场的内容时间 (秒)
    field_kind: str       # "top" / "bottom"
    input_frame: int      # 来源输入帧序号
    input_pts: float      # 来源输入帧的真实 pts


class TimingModel:
    """依据真实输入 pts 与场序构造三种输出节奏的时间映射。"""

    def __init__(self, input_pts: list[float], parity: Parity):
        if not input_pts:
            raise ValueError("输入 pts 为空")
        self.input_pts = list(input_pts)
        self.parity: Parity = parity
        # CFR 前提: 用相邻真实 pts 的中位数估计帧间隔, 避免单点抖动。
        diffs = [
            input_pts[i + 1] - input_pts[i]
            for i in range(len(input_pts) - 1)
        ]
        diffs.sort()
        self.frame_period = diffs[len(diffs) // 2] if diffs else 0.0
        self.field_period = self.frame_period / 2.0

    # ---- 基础: 输入帧 -> 两个场 ----
    def fields_of_input(self, i: int) -> tuple[FieldTime, FieldTime]:
        t = self.input_pts[i]
        if self.parity == "tff":
            first = FieldTime(2 * i, t, "top", i, t)
            second = FieldTime(2 * i + 1, t + self.field_period, "bottom", i, t)
        else:
            first = FieldTime(2 * i, t, "bottom", i, t)
            second = FieldTime(2 * i + 1, t + self.field_period, "top", i, t)
        return first, second

    def all_fields(self) -> list[FieldTime]:
        """按内容时间排列的全部场 (每场一个时间点)。"""
        out: list[FieldTime] = []
        for i in range(len(self.input_pts)):
            a, b = self.fields_of_input(i)
            out.append(a)
            out.append(b)
        out.sort(key=lambda f: f.time)
        return out

    # ---- 三种输出节奏 ----
    def output_count(self, mode: Mode) -> int:
        if mode in ("raw", "single"):
            return len(self.input_pts)
        return 2 * len(self.input_pts)

    def output_frame_time(self, mode: Mode, out_index: int) -> float:
        """某个输出帧的内容时间 (秒), 全部来自真实 pts 推导。"""
        if mode in ("raw", "single"):
            return self.input_pts[out_index]
        return self.all_fields()[out_index].time

    def output_field_info(self, mode: Mode, out_index: int) -> FieldTime:
        """某个输出帧来自哪一段场时间。"""
        if mode == "double":
            return self.all_fields()[out_index]
        # raw / single: 一个输出帧对应一个完整输入帧, 标签给该帧第一个场。
        first, _ = self.fields_of_input(out_index)
        return first

    def source_input_for_output(self, mode: Mode, out_index: int) -> int:
        """该输出帧由哪一个输入帧去隔行得到。"""
        if mode in ("raw", "single"):
            return out_index
        return self.all_fields()[out_index].input_frame

    # ---- 反向定位 ----
    def nearest_output_index(self, mode: Mode, content_time: float) -> int:
        """按内容时间找最近的输出帧 (用于时间定位, 不用帧率乘时间)。"""
        n = self.output_count(mode)
        best, best_dt = 0, float("inf")
        for i in range(n):
            dt = abs(self.output_frame_time(mode, i) - content_time)
            if dt < best_dt:
                best, best_dt = i, dt
        return best

    def field_index_for_output(self, mode: Mode, out_index: int) -> int:
        """输出帧对应的全局场序号, 用于跨视图按内容时间对齐。"""
        if mode == "double":
            return self.output_field_info(mode, out_index).index
        # raw/single 落在输入帧起点, 对应该帧第一个场。
        return 2 * out_index

    def output_index_at_field(self, mode: Mode, field_index: int) -> int:
        """给定全局场序号, 求某视图里覆盖该场时间的输出帧。"""
        if mode == "double":
            return min(field_index, self.output_count(mode) - 1)
        # raw/single: 每个输出帧覆盖两个场。
        return min(field_index // 2, self.output_count(mode) - 1)

    def label_for(self, mode: Mode, out_index: int) -> str:
        """供界面显示的单行标签: 输出帧时间 + 来源场时间。"""
        t = self.output_frame_time(mode, out_index)
        info = self.output_field_info(mode, out_index)
        kind_cn = "顶场" if info.field_kind == "top" else "底场"
        if mode == "double":
            return (
                f"输出帧 {out_index + 1}/{self.output_count(mode)}  "
                f"帧时间 {t:.3f}s  |  来源: 输入帧{info.input_frame + 1} "
                f"(pts {info.input_pts:.3f}s) 的{kind_cn}, 场时间 {info.time:.3f}s"
            )
        first, second = self.fields_of_input(out_index)
        return (
            f"输出帧 {out_index + 1}/{self.output_count(mode)}  "
            f"帧时间 {t:.3f}s  |  输入帧{info.input_frame + 1} "
            f"(pts {info.input_pts:.3f}s): "
            f"{'顶' if first.field_kind == 'top' else '底'}场 {first.time:.3f}s → "
            f"{'顶' if second.field_kind == 'top' else '底'}场 {second.time:.3f}s"
        )
