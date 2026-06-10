// `tauri::Manager` is used by gateway_token in both profiles, so it stays
// ungated. The rest of the sidecar plumbing only exists in a RELEASE bundle (in
// dev the Core runs as a separate process, `pnpm core:dev`); gating those imports
// release-only keeps debug builds warning-free.
use tauri::Manager;
#[cfg(not(debug_assertions))]
use std::sync::Mutex;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

/// Exposes the Core's shared WS auth token (the sidecar writes it to
/// ~/.fleet/gateway-token) to the frontend, which echoes it in the WS handshake.
#[tauri::command]
fn gateway_token(app: tauri::AppHandle) -> Option<String> {
    let dir = std::env::var("GATEWAY_DATA_DIR")
        .map(std::path::PathBuf::from)
        .ok()
        .or_else(|| app.path().home_dir().ok().map(|h| h.join(".fleet")))?;
    std::fs::read_to_string(dir.join("gateway-token"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Holds the spawned Core sidecar child so the exit handler can kill it,
/// preventing an orphaned Core after the app closes. Lives in Tauri's managed
/// state; present only in release builds.
#[cfg(not(debug_assertions))]
struct CoreSidecar(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![gateway_token])
        .setup(|app| {
            // In a RELEASE bundle the Core ships as a sidecar binary, and the
            // shell launches it here. In DEV (`tauri dev`) run the Core
            // separately (`pnpm core:dev`); either way the frontend connects to
            // ws://127.0.0.1:4179.
            #[cfg(not(debug_assertions))]
            start_core(app.handle());
            let _ = app;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Gateway desktop shell");

    // Drive the run loop ourselves so we can react to the exit event and tear
    // the sidecar down cleanly (`builder.run(ctx)` would hide this).
    app.run(|_app_handle, _event| {
        #[cfg(not(debug_assertions))]
        if matches!(
            _event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            // `take()` makes this idempotent across ExitRequested + Exit.
            if let Some(state) = _app_handle.try_state::<CoreSidecar>() {
                if let Some(child) = state.0.lock().ok().and_then(|mut guard| guard.take()) {
                    let _ = child.kill();
                }
            }
        }
    });
}

#[cfg(not(debug_assertions))]
fn start_core(app: &tauri::AppHandle) {
    let sidecar = app
        .shell()
        .sidecar("gateway-core")
        .expect("the gateway-core sidecar is not bundled");
    let (mut rx, child) = sidecar.spawn().expect("failed to spawn gateway-core");

    // Keep the child handle alive in managed state so the run-loop exit handler
    // can kill it. Without this the Core would outlive the desktop app.
    app.manage(CoreSidecar(Mutex::new(Some(child))));

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => print!("[core] {}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Stderr(bytes) => eprint!("[core] {}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
    });
}
