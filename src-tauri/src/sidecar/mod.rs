mod connection;
mod diagnostics;
mod runtime;
mod supervision;

pub(crate) use connection::{
    build_backend_connection, BackendClientConfig, BackendConnection, BackendConnectionState,
};
pub(crate) use diagnostics::{
    show_startup_error_dialog, StartupDiagnostics, StartupDiagnosticsState,
};
pub(crate) use supervision::{start_desktop_services, stop_backend, BackendState};

#[tauri::command]
pub(crate) fn get_backend_client_config(
    state: tauri::State<'_, BackendConnectionState>,
) -> BackendClientConfig {
    connection::backend_client_config(state)
}

#[tauri::command]
pub(crate) fn restart_sidecar(
    app: tauri::AppHandle,
    state: tauri::State<'_, BackendState>,
    connection: tauri::State<'_, BackendConnectionState>,
    diagnostics: tauri::State<'_, StartupDiagnosticsState>,
) -> Result<(), String> {
    supervision::restart_backend(app, state, connection, diagnostics)
}

#[tauri::command]
pub(crate) fn open_startup_log(
    diagnostics: tauri::State<'_, StartupDiagnosticsState>,
) -> Result<String, String> {
    supervision::open_backend_startup_log(diagnostics)
}
