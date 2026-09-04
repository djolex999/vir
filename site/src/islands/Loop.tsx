import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { LoopNode } from "../consts";

export type NavKey = "ArrowRight" | "ArrowLeft" | "Home" | "End";

export function nextIndex(current: number, key: NavKey, len: number): number {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % len;
    case "ArrowLeft":
      return (current - 1 + len) % len;
    case "Home":
      return 0;
    case "End":
      return len - 1;
  }
}

function isNavKey(k: string): k is NavKey {
  return k === "ArrowRight" || k === "ArrowLeft" || k === "Home" || k === "End";
}

export function Loop({ nodes }: { nodes: LoopNode[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelId = useId();

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "Escape") {
      setActive(null);
      return;
    }
    if (!isNavKey(e.key)) return;
    e.preventDefault();
    const n = nextIndex(i, e.key, nodes.length);
    setFocused(n);
    setActive(n);
    refs.current[n]?.focus();
  };

  const shown = active === null ? null : nodes[active];

  return (
    <div className="loop">
      <ol className="loop-ring" aria-label="The vir loop" role="group">
        {nodes.map((n, i) => (
          <li key={n.id} className="loop-item">
            <button
              type="button"
              ref={(el) => {
                refs.current[i] = el;
              }}
              tabIndex={i === focused ? 0 : -1}
              aria-expanded={active === i}
              aria-controls={panelId}
              data-active={active === i || undefined}
              className="loop-node"
              onMouseEnter={() => setActive(i)}
              onFocus={() => {
                setFocused(i);
                setActive(i);
              }}
              onClick={() => setActive(active === i ? null : i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {n.label}
            </button>
            <span className="loop-arrow" aria-hidden="true">
              →
            </span>
          </li>
        ))}
      </ol>
      <svg className="loop-return" viewBox="0 0 1000 56" preserveAspectRatio="none" aria-hidden="true">
        <path d="M985 0 V40 H15 V4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 5" />
        <path d="M8 12 L15 2 L22 12" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div id={panelId} className="loop-panel" aria-live="polite">
        {shown ? (
          <>
            <p className="loop-blurb">{shown.blurb}</p>
            {shown.command && (
              <code className="loop-cmd">
                <span aria-hidden="true">$ </span>
                {shown.command}
              </code>
            )}
          </>
        ) : (
          <p className="loop-blurb loop-hint">Hover or tab through a step.</p>
        )}
      </div>
    </div>
  );
}
