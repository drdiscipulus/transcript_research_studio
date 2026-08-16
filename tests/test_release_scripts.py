from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
LOADER_INJECTION_VARIABLES = (
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
)


def _safe_node_launcher_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in LOADER_INJECTION_VARIABLES:
        environment.pop(name, None)
    return environment


@unittest.skipUnless(NODE, "Node.js is required for release orchestration tests")
class ReleaseOrchestrationTests(unittest.TestCase):
    def test_safe_node_launcher_environment_excludes_loader_injection_variables(self) -> None:
        environment = _safe_node_launcher_environment()

        for name in LOADER_INJECTION_VARIABLES:
            self.assertNotIn(name, environment)

    def _run_node(
        self,
        script_name: str,
        *arguments: str,
        qualification_build: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        if qualification_build:
            environment["TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD"] = "1"
        else:
            environment.pop("TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD", None)
        return subprocess.run(
            [str(NODE), str(REPO_ROOT / "scripts" / script_name), *arguments],
            cwd=REPO_ROOT,
            env=environment,
            capture_output=True,
            check=False,
            encoding="utf-8",
        )

    def test_final_entrypoints_use_identity_checked_orchestrator(self) -> None:
        package_json = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))

        self.assertEqual(
            package_json["scripts"]["release:final"],
            "node scripts/run_final_release.mjs release:build",
        )
        self.assertEqual(
            package_json["scripts"]["release:macos:final"],
            "node scripts/run_final_release.mjs release:macos",
        )
        self.assertEqual(
            package_json["scripts"]["release:macos"],
            "node scripts/build_macos_release.mjs",
        )

    def test_identity_verification_rejects_inherited_qualification_mode(self) -> None:
        result = self._run_node(
            "verify_release_identity.mjs",
            qualification_build=True,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refuses TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD=1", result.stderr)

    def test_final_orchestrator_rejects_inherited_qualification_mode(self) -> None:
        result = self._run_node(
            "run_final_release.mjs",
            "release:build",
            qualification_build=True,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refuse TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD=1", result.stderr)

    def test_final_orchestrator_rejects_unknown_target_without_building(self) -> None:
        result = self._run_node("run_final_release.mjs", "release:unknown")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported final release target", result.stderr)

    def test_macos_bundle_path_validation(self) -> None:
        result = subprocess.run(
            [str(NODE), "--test", str(REPO_ROOT / "tests" / "release_bundle_paths.test.mjs")],
            cwd=REPO_ROOT,
            capture_output=True,
            check=False,
            encoding="utf-8",
        )

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_release_verification_boundaries(self) -> None:
        result = subprocess.run(
            [str(NODE), "--test", str(REPO_ROOT / "tests" / "release_verification.test.mjs")],
            cwd=REPO_ROOT,
            capture_output=True,
            check=False,
            encoding="utf-8",
        )

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_runtime_probe_environment_does_not_inherit_build_machine_injection(self) -> None:
        runtime_root = REPO_ROOT / "synthetic runtime"
        isolation_root = REPO_ROOT / "synthetic isolation"
        verifier_url = (REPO_ROOT / "scripts" / "verify_release_artifacts.mjs").as_uri()
        poison = str(REPO_ROOT / "must-not-be-inherited")
        inherited_environment = {
            name: poison
            for name in (
                "PATH",
                "HOME",
                "VIRTUAL_ENV",
                "CONDA_PREFIX",
                "CONDA_DEFAULT_ENV",
                "_CE_CONDA",
                "PYTHONUSERBASE",
                "PYTHONSTARTUP",
                "PYTHONPATH",
                "PYTHONHOME",
                *LOADER_INJECTION_VARIABLES,
                "TRANSCRIPT_RESEARCH_STUDIO_HOST_POISON",
            )
        }
        if os.name == "nt":
            inherited_environment["SystemRoot"] = r"C:\Windows"
        source = (
            f'import {{ sanitizedRuntimeEnvironment }} from {json.dumps(verifier_url)}; '
            f'const environment = sanitizedRuntimeEnvironment('
            f'{json.dumps(str(runtime_root))}, {json.dumps(str(isolation_root))}, '
            '{ TRANSCRIPT_RESEARCH_STUDIO_BACKEND_PORT: "8765" }, '
            f'{json.dumps(inherited_environment)}); '
            'console.log(JSON.stringify(environment));'
        )

        result = subprocess.run(
            [str(NODE), "--input-type=module", "-e", source],
            cwd=REPO_ROOT,
            env=_safe_node_launcher_environment(),
            capture_output=True,
            check=False,
            encoding="utf-8",
        )

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        probe_environment = json.loads(result.stdout)
        self.assertEqual(probe_environment["PYTHONNOUSERSITE"], "1")
        self.assertEqual(probe_environment["PYTHONPATH"], str(runtime_root.resolve()))
        self.assertEqual(
            probe_environment["PYTHONHOME"],
            str((runtime_root / "python-runtime").resolve()),
        )
        self.assertEqual(probe_environment["HOME"], str(isolation_root.resolve()))
        self.assertEqual(probe_environment["TRANSCRIPT_RESEARCH_STUDIO_BACKEND_PORT"], "8765")
        self.assertNotIn(poison, probe_environment["PATH"])
        for name in (
            "VIRTUAL_ENV",
            "CONDA_PREFIX",
            "CONDA_DEFAULT_ENV",
            "_CE_CONDA",
            "PYTHONUSERBASE",
            "PYTHONSTARTUP",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "DYLD_FRAMEWORK_PATH",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "TRANSCRIPT_RESEARCH_STUDIO_HOST_POISON",
        ):
            self.assertNotIn(name, probe_environment)

    @unittest.skipUnless(os.name == "nt", "Windows environment lookup is platform-specific")
    def test_runtime_probe_environment_uses_case_insensitive_windows_source_environment(self) -> None:
        runtime_root = REPO_ROOT / "synthetic runtime"
        isolation_root = REPO_ROOT / "synthetic isolation"
        verifier_url = (REPO_ROOT / "scripts" / "verify_release_artifacts.mjs").as_uri()
        source_environment = {
            "sYsTeMrOoT": r"C:\SyntheticWindows",
            "cOmSpEc": r"C:\SyntheticWindows\System32\custom-cmd.exe",
            "pAtHeXt": ".TEST",
        }
        source = (
            f'import {{ sanitizedRuntimeEnvironment }} from {json.dumps(verifier_url)}; '
            f'const environment = sanitizedRuntimeEnvironment('
            f'{json.dumps(str(runtime_root))}, {json.dumps(str(isolation_root))}, {{}}, '
            f'{json.dumps(source_environment)}); '
            'console.log(JSON.stringify(environment));'
        )

        result = subprocess.run(
            [str(NODE), "--input-type=module", "-e", source],
            cwd=REPO_ROOT,
            env=_safe_node_launcher_environment(),
            capture_output=True,
            check=False,
            encoding="utf-8",
        )

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        probe_environment = json.loads(result.stdout)
        self.assertEqual(probe_environment["SystemRoot"], r"C:\SyntheticWindows")
        self.assertEqual(probe_environment["WINDIR"], r"C:\SyntheticWindows")
        self.assertEqual(probe_environment["COMSPEC"], r"C:\SyntheticWindows\System32\custom-cmd.exe")
        self.assertEqual(probe_environment["PATHEXT"], ".TEST")

    def test_runtime_probe_environment_rejects_non_application_overrides(self) -> None:
        verifier_url = (REPO_ROOT / "scripts" / "verify_release_artifacts.mjs").as_uri()
        source = (
            f'import {{ sanitizedRuntimeEnvironment }} from {json.dumps(verifier_url)}; '
            'sanitizedRuntimeEnvironment("runtime", "isolation", '
            '{ DYLD_INSERT_LIBRARIES: "hostile.dylib" });'
        )

        result = subprocess.run(
            [str(NODE), "--input-type=module", "-e", source],
            cwd=REPO_ROOT,
            env=_safe_node_launcher_environment(),
            capture_output=True,
            check=False,
            encoding="utf-8",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsafe runtime probe environment override", result.stderr)


@unittest.skipUnless(os.name == "nt", "PowerShell reassembly tests run on Windows")
class CudaReassemblyHelperTests(unittest.TestCase):
    helper = Path(__file__).resolve().parents[1] / "scripts" / "reassemble_cuda.ps1"

    def _run(self, manifest_path: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(self.helper),
                "-ManifestPath",
                str(manifest_path),
            ],
            capture_output=True,
            check=False,
            encoding="utf-8",
        )

    def test_reassembles_valid_parts_only_after_full_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_name = "transcript_research_studio_1.0.0-beta.1_windows_x64_cuda_portable.zip"
            payloads = [b"first archive bytes", b" and the remainder"]
            parts = []
            for index, payload in enumerate(payloads, start=1):
                part_name = f"{archive_name}.part{index:03d}"
                (root / part_name).write_bytes(payload)
                parts.append(
                    {
                        "file_name": part_name,
                        "size_bytes": len(payload),
                        "sha256": hashlib.sha256(payload).hexdigest(),
                    }
                )
            archive = b"".join(payloads)
            manifest = root / f"{archive_name}.parts.json"
            manifest.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "archive_name": archive_name,
                        "archive_size_bytes": len(archive),
                        "archive_sha256": hashlib.sha256(archive).hexdigest(),
                        "part_size_limit_bytes": max(map(len, payloads)),
                        "parts": parts,
                    }
                ),
                encoding="utf-8",
            )

            result = self._run(manifest)

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            self.assertEqual((root / archive_name).read_bytes(), archive)
            self.assertEqual(list(root.glob(".cuda-reassembly-*.tmp")), [])

    def test_rejects_path_traversal_without_creating_partial_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_name = "transcript_research_studio_1.0.0-beta.1_windows_x64_cuda_portable.zip"
            manifest = root / "unsafe.parts.json"
            manifest.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "archive_name": f"../{archive_name}",
                        "archive_size_bytes": 1,
                        "archive_sha256": hashlib.sha256(b"x").hexdigest(),
                        "part_size_limit_bytes": 1,
                        "parts": [],
                    }
                ),
                encoding="utf-8",
            )

            result = self._run(manifest)

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root.parent / archive_name).exists())
            self.assertEqual(list(root.glob(".cuda-reassembly-*.tmp")), [])

    def test_bad_part_hash_leaves_no_output_or_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_name = "transcript_research_studio_1.0.0-beta.1_windows_x64_cuda_portable.zip"
            part_name = f"{archive_name}.part001"
            (root / part_name).write_bytes(b"bad")
            manifest = root / f"{archive_name}.parts.json"
            manifest.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "archive_name": archive_name,
                        "archive_size_bytes": 3,
                        "archive_sha256": hashlib.sha256(b"bad").hexdigest(),
                        "part_size_limit_bytes": 3,
                        "parts": [
                            {
                                "file_name": part_name,
                                "size_bytes": 3,
                                "sha256": "0" * 64,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            result = self._run(manifest)

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / archive_name).exists())
            self.assertEqual(list(root.glob(".cuda-reassembly-*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
