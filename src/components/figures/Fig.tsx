import type { ReactNode } from "react";

/**
 * Datasheet figure: an instrument panel with corner brackets, a scale rule along the top edge and a
 * mono "FIG. nn · LABEL" head. Styles live in globals.css (`.fig*`).
 *
 *   <Fig n="02" label="Pipeline timing" meta="one screen · 2.4 s">…</Fig>
 */
export function Fig({
  n,
  label,
  meta,
  live = false,
  className,
  children,
}: {
  /** figure number, e.g. "02" */
  n: string;
  /** mono uppercase label after the number */
  label: ReactNode;
  /** right-aligned mono meta (not uppercased) */
  meta?: ReactNode;
  /** prepend a blinking live dot to the label */
  live?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={`fig${className ? ` ${className}` : ""}`}>
      <div className="fig-head">
        <span className="fig-label">
          {live && <span className="live-dot" aria-hidden="true" />}
          <span>
            <b>Fig. {n}</b> · {label}
          </span>
        </span>
        {meta && <span className="fig-meta">{meta}</span>}
      </div>
      <div className="fig-body">{children}</div>
    </figure>
  );
}
