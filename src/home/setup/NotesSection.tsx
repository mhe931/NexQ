import { useCallback, useEffect, useRef, useState } from "react";
import { NotesCorrection, NotesMappingTable } from "./NotesMapping";
import { PresentationSources } from "./PresentationSources";
import { NotesPriorityPicker, PresenterPreferences } from "./PresenterPreferences";
import { hintCls } from "../ui";
import { profileIpc } from "../../lib/profileIpc";
import type { MeetingProfile, NotesBlock, PresentationInfo } from "../../lib/profileTypes";
import { useProfileStore } from "../../stores/profileStore";

export function NotesSection({ profile }: { profile: MeetingProfile }) {
  const slides = useProfileStore((s) => s.slides);
  const dirty = useProfileStore((s) => s.dirty);
  const loadSlides = useProfileStore((s) => s.loadSlides);
  const [info, setInfo] = useState<PresentationInfo | null>(null);
  const [blocks, setBlocks] = useState<NotesBlock[]>([]);
  const profileId = profile.id;

  const reloadBlocks = useCallback(async () => {
    try {
      setBlocks((await profileIpc.notesBlocks(profileId)) ?? []);
    } catch {
      setBlocks([]);
    }
  }, [profileId]);

  useEffect(() => {
    let live = true;
    setInfo(null);
    profileIpc.presentationInfo(profileId).then((i) => { if (live) setInfo(i ?? null); }, () => {});
    void reloadBlocks();
    return () => { live = false; };
  }, [profileId, reloadBlocks]);

  // The priority only changes what the presenter shows once it is saved: refresh the preview then.
  const wasDirty = useRef(dirty);
  useEffect(() => {
    if (wasDirty.current && !dirty) void loadSlides();
    wasDirty.current = dirty;
  }, [dirty, loadSlides]);

  return (
    <>
      <PresentationSources profile={profile} info={info} onInfo={setInfo} onChanged={reloadBlocks} />

      {slides.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/40 px-3 py-4 text-center text-xs text-muted-foreground">
          No slides yet. Use Add Presentation to choose a .pptx, .pptm or .ppsx file.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/30">
          <NotesMappingTable slides={slides} />
        </div>
      )}
      <p className={hintCls}>
        Edits are this meeting's copy. The original presentation and speaker-notes files are never changed. “Restore original” brings back the
        imported notes.
      </p>

      <NotesCorrection profile={profile} blocks={blocks} slides={slides} onChanged={reloadBlocks} />
      <NotesPriorityPicker profile={profile} />
      <PresenterPreferences profile={profile} />
    </>
  );
}
