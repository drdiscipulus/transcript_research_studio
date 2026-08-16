import { describe, expect, it } from "vitest";

import { sortSpeakersForDisplay } from "../../src/lib/editorState";

describe("editor speaker display order", () => {
  it("sorts speaker IDs naturally without changing stored order", () => {
    const storedSpeakers = [
      { id: "SPEAKER_01", name: "Host" },
      { id: "SPEAKER_10", name: "Observer" },
      { id: "SPEAKER_02", name: "Guest" },
      { id: "SPEAKER_00", name: "Interviewer" }
    ];

    const displaySpeakers = sortSpeakersForDisplay(storedSpeakers);

    expect(displaySpeakers.map((speaker) => speaker.id)).toEqual([
      "SPEAKER_00",
      "SPEAKER_01",
      "SPEAKER_02",
      "SPEAKER_10"
    ]);
    expect(storedSpeakers.map((speaker) => speaker.id)).toEqual([
      "SPEAKER_01",
      "SPEAKER_10",
      "SPEAKER_02",
      "SPEAKER_00"
    ]);
  });
});
