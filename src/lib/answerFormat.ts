export type AnswerBlockKind = "action" | "answer" | "source" | "text";

export interface AnswerBlock {
  kind: AnswerBlockKind;
  text: string;
  /** 1-based position among the [ACTION] steps; only set for actions. */
  step?: number;
}

export interface ParsedAnswer {
  blocks: AnswerBlock[];
  actions: AnswerBlock[];
  /** True while the last line is still arriving (no newline yet). */
  streaming: boolean;
}

const TAG = /^\s*(?:[-*]\s*)?\**\[(ACTION|ANSWER|SOURCE)\]\**:?\s*(.*)$/i;

/**
 * Splits a model reply into distinct [ACTION] steps, the [ANSWER] to say aloud
 * and [SOURCE] citations. Untagged lines continue the previous block, so a
 * plain-text reply simply becomes one "text" block. Safe on partial streams.
 */
export function parseAnswer(raw: string): ParsedAnswer {
  const blocks: AnswerBlock[] = [];
  let steps = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tag = TAG.exec(line);
    if (tag) {
      const kind = tag[1].toLowerCase() as AnswerBlockKind;
      const block: AnswerBlock = { kind, text: tag[2].trim() };
      if (kind === "action") block.step = ++steps;
      blocks.push(block);
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last && last.kind !== "action" && last.kind !== "source") {
      last.text = `${last.text} ${line.trim()}`.trim();
    } else if (last && last.kind === "action") {
      // A wrapped action line stays part of the same step.
      last.text = `${last.text} ${line.trim()}`.trim();
    } else {
      blocks.push({ kind: "text", text: line.trim() });
    }
  }
  return {
    blocks: blocks.filter((b) => b.text.length > 0),
    actions: blocks.filter((b) => b.kind === "action" && b.text.length > 0),
    streaming: raw.length > 0 && !raw.endsWith("\n"),
  };
}
