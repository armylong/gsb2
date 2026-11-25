"""Robust per-pixel photometric-stereo solver.

Model
-----
For a matte surface under a distant light with direction ``l`` (unit vector
pointing *towards* the light) and unit normal ``n``::

    I = rho * max(0, n . l) = max(0, g . l),   g = rho * n

``g`` has three unknowns, so three differently-directed readings are enough.
Two subtleties dominate everything else in practice:

* a reading that is **unlit** (``n . l <= 0``) carries no linear information at
  all — it only says "not this side"; forcing it into the fit drags ``g``
  towards zero.  These readings must be *excluded*, not fitted.
* a reading that is **cast-shadowed**, **clipped** or **non-Lambertian**
  breaks the model.  It has to be found and excluded per pixel and per light.

Pipeline
--------
1. *Triple consensus* — each well-conditioned triple of lights gives an exact
   ``g``.  Each hypothesis predicts every reading; the triple explaining the
   lit readings best seeds the estimate, and the runner-up hypothesis gives a
   disagreement measure used to flag genuinely ambiguous pixels.
2. *Robust refinement* — iteratively reweighted least squares with Tukey
   weights, excluding readings the current model calls unlit.
3. *Leave-one-out audit* — refit without each reading using a rank-1 downdate
   of the normal equations, then label that reading as unlit / shadow /
   saturated / non-Lambertian / fine.
4. *Sufficiency* — a normal is valid only when at least three readings survive,
   the weighted normal matrix is well conditioned, the propagated angular
   uncertainty is small, and the hypotheses did not disagree.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field

import numpy as np

from . import vecmath

STATUS_OK = 0
STATUS_SATURATED = 1
STATUS_SHADOW = 2
STATUS_NONLAMBERT = 3
STATUS_UNLIT = 4

STATUS_NAMES = {
    STATUS_OK: "正常",
    STATUS_SATURATED: "饱和",
    STATUS_SHADOW: "阴影",
    STATUS_NONLAMBERT: "非朗伯",
    STATUS_UNLIT: "未受照",
}
STATUS_SHORT = {
    STATUS_OK: "可用",
    STATUS_SATURATED: "饱和",
    STATUS_SHADOW: "阴影",
    STATUS_NONLAMBERT: "非朗伯",
    STATUS_UNLIT: "未受照",
}

REASON_NONE = 0
REASON_NOT_OBJECT = 1
REASON_TOO_FEW = 2
REASON_ILL_CONDITIONED = 3
REASON_UNCERTAIN = 4
REASON_DARK = 5
REASON_AMBIGUOUS = 6

REASON_NAMES = {
    REASON_NONE: "可用",
    REASON_NOT_OBJECT: "非物体",
    REASON_TOO_FEW: "有效读数不足 3 个",
    REASON_ILL_CONDITIONED: "方向组合病态",
    REASON_UNCERTAIN: "不确定度过大",
    REASON_DARK: "反射率过低",
    REASON_AMBIGUOUS: "方向存在歧义",
}


@dataclass
class SolverOptions:
    saturated_level: float = 0.995
    dark_level: float = 0.004
    unlit_ndl: float = 0.03
    max_hypothesis_triples: int = 24
    iterations: int = 6
    tukey_c: float = 4.5
    sigma_floor: float = 0.004
    # Below this smallest eigenvalue the per-pixel normal matrix is too
    # ill-conditioned to trust: measured against ground truth, reconstructions
    # under 0.09 go wrong for 17-31% of pixels, above it under 4%.
    min_eigenvalue: float = 0.09
    max_uncertainty_deg: float = 12.0
    min_readings: int = 3
    min_albedo: float = 0.012
    shadow_abs: float = 0.030
    shadow_rel: float = 0.35
    highlight_abs: float = 0.030
    highlight_rel: float = 0.16
    ambiguity_separation_deg: float = 15.0
    consensus_tolerance: float = 0.08
    max_working_size: int = 720


@dataclass
class SolveResult:
    width: int
    height: int
    directions: np.ndarray
    normals: np.ndarray
    albedo: np.ndarray
    status: np.ndarray
    valid: np.ndarray
    reason: np.ndarray
    object_mask: np.ndarray
    predictions: np.ndarray
    residual: np.ndarray
    uncertainty_deg: np.ndarray
    readings_used: np.ndarray
    min_eigenvalue: np.ndarray
    confidence: np.ndarray
    sigma: float
    #: Row ``i`` of ``status`` corresponds to scene light ``light_indices[i]``.
    #: Disabled lights are absent from the solve, so this is not always 0..m-1.
    light_indices: np.ndarray | None = None
    options: SolverOptions = field(default_factory=SolverOptions)

    def scene_index(self, row: int) -> int:
        if self.light_indices is None:
            return row
        return int(self.light_indices[row])

    def row_for_scene_light(self, scene_light: int) -> int | None:
        if self.light_indices is None:
            return scene_light if 0 <= scene_light < len(self.directions) else None
        hits = np.nonzero(np.asarray(self.light_indices) == scene_light)[0]
        return int(hits[0]) if len(hits) else None

    def status_at(self, light: int, x: int, y: int) -> int:
        return int(self.status[light, y, x])

    def counts_by_status(self) -> dict[int, int]:
        values, counts = np.unique(self.status[:, self.object_mask], return_counts=True)
        return {int(v): int(c) for v, c in zip(values, counts)}

    def invalid_counts(self) -> dict[int, int]:
        values, counts = np.unique(self.reason[self.object_mask], return_counts=True)
        return {int(v): int(c) for v, c in zip(values, counts) if int(v) != REASON_NONE}


def as_float_images(images: np.ndarray) -> np.ndarray:
    arr = np.asarray(images, dtype=np.float64)
    if arr.ndim != 3:
        raise ValueError("images must be a stack with shape (m, H, W)")
    return np.clip(arr, 0.0, 1.0)


def _normal_equations(images: np.ndarray, dirs: np.ndarray, w: np.ndarray
                      ) -> tuple[np.ndarray, np.ndarray]:
    m = len(dirs)
    a = np.zeros(images.shape[1:] + (3, 3))
    b = np.zeros(images.shape[1:] + (3,))
    for i in range(m):
        if not np.any(w[i]):
            continue
        a += w[i][..., None, None] * np.outer(dirs[i], dirs[i])
        b += w[i][..., None] * (dirs[i] * images[i][..., None])
    return a, b


def _solve_normal_equations(a: np.ndarray, b: np.ndarray
                            ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ev, evec = np.linalg.eigh(a)
    coef = np.einsum("hwji,hwj->hwi", evec, b)
    coef = np.divide(coef, ev, out=np.zeros_like(coef), where=ev > 1e-9)
    g = np.einsum("hwij,hwj->hwi", evec, coef)
    return g, ev, evec


def _fit(images: np.ndarray, dirs: np.ndarray, w: np.ndarray) -> np.ndarray:
    a, b = _normal_equations(images, dirs, w)
    return _solve_normal_equations(a, b)[0]


def _decompose(g: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rho = np.linalg.norm(g, axis=-1)
    n = g / np.maximum(rho, 1e-9)[..., None]
    return rho, n


def _hypotheses(images: np.ndarray, dirs: np.ndarray, usable: np.ndarray,
                opts: SolverOptions) -> tuple[np.ndarray, np.ndarray]:
    """Seed ``g`` from the best-explaining light triple; return (g, confidence)."""
    m, H, W = images.shape
    if m < 3:
        return np.zeros((H, W, 3)), np.zeros((H, W))

    triples = list(itertools.combinations(range(m), 3))
    ranked = []
    for tri in triples:
        ev = np.linalg.eigvalsh(np.einsum("ij,ik->jk", dirs[list(tri)], dirs[list(tri)]))
        if ev[0] > 1e-6:
            ranked.append((float(ev[0]), tri))
    ranked.sort(key=lambda item: -item[0])
    ranked = ranked[: max(3, min(opts.max_hypothesis_triples, len(ranked)))]
    if not ranked:
        return np.zeros((H, W, 3)), np.zeros((H, W))

    scores, gs, ns = [], [], []
    for _, tri in ranked:
        used = np.zeros(m, dtype=bool)
        used[list(tri)] = True
        # only the *omitted* readings test the hypothesis: the three used ones
        # fit exactly by construction and would dilute every comparison.
        test = usable & ~used[:, None, None]
        inv = np.linalg.inv(dirs[list(tri)])
        g = np.einsum("ij,hwj->hwi", inv, images[list(tri)].transpose(1, 2, 0))
        rho, n = _decompose(g)
        ndl = np.einsum("ij,hwj->ihw", dirs, n)
        pred = rho[None] * np.clip(ndl, 0.0, None)
        tol = np.maximum(0.035, 0.12 * np.maximum(pred, 0.20))
        resid = np.abs(images - pred)
        # a reading the hypothesis calls unlit must actually be near black;
        # darkness is weak evidence (it also fits "cast shadow"), so it scores
        # less than a genuine lit match.
        unlit = ndl <= opts.unlit_ndl
        dark = images < 0.06
        explained = np.where(unlit, np.where(dark, 0.45, 0.0),
                             np.where(dark, 0.0, np.exp(-resid / (0.35 * tol))))
        weight = np.maximum(test.sum(axis=0), 1)
        score = np.where(test, explained, 0.0).sum(axis=0) / weight
        ok = (rho > 0.02) & (n[..., 2] > -0.4)
        scores.append(np.where(ok, score, -1.0))
        gs.append(g)
        ns.append(n)

    stack = np.stack(scores, axis=0)                  # (k, H, W) in [-1, 1]
    g_stack = np.stack(gs, axis=0)
    order = np.argsort(stack, axis=0)
    best = order[-1]
    ys, xs = np.mgrid[0:H, 0:W]
    best_g = g_stack[best, ys, xs]
    best_score = np.take_along_axis(stack, best[None], axis=0)[0]
    has_fit = best_score >= 0.0

    if len(ranked) >= 2:
        n_stack = np.stack(ns, axis=0)
        nb = n_stack[best, ys, xs]
        # Candidates that explain the omitted readings almost as well as the
        # winner.  If they point elsewhere, the reading set cannot decide the
        # tilt: expose the spread so the UI can flag the spot.
        candidate = (stack >= np.maximum(best_score - opts.consensus_tolerance, 0.0))
        dots = np.einsum("khwj,hwj->khw", n_stack, nb)
        angles = np.rad2deg(np.arccos(np.clip(dots, -1.0, 1.0)))
        spread = np.where(candidate & (stack >= 0.0), angles, 0.0).max(axis=0)
        confidence = np.clip(1.0 - spread / opts.ambiguity_separation_deg, 0.0, 1.0)
        confidence = np.where(has_fit, confidence, 0.0)
    else:
        confidence = np.where(has_fit, 1.0, 0.0)
    best_g = np.where(has_fit[..., None], best_g, 0.0)
    return best_g, np.where(has_fit, confidence, 0.0)


def _leave_one_out(g: np.ndarray, a: np.ndarray, dirs: np.ndarray,
                   images: np.ndarray, w: np.ndarray
                   ) -> tuple[np.ndarray, np.ndarray]:
    """Predict each light from the others via a rank-1 downdate.

    Uses ``(A - w l l^T)^-1 = A^-1 + w A^-1 l l^T A^-1 / (1 - w l^T A^-1 l)``
    and the matching update of the right-hand side.  ``usable`` is false when
    the downdate is numerically singular.
    """
    m = len(dirs)
    ev, evec = np.linalg.eigh(a)
    inv_ev = np.divide(1.0, ev, out=np.zeros_like(ev), where=ev > 1e-9)
    ainv = np.einsum("hwij,hwj,hwjk->hwik", evec, inv_ev, np.swapaxes(evec, -1, -2))
    preds = np.zeros((m,) + g.shape[:2])
    usable = np.ones((m,) + g.shape[:2], dtype=bool)
    for i in range(m):
        l = dirs[i]
        wi = w[i]
        u = np.einsum("hwjk,k->hwj", ainv, l)
        ul = np.einsum("hwj,j->hw", u, l)
        denom = 1.0 - wi * ul
        safe = np.abs(denom) > 1e-3
        lu = np.einsum("hwj,j->hw", g, l)
        step = wi * (lu - images[i]) / np.where(safe, denom, 1.0)
        g_loo = g + step[..., None] * u
        g_loo = np.where(safe[..., None], g_loo, g)
        rho_loo = np.linalg.norm(g_loo, axis=-1)
        usable[i] = safe & (rho_loo > 1e-4)
        preds[i] = np.maximum(np.einsum("hwj,j->hw", g_loo, l), 0.0)
    return preds, usable


def solve(images: np.ndarray, directions: np.ndarray,
          object_mask: np.ndarray | None = None,
          options: SolverOptions | None = None,
          light_indices: np.ndarray | None = None) -> SolveResult:
    opts = options or SolverOptions()
    imgs = as_float_images(images)
    dirs = vecmath.normalize(np.asarray(directions, dtype=np.float64).reshape(-1, 3))
    m, H, W = imgs.shape
    if len(dirs) != m:
        raise ValueError("need one light direction per image")

    if object_mask is None:
        object_mask = imgs.max(axis=0) > 0.02
    object_mask = np.asarray(object_mask, dtype=bool) & (imgs.max(axis=0) > opts.dark_level)

    base = np.broadcast_to(object_mask[None], imgs.shape)
    saturated = base & (imgs >= opts.saturated_level)
    usable = base & ~saturated
    g, confidence = _hypotheses(imgs, dirs, usable, opts)

    # ---- robust refinement --------------------------------------------------
    w = usable.astype(np.float64)
    sigma = opts.sigma_floor
    rho, n = _decompose(g)
    for _ in range(max(1, opts.iterations)):
        # A model that says "facing away from this light" cannot be fitted with
        # the linear relation, so those readings leave the fit.  But a reading
        # that is *bright* cannot be unlit: keeping it out would lock in a bad
        # estimate wherever the seed was wrong, so bright readings stay in and
        # pull the fit back.
        ndl = np.einsum("ij,hwj->ihw", dirs, n)
        truly_dark = imgs <= max(opts.dark_level, 0.045)
        active = usable & ((ndl > opts.unlit_ndl) | ~truly_dark)
        pred = rho[None] * np.clip(ndl, 0.0, None)
        resid = imgs - pred
        sample = resid[active]
        if sample.size:
            sigma = max(opts.sigma_floor,
                        1.4826 * float(np.median(np.abs(sample - np.median(sample)))))
        scale = np.maximum(0.035, 0.11 * np.maximum(pred, 0.18)) + opts.tukey_c * sigma
        u = resid / scale
        tukey = np.where(np.abs(u) < 1.0, (1.0 - u * u) ** 2, 0.0)
        new_w = np.where(active, tukey, 0.0)
        change = float(np.abs(new_w - w).sum())
        w = new_w
        # refit with the new weights *before* the next unlit test, otherwise
        # the "unlit" verdict lags a step behind the estimate.
        g = _fit(imgs, dirs, w)
        rho, n = _decompose(g)
        if change < 3.0:
            break

    a, b = _normal_equations(imgs, dirs, w)
    g, ev, evec = _solve_normal_equations(a, b)
    rho, n = _decompose(g)
    ndl = np.einsum("ij,hwj->ihw", dirs, n)
    lit_model = ndl > opts.unlit_ndl
    pred_final = rho[None] * np.clip(ndl, 0.0, None)
    resid = imgs - pred_final
    sample = resid[usable & lit_model]
    if sample.size:
        sigma = max(opts.sigma_floor,
                    1.4826 * float(np.median(np.abs(sample - np.median(sample)))))

    # ---- leave-one-out audit ------------------------------------------------
    loo_pred, loo_ok = _leave_one_out(g, a, dirs, imgs, w)

    # "Unlit" = the model says this surface faces away from the light *and*
    # the reading is black.  A black reading whose direction is ambiguous is
    # labelled "shadow" instead: from the pixels alone the two are the same,
    # and the pixel is flagged invalid either way.
    near_black = imgs <= max(opts.dark_level, 0.045)
    unlit = usable & (ndl <= opts.unlit_ndl) & near_black
    shadow_thr = np.maximum(opts.shadow_abs, opts.shadow_rel * loo_pred) + 3.0 * sigma
    bright_thr = np.maximum(opts.highlight_abs,
                            opts.highlight_rel * np.maximum(loo_pred, 0.2)) + 3.0 * sigma
    loo_resid = imgs - loo_pred
    residual_ok = usable & (~unlit) & loo_ok
    shadow = residual_ok & (loo_pred > 0.05) & (loo_resid < -shadow_thr)
    nonlambert = residual_ok & (~shadow) & (loo_resid > bright_thr)

    status = np.full((m, H, W), STATUS_OK, dtype=np.int8)
    status[saturated] = STATUS_SATURATED
    status[shadow] = STATUS_SHADOW
    status[nonlambert] = STATUS_NONLAMBERT
    status[unlit] = STATUS_UNLIT
    status[:, ~object_mask] = STATUS_OK

    clean = object_mask[None] & (status == STATUS_OK)
    readings = clean.sum(axis=0).astype(np.int16)

    # ---- sufficiency --------------------------------------------------------
    lam_min = ev[..., 0]
    inv_ev = np.divide(1.0, ev, out=np.zeros_like(ev), where=ev > 1e-10)
    uncertainty = np.rad2deg(np.sqrt(inv_ev.sum(axis=-1)) * sigma / np.maximum(rho, 1e-6))
    ambiguous = confidence < 0.15

    reason = np.zeros((H, W), dtype=np.int8)
    reason[~object_mask] = REASON_NOT_OBJECT
    reason[(reason == REASON_NONE) & (readings < opts.min_readings)] = REASON_TOO_FEW
    reason[(reason == REASON_NONE) & (lam_min < opts.min_eigenvalue)] = REASON_ILL_CONDITIONED
    reason[(reason == REASON_NONE) & (uncertainty > opts.max_uncertainty_deg)] = REASON_UNCERTAIN
    reason[(reason == REASON_NONE) & (rho < opts.min_albedo)] = REASON_DARK
    reason[(reason == REASON_NONE) & ambiguous] = REASON_AMBIGUOUS
    # photometric stereo cannot see through the surface: a normal pointing
    # away from the camera is not physically admissible here.
    backfacing = n[..., 2] <= 0.0
    reason[(reason == REASON_NONE) & backfacing] = REASON_AMBIGUOUS
    valid = reason == REASON_NONE

    normals = np.where(valid[..., None], n, 0.0)
    return SolveResult(
        width=W, height=H,
        directions=dirs,
        normals=normals,
        albedo=np.where(object_mask, rho, 0.0),
        status=status,
        valid=valid,
        reason=reason,
        object_mask=object_mask,
        predictions=loo_pred,
        residual=resid,
        uncertainty_deg=uncertainty,
        readings_used=readings,
        min_eigenvalue=lam_min,
        confidence=confidence,
        sigma=sigma,
        light_indices=(None if light_indices is None
                       else np.asarray(light_indices, dtype=np.int32)),
        options=opts,
    )


def mirror_towards_viewer(normals: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    out = np.array(normals, dtype=np.float64, copy=True)
    flip = out[..., 2] < 0
    if valid is not None:
        flip &= valid
    out[flip] *= -1.0
    return out


def normal_angle_deg(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return vecmath.angle_between(a, b)
