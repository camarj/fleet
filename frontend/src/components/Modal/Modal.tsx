/**
 * Modal — a centered overlay dialog. Closes on backdrop click or Escape. The
 * body and an optional footer are provided by the caller.
 */

import { useEffect } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** When false, clicking the backdrop or pressing Escape does NOT close it
   * (close only via the ✕ or footer buttons). Prevents accidental loss. */
  dismissable?: boolean;
}

export function Modal({ title, onClose, children, footer, dismissable = true }: Props): React.JSX.Element {
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dismissable]);

  return (
    <div className="modal-backdrop" onClick={dismissable ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
