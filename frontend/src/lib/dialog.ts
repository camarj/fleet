/**
 * Native directory picker. Inside the Tauri desktop shell it opens the OS folder
 * dialog; in a plain browser there is none, so it returns null and the caller
 * falls back to a text input.
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
