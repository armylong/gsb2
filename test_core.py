"""核心算法自检: 不依赖 GUI, 直接验证关键性质。"""
import numpy as np

from sirds_core import (RenderParams, make_depth, render_sirds, analyze_row,
                        separation, validate_params, make_default_texture)


def check(name, cond):
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")
    assert cond, name


def main():
    p = RenderParams(width=720, height=480, eye_sep=120, mu=1/3,
                     pattern_width=120, seed=7, depth_kind="step",
                     z_far=0.15, z_near=0.95)

    # 1. 确定性: 同种子同设定重生成完全一致
    d = make_depth(p)
    img1, _ = render_sirds(d, p)
    img2, _ = render_sirds(d, p)
    check("同种子重生成逐像素一致", np.array_equal(img1, img2))

    p2 = RenderParams(**{**p.__dict__, "seed": 8})
    img3, _ = render_sirds(d, p2)
    check("换种子结果不同", not np.array_equal(img1, img3))

    # 2. 视差公式: 近处视差 < 远处视差
    s_far = separation(p.z_far, p.eye_sep, p.mu)
    s_near = separation(p.z_near, p.eye_sep, p.mu)
    check(f"近处视差({s_near}) < 远处视差({s_far})", s_near < s_far)

    # 3. 行分析: 台阶中间行, 背景区与浮起区的实际点对距离应分别接近 s_far / s_near
    y = 240
    dbg = analyze_row(d, y, p.eye_sep, p.mu)
    dist = dbg.pair_distances
    check("存在同名点对", dist.size > 0)
    # 用深度分区统计: 自由点颜色从右往左传播, 直接看 sep 数组更可靠
    sep_row = dbg.separation
    in_step = d[y] > 0.5
    check("浮起区视差全部等于 s_near",
          np.all(sep_row[in_step] == s_near))
    check("背景区视差全部等于 s_far",
          np.all(sep_row[~in_step] == s_far))

    # 4. 遮挡: 台阶边缘应产生被挡的候选对
    check(f"台阶边缘检出被遮挡的匹配 (共 {len(dbg.occluded)} 处)",
          len(dbg.occluded) > 0)

    # 5. 同色约束: 输出图中每一对链接点颜色必须一致 (不矛盾)
    _, links = render_sirds(d, p, collect_links=True)
    row_img = img1[y]
    row_link = links[y]
    xs = np.where(row_link > np.arange(row_link.size))[0]
    same_color = all(np.array_equal(row_img[x], row_img[row_link[x]]) for x in xs)
    check("所有同名点对在输出中颜色一致", same_color)

    # 6. 平面样例: 整行视差恒定, 输出呈周期 E*(1-mu*z_far) 的重复
    pp = RenderParams(width=720, height=480, eye_sep=120, mu=1/3,
                      pattern_width=120, seed=7, depth_kind="plane",
                      z_far=0.15, z_near=0.95)
    dp = make_depth(pp)
    imgp, _ = render_sirds(dp, pp)
    rowp = imgp[100].astype(int)
    per = int(separation(0.15, 120, 1/3))
    check(f"平面输出行以 {per}px 为周期重复",
          np.array_equal(rowp[:-per], rowp[per:]))

    # 7. 带孔台阶: 孔内视差回到远处值
    ph = RenderParams(**{**p.__dict__, "depth_kind": "step_hole"})
    dh = make_depth(ph)
    yh = 240
    xh = 360  # 孔中心
    check("孔中心深度回到远层", dh[yh, xh] == ph.z_far)
    dbgh = analyze_row(dh, yh, ph.eye_sep, ph.mu)
    check("孔中心视差等于远处视差", dbgh.separation[xh] == s_far)

    # 8. 纹理模式 + 默认纹理可运行且确定
    pt = RenderParams(**{**p.__dict__, "dot_mode": "texture"})
    tex = make_default_texture(pt)
    it1, _ = render_sirds(d, pt, texture=tex)
    it2, _ = render_sirds(d, pt, texture=tex)
    check("纹理模式重生成一致", np.array_equal(it1, it2))

    # 9. 参数校验能抓到不合理组合
    bad = RenderParams(width=300, eye_sep=200, mu=0.9, pattern_width=300,
                       dot_mode="texture")
    warns = validate_params(bad)
    check(f"不合理参数产生警告 ({len(warns)} 条)", len(warns) >= 3)
    ok = validate_params(p)
    check("合理参数无警告", ok == [])

    print("\n全部自检通过。")


if __name__ == "__main__":
    main()
