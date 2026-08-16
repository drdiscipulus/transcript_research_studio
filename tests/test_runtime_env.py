from __future__ import annotations

import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server import runtime_env


def _runtime_paths() -> dict[str, Path]:
    return {
        "huggingface_home": Path("C:/test-runtime/huggingface"),
        "huggingface_hub_cache": Path("C:/test-runtime/huggingface/hub"),
    }


class RuntimeEnvironmentTests(unittest.TestCase):
    def test_concurrent_callers_wait_for_one_complete_initialization(self) -> None:
        initialization_started = threading.Event()
        release_initialization = threading.Event()
        completed: list[int] = []
        errors: list[BaseException] = []
        ensure_calls = 0

        def ensure_paths() -> dict[str, Path]:
            nonlocal ensure_calls
            ensure_calls += 1
            initialization_started.set()
            release_initialization.wait(timeout=2)
            return _runtime_paths()

        def configure(index: int) -> None:
            try:
                runtime_env.configure_ml_runtime_environment()
                completed.append(index)
            except BaseException as error:  # pragma: no cover - assertion captures thread failures
                errors.append(error)

        with (
            patch.object(runtime_env, "_RUNTIME_ENV_CONFIGURED", False),
            patch.object(runtime_env, "ensure_app_runtime_directories", side_effect=ensure_paths),
            patch.object(
                runtime_env,
                "_runtime_dll_directories",
                return_value=[Path("C:/test-runtime/dlls")],
            ),
            patch.object(runtime_env, "_activate_windows_dll_directory") as activate_dll,
            patch.dict(runtime_env.os.environ, {}, clear=False),
        ):
            workers = [threading.Thread(target=configure, args=(index,)) for index in range(3)]
            for worker in workers:
                worker.start()

            self.assertTrue(initialization_started.wait(timeout=1))
            time.sleep(0.05)
            self.assertEqual(completed, [])

            release_initialization.set()
            for worker in workers:
                worker.join(timeout=2)

            self.assertEqual(errors, [])
            self.assertCountEqual(completed, [0, 1, 2])
            self.assertEqual(ensure_calls, 1)
            activate_dll.assert_called_once_with(Path("C:/test-runtime/dlls"))
            self.assertEqual(runtime_env.os.environ["HF_HOME"], str(_runtime_paths()["huggingface_home"]))
            self.assertEqual(
                runtime_env.os.environ["HF_HUB_CACHE"],
                str(_runtime_paths()["huggingface_hub_cache"]),
            )

            runtime_env.configure_ml_runtime_environment()
            self.assertEqual(ensure_calls, 1)

    def test_failed_initialization_remains_retryable(self) -> None:
        attempts = 0

        def ensure_paths() -> dict[str, Path]:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("synthetic initialization failure")
            return _runtime_paths()

        with (
            patch.object(runtime_env, "_RUNTIME_ENV_CONFIGURED", False),
            patch.object(runtime_env, "ensure_app_runtime_directories", side_effect=ensure_paths),
            patch.object(runtime_env, "_runtime_dll_directories", return_value=[]),
            patch.dict(runtime_env.os.environ, {}, clear=False),
        ):
            with self.assertRaisesRegex(RuntimeError, "synthetic initialization failure"):
                runtime_env.configure_ml_runtime_environment()

            self.assertFalse(runtime_env._RUNTIME_ENV_CONFIGURED)  # noqa: SLF001
            runtime_env.configure_ml_runtime_environment()
            self.assertTrue(runtime_env._RUNTIME_ENV_CONFIGURED)  # noqa: SLF001
            self.assertEqual(attempts, 2)


if __name__ == "__main__":
    unittest.main()
