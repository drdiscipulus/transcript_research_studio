from __future__ import annotations

import csv
import tempfile
import unittest
import json
import io
import threading
import zipfile
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.evidence_project import (
    EvidenceProjectConflictError,
    EvidenceProjectOperationError,
    create_code,
    create_evidence_item,
    create_evidence_project,
    create_theme,
    delete_code,
    delete_evidence_item,
    delete_theme,
    import_transcript_candidates,
    load_evidence_project,
    merge_code,
    preview_transcript_import,
    remove_project_transcript,
    run_evidence_project_mutation,
    save_evidence_project,
    update_code,
    update_evidence_item,
    update_theme,
)
from backend.sidecar_server.evidence_project_ai import (
    ContextualAiRunManager,
    prepare_contextual_ai_run,
    record_ai_suggestion_decision,
    run_evidence_assistance,
    run_code_details_assistance,
    run_theme_suggestions_assistance,
    run_note_assistance,
)
from backend.sidecar_server.evidence_export_bundle import export_evidence_project_bundle
from backend.sidecar_server.evidence_export_qdpx import stable_guid


class EvidenceProjectTests(unittest.TestCase):
    def segment_ranges(self, excerpt: str = "Hello world.", source_text: str = "Hello world.") -> dict[str, dict[str, object]]:
        start = source_text.index(excerpt)
        return {
            "seg_000001": {
                "start_offset": start,
                "end_offset": start + len(excerpt),
                "excerpt": excerpt,
            }
        }

    def write_app_json(self, path: Path, text: str = "Hello world.") -> None:
        path.write_text(
            """
{
  "documents": [
    {
      "file_name": "interview_01.wav",
      "detected_language": "en",
      "duration": 2.0,
      "segments": [
        {
          "start_seconds": 0.0,
          "end_seconds": 2.0,
          "speaker": "Participant",
          "text": "%s"
        }
      ]
    }
  ]
}
""".strip()
            % text,
            encoding="utf-8",
        )

    def import_transcript(self, project: dict[str, object], transcript_path: Path) -> dict[str, object]:
        preview = preview_transcript_import({"project": project, "transcript_file": str(transcript_path)})
        candidate = next(item for item in preview["candidates"] if item["status"] == "ready")
        return import_transcript_candidates(
            {
                "project": project,
                "candidates": [
                    {
                        "candidate_id": candidate["candidate_id"],
                        "source_path": candidate["source_path"],
                        "source_document_id": candidate["source_document_id"],
                    }
                ],
            }
        )

    def test_create_save_load_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "study.evidence.json"
            created = create_evidence_project(
                {
                    "project_file": str(project_path),
                    "name": "Study",
                    "research_focus": "Initial focus",
                    "ai_settings": {
                        "provider_id": "Ollama",
                        "model_id": "llama3",
                        "temperature": 0.3,
                        "timeout_seconds": 240,
                        "suggestion_language": "German",
                    },
                }
            )

            saved = save_evidence_project(
                {
                    "project_file": created["project_file"],
                    "source_project_file": created["project_file"],
                    "project_id": created["project_id"],
                    "expected_revision": created["revision"],
                    "project_updates": {"research_focus": "How founders describe customer uncertainty."},
                }
            )
            loaded = load_evidence_project({"project_file": str(project_path)})

            self.assertTrue(project_path.exists())
            self.assertEqual(saved["project_file"], str(project_path.resolve()))
            self.assertNotEqual(saved["revision"], created["revision"])
            self.assertEqual(loaded["project"]["name"], "Study")
            self.assertEqual(loaded["project"]["research_focus"], "How founders describe customer uncertainty.")
            self.assertEqual(loaded["project"]["ai_settings"]["provider_id"], "ollama")
            self.assertEqual(loaded["project"]["ai_settings"]["model_id"], "llama3")
            self.assertEqual(loaded["project"]["ai_settings"]["temperature"], 0.3)
            self.assertEqual(loaded["project"]["ai_settings"]["timeout_seconds"], 240)
            self.assertEqual(loaded["project"]["ai_settings"]["suggestion_language"], "german")
            self.assertEqual(loaded["project"]["settings"]["case_definition"], "transcript")
            self.assertEqual(loaded["project"]["settings"]["theme_assignment"], "multiple")
            self.assertEqual(loaded["project"]["transcripts"], [])
            self.assertEqual(loaded["project"]["evidence_items"], [])
            self.assertEqual(loaded["project"]["codes"], [])
            self.assertEqual(loaded["project"]["themes"], [])
            self.assertEqual(loaded["project"]["report_drafts"], [])
            self.assertEqual(loaded["project"]["suggestion_decisions"], [])
            self.assertEqual(loaded["project"]["ai_runs"], [])
            self.assertEqual(loaded["project"]["ai_settings"]["prompt_overrides"], {
                "evidence": "",
                "codes": "",
                "note": "",
                "codebook": "",
                "themes": "",
            })
            self.assertEqual(loaded["project_id"], loaded["project"]["project_id"])
            self.assertEqual(len(loaded["revision"]), 64)

    def test_contextual_ai_run_records_compact_audit_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path, text="A traceable participant statement.")
            project = create_evidence_project({
                "name": "Study",
                "research_focus": "Founder uncertainty",
                "ai_settings": {
                    "provider_id": "ollama",
                    "model_id": "local-model",
                    "prompt_overrides": {"evidence": "Prioritize uncertainty statements."},
                },
            })["project"]
            imported = self.import_transcript(project, transcript_path)
            manager = ContextualAiRunManager()

            with (
                patch("backend.sidecar_server.evidence_project_ai.contextual_ai_run_manager", manager),
                patch(
                    "backend.sidecar_server.evidence_project_ai.validate_provider_model",
                    return_value={"provider_id": "ollama", "models": [{"id": "local-model"}]},
                ) as validate_model,
            ):
                prepared = prepare_contextual_ai_run({
                    "project": imported["project"],
                    "_run_id": "ai_run_test",
                    "task": "evidence",
                    "transcript_id": "T000001",
                    "scope": {"type": "current_page", "segment_ids": ["seg_000001"]},
                    "maximum_suggestions": 10,
                })

            validate_model.assert_called_once_with("ollama", "local-model")
            run_record = prepared["project"]["ai_runs"][0]
            self.assertEqual(run_record["run_id"], "ai_run_test")
            self.assertEqual(run_record["researcher_prompt"], "Prioritize uncertainty statements.")
            self.assertEqual(run_record["context"]["segment_ids"], ["seg_000001"])
            self.assertNotIn("A traceable participant statement.", json.dumps(run_record))
            self.assertEqual(prepared["run"]["status"], "pending")
            self.assertEqual(prepared["run"]["phase"], "queued")
            self.assertEqual(prepared["run"]["progress_kind"], "indeterminate")
            self.assertEqual(prepared["run"]["progress_label"], "Waiting to start.")

    def test_contextual_ai_validation_precedes_run_mutation_and_registration(self) -> None:
        project = create_evidence_project({
            "name": "Study",
            "ai_settings": {"provider_id": "ollama", "model_id": "missing-model"},
        })["project"]
        manager = ContextualAiRunManager()

        with (
            patch("backend.sidecar_server.evidence_project_ai.contextual_ai_run_manager", manager),
            patch(
                "backend.sidecar_server.evidence_project_ai.validate_provider_model",
                side_effect=ValueError('The selected model "missing-model" is no longer available in Ollama.'),
            ) as validate_model,
            patch.object(manager, "register", wraps=manager.register) as register,
        ):
            with self.assertRaises(EvidenceProjectOperationError) as failure:
                prepare_contextual_ai_run({
                    "project": project,
                    "_run_id": "ai_run_rejected",
                    "task": "code_details",
                    "code_draft": {"name": "Draft"},
                })

        self.assertEqual(failure.exception.code, "ai_model_unavailable")
        validate_model.assert_called_once_with("ollama", "missing-model")
        register.assert_not_called()
        self.assertEqual(project["ai_runs"], [])
        with self.assertRaises(EvidenceProjectOperationError):
            manager.snapshot("ai_run_rejected")

    def test_contextual_ai_rejects_invalid_context_before_provider_validation(self) -> None:
        project = create_evidence_project({
            "name": "Study",
            "ai_settings": {"provider_id": "ollama", "model_id": "local-model"},
        })["project"]

        with patch("backend.sidecar_server.evidence_project_ai.validate_provider_model") as validate_model:
            with self.assertRaisesRegex(ValueError, "Transcript was not found"):
                prepare_contextual_ai_run({
                    "project": project,
                    "task": "evidence",
                    "transcript_id": "missing-transcript",
                })

        validate_model.assert_not_called()
        self.assertEqual(project["ai_runs"], [])

    def test_contextual_ai_unsupported_provider_is_a_controlled_model_error(self) -> None:
        project = create_evidence_project({
            "name": "Study",
            "ai_settings": {"provider_id": "cloud-provider", "model_id": "remote-model"},
        })["project"]

        with patch(
            "backend.sidecar_server.prompting_providers.list_provider_models"
        ) as list_models:
            with self.assertRaises(EvidenceProjectOperationError) as failure:
                prepare_contextual_ai_run({
                    "project": project,
                    "task": "code_details",
                    "code_draft": {"name": "Draft"},
                })

        self.assertEqual(failure.exception.code, "ai_model_unavailable")
        list_models.assert_not_called()
        self.assertEqual(project["ai_runs"], [])

    def test_contextual_ai_run_manager_enforces_project_ownership_before_cancellation(self) -> None:
        manager = ContextualAiRunManager()
        project = create_evidence_project({"name": "Study"})["project"]
        payload = {"task": "note"}
        manager.register("ai_run_owned", project, payload)

        snapshot = manager.snapshot_for_project(project["project_id"], "ai_run_owned")
        self.assertEqual(snapshot["status"], "pending")

        with self.assertRaises(EvidenceProjectOperationError) as wrong_status:
            manager.snapshot_for_project("another_project", "ai_run_owned")
        self.assertEqual(wrong_status.exception.code, "ai_run_not_found")

        with self.assertRaises(EvidenceProjectOperationError) as wrong_cancel:
            manager.cancel_for_project("another_project", "ai_run_owned")
        self.assertEqual(wrong_cancel.exception.code, "ai_run_not_found")
        self.assertFalse(manager.cancellation_requested("ai_run_owned"))
        self.assertEqual(manager.snapshot("ai_run_owned")["status"], "pending")

        cancelled = manager.cancel_for_project(project["project_id"], "ai_run_owned")
        self.assertEqual(cancelled["status"], "cancelling")
        self.assertTrue(manager.cancellation_requested("ai_run_owned"))

    def test_contextual_ai_run_manager_preserves_one_active_run_per_project(self) -> None:
        manager = ContextualAiRunManager()
        project = create_evidence_project({"name": "Study"})["project"]
        manager.register("ai_run_first", project, {"task": "note"})

        with self.assertRaises(EvidenceProjectOperationError) as duplicate:
            manager.register("ai_run_second", project, {"task": "codes"})

        self.assertEqual(duplicate.exception.code, "ai_run_active")

    def test_contextual_evidence_ai_keeps_valid_exact_quote_and_reports_invalid_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path, text="Exact quote once. repeated repeated.")
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)
            payload = {
                "task": "evidence",
                "transcript_id": "T000001",
                "scope": {"type": "current_page", "segment_ids": ["seg_000001"]},
                "researcher_prompt": "Find relevant evidence.",
                "maximum_suggestions": 10,
                "ai_settings": {
                    "provider_id": "ollama",
                    "model_id": "local-model",
                    "temperature": 0,
                    "timeout_seconds": 180,
                },
            }
            manager = ContextualAiRunManager()
            manager.register("ai_run_quotes", imported["project"], payload)
            provider_response = json.dumps({
                "suggestions": [
                    {
                        "segment_id": "seg_000001",
                        "quote": "Exact quote once.",
                        "rationale": "Relevant.",
                        "code_id": "C000001",
                        "new_code": {"name": "Must be ignored", "description": "Evidence AI does not code."},
                    },
                    {"segment_id": "seg_000001", "quote": "repeated", "rationale": "Ambiguous."},
                    {"segment_id": "seg_missing", "quote": "Invented", "rationale": "Invalid."},
                ]
            })

            with (
                patch("backend.sidecar_server.evidence_project_ai.detect_prompting_context_policy", return_value={
                    "tokens": 4096,
                    "should_request_provider_context": False,
                }),
                patch("backend.sidecar_server.evidence_project_ai.run_provider_task_prompt", return_value=provider_response),
            ):
                results, omitted = run_evidence_assistance(imported["project"], payload, "ai_run_quotes", manager)

            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["selected_text"], "Exact quote once.")
            self.assertEqual(results[0]["segment_ranges"]["seg_000001"]["start_offset"], 0)
            self.assertNotIn("suggested_code_id", results[0])
            self.assertNotIn("suggested_new_code", results[0])
            self.assertEqual(len(omitted), 2)
            snapshot = manager.snapshot("ai_run_quotes")
            self.assertEqual(snapshot["progress_kind"], "determinate")
            self.assertEqual(snapshot["progress_completed"], snapshot["progress_total"])
            self.assertIn("batches completed", snapshot["progress_label"])

    def test_contextual_note_ai_returns_only_one_normalized_paragraph_under_80_words(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path, text="A participant statement for analysis.")
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)
            payload = {
                "task": "note",
                "transcript_id": "T000001",
                "segment_ids": ["seg_000001"],
                "selected_text": "A participant statement for analysis.",
                "code_ids": [],
                "researcher_prompt": "Draft a note.",
                "ai_settings": {
                    "provider_id": "lmstudio",
                    "model_id": "local-model",
                    "temperature": 0,
                    "timeout_seconds": 180,
                },
            }
            manager = ContextualAiRunManager()
            manager.register("ai_run_note", imported["project"], payload)
            long_note = "\n".join(["word"] * 100)

            with patch(
                "backend.sidecar_server.evidence_project_ai.run_provider_task_prompt",
                return_value=json.dumps({"note": long_note, "rationale": "This must not be returned."}),
            ):
                results, omitted = run_note_assistance(imported["project"], payload, "ai_run_note", manager)

            self.assertEqual(omitted, [])
            self.assertEqual(set(results[0]), {"suggestion_id", "kind", "note"})
            self.assertLessEqual(len(results[0]["note"].split()), 80)
            self.assertNotIn("\n", results[0]["note"])
            snapshot = manager.snapshot("ai_run_note")
            self.assertEqual(snapshot["phase"], "validating")
            self.assertEqual(snapshot["progress_kind"], "indeterminate")

    def test_contextual_code_details_and_theme_suggestions_are_draft_only_and_validate_ids(self) -> None:
        project = create_evidence_project({"name": "Study", "research_focus": "Founder learning"})["project"]
        first = create_code({"project": project, "name": "Experimentation", "description": "Testing assumptions."})
        second = create_code({"project": first["project"], "name": "Customer Feedback", "description": "Learning from customers."})
        settings = {
            "provider_id": "ollama",
            "model_id": "local-model",
            "temperature": 0,
            "timeout_seconds": 180,
        }

        code_payload = {
            "task": "code_details",
            "researcher_prompt": "Draft operational details.",
            "code_draft": {"name": "Experimentation"},
            "ai_settings": settings,
        }
        code_manager = ContextualAiRunManager()
        code_manager.register("ai_run_code_details", second["project"], code_payload)
        with patch(
            "backend.sidecar_server.evidence_project_ai.run_provider_task_prompt",
            return_value=json.dumps({
                "name": "Experimentation",
                "description": "Purposeful tests of assumptions.",
                "inclusion_note": "Include explicit tests.",
                "exclusion_note": "Exclude untested ideas.",
                "memo": "Track learning cycles.",
                "color": "#ffffff",
            }),
        ):
            code_results, code_omitted = run_code_details_assistance(
                second["project"], code_payload, "ai_run_code_details", code_manager
            )
        self.assertEqual(code_omitted, [])
        self.assertEqual(code_results[0]["kind"], "code_details")
        self.assertNotIn("color", code_results[0])

        theme_payload = {
            "task": "theme_suggestions",
            "researcher_prompt": "Suggest coherent themes.",
            "selected_code_ids": ["C000001", "C000002"],
            "maximum_suggestions": 5,
            "ai_settings": settings,
        }
        theme_manager = ContextualAiRunManager()
        theme_manager.register("ai_run_themes", second["project"], theme_payload)
        with patch(
            "backend.sidecar_server.evidence_project_ai.run_provider_task_prompt",
            return_value=json.dumps({"themes": [
                {"name": "Learning Through Action", "description": "Iterative learning.", "memo": "", "rationale": "Codes cohere.", "code_ids": ["C000001", "C000002"]},
                {"name": "Invalid", "description": "", "memo": "", "rationale": "", "code_ids": ["C999999"]},
            ]}),
        ):
            theme_results, theme_omitted = run_theme_suggestions_assistance(
                second["project"], theme_payload, "ai_run_themes", theme_manager
            )
        self.assertEqual([item["name"] for item in theme_results], ["Learning Through Action"])
        self.assertEqual(len(theme_omitted), 1)
        self.assertEqual(second["project"]["themes"], [])

    def test_ai_evidence_accept_creates_uncoded_evidence_and_decision_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path, text="Exact AI-selected evidence.")
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)
            coded = create_code({"project": imported["project"], "name": "Existing Code"})
            coded["project"]["ai_runs"].append({
                "run_id": "ai_run_accept",
                "task": "evidence",
                "provider_id": "lmstudio",
                "model_id": "local-model",
            })

            accepted = create_evidence_item({
                "project": coded["project"],
                "transcript_id": "T000001",
                "segment_ids": ["seg_000001"],
                "segment_ranges": self.segment_ranges(
                    "Exact AI-selected evidence.",
                    "Exact AI-selected evidence.",
                ),
                "selected_text": "Exact AI-selected evidence.",
                "code_ids": [],
                "new_codes": [],
                "memo": "",
                "ai_decisions": [{
                    "run_id": "ai_run_accept",
                    "suggestion_id": "suggestion_accept",
                    "task": "evidence",
                    "decision": "accepted",
                }],
            })

            self.assertEqual(accepted["evidence"]["code_ids"], [])
            self.assertEqual(accepted["evidence"]["memo"], "")
            self.assertEqual(len(accepted["project"]["codes"]), 1)
            self.assertEqual(accepted["project"]["suggestion_decisions"][0]["decision"], "accepted")
            self.assertEqual(accepted["project"]["suggestion_decisions"][0]["result_ids"], ["E000001"])

    def test_create_can_persist_project_immediately(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "new-study.evidence.json"

            created = create_evidence_project({"name": "Study", "project_file": str(project_path)})

            self.assertTrue(project_path.is_file())
            self.assertEqual(created["project_file"], str(project_path.resolve()))
            self.assertEqual(created["project_id"], created["project"]["project_id"])
            self.assertEqual(len(created["revision"]), 64)

    def test_file_backed_mutation_returns_patch_and_saves_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "study.evidence.json"
            created = create_evidence_project({"name": "Study", "project_file": str(project_path)})

            result = run_evidence_project_mutation(
                {
                    "project_file": created["project_file"],
                    "project_id": created["project_id"],
                    "expected_revision": created["revision"],
                    "name": "Uncertainty",
                },
                create_code,
            )
            loaded = load_evidence_project({"project_file": str(project_path)})

            self.assertNotIn("project", result)
            self.assertEqual(result["code"]["code_id"], "C000001")
            self.assertEqual(result["project_patch"]["upsert"]["codes"][0]["name"], "Uncertainty")
            self.assertEqual(result["revision"], loaded["revision"])
            self.assertEqual(loaded["project"]["codes"][0]["name"], "Uncertainty")
            self.assertTrue(Path(f"{project_path}.bak").is_file())

    def test_file_backed_mutation_rejects_stale_revision_without_overwriting(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "study.evidence.json"
            created = create_evidence_project({"name": "Study", "project_file": str(project_path)})
            first = run_evidence_project_mutation(
                {
                    "project_file": created["project_file"],
                    "project_id": created["project_id"],
                    "expected_revision": created["revision"],
                    "name": "First",
                },
                create_code,
            )

            with self.assertRaises(EvidenceProjectConflictError) as raised:
                run_evidence_project_mutation(
                    {
                        "project_file": created["project_file"],
                        "project_id": created["project_id"],
                        "expected_revision": created["revision"],
                        "name": "Stale",
                    },
                    create_code,
                )

            loaded = load_evidence_project({"project_file": str(project_path)})
            self.assertEqual(raised.exception.current_revision, first["revision"])
            self.assertEqual([code["name"] for code in loaded["project"]["codes"]], ["First"])

    def test_concurrent_mutations_from_one_revision_cannot_overwrite_each_other(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "study.evidence.json"
            created = create_evidence_project({"name": "Study", "project_file": str(project_path)})
            barrier = threading.Barrier(2)
            results: list[str] = []

            def slow_create_code(payload: dict[str, object]) -> dict[str, object]:
                result = create_code(payload)
                barrier.wait(timeout=2)
                return result

            def mutate(name: str) -> None:
                try:
                    run_evidence_project_mutation(
                        {
                            "project_file": created["project_file"],
                            "project_id": created["project_id"],
                            "expected_revision": created["revision"],
                            "name": name,
                        },
                        slow_create_code,
                    )
                    results.append("saved")
                except EvidenceProjectConflictError:
                    results.append("conflict")

            threads = [threading.Thread(target=mutate, args=(name,)) for name in ("First", "Second")]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=3)

            self.assertCountEqual(results, ["saved", "conflict"])
            self.assertEqual(len(load_evidence_project({"project_file": str(project_path)})["project"]["codes"]), 1)

    def test_save_with_expected_revision_detects_external_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "study.evidence.json"
            created = create_evidence_project({"name": "Study", "project_file": str(project_path)})
            project_path.write_text(project_path.read_text(encoding="utf-8") + "\n", encoding="utf-8")

            with self.assertRaises(EvidenceProjectConflictError):
                save_evidence_project(
                    {
                        "project_file": str(project_path),
                        "project_id": created["project_id"],
                        "expected_revision": created["revision"],
                        "project_updates": {"name": "Study"},
                    }
                )

    def test_compact_project_updates_preserve_large_project_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "large.evidence.json"
            created = create_evidence_project({"name": "Large", "project_file": str(project_path)})
            large_project = created["project"]
            large_project["report_drafts"] = [
                {
                    "draft_id": "R000001",
                    "title": "Large draft",
                    "body": "x" * (11 * 1024 * 1024),
                    "source_suggestion_id": "",
                    "created_at": large_project["created_at"],
                    "updated_at": large_project["updated_at"],
                }
            ]
            project_path.write_text(json.dumps(large_project), encoding="utf-8")
            seeded = load_evidence_project({"project_file": str(project_path)})
            compact_payload = {
                "project_file": str(project_path),
                "source_project_file": str(project_path),
                "project_id": seeded["project_id"],
                "expected_revision": seeded["revision"],
                "project_updates": {"research_focus": "Updated without uploading the project."},
            }

            saved = save_evidence_project(compact_payload)
            loaded = load_evidence_project({"project_file": str(project_path)})

            self.assertLess(len(json.dumps(compact_payload)), 1024)
            self.assertNotIn("project", saved)
            self.assertEqual(loaded["project"]["research_focus"], "Updated without uploading the project.")
            self.assertEqual(len(loaded["project"]["report_drafts"][0]["body"]), 11 * 1024 * 1024)

    def test_compact_save_as_copies_from_validated_source_handle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.evidence.json"
            target_path = Path(directory) / "copy.evidence.json"
            created = create_evidence_project({"name": "Study", "project_file": str(source_path)})

            copied = save_evidence_project(
                {
                    "project_file": str(target_path),
                    "source_project_file": str(source_path),
                    "project_id": created["project_id"],
                    "expected_revision": created["revision"],
                    "project_updates": {"name": "Study copy"},
                }
            )

            self.assertEqual(load_evidence_project({"project_file": str(source_path)})["project"]["name"], "Study")
            self.assertEqual(load_evidence_project({"project_file": str(target_path)})["project"]["name"], "Study copy")
            self.assertEqual(copied["project_file"], str(target_path.resolve()))

    def test_conflict_save_copy_uses_last_revision_without_uploading_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.evidence.json"
            target_path = Path(directory) / "recovered.evidence.json"
            created = create_evidence_project({"name": "Local study", "project_file": str(source_path)})
            external = create_evidence_project({"name": "External replacement"})["project"]
            source_path.write_text(json.dumps(external), encoding="utf-8")

            copied = save_evidence_project(
                {
                    "project_file": str(target_path),
                    "source_project_file": str(source_path),
                    "project_id": created["project_id"],
                    "expected_revision": created["revision"],
                    "project_updates": {"research_focus": "Recovered local draft"},
                }
            )
            recovered = load_evidence_project({"project_file": str(target_path)})

            self.assertEqual(recovered["project"]["project_id"], created["project_id"])
            self.assertEqual(recovered["project"]["name"], "Local study")
            self.assertEqual(recovered["project"]["research_focus"], "Recovered local draft")
            self.assertEqual(copied["revision"], recovered["revision"])

    def test_deleted_source_can_be_recovered_to_a_copy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.evidence.json"
            target_path = Path(directory) / "recovered.evidence.json"
            created = create_evidence_project({"name": "Local study", "project_file": str(source_path)})
            source_path.unlink()

            with self.assertRaises(EvidenceProjectConflictError):
                run_evidence_project_mutation(
                    {
                        "project_file": str(source_path),
                        "project_id": created["project_id"],
                        "expected_revision": created["revision"],
                        "name": "Code after deletion",
                    },
                    create_code,
                )

            save_evidence_project(
                {
                    "project_file": str(target_path),
                    "source_project_file": str(source_path),
                    "project_id": created["project_id"],
                    "expected_revision": created["revision"],
                    "project_updates": {},
                }
            )

            self.assertEqual(load_evidence_project({"project_file": str(target_path)})["project"]["name"], "Local study")

    def test_create_adds_evidence_extension_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            saved = create_evidence_project({"project_file": str(Path(directory) / "study"), "name": "Study"})

            self.assertTrue(saved["project_file"].endswith("study.evidence.json"))
            self.assertTrue(Path(saved["project_file"]).exists())

    def test_load_rejects_invalid_schema(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "bad.evidence.json"
            project_path.write_text('{"schema_version":"0.1","project_id":"project_bad"}', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Unsupported coding project schema version"):
                load_evidence_project({"project_file": str(project_path)})

    def test_load_rejects_collection_with_wrong_structural_type(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "bad-codes.evidence.json"
            create_evidence_project({"project_file": str(project_path), "name": "Study"})
            stored = json.loads(project_path.read_text(encoding="utf-8"))
            stored["codes"] = {}
            project_path.write_text(json.dumps(stored), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Coding project field must be a list: codes"):
                load_evidence_project({"project_file": str(project_path)})

    def test_import_preview_prefers_json_and_reports_bad_files_individually(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_app_json(root / "interview.json")
            (root / "interview.csv").write_text(
                "file_name,start_seconds,end_seconds,speaker,text\n"
                "interview_01.wav,0,2,Participant,Hello world.\n",
                encoding="utf-8",
            )
            (root / "broken.docx").write_bytes(b"not-a-docx")
            project = create_evidence_project({"name": "Study"})["project"]

            preview = preview_transcript_import({"project": project, "transcript_folder": str(root)})

            by_format = {candidate["format"]: candidate for candidate in preview["candidates"]}
            self.assertEqual(by_format["json"]["status"], "ready")
            self.assertTrue(by_format["json"]["preferred"])
            self.assertEqual(by_format["csv"]["status"], "alternate_format")
            self.assertEqual(by_format["docx"]["status"], "problem")
            self.assertEqual(preview["counts"], {"ready": 1, "already_imported": 0, "alternate_format": 1, "problem": 1})

            imported = import_transcript_candidates(
                {
                    "project": project,
                    "candidates": [
                        {
                            "candidate_id": by_format["json"]["candidate_id"],
                            "source_path": by_format["json"]["source_path"],
                            "source_document_id": by_format["json"]["source_document_id"],
                        }
                    ],
                }
            )
            self.assertEqual(len(imported["imported"]), 1)
            self.assertEqual(imported["failed"], [])

    def test_remove_transcript_is_blocked_when_evidence_exists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path)
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)
            coded = create_evidence_item(
                {
                    "project": imported["project"],
                    "transcript_id": "T000001",
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": self.segment_ranges(),
                    "selected_text": "Hello world.",
                }
            )

            with self.assertRaises(EvidenceProjectOperationError) as caught:
                remove_project_transcript({"project": coded["project"], "transcript_id": "T000001"})

            self.assertEqual(caught.exception.code, "transcript_has_evidence")
            self.assertEqual(len(coded["project"]["transcripts"]), 1)

    def test_create_evidence_item_preserves_source_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path)
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)

            created = create_evidence_item(
                {
                    "project": imported["project"],
                    "transcript_id": "T000001",
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": self.segment_ranges(),
                    "selected_text": "Hello world.",
                    "memo": "Relevant opening statement.",
                }
            )

            evidence = created["evidence"]
            self.assertEqual(evidence["evidence_id"], "E000001")
            self.assertEqual(evidence["transcript_id"], "T000001")
            self.assertEqual(evidence["source_file"], str(transcript_path.resolve()))
            self.assertEqual(evidence["source_document_id"], "doc_000001")
            self.assertEqual(evidence["segment_ids"], ["seg_000001"])
            self.assertEqual(evidence["speaker"], "Participant")
            self.assertEqual(evidence["start"], 0.0)
            self.assertEqual(evidence["end"], 2.0)
            self.assertEqual(evidence["selected_text"], "Hello world.")
            self.assertEqual(evidence["code_ids"], [])
            self.assertEqual(evidence["memo"], "Relevant opening statement.")
            self.assertEqual(len(created["project"]["evidence_items"]), 1)

    def test_create_evidence_stores_exact_ranges_and_creates_provisional_codes_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path)
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)

            created = create_evidence_item(
                {
                    "project": imported["project"],
                    "transcript_id": "T000001",
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": self.segment_ranges("Hello"),
                    "selected_text": "Hello",
                    "new_codes": [{
                        "client_id": "draft-code-1",
                        "name": "Greeting",
                        "color": "#123456",
                        "description": "A participant greeting.",
                        "inclusion_note": "Include explicit greetings.",
                        "exclusion_note": "Exclude general introductions.",
                        "memo": "Opening interaction.",
                        "use_current_evidence_as_example": True,
                    }],
                }
            )

            self.assertEqual(created["evidence"]["segment_ranges"], self.segment_ranges("Hello"))
            self.assertEqual(created["evidence"]["code_ids"], ["C000001"])
            self.assertEqual(created["created_codes"][0]["client_id"], "draft-code-1")
            self.assertEqual(created["created_codes"][0]["color"], "#123456")
            self.assertEqual(created["project"]["codes"][0]["name"], "Greeting")
            self.assertEqual(created["project"]["codes"][0]["description"], "A participant greeting.")
            self.assertEqual(created["project"]["codes"][0]["inclusion_note"], "Include explicit greetings.")
            self.assertEqual(created["project"]["codes"][0]["exclusion_note"], "Exclude general introductions.")
            self.assertEqual(created["project"]["codes"][0]["memo"], "Opening interaction.")
            self.assertEqual(created["project"]["codes"][0]["example_evidence_ids"], ["E000001"])
            project_path = Path(directory) / "anchored.evidence.json"
            project_path.write_text(json.dumps(created["project"]), encoding="utf-8")
            reopened = load_evidence_project({"project_file": str(project_path)})
            self.assertEqual(reopened["project"]["schema_version"], "1.1")
            self.assertEqual(reopened["project"]["evidence_items"][0]["segment_ranges"], self.segment_ranges("Hello"))

            with self.assertRaisesRegex(ValueError, "does not match source text"):
                create_evidence_item(
                    {
                        "project": imported["project"],
                        "transcript_id": "T000001",
                        "segment_ids": ["seg_000001"],
                        "segment_ranges": {"seg_000001": {"start_offset": 0, "end_offset": 5, "excerpt": "Nope!"}},
                        "selected_text": "Not in the transcript",
                    }
                )

            with self.assertRaisesRegex(ValueError, "outside the source segment"):
                create_evidence_item(
                    {
                        "project": imported["project"],
                        "transcript_id": "T000001",
                        "segment_ids": ["seg_000001"],
                        "segment_ranges": {
                            "seg_000001": {"start_offset": 0, "end_offset": 99, "excerpt": "Hello"}
                        },
                        "selected_text": "Hello",
                    }
                )

            with self.assertRaisesRegex(ValueError, "start offset must be an integer"):
                create_evidence_item(
                    {
                        "project": imported["project"],
                        "transcript_id": "T000001",
                        "segment_ids": ["seg_000001"],
                        "segment_ranges": {
                            "seg_000001": {"start_offset": 0.5, "end_offset": 5, "excerpt": "Hello"}
                        },
                        "selected_text": "Hello",
                    }
                )

            with self.assertRaisesRegex(ValueError, "source segments were not found"):
                create_evidence_item(
                    {
                        "project": imported["project"],
                        "transcript_id": "T000001",
                        "segment_ids": ["seg_000001", "seg_missing"],
                        "selected_text": "Hello",
                    }
                )

    def test_update_evidence_creates_provisional_codes_and_saves_changes_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path)
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)
            evidenced = create_evidence_item(
                {
                    "project": imported["project"],
                    "transcript_id": "T000001",
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": self.segment_ranges(),
                    "selected_text": "Hello world.",
                }
            )

            updated = update_evidence_item(
                {
                    "project": evidenced["project"],
                    "evidence_id": "E000001",
                    "memo": "Analytical note",
                    "code_ids": [],
                    "new_codes": [
                        {"client_id": "draft-1", "name": "Greeting", "color": "#445566"}
                    ],
                }
            )

            self.assertEqual(updated["evidence"]["memo"], "Analytical note")
            self.assertEqual(updated["evidence"]["code_ids"], ["C000001"])
            self.assertEqual(updated["created_codes"][0]["client_id"], "draft-1")
            self.assertEqual(updated["created_codes"][0]["name"], "Greeting")

            with self.assertRaisesRegex(ValueError, "already exists"):
                update_evidence_item(
                    {
                        "project": updated["project"],
                        "evidence_id": "E000001",
                        "memo": "Must not persist",
                        "new_codes": [
                            {"client_id": "draft-2", "name": "Greeting", "color": "#000000"}
                        ],
                    }
                )
            self.assertEqual(updated["evidence"]["memo"], "Analytical note")
            self.assertEqual(len(updated["project"]["codes"]), 1)

    def test_code_lifecycle_and_evidence_assignment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path)
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)
            coded = create_code(
                {
                    "project": imported["project"],
                    "name": "Uncertainty",
                    "description": "Mentions ambiguous customer needs.",
                    "inclusion_note": "Use when the speaker names uncertainty.",
                    "exclusion_note": "Do not use for confirmed customer needs.",
                    "color": "#AA5500",
                    "memo": "Initial code memo.",
                }
            )
            evidence_created = create_evidence_item(
                {
                    "project": coded["project"],
                    "transcript_id": "T000001",
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": self.segment_ranges(),
                    "selected_text": "Hello world.",
                    "code_ids": ["C000001"],
                }
            )
            evidence_updated = update_evidence_item(
                {
                    "project": evidence_created["project"],
                    "evidence_id": "E000001",
                    "memo": "Updated memo.",
                    "code_ids": [],
                }
            )
            code_updated = update_code(
                {
                    "project": evidence_updated["project"],
                    "code_id": "C000001",
                    "name": "Customer uncertainty",
                    "example_evidence_ids": ["E000001"],
                    "color": "#00AA66",
                }
            )

            self.assertEqual(coded["code"]["code_id"], "C000001")
            self.assertEqual(coded["code"]["color"], "#aa5500")
            self.assertEqual(coded["code"]["inclusion_note"], "Use when the speaker names uncertainty.")
            self.assertEqual(coded["code"]["exclusion_note"], "Do not use for confirmed customer needs.")
            self.assertEqual(evidence_created["evidence"]["code_ids"], ["C000001"])
            self.assertEqual(evidence_updated["evidence"]["code_ids"], [])
            self.assertEqual(evidence_updated["evidence"]["memo"], "Updated memo.")
            self.assertEqual(code_updated["code"]["name"], "Customer uncertainty")
            self.assertEqual(code_updated["code"]["example_evidence_ids"], ["E000001"])
            self.assertEqual(code_updated["code"]["color"], "#00aa66")
            self.assertEqual(code_updated["project"]["evidence_items"][0]["code_ids"], ["C000001"])

    def test_delete_code_removes_assignments_and_delete_evidence_removes_item(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path)
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)
            coded = create_code({"project": imported["project"], "name": "Uncertainty"})
            evidence_created = create_evidence_item(
                {
                    "project": coded["project"],
                    "transcript_id": "T000001",
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": self.segment_ranges(),
                    "selected_text": "Hello world.",
                    "code_ids": ["C000001"],
                }
            )
            example_updated = update_code({"project": evidence_created["project"], "code_id": "C000001", "example_evidence_ids": ["E000001"]})
            evidence_only_deleted = delete_evidence_item({"project": example_updated["project"], "evidence_id": "E000001"})
            self.assertEqual(evidence_only_deleted["project"]["codes"][0]["example_evidence_ids"], [])

            code_deleted = delete_code({"project": evidence_created["project"], "code_id": "C000001"})
            evidence_deleted = delete_evidence_item({"project": code_deleted["project"], "evidence_id": "E000001"})

            self.assertEqual(code_deleted["project"]["codes"], [])
            self.assertEqual(code_deleted["project"]["evidence_items"][0]["code_ids"], [])
            self.assertEqual(evidence_deleted["project"]["evidence_items"], [])

    def test_duplicate_code_names_are_rejected(self) -> None:
        project = create_evidence_project({"name": "Study"})["project"]
        created = create_code({"project": project, "name": "Uncertainty"})

        with self.assertRaisesRegex(ValueError, "already exists"):
            create_code({"project": created["project"], "name": " uncertainty "})

    def test_merge_code_reassigns_evidence_and_themes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "interview.json"
            self.write_app_json(transcript_path)
            project = create_evidence_project({"name": "Study"})["project"]
            imported = self.import_transcript(project, transcript_path)
            first_code = create_code({"project": imported["project"], "name": "Uncertainty", "description": "Source definition", "memo": "Source note"})
            second_code = create_code({"project": first_code["project"], "name": "Learning", "description": "Target definition", "memo": "Target note"})
            themed = create_theme({"project": second_code["project"], "name": "Market learning", "code_ids": ["C000001"]})
            evidenced = create_evidence_item(
                {
                    "project": themed["project"],
                    "transcript_id": "T000001",
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": self.segment_ranges(),
                    "selected_text": "Hello world.",
                    "code_ids": ["C000001"],
                }
            )

            with_example = update_code({"project": evidenced["project"], "code_id": "C000001", "example_evidence_ids": ["E000001"]})
            merged = merge_code({
                "project": with_example["project"],
                "source_code_id": "C000001",
                "target_code_id": "C000002",
                "description": "Target definition\n\nSource definition",
                "memo": "Target note\n\nSource note",
            })

            self.assertEqual([code["code_id"] for code in merged["project"]["codes"]], ["C000002"])
            self.assertEqual(merged["project"]["evidence_items"][0]["code_ids"], ["C000002"])
            self.assertEqual(merged["project"]["themes"][0]["code_ids"], ["C000002"])
            self.assertEqual(merged["target_code"]["example_evidence_ids"], ["E000001"])
            self.assertEqual(merged["target_code"]["description"], "Target definition\n\nSource definition")
            self.assertEqual(merged["target_code"]["memo"], "Target note\n\nSource note")

    def test_theme_lifecycle_and_delete_code_removes_theme_assignment(self) -> None:
        project = create_evidence_project({"name": "Study"})["project"]
        coded = create_code({"project": project, "name": "Uncertainty"})
        themed = create_theme(
            {
                "project": coded["project"],
                "name": "Market learning",
                "description": "How participants learn from customer signals.",
                "color": "#3344AA",
                "code_ids": ["C000001"],
                "memo": "Theme memo.",
            }
        )
        theme_updated = update_theme(
            {
                "project": themed["project"],
                "theme_id": "TH000001",
                "name": "Learning loops",
                "code_ids": [],
            }
        )
        theme_reassigned = update_theme(
            {
                "project": theme_updated["project"],
                "theme_id": "TH000001",
                "code_ids": ["C000001"],
            }
        )
        code_deleted = delete_code({"project": theme_reassigned["project"], "code_id": "C000001"})
        theme_deleted = delete_theme({"project": code_deleted["project"], "theme_id": "TH000001"})

        self.assertEqual(themed["theme"]["theme_id"], "TH000001")
        self.assertEqual(themed["theme"]["color"], "#3344aa")
        self.assertEqual(themed["theme"]["code_ids"], ["C000001"])
        self.assertEqual(theme_updated["theme"]["name"], "Learning loops")
        self.assertEqual(theme_updated["theme"]["code_ids"], [])
        self.assertEqual(code_deleted["project"]["themes"][0]["code_ids"], [])
        self.assertEqual(theme_deleted["project"]["themes"], [])

    def test_contextual_ai_decision_audit_is_stored(self) -> None:
        project = create_evidence_project({"name": "Study"})["project"]
        decision = record_ai_suggestion_decision(
            {
                "project": project,
                "run_id": "ai_run_001",
                "suggestion": {
                    "suggestion_id": "suggestion_001",
                    "run_id": "ai_run_001",
                    "task": "theme_suggestions",
                    "provider_id": "ollama",
                    "model_id": "llama3",
                },
                "decision": "accepted",
                "result_ids": ["TH000001"],
            }
        )

        self.assertEqual(decision["decision"]["suggestion_id"], "suggestion_001")
        self.assertEqual(decision["decision"]["run_id"], "ai_run_001")
        self.assertEqual(decision["decision"]["decision"], "accepted")
        self.assertEqual(decision["project"]["suggestion_decisions"][0]["result_ids"], ["TH000001"])

    def test_stored_report_draft_survives_load_and_compact_save(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_path = Path(directory) / "study.evidence.json"
            create_evidence_project({"project_file": str(project_path), "name": "Study"})
            stored = json.loads(project_path.read_text(encoding="utf-8"))
            stored["report_drafts"] = [
                {
                    "draft_id": "R000001",
                    "title": "Preliminary findings",
                    "body": "A short report draft.",
                    "source_suggestion_id": "suggestion_001",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "updated_at": "2026-01-01T00:00:00+00:00",
                }
            ]
            project_path.write_text(json.dumps(stored), encoding="utf-8")
            loaded = load_evidence_project({"project_file": str(project_path)})
            saved = save_evidence_project(
                {
                    "project_file": loaded["project_file"],
                    "source_project_file": loaded["project_file"],
                    "project_id": loaded["project_id"],
                    "expected_revision": loaded["revision"],
                    "project_updates": {"name": "Renamed Study"},
                }
            )
            reopened = load_evidence_project({"project_file": saved["project_file"]})

            self.assertEqual(reopened["project"]["name"], "Renamed Study")
            self.assertEqual(reopened["project"]["report_drafts"], loaded["project"]["report_drafts"])
            self.assertEqual(reopened["project"]["report_drafts"][0]["draft_id"], "R000001")

    def test_export_bundle_writes_valid_privacy_first_products(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript_path = root / "interview.json"
            self.write_app_json(transcript_path)
            project = create_evidence_project({"name": "Study", "research_focus": "How uncertainty is discussed."})["project"]
            imported = self.import_transcript(project, transcript_path)
            coded = create_code(
                {
                    "project": imported["project"],
                    "name": "Uncertainty",
                    "description": "Expressions of uncertainty.",
                    "inclusion_note": "Include explicit uncertainty.",
                    "memo": "Analytical code note.",
                }
            )
            themed = create_theme(
                {
                    "project": coded["project"],
                    "name": "Learning",
                    "description": "Learning through uncertainty.",
                    "code_ids": ["C000001"],
                    "memo": "Theme note.",
                }
            )
            created = create_evidence_item(
                {
                    "project": themed["project"],
                    "transcript_id": "T000001",
                    "segment_ids": ["seg_000001"],
                    "segment_ranges": self.segment_ranges(),
                    "selected_text": "Hello world.",
                    "code_ids": ["C000001"],
                    "memo": "Evidence note.",
                }
            )
            report_draft = {
                "draft_id": "R000001",
                "title": "Preliminary findings",
                "body": "Uncertainty shapes the participant's account.",
                "source_suggestion_id": "suggestion_001",
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-02T00:00:00+00:00",
            }
            created["project"]["report_drafts"] = [report_draft]
            output_path = root / "study_export.zip"

            exported = export_evidence_project_bundle(
                {
                    "project": created["project"],
                    "output_file": str(output_path),
                    "products": ["xlsx", "csv", "json", "docx", "qdpx"],
                    "docx_mode": "separate",
                    "include_local_paths": False,
                    "include_ai_audit": False,
                }
            )

            self.assertTrue(exported["bundle"]["exists"])
            self.assertTrue(exported["warnings"])
            with zipfile.ZipFile(output_path, "r") as archive:
                names = set(archive.namelist())
                self.assertIn("README.txt", names)
                self.assertIn("manifest.json", names)
                self.assertIn("analysis_workbook.xlsx", names)
                self.assertIn("structured_project.json", names)
                self.assertIn("csv/evidence_segments.csv", names)
                self.assertIn("csv/report_drafts.csv", names)
                self.assertIn("documents/codebook.docx", names)
                qdpx_name = next(name for name in names if name.endswith(".qdpx"))
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["export"]["app_version"], "1.0.0-beta.3")
                self.assertEqual(manifest["counts"]["report_drafts"], 1)
                self.assertIn("Transcript Research Studio", archive.read("README.txt").decode("utf-8"))
                structured = json.loads(archive.read("structured_project.json"))
                self.assertEqual(structured["project"]["transcripts"][0]["source_file"], "interview.json")
                self.assertEqual(structured["project"]["report_drafts"], [report_draft])
                self.assertNotIn("ai_settings", structured["project"])
                report_rows = list(
                    csv.DictReader(io.StringIO(archive.read("csv/report_drafts.csv").decode("utf-8")))
                )
                self.assertEqual(
                    report_rows,
                    [
                        {
                            "Draft ID": report_draft["draft_id"],
                            "Title": report_draft["title"],
                            "Body": report_draft["body"],
                            "Created At": report_draft["created_at"],
                            "Updated At": report_draft["updated_at"],
                        }
                    ],
                )
                with zipfile.ZipFile(io.BytesIO(archive.read(qdpx_name)), "r") as qdpx:
                    self.assertIn("project.qde", qdpx.namelist())
                    project_xml = qdpx.read("project.qde")
                    self.assertIn(b"PlainTextSelection", project_xml)
                    self.assertIn(b'origin="Transcript Research Studio"', project_xml)
                with zipfile.ZipFile(io.BytesIO(archive.read("analysis_workbook.xlsx")), "r") as workbook:
                    self.assertIn(b"Transcript Research Studio", workbook.read("docProps/core.xml"))
                    self.assertIn(b"Transcript Research Studio", workbook.read("docProps/app.xml"))

    def test_export_bundle_supports_empty_projects_and_optional_ai_audit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = create_evidence_project({"name": "Empty Study"})["project"]
            project["ai_settings"] = {
                "provider_id": "lmstudio",
                "model_id": "local-model",
                "temperature": 0,
                "timeout_seconds": 180,
                "access_token": "must-not-export",
            }
            project["ai_runs"] = [
                {
                    "run_id": "AIR000001",
                    "task": "evidence",
                    "provider": "lmstudio",
                    "model": "local-model",
                    "researcher_prompt": "Find relevant passages.",
                }
            ]

            private_path = root / "private.zip"
            export_evidence_project_bundle(
                {
                    "project": project,
                    "output_file": str(private_path),
                    "products": ["json", "qdpx"],
                    "include_local_paths": False,
                    "include_ai_audit": False,
                }
            )
            with zipfile.ZipFile(private_path, "r") as archive:
                structured = json.loads(archive.read("structured_project.json"))
                self.assertNotIn("ai_settings", structured["project"])
                self.assertNotIn("ai_runs", structured["project"])
                qdpx_name = next(name for name in archive.namelist() if name.endswith(".qdpx"))
                with zipfile.ZipFile(io.BytesIO(archive.read(qdpx_name)), "r") as qdpx:
                    self.assertIn("project.qde", qdpx.namelist())

            audit_path = root / "audit.zip"
            exported = export_evidence_project_bundle(
                {
                    "project": project,
                    "output_file": str(audit_path),
                    "products": ["json"],
                    "include_ai_audit": True,
                }
            )
            with zipfile.ZipFile(audit_path, "r") as archive:
                structured = json.loads(archive.read("structured_project.json"))
                self.assertEqual(structured["project"]["ai_settings"]["provider_id"], "lmstudio")
                self.assertEqual(structured["project"]["ai_runs"][0]["run_id"], "AIR000001")
                self.assertNotIn("access_token", structured["project"]["ai_settings"])
            self.assertTrue(any("AI audit" in warning for warning in exported["warnings"]))

    def test_qdpx_guids_are_deterministic_and_entity_scoped(self) -> None:
        first = stable_guid("P000001", "code", "C000001")
        self.assertEqual(first, stable_guid("P000001", "code", "C000001"))
        self.assertNotEqual(first, stable_guid("P000001", "theme", "C000001"))
        self.assertNotEqual(first, stable_guid("P000002", "code", "C000001"))


if __name__ == "__main__":
    unittest.main()
