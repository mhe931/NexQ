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

Set **Webcam position** and the teleprompter size in the setup screen. **Test
placement** moves the overlay under the camera. The overlay does not take
keyboard focus from PowerPoint, Teams or Zoom, and its position and size are
saved per meeting (drag the top bar to move, drag an edge to resize).

### Live text controls (Presentation View)

One slim row, always available while presenting:
`[ A− ] [ A+ ] [ Font ] [ LTR | RTL | Auto ] [ Window Opacity ] [ Reset to 100% ] [ Settings ]`.

- **A− / A+** (or the `-` and `+` keys): 14–96 px, visible immediately.
- **Font**: "Default" or any installed font. A missing font falls back to Segoe UI / Tahoma /
  Noto Arabic so English and Persian text always render.
- **LTR / RTL / Auto**: *Auto* follows each paragraph's first strong character, so mixed
  Persian/English notes lay out correctly. Text is shown exactly as written.
- **Window Opacity** (20–100 %, live): fades the *entire* NexQ window (background, notes, AI answers,
  toolbar, buttons and borders) so PowerPoint, Teams or a browser behind it shows through. The
  fade is applied by Windows to the NexQ window itself, not by CSS, and NexQ stays clickable (it is
  never click-through). It applies in both Presentation and Q&A, is saved per meeting, and does not
  change the opacity of any other app. **Reset to 100%** makes it fully opaque again. While the
  presenter runs, the overlay's glass blur is off so the desktop behind is sharp; it returns when the
  meeting closes. Meetings saved before this control start at 100 %. Limitations: Windows
  only (elsewhere the window's own content fades instead), and at very low values the text is
  as faint as the background, so keep it above about 40 % while presenting.
- **Settings**: line spacing, text width, scroll speed, **Pause/Resume scrolling**, colour preset
  (white, yellow or green on black, black on white) and **Restore defaults**.

Everything is saved with *this* meeting; other meetings keep their own look.

## 9. From presentation to Q&A, with the real presentation

### Bind Presentation

1. Open your deck in **desktop PowerPoint** (or Google Slides in a browser).
2. In the presenter view click **Bind presentation**, then choose the target from the list and press
   **Bind**. NexQ never assumes the focused window; it lists what is open and you pick.
3. The chip shows the name and **CONNECTED / DISCONNECTED / UNSUPPORTED / OUT OF SYNC**.
   **Rebind**, **Disconnect**, **Test navigation** (one slide away and back) and
   **Sync to current slide** are in the same panel.

The binding is stored with the meeting but re-checked every time you reopen it: if exactly that file
is not open you see DISCONNECTED and can rebind.

**PowerPoint (desktop)** is controlled through its official COM automation: no keystrokes are sent, no
window is focused, no administrator rights are needed. **Google Slides** can be *listed* but cannot be
controlled: Google offers no slideshow-control API, so NexQ labels it UNSUPPORTED and the notes
follow your manual selection (change the slide in the browser yourself).

### One control for slides and notes

Next / Previous / First / Last (buttons or keys) move **the bound presentation and the notes
together**. The notes change after PowerPoint confirms the slide ("Moving…" until then; a failure is
shown and nothing changes). Fast presses are combined, held keys are ignored, and a slide
change made directly in PowerPoint is followed automatically (turn this off in the setup screen to get
an OUT OF SYNC notice and a **Sync to current slide** button instead). Navigation never calls an AI
provider.

Default keys: next `→ PgDn N`, previous `← PgUp P`, first `Home`, last `End`, Start Q&A `Q`
(change them in the setup screen); `↑ ↓` scroll and `H` hide are fixed.

### Start Q&A

**Start Q&A** switches phase; the meeting, its documents, prompt and model stay the same. The first
time a meeting starts listening you get **one** inline notice ("Listening transcribes everyone on this
call — make sure that is allowed") with *Start listening and remember for this meeting*. After that
nothing is asked on pause/resume, slide↔Q&A switches or questions. You can tick the same box
in *Privacy & consent* beforehand. A visible LISTENING / NOT LISTENING status and **Pause listening**
are always on screen; audio is not recorded and nothing is uploaded unless you turn recording on. Windows' own
microphone permission still applies.

### Presentations and speaker notes from files

- **Add Presentation**: `.pptx`, `.pptm`, `.ppsx`. Slide numbers, titles, text and embedded notes are
  cached locally (also searchable in Q&A); the setup screen shows when it was imported and warns if the
  file changed ("Refresh"). Your edited notes survive a refresh.
- **Google Slides / OneDrive / SharePoint**: signing in from NexQ is not built (it needs your own OAuth
  registration). Use *File → Download → Microsoft PowerPoint (.pptx)* from Google Slides, or add a deck
  that the OneDrive/SharePoint/Google Drive desktop app already synced to disk (labelled "Locally synced
  cloud file").
- **Add Speaker Notes**: a separate `.docx`, `.pdf`, `.txt` or `.md` with sections such as `# Slide 1`,
  `Slide 2: Objectives`, `SLIDE 03 | …`, `Slide 4 of 16`. A table **SLIDE | TITLE | NOTES SOURCE |
  STATUS** shows the mapping; open a row to see embedded, external and edited text side by side.
  Ambiguous sections (duplicates, no number, beyond the last slide) are listed for you to assign by hand.
- **Precedence** (shown, never silent): *your own edits* > *speaker-notes document* > *presentation
  notes* by default; one switch prefers the presentation's notes instead. Neither source is deleted and
  the original files are never modified.
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
