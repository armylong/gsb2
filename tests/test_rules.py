"""规则求值与边界值测试。"""
import copy
import unittest

from helpers import DqTestCase, BASE_RULES
from dqtool.rules import evaluate_rule, UniqueContext, coerce


class MemUnique(UniqueContext):
    def __init__(self):
        self.seen = {}

    def lookup(self, rule_id, value):
        return self.seen.get((rule_id, value))

    def register(self, rule_id, value, record_key):
        self.seen[(rule_id, value)] = record_key


def ev(rule_spec, record):
    rule = dict(rule_spec)
    rule.setdefault("name", rule["id"])
    rule.setdefault("field", rule.get("field"))
    rule.setdefault("params", {})
    return evaluate_rule(rule, record, "k1", MEM)


MEM = None


class TestCoerce(unittest.TestCase):
    def test_int(self):
        self.assertEqual(coerce("3", "int"), (True, 3))
        self.assertEqual(coerce("3.0", "int"), (True, 3))
        self.assertEqual(coerce(3.5, "int"), (False, None))
        self.assertEqual(coerce("abc", "int"), (False, None))
        self.assertEqual(coerce(True, "int"), (False, None))

    def test_float(self):
        self.assertEqual(coerce("1.5", "float"), (True, 1.5))
        self.assertEqual(coerce("x", "float"), (False, None))

    def test_date(self):
        ok, _ = coerce("2026-11-15", "date")
        self.assertTrue(ok)
        ok, _ = coerce("15/11/2026", "date")
        self.assertFalse(ok)

    def test_bool(self):
        self.assertEqual(coerce("true", "bool"), (True, True))
        self.assertEqual(coerce("0", "bool"), (True, False))


class TestRuleEval(unittest.TestCase):
    def setUp(self):
        global MEM
        MEM = MemUnique()

    def test_required(self):
        r = {"id": "r", "type": "required", "field": "a"}
        self.assertEqual(ev(r, {"a": ""})[0], "fail")
        self.assertEqual(ev(r, {"a": "  "})[0], "fail")
        self.assertEqual(ev(r, {"a": None})[0], "fail")
        self.assertEqual(ev(r, {"a": "x"})[0], "pass")

    def test_type_empty_is_na(self):
        r = {"id": "t", "type": "type", "field": "a", "params": {"dtype": "int"}}
        self.assertEqual(ev(r, {"a": ""})[0], "not_applicable")
        self.assertEqual(ev(r, {})[0], "not_applicable")
        self.assertEqual(ev(r, {"a": "5"})[0], "pass")
        self.assertEqual(ev(r, {"a": "5x"})[0], "fail")

    def test_range_boundaries(self):
        r = {"id": "g", "type": "range", "field": "a", "params": {"min": 0, "max": 100}}
        self.assertEqual(ev(r, {"a": "0"})[0], "pass")       # 边界含端点
        self.assertEqual(ev(r, {"a": "100"})[0], "pass")
        self.assertEqual(ev(r, {"a": "-0.001"})[0], "fail")
        self.assertEqual(ev(r, {"a": "100.001"})[0], "fail")
        self.assertEqual(ev(r, {"a": ""})[0], "not_applicable")
        self.assertEqual(ev(r, {"a": "abc"})[0], "fail")     # 有值但非数值 = 数据错误

    def test_unique(self):
        r = {"id": "u", "type": "unique", "field": "a"}
        self.assertEqual(ev(r, {"a": "x"})[0], "pass")
        status, detail = ev(r, {"a": "x"})
        self.assertEqual(status, "fail")
        self.assertIn("k1", detail)
        self.assertEqual(ev(r, {"a": ""})[0], "not_applicable")

    def test_relation(self):
        r = {"id": "rel", "type": "relation",
             "params": {"left": "s", "op": "<=", "right": "e"}}
        self.assertEqual(ev(r, {"s": "2026-01-01", "e": "2026-01-02"})[0], "pass")
        self.assertEqual(ev(r, {"s": "2026-01-03", "e": "2026-01-02"})[0], "fail")
        self.assertEqual(ev(r, {"s": "", "e": "2026-01-02"})[0], "not_applicable")
        r2 = {"id": "rel2", "type": "relation",
              "params": {"left": "n", "op": "<", "right_value": 10}}
        self.assertEqual(ev(r2, {"n": "9"})[0], "pass")
        self.assertEqual(ev(r2, {"n": "10"})[0], "fail")


class TestRuleVersioning(DqTestCase):
    def test_import_creates_versions_only_on_change(self):
        v1, changed1 = self.import_rules(BASE_RULES)
        self.assertTrue(changed1)
        v2, changed2 = self.import_rules(BASE_RULES)
        self.assertFalse(changed2)
        self.assertEqual(v1, v2)
        modified = copy.deepcopy(BASE_RULES)
        modified[3]["params"]["max"] = 200
        v3, changed3 = self.import_rules(modified)
        self.assertTrue(changed3)
        self.assertEqual(v3, v1 + 1)

    def test_enable_disable_bumps_version(self):
        from dqtool.rules import set_enabled, get_rules
        v1, _ = self.import_rules(BASE_RULES)
        v2, changed = set_enabled(self.conn, "amount_range", False)
        self.assertTrue(changed)
        self.assertEqual(v2, v1 + 1)
        rules = {r["rule_id"]: r for r in get_rules(self.conn)}
        self.assertEqual(rules["amount_range"]["enabled"], 0)
        # 旧版本规则仍然可查（回放依据）
        old = {r["rule_id"]: r for r in get_rules(self.conn, v1)}
        self.assertEqual(old["amount_range"]["enabled"], 1)


if __name__ == "__main__":
    unittest.main()
