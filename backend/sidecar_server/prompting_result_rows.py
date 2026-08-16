from __future__ import annotations

from .prompting_context import TaskContext
from .prompting_transcripts import TranscriptObject


def base_result_row(transcript: TranscriptObject, context: TaskContext) -> dict[str, object]:
    return {
        "transcript_id": transcript.transcript_id,
        "source_file": transcript.source_file,
        "model": context.model_id,
        "provider": context.provider_name,
        "run_timestamp": context.run_timestamp,
    }
