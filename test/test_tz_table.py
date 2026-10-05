#!/usr/bin/env python3
"""tz-transitions.json must match the system tz database it was built from."""

import subprocess
import sys
from pathlib import Path
import unittest


PLUGIN = Path(__file__).parents[1]


class TzTableTests(unittest.TestCase):
    def test_committed_table_is_current(self):
        try:
            import zoneinfo
            zoneinfo.ZoneInfo("America/New_York")
        except Exception:
            self.skipTest("no tz database on this machine")
        result = subprocess.run([sys.executable, str(PLUGIN / "scripts" / "build-tz-transitions.py"), "--check"],
                                capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
