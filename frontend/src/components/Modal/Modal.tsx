/**
 * Modal — a centered overlay dialog. Closes on backdrop click or Escape. The
 * body and an optional footer are provided by the caller.
 */

import { useEffect, useRef } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** When false, clicking the backdrop or pressing Escape does NOT close it
   * (close only via the ✕ or footer buttons). Prevents accidental loss. */
  dismissable?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, dismissable = true }: Props): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null);

  // Escape to close (when dismissable).
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dismissable]);

  // Focus trap + focus restoration.
  // Runs once on mount; captures the previously focused element and restores it
  // on unmount. Traps Tab/Shift+Tab within the modal while it is open.
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;

    // Move focus into the modal container on mount.
    const modalEl = modalRef.current;
    if (modalEl) modalEl.focus();

    const handleTab = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const el = modalRef.current;
      if (!el) return;

      const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

      // No focusable children — keep focus on the container itself.
      if (focusable.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // Guards for noUncheckedIndexedAccess — array is non-empty so these are
      // always defined, but TypeScript still widens the type without the check.
      if (!first || !last) return;

      if (e.shiftKey) {
        // Shift+Tab at the first element or the modal container → wrap to last.
        if (document.activeElement === first || document.activeElement === el) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab at the last element or the modal container → wrap to first.
        if (document.activeElement === last || document.activeElement === el) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", handleTab);

    return () => {
      window.removeEventListener("keydown", handleTab);
      // Restore focus to the element that was active before the modal opened.
      if (previousFocus && document.body.contains(previousFocus)) {
        previousFocus.focus();
      }
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={dismissable ? onClose : undefined}>
      <div
        className="modal"
        ref={modalRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
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
