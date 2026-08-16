import type { EditorSpeaker, EditorTranscript } from "./api";

export type EditorSegment = EditorTranscript["segments"][number];

export function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? path;
}

export function fileStem(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, "") || "edited_transcript";
}

export function folderName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) {
    return "";
  }
  if (index === 0 || (index === 2 && /^[a-z]:\//i.test(normalized))) {
    return path.slice(0, index + 1);
  }
  return path.slice(0, index);
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function formatSeconds(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "--:--:--";
  }
  const totalSeconds = Math.max(0, Math.round(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function buildSpeakerNameMap(speakers: EditorSpeaker[]): Record<string, string> {
  return speakers.reduce<Record<string, string>>((accumulator, speaker) => {
    accumulator[speaker.id] = speaker.name || speaker.id;
    return accumulator;
  }, {});
}

const speakerDisplayCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base"
});

export function sortSpeakersForDisplay(speakers: EditorSpeaker[]): EditorSpeaker[] {
  return [...speakers].sort((left, right) => speakerDisplayCollator.compare(left.id, right.id));
}

export function renumberSegments(transcript: EditorTranscript): EditorTranscript {
  return {
    ...transcript,
    segments: transcript.segments.map((segment, index) => ({
      ...segment,
      id: `seg_${String(index + 1).padStart(6, "0")}`
    }))
  };
}

export function segmentHasPlayableTimestamps(segment: EditorSegment): boolean {
  return segment.start !== null && segment.end !== null && segment.end > segment.start;
}

export function updateSegmentAt(
  transcript: EditorTranscript,
  index: number,
  patch: Partial<EditorSegment>
): EditorTranscript {
  return {
    ...transcript,
    segments: transcript.segments.map((segment, segmentIndex) =>
      segmentIndex === index ? { ...segment, ...patch } : segment
    )
  };
}

export function deleteSegmentAt(transcript: EditorTranscript, index: number): EditorTranscript {
  if (transcript.segments.length <= 1 || index < 0 || index >= transcript.segments.length) {
    return transcript;
  }
  return renumberSegments({
    ...transcript,
    segments: transcript.segments.filter((_, segmentIndex) => segmentIndex !== index)
  });
}

export function updateSpeakerName(transcript: EditorTranscript, speakerId: string, name: string): EditorTranscript {
  return {
    ...transcript,
    speakers: transcript.speakers.map((speaker) =>
      speaker.id === speakerId ? { ...speaker, name } : speaker
    )
  };
}

export function addSpeakerToTranscript(transcript: EditorTranscript): EditorTranscript {
  let nextIndex = transcript.speakers.length;
  let nextId = `SPEAKER_${String(nextIndex).padStart(2, "0")}`;
  while (transcript.speakers.some((speaker) => speaker.id === nextId)) {
    nextIndex += 1;
    nextId = `SPEAKER_${String(nextIndex).padStart(2, "0")}`;
  }
  return {
    ...transcript,
    speakers: [...transcript.speakers, { id: nextId, name: nextId }]
  };
}

export function removeSpeakerFromTranscript(transcript: EditorTranscript, speakerId: string): EditorTranscript {
  return {
    ...transcript,
    speakers: transcript.speakers.filter((speaker) => speaker.id !== speakerId),
    segments: transcript.segments.map((segment) =>
      segment.speaker === speakerId ? { ...segment, speaker: "" } : segment
    )
  };
}

export function mergeSegmentWithNext(transcript: EditorTranscript, index: number): EditorTranscript {
  if (index >= transcript.segments.length - 1) {
    return transcript;
  }
  const current = transcript.segments[index];
  const next = transcript.segments[index + 1];
  const segments = transcript.segments.filter((_, segmentIndex) => segmentIndex !== index + 1);
  segments[index] = {
    ...current,
    end: next.end ?? current.end,
    text: `${current.text.trim()} ${next.text.trim()}`.trim()
  };
  return renumberSegments({ ...transcript, segments });
}

export function mergeAdjacentSameSpeakerSegments(transcript: EditorTranscript): {
  transcript: EditorTranscript;
  mergeCount: number;
} {
  const mergedSegments: EditorSegment[] = [];
  let mergeCount = 0;
  for (const segment of transcript.segments) {
    const previous = mergedSegments[mergedSegments.length - 1];
    if (previous && previous.speaker && previous.speaker === segment.speaker) {
      mergedSegments[mergedSegments.length - 1] = {
        ...previous,
        end: segment.end ?? previous.end,
        text: `${previous.text.trim()} ${segment.text.trim()}`.trim()
      };
      mergeCount += 1;
    } else {
      mergedSegments.push(segment);
    }
  }
  return {
    transcript: mergeCount > 0 ? renumberSegments({ ...transcript, segments: mergedSegments }) : transcript,
    mergeCount
  };
}

export function splitSegmentAtCursor(
  transcript: EditorTranscript,
  index: number,
  cursor: number
): { transcript: EditorTranscript } | { error: string } {
  const segment = transcript.segments[index];
  if (!segment || cursor <= 0 || cursor >= segment.text.length) {
    return { error: "Place the cursor inside the segment text before splitting." };
  }
  const firstText = segment.text.slice(0, cursor).trim();
  const secondText = segment.text.slice(cursor).trim();
  if (!firstText || !secondText) {
    return { error: "Split needs text on both sides of the cursor." };
  }

  let firstEnd: number | null = segment.end;
  let secondStart: number | null = segment.start;
  if (segment.start !== null && segment.end !== null && segment.end > segment.start && segment.text.length > 0) {
    const ratio = Math.min(0.95, Math.max(0.05, cursor / segment.text.length));
    const splitTime = segment.start + (segment.end - segment.start) * ratio;
    firstEnd = splitTime;
    secondStart = splitTime;
  }

  const firstSegment = { ...segment, text: firstText, end: firstEnd };
  const secondSegment = { ...segment, text: secondText, start: secondStart };
  return {
    transcript: renumberSegments({
      ...transcript,
      segments: [
        ...transcript.segments.slice(0, index),
        firstSegment,
        secondSegment,
        ...transcript.segments.slice(index + 1)
      ]
    })
  };
}
