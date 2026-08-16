#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native_commands;
mod sidecar;

use sidecar::{BackendConnectionState, BackendState, StartupDiagnostics, StartupDiagnosticsState};
use tauri::RunEvent;

fn main() {
    let diagnostics = match StartupDiagnostics::new() {
        Ok(diagnostics) => diagnostics,
        Err(error) => {
            sidecar::show_startup_error_dialog(
                None,
                &format!("Could not prepare the startup diagnostics log: {error}"),
            );
            return;
        }
    };
    diagnostics.write_session_header();

    let backend_connection = match sidecar::build_backend_connection() {
        Ok(connection) => connection,
        Err(message) => {
            diagnostics.log_line(&format!("backend_connection_error={message}"));
            sidecar::show_startup_error_dialog(Some(&diagnostics.log_path), &message);
            return;
        }
    };

    tauri::Builder::default()
        .manage(BackendState::default())
        .manage(BackendConnectionState(backend_connection))
        .manage(StartupDiagnosticsState(diagnostics))
        .setup(sidecar::start_desktop_services)
        .invoke_handler(tauri::generate_handler![
            sidecar::get_backend_client_config,
            native_commands::pick_folder_native,
            native_commands::pick_transcript_file_native,
            native_commands::pick_evidence_project_file_native,
            native_commands::pick_media_file_native,
            native_commands::pick_save_file_native,
            native_commands::pick_editor_export_file_native,
            native_commands::pick_codes_export_bundle_file_native,
            native_commands::pick_evidence_project_save_file_native,
            native_commands::open_path_native,
            native_commands::open_external_url_native,
            sidecar::restart_sidecar,
            sidecar::open_startup_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                sidecar::stop_backend(app);
            }
        });
}
