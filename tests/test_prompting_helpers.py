from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.prompting_outputs import write_preprocessing_outputs
from backend.sidecar_server.prompting_providers import (
    active_lm_studio_context_length,
    collect_lm_studio_chat_completion,
    collect_lm_studio_chat_stream,
    collect_ollama_chat_stream,
    detect_ollama,
    list_ollama_models,
    parse_sse_event,
    resolve_provider_context_policy,
    resolve_provider_context_window,
    run_provider_task_prompt,
)
from backend.sidecar_server.prompting_tables import load_table
from backend.sidecar_server.prompting_utils import (
    DEFAULT_PROMPT_TIMEOUT_SECONDS,
    calculate_progress,
    parse_prompt_timeout_seconds,
    parse_temperature,
    row_label,
    stringify_cell,
)


class PromptingHelperTests(unittest.TestCase):
    def test_temperature_progress_and_row_helpers(self) -> None:
        self.assertEqual(parse_temperature("1.234"), 1.23)
        self.assertEqual(parse_prompt_timeout_seconds(""), DEFAULT_PROMPT_TIMEOUT_SECONDS)
        self.assertEqual(parse_prompt_timeout_seconds("120.9"), 120)
        self.assertEqual(calculate_progress(completed=1, total=3), 33)
        self.assertEqual(row_label({"file_name": "clip.wav", "text": "Hello"}, 0, ["text"]), "clip.wav")
        self.assertEqual(row_label({"text": "A" * 100}, 0, ["text"]), "A" * 80)
        self.assertEqual(stringify_cell({"a": 1}), '{"a": 1}')

    def test_prompt_table_readers_load_csv_json_and_xlsx(self) -> None:
        rows = [{"file_name": "clip.wav", "text": "Hello", "summary": "Short"}]

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            csv_path = root / "source.csv"
            json_path = root / "source.json"
            csv_path.write_text("file_name,text,summary\nclip.wav,Hello,Short\n", encoding="utf-8")
            json_path.write_text(json.dumps({"rows": rows}), encoding="utf-8")
            written = write_preprocessing_outputs(
                output_folder=root,
                output_basename="source",
                output_formats=["xlsx"],
                results={"summary": rows},
                run_info={"status": "completed"},
            )
            xlsx_path = Path(written[0].path)

            self.assertEqual(load_table(csv_path)["rows"], rows)
            self.assertEqual(load_table(json_path)["rows"], rows)
            self.assertEqual(load_table(xlsx_path)["rows"], rows)

    @patch("backend.sidecar_server.prompting_providers.ollama_installed", return_value=True)
    @patch("backend.sidecar_server.prompting_providers.local_service_reachable", return_value=True)
    @patch("backend.sidecar_server.prompting_providers.http_json")
    def test_provider_detection_and_model_parsing(self, http_json, _reachable, _installed) -> None:
        http_json.return_value = {"models": [{"model": "llama3", "name": "llama3", "size": 1024, "details": {}}]}
        status = detect_ollama()
        self.assertTrue(status.available)
        self.assertEqual(status.model_count, 1)

        http_json.side_effect = [
            {"models": [{"model": "llama3", "name": "llama3", "size": 1024, "details": {}}]},
            {"models": [{"model": "llama3"}]},
        ]
        models = list_ollama_models()
        self.assertEqual(models[0].id, "llama3")
        self.assertTrue(models[0].is_loaded)

    @patch("backend.sidecar_server.prompting_providers.http_json")
    @patch("backend.sidecar_server.prompting_providers.http_json_lines")
    def test_provider_task_prompt_parses_ollama_and_lm_studio_payloads(self, http_json_lines, http_json) -> None:
        http_json_lines.return_value = [
            {"message": {"content": "res"}, "done": False},
            {"message": {"content": "ult"}, "done": True},
        ]
        self.assertEqual(
            run_provider_task_prompt(
                provider_id="ollama",
                model_id="llama3",
                system_prompt="You summarize.",
                user_prompt="Hello",
                temperature=0,
            ),
            "result",
        )
        ollama_body = http_json_lines.call_args.kwargs["body"]
        self.assertTrue(ollama_body["stream"])
        self.assertFalse(ollama_body["think"])
        self.assertNotIn("num_ctx", ollama_body["options"])
        self.assertEqual(ollama_body["model"], "llama3")
        self.assertEqual(ollama_body["options"]["temperature"], 0)

        http_json.return_value = {"choices": [{"message": {"content": "answer"}, "finish_reason": "stop"}]}
        self.assertEqual(
            run_provider_task_prompt(
                provider_id="lmstudio",
                model_id="local",
                system_prompt="You summarize.",
                user_prompt="Hello",
                temperature=0,
            ),
            "answer",
        )
        lm_studio_body = http_json.call_args.kwargs["body"]
        self.assertFalse(lm_studio_body["stream"])
        self.assertEqual(lm_studio_body["reasoning_effort"], "none")
        self.assertEqual(lm_studio_body["model"], "local")
        self.assertEqual(lm_studio_body["temperature"], 0)

    @patch("backend.sidecar_server.prompting_providers.http_json_lines")
    def test_ollama_task_prompt_can_request_context_window(self, http_json_lines) -> None:
        http_json_lines.return_value = [
            {"message": {"content": "answer"}, "done": True},
        ]

        self.assertEqual(
            run_provider_task_prompt(
                provider_id="ollama",
                model_id="llama3",
                system_prompt="You summarize.",
                user_prompt="Hello",
                temperature=0,
                context_window_tokens=4096,
                should_request_provider_context=True,
            ),
            "answer",
        )

        self.assertEqual(http_json_lines.call_args.kwargs["body"]["options"]["num_ctx"], 4096)

    @patch("backend.sidecar_server.prompting_providers.http_json_lines")
    def test_ollama_stream_keeps_partial_content_on_timeout(self, http_json_lines) -> None:
        def timeout_after_content():
            yield {"message": {"content": "partial answer"}, "done": False}
            raise TimeoutError("Provider request timed out.")

        http_json_lines.return_value = timeout_after_content()

        self.assertEqual(
            run_provider_task_prompt(
                provider_id="ollama",
                model_id="llama3",
                system_prompt="You summarize.",
                user_prompt="Hello",
                temperature=0,
            ),
            "partial answer",
        )

    @patch("backend.sidecar_server.prompting_providers.http_json_lines")
    def test_ollama_stream_reports_thinking_without_final_content(self, http_json_lines) -> None:
        http_json_lines.return_value = [
            {"message": {"thinking": "reasoning only"}, "done": False},
            {"done": True, "done_reason": "stop"},
        ]

        with self.assertRaisesRegex(RuntimeError, "produced reasoning but no final answer"):
            collect_ollama_chat_stream(body={"model": "thinking-model"}, timeout=30)

    @patch("backend.sidecar_server.prompting_providers.http_json_lines")
    def test_ollama_stream_reports_empty_content_metadata(self, http_json_lines) -> None:
        http_json_lines.return_value = [
            {"message": {}, "done": False},
            {"done": True, "done_reason": "stop"},
        ]

        with self.assertRaisesRegex(RuntimeError, "chunks=2"):
            collect_ollama_chat_stream(body={"model": "empty-model"}, timeout=30)

    @patch("backend.sidecar_server.prompting_providers.http_sse_events")
    def test_lm_studio_stream_uses_chat_end_fallback(self, http_sse_events) -> None:
        http_sse_events.return_value = [
            {
                "type": "chat.end",
                "data": {"result": {"output": [{"type": "message", "content": "final answer"}]}},
            }
        ]

        self.assertEqual(
            collect_lm_studio_chat_stream(body={"model": "local"}, timeout=30),
            "final answer",
        )

    @patch("backend.sidecar_server.prompting_providers.http_sse_events")
    def test_lm_studio_stream_keeps_partial_content_on_timeout(self, http_sse_events) -> None:
        def timeout_after_content():
            yield {"type": "message.delta", "data": {"content": "partial answer"}}
            raise TimeoutError("Provider request timed out.")

        http_sse_events.return_value = timeout_after_content()

        self.assertEqual(
            collect_lm_studio_chat_stream(body={"model": "local"}, timeout=30),
            "partial answer",
        )

    @patch("backend.sidecar_server.prompting_providers.http_json")
    def test_lm_studio_completion_reports_empty_content_metadata(self, http_json) -> None:
        http_json.return_value = {"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}

        with self.assertRaisesRegex(RuntimeError, "finish_reason=length"):
            collect_lm_studio_chat_completion(body={"model": "local"}, timeout=30)

    def test_lm_studio_active_context_uses_loaded_instance_config(self) -> None:
        self.assertEqual(
            active_lm_studio_context_length(
                {
                    "max_context_length": 262144,
                    "loaded_instances": [{"config": {"context_length": 4096}}],
                }
            ),
            4096,
        )
        self.assertIsNone(active_lm_studio_context_length({"loaded_instances": []}))

    @patch("backend.sidecar_server.prompting_providers.http_json")
    def test_resolve_provider_context_window_uses_lm_studio_active_context(self, http_json) -> None:
        http_json.return_value = {
            "models": [
                {"key": "other", "loaded_instances": [{"config": {"context_length": 8192}}]},
                {"key": "local", "loaded_instances": [{"config": {"context_length": 4096}}]},
            ]
        }

        self.assertEqual(resolve_provider_context_window("lmstudio", "local"), 4096)
        self.assertIsNone(resolve_provider_context_window("ollama", "llama3"))

    @patch("backend.sidecar_server.prompting_providers.http_json")
    def test_provider_context_policy_marks_sources(self, http_json) -> None:
        http_json.return_value = {
            "models": [
                {"key": "local", "loaded_instances": [{"config": {"context_length": 4096}}]},
            ]
        }

        lm_policy = resolve_provider_context_policy("lmstudio", "local")
        ollama_policy = resolve_provider_context_policy("ollama", "llama3")

        self.assertEqual(lm_policy.tokens, 4096)
        self.assertEqual(lm_policy.source, "lmstudio_active")
        self.assertFalse(lm_policy.should_request_provider_context)
        self.assertEqual(ollama_policy.tokens, 4096)
        self.assertEqual(ollama_policy.source, "ollama_assumed")
        self.assertFalse(ollama_policy.should_request_provider_context)

    def test_parse_sse_event_uses_event_type_and_json_data(self) -> None:
        self.assertEqual(
            parse_sse_event(event_type="message.delta", data_lines=['{"content":"hello"}']),
            {"content": "hello", "type": "message.delta", "data": {"content": "hello"}},
        )
