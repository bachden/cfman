import { X } from "lucide-react";
import type { ReactNode } from "react";

type SideDrawerProps = {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  zIndex?: number | undefined;
};

export function SideDrawer({ open, title, children, onClose, zIndex }: SideDrawerProps) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop" role="presentation" style={zIndex !== undefined ? { zIndex } : undefined} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="side-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
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
