"""异常场景: 缺口、重复冲突、修改不存在记录 —— 必须阻塞且不跳过。"""

import json
import os
import unittest

from sync_tool import storage

from tests.helpers import SyncTestCase


class BlockingTests(SyncTestCase):
    def _assert_blocked(self, summary, reason):
        self.assertIsNotNone(summary["blocked"], "预期同步被阻塞")
        detail = summary["blocked"]
        self.assertEqual(detail["reason"], reason)
        # 阻塞信息必须带具体定位
        self.assertIn("file", detail)
        self.assertIn("line", detail)
        return detail

    def test_seq_gap_blocks_and_reports_missing_range(self):
        engine, conn = self.bootstrap("gap")
        summary = engine.sync_once()
        detail = self._assert_blocked(summary, "seq_gap")
        self.assertEqual(detail["missing_from"], detail["seq"] - 1)
        self.assertEqual(detail["missing_to"], detail["seq"] - 1)

        # 阻塞后位置停在缺口前, 后续文件没有被跳过
        status = engine.status()
        self.assertEqual(status["received_seq"], detail["missing_from"] - 1)
        self.assertIsNotNone(status["blocked"])

        # 重新跑仍然阻塞(不会假装成功), 业务表保持上一个已提交状态
        again = engine.sync_once()
        self._assert_blocked(again, "seq_gap")
        customers = {r["id"]: r for r in self.target_rows("customer")}
        self.assertNotIn(6, customers, "缺口之后的 INSERT 不能生效")
        conn.close()

    def test_duplicate_conflict_blocks(self):
        engine, conn = self.bootstrap("dup_conflict")
        summary = engine.sync_once()
        detail = self._assert_blocked(summary, "duplicate_conflict")
        self.assertIn("seq", detail)
        # 冲突文件里的冒名者不能进库
        customers = {r["id"]: r for r in self.target_rows("customer")}
        if 6 in customers:
            self.assertEqual(customers[6]["name"], "孙八")
        conn.close()

    def test_modify_missing_rolls_back_whole_txn(self):
        """同事务里一条合法、一条非法: 整笔失败, 合法的那条也不能生效。"""
        engine, conn = self.bootstrap("missing_row")
        summary = engine.sync_once()
        detail = self._assert_blocked(summary, "modify_missing")
        self.assertEqual(detail["txn_id"], "T011")
        self.assertEqual(detail["table"], "customer")
        self.assertEqual(detail["key"], {"id": 999})

        orders = {r["id"]: r for r in self.target_rows("customer_order")}
        self.assertEqual(
            orders[103]["amount"], 55.0, "同事务的订单 UPDATE 必须一起回滚"
        )
        # 阻塞事务通过 _blocked 明细可见(整文件回滚, 重启后整个文件重来);
        # 业务表无半成品
        status = engine.status()
        self.assertEqual(status["blocked"]["txn_id"], "T011")
        self.assertEqual(status["blocked"]["reason"], "modify_missing")
        conn.close()

    def test_unknown_column_is_rejected(self):
        """事件携带未映射字段: 接收期即阻塞, 定位到文件行。"""
        engine, conn = self.bootstrap("clean")
        changes = os.path.join(self.root, "changes")
        bad_file = os.path.join(changes, "00099.jsonl")
        seq = engine.status()["source"]["source_max_seq"] + 1
        import json
        with open(bad_file, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "seq": seq, "txn_id": "TBAD", "op_order": 1, "kind": "row",
                "table": "customer", "op": "INSERT",
                "payload": {"id": 7, "name": "陌生列", "city": "X", "mystery": 1},
            }, ensure_ascii=False) + "\n")
        summary = engine.sync_once()
        self._assert_blocked(summary, "unknown_column")
        conn.close()

    def test_bad_json_line_blocks_with_location(self):
        engine, conn = self.bootstrap("clean")
        changes = os.path.join(self.root, "changes")
        bad_file = os.path.join(changes, "00098.jsonl")
        with open(bad_file, "w", encoding="utf-8") as fh:
            fh.write("{这不是 json\n")
        summary = engine.sync_once()
        self._assert_blocked(summary, "bad_json")
        conn.close()


if __name__ == "__main__":
    unittest.main()
