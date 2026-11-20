"""修补算法.

两种可对比的方法:
  * diffusion : 邻域插值/扩散式 (OpenCV Telea 或 Navier-Stokes), 快, 适合小块,
                但细线跨过明暗边缘时容易把边缘抹糊、结构接不上.
  * texture   : 纹理式/样本块修补 (简化版 Criminisi): 沿填充前沿按
                置信度 x 结构强度 的优先级逐块填充, 在完好区域中搜索最相似
                的补丁复制过来, 跨边缘的细线结构通常能续上.

所有函数保证: 遮罩之外像素与输入完全一致 (结果 = 输入拷贝后仅改写遮罩内像素).
"""

from __future__ import annotations

import cv2
import numpy as np

METHODS = ("diffusion", "texture")


def _to_bgr(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_RGB2BGR)


def _from_bgr(img: np.ndarray, like: np.ndarray) -> np.ndarray:
    if like.ndim == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def inpaint_diffusion(img: np.ndarray, mask: np.ndarray, radius: float = 4.0,
                      variant: str = "telea") -> np.ndarray:
    """邻域插值 (扩散式). variant: 'telea' | 'ns'."""
    m = (mask > 0).astype(np.uint8) * 255
    if not m.any():
        return img.copy()
    flag = cv2.INPAINT_TELEA if variant == "telea" else cv2.INPAINT_NS
    out = cv2.inpaint(_to_bgr(img), m, radius, flag)
    out = _from_bgr(out, like=img)
    # cv2.inpaint 理论上只改遮罩内, 这里显式保证选区外逐位不变
    result = img.copy()
    result[m > 0] = out[m > 0]
    return result


def _priority(conf, fill, gray):
    """填充前沿优先级 = 置信度项 x 数据结构项."""
    k = np.ones((9, 9), np.float32)
    conf_sum = cv2.filter2D(conf, -1, k, borderType=cv2.BORDER_CONSTANT)
    # 填充区域边界 = 待填区与已知区的交界
    dil = cv2.dilate((fill > 0).astype(np.uint8), np.ones((3, 3), np.uint8))
    front = (dil > 0) & (fill > 0)
    if not front.any():
        return None, None
    # 法向: 对填充掩码求梯度
    fm = (fill > 0).astype(np.float32)
    nx = cv2.Sobel(fm, cv2.CV_32F, 1, 0, ksize=3)
    ny = cv2.Sobel(fm, cv2.CV_32F, 0, 1, ksize=3)
    norm = np.sqrt(nx**2 + ny**2) + 1e-6
    nx, ny = nx / norm, ny / norm
    # 等照度线方向 (梯度旋转 90 度) 与法向点积 -> 结构项
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    data = np.abs(gx * (-ny) + gy * nx) / 255.0 + 0.001
    prio = (conf_sum / 81.0) * data
    prio[~front] = -1
    return prio, front


def inpaint_texture(img: np.ndarray, mask: np.ndarray, patch_size: int = 9,
                    max_iters: int = 4000) -> np.ndarray:
    """纹理式 (样本块) 修补, 简化版 Criminisi 算法."""
    m = (mask > 0).astype(np.uint8)
    if not m.any():
        return img.copy()
    if img.ndim == 2:
        work = img.astype(np.float32)[..., None]
    else:
        work = img.astype(np.float32)
    h, w = work.shape[:2]
    half = patch_size // 2
    fill = m.copy()                      # 尚未填充
    known_all = (m == 0).astype(np.uint8)  # 原始完好区
    conf = known_all.astype(np.float32)  # 置信度
    gray = cv2.cvtColor(work.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) \
        if work.shape[2] == 3 else work[..., 0].copy()

    for _ in range(max_iters):
        if not fill.any():
            break
        prio, _ = _priority(conf, fill, gray)
        if prio is None:
            break
        y, x = np.unravel_index(np.argmax(prio), prio.shape)
        y0, y1 = max(0, y - half), min(h, y + half + 1)
        x0, x1 = max(0, x - half), min(w, x + half + 1)
        # 边界处补丁收缩, 保持模板与权重同形
        templ = work[y0:y1, x0:x1]
        tmask = ((1 - fill[y0:y1, x0:x1]) * 255).astype(np.uint8)
        if (tmask > 0).sum() < 4:
            # 周围几乎无可参考像素, 退化为邻域均值
            ys, xs = np.where(tmask > 0)
            if len(ys) == 0:
                fill[y, x] = 0
                conf[y, x] = 0.5
                continue
            mean_val = templ[ys, xs].mean(axis=0)
            work[y, x] = mean_val
            gray[y, x] = float(mean_val.mean())
            fill[y, x] = 0
            conf[y, x] = 0.5
            continue
        # 在整图中搜索最相似补丁 (仅完好区可作为来源)
        ph, pw = templ.shape[:2]
        res = cv2.matchTemplate(work, templ, cv2.TM_SQDIFF, mask=tmask)
        # matchTemplate 结果对齐到模板左上角; 用 anchor=(0,0) 的腐蚀得到
        # "以 (y,x) 为左上角时整个补丁都在完好区" 的有效位置图
        valid_tl = cv2.erode(known_all, np.ones((ph, pw), np.uint8), anchor=(0,0))
        rh, rw = res.shape
        res_masked = np.where(valid_tl[:rh, :rw] > 0, res, np.inf)
        if not np.isfinite(res_masked).any():
            fill[y, x] = 0
            conf[y, x] = 0.5
            continue
        by, bx = np.unravel_index(np.argmin(res_masked), res_masked.shape)
        # 把最佳补丁中对应"待填"位置的像素复制过来
        src = work[by:by + ph, bx:bx + pw]
        tgt_fill = fill[y0:y1, x0:x1] > 0
        region = work[y0:y1, x0:x1]
        region[tgt_fill] = src[tgt_fill]
        work[y0:y1, x0:x1] = region
        gregion = gray[y0:y1, x0:x1]
        gsrc = cv2.cvtColor(src.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) \
            if work.shape[2] == 3 else src[..., 0]
        gregion[tgt_fill] = gsrc[tgt_fill]
        gray[y0:y1, x0:x1] = gregion
        conf[y0:y1, x0:x1][tgt_fill] = conf[y, x]
        fill[y0:y1, x0:x1][tgt_fill] = 0

    out = np.clip(work, 0, 255).astype(np.uint8)
    if img.ndim == 2:
        out = out[..., 0]
    result = img.copy()
    result[m > 0] = out[m > 0]
    return result


def inpaint(img: np.ndarray, mask: np.ndarray, method: str = "diffusion", **kw) -> np.ndarray:
    """统一入口. 保证遮罩外像素与输入逐位一致."""
    if method == "diffusion":
        return inpaint_diffusion(img, mask, **{k: v for k, v in kw.items()
                                               if k in ("radius", "variant")})
    if method == "texture":
        return inpaint_texture(img, mask, **{k: v for k, v in kw.items()
                                             if k in ("patch_size", "max_iters")})
    raise ValueError(f"未知方法: {method}")
