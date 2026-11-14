import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";
import { MeetingSetup } from "./MeetingSetup";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useProfileStore } from "../stores/profileStore";
import {
  CATALOG, makeProfile, makeSlide, profileIpcMock as ipc, readyProfile, resetProfileIpcMock,
} from "../test/profileFixtures";
import type { MeetingProfile, NotesBlock, PresentationInfo, SlideRow } from "../lib/profileTypes";

const INFO: PresentationInfo = {
  documentId: "doc1", name: "Thesis.pptx", path: "C:\\Decks\\Thesis.pptx", slideCount: 12,
  indexedAt: "2026-03-01T10:00:00Z", stale: false, sourceMissing: false, origin: "local",
};

const EMPTY_REPORT = { added: [], updated: [], unchanged: [], duplicates: [], failed: [], skipped: [], missing: [] };

function block(over: Partial<NotesBlock> = {}): NotesBlock {
  return {
    id: "b1", documentId: "notes1", ordinal: 1, label: "Intro", detectedSlide: null, assignedSlide: null,
    text: "Welcome everyone and thank the committee.", manual: false, status: "unassigned", ...over,
  };
}

function slideRow(no: number, over: Partial<SlideRow> = {}): SlideRow {
  return { ...makeSlide(no, `Embedded ${no}`), notesSource: "embedded", notesStatus: "ok", notesExternal: null, effectiveNotes: `Embedded ${no}`, ...over };
}

function show(profile: MeetingProfile = readyProfile(), slides: SlideRow[] = []) {
  ipc.get.mockResolvedValue(profile);
  useProfileStore.setState({ current: profile, catalog: CATALOG, dirty: false, documents: [], slides, error: null, busy: false });
  render(<MeetingSetup onBack={vi.fn()} onStart={vi.fn()} startState={{ starting: false, error: null }} />);
}

const pick = (path: string | null) => vi.mocked(open).mockResolvedValueOnce(path as never);
const draft = () => useProfileStore.getState().current!;

beforeEach(() => {
  resetProfileIpcMock();
  vi.mocked(open).mockReset();
  useMeetingStore.setState({ activeMeeting: null });
  useConfigStore.setState({ verifiedCloudProviders: [] });
});

afterEach(() => {
  cleanup();
  useProfileStore.getState().close();
});

