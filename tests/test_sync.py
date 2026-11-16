"""正常流程: 快照装载、跨文件事务、原子性与幂等。"""

import os
import unittest

from sync_tool import storage
from sync_tool.verify import verify as run_verify

from tests.helpers import SyncTestCase


class CleanSyncTests(SyncTestCase):
    def test_full_sync_and_verify(self):
        engine, conn = self.bootstrap("clean")
        summary = engine.sync_once()
        self.assertIsNone(summary["blocked"])

        status = engine.status()
        self.assertEqual(status["snapshot_seq"], 4)
        self.assertEqual(status["received_seq"], status["source"]["source_max_seq"])
        self.assertEqual(status["received_seq"], status["applied_seq"])
        self.assertEqual(status["pending_txn"], [])
        self.assertIsNone(status["blocked"])

        # clean 场景: 客户3 被 T008 删除, 客户5/6 为后续新增
        # (客户4 只在 overlap 场景的快照里出现)
        customers = {r["id"]: r for r in self.target_rows("customer")}
        self.assertEqual(sorted(customers), [1, 2, 5, 6])
        self.assertEqual(customers[1]["city"], "深圳")
        self.assertEqual(customers[5]["city"], "重庆")

        # 订单: 102 改价, 103 新增并改价
        orders = {r["id"]: r for r in self.target_rows("customer_order")}
        self.assertEqual(sorted(orders), [101, 102, 103])
        self.assertEqual(orders[102]["amount"], 210.0)
        self.assertEqual(orders[102]["status"], "paid")
        self.assertEqual(orders[103]["amount"], 55.0)
        self.assertEqual(orders[103]["_last_txn_id"], "T010")

        result = run_verify(storage.connect_readonly(self.target_db),
                            self.load_config())
        self.assertTrue(result["ok"], result)
        conn.close()

    def test_cross_file_txn_invisible_until_commit(self):
        """跨文件事务: 提交标记到达前, 外部查询看不到任何半成品。"""
        engine, conn = self.bootstrap("clean")
        files = sorted(os.listdir(os.path.join(self.root, "changes")))
        # 00002 只含 T008 的行事件; 00003 才是提交标记
        self.move_change_files(files[2:], "held")
        engine.sync_once()

        status = engine.status()
        pending = {t["txn_id"]: t for t in status["pending_txn"]}
        self.assertIn("T008", pending)
        self.assertEqual(pending["T008"]["event_count"], 2)
        # 已接收但未应用: 两个位置不同, 但业务表保持一致快照
        self.assertGreater(status["received_seq"], status["applied_seq"])

        customers = {r["id"]: r for r in self.target_rows("customer")}
        self.assertIn(3, customers, "DELETE 未提交, 客户3 必须还在")
        orders = {r["id"]: r for r in self.target_rows("customer_order")}
        self.assertEqual(orders[102]["amount"], 200.5, "UPDATE 未提交不能生效")

        # 送达剩余文件后继续, 事务整体生效
        self.bring_back(files[2:], "held")
        summary = engine.sync_once()
        self.assertIsNone(summary["blocked"])
        customers = {r["id"]: r for r in self.target_rows("customer")}
        self.assertNotIn(3, customers)
        orders = {r["id"]: r for r in self.target_rows("customer_order")}
        self.assertEqual(orders[102]["amount"], 210.0)
        conn.close()

    def test_restart_resumes_and_is_idempotent(self):
        """模拟分批送达 + 中途重启: 进度不丢, 重跑不重复不回退。"""
        engine, conn = self.bootstrap("clean")
        files = sorted(os.listdir(os.path.join(self.root, "changes")))
        self.move_change_files(files[3:], "held")
        first = engine.sync_once()
        self.assertIsNone(first["blocked"])
        applied_after_first = self.meta_value(storage.META_APPLIED_SEQ)
        conn.close()

        # 全新进程: 重新打开库, 已处理文件再跑一遍
        engine2, conn2 = self.new_engine()
        rerun = engine2.sync_once()
        self.assertEqual(rerun["files_processed"], 0)
        self.assertEqual(rerun["events_received"], 0)
        self.assertEqual(
            self.meta_value(storage.META_APPLIED_SEQ), applied_after_first
        )
        # 行数没有翻倍
        self.assertEqual(len(self.target_rows("customer")), 3)

        self.bring_back(files[3:], "held")
        rest = engine2.sync_once()
        self.assertIsNone(rest["blocked"])
        result = run_verify(storage.connect_readonly(self.target_db),
                            self.load_config())
        self.assertTrue(result["ok"])
        conn2.close()

    def test_duplicate_same_file_is_ignored(self):
        """内容完全一致的重复文件: 跳过且不影响进度。"""
        engine, conn = self.bootstrap("dup_same")
        summary = engine.sync_once()
        self.assertIsNone(summary["blocked"])
        result = run_verify(storage.connect_readonly(self.target_db),
                            self.load_config())
        self.assertTrue(result["ok"])
        customers = {r["id"]: r for r in self.target_rows("customer")}
        # 孙八只能出现一次
        self.assertEqual([r for r in customers.values() if r["name"] == "孙八"],
                         [customers[6]])
        conn.close()

    def test_snapshot_then_overlap_not_applied_twice(self):
        """已包含在快照里的变化再次送达: 标记 covered, 不能再应用一次。"""
        engine, conn = self.bootstrap("overlap")
        summary = engine.sync_once()
        self.assertIsNone(summary["blocked"], summary)
        customers = {r["id"]: r for r in self.target_rows("customer")}
        self.assertIn(4, customers, "快照里已有的客户4 仍然在")
        self.assertEqual(len(customers), 4, "INSERT 不能重复生效导致报错或重复")
        orders = {r["id"]: r for r in self.target_rows("customer_order")}
        self.assertEqual(orders[101]["amount"], 120.0)
        result = run_verify(storage.connect_readonly(self.target_db),
                            self.load_config())
        self.assertTrue(result["ok"])
        conn.close()

    def test_trace_last_modifying_txn(self):
        engine, conn = self.bootstrap("clean")
        engine.sync_once()
        trace = engine.trace_record("order", [103])
        self.assertTrue(trace["found"])
        self.assertEqual(trace["last_txn_id"], "T010")
        self.assertEqual(trace["last_op_order"], 1)

        trace_missing = engine.trace_record("customer", [999])
        self.assertFalse(trace_missing["found"])

        # 被删除的记录也应查不到, 而不是残留
        trace_deleted = engine.trace_record("customer", [3])
        self.assertFalse(trace_deleted["found"])
        conn.close()


if __name__ == "__main__":
    unittest.main()
