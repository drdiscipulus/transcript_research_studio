from __future__ import annotations

import csv
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.export_docx import write_docx
from backend.sidecar_server.export_table_formats import write_xlsx
from backend.sidecar_server.prompting_outputs import write_preprocessing_outputs
from backend.sidecar_server.prompting_prompt_templates import (
    prompt_templates_payload,
    revert_prompt_template_override,
    save_prompt_template_override,
)
from backend.sidecar_server.prompting_tasks import (
    MIN_CHUNK_CHARACTERS,
    TaskContext,
    adaptive_chunk_character_budget,
    chunk_transcript_text,
    execute_preprocessing_tasks,
    is_context_window_error,
    run_diagnostics_task,
    run_quote_task,
    selected_task_names,
    verify_quote,
)
from backend.sidecar_server.prompting_tasks import run_custom_prompt_task, run_summary_task
from backend.sidecar_server.prompting_transcripts import TranscriptObject, TranscriptSegment, load_transcript_objects


def _context() -> TaskContext:
    return TaskContext(
        provider_id="ollama",
        provider_name="Ollama",
        model_id="llama3",
        temperature=0,
        timeout_seconds=180,
        run_timestamp="2026-05-26T12:00:00",
        prompt_runner=lambda **_: '[{"quote":"Hello world","speaker":"Speaker 1","timestamp":"00:00:01","reason":"Matches topic"}]',
    )


