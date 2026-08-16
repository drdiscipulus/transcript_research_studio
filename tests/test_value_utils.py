from __future__ import annotations

import unittest

from backend.sidecar_server.value_utils import (
    float_or_default,
    float_or_none,
    format_timestamp_hhmmss,
    format_timestamp_mmss_or_hhmmss,
    parse_timestamp_seconds,
    timestamp_range_label,
)


class ValueUtilsTests(unittest.TestCase):
    def test_float_parsing(self) -> None:
        self.assertIsNone(float_or_none(None))
        self.assertIsNone(float_or_none(""))
        self.assertIsNone(float_or_none("bad"))
        self.assertEqual(float_or_none("1.5"), 1.5)
        self.assertEqual(float_or_none(2), 2.0)

    def test_float_default(self) -> None:
        self.assertEqual(float_or_default(None, 3.0), 3.0)
        self.assertEqual(float_or_default("bad", 3.0), 3.0)
        self.assertEqual(float_or_default("-1", 3.0), 3.0)
        self.assertEqual(float_or_default("0", 3.0), 0.0)
        self.assertEqual(float_or_default("2.5", 3.0), 2.5)
        self.assertEqual(float_or_default("4", 3.0, minimum=5), 3.0)

    def test_timestamp_formatting(self) -> None:
        self.assertEqual(format_timestamp_hhmmss(None), "")
        self.assertEqual(format_timestamp_hhmmss(-4), "00:00:00")
        self.assertEqual(format_timestamp_hhmmss(1.4), "00:00:01")
        self.assertEqual(format_timestamp_hhmmss(3661), "01:01:01")
        self.assertEqual(format_timestamp_mmss_or_hhmmss(1.4), "00:01")
        self.assertEqual(format_timestamp_mmss_or_hhmmss(3661), "01:01:01")

    def test_timestamp_parsing(self) -> None:
        self.assertIsNone(parse_timestamp_seconds(None))
        self.assertIsNone(parse_timestamp_seconds(""))
        self.assertIsNone(parse_timestamp_seconds("bad:value"))
        self.assertEqual(parse_timestamp_seconds("01:05"), 65.0)
        self.assertEqual(parse_timestamp_seconds("01:01:01"), 3661.0)
        self.assertEqual(parse_timestamp_seconds("12.5"), 12.5)

    def test_timestamp_range_label(self) -> None:
        self.assertEqual(timestamp_range_label(1, 2), "00:00:01 - 00:00:02")
        self.assertEqual(timestamp_range_label(1, None), "00:00:01")
        self.assertEqual(timestamp_range_label(None, 2), "00:00:02")
        self.assertEqual(timestamp_range_label(None, None), "")


if __name__ == "__main__":
    unittest.main()
