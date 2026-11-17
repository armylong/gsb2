"""拼接流水线编排与“上次有效结果”回退机制。

一次 rebuild 的结果只有在通过全部检查（配对接受、全局布局安全、
画布尺寸安全）后才会替换 last_good；失败时保留上次有效结果并返回原因，
用户因此永远不会被迫导出一张没有可信位置关系的全景。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import blend, features, layout
from .config import Config
from .control import ControlPointStore


@dataclass
class Photo:
    pid: int
    path: str
    image: np.ndarray
    name: str

    @property
    def size(self) -> tuple[int, int]:
        h, w = self.image.shape[:2]
        return w, h


@dataclass
class BuildReport:
    ok: bool
    rolled_back: bool
    reasons: list[str]
    pair_matches: dict = field(default_factory=dict)
    layout: layout.LayoutResult | None = None
    canvas: blend.CanvasResult | None = None
    excluded: list[int] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    used_snapshot: bool = False


class PanoramaEngine:
    def __init__(self, cfg: Config | None = None) -> None:
        self.cfg = cfg or Config()
        self.photos: list[Photo] = []
        self._next_pid = 0
        self.controls = ControlPointStore()
        self._feats: dict[int, tuple] = {}
        self.last_report: BuildReport | None = None
        # 上次有效结果（用于回退）
        self._last_good: dict | None = None

    # ---------- 照片管理 ----------
    def add_photo(self, path: str) -> Photo:
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError(f"无法读取图片：{path}")
        photo = Photo(self._next_pid, str(path), img, Path(path).name)
        self._next_pid += 1
        self.photos.append(photo)
        self._feats[photo.pid] = features.extract_features(img, self.cfg)
        return photo

    def remove_photo(self, pid: int) -> None:
        idx = self._index_of(pid)
        self.photos.pop(idx)
        self._feats.pop(pid, None)
        # 清理涉及该照片的控制点
        for key in self.controls.all_pairs():
            if pid in key:
                self.controls.clear_pair(*key)

    def move_photo(self, pid: int, new_index: int) -> None:
        idx = self._index_of(pid)
        photo = self.photos.pop(idx)
        new_index = max(0, min(new_index, len(self.photos)))
        self.photos.insert(new_index, photo)

    def reorder(self, ordered_pids: list[int]) -> None:
        by_id = {p.pid: p for p in self.photos}
        if set(ordered_pids) != set(by_id):
            raise ValueError("重排序列与当前照片集合不一致")
        self.photos = [by_id[p] for p in ordered_pids]

    def _index_of(self, pid: int) -> int:
        for k, p in enumerate(self.photos):
            if p.pid == pid:
                return k
        raise KeyError(f"照片 {pid} 不存在")

    @property
    def n(self) -> int:
        return len(self.photos)

    # ---------- 控制点转发 ----------
    def add_control_point(self, i: int, j: int, pt_i, pt_j):
        return self.controls.add(i, j, pt_i, pt_j)

    def move_control_point(self, pid: int, side: str, pt):
        self.controls.move(pid, side, pt)

    def remove_control_point(self, pid: int):
        self.controls.remove(pid)

    # ---------- 主流水线 ----------
    def rebuild(self) -> BuildReport:
        warnings: list[str] = []
        n = self.n
        if n < 2:
            report = BuildReport(
                False, False, ["至少需要 2 张照片才能拼接"],
                used_snapshot=self._last_good is not None,
            )
            self.last_report = report
            return self._fail_with_rollback(report)

        pair_matches: dict[tuple[int, int], features.PairMatch] = {}

        # 1) 所有相邻及跨邻配对（小规模输入，全配对可接受；3~6 张 => ≤15 对）
        for ai in range(n):
            for bi in range(ai + 1, n):
                pa, pb = self.photos[ai], self.photos[bi]
                cps = self.controls.get(pa.pid, pb.pid)
                src_cp, dst_cp = self.controls.ordered_arrays(pa.pid, pb.pid)
                m = features.match_pair(
                    pa.pid, pb.pid, pa.image, pb.image,
                    self._feats[pa.pid], self._feats[pb.pid],
                    self.cfg,
                    extra_src=src_cp if len(src_cp) else None,
                    extra_dst=dst_cp if len(dst_cp) else None,
                    manual=bool(cps),
                )
                # 自动匹配失败但给了足够控制点：尝试纯手动求解
                if not m.accepted and len(src_cp) >= self.cfg.min_cp_for_solve:
                    manual = self.controls.solve_manual(
                        pa.pid, pb.pid, pa.image.shape[:2],
                        pb.image.shape[:2], self.cfg,
                    )
                    if manual.ok:
                        m.accepted = True
                        m.H_ji = manual.H_ji
                        m.manual = True
                        m.inlier_pairs = manual.points
                        m.n_inliers = len(manual.points)
                        m.rmse = manual.rmse
                        m.reasons = [
                            "自动匹配不足，已采用手动控制点建立关系"
                        ]
                        m.confidence = max(0.45, m.confidence)
                        warnings.append(
                            f"照片 {pa.name} 与 {pb.name} 依赖手动控制点"
                        )
                    else:
                        m.reasons.append(
                            "手动控制点求解失败：" + "；".join(manual.reasons)
                        )
                pair_matches[(pa.pid, pb.pid)] = m

        accepted = [m for m in pair_matches.values() if m.accepted]
        if not accepted:
            report = BuildReport(
                False, False,
                ["没有任何一对照片建立可信几何关系"] +
                [f"{self._name(k)}: {'; '.join(v.reasons)}"
                 for k, v in pair_matches.items()],
                pair_matches=pair_matches,
                used_snapshot=self._last_good is not None,
            )
            self.last_report = report
            return self._fail_with_rollback(report)

        # 2) 全局布局
        edges = []
        for m in accepted:
            edges.append(
                layout.Edge(
                    a=m.i, b=m.j, H_ab=m.H_ji,
                    correspondences=m.inlier_pairs,
                    confidence=m.confidence,
                    overlap_frac=m.overlap_frac,
                    manual=m.manual,
                )
            )
        sizes = {p.pid: p.size for p in self.photos}
        lay = layout.build_layout(
            n, edges, sizes, self.cfg, ref_index=0
        )
        if not lay.ok:
            report = BuildReport(
                False, False, lay.reasons,
                pair_matches=pair_matches, layout=lay,
                excluded=lay.excluded,
                used_snapshot=self._last_good is not None,
            )
            self.last_report = report
            return self._fail_with_rollback(report)

        for pid in lay.excluded:
            warnings.append(
                f"照片 {self._name(pid)} 与主全景无可信重叠，已排除（不强行贴入）"
            )

        # 3) 渲染画布
        order = [p.pid for p in self.photos if p.pid in lay.globals_H]
        images = {p.pid: p.image for p in self.photos}
        canvas = blend.render_canvas(order, images, lay.globals_H, self.cfg)
        if not canvas.ok:
            report = BuildReport(
                False, False, canvas.reasons,
                pair_matches=pair_matches, layout=lay,
                used_snapshot=self._last_good is not None,
            )
            self.last_report = report
            return self._fail_with_rollback(report)

        if canvas.ghost_frac > self.cfg.ghost_area_frac:
            warnings.append(
                f"重叠区约 {canvas.ghost_frac:.1%} 像素差异显著，"
                "可能存在近景视差重影（超出平面/远景假设，未做运动消除）"
            )
        if lay.has_loop:
            warnings.append(
                f"检测到首尾重叠闭环，已联合优化"
                f"（闭环边 RMSE 改善 {lay.loop_closure_gain:.2f}px，"
                f"相对接龙布局最大角点修正 {lay.max_corner_drift_px:.1f}px）"
            )

        report = BuildReport(
            ok=True, rolled_back=False, reasons=[],
            pair_matches=pair_matches, layout=lay, canvas=canvas,
            excluded=lay.excluded, warnings=warnings,
        )
        self.last_report = report
        self._last_good = {
            "pair_matches": {k: v for k, v in pair_matches.items()},
            "layout": lay,
            "canvas": canvas,
        }
        return report

    def _fail_with_rollback(self, report: BuildReport) -> BuildReport:
        """失败时挂回上次有效结果（若存在），并明确标注。"""
        if self._last_good is not None:
            report.rolled_back = True
            report.layout = self._last_good["layout"]
            report.canvas = self._last_good["canvas"]
            report.pair_matches = report.pair_matches or self._last_good["pair_matches"]
            report.warnings.append(
                "本次修改未通过校验，界面仍显示上次有效结果；"
                "修复或撤销后才会更新"
            )
        return report

    def has_last_good(self) -> bool:
        return self._last_good is not None

    def _name(self, pid) -> str:
        if isinstance(pid, tuple):
            return f"({self._name(pid[0])}, {self._name(pid[1])})"
        for p in self.photos:
            if p.pid == pid:
                return p.name
        return f"#{pid}"
