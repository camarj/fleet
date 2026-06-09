/**
 * Native directory selection — folder dialog and folder drag-and-drop.
 *
 * Both only yield a real filesystem PATH inside the Tauri desktop shell. A plain
 * browser deliberately hides absolute paths, so there is nothing usable to give
 * the Core there: `pickDirectory` returns null and `onDirectoryDrop` is a no-op.
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "Select a Claude Code project" });
  return typeof selected === "string" ? selected : null;
}

/** Drag-and-drop handlers for a dropped folder. */
export interface DirectoryDropHandlers {
  /** Fired while a drag hovers the window (highlight the drop zone). */
  onHover?: (active: boolean) => void;
  /** Fired with the first dropped path when the user releases. */
  onDrop: (path: string) => void;
}

/**
 * Subscribe to the Tauri webview's drag-drop event. Returns an unlisten function,
 * or null in a plain browser (no filesystem paths available). The event is
 * window-wide; the caller decides what counts as "over the drop zone".
 */
export async function onDirectoryDrop(handlers: DirectoryDropHandlers): Promise<(() => void) | null> {
  if (!isTauri()) return null;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") handlers.onHover?.(true);
    else if (p.type === "leave") handlers.onHover?.(false);
    else if (p.type === "drop") {
      handlers.onHover?.(false);
      if (p.paths[0]) handlers.onDrop(p.paths[0]);
    }
  });
}
