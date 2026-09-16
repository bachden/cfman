import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type DrawerStackEntry = { id: string; width: number; focusOrder: number };

type DrawerStackApi = {
  // Registers this id if new, or re-focuses it (moves it to the front of the stack) if
  // already present - callers decide when re-focusing is warranted (see focusKey below).
  focus: (id: string, width: number) => void;
  updateWidth: (id: string, width: number) => void;
  close: (id: string) => void;
};

const DrawerStackApiContext = createContext<DrawerStackApi | null>(null);
const DrawerStackEntriesContext = createContext<DrawerStackEntry[]>([]);

// Matches .sidebar's fixed width in styles.css; drawers cascade left but must never slide
// past this plus MAIN_CONTENT_GAP, so a strip of the main content stays visible and the
// sidebar itself is never covered.
const SIDEBAR_WIDTH = 236;
const MAIN_CONTENT_GAP = 100;
// Below this, .sidebar goes off-canvas and .side-drawer becomes full width (styles.css),
// so there is no sidebar to avoid and no room to cascade.
const MOBILE_BREAKPOINT = 760;
// Default, equal peek per stacked layer. Only shrinks below this once the fixed spacing
// would push the backmost drawer past the sidebar boundary.
const DEFAULT_STEP = 50;
// Must stay below the fixed .modal-backdrop z-index (100, styles.css) so nested Modals
// (enrollment log, WAF manager, ...) render above their owning drawer.
const BASE_Z_INDEX = 90;

export function DrawerStackProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<DrawerStackEntry[]>([]);
  const focusCounter = useRef(0);

  const api = useMemo<DrawerStackApi>(() => ({
    focus: (id, width) => {
      focusCounter.current += 1;
      const focusOrder = focusCounter.current;
      setEntries((current) => [...current.filter((item) => item.id !== id), { id, width, focusOrder }]);
    },
    updateWidth: (id, width) => setEntries((current) => current.map((item) => (item.id === id ? { ...item, width } : item))),
    close: (id) => setEntries((current) => current.filter((item) => item.id !== id))
  }), []);

  return (
    <DrawerStackApiContext.Provider value={api}>
      <DrawerStackEntriesContext.Provider value={entries}>{children}</DrawerStackEntriesContext.Provider>
    </DrawerStackApiContext.Provider>
  );
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export type DrawerStackPosition = { offsetX: number; isFrontmost: boolean; zIndex: number };

// Registers this drawer instance in the shared stack while it's open, and reports back its
// cascade offset, whether it's the frontmost drawer (which alone should dim the page), and
// its z-index.
//
// `focusKey` identifies what the drawer currently shows (e.g. a tunnel id). The drawer is
// brought to the front of the whole stack whenever this key changes to a new non-null value -
// covering both a fresh open (focusKey goes from unset to set) and re-targeting a drawer that
// was already open in the background (focusKey changes to a different id while `open` stays
// true throughout, e.g. clicking a different tunnel's link from inside another open drawer).
// Ordering otherwise never changes on its own, so an already-open drawer never jumps just
// because a sibling drawer's props were recomputed.
export function useDrawerStackPosition(id: string, open: boolean, width: number, focusKey: string | null): DrawerStackPosition {
  const api = useContext(DrawerStackApiContext);
  const entries = useContext(DrawerStackEntriesContext);
  const viewportWidth = useViewportWidth();
  const lastFocusKey = useRef<string | null>(null);

  useEffect(() => {
    if (!api) return;
    if (!open) {
      lastFocusKey.current = null;
      api.close(id);
      return;
    }
    if (lastFocusKey.current !== focusKey) {
      lastFocusKey.current = focusKey;
      api.focus(id, width);
    } else {
      api.updateWidth(id, width);
    }
  }, [api, id, open, width, focusKey]);

  useEffect(() => {
    return () => { if (api) api.close(id); };
    // Only re-run this cleanup-only effect if the drawer identity itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id]);

  if (!open) return { offsetX: 0, isFrontmost: true, zIndex: BASE_Z_INDEX };
  const sorted = [...entries].sort((a, b) => b.focusOrder - a.focusOrder);
  const rank = Math.max(0, sorted.findIndex((entry) => entry.id === id));
  const isFrontmost = rank === 0;
  const zIndex = BASE_Z_INDEX + Math.max(0, sorted.length - 1 - rank);
  if (viewportWidth <= MOBILE_BREAKPOINT) return { offsetX: 0, isFrontmost, zIndex };
  const front = sorted[0];
  if (isFrontmost || !front) return { offsetX: 0, isFrontmost, zIndex };
  const boundary = SIDEBAR_WIDTH + MAIN_CONTENT_GAP;
  const frontLeftEdge = viewportWidth - front.width;
  const available = Math.max(0, frontLeftEdge - boundary);
  const layerCount = sorted.length - 1;
  if (layerCount <= 0) return { offsetX: 0, isFrontmost, zIndex };
  const step = Math.min(DEFAULT_STEP, available / layerCount);
  return { offsetX: Math.round(rank * step), isFrontmost, zIndex };
}
