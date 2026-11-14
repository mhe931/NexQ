import { useEffect, useRef } from "react";
import { presenterKey } from "../lib/slideNav";
import { usePresenterStore } from "../stores/presenterStore";

interface Handlers {
  onStartQa: () => void;
  onScroll: (direction: 1 | -1) => void;
}

/**
 * Keyboard control of the presenter view, on a window keydown listener that
 * ignores text fields. Slide keys only act while presenting; "h" always works.
 */
export function usePresenterKeys({ onStartQa, onScroll }: Handlers) {
  const handlers = useRef({ onStartQa, onScroll });
  handlers.current = { onStartQa, onScroll };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = presenterKey(e);
      if (!action) return;
      const store = usePresenterStore.getState();
      if (action === "toggle_hide") {
        e.preventDefault();
        store.toggleHidden();
        return;
      }
      if (store.phase !== "presentation" || store.hidden) return;
      e.preventDefault();
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
