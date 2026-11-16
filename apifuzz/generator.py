"""模糊输入生成器。

按确定性规则从正常请求样本派生测试输入，覆盖：

- missing    字段缺失（逐层叶子字段）
- type       类型变化（标量/容器互换、null 等）
- boundary   边界长度与极值（空串、超长串、数值极值）
- nested     嵌套结构（深层嵌套、dict/list 互换、嵌套数组）
- unknown    未声明字段（含 is_admin 之类越权嫌疑字段）
- constraint 字段间约束（按接口配置的 all_or_none / equals_field /
             value_dependency 破坏约束）
- malformed  畸形 JSON 报文

随机源按 ``(seed, endpoint)`` 独立播种，同一配置同一 seed 下生成结果
逐字节稳定，可重复实验。
"""
from __future__ import annotations

import copy
import json
import random
from typing import Any, Dict, Iterator, List, Tuple

from .config import Endpoint
from .models import Case

DEEP_NEST_LEVELS = 20
LONG_LENGTHS = (0, 1, 32, 256, 4096, 8193)
NUMBER_EDGES = (0, -1, 2 ** 31, 2 ** 32, 2 ** 53, -(2 ** 53), 1e308)
SUSPICIOUS_EXTRA_FIELDS = ("is_admin", "role", "owner_id", "__proto__", "constructor")


# ---------- JSON 路径工具（点分路径，生成阶段只处理 dict） ----------

def _walk_paths(obj: Any, prefix: str = "$") -> Iterator[Tuple[str, Any]]:
    yield prefix, obj
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield from _walk_paths(value, f"{prefix}.{key}")


def _leaf_paths(sample: Dict[str, Any]) -> List[Tuple[str, Any]]:
    return [(p, v) for p, v in _walk_paths(sample) if not isinstance(v, (dict, list))]


def _container_paths(sample: Dict[str, Any]) -> List[Tuple[str, Any]]:
    return [(p, v) for p, v in _walk_paths(sample) if isinstance(v, (dict, list)) and p != "$"]


def _set_path(obj: Dict[str, Any], path: str, value: Any) -> Dict[str, Any]:
    keys = path.split(".")[1:]
    cur = obj
    for key in keys[:-1]:
        cur = cur[key]
    cur[keys[-1]] = value
    return obj


def _delete_path(obj: Dict[str, Any], path: str) -> Dict[str, Any]:
    keys = path.split(".")[1:]
    cur = obj
    for key in keys[:-1]:
        cur = cur[key]
    cur.pop(keys[-1], None)
    return obj


def _deep_nested(levels: int = DEEP_NEST_LEVELS) -> Dict[str, Any]:
    node: Any = "x"
    for _ in range(levels):
        node = {"nested": node}
    return node


def _type_alternatives(value: Any, rng: random.Random) -> List[Any]:
    if isinstance(value, bool):
        return ["true", 0, None, {}, []]
    if isinstance(value, int):
        alts = ["x", None, True, [], {}, 1.5]
        rng.shuffle(alts)
        return alts
    if isinstance(value, float):
        return ["x", None, True, [], {}, 999]
    if isinstance(value, str):
        return [0, True, None, [], {}, ["a", "b"]]
    if isinstance(value, list):
        return ["x", {}, None, [[]], [[[]]]]
    if value is None:
        return ["x", 0, {}, []]
    return ["x", 0, None, []]


# ---------- 各规则的生成逻辑 ----------

def _gen_missing(ep: Endpoint) -> Iterator[Case]:
    for idx, (path, _) in enumerate(_leaf_paths(ep.sample)):
        body = _delete_path(copy.deepcopy(ep.sample), path)
        yield Case(f"{ep.name}-missing-{idx:03d}", ep.name, "missing", path, body)


def _gen_type(ep: Endpoint, rng: random.Random) -> Iterator[Case]:
    idx = 0
    for path, value in _leaf_paths(ep.sample):
        for alt in _type_alternatives(value, rng):
            body = _set_path(copy.deepcopy(ep.sample), path, alt)
            yield Case(f"{ep.name}-type-{idx:03d}", ep.name, "type", path, body)
            idx += 1
    # 容器字段整体换成错误类型
    for path, value in _container_paths(ep.sample):
        for alt in ("scalar", None) if isinstance(value, dict) else ("scalar", None, {}):
            replaced = "x" if alt == "scalar" else alt
            body = _set_path(copy.deepcopy(ep.sample), path, replaced)
            yield Case(f"{ep.name}-type-{idx:03d}", ep.name, "type", path, body)
            idx += 1


def _gen_boundary(ep: Endpoint, rng: random.Random) -> Iterator[Case]:
    idx = 0
    for path, value in _leaf_paths(ep.sample):
        if isinstance(value, str):
            for length in LONG_LENGTHS:
                body = _set_path(copy.deepcopy(ep.sample), path, "A" * length)
                yield Case(f"{ep.name}-boundary-{idx:03d}", ep.name,
                           "boundary", path, body)
                idx += 1
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            for edge in NUMBER_EDGES:
                body = _set_path(copy.deepcopy(ep.sample), path, edge)
                yield Case(f"{ep.name}-boundary-{idx:03d}", ep.name,
                           "boundary", path, body)
                idx += 1
    # 在根上注入一个超长未知字段，探测整体长度限制
    body = copy.deepcopy(ep.sample)
    body["_fuzz_long"] = "B" * 65536
    yield Case(f"{ep.name}-boundary-{idx:03d}", ep.name, "boundary",
               "$._fuzz_long", body)


