import { describe, expect, it } from "vitest";

import { folderName } from "../../src/lib/editorState";

describe("folderName", () => {
  it("preserves Windows and POSIX filesystem roots", () => {
    expect(folderName("D:\\interview.xlsx")).toBe("D:\\");
    expect(folderName("/interview.xlsx")).toBe("/");
  });

  it("returns an ordinary parent folder unchanged", () => {
    expect(folderName("D:\\research\\interview.xlsx")).toBe("D:\\research");
  });
});
