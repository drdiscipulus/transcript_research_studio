from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.prompting_analysis_tasks import (
    normalize_analysis_selection,
    run_selected_analysis,
)
from backend.sidecar_server.prompting import PromptingManager, prepare_preprocessing_run
from backend.sidecar_server.prompting_context import TaskContext
from backend.sidecar_server.prompting_custom_analyses import (
    create_custom_analysis,
    delete_custom_analysis,
    duplicate_custom_analysis,
    update_custom_analysis,
)
from backend.sidecar_server.prompting_transcripts import (
    TranscriptObject,
    TranscriptSegment,
    inspect_prompting_input,
    load_selected_transcript_objects,
)
from backend.sidecar_server.prompting_runtime import (
    append_prompt_log_event,
    initialize_prompt_log,
    write_prompt_log,
)
from backend.sidecar_server.prompting_types import PromptRunSnapshot


class PromptingAnalysisTests(unittest.TestCase):
    def test_analysis_output_name_is_derived_from_input_and_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "Founder Interview.json"
            source.write_text(json.dumps({
                "segments": [{"id": "seg_000001", "speaker": "Founder", "start": 0, "end": 3, "text": "We raised seed funding."}],
                "metadata": {"file_name": "Founder Interview.json"},
            }), encoding="utf-8")
            selected_candidate_ids = _ready_candidate_ids(source)

            with patch("backend.sidecar_server.prompting.validate_provider_model"):
                plan = prepare_preprocessing_run({
                    "provider_id": "lmstudio",
                    "model_id": "local-model",
                    "input_mode": "file",
                    "input_path": str(source),
                    "output_folder": str(root / "outputs"),
                    "output_formats": ["xlsx", "json"],
                    "analysis": {"type": "overview"},
                    "selected_candidate_ids": selected_candidate_ids,
                })

            self.assertEqual(plan["output_naming_mode"], "input")
            self.assertEqual(plan["output_basename"], "Founder_Interview_transcript_overview")

    def test_failed_provider_validation_does_not_create_output_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "interview.json"
            source.write_text(json.dumps({
                "segments": [{"id": "seg_000001", "text": "A valid transcript."}],
            }), encoding="utf-8")
            selected_candidate_ids = _ready_candidate_ids(source)
            output_folder = Path(directory) / "must-not-exist"
            with patch(
                "backend.sidecar_server.prompting.validate_provider_model",
                side_effect=ValueError("LM Studio is not reachable."),
            ):
                with self.assertRaisesRegex(ValueError, "not reachable"):
                    prepare_preprocessing_run({
                        "provider_id": "lmstudio",
                        "model_id": "local-model",
                        "input_mode": "file",
                        "input_path": str(source),
                        "output_folder": str(output_folder),
                        "output_formats": ["json"],
                        "analysis": {"type": "overview"},
                        "selected_candidate_ids": selected_candidate_ids,
                    })
            self.assertFalse(output_folder.exists())

    def test_missing_model_fails_before_run_thread_starts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "interview.json"
            source.write_text(json.dumps({
                "segments": [{"id": "seg_000001", "text": "A valid transcript."}],
            }), encoding="utf-8")
            selected_candidate_ids = _ready_candidate_ids(source)
            output_folder = Path(directory) / "must-not-exist"
            manager = PromptingManager()
            with (
                patch(
                    "backend.sidecar_server.prompting.validate_provider_model",
                    side_effect=ValueError(
                        'The selected model "missing-model" is no longer available in LM Studio.'
                    ),
                ),
                patch("backend.sidecar_server.prompting.threading.Thread") as worker_thread,
            ):
                with self.assertRaisesRegex(ValueError, "no longer available"):
                    manager.start_run({
                        "provider_id": "lmstudio",
                        "model_id": "missing-model",
                        "input_mode": "file",
                        "input_path": str(source),
                        "output_folder": str(output_folder),
                        "output_formats": ["json"],
                        "analysis": {"type": "overview"},
                        "selected_candidate_ids": selected_candidate_ids,
                    })
            worker_thread.assert_not_called()
            self.assertFalse(output_folder.exists())

    def test_candidate_selection_is_required_before_provider_contact_or_output_creation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "interview.json"
            source.write_text(json.dumps({
                "segments": [{"id": "seg_000001", "text": "A valid transcript."}],
            }), encoding="utf-8")

            malformed_selections = (
                ("absent", None, "Selected transcript candidate IDs must be a list."),
                ("non-list", "candidate_1", "Selected transcript candidate IDs must be a list."),
                ("null-element", [None], "Selected transcript candidate IDs must be non-empty strings."),
                ("number-element", [7], "Selected transcript candidate IDs must be non-empty strings."),
                ("object-element", [{"private": "must not be exposed"}], "Selected transcript candidate IDs must be non-empty strings."),
                ("blank-element", ["   "], "Selected transcript candidate IDs must be non-empty strings."),
            )
            for label, selected_candidate_ids, expected_error in malformed_selections:
                with self.subTest(label=label):
                    output_folder = root / f"output-{label}"
                    payload = {
                        "provider_id": "lmstudio",
                        "model_id": "local-model",
                        "input_mode": "file",
                        "input_path": str(source),
                        "output_folder": str(output_folder),
                        "output_formats": ["json"],
                        "analysis": {"type": "overview"},
                    }
                    if label != "absent":
                        payload["selected_candidate_ids"] = selected_candidate_ids

                    with patch("backend.sidecar_server.prompting.validate_provider_model") as validate_provider:
                        with self.assertRaises(ValueError) as raised:
                            prepare_preprocessing_run(payload)

                    self.assertEqual(str(raised.exception), expected_error)
                    validate_provider.assert_not_called()
                    self.assertFalse(output_folder.exists())

            empty_output_folder = root / "output-empty"
            with patch("backend.sidecar_server.prompting.validate_provider_model") as validate_provider:
                with self.assertRaisesRegex(ValueError, "Select at least one ready transcript candidate"):
                    prepare_preprocessing_run({
                        "provider_id": "lmstudio",
                        "model_id": "local-model",
                        "input_mode": "file",
                        "input_path": str(source),
                        "output_folder": str(empty_output_folder),
                        "output_formats": ["json"],
                        "analysis": {"type": "overview"},
                        "selected_candidate_ids": [],
                    })
            validate_provider.assert_not_called()
            self.assertFalse(empty_output_folder.exists())

            valid_output_folder = root / "output-valid"
            selected_candidate_ids = _ready_candidate_ids(source)
            with patch("backend.sidecar_server.prompting.validate_provider_model") as validate_provider:
                plan = prepare_preprocessing_run({
                    "provider_id": "lmstudio",
                    "model_id": "local-model",
                    "input_mode": "file",
                    "input_path": str(source),
                    "output_folder": str(valid_output_folder),
                    "output_formats": ["json"],
                    "analysis": {"type": "overview"},
                    "selected_candidate_ids": selected_candidate_ids,
                })
            validate_provider.assert_called_once_with("lmstudio", "local-model")
            self.assertEqual(len(plan["transcripts"]), 1)
            self.assertTrue(valid_output_folder.is_dir())

    def test_preview_isolates_corrupt_files_and_requires_duplicate_choice(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "interview.json").write_text(json.dumps({
                "segments": [{"id": "seg_000001", "speaker": "SPEAKER_00", "start": 0, "end": 2, "text": "Hello world"}],
                "speakers": [{"id": "SPEAKER_00", "name": "SPEAKER_00"}],
                "metadata": {"file_name": "interview.wav"},
            }), encoding="utf-8")
            (root / "interview.csv").write_text("text,speaker\nHello world,SPEAKER_00\n", encoding="utf-8")
            (root / "broken.json").write_text("{", encoding="utf-8")

            preview = inspect_prompting_input({"input_mode": "folder", "input_path": str(root)})
            self.assertEqual(preview["counts"]["decisions_required"], 1)
            self.assertEqual(preview["counts"]["problems"], 1)
            equivalents = [item for item in preview["candidates"] if item["status"] == "equivalent_format"]
            self.assertEqual(len(equivalents), 2)
            self.assertTrue(next(item for item in equivalents if item["format"] == "json")["recommended"])

            with self.assertRaisesRegex(ValueError, "Choose one transcript representation"):
                load_selected_transcript_objects({
                    "input_mode": "folder",
                    "input_path": str(root),
                    "selected_candidate_ids": [],
                })

            selected_json = next(item["candidate_id"] for item in equivalents if item["format"] == "json")
            transcripts, intake = load_selected_transcript_objects({
                "input_mode": "folder",
                "input_path": str(root),
                "selected_candidate_ids": [selected_json],
            })
            self.assertEqual(len(transcripts), 1)
            self.assertEqual(len(intake["excluded"]), 2)

    def test_candidate_selection_rejects_empty_stale_and_nonselectable_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ready_source = root / "ready.json"
            ready_source.write_text(json.dumps({
                "segments": [{"id": "seg_000001", "text": "A valid transcript."}],
            }), encoding="utf-8")
            broken_source = root / "broken.json"
            broken_source.write_text("{", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Select at least one ready transcript candidate"):
                load_selected_transcript_objects({
                    "input_mode": "file",
                    "input_path": str(ready_source),
                    "selected_candidate_ids": [],
                })

            with self.assertRaisesRegex(ValueError, "preview is stale"):
                load_selected_transcript_objects({
                    "input_mode": "file",
                    "input_path": str(ready_source),
                    "selected_candidate_ids": ["candidate_from_an_older_preview"],
                })

            broken_preview = inspect_prompting_input({
                "input_mode": "file",
                "input_path": str(broken_source),
            })
            problem_candidate_id = broken_preview["candidates"][0]["candidate_id"]
            with self.assertRaisesRegex(ValueError, "preview is stale"):
                load_selected_transcript_objects({
                    "input_mode": "file",
                    "input_path": str(broken_source),
                    "selected_candidate_ids": [problem_candidate_id],
                })

    def test_research_findings_require_exact_unambiguous_excerpt(self) -> None:
        transcript = sample_transcript()
        responses = iter([
            json.dumps({
                "findings": [
                    {
                        "finding": "The participant discusses funding.",
                        "relevance": "Relevant to resource acquisition.",
                        "qualification": "One interview only.",
                        "segment_id": "seg_000001",
                        "supporting_excerpt": "We raised seed funding.",
                    },
                    {
                        "finding": "Invalid",
                        "relevance": "Invalid",
                        "qualification": "",
                        "segment_id": "seg_000001",
                        "supporting_excerpt": "Not in the source",
                    },
                ],
                "missing_aspects": ["Later funding rounds"],
            })
        ])
        context = sample_context(lambda **_: next(responses))
        selection = normalize_analysis_selection({
            "type": "research_focus",
            "research_focus": "How do founders acquire resources?",
            "prompt": "Analyze resource acquisition.",
        })
        results = run_selected_analysis(transcript, selection, context)
        self.assertEqual(len(results["research_focus"]), 1)
        self.assertEqual(results["research_focus"][0]["verification_status"], "exact_match")
        self.assertEqual(results["research_focus"][0]["segment_id"], "seg_000001")
        self.assertEqual(len(results["_warnings"]), 1)

    def test_interview_review_discards_honesty_judgments(self) -> None:
        transcript = sample_transcript()
        context = sample_context(lambda **_: json.dumps({
            "issues": [
                {
                    "category": "unclear_passage",
                    "description": "This statement is dishonest.",
                    "segment_id": "seg_000001",
                    "supporting_excerpt": "We raised seed funding.",
                },
                {
                    "category": "incomplete_answer",
                    "description": "The response ends before explaining the source.",
                    "segment_id": "seg_000001",
                    "supporting_excerpt": "We raised seed funding.",
                },
            ]
        }))
        selection = normalize_analysis_selection({"type": "interview_review", "prompt": "Review the interview."})
        results = run_selected_analysis(transcript, selection, context)
        self.assertEqual(len(results["interview_review"]), 1)
        self.assertEqual(results["interview_review"][0]["category"], "incomplete_answer")
        self.assertIn("prohibited honesty", results["_warnings"][0])

    def test_malformed_structured_response_fails_instead_of_silently_succeeding(self) -> None:
        transcript = sample_transcript()
        context = sample_context(lambda **_: "not valid JSON")
        selection = normalize_analysis_selection({"type": "overview", "prompt": "Summarize."})
        with self.assertRaisesRegex(ValueError, "malformed structured analysis"):
            run_selected_analysis(transcript, selection, context)

    def test_custom_analysis_library_crud_is_atomic_and_named(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch("backend.sidecar_server.prompting_custom_analyses.config_dir", return_value=root),
                patch("backend.sidecar_server.prompting_custom_analyses.ensure_app_runtime_directories", return_value={}),
            ):
                created = create_custom_analysis({"name": "Opportunity Framing", "instructions": "Analyze opportunity framing."})
                analysis_id = created["analysis"]["id"]
                self.assertEqual(created["analysis"]["output_key"], "opportunity_framing")
                updated = update_custom_analysis({"id": analysis_id, "name": "Opportunity Claims", "instructions": "Analyze claims."})
                self.assertEqual(updated["analysis"]["name"], "Opportunity Claims")
                duplicated = duplicate_custom_analysis({"id": analysis_id})
                self.assertEqual(len(duplicated["analyses"]), 2)
                deleted = delete_custom_analysis({"id": duplicated["analysis"]["id"]})
                self.assertEqual(len(deleted["analyses"]), 1)

    def test_run_log_is_incremental_and_omits_researcher_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log_file = Path(directory) / "analysis.prompt.log"
            snapshot = PromptRunSnapshot(
                run_id="run_1", status="running", message="Running", progress_percent=0,
                started_at="2026-01-01T00:00:00Z", finished_at=None,
                provider_id="lmstudio", provider_name="LM Studio", model_id="test-model",
                log_file=str(log_file), counts={"done": 0, "failed": 0, "excluded": 0},
                input_mode="file", input_path="D:/research/interview.json",
            )
            plan = {
                "temperature": 0,
                "timeout_seconds": 180,
                "provider_context": {"tokens": 4096, "source": "test"},
                "chunk_max_characters": 8000,
                "selected_tasks": ["overview"],
                "analysis_selection": {"name": "Transcript Overview", "prompt": "PRIVATE RESEARCHER PROMPT"},
                "transcripts": [sample_transcript()],
                "exclusions": [],
            }
            initialize_prompt_log(log_file=log_file, snapshot=snapshot, plan=plan)
            append_prompt_log_event(log_file, "TRANSCRIPT COMPLETED", transcript_id="founder_interview", results=1)
            snapshot.status = "completed"
            snapshot.finished_at = "2026-01-01T00:01:00Z"
            write_prompt_log(log_file=log_file, snapshot=snapshot, plan=plan)

            text = log_file.read_text(encoding="utf-8")
            self.assertIn("RUN STARTED", text)
            self.assertIn("TRANSCRIPT COMPLETED", text)
            self.assertIn("FINAL SUMMARY", text)
            self.assertNotIn("PRIVATE RESEARCHER PROMPT", text)


def sample_transcript() -> TranscriptObject:
    segment = TranscriptSegment(
        segment_id="seg_000001",
        speaker="Founder",
        start=0,
        end=3,
        text="We raised seed funding.",
    )
    return TranscriptObject(
        transcript_id="founder_interview",
        source_file="founder.json",
        segments=[segment],
        full_text="Founder: We raised seed funding.",
        metadata={"file_name": "founder.json"},
    )


def _ready_candidate_ids(source: Path) -> list[str]:
    preview = inspect_prompting_input({"input_mode": "file", "input_path": str(source)})
    return [
        str(candidate["candidate_id"])
        for candidate in preview["candidates"]
        if candidate["status"] in {"ready", "equivalent_format"}
    ]


def sample_context(runner) -> TaskContext:
    return TaskContext(
        provider_id="lmstudio",
        provider_name="LM Studio",
        model_id="test-model",
        temperature=0,
        timeout_seconds=180,
        run_timestamp="2026-01-01T00:00:00Z",
        prompt_runner=runner,
        chunk_max_characters=10_000,
    )


if __name__ == "__main__":
    unittest.main()
