"""核心图像处理:样例生成、全局/局部对比度调整、遮罩混合、噪声统计与项目存取。

所有函数均无 GUI 依赖,可用无界面方式直接复验。
约定:图像一律使用 BGR uint8(与 cv2.imwrite/imdecode 一致)。
"""
from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

PROJECT_VERSION = 1
SEED = 20261121


# ---------------------------------------------------------------------------
# 确定性随机数与样例图
# ---------------------------------------------------------------------------
def make_rng(seed: int = SEED) -> np.random.Generator:
    return np.random.default_rng(seed)


def _noise(rng: np.random.Generator, shape, sigma: float) -> np.ndarray:
    return rng.normal(0.0, sigma, size=shape).round().astype(np.int16)


def make_sample(kind: str = "blocks", seed: int = SEED) -> np.ndarray:
    """生成内置样例。

    blocks : 明/暗两个平坦噪声块 + 中间硬交界 + 右侧低对比纹理条(480x360)
    edge   : 平滑渐变交界 + 两侧平坦噪声,用于检查交界处的连续性(480x360)
    extreme: 极小图(32x24),含明暗块与噪声,用于极端区域尺寸测试
    color  : 彩色图,中间一条彩边,用于观察颜色标记(饱和裁切/彩边)(480x360)
    """
    rng = make_rng(seed + hash(kind) % 10000)
    if kind == "extreme":
        w, h = 32, 24
        base = np.full((h, w), 128, np.int16)
        base[:, : w // 2] = 80
        base += _noise(rng, (h, w), 6.0)
        return _gray_to_bgr(base)
    if kind == "edge":
        w, h = 480, 360
        ramp = np.tile(np.linspace(40, 215, w, dtype=np.float32), (h, 1))
        ramp[:, :140] = 55.0
        ramp[:, 340:] = 200.0
        ramp += rng.normal(0.0, 4.0, size=(h, w))
        return _gray_to_bgr(ramp)
    if kind == "color":
        w, h = 480, 360
        bgr = np.zeros((h, w, 3), np.float32)
        bgr[:, : w // 2] = (60, 90, 170)     # 左侧暖色(BGR)
        bgr[:, w // 2 :] = (170, 120, 70)    # 右侧冷色
        bgr += rng.normal(0.0, 3.0, size=(h, w, 3))
        return _clip_bgr(bgr)
    # 默认 blocks
    w, h = 480, 360
    base = np.full((h, w), 205, np.int16)       # 右侧亮平坦区
    base[:, : w // 2] = 50                      # 左侧暗平坦区(硬交界)
    base += _noise(rng, (h, w), 5.0)
    base = np.clip(base, 0, 255)
    img = _gray_to_bgr(base)
    # 右侧低对比纹理条:弱正弦纹理 + 噪声,用来检验纹理是否被保住(三通道保持相等)
    xs = np.arange(w, dtype=np.float32)
    stripe = 6.0 * np.sin(xs / 9.0)
    x0, x1 = w // 2 + 40, w // 2 + 130
    tex = img[:, x0:x1].astype(np.float32)
    add = (stripe[x0:x1][None, :] + rng.normal(0.0, 2.5, size=(h, x1 - x0)))[:, :, None]
    img[:, x0:x1] = _clip_bgr(tex + add)
    return img


def _gray_to_bgr(gray: np.ndarray) -> np.ndarray:
    g = np.clip(gray, 0, 255).astype(np.uint8)
    if g.ndim == 2:
        return cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
    return g


def _clip_bgr(arr: np.ndarray) -> np.ndarray:
    return np.clip(arr, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# 颜色空间:只在亮度 L 上调整,色度通道原样保留
# ---------------------------------------------------------------------------
def to_lab(bgr: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)


def from_lab(lab: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
@dataclass
class Segment:
    """一段遮罩及其独立的限制参数。"""
    name: str = "段1"
    color_rgb: tuple = (255, 170, 0)
    points: list = field(default_factory=list)   # 图像坐标系多边形点 [(x,y), ...]
    clip_limit: float = 3.0                       # CLAHE 对比上限
    tile_size: int = 32                           # 区域(瓦片)边长,像素
    strength: float = 1.0                         # 0=不处理 1=完整 CLAHE

    def __post_init__(self):
        # JSON 往返会把 tuple 变成 list,统一归一化保证 round-trip 可比较
        self.color_rgb = tuple(self.color_rgb)

    def grid(self, shape) -> tuple:
        h, w = shape[:2]
        ts = max(2, int(self.tile_size))
        return (max(1, int(round(w / ts))), max(1, int(round(h / ts))))


@dataclass
class Params:
    mode: str = "local_full"        # global | local_full | local_mask
    clip_limit: float = 3.0
    tile_size: int = 32
    strength: float = 1.0
    feather: int = 12               # 遮罩边缘羽化宽度(像素)
    segments: list = field(default_factory=lambda: [Segment(name="段1"), Segment(name="段2")])

    def to_dict(self) -> dict:
        d = asdict(self)
        d["segments"] = [asdict(s) for s in self.segments]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Params":
        segs = [Segment(**s) for s in d.get("segments", [])]
        if not segs:
            segs = [Segment(name="段1"), Segment(name="段2")]
        return cls(
            mode=d.get("mode", "local_full"),
            clip_limit=float(d.get("clip_limit", 3.0)),
            tile_size=int(d.get("tile_size", 32)),
            strength=float(d.get("strength", 1.0)),
            feather=int(d.get("feather", 12)),
            segments=segs,
        )


def _grid_from_tile(shape, tile_size: int) -> tuple:
    h, w = shape[:2]
    ts = max(2, int(tile_size))
    return (max(1, int(round(w / ts))), max(1, int(round(h / ts))))


# ---------------------------------------------------------------------------
# 调整算子
# ---------------------------------------------------------------------------
def apply_global(lab: np.ndarray) -> np.ndarray:
    """全局直方图均衡(只作用于 L)。"""
    out = lab.copy()
    out[:, :, 0] = cv2.equalizeHist(lab[:, :, 0].astype(np.uint8)).astype(np.float32)
    return out


def apply_clahe(lab: np.ndarray, clip_limit: float, tile_size: int,
                strength: float = 1.0) -> np.ndarray:
    """CLAHE 局部对比调整(只作用于 L),strength 在原图与完整结果间线性混合。"""
    clip = float(np.clip(clip_limit, 0.0, 40.0))
    grid = _grid_from_tile(lab.shape, tile_size)
    clahe = cv2.createCLAHE(clipLimit=clip, tileGridSize=grid)
    l0 = lab[:, :, 0].astype(np.uint8)
    l1 = clahe.apply(l0).astype(np.float32)
    out = lab.copy()
    s = float(np.clip(strength, 0.0, 1.0))
    out[:, :, 0] = lab[:, :, 0] * (1.0 - s) + l1 * s
    return out


# ---------------------------------------------------------------------------
# 遮罩与羽化
# ---------------------------------------------------------------------------
def polygon_mask(shape, points: list) -> np.ndarray:
    mask = np.zeros(shape[:2], np.uint8)
    if len(points) >= 3:
        cv2.fillPoly(mask, [np.array(points, np.int32)], 255)
    return mask


def feather_weight(mask: np.ndarray, feather: int) -> np.ndarray:
    """距离变换生成 0..1 软权重:遮罩内部为 1,边缘 smoothstep 过渡到 0。

    smoothstep (3t^2-2t^3) 在 t=0/1 处导数为 0,保证两段羽化交叉混合后,
    输出在过渡带边界处一阶导数连续(交界处渐变连续),而不是线性权重的折点。
    """
    if mask.max() == 0:
        return np.zeros(mask.shape, np.float32)
    f = max(1, int(feather))
    t = np.clip(cv2.distanceTransform(mask, cv2.DIST_L2, 5) / float(f), 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def _seg_result(bgr: np.ndarray, seg: Segment) -> np.ndarray:
    if seg.strength <= 0.0:
        return bgr.copy()
    lab = to_lab(bgr)
    lab2 = apply_clahe(lab, seg.clip_limit, seg.tile_size, seg.strength)
    return from_lab(lab2)


def process_mask(bgr: np.ndarray, params: Params) -> np.ndarray:
    """两段相接遮罩模式。

    每段独立 CLAHE,羽化带内按距离权重交叉混合;交界处因两侧权重都接近 1
    (或按比例交叉)而连续;遮罩外像素与输入逐像素相等。
    """
    h, w = bgr.shape[:2]
    acc = np.zeros_like(bgr, dtype=np.float32)
    wsum = np.zeros((h, w), np.float32)
    for seg in params.segments:
        m = polygon_mask(bgr.shape, seg.points)
        if m.max() == 0:
            continue
        wt = feather_weight(m, params.feather)
        acc += _seg_result(bgr, seg).astype(np.float32) * wt[:, :, None]
        wsum += wt
    out = bgr.astype(np.float32).copy()
    active = wsum > 1e-6
    blended = acc[active] / wsum[active][:, None]
    out[active] = blended
    return np.clip(out, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# 统一处理入口
# ---------------------------------------------------------------------------
@dataclass
class ProcessResult:
    image: np.ndarray                 # 处理后 BGR
    markers: np.ndarray               # 叠加了饱和裁切/彩边标记的 BGR
    clip_mask: np.ndarray             # 饱和裁切 bool
    fringe_mask: np.ndarray           # 彩边 bool
    mode: str


def _mark_masks(before: np.ndarray, after: np.ndarray) -> tuple:
    """只标记,不改明暗。

    clip  : 处理后出现 0/255 通道裁切,而处理前未裁切的像素(新增饱和)
    fringe: 色度(AB 平面)在局部邻域内沿某方向突变形成的彩边:
            色度梯度幅值显著(>阈值)且其方向与亮度梯度方向不一致的位置。
    """
    b0 = before.astype(np.int16)
    b1 = after.astype(np.int16)
    sat0 = ((b0 <= 1) | (b0 >= 254)).any(axis=2)
    sat1 = ((b1 <= 1) | (b1 >= 254)).any(axis=2)
    clip_mask = sat1 & ~sat0

    lab0 = cv2.cvtColor(before, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab1 = cv2.cvtColor(after, cv2.COLOR_BGR2LAB).astype(np.float32)
    a = lab1[:, :, 1]
    bch = lab1[:, :, 2]
    gax = cv2.Sobel(a, cv2.CV_32F, 1, 0, ksize=3)
    gay = cv2.Sobel(a, cv2.CV_32F, 0, 1, ksize=3)
    gbx = cv2.Sobel(bch, cv2.CV_32F, 1, 0, ksize=3)
    gby = cv2.Sobel(bch, cv2.CV_32F, 0, 1, ksize=3)
    chroma_mag = cv2.magnitude(gax + gbx, gay + gby)
    lx = cv2.Sobel(lab0[:, :, 0], cv2.CV_32F, 1, 0, ksize=3)
    ly = cv2.Sobel(lab0[:, :, 0], cv2.CV_32F, 0, 1, ksize=3)
    luma_mag = cv2.magnitude(lx, ly)
    # 彩边:色度梯度强而亮度梯度弱(纯亮度调整在平坦处不应产生这种结构)
    fringe_mask = (chroma_mag > 18.0) & (luma_mag < 12.0)
    # 灰度图(BGR 三通道相等)天然无彩边
    is_gray = (np.array_equal(before[:, :, 0], before[:, :, 1])
               and np.array_equal(before[:, :, 1], before[:, :, 2]))
    if is_gray:
        fringe_mask[:] = False
    return clip_mask, fringe_mask


def overlay_markers(image: np.ndarray, clip_mask: np.ndarray,
                    fringe_mask: np.ndarray, alpha: float = 0.55) -> np.ndarray:
    out = image.copy()
    # 红色=饱和裁切,蓝色=彩边
    red = np.zeros_like(out); red[:, :, 2] = 255
    blue = np.zeros_like(out); blue[:, :, 0] = 255
    out[fringe_mask] = cv2.addWeighted(out, 1 - alpha, blue, alpha, 0)[fringe_mask]
    out[clip_mask] = cv2.addWeighted(out, 1 - alpha, red, alpha, 0)[clip_mask]
    return out


def process(bgr: np.ndarray, params: Params) -> ProcessResult:
    if params.mode == "global":
        out = from_lab(apply_global(to_lab(bgr)))
    elif params.mode == "local_mask":
        out = process_mask(bgr, params)
    else:  # local_full:整张图 CLAHE
        if params.strength <= 0.0:
            out = bgr.copy()
        else:
            out = from_lab(apply_clahe(to_lab(bgr), params.clip_limit,
                                       params.tile_size, params.strength))
    clip_m, fringe_m = _mark_masks(bgr, out)
    marked = overlay_markers(out, clip_m, fringe_m)
    return ProcessResult(out, marked, clip_m, fringe_m, params.mode)


# ---------------------------------------------------------------------------
# 块统计与直方图
# ---------------------------------------------------------------------------
@dataclass
class BlockStats:
    x: int
    y: int
    w: int
    h: int
    l_mean_before: float
    l_std_before: float       # 平坦处 std≈噪声水平,放大后上升即噪声被放大
    l_mean_after: float
    l_std_after: float

    @property
    def noise_gain(self) -> float:
        return self.l_std_after / self.l_std_before if self.l_std_before > 1e-6 else float("nan")

    @property
    def contrast_change(self) -> float:
        """实测对比变化百分比(以 L 通道标准差计)。"""
        if self.l_std_before < 1e-6:
            return float("nan")
        return (self.l_std_after - self.l_std_before) / self.l_std_before * 100.0


def block_stats(before: np.ndarray, after: np.ndarray, rect: tuple) -> BlockStats:
    x, y, w, h = rect
    x, y = max(0, x), max(0, y)
    w = max(0, min(w, before.shape[1] - x))
    h = max(0, min(h, before.shape[0] - y))
    if w <= 0 or h <= 0:
        return BlockStats(x, y, max(0, w), max(0, h), 0.0, 0.0, 0.0, 0.0)
    l0 = cv2.cvtColor(before, cv2.COLOR_BGR2LAB)[:, :, 0][y:y + h, x:x + w].astype(np.float32)
    l1 = cv2.cvtColor(after, cv2.COLOR_BGR2LAB)[:, :, 0][y:y + h, x:x + w].astype(np.float32)
    return BlockStats(x, y, w, h, float(l0.mean()), float(l0.std()),
                      float(l1.mean()), float(l1.std()))


def luma_histogram(bgr: np.ndarray, rect: tuple | None = None) -> np.ndarray:
    l = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)[:, :, 0]
    if rect is not None:
        x, y, w, h = rect
        l = l[max(0, y):y + h, max(0, x):x + w]
    hist = cv2.calcHist([l], [0], None, [32], [0, 256]).flatten()
    total = hist.sum()
    return hist / total if total > 0 else hist


# ---------------------------------------------------------------------------
# 图像指纹、确定性编码与项目存取
# ---------------------------------------------------------------------------
def image_id(bgr: np.ndarray) -> str:
    return hashlib.sha256(bgr.tobytes()).hexdigest()[:16]


def encode_png(bgr: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", bgr, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError("PNG 编码失败")
    return buf.tobytes()


def decode_png(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("PNG 解码失败")
    return img


def save_project(path: str | Path, bgr: np.ndarray, params: Params,
                 reference_rect: tuple | None) -> str:
    """保存项目(zip):源图 + 参数 JSON。返回项目内记录的输入指纹。"""
    payload = {
        "version": PROJECT_VERSION,
        "input_id": image_id(bgr),
        "reference_rect": list(reference_rect) if reference_rect else None,
        "params": params.to_dict(),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("input.png", encode_png(bgr))
        zf.writestr("project.json", json.dumps(payload, ensure_ascii=False, indent=2))
    return payload["input_id"]


def load_project(path: str | Path) -> tuple:
    """读取项目,返回 (bgr, Params, reference_rect|None, input_id)。"""
    with zipfile.ZipFile(path, "r") as zf:
        payload = json.loads(zf.read("project.json"))
        bgr = decode_png(zf.read("input.png"))
    params = Params.from_dict(payload["params"])
    rect = tuple(payload["reference_rect"]) if payload.get("reference_rect") else None
    return bgr, params, rect, payload["input_id"]
