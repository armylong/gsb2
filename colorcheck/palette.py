"""调色板模型: 类别、必须区分的配对、候选建议与跨组冲突预警。

候选色在 OKLCH 感知均匀空间里沿色相/彩度/明度三个方向生成,
评分同时考虑:
  1. 本类别参与的必须区分配对, 模拟后的色差与背景亮度反差;
  2. 它与其它任意类别之间是否产生 *新的* 冲突 (跨组预警);
  3. 与原色的偏离量, 优先保留品牌识别度。
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

import numpy as np

from . import cvd
from .colorio import (ciede2000, contrast_ratio,
                      oklch_to_rgb, rgb_to_hex, rgb_to_oklch)

DEFAULT_DE_THRESHOLD = 10.0
DEFAULT_CONTRAST_MIN = 3.0


@dataclass
class Category:
    cid: str
    name: str
    color: tuple            # 当前颜色 RGB(0-255)
    locked: bool = False
    source_color: tuple = None   # 取样原色; None 时取 color

    def __post_init__(self):
        self.color = tuple(int(v) for v in self.color)
        if self.source_color is None:
            self.source_color = self.color
        self.source_color = tuple(int(v) for v in self.source_color)

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        return cls(cid=d["cid"], name=d["name"],
                   color=tuple(d["color"]), locked=bool(d.get("locked", False)),
                   source_color=tuple(d.get("source_color", d["color"])))


@dataclass
class Pair:
    a: str
    b: str

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        return cls(a=d["a"], b=d["b"])


@dataclass
class Palette:
    categories: list = field(default_factory=list)
    pairs: list = field(default_factory=list)
    de_threshold: float = DEFAULT_DE_THRESHOLD
    contrast_min: float = DEFAULT_CONTRAST_MIN
    light_bg: tuple = (245, 245, 245)
    dark_bg: tuple = (32, 32, 32)

    # ---- 基本操作 ----
    def get(self, cid) -> Category:
        for c in self.categories:
            if c.cid == cid:
                return c
        raise KeyError(cid)

    def has(self, cid) -> bool:
        return any(c.cid == cid for c in self.categories)

    def add_category(self, color, name=None, locked=False):
        idx = len(self.categories) + 1
        cid = f"cat{idx}"
        while self.has(cid):
            idx += 1
            cid = f"cat{idx}"
        name = name or f"类别 {idx}"
        cat = Category(cid=cid, name=name, color=tuple(int(v) for v in color),
                       locked=locked)
        self.categories.append(cat)
        return cat

    def set_color(self, cid, rgb):
        self.get(cid).color = tuple(int(v) for v in rgb)

    def toggle_lock(self, cid):
        c = self.get(cid)
        c.locked = not c.locked
        return c.locked

    def add_pair(self, cid_a, cid_b):
        if cid_a == cid_b:
            raise ValueError("配对必须是两个不同类别")
        key = frozenset((cid_a, cid_b))
        if any(frozenset((p.a, p.b)) == key for p in self.pairs):
            return
        self.pairs.append(Pair(a=cid_a, b=cid_b))

    def remove_pair(self, cid_a, cid_b):
        key = frozenset((cid_a, cid_b))
        self.pairs = [p for p in self.pairs
                      if frozenset((p.a, p.b)) != key]

    def pairs_involving(self, cid):
        return [p for p in self.pairs if cid in (p.a, p.b)]

    # ---- 颜色级读数 ----
    def pair_color_metrics(self, pair, kind, severity, bg):
        """名义色块级指标: 不依赖图像, 直接算两类别当前颜色。"""
        ca = np.asarray(self.get(pair.a).color, dtype=float)
        cb = np.asarray(self.get(pair.b).color, dtype=float)
        bg_arr = np.asarray(bg, dtype=float)
        if severity > 0:
            sa = cvd.simulate(ca, kind, severity)
            sb = cvd.simulate(cb, kind, severity)
            sbg = cvd.simulate(bg_arr, kind, severity)
        else:
            sa, sb, sbg = ca, cb, bg_arr
        return {
            "pair": pair,
            "de": float(ciede2000(sa, sb)),
            "contrast_a": float(contrast_ratio(sa, sbg)),
            "contrast_b": float(contrast_ratio(sb, sbg)),
            "sim_a": tuple(int(round(v)) for v in sa),
            "sim_b": tuple(int(round(v)) for v in sb),
            "de_pass": False,  # 由调用方按阈值填, 这里给默认
        }

    def full_metrics(self, kind, severity, bg):
        rows = []
        for p in self.pairs:
            m = self.pair_color_metrics(p, kind, severity, bg)
            m["de_pass"] = m["de"] >= self.de_threshold
            m["contrast_pass"] = (m["contrast_a"] >= self.contrast_min
                                  and m["contrast_b"] >= self.contrast_min)
            rows.append(m)
        return rows

    # ---- 候选建议 ----
    def generate_candidates(self, cid, kind, severity, max_count=12):
        """围绕类别当前色在 OKLCH 空间生成候选, 带评分与跨组预警。"""
        target = self.get(cid)
        base_lch = rgb_to_oklch(np.asarray(target.color, dtype=float))
        L0, C0, h0 = [float(v) for v in base_lch]

        grid = []
        for dh in (-60, -30, -15, 15, 30, 60, 90, 120, 150, 180):
            grid.append((L0, C0, (h0 + dh) % 360))
        for dL in (-0.15, -0.08, 0.08, 0.15):
            grid.append(((np.clip(L0 + dL, 0.05, 0.98), C0, h0)))
        for dC in (-0.06, 0.05, 0.10):
            grid.append((L0, max(C0 + dC, 0.005), h0))
        for dh in (-30, 30):
            for dL in (-0.08, 0.08):
                grid.append((np.clip(L0 + dL, 0.05, 0.98), C0,
                             (h0 + dh) % 360))

        candidates = []
        seen = [np.asarray(target.color, dtype=float)]
        for L, C, h in grid:
            rgb = oklch_to_rgb(L, C, h)
            if any(float(ciede2000(rgb, s)) < 1.5 for s in seen):
                continue
            seen.append(rgb)
            scored = self._score_candidate(cid, rgb, kind, severity)
            candidates.append(scored)

        candidates.sort(key=lambda c: (c["error_count"], -c["min_pair_de"],
                                       -c["min_contrast"], c["distance"]))
        return candidates[:max_count]

    def _all_current_rgb(self):
        return {c.cid: np.asarray(c.color, dtype=float)
                for c in self.categories}

    def _score_candidate(self, cid, rgb, kind, severity):
        """把 cid 临时换成 rgb 后评估全部配对; 不改实际状态。"""
        rgb = np.asarray(rgb, dtype=float)
        colors = self._all_current_rgb()
        original = colors[cid].copy()
        colors[cid] = rgb

        def sim(c):
            return cvd.simulate(c, kind, severity) if severity > 0 else c

        bgs = {"浅底": np.asarray(self.light_bg, dtype=float),
               "深底": np.asarray(self.dark_bg, dtype=float)}

        pair_details = []
        min_pair_de = float("inf")
        min_contrast = float("inf")
        error_count = 0
        conflict_warnings = []

        required = {frozenset((p.a, p.b)) for p in self.pairs}
        for p in self.pairs:
            sa, sb = sim(colors[p.a]), sim(colors[p.b])
            de = float(ciede2000(sa, sb))
            min_pair_de = min(min_pair_de, de)
            worst_cr = min(
                float(contrast_ratio(sa, sim(bgs["浅底"]))),
                float(contrast_ratio(sb, sim(bgs["浅底"]))),
                float(contrast_ratio(sa, sim(bgs["深底"]))),
                float(contrast_ratio(sb, sim(bgs["深底"]))))
            min_contrast = min(min_contrast, worst_cr)
            pair_details.append({"pair": (p.a, p.b), "de": de,
                                 "worst_contrast": worst_cr})
            if de < self.de_threshold:
                error_count += 1
            if worst_cr < self.contrast_min:
                error_count += 1

        # 跨组冲突: 与 *未配对* 的类别在任一模拟下色差过小
        others = [c for c in self.categories if c.cid != cid]
        s_new = sim(rgb)
        for other in others:
            key = frozenset((cid, other.cid))
            de = float(ciede2000(s_new, sim(colors[other.cid])))
            if de < self.de_threshold and key not in required:
                conflict_warnings.append(
                    f"与未配对的「{other.name}」新冲突: ΔE={de:.1f} "
                    f"(< {self.de_threshold:g})")

        # 配对反差劣化预警 (两个底色都查)
        for label, bg in bgs.items():
            sbg = sim(bg)
            cr = float(contrast_ratio(s_new, sbg))
            if cr < self.contrast_min:
                conflict_warnings.append(
                    f"{label}下亮度反差 {cr:.2f} 低于 {self.contrast_min:g}")

        return {
            "cid": cid,
            "rgb": tuple(int(round(v)) for v in rgb),
            "hex": rgb_to_hex(rgb),
            "distance": float(ciede2000(rgb, original)),
            "min_pair_de": min_pair_de if np.isfinite(min_pair_de) else 0.0,
            "min_contrast": min_contrast if np.isfinite(min_contrast) else 0.0,
            "error_count": error_count,
            "warnings": conflict_warnings,
            "pair_details": pair_details,
        }

    def evaluate_proposal(self, changes: dict, kind, severity):
        """批量改动评估: {cid: rgb}, 返回每个改动的预警与整体配对表。"""
        saved = {cid: self.get(cid).color for cid in changes}
        try:
            for cid, rgb in changes.items():
                self.set_color(cid, rgb)
            warnings = []
            for cid, rgb in changes.items():
                scored = self._score_candidate(
                    cid, np.asarray(rgb, dtype=float), kind, severity)
                for w in scored["warnings"]:
                    warnings.append(f"{self.get(cid).name}: {w}")
            metrics = {
                "浅底": self.full_metrics(kind, severity, self.light_bg),
                "深底": self.full_metrics(kind, severity, self.dark_bg),
            }
            return {"warnings": warnings, "metrics": metrics}
        finally:
            for cid, rgb in saved.items():
                self.set_color(cid, rgb)

    # ---- 序列化 ----
    def to_dict(self):
        return {
            "categories": [c.to_dict() for c in self.categories],
            "pairs": [p.to_dict() for p in self.pairs],
            "de_threshold": self.de_threshold,
            "contrast_min": self.contrast_min,
            "light_bg": list(self.light_bg),
            "dark_bg": list(self.dark_bg),
        }

    @classmethod
    def from_dict(cls, d):
        pal = cls(
            categories=[Category.from_dict(x) for x in d.get("categories", [])],
            pairs=[Pair.from_dict(x) for x in d.get("pairs", [])],
            de_threshold=float(d.get("de_threshold", DEFAULT_DE_THRESHOLD)),
            contrast_min=float(d.get("contrast_min", DEFAULT_CONTRAST_MIN)),
            light_bg=tuple(d.get("light_bg", (245, 245, 245))),
            dark_bg=tuple(d.get("dark_bg", (32, 32, 32))),
        )
        return pal

    def editable_sources_targets(self):
        """给 recolor_image 用: 只包含未锁定类别 (锁定色不参与改色)。"""
        src, dst, cids = [], [], []
        for c in self.categories:
            if c.locked:
                continue
            src.append(c.source_color)
            dst.append(c.color)
            cids.append(c.cid)
        return src, dst, cids
