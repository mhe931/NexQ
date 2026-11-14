import { useEffect, useRef } from "react";
import { stepFontSize } from "../lib/presenterTypography";
import { DEFAULT_SHORTCUTS, presenterAction } from "../lib/slideNav";
import { usePresenterStore } from "../stores/presenterStore";

interface Handlers {
  onStartQa: () => void;
  onScroll: (direction: 1 | -1) => void;
}

/** True when the key press happens in a field where typing must not trigger shortcuts. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/**
 * Keyboard control of the presenter view, on a window keydown listener that
 * ignores text fields. The keys come from the meeting's configurable shortcuts.
 * Slide keys only act while presenting; a held key does not repeat; "h" always
 * works; "-" / "+" change the font size.
 */
export function usePresenterKeys({ onStartQa, onScroll }: Handlers) {
  const handlers = useRef({ onStartQa, onScroll });
  handlers.current = { onStartQa, onScroll };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const store = usePresenterStore.getState();

      const action = presenterAction(e, store.profile?.presentation.shortcuts ?? DEFAULT_SHORTCUTS);

      // Font size: plain "-" / "+" / "=" (Shift is how "+" is typed on many keyboards).
      if (!action && !e.ctrlKey && !e.altKey && !e.metaKey && !inTextField(e.target) && (e.key === "-" || e.key === "+" || e.key === "=")) {
        if (store.hidden || !store.profile) return;
        e.preventDefault();
        if (e.repeat) return;
        const current = store.profile.environment.teleprompter.fontSize;
        const next = stepFontSize(current, e.key === "-" ? -1 : 1);
        if (next !== current) store.patchTeleprompter({ fontSize: next });
        return;
      }

      if (!action) return;
      if (action === "toggle_hide") {
        e.preventDefault();
        if (!e.repeat) store.toggleHidden();
        return;
      }
      if (store.phase !== "presentation" || store.hidden) return;
      // Always stop the page from scrolling, but a held key must not fire again and again.
      e.preventDefault();
      if (e.repeat && action !== "scroll_down" && action !== "scroll_up") return;
      switch (action) {
        case "next": store.step(1); break;
        case "prev": store.step(-1); break;
        case "first": store.first(); break;
        case "last": store.last(); break;
        case "start_qa": handlers.current.onStartQa(); break;
        case "scroll_down": handlers.current.onScroll(1); break;
        case "scroll_up": handlers.current.onScroll(-1); break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
