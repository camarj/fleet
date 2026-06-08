use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
        .run(tauri::generate_context!())
        .expect("error while running the Gateway desktop shell");
}

#[cfg(not(debug_assertions))]
fn start_core(app: &tauri::AppHandle) {
    let sidecar = app
        .shell()
        .sidecar("gateway-core")
        .expect("the gateway-core sidecar is not bundled");
    let (mut rx, _child) = sidecar.spawn().expect("failed to spawn gateway-core");

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
