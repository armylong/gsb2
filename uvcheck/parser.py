"""OBJ 三角网格与贴图坐标解析器。

设计目标是**容错**：遇到一条坏数据不丢弃整个文件，而是：
1. 把问题记录到 ``messages``（区分 error / warning，并保留行号）；
2. 跳过该条坏数据，继续解析其余可读取部分。

支持的 OBJ 子集（覆盖绝大多数静态网格导出）：
- ``v x y z``            顶点（w 分量可选，忽略）
- ``vt u v``             贴图坐标（三维 vt 的第三分量忽略）
- ``vn x y z``           法线（保留，前端目前用计算法线）
- ``f a b c ...``        面，支持 ``v``、``v/vt``、``v//vn``、``v/vt/vn`` 四种写法，
                         支持负索引，多边形按扇形三角化，三角形按生成顺序编号
- ``mtllib`` / ``usemtl`` / ``o`` / ``g`` / ``s``：记录但不影响几何
- ``l`` / ``p``          线/点：忽略并提示
- ``#`` 注释、``\\`` 续行

面编号约定：所有面先做扇形三角化，三角形按文件中出现顺序从 0 开始编号
（界面和导出显示为从 1 开始）。导出问题清单中的 face_id 与该编号一致。
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Triangle:
    """一个三角面。顶点/UV 索引均为 0 基。"""

    id: int
    verts: list[int]                      # 长度 3，顶点索引
    uvs: list[int] | None = None          # 长度 3，UV 索引；该面无贴图坐标时为 None
    normals: list[int] | None = None
    source_face: int = 0                  # 来源面（f 语句）的 0 基序号
    material: str | None = None


@dataclass
class ParseResult:
    vertices: list[tuple[float, float, float]] = field(default_factory=list)
    uvs: list[tuple[float, float]] = field(default_factory=list)
    normals: list[tuple[float, float, float]] = field(default_factory=list)
    triangles: list[Triangle] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)
    mtllib: list[str] = field(default_factory=list)
    materials: list[str] = field(default_factory=list)
    source_name: str = ""

    # ---- 统计与状态 -------------------------------------------------
    @property
    def faces_without_uv(self) -> list[int]:
        return [t.id for t in self.triangles if t.uvs is None]

    @property
    def error_count(self) -> int:
        return sum(1 for m in self.messages if m["level"] == "error")

    @property
    def warning_count(self) -> int:
        return sum(1 for m in self.messages if m["level"] == "warning")

    def _message(self, level: str, line_no: int, message: str) -> None:
        self.messages.append({"level": level, "line": line_no, "message": message})

    # ---- 导出给前端的纯数据 -----------------------------------------
    def to_payload(self) -> dict[str, Any]:
        return {
            "source": self.source_name,
            "vertices": [list(v) for v in self.vertices],
            "uvs": [list(u) for u in self.uvs],
            "normals": [list(n) for n in self.normals],
            "triangles": [
                {
                    "id": t.id,
                    "verts": t.verts,
                    "uvs": t.uvs,
                    "normals": t.normals,
                    "source_face": t.source_face,
                    "material": t.material,
                }
                for t in self.triangles
            ],
            "messages": self.messages,
            "stats": {
                "vertex_count": len(self.vertices),
                "uv_count": len(self.uvs),
                "normal_count": len(self.normals),
                "triangle_count": len(self.triangles),
                "faces_without_uv": self.faces_without_uv,
                "error_count": self.error_count,
                "warning_count": self.warning_count,
                "mtllib": self.mtllib,
                "materials": self.materials,
            },
        }


def _parse_floats(parts: list[str]) -> tuple[list[float], bool]:
    """把字符串片段转成 float；遇到非数字/NaN/Inf 时标记失败。"""
    out: list[float] = []
    ok = True
    for p in parts:
        try:
            val = float(p)
        except (ValueError, TypeError):
            ok = False
            return out, False
        if not math.isfinite(val):
            ok = False
            return out, False
        out.append(val)
    return out, ok


def _resolve_index(raw: str, count: int) -> int:
    """把 OBJ 索引（可能为负）解析为 0 基正索引；越界时抛 IndexError。"""
    idx = int(raw)
    if idx > 0:
        resolved = idx - 1
    elif idx < 0:
        resolved = count + idx
    else:
        raise ValueError("索引不能为 0")
    if resolved < 0 or resolved >= count:
        raise IndexError(f"索引 {idx} 超出当前元素数量 {count}")
    return resolved


def _parse_vertex_spec(spec: str) -> tuple[int | None, int | None, int | None]:
    """解析单个顶点描述 v、v/vt、v//vn、v/vt/vn。"""
    parts = spec.split("/")
    if len(parts) > 3 or any(p == "" for p in parts[:1]):
        raise ValueError(f"无法识别的顶点描述 {spec!r}")
    vi = int(parts[0]) if parts[0] else None
    ti = int(parts[1]) if len(parts) >= 2 and parts[1] != "" else None
    ni = int(parts[2]) if len(parts) == 3 and parts[2] != "" else None
    if vi is None:
        raise ValueError(f"顶点描述 {spec!r} 缺少顶点索引")
    return vi, ti, ni