class PromptingPreprocessingTests(unittest.TestCase):
    def test_adaptive_chunk_budget_scales_conservatively(self) -> None:
        budget_4096 = adaptive_chunk_character_budget(4096)
        budget_8192 = adaptive_chunk_character_budget(8192)
        budget_16384 = adaptive_chunk_character_budget(16384)

        self.assertGreaterEqual(budget_4096, 4500)
        self.assertLessEqual(budget_4096, 5500)
        self.assertGreater(budget_8192, budget_4096)
        self.assertEqual(budget_16384, 12000)
        self.assertEqual(adaptive_chunk_character_budget(None), budget_4096)

    def test_chunking_splits_oversized_single_segment(self) -> None:
        transcript = TranscriptObject(
            transcript_id="one",
            source_file="source.csv",
            segments=[
                TranscriptSegment(
                    segment_id="seg_000001",
                    speaker="Speaker 1",
                    start=0,
                    end=1,
                    text=" ".join(["word"] * 2000),
                )
            ],
            full_text=" ".join(["word"] * 2000),
        )

        chunks = chunk_transcript_text(transcript, max_characters=MIN_CHUNK_CHARACTERS)

        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= MIN_CHUNK_CHARACTERS + 100 for chunk in chunks))
        self.assertTrue(all("seg_000001" in chunk for chunk in chunks))

    def test_context_window_error_detection_matches_provider_messages(self) -> None:
        self.assertTrue(is_context_window_error(RuntimeError("n_keep: 4918>= n_ctx: 4096")))
        self.assertTrue(is_context_window_error(RuntimeError("prompt is too long for num_ctx")))
        self.assertFalse(is_context_window_error(RuntimeError("provider timed out")))

    def test_context_error_retries_task_with_smaller_chunks(self) -> None:
        calls = 0

        def runner(**kwargs: object) -> str:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("n_keep: 4918>= n_ctx: 4096")
            return '{"short_summary":"Retried summary."}'

        transcript = TranscriptObject(
            transcript_id="one",
            source_file="source.csv",
            segments=[
                TranscriptSegment(
                    segment_id=f"seg_{index:06d}",
                    speaker="Speaker 1",
                    start=float(index),
                    end=float(index + 1),
                    text=" ".join(["word"] * 120),
                )
                for index in range(12)
            ],
            full_text=" ".join(["word"] * 1440),
        )
        context = TaskContext(
            provider_id="lmstudio",
            provider_name="LM Studio",
            model_id="local",
            temperature=0,
            timeout_seconds=180,
            run_timestamp="2026-05-26T12:00:00",
            prompt_runner=runner,
            context_window_tokens=4096,
            chunk_max_characters=6000,
        )

        results = execute_preprocessing_tasks(
            transcripts=[transcript],
            tasks={"summary": {"enabled": True, "components": {"short_summary": True}}},
            context=context,
        )

        self.assertEqual(results["summary"][0]["short_summary"], "Retried summary.")
        self.assertGreater(calls, 1)

    def test_llm_diagnostics_scan_all_chunks_and_dedupe(self) -> None:
        prompts: list[str] = []

        def runner(**kwargs: object) -> str:
            prompt = str(kwargs["user_prompt"])
            prompts.append(prompt)
            if "seg_000001" in prompt:
                return json.dumps(
                    [
                        {
                            "issue_type": "broken_or_unclear_passages",
                            "segment_id": "seg_000001",
                            "excerpt": "First chunk",
                            "recommendation": "Review first chunk.",
                            "severity": "low",
                        }
                    ]
                )
            return json.dumps(
                [
                    {
                        "issue_type": "possible_speaker_inconsistency",
                        "segment_id": "seg_000020",
                        "excerpt": "Later chunk",
                        "recommendation": "Review later chunk.",
                        "severity": "medium",
                    },
                    {
                        "issue_type": "possible_speaker_inconsistency",
                        "segment_id": "seg_000020",
                        "excerpt": "Later chunk",
                        "recommendation": "Duplicate should be removed.",
                        "severity": "medium",
                    },
                ]
            )

        transcript = TranscriptObject(
            transcript_id="one",
            source_file="source.csv",
            segments=[
                TranscriptSegment(
                    segment_id=f"seg_{index:06d}",
                    speaker="Speaker 1",
                    start=float(index),
                    end=float(index + 1),
                    text=" ".join(["word"] * 70),
                )
                for index in range(1, 28)
            ],
            full_text=" ".join(["word"] * 1890),
        )
        context = TaskContext(
            provider_id="ollama",
            provider_name="Ollama",
            model_id="llama3",
            temperature=0,
            timeout_seconds=180,
            run_timestamp="2026-05-26T12:00:00",
            prompt_runner=runner,
            chunk_max_characters=2500,
        )

        rows = run_diagnostics_task(
            transcript,
            {
                "enabled": True,
                "components": {
                    "broken_or_unclear_passages": True,
                    "possible_speaker_inconsistency": True,
                },
            },
            context,
        )

        self.assertGreater(len(prompts), 1)
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["segment_id"] for row in rows}, {"seg_000001", "seg_000020"})
        self.assertTrue(all(row["detection_method"] == "llm" for row in rows))

    def test_llm_diagnostics_row_cap_is_enforced(self) -> None:
        transcript = TranscriptObject(
            transcript_id="one",
            source_file="source.csv",
            segments=[
                TranscriptSegment(
                    segment_id=f"seg_{index:06d}",
                    speaker="Speaker 1",
                    start=float(index),
                    end=float(index + 1),
                    text="Review this passage.",
                )
                for index in range(80)
            ],
            full_text=" ".join(["Review this passage."] * 80),
        )

        def runner(**_: object) -> str:
            return json.dumps(
                [
                    {
                        "issue_type": "broken_or_unclear_passages",
                        "segment_id": f"seg_{index:06d}",
                        "excerpt": f"Excerpt {index}",
                        "recommendation": "Review.",
                        "severity": "low",
                    }
                    for index in range(80)
                ]
            )

        context = TaskContext(
            provider_id="ollama",
            provider_name="Ollama",
            model_id="llama3",
            temperature=0,
            timeout_seconds=180,
            run_timestamp="2026-05-26T12:00:00",
            prompt_runner=runner,
        )

        rows = run_diagnostics_task(
            transcript,
            {"enabled": True, "components": {"broken_or_unclear_passages": True}},
            context,
        )

        self.assertEqual(len(rows), 50)

    def test_rule_only_diagnostics_do_not_call_llm(self) -> None:
        def runner(**_: object) -> str:
            raise AssertionError("Rule-only diagnostics should not call the provider.")

        transcript = TranscriptObject(
            transcript_id="one",
            source_file="source.csv",
            segments=[TranscriptSegment(segment_id="seg_000001", speaker="", start=None, end=None, text="")],
            full_text="",
        )
        context = TaskContext(
            provider_id="ollama",
            provider_name="Ollama",
            model_id="llama3",
            temperature=0,
            timeout_seconds=180,
            run_timestamp="2026-05-26T12:00:00",
            prompt_runner=runner,
        )

        rows = run_diagnostics_task(
            transcript,
            {
                "enabled": True,
                "components": {
                    "missing_speaker_labels": True,
                    "missing_timestamps": True,
                    "empty_text_segments": True,
                },
            },
            context,
        )

        self.assertEqual(len(rows), 3)

    def test_normalizes_app_json_and_edited_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_json = root / "app.json"
            app_json.write_text(
                json.dumps(
                    {
                        "documents": [
                            {
                                "file_name": "interview_01.mp3",
                                "segments": [
                                    {"start_seconds": 1, "end_seconds": 2, "speaker": "Speaker 1", "text": "Hello."}
                                ],
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            edited_json = root / "edited.json"
            edited_json.write_text(
                json.dumps(
                    {
                        "source_transcript_file": str(app_json),
                        "speakers": [{"id": "SPEAKER_00", "name": "Interviewer"}],
                        "segments": [{"id": "seg_000001", "speaker": "SPEAKER_00", "start": 0, "end": 1, "text": "Hi."}],
                    }
                ),
                encoding="utf-8",
            )

            app_transcripts = load_transcript_objects({"input_mode": "file", "input_path": str(app_json)})
            edited_transcripts = load_transcript_objects({"input_mode": "file", "input_path": str(edited_json)})

            self.assertEqual(app_transcripts[0].transcript_id, "interview_01")
            self.assertEqual(app_transcripts[0].segments[0].speaker, "SPEAKER_01")
            self.assertEqual(edited_transcripts[0].segments[0].speaker, "Interviewer")

    def test_normalizes_table_mapping_and_docx(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            csv_path = root / "rows.csv"
            csv_path.write_text(
                "transcript_id,speaker,start,end,text\none,A,0,1,Hello\none,B,1,2,World\ntwo,A,0,1,Other\n",
                encoding="utf-8",
            )
            docx_path = root / "app.docx"
            write_docx(docx_path, ["Interview", "[00:00:01 - 00:00:02] Speaker 1: Hello world"])

            table_transcripts = load_transcript_objects({"input_mode": "file", "input_path": str(csv_path)})
            docx_transcripts = load_transcript_objects({"input_mode": "file", "input_path": str(docx_path)})

            self.assertEqual([item.transcript_id for item in table_transcripts], ["one", "two"])
            self.assertEqual(table_transcripts[0].segments[1].speaker, "B")
            self.assertEqual(docx_transcripts[0].segments[0].start, 1.0)
            self.assertEqual(docx_transcripts[0].segments[0].speaker, "SPEAKER_01")

    def test_quote_verification_and_output_package(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.csv"
            source.write_text("text\nHello world\n", encoding="utf-8")
            transcript = load_transcript_objects({"input_mode": "file", "input_path": str(source), "advanced_mapping": {"text_column": "text"}})[0]

            self.assertEqual(verify_quote("Hello world", transcript.full_text), "verified")
            self.assertEqual(verify_quote("Invented sentence", transcript.full_text), "not_verified")
            quote_rows = run_quote_task(
                transcript,
                {
                    "enabled": True,
                    "topic": "greeting",
                    "components": {"quote_candidates": True, "verify_quote_text": True},
                },
                _context(),
            )
            self.assertEqual(quote_rows[0]["verification_status"], "verified")

            outputs = write_preprocessing_outputs(
                output_folder=root,
                output_basename="results",
                output_formats=["xlsx", "csv", "json", "docx"],
                results={"summary": [], "quotes": quote_rows, "diagnostics": [], "custom_prompt": []},
                run_info={"run_timestamp": "now", "status": "completed"},
            )
            self.assertTrue((root / "results.xlsx").exists())
            self.assertTrue((root / "results_quotes.csv").exists())
            self.assertTrue((root / "results_run_info.csv").exists())
            self.assertTrue((root / "results.json").exists())
            self.assertTrue((root / "results.docx").exists())
            with zipfile.ZipFile(root / "results.xlsx", "r") as workbook:
                workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")
                core_properties = workbook.read("docProps/core.xml").decode("utf-8")
                app_properties = workbook.read("docProps/app.xml").decode("utf-8")
            self.assertIn("Quotes", workbook_xml)
            self.assertIn("Run Info", workbook_xml)
            self.assertIn("Transcript Research Studio Transcript Analysis Output", core_properties)
            self.assertIn("Transcript Research Studio", app_properties)
            self.assertEqual({item.format for item in outputs}, {"xlsx", "csv", "json", "docx"})

    def test_xlsx_table_input_uses_first_sheet(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            xlsx_path = root / "rows.xlsx"
            write_xlsx(xlsx_path, ["transcript_id", "text"], [{"transcript_id": "one", "text": "Hello"}])

            transcripts = load_transcript_objects({"input_mode": "file", "input_path": str(xlsx_path)})

            self.assertEqual(transcripts[0].transcript_id, "one")
            self.assertEqual(transcripts[0].segments[0].text, "Hello")

    def test_prompt_template_overrides_can_be_saved_and_reverted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch("backend.sidecar_server.prompting_prompt_templates.config_dir", return_value=root),
                patch("backend.sidecar_server.prompting_prompt_templates.ensure_app_runtime_directories", return_value={}),
            ):
                saved = save_prompt_template_override(
                    {"template_id": "summary.short_summary", "prompt_text": "Custom summary prompt."}
                )
                option = saved["tasks"]["summary"]["options"]["short_summary"]
                self.assertEqual(option["current_prompt"], "Custom summary prompt.")
                self.assertTrue(option["has_permanent_override"])

                reverted = revert_prompt_template_override({"template_id": "summary.short_summary"})
                option = reverted["tasks"]["summary"]["options"]["short_summary"]
                self.assertEqual(option["current_prompt"], option["default_prompt"])
                self.assertFalse(option["has_permanent_override"])

                catalog = prompt_templates_payload()
                self.assertIn("diagnostics", catalog["tasks"])

    def test_run_only_summary_prompt_override_is_used(self) -> None:
        captured_prompts: list[str] = []

        def runner(**kwargs: object) -> str:
            captured_prompts.append(str(kwargs["user_prompt"]))
            return '{"short_summary":"Short summary."}'

        context = TaskContext(
            provider_id="ollama",
            provider_name="Ollama",
            model_id="llama3",
            temperature=0,
            timeout_seconds=180,
            run_timestamp="2026-05-26T12:00:00",
            prompt_runner=runner,
        )
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.csv"
            source.write_text("text\nHello world\n", encoding="utf-8")
            transcript = load_transcript_objects({"input_mode": "file", "input_path": str(source), "advanced_mapping": {"text_column": "text"}})[0]

            rows = run_summary_task(
                transcript,
                {
                    "enabled": True,
                    "components": {"short_summary": True, "main_topics": False, "keywords": False},
                    "prompt_overrides": {"short_summary": "Use exactly this custom summary instruction."},
                },
                context,
            )

            self.assertEqual(rows[0]["short_summary"], "Short summary.")
            self.assertIn("Use exactly this custom summary instruction.", captured_prompts[0])

    def test_multiple_custom_prompts_emit_multiple_rows(self) -> None:
        context = TaskContext(
            provider_id="ollama",
            provider_name="Ollama",
            model_id="llama3",
            temperature=0,
            timeout_seconds=180,
            run_timestamp="2026-05-26T12:00:00",
            prompt_runner=lambda **kwargs: f"Result for {str(kwargs['user_prompt']).splitlines()[0]}",
        )
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.csv"
            source.write_text("text\nHello world\n", encoding="utf-8")
            transcript = load_transcript_objects({"input_mode": "file", "input_path": str(source), "advanced_mapping": {"text_column": "text"}})[0]

            rows = run_custom_prompt_task(
                transcript,
                {
                    "enabled": True,
                    "prompts": [
                        {"enabled": True, "label": "A", "result_label": "a_result", "prompt_text": "Prompt A"},
                        {"enabled": True, "label": "B", "result_label": "b_result", "prompt_text": "Prompt B"},
                    ],
                },
                context,
            )

            self.assertEqual([row["custom_prompt_label"] for row in rows], ["A", "B"])
            self.assertEqual([row["result_label"] for row in rows], ["a_result", "b_result"])

    def test_task_enablement_requires_selected_options(self) -> None:
        self.assertEqual(
            selected_task_names(
                {
                    "summary": {"enabled": True, "components": {}},
                    "quotes": {
                        "enabled": True,
                        "topic": "trust",
                        "components": {"include_speaker_timestamp": True},
                    },
                    "diagnostics": {"enabled": True, "components": {}},
                    "custom_prompt": {
                        "enabled": True,
                        "prompts": [{"enabled": True, "prompt_text": ""}],
                    },
                }
            ),
            [],
        )
        self.assertEqual(
            selected_task_names(
                {
                    "summary": {"enabled": True, "components": {"short_summary": True}},
                    "quotes": {
                        "enabled": True,
                        "topic": "trust",
                        "components": {"quote_candidates": True},
                    },
                    "diagnostics": {"enabled": True, "components": {"missing_timestamps": True}},
                    "custom_prompt": {
                        "enabled": True,
                        "prompts": [{"enabled": True, "prompt_text": "Summarize this."}],
                    },
                }
            ),
            ["summary", "quotes", "diagnostics", "custom_prompt"],
        )


if __name__ == "__main__":
    unittest.main()
