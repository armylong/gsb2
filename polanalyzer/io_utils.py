"""图像读写与结果导出."""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
from PIL import Image

from .physics import FitResult


class ImageLoadError(Exception):
    pass


def load_rgb(path: str | Path) -> np.ndarray:
    """读图为 RGB uint8; 非 8 位/调色板图统一转换."""
    p = Path(path)
    if not p.exists():
        raise ImageLoadError(f"文件不存在: {p}")
    try:
        with Image.open(p) as im:
            im.load()
            if im.mode != "RGB":
                im = im.convert("RGB")
            return np.asarray(im, dtype=np.uint8)
    except Exception as exc:  # Pillow 的异常类型较杂, 统一包装
        raise ImageLoadError(f"无法读取 {p.name}: {exc}") from exc


def load_stack(paths: list[str]) -> tuple[np.ndarray, list[str]]:
    """加载多张图并校验同尺寸, 返回 (栈, 问题列表)."""
    problems: list[str] = []
    images: list[np.ndarray] = []
    base_size: tuple[int, int] | None = None
    for i, path in enumerate(paths):
        im = load_rgb(path)
        size = (im.shape[1], im.shape[0])
        if base_size is None:
            base_size = size
        elif size != base_size:
            problems.append(
                f"第 {i + 1} 张 {Path(path).name} 尺寸 {size[0]}x{size[1]} "
                f"与首张 {base_size[0]}x{base_size[1]} 不一致, 已排除"
            )
            continue
        images.append(im)
    if not images:
        raise ImageLoadError("没有可加载的有效图像")
    return np.stack(images, axis=0), problems


def save_rgb(rgb: np.ndarray, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb.astype(np.uint8), mode="RGB").save(path)
    return path


def save_mask(mask: np.ndarray, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((mask.astype(bool) * 255).astype(np.uint8), mode="L").save(path)
    return path


def export_fit_csv(fit: FitResult, path: str | Path, step: int = 2) -> Path:
    """导出逐像素拟合参数 (step 控制抽样步长, 避免文件过大).

    只导出可信像素, 列: x,y,A,R,rho,phi_deg,rms,category
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ys, xs = np.nonzero(fit.trustworthy[::step, ::step])
    ys *= step
    xs *= step
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["x", "y", "A", "R", "rho", "phi_deg", "rms"])
        for y, x in zip(ys, xs):
            w.writerow([int(x), int(y), f"{fit.A[y, x]:.6f}", f"{fit.R[y, x]:.6f}",
                        f"{fit.rho[y, x]:.6f}", f"{fit.phi[y, x]:.3f}", f"{fit.rms[y, x]:.6f}"])
    return path


def export_probe_csv(fit: FitResult, x: int, y: int, theta_grid: np.ndarray, path: str | Path) -> Path:
    """导出光标处随角度曲线 (实测四点 + 拟合曲线)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.deg2rad(theta_grid)
    curve = fit.A[y, x] + fit.B[y, x] * np.cos(2 * t) + fit.C[y, x] * np.sin(2 * t)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["kind", "theta_deg", "luminance"])
        for th, val in zip(theta_grid, curve):
            w.writerow(["fit", f"{th:.3f}", f"{val:.6f}"])
        for th, val in zip(fit.angles, fit.lum[:, y, x]):
            w.writerow(["measured", f"{th:.3f}", f"{val:.6f}"])
    return path
