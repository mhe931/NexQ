import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { scanPath, scanText } from "./secret-scan.mjs";

describe("secret scan", () => {
  it("flags credential-shaped values without echoing them", () => {
    const fake = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("-");
    expect(scanText("a.ts", `const k = "${fake}";`)).toEqual([{ path: "a.ts", line: 1, rule: "OpenAI-style key" }]);
    expect(scanText("b.ts", "fetch(`/v1?key=ABCDEFGHIJKLMNOPQRSTUV123`)")[0].rule).toBe("API key in URL");
    expect(scanText("c.pem", "-----BEGIN PRIVATE KEY-----")[0].rule).toBe("Private key block");
  });

  it("accepts ordinary prose, header names and the documented test placeholders", () => {
    expect(scanText("d.md", "Use the x-goog-api-key header; never put a key in the URL.")).toEqual([]);
    expect(scanText("e.rs", 'const TEST_KEY: &str = "nexq-unit-test-key-not-a-credential";')).toEqual([]);
    expect(scanText("f.ts", "const ask-me = 'task-based sk-learn'")).toEqual([]);
  });

  it("rejects personal document, database and recording types", () => {
    for (const p of ["thesis.docx", "deck.pptx", "cv.pdf", "nexq.db", "talk.wav", "meeting.local.json"]) {
      expect(scanPath(p)).toHaveLength(1);
    }
    expect(scanPath("src/App.tsx")).toEqual([]);
    expect(scanPath("website/public/guide.pdf")).toEqual([]);
  });
});
