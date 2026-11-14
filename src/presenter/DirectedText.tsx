import type { CSSProperties } from "react";
import { directionProps, noteParagraphs } from "../lib/presenterTypography";
import type { TextDirection } from "../lib/profileTypes";

interface Props {
  text: string;
  direction: TextDirection;
  /** Font, size, line height and width of the text. */
  style: CSSProperties;
  className?: string;
}

/**
 * Notes or an answer as paragraphs (one per line) with the reading direction
 * applied: "auto" lets each paragraph follow its own first strong character,
 * "ltr"/"rtl" force it. Text is rendered exactly as given.
 */
export function DirectedText({ text, direction, style, className }: Props) {
  const { container, paragraph } = directionProps(direction);
  return (
    <div
      dir={container.dir}
      // A forced right-to-left column sits at the right edge like its text.
      style={{ ...style, ...container.style, ...(container.dir === "rtl" ? { marginLeft: "auto" } : null) }}
      className={className}
      data-direction={direction}
    >
      {noteParagraphs(text).map((line, i) => (
        <p key={i} dir={paragraph.dir} className="whitespace-pre-wrap" style={{ ...paragraph.style, ...(i > 0 ? { marginTop: "0.35em" } : null) }}>
          {line}
        </p>
      ))}
    </div>
  );
}
