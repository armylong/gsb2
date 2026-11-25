"""Core image-analysis and bridge-planning logic for the stencil checker.

The module is deliberately independent of Qt widgets so the important rules can
be tested headlessly:

* paper is a boolean mask -- ``True`` means the retained side of the binary art;
* 4-connectivity is used because a diagonal-only contact is not reliable paper;
* every component touching the image border belongs to the fixed frame;
* bridges are rasterized to real image pixels, never to zoom-dependent screen
  widths;
* a protected pixel that would change value makes an automatic proposal invalid.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

try:  # scikit-image is only needed for skeleton based neck detection.
    from skimage.morphology import skeletonize
except Exception:  # pragma: no cover - dependency is declared in requirements.
    skeletonize = None


FOUR_NEIGHBOURS = ndi.generate_binary_structure(2, 1)
EIGHT_NEIGHBOURS = np.ones((3, 3), dtype=int)

DIRECTIONS: dict[str, tuple[int, int]] = {
    "右": (1, 0),
    "右下": (1, 1),
    "下": (0, 1),
    "左下": (-1, 1),
    "左": (-1, 0),
    "左上": (-1, -1),
    "上": (0, -1),
    "右上": (1, -1),
}


@dataclass(frozen=True)
class ComponentInfo:
    label: int
    area: int
    x: int
    y: int
    width: int
    height: int
    centroid_x: float
    centroid_y: float
    frame_connected: bool

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return self.x, self.y, self.width, self.height


@dataclass(frozen=True)
class ThinPoint:
    x: int
    y: int
    width_px: float
    label: int


@dataclass
class Analysis:
    paper: np.ndarray
    labels: np.ndarray
    component_count: int
    frame_labels: set[int]
    components: dict[int, ComponentInfo]
    floating_labels: list[int]
    thin_points: list[ThinPoint]
    thin_mask: np.ndarray

    @property
    def floating_count(self) -> int:
        return len(self.floating_labels)

    def label_at(self, x: int, y: int) -> int:
        h, w = self.labels.shape
        if 0 <= x < w and 0 <= y < h:
            return int(self.labels[y, x])
        return 0

    def is_floating(self, label: int) -> bool:
        return label != 0 and label not in self.frame_labels


@dataclass
class Bridge:
    """An applied bridge. Coordinates are pixel coordinates in image space."""

    x0: int
    y0: int
    x1: int
    y1: int
    width: int
    changed_coords: np.ndarray = field(repr=False)
    kind: str = "manual"
    description: str = ""
    id: int | None = None

    def mask(self, shape: tuple[int, int]) -> np.ndarray:
        return raster_bridge(shape, self.x0, self.y0, self.x1, self.y1, self.width)


@dataclass
class Proposal:
    source_label: int
    x0: int
    y0: int
    x1: int
    y1: int
    width: int
    direction: str
    target_labels: tuple[int, ...]
    reaches_frame: bool
    length: float
    protected_hits: int = 0
    feasible: bool = True
    reason: str = ""
    id: int | None = None

    def mask(self, shape: tuple[int, int]) -> np.ndarray:
        return raster_bridge(shape, self.x0, self.y0, self.x1, self.y1, self.width)

    def summary(self) -> str:
        if self.reaches_frame:
            target = "接回外框"
        elif self.target_labels:
            target = "合并纸块 " + ",".join(f"#{v}" for v in self.target_labels)
        else:
            target = "未连接目标"
        state = "可用" if self.feasible else f"放不下：{self.reason}"
        return f"{self.direction} · {target} · 宽{self.width}px · {state}"


# ---------------------------------------------------------------------------
# Loading / exporting
# ---------------------------------------------------------------------------


def load_binary(path: str | Path, keep_color: str = "black") -> np.ndarray:
    """Load an image and return the retained paper mask."""
    with Image.open(path) as im:
        gray = np.asarray(im.convert("L"), dtype=np.uint8)
    return paper_from_gray(gray, keep_color)


def paper_from_gray(gray: np.ndarray, keep_color: str = "black") -> np.ndarray:
    black_paper = gray < 128
    if keep_color in ("black", "黑", "黑色"):
        return black_paper
    if keep_color in ("white", "白", "白色"):
        return ~black_paper
    raise ValueError("keep_color must be 'black' or 'white'")


def export_binary(path: str | Path, paper: np.ndarray, keep_color: str = "black") -> None:
    """Export a strict 1-bit-looking 0/255 PNG/BMP according to retained side."""
    paper = np.asarray(paper, dtype=bool)
    if keep_color in ("black", "黑", "黑色"):
        values = np.where(paper, 0, 255).astype(np.uint8)
    elif keep_color in ("white", "白", "白色"):
        values = np.where(paper, 255, 0).astype(np.uint8)
    else:
        raise ValueError("keep_color must be 'black' or 'white'")
    Image.fromarray(values, mode="L").save(path)


def verify_export(
    path: str | Path, keep_color: str = "black", thin_width: int = 3
) -> Analysis:
    """Reload an exported binary and independently recompute its state."""
    paper = load_binary(path, keep_color)
    return analyze_paper(paper, thin_width=thin_width)


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


def analyze_paper(paper: np.ndarray, thin_width: int = 3) -> Analysis:
    paper = np.asarray(paper, dtype=bool)
    if paper.ndim != 2:
        raise ValueError("paper must be a 2-D mask")

    labels, count = ndi.label(paper, structure=FOUR_NEIGHBOURS)

    border = np.zeros_like(paper)
    border[0, :] = True
    border[-1, :] = True
    border[:, 0] = True
    border[:, -1] = True
    frame_labels = {int(v) for v in np.unique(labels[border]) if v != 0}

    components: dict[int, ComponentInfo] = {}
    slices = ndi.find_objects(labels)
    areas = np.bincount(labels.ravel())
    centroids = ndi.center_of_mass(paper, labels, index=range(1, count + 1))
    for label in range(1, count + 1):
        sl = slices[label - 1]
        if sl is None:
            continue
        ys, xs = sl
        cy, cx = centroids[label - 1]
        components[label] = ComponentInfo(
            label=label,
            area=int(areas[label]),
            x=int(xs.start),
            y=int(ys.start),
            width=int(xs.stop - xs.start),
            height=int(ys.stop - ys.start),
            centroid_x=float(cx),
            centroid_y=float(cy),
            frame_connected=label in frame_labels,
        )

    floating = sorted(
        label
        for label in components
        if label not in frame_labels
    )

    thin_mask, thin_points = find_thin_connections(
        paper, labels, frame_labels, thin_width=thin_width
    )

    return Analysis(
        paper=paper,
        labels=labels,
        component_count=count,
        frame_labels=frame_labels,
        components=components,
        floating_labels=floating,
        thin_points=thin_points,
        thin_mask=thin_mask,
    )


def find_thin_connections(
    paper: np.ndarray,
    labels: np.ndarray,
    frame_labels: set[int],
    thin_width: int = 3,
) -> tuple[np.ndarray, list[ThinPoint]]:
    """Find narrow skeleton segments joining two thicker paper cores.

    The returned mask contains the narrow skeleton clusters.  A reported point
    is the narrowest raster point in each cluster.  Pure thin branches with only
    one thick anchor are not "connecting points" and are intentionally omitted.
    """
    h, w = paper.shape
    thin_mask_out = np.zeros_like(paper)
    points: list[ThinPoint] = []

    if skeletonize is None or not paper.any():
        return thin_mask_out, points

    distance = ndi.distance_transform_edt(paper)
    skeleton = skeletonize(paper)
    # Conservative raster-width estimate.  A one-pixel line maps to 1, a
    # two-pixel run is still treated as at most 2, and three-pixel runs map to 3.
    width_estimate = np.maximum(1.0, 2.0 * distance - 1.0)
    narrow = skeleton & (width_estimate < max(2, int(thin_width)) + 0.01)

    if not narrow.any():
        return thin_mask_out, points

    # Thick cores: a three-pixel bar has EDT maxima around 2; requiring
    # distance >= thin_width / 2 keeps a 1-2 px neck out of the core mask.
    core_radius = max(1.5, thin_width / 2.0)
    cores = paper & (distance >= core_radius)
    core_labels, core_count = ndi.label(cores, structure=FOUR_NEIGHBOURS)

    cluster_labels, cluster_count = ndi.label(narrow, structure=EIGHT_NEIGHBOURS)
    for cluster_id in range(1, cluster_count + 1):
        cluster = cluster_labels == cluster_id
        ys, xs = np.nonzero(cluster)
        if len(xs) == 0:
            continue

        # Look just outside the narrow cluster for the thick parts it joins.
        anchor_region = ndi.binary_dilation(cluster, iterations=2) & ~cluster
        nearby_cores = {
            int(v) for v in np.unique(core_labels[anchor_region]) if v != 0
        }

        paper_label = int(labels[ys[0], xs[0]])
        touches_frame_edge = paper_label in frame_labels and bool(
            anchor_region[0, :].any()
            or anchor_region[-1, :].any()
            or anchor_region[:, 0].any()
            or anchor_region[:, -1].any()
        )

        # A real neck normally has two thick anchors.  Accept one thick anchor
        # plus the image frame for a narrow tab growing directly from the edge.
        if len(nearby_cores) < 2 and not (len(nearby_cores) >= 1 and touches_frame_edge):
            continue

        local_dist = distance[cluster]
        narrowest = np.flatnonzero(local_dist == local_dist.min())
        pick = narrowest[len(narrowest) // 2]
        px, py = int(xs[pick]), int(ys[pick])
        width_px = float(_cross_section_width(paper, px, py))

        thin_mask_out |= cluster
        points.append(
            ThinPoint(x=px, y=py, width_px=width_px, label=paper_label)
        )

    # Sort in reading order for stable UI/test output.
    points.sort(key=lambda p: (p.y, p.x))
    return thin_mask_out, points


def _cross_section_width(paper: np.ndarray, x: int, y: int) -> int:
    """Measure the shortest contiguous paper run through a raster point."""
    h, w = paper.shape
    axes = ((1, 0), (0, 1), (1, 1), (1, -1))
    widths: list[int] = []
    for dx, dy in axes:
        count = 1
        nx, ny = x + dx, y + dy
        while 0 <= nx < w and 0 <= ny < h and paper[ny, nx]:
            count += 1
            nx += dx
            ny += dy
        nx, ny = x - dx, y - dy
        while 0 <= nx < w and 0 <= ny < h and paper[ny, nx]:
            count += 1
            nx -= dx
            ny -= dy
        widths.append(count)
    return min(widths)


# ---------------------------------------------------------------------------
# Bridge rasterization and proposals
# ---------------------------------------------------------------------------


def raster_bridge(
    shape: tuple[int, int],
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    width: int,
) -> np.ndarray:
    """Rasterize a thick pixel-space line.

    PIL gives exact integer cross-section counts for horizontal/vertical
    bridges (width 1 -> one row, width 2 -> two rows, ...).  Because the result
    is an image-sized bool mask, zooming a view cannot change these pixels.
    """
    h, w = shape
    width = max(1, int(width))
    mask_img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask_img)
    draw.line(
        [(round(float(x0)), round(float(y0))), (round(float(x1)), round(float(y1)))],
        fill=1,
        width=width,
    )
    return np.asarray(mask_img, dtype=np.uint8).astype(bool)


def generate_proposals(
    paper: np.ndarray,
    labels: np.ndarray,
    frame_labels: set[int],
    source_label: int,
    width: int,
    protected: np.ndarray | None = None,
    direction: str = "自动",
    max_ray_steps: int | None = None,
) -> list[Proposal]:
    """Generate straight bridge plans from one component.

    The search projects source pixels onto the normal of each requested
    direction, tries the forward-most source pixel in every normal bin, and
    marches along the ray until another paper label or the image border.
    """
    h, w = paper.shape
    if source_label == 0 or source_label not in set(np.unique(labels)):
        return []

    source = labels == source_label
    if not source.any():
        return []
    if protected is None:
        protected = np.zeros_like(paper, dtype=bool)
    protected = protected.astype(bool, copy=False)

    wanted = list(DIRECTIONS) if direction in ("自动", "auto", "Auto", None) else [direction]
    if direction not in ("自动", "auto", "Auto", None) and direction not in DIRECTIONS:
        # Allow angle-like callers to pass a Chinese/compass key only.
        wanted = list(DIRECTIONS)

    diagonal = float(np.hypot(w, h))
    max_steps = max_ray_steps or int(diagonal) + max(width, 4)

    proposals: list[Proposal] = []
    proposal_seq = 0

    for dir_name in wanted:
        dx0, dy0 = DIRECTIONS[dir_name]
        length = float(np.hypot(dx0, dy0))
        dx, dy = dx0 / length, dy0 / length
        nx, ny = -dy, dx

        ys, xs = np.nonzero(source)
        xsf = xs.astype(float)
        ysf = ys.astype(float)
        u = xsf * dx + ysf * dy
        normal_bin = np.rint(xsf * nx + ysf * ny).astype(int)

        # For each parallel line, use the source point furthest forward.
        anchors: dict[int, tuple[float, int, int]] = {}
        for i, b in enumerate(normal_bin):
            x = int(xs[i])
            y = int(ys[i])
            forward = float(u[i])
            old = anchors.get(int(b))
            if old is None or forward > old[0]:
                anchors[int(b)] = (forward, x, y)

        # A wide bridge can be centred between bins; sampling every source bin is
        # intentionally conservative and is fast enough for template images.
        best: dict[tuple, Proposal] = {}
        for _, sx, sy in anchors.values():
            hit_x, hit_y, hit_label, reached_edge = _march_ray(
                labels, source_label, sx, sy, dx, dy, max_steps
            )
            if hit_x is None:
                continue

            p0x, p0y = sx, sy
            p1x, p1y = hit_x, hit_y
            bridge_mask = raster_bridge(paper.shape, p0x, p0y, p1x, p1y, width)
            touched = np.unique(labels[bridge_mask])
            target_labels = tuple(
                sorted(int(v) for v in touched if v != 0 and int(v) != source_label)
            )
            reaches_frame = any(v in frame_labels for v in target_labels)

            if not target_labels and not reached_edge:
                continue
            if reached_edge and not reaches_frame:
                # Extend the rasterized end to the actual border row/column so
                # the exported bridge itself touches the frame edge.
                ex, ey = _edge_endpoint(w, h, sx, sy, dx, dy)
                p1x, p1y = ex, ey
                bridge_mask = raster_bridge(paper.shape, p0x, p0y, p1x, p1y, width)

            changed = bridge_mask & ~paper
            protected_hits = int(np.count_nonzero(changed & protected))
            feasible = protected_hits == 0
            reason = "会破坏已保护细节" if protected_hits else ""

            # If the raster only touches the source after endpoint adjustment,
            # do not present it as a connection.
            touched2 = np.unique(labels[bridge_mask])
            has_target = any(
                int(v) != 0 and int(v) != source_label for v in touched2
            ) or reached_edge
            if not has_target:
                continue

            length_px = float(np.hypot(p1x - p0x, p1y - p0y))
            signature = (
                dir_name,
                target_labels,
                reaches_frame or reached_edge,
            )
            candidate = Proposal(
                source_label=source_label,
                x0=int(p0x),
                y0=int(p0y),
                x1=int(p1x),
                y1=int(p1y),
                width=int(width),
                direction=dir_name,
                target_labels=target_labels,
                reaches_frame=bool(reaches_frame or reached_edge),
                length=length_px,
                protected_hits=protected_hits,
                feasible=feasible,
                reason=reason,
                id=proposal_seq,
            )
            proposal_seq += 1

            old = best.get(signature)
            if old is None or _candidate_rank(candidate) < _candidate_rank(old):
                best[signature] = candidate

        proposals.extend(best.values())

    # Feasible, frame-reaching and short plans first; invalid plans remain in
    # the list so a tight sample can honestly explain why the width does not fit.
    proposals.sort(
        key=lambda p: (
            not p.feasible,
            not p.reaches_frame,
            p.length,
            p.direction,
            p.target_labels,
        )
    )
    for i, p in enumerate(proposals):
        p.id = i
    return proposals


def _candidate_rank(p: Proposal) -> tuple:
    return (not p.feasible, p.protected_hits, p.length)


def _march_ray(
    labels: np.ndarray,
    source_label: int,
    sx: int,
    sy: int,
    dx: float,
    dy: float,
    max_steps: int,
) -> tuple[int | None, int | None, int, bool]:
    h, w = labels.shape
    last_x, last_y = sx, sy
    # Half-pixel increments avoid skipping a one-pixel diagonal target.
    for k in range(2, max_steps * 2 + 1):
        t = k / 2.0
        x = int(round(sx + dx * t))
        y = int(round(sy + dy * t))
        if x < 0 or y < 0 or x >= w or y >= h:
            return last_x, last_y, 0, True
        last_x, last_y = x, y
        label = int(labels[y, x])
        if label != 0 and label != source_label:
            return x, y, label, False
    return None, None, 0, False


def _edge_endpoint(w: int, h: int, sx: int, sy: int, dx: float, dy: float) -> tuple[int, int]:
    tx = float("inf")
    ty = float("inf")
    if dx > 0:
        tx = (w - 1 - sx) / dx
    elif dx < 0:
        tx = (-sx) / dx
    if dy > 0:
        ty = (h - 1 - sy) / dy
    elif dy < 0:
        ty = (-sy) / dy
    t = min(tx, ty)
    return int(round(sx + dx * t)), int(round(sy + dy * t))


def apply_proposal(
    paper: np.ndarray,
    proposal: Proposal,
    protected: np.ndarray | None = None,
) -> tuple[np.ndarray, Bridge]:
    """Return a new paper mask with a valid proposal rasterized."""
    if not proposal.feasible:
        raise ValueError(proposal.reason or "当前方案不可行")
    mask = proposal.mask(paper.shape)
    return apply_bridge_mask(
        paper,
        mask,
        protected=protected,
        kind="proposal",
        description=proposal.summary(),
        geometry=(proposal.x0, proposal.y0, proposal.x1, proposal.y1, proposal.width),
    )


def apply_manual_stroke(
    paper: np.ndarray,
    points: Sequence[tuple[int, int]],
    width: int,
    protected: np.ndarray | None = None,
) -> tuple[np.ndarray, Bridge | None, int]:
    """Rasterize a freehand/drag manual bridge.

    Protected pixels are never changed.  The third return value is the number
    of protected pixels that stopped part of the stroke.  The caller reanalyzes
    the result, so a clipped stroke is reported truthfully instead of being
    assumed to work.
    """
    if len(points) < 2:
        return paper, None, 0

    mask_img = Image.new("L", (paper.shape[1], paper.shape[0]), 0)
    draw = ImageDraw.Draw(mask_img)
    if len(points) == 2:
        draw.line([tuple(points[0]), tuple(points[1])], fill=1, width=width)
    else:
        draw.line([tuple(p) for p in points], fill=1, width=width, joint="curve")
    bridge_mask = np.asarray(mask_img, dtype=np.uint8).astype(bool)

    changed = bridge_mask & ~paper
    blocked = 0
    if protected is not None:
        protected = protected.astype(bool, copy=False)
        blocked = int(np.count_nonzero(changed & protected))
        # Never modify protected cells, even for a manual stroke.
        bridge_mask = bridge_mask & ~protected

    new_paper, bridge = apply_bridge_mask(
        paper,
        bridge_mask,
        protected=protected,
        kind="manual",
        description=f"手工补桥 宽{width}px",
        geometry=(points[0][0], points[0][1], points[-1][0], points[-1][1], width),
    )
    return new_paper, bridge, blocked


def apply_bridge_mask(
    paper: np.ndarray,
    bridge_mask: np.ndarray,
    protected: np.ndarray | None = None,
    kind: str = "manual",
    description: str = "",
    geometry: tuple[int, int, int, int, int] | None = None,
) -> tuple[np.ndarray, Bridge]:
    paper = np.asarray(paper, dtype=bool).copy()
    bridge_mask = np.asarray(bridge_mask, dtype=bool)
    if bridge_mask.shape != paper.shape:
        raise ValueError("bridge mask shape does not match paper")

    if protected is not None:
        bridge_mask = bridge_mask & ~np.asarray(protected, dtype=bool)

    changed_coords = np.column_stack(np.nonzero(bridge_mask & ~paper))
    paper[bridge_mask] = True

    if geometry is None:
        ys, xs = np.nonzero(bridge_mask)
        if len(xs):
            geometry = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), 1)
        else:
            geometry = (0, 0, 0, 0, 1)

    bridge = Bridge(
        x0=geometry[0],
        y0=geometry[1],
        x1=geometry[2],
        y1=geometry[3],
        width=geometry[4],
        changed_coords=changed_coords,
        kind=kind,
        description=description,
    )
    return paper, bridge


def undo_bridge(paper: np.ndarray, bridge: Bridge) -> np.ndarray:
    """Undo one bridge patch.

    Bridges are normally undone in reverse application order.  Coordinates are
    stored as the exact pixels changed by that bridge, making the operation
    independent of GUI zoom or geometry.
    """
    paper = np.asarray(paper, dtype=bool).copy()
    coords = bridge.changed_coords
    if coords.size:
        paper[coords[:, 0], coords[:, 1]] = False
    return paper


def paint_protected_disk(
    protected: np.ndarray,
    cx: int,
    cy: int,
    radius: int,
    value: bool = True,
) -> np.ndarray:
    protected = np.asarray(protected, dtype=bool).copy()
    h, w = protected.shape
    radius = max(0, int(radius))
    x0 = max(0, cx - radius)
    x1 = min(w, cx + radius + 1)
    y0 = max(0, cy - radius)
    y1 = min(h, cy + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return protected
    yy, xx = np.mgrid[y0:y1, x0:x1]
    disk = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius**2
    protected[y0:y1, x0:x1][disk] = value
    return protected
