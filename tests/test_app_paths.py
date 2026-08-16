from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server import app_paths


class AppPathsTests(unittest.TestCase):
    def tearDown(self) -> None:
        app_paths.app_data_root.cache_clear()

    def test_windows_data_and_analysis_paths_use_the_release_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            local_app_data = Path(directory) / "LocalAppData"
            expected_root = local_app_data / "Transcript Research Studio"
            resolved_root = app_paths._resolve_app_data_root(
                {
                    "LOCALAPPDATA": str(local_app_data),
                    app_paths.PORTABLE_ROOT_ENV: "",
                    app_paths.PORTABLE_MODE_ENV: "",
                    "_".join(["AI", "TRANSCRIPTION", "PORTABLE_ROOT"]): str(Path(directory) / "old-portable-root"),
                    "_".join(["AI", "TRANSCRIPTION", "PORTABLE"]): "1",
                },
                os_name="nt",
                platform_name="win32",
                home_directory=Path(directory) / "home",
            )

            self.assertEqual(resolved_root, expected_root)

    def test_data_root_helper_preserves_platform_defaults(self) -> None:
        home = Path("/synthetic/home")

        self.assertEqual(
            app_paths._resolve_app_data_root(
                {},
                os_name="nt",
                platform_name="win32",
                home_directory=home,
            ),
            home / "Transcript Research Studio",
        )
        self.assertEqual(
            app_paths._resolve_app_data_root(
                {},
                os_name="posix",
                platform_name="darwin",
                home_directory=home,
            ),
            home / "Library" / "Application Support" / "Transcript Research Studio",
        )
        self.assertEqual(
            app_paths._resolve_app_data_root(
                {},
                os_name="posix",
                platform_name="linux",
                home_directory=home,
            ),
            home / ".local" / "share" / "Transcript Research Studio",
        )

    def test_portable_root_and_marker_environment_are_authoritative(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "portable"
            with patch.dict(
                os.environ,
                {
                    app_paths.PORTABLE_ROOT_ENV: str(root),
                    app_paths.PORTABLE_MODE_ENV: "1",
                },
                clear=False,
            ):
                app_paths.app_data_root.cache_clear()
                self.assertEqual(app_paths.app_data_root(), root)
                self.assertEqual(
                    app_paths.default_prompt_output_folder(),
                    root / "Transcript Analysis Exports",
                )
                self.assertTrue(app_paths.is_portable_mode())
                self.assertEqual(app_paths.PORTABLE_ROOT_ENV, "TRANSCRIPT_RESEARCH_STUDIO_PORTABLE_ROOT")
                self.assertEqual(app_paths.PORTABLE_MODE_ENV, "TRANSCRIPT_RESEARCH_STUDIO_PORTABLE")


if __name__ == "__main__":
    unittest.main()
