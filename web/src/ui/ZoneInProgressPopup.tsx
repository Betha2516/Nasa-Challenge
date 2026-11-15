// Notice shown after flying to a region that has no zones of interest yet (every
// region but the Amazon): a small centred card saying the zone is in progress.
// It closes with its button, a click outside the card or Escape.

import { useEffect, useRef } from "react";

export interface ZoneInProgressPopupProps {
  regionName: string;
  onClose: () => void;
}

export function ZoneInProgressPopup({ regionName, onClose }: ZoneInProgressPopupProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="zone-in-progress-title"
      data-testid="zone-in-progress"
      onClick={onClose}
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/40 px-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-slate-950/90 p-5 text-center text-slate-100 shadow-2xl backdrop-blur"
      >
        <p className="text-xs uppercase tracking-wide text-slate-400">{regionName}</p>
        <h2 id="zone-in-progress-title" className="mt-1 text-lg font-semibold">
          This zone is in progress
        </h2>
        <button
          ref={closeRef}
          type="button"
          data-testid="zone-in-progress-close"
          onClick={onClose}
          className="mt-4 rounded-full border border-slate-500 px-4 py-1.5 text-sm text-slate-200 hover:border-slate-300 hover:bg-slate-800"
        >
          OK
        </button>
      </div>
    </div>
  );
}
