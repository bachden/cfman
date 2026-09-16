import { X } from "lucide-react";
import { useCallback, useId, useRef, type ReactNode } from "react";
import { useDrawerStackPosition } from "./DrawerStack";

export const DRAWER_MIN_WIDTH = 480;
export const DRAWER_MAX_WIDTH = 1600;

type SideDrawerProps = {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  // Identifies what this drawer currently shows (e.g. a tunnel id); see useDrawerStackPosition.
  focusKey: string | null;
  width: number;
  onResize: (width: number) => void;
};

export function SideDrawer({ open, title, children, onClose, focusKey, width, onResize }: SideDrawerProps) {
  const draggingRef = useRef(false);
  const id = useId();
  const { offsetX, isFrontmost, zIndex } = useDrawerStackPosition(id, open, width, focusKey);

  const handleResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, window.innerWidth - moveEvent.clientX));
      onResize(next);
    };
    const handleMouseUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [onResize]);

  if (!open) return null;
  return (
    <div className={`drawer-backdrop${isFrontmost ? " drawer-backdrop-dim" : ""}`} role="presentation" style={{ zIndex }} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="side-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" style={{ width: `min(${width}px, 100%)`, transform: offsetX ? `translateX(-${offsetX}px)` : undefined }}>
        <div className="side-drawer-resize-handle" onMouseDown={handleResizeStart} title="Drag to resize" />
        <header className="side-drawer-header">
          <div className="side-drawer-title" id="drawer-title">{title}</div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close tunnel details" title="Close">
            <X size={18} />
          </button>
        </header>
        <div className="side-drawer-body">{children}</div>
      </aside>
    </div>
  );
}