def parse_obj(text: str, source_name: str = "") -> ParseResult:
    """解析 OBJ 文本，返回 :class:`ParseResult`。永不抛解析类异常。"""
    result = ParseResult(source_name=source_name or "")

    # 处理反斜杠续行：先把物理行合并成逻辑行，同时保留起始行号。
    logical: list[tuple[int, str]] = []
    buf = ""
    start_line = 1
    for physical_no, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not buf:
            start_line = physical_no
        if line.endswith("\\"):
            buf += line[:-1] + " "
            continue
        buf += line
        logical.append((start_line, buf))
        buf = ""
    if buf:
        logical.append((start_line, buf))

    current_material: str | None = None
    face_seq = 0

    for line_no, line in logical:
        if not line or line.startswith("#"):
            continue
        tokens = line.split()
        keyword = tokens[0]
        args = tokens[1:]

        if keyword == "v":
            vals, ok = _parse_floats(args)
            if not ok or len(vals) < 3:
                result._message("error", line_no, f"顶点 'v' 需要 3 个有效数字，实际为: {line!r}")
                continue
            result.vertices.append((vals[0], vals[1], vals[2]))

        elif keyword == "vt":
            vals, ok = _parse_floats(args)
            if not ok or len(vals) < 2:
                result._message("error", line_no, f"贴图坐标 'vt' 需要 2 个有效数字，实际为: {line!r}")
                continue
            result.uvs.append((vals[0], vals[1]))

        elif keyword == "vn":
            vals, ok = _parse_floats(args)
            if not ok or len(vals) < 3:
                result._message("error", line_no, f"法线 'vn' 需要 3 个有效数字，实际为: {line!r}")
                continue
            result.normals.append((vals[0], vals[1], vals[2]))

        elif keyword == "f":
            if len(args) < 3:
                result._message("error", line_no, f"面 'f' 至少需要 3 个顶点，实际 {len(args)} 个，已跳过")
                face_seq += 1
                continue
            face_verts: list[int] = []
            face_uvs: list[int] | None = []
            face_normals: list[int] | None = []
            face_bad = False
            saw_uv = False
            for spec in args:
                try:
                    vi, ti, ni = _parse_vertex_spec(spec)
                    v_resolved = _resolve_index(str(vi), len(result.vertices))
                    face_verts.append(v_resolved)
                    if ti is not None:
                        face_uvs.append(_resolve_index(str(ti), len(result.uvs)))  # type: ignore[union-attr]
                        saw_uv = True
                    else:
                        face_uvs.append(-1)  # type: ignore[union-attr]
                    if ni is not None:
                        face_normals.append(_resolve_index(str(ni), len(result.normals)))  # type: ignore[union-attr]
                    else:
                        face_normals.append(-1)  # type: ignore[union-attr]
                except (ValueError, IndexError) as exc:
                    result._message("error", line_no, f"面顶点描述 {spec!r} 无效（{exc}），整个面已跳过")
                    face_bad = True
                    break
            face_seq += 1
            if face_bad:
                continue

            # 面里一个 vt 都没有 -> 该面缺贴图坐标（仍保留几何，供三维查看）
            if not saw_uv:
                face_uvs = None
                result._message(
                    "warning", line_no,
                    f"第 {face_seq} 个面（{len(args)} 顶点）没有贴图坐标，三角化后标记为缺 UV",
                )
            else:
                if any(u == -1 for u in face_uvs):
                    result._message(
                        "error", line_no,
                        f"第 {face_seq} 个面只有部分顶点带贴图坐标，该面 UV 无法配对，按缺 UV 处理",
                    )
                    face_uvs = None
            if face_normals is not None and all(n == -1 for n in face_normals):
                face_normals = None

            # 扇形三角化
            for k in range(1, len(face_verts) - 1):
                tri = Triangle(
                    id=len(result.triangles),
                    verts=[face_verts[0], face_verts[k], face_verts[k + 1]],
                    uvs=([face_uvs[0], face_uvs[k], face_uvs[k + 1]] if face_uvs is not None else None),
                    normals=([face_normals[0], face_normals[k], face_normals[k + 1]]
                             if face_normals is not None else None),
                    source_face=face_seq - 1,
                    material=current_material,
                )
                result.triangles.append(tri)

        elif keyword == "mtllib":
            names = args[:]
            result.mtllib.extend(names)
            result._message("warning", line_no, f"引用材质库 {' '.join(names)}，本工具不解析 .mtl，贴图需手动指定")

        elif keyword == "usemtl":
            current_material = args[0] if args else None
            if current_material and current_material not in result.materials:
                result.materials.append(current_material)

        elif keyword in ("o", "g"):
            pass  # 名称记录对检查无影响
        elif keyword == "s":
            pass
        elif keyword in ("l", "p"):
            result._message("warning", line_no, f"忽略 {keyword} 图元（本工具只检查三角面）")
        else:
            result._message("warning", line_no, f"忽略未识别的关键字 {keyword!r}")

    # ---- 文件级汇总问题 ---------------------------------------------
    if not result.vertices:
        result._message("error", 0, "文件中没有任何有效顶点 (v)，无法构建三维模型")
    if not result.triangles:
        result._message("error", 0, "文件中没有任何有效三角面 (f)")
    if result.vertices and not result.uvs:
        result._message("warning", 0, "文件中没有任何贴图坐标 (vt)，全部面都无法做 UV 检查")

    return result


def parse_obj_file(path: str) -> ParseResult:
    """从磁盘读取并解析 OBJ。读取/编码问题也转成 messages，不向上抛。"""
    name = os.path.basename(path)
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        result = ParseResult(source_name=name)
        result._message("error", 0, f"无法读取文件 {path}: {exc}")
        return result
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
        result_hint = parse_obj(text, source_name=name)
        result_hint._message("warning", 0, "文件不是 UTF-8 编码，已按 Latin-1 解码，对象名可能显示异常")
        return result_hint
    return parse_obj(text, source_name=name)
