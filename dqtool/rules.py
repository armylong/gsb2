"""规则定义、版本管理与求值。

规则类型：type / required / range / unique / relation。
每条规则有版本与启停状态；任何变更都会生成新的规则集版本，
每次运行记录所使用的规则集版本，保证可回放。
"""
import hashlib
import json
from datetime import datetime

from .db import now_iso

RULE_TYPES = ("type", "required", "range", "unique", "relation")
DATE_FORMATS = ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d")
RELATION_OPS = ("==", "!=", "<", "<=", ">", ">=")


class RuleError(ValueError):
    pass


def is_empty(v):
    return v is None or (isinstance(v, str) and v.strip() == "")


def coerce(value, dtype):
    """把输入值按目标类型转换，返回 (ok, coerced)。空值由调用方先处理。"""
    if dtype == "string":
        return True, str(value)
    if dtype == "bool":
        if isinstance(value, bool):
            return True, value
        s = str(value).strip().lower()
        if s in ("true", "1", "yes"):
            return True, True
        if s in ("false", "0", "no"):
            return True, False
        return False, None
    if isinstance(value, bool):  # bool 是 int 子类，单独挡掉
        return False, None
    if dtype == "int":
        if isinstance(value, int):
            return True, value
        if isinstance(value, float):
            return (value.is_integer(), int(value) if value.is_integer() else None)
        s = str(value).strip()
        try:
            return True, int(s)
        except ValueError:
            try:
                f = float(s)
            except ValueError:
                return False, None
            return (f.is_integer(), int(f) if f.is_integer() else None)
    if dtype == "float":
        if isinstance(value, (int, float)):
            return True, float(value)
        try:
            return True, float(str(value).strip())
        except ValueError:
            return False, None
    if dtype == "date":
        if isinstance(value, (int, float)):
            return False, None
        s = str(value).strip()
        for fmt in DATE_FORMATS:
            try:
                return True, datetime.strptime(s, fmt)
            except ValueError:
                continue
        return False, None
    raise RuleError(f"unknown dtype: {dtype}")


def validate_rule(spec):
    rid = spec.get("id")
    rtype = spec.get("type")
    if not rid:
        raise RuleError("rule missing 'id'")
    if rtype not in RULE_TYPES:
        raise RuleError(f"rule {rid}: unknown type {rtype!r}")
    params = spec.get("params") or {}
    field = spec.get("field")
    if rtype in ("type", "required", "range", "unique") and not field:
        raise RuleError(f"rule {rid}: type {rtype} requires 'field'")
    if rtype == "type" and params.get("dtype") not in ("int", "float", "string", "bool", "date"):
        raise RuleError(f"rule {rid}: params.dtype must be int/float/string/bool/date")
    if rtype == "range" and "min" not in params and "max" not in params:
        raise RuleError(f"rule {rid}: range requires min and/or max")
    if rtype == "relation":
        if not params.get("left"):
            raise RuleError(f"rule {rid}: relation requires params.left")
        if params.get("op") not in RELATION_OPS:
            raise RuleError(f"rule {rid}: relation op must be one of {RELATION_OPS}")
        if "right" not in params and "right_value" not in params:
            raise RuleError(f"rule {rid}: relation requires params.right or params.right_value")
    return {
        "id": str(rid),
        "name": spec.get("name") or str(rid),
        "type": rtype,
        "field": field,
        "params": params,
        "enabled": bool(spec.get("enabled", True)),
    }


def rule_content_hash(rule):
    canon = json.dumps(
        {"name": rule["name"], "type": rule["type"], "field": rule["field"],
         "params": rule["params"], "enabled": rule["enabled"]},
        sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


# ---------- 版本管理 ----------

def current_version(conn):
    row = conn.execute("SELECT MAX(version) AS v FROM rule_versions").fetchone()
    return row["v"] or 0


def get_rules(conn, version=None, enabled_only=False):
    version = version if version is not None else current_version(conn)
    sql = "SELECT * FROM rules WHERE version = ?"
    if enabled_only:
        sql += " AND enabled = 1"
    rows = conn.execute(sql + " ORDER BY rule_id", (version,)).fetchall()
    return [dict(r) for r in rows]


def import_rules(conn, specs, note=""):
    """导入一组规则定义。内容有变化则生成新版本快照；无变化返回现版本。"""
    rules = [validate_rule(s) for s in specs]
    ids = [r["id"] for r in rules]
    if len(ids) != len(set(ids)):
        raise RuleError("duplicate rule id in import")
    old = {r["rule_id"]: r for r in get_rules(conn)}
    changed = set(ids) != set(old)
    if not changed:
        for r in rules:
            o = old[r["id"]]
            if (rule_content_hash(r) != o["content_hash"]):
                changed = True
                break
    if not changed:
        return current_version(conn), False
    version = current_version(conn) + 1
    conn.execute("INSERT INTO rule_versions (version, created_at, note) VALUES (?,?,?)",
                 (version, now_iso(), note))
    for r in rules:
        conn.execute(
            "INSERT INTO rules (rule_id, version, name, rule_type, field, params, enabled, content_hash)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (r["id"], version, r["name"], r["type"], r["field"],
             json.dumps(r["params"], ensure_ascii=False, sort_keys=True),
             1 if r["enabled"] else 0, rule_content_hash(r)))
    conn.commit()
    return version, True


