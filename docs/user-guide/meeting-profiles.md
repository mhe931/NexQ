# Meetings: setup, presenter notes and Q&A

NexQ is built around **individual meetings**. Each saved meeting keeps its own
settings, documents, prompt, provider/model and session history. Opening or
editing one meeting never changes another.

**Global** (shared by all meetings): API keys in Windows Credential Manager,
installed speech models, app theme. **Per meeting**: everything else on the
setup screen. The setup screen marks which is which.

## 1. Create a new meeting

Home → **New Meeting**, pick a template (Presentation + Academic Q&A, Technical
Interview, General Meeting, or Custom), name it and press **Save**. Templates
only pre-fill editable text. Saved meetings are listed under **Saved Meetings**;
**Start Meeting** on the home screen starts your most recent one.

## 2. Add files and folders

On the setup screen: **Add Files** (`.md`, `.txt`, `.pdf`, `.docx`, `.pptx`,
`.html`) and **Add Local Folder** (recursive; hidden, `node_modules`, `target`
and similar folders are skipped; limits: 25 MB per file, 1000 files per folder).
Each file shows its status, chunk count and, if extraction failed, the reason.
**Refresh sources** re-reads changed files, skips duplicates and marks vanished
files as missing. Everything is indexed **locally** (SQLite full-text search);
no document is uploaded to a provider. Only the few excerpts relevant to a
question are sent to your selected provider, wrapped as untrusted reference data.

**Connect Cloud Folder** accepts a folder synced by the Google Drive or OneDrive
desktop apps. Signing in to the Google Drive / OneDrive / SharePoint APIs from
NexQ is not built in; NexQ never reads browser sessions or tokens.

## 3. Add Markdown instructions

Reference documents are **data**, never instructions. To give instructions, use
**Edit Meeting Instructions** (type or paste) or **Import instruction .md**, which
adds the file with the *Instruction file* role. You can also switch any document
between *Reference* and *Instruction file*. Precedence, highest first:

1. NexQ safety rules (fixed)
2. The meeting's system prompt
3. The style profile (for example *Daniel Academic Voice*)
4. Additional meeting instructions
5. Instruction files you designated
6. Response format and length

**Preview combined instructions** shows exactly what the model receives. A style
is a manner of writing, not a synthesized voice.

## 4. Choose provider and model

*Advanced → AI*: primary provider/model, optional fallback, strategy, response
length, streaming, maximum response time and spending limit. Keys are entered
only in **Global settings → LLM Providers**; a meeting stores just the names.
Use **Test connection** to check a provider. A ChatGPT, Gemini or Copilot
subscription does not include API access.

## 5. Text, spoken answers and Whisper

**Response output**: *Text* (default) or *Spoken answer* (optional; system
text-to-speech on the default output device, with stop / pause / mute). Separately,
**Transcription engine**: *Automatic* or *Whisper transcription* (speech-to-text
only; used when installed, otherwise the automatic engine stays active and you
are told).

## 6. Zoom, Teams, Meet

*Meeting environment → Platform* and *Screen sharing* (none / one window / entire
display). NexQ does **not** hide itself from capture: it warns when the notes
could be visible in what you share. Always check the platform's share preview.

## 7. One or two monitors

*Detect displays*, then choose which monitor is the primary, which one you
present or share, and which one shows NexQ's notes. Recommended: slides on
monitor 2, NexQ notes on monitor 1 near the camera. With one monitor the overlay
is compact and movable.

## 8. Notes near the webcam

Set **Webcam position** and the teleprompter font size, line length, opacity and
scroll speed. **Test placement** moves the overlay under the camera. The overlay
does not take keyboard focus from PowerPoint, Teams or Zoom.

## 9. From presentation to Q&A

Presentation + Questions meetings start with your slide notes. Keys: **→ / PgDn /
N** next, **← / PgUp / P** previous, **Home/End**, **↑/↓** scroll, **H**
hide/show, **Q** start Q&A. NexQ shows the notes of exactly the slide selected
(manual selection is the supported mode; automatic following is not available).
**Start Q&A** asks you to confirm that everyone agreed to listening, then starts
transcription. The meeting, its documents and settings stay the same; answers come
from *this meeting's* documents with source references. Interview meetings start
directly in Q&A and show `[ACTION]` steps (what you should do) apart from
`[ANSWER]` (what to say). NexQ never operates your computer.

To use Google Slides: File → Download → PowerPoint (.pptx), add it, and choose
**Use as presentation**. Notes can be edited as this meeting's copy; the file is
untouched.

## 10. Automatic fallback

Optional and off by default. If the primary provider is rate-limited, down or
too slow *before any text appears*, NexQ may retry **once** on your fallback, but
only if you ticked *Allow \<provider\> to receive this meeting's context*
(and, for a paid provider, *Allow paid fallback* within your spending limit). A
notice appears when it switches. Strategies: **FAST** (switches only when the
fallback is measurably faster), **BALANCED** (default; switches when the primary is
degraded), **BEST ANSWER** (stays on the primary unless it is unavailable).

## 11. Reopen a saved meeting

Home → **Saved Meetings** → Open. Previous sessions, with transcripts, are listed
under *Privacy & consent → Review retained data*; **Clear session history** and
**Delete this meeting** remove them from your computer.

## Privacy defaults

Local storage, no automatic recording, no folder uploads, no transcript
publication. Rehearsal and live sessions are labelled "AI assisted" on screen.
Check your institution's and the meeting's rules before using AI assistance in
an assessed or recorded meeting.
