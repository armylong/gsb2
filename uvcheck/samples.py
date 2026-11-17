"""程序化生成 OBJ 与贴图样例。

样例刻意包含各类已知缺陷，便于直接验证工具的检测与联动能力：

- ``sample_box.obj``      一个规则立方体（UV 正确）+ 6 个并排测试三角面，分别制造
                          越界、重叠、部分重叠、拉伸、UV 退化、缺 UV 等情况
- ``sample_broken.obj``   含格式错误行（坏顶点、越界索引、非三角面引用），
                          验证容错：坏数据被报告，其余部分仍可检查
- ``sample_texture.png``  带编号棋盘格贴图（观察拉伸/错位）
"""

from __future__ import annotations

import os

from .png import checker_texture, write_png


def _emit_obj(vertices: list[tuple[float, float, float]],
              uvs: list[tuple[float, float]],
              faces: list[tuple[list[int], list[int] | None]],
              header: str) -> str:
    lines = [header]
    for x, y, z in vertices:
        lines.append(f"v {x:.6f} {y:.6f} {z:.6f}")
    for u, v in uvs:
        lines.append(f"vt {u:.6f} {v:.6f}")
    for vis, uvis in faces:
        vpart = " ".join(str(i + 1) for i in vis)
        if uvis is None:
            lines.append(f"f {vpart}")
        else:
            lines.append("f " + " ".join(f"{vi + 1}/{ti + 1}" for vi, ti in zip(vis, uvis)))
    return "\n".join(lines) + "\n"


