from __future__ import annotations

import csv
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from backend.sidecar_server.table_writers import (
    EXCEL_CELL_CHARACTER_LIMIT,
    safe_csv_cell,
    spreadsheet_column_letter,
    write_csv_rows,
    write_multi_sheet_xlsx,
    write_single_sheet_xlsx,
)


class TableWritersTests(unittest.TestCase):
    def test_spreadsheet_column_letters(self) -> None:
        self.assertEqual(spreadsheet_column_letter(0), "A")
        self.assertEqual(spreadsheet_column_letter(25), "Z")
        self.assertEqual(spreadsheet_column_letter(26), "AA")

    def test_csv_writer_preserves_headers_and_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rows.csv"
            write_csv_rows(path, ["name", "count"], [{"name": "Alice", "count": 2}], stringify=str)

            with path.open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))

        self.assertEqual(rows, [{"name": "Alice", "count": "2"}])

    def test_csv_writer_neutralizes_formula_leading_cells(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rows.csv"
            write_csv_rows(
                path,
                ["formula", "spaced", "plain"],
                [{"formula": "=1+1", "spaced": " \t@cmd", "plain": "A-1"}],
                stringify=str,
            )

            with path.open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))

        self.assertEqual(rows[0]["formula"], "'=1+1")
        self.assertEqual(rows[0]["spaced"], "' \t@cmd")
        self.assertEqual(rows[0]["plain"], "A-1")

    def test_safe_csv_cell_covers_formula_prefixes(self) -> None:
        for value in ["=sum(1,1)", "+1", "-1", "@cmd", "\r=1", "\n+1"]:
            self.assertTrue(safe_csv_cell(value).startswith("'"))
        self.assertEqual(safe_csv_cell("text"), "text")

    def test_single_sheet_xlsx_contains_sheet_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "single.xlsx"
            write_single_sheet_xlsx(path, ["text"], [{"text": "Hello"}], sheet_name="Transcripts", title="Export")

            with zipfile.ZipFile(path, "r") as workbook:
                workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")
                worksheet_xml = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
                styles_xml = workbook.read("xl/styles.xml").decode("utf-8")

        self.assertIn('sheet name="Transcripts"', workbook_xml)
        self.assertIn('state="frozen"', worksheet_xml)
        self.assertIn('<autoFilter ref="A1:A2"', worksheet_xml)
        self.assertIn("<cols>", worksheet_xml)
        self.assertIn("<fonts", styles_xml)
        self.assertIn("<fills", styles_xml)

    def test_multi_sheet_xlsx_contains_sheet_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "multi.xlsx"
            write_multi_sheet_xlsx(
                path,
                [
                    ("Summary", ["text"], [{"text": "One"}]),
                    ("Run Info", ["status"], [{"status": "ok"}]),
                ],
                title="Preprocessing",
            )

            with zipfile.ZipFile(path, "r") as workbook:
                workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")

        self.assertIn('sheet name="Summary"', workbook_xml)
        self.assertIn('sheet name="Run Info"', workbook_xml)

    def test_xlsx_sanitizes_xml_invalid_characters(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "safe.xlsx"
            write_single_sheet_xlsx(
                path,
                ["text"],
                [{"text": "before\x00middle\x0bafter\ttab\nline"}],
            )

            with zipfile.ZipFile(path, "r") as workbook:
                worksheet_xml = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")

        ElementTree.fromstring(worksheet_xml)
        self.assertNotIn("\x00", worksheet_xml)
        self.assertNotIn("\x0b", worksheet_xml)
        self.assertIn("beforemiddleafter", worksheet_xml)

    def test_xlsx_splits_oversized_text_and_repeats_metadata(self) -> None:
        long_text = "A" * 40_000
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "long.xlsx"
            write_single_sheet_xlsx(
                path,
                ["file_name", "text"],
                [{"file_name": "interview.wav", "text": long_text}],
            )

            with zipfile.ZipFile(path, "r") as workbook:
                worksheet = ElementTree.fromstring(workbook.read("xl/worksheets/sheet1.xml"))

        namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        rows = worksheet.findall(".//x:row", namespace)
        self.assertEqual(len(rows), 3)
        values = [
            ["".join((node.text or "") for node in cell.findall(".//x:t", namespace)) for cell in row.findall("x:c", namespace)]
            for row in rows[1:]
        ]
        self.assertEqual([row[0] for row in values], ["interview.wav", "interview.wav"])
        self.assertTrue(all(row[1].startswith("[Excel cell split: part ") for row in values))
        self.assertTrue(all(len(row[1]) <= EXCEL_CELL_CHARACTER_LIMIT for row in values))
        reconstructed = "".join(row[1].split("]\n", 1)[1] for row in values)
        self.assertEqual(reconstructed, long_text)


if __name__ == "__main__":
    unittest.main()