def _gen_nested(ep: Endpoint) -> Iterator[Case]:
    idx = 0
    deep = _deep_nested()
    for path, value in _container_paths(ep.sample):
        if isinstance(value, dict):
            for candidate in (deep, ["x", "y"], "scalar"):
                body = _set_path(copy.deepcopy(ep.sample), path,
                                 candidate if candidate != "scalar" else "x")
                yield Case(f"{ep.name}-nested-{idx:03d}", ep.name,
                           "nested", path, body)
                idx += 1
        else:  # list
            for candidate in (deep, [deep], [[["deep"]]], "x"):
                body = _set_path(copy.deepcopy(ep.sample), path, candidate)
                yield Case(f"{ep.name}-nested-{idx:03d}", ep.name,
                           "nested", path, body)
                idx += 1
    # 根节点本身被深层结构包裹
    body = {"_fuzz_wrap": copy.deepcopy(ep.sample), "deep": deep}
    yield Case(f"{ep.name}-nested-{idx:03d}", ep.name, "nested", "$", body)


def _gen_unknown(ep: Endpoint, rng: random.Random) -> Iterator[Case]:
    idx = 0
    for extra in SUSPICIOUS_EXTRA_FIELDS:
        body = copy.deepcopy(ep.sample)
        body[extra] = rng.choice([True, 1, "admin", {"elevated": True}])
        yield Case(f"{ep.name}-unknown-{idx:03d}", ep.name, "unknown",
                   f"$.{extra}", body)
        idx += 1
    for path, value in _container_paths(ep.sample):
        if isinstance(value, dict):
            body = _set_path(copy.deepcopy(ep.sample), path,
                             {**copy.deepcopy(value), "_fuzz_unknown": True})
            yield Case(f"{ep.name}-unknown-{idx:03d}", ep.name,
                       "unknown", f"{path}._fuzz_unknown", body)
            idx += 1


def _gen_constraint(ep: Endpoint) -> Iterator[Case]:
    idx = 0
    for con in ep.constraints:
        ctype = con["type"]
        if ctype == "all_or_none":
            for field_name in con["fields"]:
                path = f"$.{field_name}"
                body = _delete_path(copy.deepcopy(ep.sample), path)
                yield Case(f"{ep.name}-constraint-{idx:03d}", ep.name,
                           "constraint", path, body,
                           expectations={"constraint": "all_or_none",
                                         "fields": con["fields"]})
                idx += 1
        elif ctype == "equals_field":
            field_name, target = con["field"], con["equals"]
            path = f"$.{field_name}"
            body = _set_path(copy.deepcopy(ep.sample), path,
                             "__fuzz_mismatch__")
            yield Case(f"{ep.name}-constraint-{idx:03d}", ep.name,
                       "constraint", path, body,
                       expectations={"constraint": "equals_field",
                                     "equals": target})
            idx += 1
        else:  # value_dependency
            field_name = con["field"]
            when, require = con["when"], con["require"]
            # 情形一：满足 when 却删掉 require 字段
            body = copy.deepcopy(ep.sample)
            if isinstance(require, str):
                body = _delete_path(body, f"$.{require}")
            else:
                for req in require:
                    body = _delete_path(body, f"$.{req}")
            yield Case(f"{ep.name}-constraint-{idx:03d}", ep.name,
                       "constraint",
                       f"$.{require if isinstance(require, str) else require[0]}",
                       body, expectations={"constraint": "value_dependency",
                                           "when": when})
            idx += 1
            # 情形二：不满足 when 却带上 require 字段
            body = copy.deepcopy(ep.sample)
            if isinstance(when.get("value"), (list, tuple)):
                body[field_name] = "__fuzz_not_when__"
            else:
                body[field_name] = "__fuzz_not_when__"
            if isinstance(require, str):
                body.setdefault(require, "__fuzz_extra__")
            else:
                for req in require:
                    body.setdefault(req, "__fuzz_extra__")
            yield Case(f"{ep.name}-constraint-{idx:03d}", ep.name,
                       "constraint", f"$.{field_name}", body,
                       expectations={"constraint": "value_dependency"})
            idx += 1


def _gen_malformed(ep: Endpoint) -> Iterator[Case]:
    valid = json.dumps(ep.sample, ensure_ascii=False)
    variants = (
        valid[: max(1, len(valid) // 2)],                 # 截断
        valid + "}",                                      # 多余括号
        valid.replace(":", ":", 1).rstrip("}") + ",}",    # 尾随逗号
        "{not json at all",                               # 完全非法
    )
    for idx, raw in enumerate(variants):
        yield Case(f"{ep.name}-malformed-{idx:03d}", ep.name, "malformed",
                   "$", raw, raw_body=True)


_RULE_FUNCS = {
    "missing": lambda ep, rng: _gen_missing(ep),
    "type": lambda ep, rng: _gen_type(ep, rng),
    "boundary": lambda ep, rng: _gen_boundary(ep, rng),
    "nested": lambda ep, rng: _gen_nested(ep),
    "unknown": lambda ep, rng: _gen_unknown(ep, rng),
    "constraint": lambda ep, rng: _gen_constraint(ep),
    "malformed": lambda ep, rng: _gen_malformed(ep),
}


def generate_cases(ep: Endpoint, seed: int) -> List[Case]:
    """为一个 endpoint 生成全部用例（含一条正常基线用例）。"""
    rng = random.Random(f"{seed}:{ep.name}")
    cases = [
        Case(f"{ep.name}-baseline-000", ep.name, "baseline", "$",
             copy.deepcopy(ep.sample))
    ]
    for rule in ep.rules:
        cases.extend(_RULE_FUNCS[rule](ep, rng))
    return cases