def build_box_obj() -> str:
    """立方体 + 缺陷演示三角面。返回 OBJ 文本。"""
    vertices: list[tuple[float, float, float]] = []
    uvs: list[tuple[float, float]] = []
    faces: list[tuple[list[int], list[int] | None]] = []

    # ---- 规则立方体：6 面 × 2 三角形，每面映射到 4x2 贴图网格中的一格 ----
    # 单位立方体，中心在原点。立方体只用前 3 列（u ∈ [0, 0.75]），
    # 第 4 列留给下方缺陷演示面，避免 UV 区域互相碰撞产生假重叠。
    cube_v = [
        (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
        (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),
    ]
    # 每个面给出 4 个角的立方体顶点索引（A=左下 B=右下 C=右上 D=左上），
    # 沿对角线 A-C 切两个三角形；UV 沿同一条对角线切分，且每个三角形
    # 独立发射 3 个顶点与 3 个 UV，显式保证三维边与 UV 边一一对应，
    # 映射为纯尺度变换（无剪切、各向异性=1）。
    face_defs = [
        ([4, 5, 6, 7], 0, 0),  # +Z
        ([1, 0, 3, 2], 1, 0),  # -Z
        ([5, 1, 2, 6], 2, 0),  # +X
        ([0, 4, 7, 3], 0, 1),  # -X
        ([3, 7, 6, 2], 1, 1),  # +Y
        ([0, 1, 5, 4], 2, 1),  # -Y
    ]
    for corners, gx, gy in face_defs:
        u0, u1 = gx * 0.25, (gx + 1) * 0.25
        v0, v1 = gy * 0.5, (gy + 1) * 0.5
        a, b, c, d = corners
        # 三角形 1：几何 (A,B,C) ↔ UV (左下,右下,右上)
        base_v = len(vertices)
        vertices.extend([cube_v[a], cube_v[b], cube_v[c]])
        base_t = len(uvs)
        uvs.extend([(u0, v0), (u1, v0), (u1, v1)])
        faces.append(([base_v, base_v + 1, base_v + 2],
                      [base_t, base_t + 1, base_t + 2]))
        # 三角形 2：几何 (A,C,D) ↔ UV (左下,右上,左上)
        base_v = len(vertices)
        vertices.extend([cube_v[a], cube_v[c], cube_v[d]])
        base_t = len(uvs)
        uvs.extend([(u0, v0), (u1, v1), (u0, v1)])
        faces.append(([base_v, base_v + 1, base_v + 2],
                      [base_t, base_t + 1, base_t + 2]))

    # ---- 并排缺陷演示三角面（位于立方体上方 z=2.5 一带）----
    # 演示面 UV 统一放在贴图第 4 列 u∈[0.78, 0.98] 的纵向条带，
    # 与立方体使用的 u∈[0, 0.75] 区域隔离，避免产生假重叠。
    z = 2.5
    gap = 1.3
    start_x = -3.25

    def add_triangle(name: str,
                     xyz: list[tuple[float, float, float]],
                     uv: list[tuple[float, float]] | None) -> None:
        base_v = len(vertices)
        vertices.extend(xyz)
        if uv is None:
            faces.append(([base_v, base_v + 1, base_v + 2], None))
            return
        base_t = len(uvs)
        uvs.extend(uv)
        faces.append(([base_v, base_v + 1, base_v + 2],
                      [base_t, base_t + 1, base_t + 2]))

    # 1) 正常参考面（无问题）
    x = start_x
    add_triangle("ok",
                 [(x, 0, z), (x + 1, 0, z), (x, 1, z)],
                 [(0.78, 0.02), (0.88, 0.02), (0.78, 0.12)])

    # 2) UV 越界：u=1.06、v=-0.12 超出 [0,1]
    x += gap
    add_triangle("out_of_range",
                 [(x, 0, z), (x + 1, 0, z), (x, 1, z)],
                 [(0.94, 0.05), (1.06, 0.05), (0.94, 0.18)])

    # 3) 与面 4 完全重叠（同一 UV 区域，两块几何）
    x += gap
    add_triangle("overlap_a",
                 [(x, 0, z), (x + 1, 0, z), (x, 1, z)],
                 [(0.78, 0.28), (0.92, 0.28), (0.78, 0.42)])

    # 4) 与面 3 UV 相同（重叠）
    x += gap
    add_triangle("overlap_b",
                 [(x, 0, z), (x + 1, 0, z), (x, 1, z)],
                 [(0.78, 0.28), (0.92, 0.28), (0.78, 0.42)])

    # 5) 明显拉伸：三维直角单位三角面，UV 在 v 方向被压成 0.02（5 倍各向异性）
    x += gap
    add_triangle("stretch",
                 [(x, 0, z), (x + 1, 0, z), (x, 1, z)],
                 [(0.78, 0.55), (0.88, 0.55), (0.78, 0.57)])

    # 6) UV 退化：三个 vt 共线（面积为 0）
    x += gap
    add_triangle("uv_degenerate",
                 [(x, 0, z), (x + 1, 0, z), (x, 1, z)],
                 [(0.78, 0.72), (0.85, 0.72), (0.92, 0.72)])

    # 7) 缺贴图坐标：f 不带 vt
    x += gap
    add_triangle("missing_uv",
                 [(x, 0, z), (x + 1, 0, z), (x + 1, 1, z)],
                 None)

    header = (
        "# 程序生成：uvcheck 样例（规则立方体 + 缺陷演示三角面）\n"
        "# 三角形编号从 1 开始；前 12 个为立方体，之后依次为\n"
        "# 正常/越界/重叠A/重叠B/拉伸/UV退化/缺UV\n"
        "o sample_box\n"
    )
    return _emit_obj(vertices, uvs, faces, header)


def build_broken_obj() -> str:
    """含多种格式错误的 OBJ，用于验证容错解析。"""
    return (
        "# 程序生成：含格式错误的 OBJ\n"
        "o sample_broken\n"
        "v 0 0 0\n"
        "v 1 0 0\n"
        "v 1 1 0\n"
        "v 0 1 0\n"
        "v 0 0 1\n"
        "v 1 0 1\n"
        "v 1 1 1\n"
        "v 0 1 1\n"
        "vt 0 0\n"
        "vt 1 0\n"
        "vt 1 1\n"
        "vt 0 1\n"
        "v 1 not_a_number 0\n"          # 坏顶点：非数字
        "vt 0.5\n"                       # 坏 UV：分量不足
        "f 1/1 2/2 3/3\n"                # 正常三角面（应保留）
        "f 4/4 8/4 5/1\n"                # 正常三角面（应保留）
        "f 99/1 2/2 3/3\n"               # 顶点索引越界（整面跳过）
        "f 1/1 2/2\n"                    # 面顶点不足（跳过）
        "f 1 2 3\n"                      # 无 UV 的面（保留，标记缺 UV）
        "l 1 2\n"                        # 线图元（忽略并提示）
        "f 1/1 2 3/3\n"                  # 部分顶点缺 UV（按缺 UV 处理）
        "f 1/1 2/2 -99/3\n"              # 负索引越界（整面跳过）
    )


def generate_samples(directory: str) -> dict[str, str]:
    """在 directory 下生成全部样例文件，返回 {逻辑名: 绝对路径}。"""
    os.makedirs(directory, exist_ok=True)
    box_path = os.path.join(directory, "sample_box.obj")
    broken_path = os.path.join(directory, "sample_broken.obj")
    tex_path = os.path.join(directory, "sample_texture.png")

    with open(box_path, "w", encoding="utf-8") as fh:
        fh.write(build_box_obj())
    with open(broken_path, "w", encoding="utf-8") as fh:
        fh.write(build_broken_obj())
    write_png(tex_path, 256, 256, checker_texture(256, 256, cells=8))
    return {
        "sample_box.obj": os.path.abspath(box_path),
        "sample_broken.obj": os.path.abspath(broken_path),
        "sample_texture.png": os.path.abspath(tex_path),
    }
