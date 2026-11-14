//! Removes the CLI's own status notices from the start of an answer.
//!
//! With the tool allowlist NexQ passes, `copilot --acp` opens a turn with
//! informational chunks that are not model output. Captured from the real
//! CLI (1.0.105), as separate `agent_message_chunk`s, none ending in a newline:
//!
//! ```text
//! "Info: Disabled tools: azure-containerapps_list, ..., glob, grep, ..."
//! "Info: Unknown tool name in the tool allowlist: \"nexq-no-tools\""
//! "p"
//! "ong"
//! ```
//!
//! They must not reach the user or the caller's text, so the filter holds
//! back the start of the stream until it can tell a notice from an answer.
//! Only the known notice texts are recognized; an answer that merely starts
//! with "Info" passes untouched.

/// How the CLI's notices start.
const NOTICE_PREFIXES: [&str; 2] = [
    "Info: Disabled tools:",
    "Info: Unknown tool name in the tool allowlist",
];

#[derive(Default)]
pub struct NoticeFilter {
    /// The start of the stream, held back while it could still be a notice.
    buf: String,
    /// Real text was passed on: everything else passes unchanged.
    passing: bool,
    /// A notice was dropped: blank lines after it are dropped as well.
    saw_notice: bool,
}

impl NoticeFilter {
    /// Feed one chunk; returns the text to pass on (possibly empty).
    pub fn push(&mut self, chunk: &str) -> String {
        if self.passing {
            return chunk.to_string();
        }
        self.buf.push_str(chunk);
        loop {
            if self.saw_notice && self.buf.trim().is_empty() {
                self.buf.clear();
                return String::new();
            }
            if NOTICE_PREFIXES.iter().any(|p| p.starts_with(self.buf.as_str())) {
                // Could still become a notice: hold on.
                return String::new();
            }
            if !NOTICE_PREFIXES.iter().any(|p| self.buf.starts_with(p)) {
                if self.saw_notice {
                    self.buf = self.buf.trim_start_matches(['\r', '\n']).to_string();
                }
                self.passing = true;
                return std::mem::take(&mut self.buf);
            }
            // A notice: it ends at its line break, or with its chunk.
            self.saw_notice = true;
            match self.buf.find('\n') {
                Some(end) => self.buf = self.buf[end + 1..].to_string(),
                None => {
                    self.buf.clear();
                    return String::new();
                }
            }
        }
    }

    /// The stream ended: whatever is still held back, if it is not a notice.
    pub fn finish(&mut self) -> String {
        self.passing = true;
        std::mem::take(&mut self.buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&str]) -> String {
        let mut filter = NoticeFilter::default();
        let mut out: String = chunks.iter().map(|c| filter.push(c)).collect();
        out.push_str(&filter.finish());
        out
    }

    #[test]
    fn the_notices_captured_from_the_real_cli_are_dropped() {
        // Exactly the chunking of the live capture (disabled-tools list shortened).
        assert_eq!(
            run(&[
                "Info: Disabled tools: azure-containerapps_list, azure-group_list, create, edit, glob, grep, list_powershell, obscura-browser_back",
                "Info: Unknown tool name in the tool allowlist: \"nexq-no-tools\"",
                "p",
                "ong",
            ]),
            "pong"
        );
    }

    #[test]
    fn plain_answers_pass_unchanged() {
        assert_eq!(run(&["Hello", " world"]), "Hello world");
        assert_eq!(run(&["Info: something else"]), "Info: something else");
        assert_eq!(run(&["Info: Disabled printers are listed below"]), "Info: Disabled printers are listed below");
        assert_eq!(run(&["I", "nfo"]), "Info");
        assert_eq!(run(&["I", " think so"]), "I think so");
        // Leading whitespace of a plain answer is kept.
        assert_eq!(run(&["  indented"]), "  indented");
    }

    #[test]
    fn a_notice_is_dropped_whatever_the_chunking() {
        let whole = "Info: Disabled tools: a, b, c\n\npong";
        assert_eq!(run(&[whole]), "pong");
        // A notice ends at its line break or, without one, with its own chunk
        // (the real CLI sends each notice as one chunk).
        assert_eq!(run(&["Info: Disabled tools: a, b\n", "\n", "pong"]), "pong");
        assert_eq!(run(&["Info: Disabled tools: a\r\n\r\n", "pong ", "pong"]), "pong pong");
        // Several notices in one chunk.
        assert_eq!(
            run(&["Info: Disabled tools: a\nInfo: Unknown tool name in the tool allowlist: \"x\"\npong"]),
            "pong"
        );
    }

    #[test]
    fn text_after_the_start_is_never_touched() {
        // A notice-looking line later in the answer is the model's own text.
        assert_eq!(
            run(&["Answer.\n", "Info: Disabled tools: this is just quoted"]),
            "Answer.\nInfo: Disabled tools: this is just quoted"
        );
    }

    #[test]
    fn a_held_back_start_is_flushed_when_the_stream_ends() {
        assert_eq!(run(&["Info: Dis"]), "Info: Dis");
        assert_eq!(run(&[]), "");
    }

    #[test]
    fn an_answer_made_only_of_notices_is_empty() {
        assert_eq!(run(&["Info: Disabled tools: a"]), "");
    }
}
