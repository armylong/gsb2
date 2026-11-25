"""SIRDS (Single Image Random Dot Stereogram) 核心算法模块。

实现 Thimbleby / Inglis / Witten 的经典算法
("Displaying 3D Images: Algorithms for Single Image Random Dot Stereograms",
 IEEE Computer, 1994), 含隐藏面消除 (遮挡处理)。

深度约定: depth 为 float 数组, 取值 [0, 1], 1 = 最近 (浮出屏幕), 0 = 最远。
视差 (同名点对在输出图上的水平距离):
    separation(z) = round((1 - mu * z) * eye_sep)
即越近的点对视差越小, 平行眼观看时浮得越高。
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

import numpy as np


# ---------------------------------------------------------------- 参数与校验

@dataclass
class RenderParams:
    width: int = 800
    height: int = 600
    eye_sep: int = 144          # 视距 E: 两眼在屏幕上对应的像素间距 (平行眼)
    mu: float = 1.0 / 3.0       # 深度系数: 最近处视差 = E * (1 - mu)
    pattern_width: int = 144    # 纹理平铺宽度 (通常应 == eye_sep)
    seed: int = 42              # 随机种子, 相同设定重生成结果完全一致
    dot_mode: str = "color"     # "color" 随机彩点 | "bw" 随机黑白点 | "texture" 纹理块
    depth_kind: str = "step"    # "plane" | "step" | "step_hole" | "custom"
    z_far: float = 0.15         # 背景深度
    z_near: float = 0.95        # 浮起层深度


def separation(z: np.ndarray | float, eye_sep: float, mu: float) -> np.ndarray:
    """深度 -> 视差(像素)。z=0 时等于 eye_sep, z=1 时等于 eye_sep*(1-mu)。"""
    return np.round((1.0 - mu * np.asarray(z, dtype=float)) * eye_sep).astype(int)


def validate_params(p: RenderParams, has_texture: bool = False) -> list[str]:
    """检查不合理的参数组合, 返回警告字符串列表 (空列表 = 一切正常)。"""
    warns: list[str] = []
    sep_min = (1.0 - p.mu) * p.eye_sep
    sep_max = p.eye_sep

    if p.eye_sep < 16:
        warns.append(f"视距 eye_sep={p.eye_sep}px 太小, 双眼几乎无法分开发出视差。")
    if sep_min < 12:
        warns.append(
            f"最近处视差 {sep_min:.0f}px 过小 (eye_sep*(1-mu)), "
            "近处表面对应点会挤在一起, 建议减小 mu 或增大视距。"
        )
    if p.mu <= 0 or p.mu >= 1:
        warns.append(f"深度系数 mu={p.mu} 必须在 (0, 1) 之间。")
    if p.width < 3 * p.eye_sep:
        warns.append(
            f"图宽 {p.width}px 不足视距的 3 倍 ({3 * p.eye_sep}px), "
            "左右边缘不可融合区域占比过大, 建议加宽图或减小视距。"
        )
    # 纹理宽度只在纹理平铺模式下影响输出; 随机点模式下无关紧要
    if p.dot_mode == "texture":
        if p.pattern_width > sep_max:
            warns.append(
                f"纹理宽度 {p.pattern_width}px 大于视距 {sep_max}px, "
                "平铺周期与视差不匹配, 融合后纹理会错位。"
            )
        if p.pattern_width > sep_min and sep_min < sep_max:
            warns.append(
                f"纹理宽度 {p.pattern_width}px 大于最近处视差 {sep_min:.0f}px, "
                "浮起区域的纹理接缝可能可见, 建议纹理宽度 <= 最近视差。"
            )
        if p.pattern_width < 8:
            warns.append(f"纹理宽度 {p.pattern_width}px 太小, 平铺纹理失去意义。")
    if p.dot_mode == "texture" and not has_texture:
        warns.append("当前选择了纹理块模式但尚未加载纹理, 将退化为随机彩点。")
    if not (0.0 <= p.z_far < p.z_near <= 1.0):
        warns.append(
            f"需要 0 <= 远层深度 < 近层深度 <= 1, 当前 far={p.z_far}, near={p.z_near}。"
        )
    return warns


# ---------------------------------------------------------------- 内置深度图

def make_depth(p: RenderParams) -> np.ndarray:
    """按参数生成内置深度图 (plane / step / step_hole)。"""
    w, h = p.width, p.height
    depth = np.full((h, w), p.z_far, dtype=float)

    if p.depth_kind == "plane":
        return depth

    # 浮起台阶: 中央矩形区域抬升到 z_near
    x0, x1 = int(w * 0.28), int(w * 0.72)
    y0, y1 = int(h * 0.25), int(h * 0.75)
    depth[y0:y1, x0:x1] = p.z_near

    if p.depth_kind == "step_hole":
        # 台阶中央再挖一个回到背景深度的孔
        hx0, hx1 = int(w * 0.44), int(w * 0.56)
        hy0, hy1 = int(h * 0.42), int(h * 0.58)
        depth[hy0:hy1, hx0:hx1] = p.z_far
    return depth


# ---------------------------------------------------------------- 核心渲染

@dataclass
class RowDebug:
    """单行的对应关系调试信息。"""
    y: int
    separation: np.ndarray          # (w,) 每个像素位置的视差
    links: np.ndarray               # (w,) same[x]: x 的右侧同名点 (same[x]==x 表示自由点)
    occluded: list[tuple[int, int]] = field(default_factory=list)  # 被遮挡而拒绝的 (left, right)

    @property
    def pair_distances(self) -> np.ndarray:
        """所有有效同名点对的距离 (links[x] - x, 仅取 links[x] > x)。"""
        mask = self.links > np.arange(len(self.links))
        return self.links[mask] - np.arange(len(self.links))[mask]


def _render_row_links(zrow: np.ndarray, eye_sep: int, mu: float,
                      collect_debug: bool = False):
    """对一行深度计算 same[] 链接 (含隐藏面消除)。

    same[x] = x 表示 x 是自由点; same[x] = r > x 表示 x 与 r 必须同色。
    返回 (same, sep, occluded)。
    """
    w = zrow.shape[0]
    sep = separation(zrow, eye_sep, mu)
    same = np.arange(w)
    occluded: list[tuple[int, int]] = []

    for x in range(w):
        s = int(sep[x])
        if s < 2:
            continue
        left = x - s // 2
        right = left + s
        if left < 0 or right >= w:
            continue

        # --- 隐藏面消除: 检查 x 附近是否有更近的点挡住 left/right 的视线 ---
        z = float(zrow[x])
        visible = True
        t = 1
        # 视线在屏幕上每偏离 1px, 可遮挡的深度阈值线性上升; zt >= 1 后不可能再被挡
        while True:
            zt = z + 2.0 * (2.0 - mu * z) * t / (mu * eye_sep)
            if zt >= 1.0:
                break
            if x - t >= 0 and zrow[x - t] >= zt:
                visible = False
                break
            if x + t < w and zrow[x + t] >= zt:
                visible = False
                break
            t += 1
        if not visible:
            if collect_debug:
                occluded.append((left, right))
            continue

        # --- 合并约束: left 与 right 必须同色 (沿已有链传播, 避免矛盾) ---
        l = int(same[left])
        while l != left and l != right:
            if l < right:
                left = l
                l = int(same[left])
            else:
                same[left] = right
                left = right
                l = int(same[left])
        same[left] = right

    return same, sep, occluded


def analyze_row(depth: np.ndarray, y: int, eye_sep: int, mu: float) -> RowDebug:
    """分析某一行的实际对应关系 (供 GUI 的行检查器使用)。"""
    zrow = np.asarray(depth[y], dtype=float)
    same, sep, occluded = _render_row_links(zrow, eye_sep, mu, collect_debug=True)
    return RowDebug(y=y, separation=sep, links=same, occluded=occluded)


def render_sirds(depth: np.ndarray, p: RenderParams,
                 texture: np.ndarray | None = None,
                 collect_links: bool = False):
    """渲染整幅立体图。

    depth:   (h, w) float, [0,1], 1 = 最近
    texture: (th, tw, 3) uint8 可选纹理块 (dot_mode == "texture" 时使用)
    返回 (image, links):
      image: (h, w, 3) uint8 RGB
      links: (h, w) int32, 每行的 same[] 链接 (collect_links=False 时为 None)
    """
    h, w = depth.shape
    rng = np.random.default_rng(p.seed)
    use_texture = p.dot_mode == "texture" and texture is not None
    if use_texture:
        tex = np.asarray(texture, dtype=np.uint8)
        th, tw = tex.shape[:2]

    out = np.zeros((h, w, 3), dtype=np.uint8)
    links = np.zeros((h, w), dtype=np.int32) if collect_links else None

    for y in range(h):
        same, _, _ = _render_row_links(depth[y], p.eye_sep, p.mu)
        if collect_links:
            links[y] = same

        # 从右向左赋色: 自由点取新颜色, 约束点复制右侧同名点的颜色
        row = np.zeros((w, 3), dtype=np.uint8)
        for x in range(w - 1, -1, -1):
            s = int(same[x])
            if s == x:
                if use_texture:
                    row[x] = tex[y % th, x % tw]
                elif p.dot_mode == "bw":
                    row[x] = 255 if rng.random() < 0.5 else 0
                else:
                    row[x] = rng.integers(0, 256, 3, dtype=np.uint8)
            else:
                row[x] = row[s]
        out[y] = row

    return out, links


# ---------------------------------------------------------------- 纹理

def make_default_texture(p: RenderParams) -> np.ndarray:
    """用固定种子生成一块默认纹理 (便于在没有外部图片时演示 texture 模式)。"""
    rng = np.random.default_rng(p.seed + 1)
    pw = max(8, p.pattern_width)
    tex = rng.integers(0, 256, (pw, pw, 3), dtype=np.uint8)
    # 加一点低频色块, 让纹理不只是噪声
    yy, xx = np.mgrid[0:pw, 0:pw]
    tex[..., 0] = (tex[..., 0].astype(int) + 60 * np.sin(xx / pw * 2 * np.pi)).clip(0, 255)
    tex[..., 1] = (tex[..., 1].astype(int) + 60 * np.cos(yy / pw * 2 * np.pi)).clip(0, 255)
    return tex.astype(np.uint8)


def params_to_dict(p: RenderParams) -> dict:
    return asdict(p)
