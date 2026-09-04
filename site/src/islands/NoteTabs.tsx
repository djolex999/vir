import { useId, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { SampleNote } from "../data/notes";
import { highlightNote } from "../lib/highlight";
import { nextIndex } from "./Loop";

function fileName(n: SampleNote): string {
  const m = n.markdown.match(/^aliases:\n\s+- "([^"]+)"/m);
  const id = n.markdown.match(/^session_id: (\w+)/m)?.[1] ?? "";
  const dir = `${n.category}s`;
  return `${dir}/${m?.[1] ?? n.category}-${id.slice(0, 8)}.md`;
}

export function NoteTabs({ notes }: { notes: SampleNote[] }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();

  const onKey = (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const n = nextIndex(i, e.key, notes.length);
    setActive(n);
    refs.current[n]?.focus();
  };

  const note = notes[active] ?? notes[0];
  if (!note) return null;

  return (
    <div className="note-card">
      <div className="note-bar">
        <div role="tablist" aria-label="Note type" className="note-tabs">
          {notes.map((n, i) => (
            <button
              key={n.category}
              type="button"
              role="tab"
              id={`${base}-tab-${n.category}`}
              aria-selected={i === active}
              aria-controls={`${base}-panel`}
              tabIndex={i === active ? 0 : -1}
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="note-tab"
              onClick={() => setActive(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {n.label}
            </button>
          ))}
        </div>
        <span className="note-file" aria-hidden="true">
          {fileName(note)}
        </span>
      </div>
      <pre
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${note.category}`}
        className="note-body"
        dangerouslySetInnerHTML={{ __html: highlightNote(note.markdown) }}
      />
    </div>
  );
}
