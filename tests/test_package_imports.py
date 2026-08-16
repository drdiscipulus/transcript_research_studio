from __future__ import annotations

import importlib
import unittest


class PackageImportTests(unittest.TestCase):
    def test_sidecar_and_worker_packages_import(self) -> None:
        self.assertIsNotNone(importlib.import_module("backend.sidecar_server"))
        self.assertIsNotNone(importlib.import_module("backend.transcription_worker"))