def set_enabled(conn, rule_id, enabled):
    """启停规则，生成新版本。"""
    rules = get_rules(conn)
    if rule_id not in {r["rule_id"] for r in rules}:
        raise RuleError(f"no such rule: {rule_id}")
    specs = []
    for r in rules:
        specs.append({
            "id": r["rule_id"], "name": r["name"], "type": r["rule_type"],
            "field": r["field"], "params": json.loads(r["params"]),
            "enabled": (enabled if r["rule_id"] == rule_id else bool(r["enabled"])),
        })
    return import_rules(conn, specs, note=f"{'enable' if enabled else 'disable'} {rule_id}")


# ---------- 求值 ----------

class UniqueContext:
    """唯一性规则的跨记录状态接口，由 runner 用 unique_seen 表实现。"""

    def lookup(self, rule_id, value):
        raise NotImplementedError

    def register(self, rule_id, value, record_key):
        raise NotImplementedError


def evaluate_rule(rule, record, record_key, unique_ctx):
    """返回 (status, detail)。status ∈ pass|fail|not_applicable。
    记录损坏（corrupt）与未检查（unchecked）不在此处产生。"""
    rid = rule.get("rule_id") or rule.get("id")
    rtype = rule.get("rule_type") or rule.get("type")
    field = rule["field"]
    params = json.loads(rule["params"]) if isinstance(rule["params"], str) else rule["params"]
    value = record.get(field) if field else None

    if rtype == "required":
        if is_empty(value):
            return "fail", f"required field '{field}' is empty"
        return "pass", ""

    if rtype == "type":
        if is_empty(value):
            return "not_applicable", f"field '{field}' is empty"
        ok, _ = coerce(value, params["dtype"])
        if not ok:
            return "fail", f"value {value!r} is not {params['dtype']}"
        return "pass", ""

    if rtype == "range":
        if is_empty(value):
            return "not_applicable", f"field '{field}' is empty"
        ok, num = coerce(value, "float")
        if not ok:
            return "fail", f"value {value!r} is not numeric"
        lo, hi = params.get("min"), params.get("max")
        if lo is not None and num < lo:
            return "fail", f"{num} < min {lo}"
        if hi is not None and num > hi:
            return "fail", f"{num} > max {hi}"
        return "pass", ""

    if rtype == "unique":
        if is_empty(value):
            return "not_applicable", f"field '{field}' is empty"
        key = str(value)
        first = unique_ctx.lookup(rid, key)
        if first is not None:
            return "fail", f"duplicate of record {first}"
        unique_ctx.register(rid, key, record_key)
        return "pass", ""

    if rtype == "relation":
        left_v = record.get(params["left"])
        if is_empty(left_v):
            return "not_applicable", f"left field '{params['left']}' is empty"
        if "right" in params:
            right_v = record.get(params["right"])
            if is_empty(right_v):
                return "not_applicable", f"right field '{params['right']}' is empty"
        else:
            right_v = params["right_value"]
        lok, lnum = coerce(left_v, "float")
        rok, rnum = coerce(right_v, "float")
        if lok and rok:
            a, b = lnum, rnum
        else:  # 非数值按字符串比较（ISO 日期字符串可直接比较）
            a, b = str(left_v), str(right_v)
        op = params["op"]
        ok = {"==": a == b, "!=": a != b, "<": a < b, "<=": a <= b,
              ">": a > b, ">=": a >= b}[op]
        if not ok:
            return "fail", f"{params['left']}({left_v!r}) not {op} {right_v!r}"
        return "pass", ""

    raise RuleError(f"unknown rule type: {rtype}")
