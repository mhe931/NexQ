import { beforeEach, describe, expect, it } from "vitest";
import { useQuestionStore } from "./questionStore";

describe("question answer outcomes", () => {
  beforeEach(() => useQuestionStore.getState().clear());

  it("does not call a requested answer ready; a failed answer can be retried", () => {
    const store = useQuestionStore.getState();
    store.addQuestion({ text: "Why?", source: "Them", confidence: 1, timestamp_ms: 1 }, "line");
    store.trackAnswer("line", "Why?", "request");
    expect(useQuestionStore.getState().questions[0].answerStatus).toBe("requested");
    store.settleAnswer("other", "ready");
    expect(useQuestionStore.getState().questions[0].answerStatus).toBe("requested");
    store.settleAnswer("request", "unable");
    expect(useQuestionStore.getState().questions[0]).toMatchObject({ answerStatus: "unable", assisted: false, heldBack: true });
    store.trackAnswer("line", "Why?", "retry");
    store.settleAnswer("retry", "ready");
    expect(useQuestionStore.getState().questions[0]).toMatchObject({ answerStatus: "ready", assisted: true });
  });
});
