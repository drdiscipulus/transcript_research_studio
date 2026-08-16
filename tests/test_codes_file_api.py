from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend.sidecar_server.evidence_project_ai import ContextualAiRunManager
from backend.sidecar_server.server import SidecarRequestHandler


class CodesFileApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)

    def tearDown(self) -> None:
        self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def post(self, path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        self.connection.request(
            "POST",
            path,
            body=json.dumps(payload),
            headers={"Content-Type": "application/json"},
        )
        response = self.connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        return response.status, body

    def test_handle_mutation_returns_patch_and_stale_request_returns_409(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_file = str(Path(directory) / "study.evidence.json")
            create_status, created = self.post(
                "/api/v1/codes/project/create",
                {"project_file": project_file, "name": "Study"},
            )
            handle = {
                "project_file": created["project_file"],
                "project_id": created["project_id"],
                "expected_revision": created["revision"],
            }

            mutation_status, mutation = self.post(
                "/api/v1/codes/project/create-code",
                {**handle, "name": "Uncertainty"},
            )
            conflict_status, conflict = self.post(
                "/api/v1/codes/project/create-code",
                {**handle, "name": "Stale code"},
            )

            self.assertEqual(create_status, HTTPStatus.OK)
            self.assertEqual(mutation_status, HTTPStatus.OK)
            self.assertNotIn("project", mutation)
            self.assertEqual(mutation["project_patch"]["upsert"]["codes"][0]["name"], "Uncertainty")
            self.assertEqual(conflict_status, HTTPStatus.CONFLICT)
            self.assertEqual(conflict["error_code"], "project_conflict")
            self.assertEqual(conflict["current_revision"], mutation["revision"])

    def test_mutation_rejects_missing_or_mismatched_file_handle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_file = str(Path(directory) / "study.evidence.json")
            create_status, created = self.post(
                "/api/v1/codes/project/create",
                {"project_file": project_file, "name": "Study"},
            )
            missing_status, missing = self.post(
                "/api/v1/codes/project/create-code",
                {"project": created["project"], "name": "No handle"},
            )
            mismatch_status, mismatch = self.post(
                "/api/v1/codes/project/create-code",
                {
                    "project_file": created["project_file"],
                    "project_id": "project_other",
                    "expected_revision": created["revision"],
                    "name": "Wrong project",
                },
            )

            self.assertEqual(create_status, HTTPStatus.OK)
            self.assertEqual(missing_status, HTTPStatus.BAD_REQUEST)
            self.assertIn("project file", missing["error"].lower())
            self.assertEqual(mismatch_status, HTTPStatus.CONFLICT)
            self.assertEqual(mismatch["error_code"], "project_conflict")

    def test_retired_codes_routes_are_not_registered(self) -> None:
        retired_routes = (
            "/api/v1/codes/project/export",
            "/api/v1/codes/project/add-transcript-file",
            "/api/v1/codes/project/add-transcript-folder",
            "/api/v1/codes/project/preview-refresh-transcript",
            "/api/v1/codes/project/refresh-transcript",
            "/api/v1/codes/project/create-and-assign-evidence-code",
            "/api/v1/codes/project/create-report-draft",
            "/api/v1/codes/project/suggest",
            "/api/v1/codes/project/apply-suggestion",
        )

        for path in retired_routes:
            with self.subTest(path=path):
                status, response = self.post(path, {})
                self.assertEqual(status, HTTPStatus.NOT_FOUND)
                self.assertEqual(response["error"], "Not found")

    def test_retired_codes_client_and_native_symbols_are_absent(self) -> None:
        root = Path(__file__).resolve().parents[1]
        codes_client = (root / "src/lib/api/codes.ts").read_text(encoding="utf-8")
        system_client = (root / "src/lib/api/system.ts").read_text(encoding="utf-8")
        native_commands = (root / "src-tauri/src/native_commands.rs").read_text(encoding="utf-8")
        native_registration = (root / "src-tauri/src/main.rs").read_text(encoding="utf-8")

        for retired_declaration in (
            "export async function exportCodesProject(",
            "export function addTranscriptFileToCodesProject(",
            "export function addTranscriptFolderToCodesProject(",
            "export function createAndAssignCodesEvidenceCode(",
        ):
            self.assertNotIn(retired_declaration, codes_client)
        self.assertNotIn("pickCodesExportFile", system_client)
        self.assertNotIn("pick_codes_export_file_native", native_commands)
        self.assertNotIn("pick_codes_export_file_native", native_registration)
        self.assertIn("exportCodesProjectBundle", codes_client)
        self.assertIn("pickCodesExportBundleFile", system_client)
        self.assertIn("pick_codes_export_bundle_file_native", native_registration)

    def test_contextual_ai_status_and_cancel_require_the_owning_project(self) -> None:
        run_id = "ai_run_http_ownership"
        project_id = "project_http_owner"
        manager = ContextualAiRunManager()
        with patch("backend.sidecar_server.server.contextual_ai_run_manager", manager):
            manager.register(
                run_id,
                {"project_id": project_id},
                {"task": "note"},
            )

            status_code, status_payload = self.post(
                "/api/v1/codes/project/ai-run/status",
                {"project_id": project_id, "run_id": run_id},
            )
            wrong_status_code, wrong_status = self.post(
                "/api/v1/codes/project/ai-run/status",
                {"project_id": "another_project", "run_id": run_id},
            )
            wrong_cancel_code, wrong_cancel = self.post(
                "/api/v1/codes/project/ai-run/cancel",
                {"project_id": "another_project", "run_id": run_id},
            )

            self.assertEqual(status_code, HTTPStatus.OK)
            self.assertEqual(status_payload["run"]["status"], "pending")
            self.assertEqual(wrong_status_code, HTTPStatus.BAD_REQUEST)
            self.assertEqual(wrong_status["error_code"], "ai_run_not_found")
            self.assertEqual(wrong_cancel_code, HTTPStatus.BAD_REQUEST)
            self.assertEqual(wrong_cancel["error_code"], "ai_run_not_found")
            self.assertEqual(manager.snapshot(run_id)["status"], "pending")
            self.assertFalse(manager.cancellation_requested(run_id))

            cancel_code, cancel_payload = self.post(
                "/api/v1/codes/project/ai-run/cancel",
                {"project_id": project_id, "run_id": run_id},
            )
            self.assertEqual(cancel_code, HTTPStatus.OK)
            self.assertEqual(cancel_payload["run"]["status"], "cancelling")

    def test_contextual_ai_status_and_cancel_reject_missing_identifiers(self) -> None:
        manager = ContextualAiRunManager()
        with patch("backend.sidecar_server.server.contextual_ai_run_manager", manager):
            for path in (
                "/api/v1/codes/project/ai-run/status",
                "/api/v1/codes/project/ai-run/cancel",
            ):
                for payload in ({}, {"project_id": "project_only"}, {"run_id": "run_only"}):
                    with self.subTest(path=path, payload=payload):
                        status, response = self.post(path, payload)
                        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
                        self.assertEqual(response["error_code"], "ai_run_not_found")

    def test_contextual_ai_validation_failure_does_not_modify_project_or_launch_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "study.evidence.json"
            create_status, created = self.post(
                "/api/v1/codes/project/create",
                {
                    "project_file": str(project_path),
                    "name": "Study",
                    "ai_settings": {"provider_id": "ollama", "model_id": "missing-model"},
                },
            )
            self.assertEqual(create_status, HTTPStatus.OK)
            original_bytes = project_path.read_bytes()
            manager = ContextualAiRunManager()

            with (
                patch("backend.sidecar_server.server.contextual_ai_run_manager", manager),
                patch("backend.sidecar_server.evidence_project_ai.contextual_ai_run_manager", manager),
                patch(
                    "backend.sidecar_server.evidence_project_ai.validate_provider_model",
                    side_effect=ValueError("The selected model is unavailable."),
                ),
                patch.object(manager, "register", wraps=manager.register) as register,
                patch.object(manager, "launch", wraps=manager.launch) as launch,
            ):
                status, response = self.post(
                    "/api/v1/codes/project/ai-run/start",
                    {
                        "project_file": created["project_file"],
                        "project_id": created["project_id"],
                        "expected_revision": created["revision"],
                        "task": "code_details",
                        "code_draft": {"name": "Draft"},
                    },
                )

            self.assertEqual(status, HTTPStatus.BAD_REQUEST)
            self.assertEqual(response["error_code"], "ai_model_unavailable")
            self.assertEqual(project_path.read_bytes(), original_bytes)
            register.assert_not_called()
            launch.assert_not_called()

    def test_import_preview_and_transcript_integrity_error_codes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_file = str(Path(directory) / "study.evidence.json")
            transcript_file = Path(directory) / "interview.json"
            transcript_file.write_text(
                json.dumps({
                    "documents": [{
                        "id": "doc_000001",
                        "file_name": "interview.wav",
                        "segments": [{
                            "segment_id": "seg_000001",
                            "text": "A traceable passage.",
                            "speaker": "SPEAKER_00",
                            "start": 0.0,
                            "end": 2.0,
                        }],
                    }],
                }),
                encoding="utf-8",
            )
            _, created = self.post("/api/v1/codes/project/create", {"project_file": project_file})
            handle = {
                "project_file": created["project_file"],
                "project_id": created["project_id"],
                "expected_revision": created["revision"],
            }

            preview_status, preview = self.post(
                "/api/v1/codes/project/preview-transcript-import",
                {**handle, "transcript_file": str(transcript_file)},
            )
            candidate = preview["candidates"][0]
            import_status, imported = self.post(
                "/api/v1/codes/project/import-transcripts",
                {
                    **handle,
                    "candidates": [{
                        "candidate_id": candidate["candidate_id"],
                        "source_path": candidate["source_path"],
                        "source_document_id": candidate["source_document_id"],
                    }],
                },
            )
            transcript_id = imported["imported"][0]["transcript_id"]
            evidence_status, evidence = self.post(
                "/api/v1/codes/project/create-evidence",
                {
                    "project_file": imported["project_file"],
                    "project_id": imported["project_id"],
                    "expected_revision": imported["revision"],
                    "transcript_id": transcript_id,
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": {
                        "seg_000001": {
                            "start_offset": 0,
                            "end_offset": len("A traceable passage."),
                            "excerpt": "A traceable passage.",
                        }
                    },
                    "selected_text": "A traceable passage.",
                },
            )
            remove_status, remove_error = self.post(
                "/api/v1/codes/project/remove-transcript",
                {
                    "project_file": evidence["project_file"],
                    "project_id": evidence["project_id"],
                    "expected_revision": evidence["revision"],
                    "transcript_id": transcript_id,
                },
            )

            self.assertEqual(preview_status, HTTPStatus.OK)
            self.assertEqual(preview["counts"]["ready"], 1)
            self.assertEqual(import_status, HTTPStatus.OK)
            self.assertEqual(evidence_status, HTTPStatus.OK)
            self.assertEqual(remove_status, HTTPStatus.CONFLICT)
            self.assertEqual(remove_error["error_code"], "transcript_has_evidence")

    def test_export_bundle_endpoint_writes_the_requested_zip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project_file = str(root / "study.evidence.json")
            output_file = str(root / "study_export.zip")
            _, created = self.post(
                "/api/v1/codes/project/create",
                {"project_file": project_file, "name": "Study"},
            )

            status, exported = self.post(
                "/api/v1/codes/project/export-bundle",
                {
                    "project_file": created["project_file"],
                    "project_id": created["project_id"],
                    "expected_revision": created["revision"],
                    "output_file": output_file,
                    "products": ["json"],
                    "docx_mode": "separate",
                    "include_local_paths": False,
                    "include_ai_audit": False,
                },
            )

            self.assertEqual(status, HTTPStatus.OK)
            self.assertTrue(exported["bundle"]["exists"])
            requested_output = Path(output_file)
            reported_output = Path(exported["bundle"]["path"])
            self.assertTrue(requested_output.exists())
            self.assertTrue(reported_output.exists())
            self.assertTrue(reported_output.samefile(requested_output))
            self.assertIn("structured_project.json", [item["archive_path"] for item in exported["artifacts"]])

    def test_export_path_identity_accepts_aliases_but_rejects_other_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requested_output = root / "study_export.zip"
            alias_output = root / "study-export-alias.zip"
            other_output = root / "other_export.zip"
            requested_output.write_bytes(b"bundle")
            alias_output.hardlink_to(requested_output)
            other_output.write_bytes(b"other bundle")

            self.assertTrue(alias_output.samefile(requested_output))
            self.assertFalse(other_output.samefile(requested_output))


if __name__ == "__main__":
    unittest.main()