describe("presentation source", () => {
  it("adds a presentation through the file dialog and shows what was imported", async () => {
    ipc.addPresentation.mockResolvedValue({ report: { ...EMPTY_REPORT, added: ["C:\\Decks\\Thesis.pptx"] }, info: INFO });
    show();
    pick("C:\\Decks\\Thesis.pptx");
    fireEvent.click(screen.getByRole("button", { name: "Add Presentation" }));
    const card = await screen.findByLabelText("Presentation");
    expect(vi.mocked(open)).toHaveBeenCalledWith(expect.objectContaining({
      multiple: false, filters: [expect.objectContaining({ extensions: ["pptx", "pptm", "ppsx"] })],
    }));
    expect(ipc.addPresentation).toHaveBeenCalledWith("p1", "C:\\Decks\\Thesis.pptx");
    expect(card).toHaveTextContent("Thesis.pptx");
    expect(card).toHaveTextContent("12 slides");
    expect(card).toHaveTextContent(/Imported/);
    expect(card).not.toHaveTextContent("Source file changed since import");
    expect(card).not.toHaveTextContent("Locally synced cloud file");
    // the stored meeting is re-read so documents/slides follow the import
    await waitFor(() => expect(ipc.documents).toHaveBeenCalled());
  });

  it("does nothing when the dialog is cancelled", async () => {
    show();
    pick(null);
    fireEvent.click(screen.getByRole("button", { name: "Add Presentation" }));
    await waitFor(() => expect(vi.mocked(open)).toHaveBeenCalled());
    expect(ipc.addPresentation).not.toHaveBeenCalled();
  });

  it("shows the backend's refusal verbatim", async () => {
    ipc.addPresentation.mockRejectedValue("Only .pptx, .pptm and .ppsx presentations can be added (not .odp).");
    show();
    pick("C:\\Decks\\old.odp");
    fireEvent.click(screen.getByRole("button", { name: "Add Presentation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only .pptx, .pptm and .ppsx presentations can be added (not .odp).");
  });

  it("labels a locally synced cloud file", async () => {
    ipc.presentationInfo.mockResolvedValue({ ...INFO, origin: "synced_cloud", path: "C:\\Users\\me\\OneDrive\\Thesis.pptx" });
    show();
    expect(await screen.findByText("Locally synced cloud file")).toBeInTheDocument();
  });

  it("warns when the source file changed and refreshes on request", async () => {
    ipc.presentationInfo.mockResolvedValueOnce({ ...INFO, stale: true });
    ipc.refresh.mockResolvedValue({ ...EMPTY_REPORT, updated: ["C:\\Decks\\Thesis.pptx"] });
    show();
    expect(await screen.findByText("Source file changed since import")).toBeInTheDocument();
    ipc.presentationInfo.mockResolvedValue({ ...INFO, stale: false });
    fireEvent.click(within(screen.getByLabelText("Presentation")).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Source file changed since import")).toBeNull());
    expect(ipc.refresh).toHaveBeenCalledWith("p1");
  });

  it("says when the source file is missing but cached slides still work", async () => {
    ipc.presentationInfo.mockResolvedValue({ ...INFO, sourceMissing: true, stale: true });
    show();
    expect(await screen.findByText("Source file missing — cached slides still usable")).toBeInTheDocument();
  });
});

describe("cloud sources are described honestly", () => {
  it("explains the supported routes and offers nothing that pretends to connect", () => {
    show();
    const toggle = screen.getByRole("button", { name: "Google Slides / OneDrive / SharePoint" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const help = document.getElementById("presentation-cloud-help")!;
    expect(help).toHaveTextContent(/Direct sign-in to Google Slides, OneDrive or SharePoint is not built into NexQ yet/);
    expect(help).toHaveTextContent(/OAuth registration/);
    expect(help).toHaveTextContent(/File → Download → Microsoft PowerPoint \(\.pptx\)/);
    expect(help).toHaveTextContent(/Locally synced cloud file/);
    expect(within(help).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /sign in|log in|authori[sz]e/i })).toBeNull();
  });
});

describe("external speaker notes", () => {
  it("imports a notes document and summarises the match", async () => {
    ipc.addNotes.mockResolvedValue({
      report: { ...EMPTY_REPORT, added: ["C:\\Notes\\talk.docx"] },
      summary: { documentId: "notes1", blocks: 5, matched: 2, unassigned: 1, duplicates: 2 },
    });
    ipc.notesBlocks.mockResolvedValue([block()]);
    show();
    pick("C:\\Notes\\talk.docx");
    fireEvent.click(screen.getByRole("button", { name: "Add Speaker Notes" }));
    expect(await screen.findByText("5 sections found, 2 matched to slides, 3 need attention")).toBeInTheDocument();
    expect(vi.mocked(open)).toHaveBeenCalledWith(expect.objectContaining({
      filters: [expect.objectContaining({ extensions: ["docx", "pdf", "txt", "md"] })],
    }));
    expect(ipc.addNotes).toHaveBeenCalledWith("p1", "C:\\Notes\\talk.docx");
    expect(screen.getByText(/Google Docs notes: File → Download → \.docx or Markdown/)).toBeInTheDocument();
  });

  it("shows an unreadable notes file's error", async () => {
    ipc.addNotes.mockRejectedValue("That PDF has no text layer.");
    show();
    pick("C:\\Notes\\scan.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Add Speaker Notes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That PDF has no text layer.");
  });
});

describe("notes mapping preview", () => {
  const SLIDES = [
    slideRow(1),
    slideRow(2, { notesSource: "external", notesStatus: "differ", notesExternal: "Doc notes 2", notesOriginal: "Embedded 2", effectiveNotes: "Doc notes 2" }),
    slideRow(3, { notesSource: "edited", notesStatus: "ok", notesEdited: "My words", effectiveNotes: "My words", notesExternal: "Doc 3" }),
    slideRow(4, { notesSource: "external", notesStatus: "duplicate", notesExternal: "A\n\nB", notesOriginal: "" }),
    slideRow(5, { notesSource: "none", notesStatus: "missing", notesOriginal: "", notesExternal: null, effectiveNotes: "" }),
  ];

  it("lists SLIDE | TITLE | NOTES SOURCE | STATUS for every slide", () => {
    show(readyProfile(), SLIDES);
    const table = screen.getByRole("table", { name: "Slide to notes mapping" });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Slide", "Title", "Notes source", "Status"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("Title 1");
    expect(rows[0]).toHaveTextContent("Presentation notes");
    expect(rows[0]).toHaveTextContent("OK");
    expect(rows[1]).toHaveTextContent("Speaker-notes document");
    expect(rows[1]).toHaveTextContent("Sources differ");
    expect(rows[2]).toHaveTextContent("Your edit");
    expect(rows[3]).toHaveTextContent("Several sections on this slide");
    expect(rows[4]).toHaveTextContent("None");
    expect(rows[4]).toHaveTextContent("No notes");
  });

  it("expands a row to all three sources side by side so nothing is hidden", () => {
    show(readyProfile(), SLIDES);
    fireEvent.click(screen.getByRole("button", { name: "Show all notes sources for slide 3" }));
    const group = screen.getByRole("group", { name: "Notes sources for slide 3" });
    expect(group).toHaveTextContent("Embedded 3");
    expect(group).toHaveTextContent("Doc 3");
    expect(group).toHaveTextContent("My words");
    expect(group).toHaveTextContent("Presentation notes");
    expect(group).toHaveTextContent("Speaker-notes document");
    expect(group).toHaveTextContent("Your edit (this meeting)");
    fireEvent.click(screen.getByRole("button", { name: "Hide all notes sources for slide 3" }));
    expect(screen.queryByRole("group", { name: "Notes sources for slide 3" })).toBeNull();
  });

  it("edits this meeting's copy and restores the original", async () => {
    ipc.setSlideNotes.mockResolvedValue(undefined);
    ipc.slides.mockResolvedValue(SLIDES);
    show(readyProfile(), SLIDES);
    fireEvent.click(screen.getByRole("button", { name: "Show all notes sources for slide 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit this meeting's copy of slide 2" }));
    const box = screen.getByLabelText("Notes for slide 2");
    expect(box).toHaveValue("Doc notes 2");
    fireEvent.change(box, { target: { value: "Rewritten" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this meeting's copy" }));
    await waitFor(() => expect(ipc.setSlideNotes).toHaveBeenCalledWith("p1", 2, "Rewritten"));

    fireEvent.click(screen.getByRole("button", { name: "Show all notes sources for slide 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore original notes of slide 3" }));
    await waitFor(() => expect(ipc.setSlideNotes).toHaveBeenCalledWith("p1", 3, ""));
  });
});

describe("manual correction of notes sections", () => {
  it("lists sections that need attention and assigns one, then reloads", async () => {
    ipc.notesBlocks.mockResolvedValue([
      block(),
      block({ id: "b2", label: "Slide 9", detectedSlide: 9, assignedSlide: 9, status: "out_of_range", text: "x".repeat(300) }),
      block({ id: "b3", label: "Fine", detectedSlide: 1, assignedSlide: 1, status: "ok" }),
    ]);
    ipc.assignNotes.mockResolvedValue(undefined);
    show(readyProfile(), [slideRow(1), slideRow(2), slideRow(3)]);
    const group = await screen.findByRole("group", { name: "Notes sections to check" });
    expect(group).toHaveTextContent("Intro");
    expect(group).toHaveTextContent("Welcome everyone");
    expect(group).toHaveTextContent("Not matched to a slide");
    expect(group).toHaveTextContent("Slide number is beyond the deck");
    expect(group).not.toHaveTextContent("Fine");
    expect(within(group).getByText(/x{160}…/)).toBeInTheDocument();

    const select = within(group).getByLabelText("Slide for Intro") as HTMLSelectElement;
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["None", "1", "2", "3"]);
    const slidesCalls = ipc.slides.mock.calls.length;
    const blockCalls = ipc.notesBlocks.mock.calls.length;
    ipc.notesBlocks.mockResolvedValue([block({ assignedSlide: 2, manual: true, status: "ok" })]);
    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() => expect(ipc.assignNotes).toHaveBeenCalledWith("p1", "b1", 2));
    await waitFor(() => expect(ipc.slides.mock.calls.length).toBeGreaterThan(slidesCalls));
    await waitFor(() => expect(ipc.notesBlocks.mock.calls.length).toBeGreaterThan(blockCalls));
    // manual assignments stay visible and are marked
    expect(await screen.findByText("Manually assigned")).toBeInTheDocument();
  });

  it("can set a section to None", async () => {
    ipc.notesBlocks.mockResolvedValue([block({ assignedSlide: 2, manual: true, status: "ok" })]);
    ipc.assignNotes.mockResolvedValue(undefined);
    show(readyProfile(), [slideRow(1), slideRow(2)]);
    const select = await screen.findByLabelText("Slide for Intro");
    expect(select).toHaveValue("2");
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(ipc.assignNotes).toHaveBeenCalledWith("p1", "b1", null));
  });

  it("shows nothing when every section is matched", async () => {
    ipc.notesBlocks.mockResolvedValue([block({ status: "ok", assignedSlide: 1, detectedSlide: 1 })]);
    show(readyProfile(), [slideRow(1)]);
    await waitFor(() => expect(ipc.notesBlocks).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Notes sections to check" })).toBeNull();
  });
});

describe("notes priority", () => {
  it("defaults to the speaker-notes document and saves the other choice", async () => {
    show(readyProfile(), [slideRow(1)]);
    const group = screen.getByRole("radiogroup", { name: "Notes priority" });
    expect(within(group).getByRole("radio", { name: "Speaker-notes document first (default)" })).toBeChecked();
    expect(screen.getByText("Your own edits always come first; neither source is ever deleted.")).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("radio", { name: "Presentation notes first" }));
    expect(draft().presentation.notesPriority).toBe("embedded_first");
    expect(screen.getByText("● Unsaved changes")).toBeInTheDocument();
    ipc.slides.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(ipc.save).toHaveBeenCalledWith(expect.objectContaining({
      presentation: expect.objectContaining({ notesPriority: "embedded_first" }),
    })));
    // the preview is re-read once saved, because the priority changes which notes win
    await waitFor(() => expect(ipc.slides).toHaveBeenCalled());
  });
});

describe("keyboard shortcuts editor", () => {
  const next = () => draft().presentation.shortcuts.next;

  it("shows the configured keys, the fixed keys and the follow-PowerPoint option", () => {
    show();
    const group = screen.getByRole("group", { name: "Keyboard shortcuts" });
    for (const label of ["Next slide", "Previous slide", "First slide", "Last slide", "Start Q&A"]) {
      expect(group).toHaveTextContent(label);
    }
    expect(group).toHaveTextContent("ArrowRight");
    expect(group).toHaveTextContent("PageDown");
    expect(group).toHaveTextContent("Home");
    expect(group).toHaveTextContent(/ArrowUp.*ArrowDown.*scroll.*H.*hides them; these cannot be changed/s);
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeInTheDocument();

    const follow = screen.getByLabelText("Follow slide changes made in PowerPoint");
    expect(follow).toBeChecked();
    fireEvent.click(follow);
    expect(draft().presentation.autoFollow).toBe(false);
  });

  it("changes a key by pressing the new one", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Change n for Next slide" }));
    expect(screen.getByText("Press the new key. Escape cancels.")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Shift" }); // modifiers alone do nothing
    expect(ipc.updatePresentation).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(ipc.updatePresentation).toHaveBeenCalledTimes(1));
    expect(ipc.updatePresentation.mock.calls[0][0]).toBe("p1");
    expect(ipc.updatePresentation.mock.calls[0][1].shortcuts.next).toEqual(["ArrowRight", "PageDown", "j"]);
    await waitFor(() => expect(next()).toEqual(["ArrowRight", "PageDown", "j"]));
    expect(screen.queryByText("Press the new key. Escape cancels.")).toBeNull();
  });

  it("adds a key", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Add a key for Start Q&A" }));
    fireEvent.keyDown(document.body, { key: " " });
    await waitFor(() => expect(draft().presentation.shortcuts.startQa).toEqual(["q", " "]));
    expect(screen.getByRole("group", { name: "Keyboard shortcuts" })).toHaveTextContent("Space");
  });

  it("Escape cancels without changing anything", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Change n for Next slide" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText("Press the new key. Escape cancels.")).toBeNull();
    expect(ipc.updatePresentation).not.toHaveBeenCalled();
    expect(next()).toEqual(["ArrowRight", "PageDown", "n"]);
  });

  it("shows the backend's refusal verbatim and keeps the old keys", async () => {
    ipc.updatePresentation.mockRejectedValue("Home is assigned to both first slide and next slide.");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Change n for Next slide" }));
    fireEvent.keyDown(document.body, { key: "Home" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Home is assigned to both first slide and next slide.");
    expect(next()).toEqual(["ArrowRight", "PageDown", "n"]);
  });

  it("shows the reserved-key refusal too", async () => {
    ipc.updatePresentation.mockRejectedValue("h is reserved (scrolling / hide) and cannot be used for next slide.");
    show();
    fireEvent.click(screen.getByRole("button", { name: "Add a key for Next slide" }));
    fireEvent.keyDown(document.body, { key: "h" });
    expect(await screen.findByRole("alert")).toHaveTextContent("h is reserved (scrolling / hide)");
  });

  it("resets to the defaults", async () => {
    const base = makeProfile();
    show(readyProfile({ presentation: { ...base.presentation, shortcuts: { ...base.presentation.shortcuts, next: ["x"], last: ["z"] } } }));
    expect(next()).toEqual(["x"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(next()).toEqual(["ArrowRight", "PageDown", "n"]));
    expect(ipc.updatePresentation.mock.calls[0][1].shortcuts).toEqual(base.presentation.shortcuts);
    expect(draft().presentation.shortcuts.last).toEqual(["End"]);
  });

  it("does not mark the meeting as having unsaved changes just for accepted shortcuts", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Add a key for Last slide" }));
    fireEvent.keyDown(document.body, { key: "e" });
    await waitFor(() => expect(draft().presentation.shortcuts.last).toEqual(["End", "e"]));
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });
});

describe("privacy wording", () => {
  it("offers the listening checkbox as an optional, once-per-meeting confirmation", () => {
    show();
    const box = screen.getByLabelText(
      "I will make sure everyone on this meeting knows it is transcribed or that it is permitted (asked once per meeting)",
    );
    expect(box).not.toBeChecked();
    expect(screen.getByText(/Optional here: you can start the meeting without ticking this/)).toBeInTheDocument();
    expect(screen.queryByText(/Everyone whose audio is captured has agreed/)).toBeNull();
    fireEvent.click(box);
    expect(draft().audio.listeningConsentConfirmed).toBe(true);
    act(() => useProfileStore.getState().close());
  });
});
