import unittest

from thumb_pack.selftest import run_selftest


class EndToEndSelfTest(unittest.TestCase):
    def test_generated_fixtures_and_pack_contracts(self) -> None:
        self.assertTrue(run_selftest(verbose=False))


if __name__ == "__main__":
    unittest.main()
