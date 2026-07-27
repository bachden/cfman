import { CircleHelp } from "lucide-react";
import { useState } from "react";

export function FieldHelp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`field-help ${open ? "field-help-open" : ""}`}>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Show field help"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onBlur={() => setOpen(false)}
      >
        <CircleHelp size={14} />
      </button>
      <span className="field-help-tooltip" role="tooltip">{text}</span>
    </span>
  );
}
