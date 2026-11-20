"""无 GUI 的处理流水线：工程校验、批量拟合、色差对比、导出。"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from .core import (
    Project,
    FitParams,
    FitResult,
    FitError,
    PatchError,
    collect_means,
    fit_transform,
    apply_transform,
    compute_errors,
    gamut_stats,
    gamut_mask,
    load_image_rgb,
    save_image_rgb,
    file_sha256,
)


@dataclass
class SourceReport:
    source_id: str
    source_name: str
    fit: FitParams
    errors: list[PatchError]
    gamut: dict
    export_path: str | None
    transformed: np.ndarray | None = None

    @property
    def mean_delta_e_before(self) -> float:
        return float(np.mean([e.delta_e_before for e in self.errors]))

    @property
    def mean_delta_e_after(self) -> float:
        return float(np.mean([e.delta_e_after for e in self.errors]))

    @property
    def max_delta_e_after(self) -> float:
        return float(max(e.delta_e_after for e in self.errors))


def check_integrity(project: Project, project_dir: str) -> list[str]:
    """重新计算图像哈希，与工程记录比对。"""
    problems = []
    for entry in project.images:
        path = project.image_path(entry, project_dir)
        if not os.path.exists(path):
            problems.append(f"图像文件缺失: {entry.path}")
            continue
        actual = file_sha256(path)
        if actual != entry.sha256:
            problems.append(
                f"图像 {entry.path} 已被修改（哈希不一致），采样位置可能已失效，建议重新框选"
            )
    return problems


def fit_all(project: Project, images: dict[str, np.ndarray]) -> dict[str, FitResult]:
    """对每个源图拟合变换并算色差。把 FitParams.source_id 回填。"""
    ref = project.reference
    if ref is None:
        raise FitError("工程里没有参考图")
    if not project.sources:
        raise FitError("工程里没有源图，至少需要 1 张源图")

    settings = project.settings
    results: dict[str, FitResult] = {}
    for src in project.sources:
        X, Y, used, _, _, sample_warnings = collect_means(
            images, project.samples, ref.id, src.id
        )
        params = fit_transform(
            X,
            Y,
            method=settings.get("method", "affine"),
            lock_white=bool(settings.get("lock_white", False)),
            white_sample_id=settings.get("white_sample_id"),
            used_samples=used,
        )
        params.source_id = src.id
        params.warnings = sample_warnings + params.warnings
        errors = compute_errors(X, Y, used, params)
        results[src.id] = FitResult(params=params, errors=errors)
    project.fits = {sid: r.params for sid, r in results.items()}
    return results


def export_source(
    images: dict[str, np.ndarray],
    params: FitParams,
    out_path: str,
) -> tuple[dict, np.ndarray]:
    """变换单张源图并导出，返回色域统计和裁剪前的变换结果。"""
    transformed = apply_transform(images[params.source_id], params)
    stats = gamut_stats(transformed, foreground_mask(images[params.source_id]))
    save_image_rgb(out_path, transformed)
    stats["export_path"] = os.path.abspath(out_path)
    return stats, transformed


def foreground_mask(src_f: np.ndarray, black_level: float = 0.02) -> np.ndarray:
    """近黑背景掩码：源图亮度高于 black_level 的像素视为有效内容。"""
    return np.max(src_f, axis=-1) > black_level


def run_headless(project_path: str, export_dir: str | None = None) -> list[SourceReport]:
    """加载工程 -> 校验 -> 拟合 -> （可选）导出，返回每张源图的报告。"""
    project = Project.load(project_path)
    project_dir = os.path.dirname(os.path.abspath(project_path))

    integrity = check_integrity(project, project_dir)
    if any("缺失" in p for p in integrity):
        raise FitError("；".join(integrity))

    images = {}
    for entry in project.images:
        images[entry.id] = load_image_rgb(project.image_path(entry, project_dir))

    results = fit_all(project, images)
    os.makedirs(export_dir or project_dir, exist_ok=True)

    reports: list[SourceReport] = []
    for src in project.sources:
        result = results[src.id]
        out_path = None
        transformed = apply_transform(images[src.id], result.params)
        stats = gamut_stats(transformed, foreground_mask(images[src.id]))
        if export_dir:
            base = os.path.splitext(os.path.basename(src.path))[0]
            out_path = os.path.join(export_dir, f"{base}_matched.png")
            save_image_rgb(out_path, transformed)
            stats["export_path"] = os.path.abspath(out_path)
        reports.append(
            SourceReport(
                source_id=src.id,
                source_name=src.path,
                fit=result.params,
                errors=result.errors,
                gamut=stats,
                export_path=out_path,
            )
        )

    # 拟合结果回写工程，保证“重开可复现”
    project.save(project_path)
    # 哈希问题只警告不阻断（GUI 里同样会提示）
    for rep in reports:
        rep.fit.warnings = integrity + rep.fit.warnings
    return reports


def gamut_overlay(base_f: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """生成越界区域可视化：越界像素红色叠加，其余保持原图。"""
    out = base_f.copy()
    red = np.array([1.0, 0.0, 0.0])
    out[mask] = 0.55 * out[mask] + 0.45 * red
    return out
