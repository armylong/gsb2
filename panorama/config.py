"""全局可调参数与硬性安全上限。

所有阈值集中在此，便于审阅“什么样的关系会被拒绝”。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Config:
    # ---- 特征 ----
    feature_type: str = "sift"          # sift | orb（sift 不可用时自动降级）
    n_features: int = 6000
    ratio_test: float = 0.75            # Lowe 比率测试阈值
    match_grid: int = 4                 # 网格数量（grid x grid），用于覆盖度统计

    # ---- 单对照片几何关系接受门槛（必须同时满足）----
    min_inliers: int = 12               # RANSAC 内点绝对数量
    min_inlier_ratio: float = 0.35      # 内点 / 候选匹配
    max_reproj_px: float = 3.0          # RANSAC 重投影阈值（像素）
    max_final_rmse_px: float = 4.0      # 最终内点 RMSE 上限（超过则判失真）
    min_coverage_cells: int = 3         # 内点至少覆盖多少个网格（防局部聚集）
    min_overlap_frac: float = 0.08      # 估计重叠区占较小照片面积比例下限

    # ---- 单应尺度合理性（防止失控变换）----
    scale_min: float = 0.25             # 映射后局部尺度上下限
    scale_max: float = 4.0
    skew_max: float = 2.0               # |H[0,1]|, |H[1,0]| 上限（归一化后）
    max_persp: float = 0.002            # 透视项 h31/h32 绝对值上限（1/像素）

    # ---- 控制点 ----
    min_cp_for_solve: int = 4           # 纯手动求解最少点数（平面 4 点）
    cp_reproj_warn_px: float = 6.0      # 手动点 RMSE 超过该值提示矛盾

    # ---- 全局布局 ----
    ref_index: int = 0                  # 参考照片（画布坐标系锚点）
    lm_max_iter: int = 200
    # 闭环边占比超过该值时认为存在首尾重叠，启用闭环联合优化
    loop_min_overlap: float = 0.12

    # ---- 画布 / 导出安全上限 ----
    max_canvas_side: int = 30000        # 任一边超过即拒绝
    max_canvas_pixels: int = 200_000_000
    max_export_side: int = 20000
    max_export_pixels: int = 120_000_000
    max_transform_scale: float = 8.0    # 全局变换相对参考的尺度上限
    min_valid_crop_frac: float = 0.25   # 内部有效矩形至少占有效像素面积比例

    # ---- 融合 ----
    feather_px: int = 24
    ghost_diff_thresh: float = 28.0     # 重叠区亮度差超过该值视为潜在重影
    ghost_area_frac: float = 0.04       # 重影像素占重叠区比例超过则提示

    # ---- 合成场景 ----
    synthetic_seed: int = 20261118


DEFAULT = Config()
