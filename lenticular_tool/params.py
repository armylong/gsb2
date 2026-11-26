"""参数模型、视图来源描述、内置预设与 JSON 持久化。"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# 来源图层的默认辨色(同时用于来源彩色图层、统计图例、镜片示意)
VIEW_COLORS = [
    (225, 64, 64),    # 视角 1 红
    (48, 116, 224),   # 视角 2 蓝
    (34, 160, 96),    # 视角 3 绿
    (238, 158, 28),   # 视角 4 橙
]


def normalize_order(order: Any, n: int) -> tuple[int, ...]:
    """把视图顺序规整成 0..n-1 的一个排列。

    允许 JSON 里缺项/多写; 缺失的编号按自然顺序补在末尾。
    """
    if order is None:
        return tuple(range(n))
    seen: list[int] = []
    try:
        iterator = [int(x) for x in order]
    except (TypeError, ValueError):
        return tuple(range(n))
    for x in iterator:
        if 0 <= x < n and x not in seen:
            seen.append(x)
    for x in range(n):
        if x not in seen:
            seen.append(x)
    return tuple(seen[:n])


@dataclass
class LensParams:
    """所有几何 / 取样参数。

    坐标约定(重要):
    - 输出像素网格与输入 PNG 完全一致, 原点在画面左上角, x 向右、y 向下。
    - 像素中心坐标是 (i + 0.5, j + 0.5)。
    - ``offset_px`` 是第 0 根镜条分界线在 ``y = pivot`` 基准行上的 x 坐标(输出像素)。
    - 镜条周期 P = dpi / lpi (输出像素), 允许小数。
    - 交错图始终按 *竖直镜条* 生成; ``angle_deg`` 只用于模拟镜片压上去时的
      微小旋转误差(以 ``pivot_frac`` 所在行为不串图的基准侧)。
    """

    lpi: float = 75.0                 # 镜条密度(根/英寸)
    dpi: float = 300.0                # 印刷分辨率(像素/英寸)
    offset_px: float = 0.0            # 起始偏移(输出像素, 可为小数)
    angle_deg: float = 0.0            # 镜片相对交错列的微小倾角
    pivot_frac: float = 0.0           # 角度基准行: 0=顶行, .5=中间, 1=底行
    order: tuple[int, ...] = (0, 1, 2)  # 切片相位从左到右对应的实际视角
    eye_phase: float = 0.18           # 观察位置(一个周期内的相位 0..1)
    eye_width_slices: float = 0.85    # 观察窗口宽度, 以“每个视角的切片宽”为 1
    whole_periods: bool = False       # 微调周期使整宽恰好为整数个周期(首尾同相)
    fit_right_edge: bool = False      # 微调周期使右端相位恰好等于 right_edge_phase
    right_edge_phase: float = 0.0     # 锁定的右端相位(0..1)

    # -- 派生量 ---------------------------------------------------------
    def base_pitch(self) -> float:
        """名义镜条周期(像素), 不考虑右端锁定。"""
        if self.lpi <= 0 or self.dpi <= 0:
            raise ValueError("LPI 和 DPI 必须为正数")
        return float(self.dpi) / float(self.lpi)

    def normalized_order(self, n: int) -> tuple[int, ...]:
        return normalize_order(self.order, n)

    # -- JSON -----------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["order"] = list(self.order)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "LensParams":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        kwargs = {k: v for k, v in dict(d).items() if k in known}
        if "order" in kwargs:
            kwargs["order"] = normalize_order(kwargs["order"], max(2, len(kwargs["order"])))
        return cls(**kwargs)


@dataclass
class ViewSource:
    """一个视角画面的来源描述, 用于保存参数后重复生成。"""

    kind: str = "sample"   # "sample" | "file"
    path: str = ""         # kind == "file": PNG 路径(保存时可写成相对路径)
    sample_index: int = 0  # kind == "sample": 内置样例编号
    label: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ViewSource":
        return cls(
            kind=str(d.get("kind", "sample")),
            path=str(d.get("path", "")),
            sample_index=int(d.get("sample_index", 0)),
            label=str(d.get("label", "")),
        )


@dataclass
class ProjectFile:
    """落盘的完整工程参数(参数 + 视角来源)。"""

    params: LensParams = field(default_factory=LensParams)
    views: list[ViewSource] = field(default_factory=list)
    preview_max_side: int = 1100
    app: str = "lenticular-tool"
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "app": self.app,
            "version": self.version,
            "preview_max_side": int(self.preview_max_side),
            "params": self.params.to_dict(),
            "views": [v.to_dict() for v in self.views],
        }

    def save_json(self, path: str | Path) -> None:
        path = Path(path)
        data = self.to_dict()
        # 尽量把外部 PNG 路径保存为相对工程文件的路径, 整个目录搬走仍可复现
        for v in data["views"]:
            if v.get("kind") == "file" and v.get("path"):
                p = Path(v["path"])
                try:
                    v["path"] = str(p.resolve().relative_to(path.parent.resolve()))
                except (ValueError, OSError):
                    v["path"] = str(p)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def load_json(cls, path: str | Path) -> "ProjectFile":
        path = Path(path)
        raw = json.loads(path.read_text(encoding="utf-8"))
        pf = cls()
        pf.app = str(raw.get("app", "lenticular-tool"))
        pf.version = int(raw.get("version", 1))
        pf.preview_max_side = int(raw.get("preview_max_side", 1100))
        pf.params = LensParams.from_dict(raw.get("params", {}))
        views = [ViewSource.from_dict(d) for d in raw.get("views", [])]
        # 相对路径基于工程文件目录解析
        for v in views:
            if v.kind == "file" and v.path and not Path(v.path).is_absolute():
                cand = (path.parent / v.path).resolve()
                if cand.exists():
                    v.path = str(cand)
        pf.views = views
        return pf


# ---------------------------------------------------------------------------
# 内置教学 / 校验预设
# ---------------------------------------------------------------------------
def preset_integer() -> tuple[str, LensParams]:
    """整数周期: 300 DPI / 100 LPI => P=3 px, 三视图每视图恰好 1 px。

    样例宽 1200 px 可被 3 整除, 图首/图中/图尾应当完全一致。
    """
    return "整数周期 P=3px(首中尾一致)", LensParams(
        lpi=100.0, dpi=300.0, offset_px=0.0, angle_deg=0.0,
        pivot_frac=0.0, order=(0, 1, 2), eye_phase=0.5 / 3,
    )


def preset_half_pixel() -> tuple[str, LensParams]:
    """半像素起始偏差: P=3 px 但分界线偏移 0.5 px(压在像素中心线上)。"""
    return "半像素偏移 offset=0.5px", LensParams(
        lpi=100.0, dpi=300.0, offset_px=0.5, angle_deg=0.0,
        pivot_frac=0.0, order=(0, 1, 2), eye_phase=0.5 / 3,
    )


def preset_fractional() -> tuple[str, LensParams]:
    """非整除周期且小数部分接近 0.5: 280 DPI / 80 LPI => P=3.5 px。

    两视图理想切片宽 1.75 px, 每个镜条只能在 3/4 像素之间交替,
    1200 px 宽度结束时右端相位与图首不同。
    """
    return "非整除周期 P=3.5px(近半像素)", LensParams(
        lpi=80.0, dpi=280.0, offset_px=0.0, angle_deg=0.0,
        pivot_frac=0.0, order=(0, 1), eye_phase=0.25,
    )


def preset_tilt_drift() -> tuple[str, LensParams]:
    """小倾角串图: 顶行对齐, 越往下相位漂移越大并逐渐串图。

    0.20° / H=800 / P=4 时底端约漂移 0.7 个周期, 足够看到
    “顶部正确 -> 中段换图 -> 底部串图”的完整渐变而不反复循环。
    """
    return "0.20° 倾角(顶准底串)", LensParams(
        lpi=75.0, dpi=300.0, offset_px=0.0, angle_deg=0.20,
        pivot_frac=0.0, order=(0, 1, 2), eye_phase=0.5 / 3,
        eye_width_slices=1.0,
    )


PRESETS = {
    "integer": preset_integer,
    "half_pixel": preset_half_pixel,
    "fractional": preset_fractional,
    "tilt": preset_tilt_drift,
}
