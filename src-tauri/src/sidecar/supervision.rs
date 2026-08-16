use super::{
    connection::{ensure_backend_port_available, probe_authenticated_health},
    diagnostics::{show_startup_error_dialog, StartupDiagnostics, StartupDiagnosticsState},
    runtime::{detect_portable_runtime, resolve_backend_launch},
    BackendConnection, BackendConnectionState,
};
use crate::native_commands::open_path_with_system;
use std::{
    fs, io,
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const BACKEND_RESTART_DELAYS_SECONDS: [u64; 3] = [1, 2, 4];
const BACKEND_RESTART_RESET_AFTER: Duration = Duration::from_secs(60);
const BACKEND_SUPERVISOR_POLL_INTERVAL: Duration = Duration::from_millis(250);
const BACKEND_STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
struct BackendProcessState {
    child: Option<Child>,
    restart_in_progress: bool,
    restart_attempts: usize,
    restart_exhaustion_logged: bool,
    running_since: Option<Instant>,
    shutdown_requested: bool,
}

#[derive(Default)]
pub(crate) struct BackendState(Mutex<BackendProcessState>);

fn lock_backend_state(state: &BackendState) -> MutexGuard<'_, BackendProcessState> {
    state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn start_desktop_services(
    app: &mut tauri::App,
) -> Result<(), Box<dyn std::error::Error>> {
    let connection = app.state::<BackendConnectionState>().0.clone();
    let diagnostics = app.state::<StartupDiagnosticsState>().0.clone();
    let child = match start_backend(&app.handle(), &connection, &diagnostics) {
        Ok(child) => child,
        Err(error) => {
            let message = error.to_string();
            diagnostics.log_line(&format!("startup_error={message}"));
            show_startup_error_dialog(Some(&diagnostics.log_path), &message);
            return Err(error);
        }
    };
    let state = app.state::<BackendState>();
    {
        let mut process = lock_backend_state(state.inner());
        process.child = Some(child);
        process.running_since = Some(Instant::now());
    }
    if let Err(error) = spawn_backend_supervisor(app.handle().clone()) {
        diagnostics.log_line(&format!("sidecar_supervisor_start_error={error}"));
        let child = {
            let mut process = lock_backend_state(state.inner());
            process.shutdown_requested = true;
            process.running_since = None;
            process.child.take()
        };
        if let Some(child) = child {
            terminate_backend_child(child, &diagnostics, "sidecar_supervisor_start_error_stop");
        }
        return Err(error.into());
    }
    Ok(())
}

pub(super) fn restart_backend(
    app: AppHandle,
    state: tauri::State<'_, BackendState>,
    connection: tauri::State<'_, BackendConnectionState>,
    diagnostics: tauri::State<'_, StartupDiagnosticsState>,
) -> Result<(), String> {
    let backend_connection = connection.0.clone();
    let startup_diagnostics = diagnostics.0.clone();
    let previous_child = {
        let mut process = lock_backend_state(state.inner());
        if process.shutdown_requested {
            return Err("The application is shutting down.".to_string());
        }
        if process.restart_in_progress {
            return Err("The local service is already restarting.".to_string());
        }
        reset_restart_budget(&mut process);
        process.restart_in_progress = true;
        process.child.take()
    };

    startup_diagnostics.log_line("sidecar_manual_restart=begin");
    if let Some(child) = previous_child {
        terminate_backend_child(child, &startup_diagnostics, "sidecar_manual_restart_stop");
    }

    match start_backend(&app, &backend_connection, &startup_diagnostics) {
        Ok(child) => {
            let mut process = lock_backend_state(state.inner());
            process.restart_in_progress = false;
            if process.shutdown_requested {
                drop(process);
                terminate_backend_child(
                    child,
                    &startup_diagnostics,
                    "sidecar_manual_restart_shutdown",
                );
                return Err("The application is shutting down.".to_string());
            }
            if process.child.is_some() {
                drop(process);
                terminate_backend_child(
                    child,
                    &startup_diagnostics,
                    "sidecar_manual_restart_duplicate_stop",
                );
                return Err("Another local service process is already running.".to_string());
            }
            process.child = Some(child);
            process.running_since = Some(Instant::now());
            startup_diagnostics.log_line("sidecar_manual_restart=ready");
            Ok(())
        }
        Err(error) => {
            lock_backend_state(state.inner()).restart_in_progress = false;
            startup_diagnostics.log_line(&format!("sidecar_manual_restart_error={error}"));
            Err(format!(
                "The local service could not be restarted. See {} for details.",
                startup_diagnostics.log_path.display()
            ))
        }
    }
}

pub(super) fn open_backend_startup_log(
    diagnostics: tauri::State<'_, StartupDiagnosticsState>,
) -> Result<String, String> {
    diagnostics
        .0
        .open_output_log()
        .map_err(|error| format!("Could not prepare the startup log: {error}"))?;
    open_path_with_system(&diagnostics.0.log_path)?;
    Ok(diagnostics.0.log_path.display().to_string())
}

fn start_backend(
    app: &AppHandle,
    connection: &BackendConnection,
    diagnostics: &StartupDiagnostics,
) -> Result<Child, Box<dyn std::error::Error>> {
    ensure_backend_port_available(connection).map_err(io::Error::other)?;
    let launch = resolve_backend_launch(app)
        .map_err(|message| io::Error::new(io::ErrorKind::NotFound, message))?;
    diagnostics.log_backend_launch(&launch, connection);
    let output_log = diagnostics.open_output_log()?;
    let error_log = output_log.try_clone()?;

    let mut command = Command::new(&launch.python_executable);
    command
        .args(["-m", "backend.sidecar_server"])
        .current_dir(&launch.working_directory)
        .env("PYTHONPATH", &launch.python_path)
        .env("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_HOST", &connection.host)
        .env("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_PORT", connection.port.to_string())
        .env("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_TOKEN", &connection.auth_token)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("TRANSCRIPT_RESEARCH_STUDIO_ALLOWED_ORIGINS", "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420")
        .stdin(Stdio::null())
        .stdout(Stdio::from(output_log))
        .stderr(Stdio::from(error_log));
    if let Some(python_home) = &launch.python_home {
        command.env("PYTHONHOME", python_home);
    }
    if let Some(resource_directory) = &launch.resource_directory {
        command.env(
            "TRANSCRIPT_RESEARCH_STUDIO_RESOURCE_DIR",
            resource_directory,
        );
    }
    if let Some(portable_runtime) = detect_portable_runtime(app) {
        fs::create_dir_all(&portable_runtime.data_root)?;
        command.env("TRANSCRIPT_RESEARCH_STUDIO_PORTABLE", "1").env(
            "TRANSCRIPT_RESEARCH_STUDIO_PORTABLE_ROOT",
            &portable_runtime.data_root,
        );
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|error| {
        diagnostics.log_line(&format!("sidecar_spawn_error={error}"));
        io::Error::other(format!(
            "Could not start the bundled Python service: {error}"
        ))
    })?;
    diagnostics.log_line(&format!("sidecar_spawned_pid={}", child.id()));

    match wait_for_authenticated_backend(&mut child, connection, BACKEND_STARTUP_TIMEOUT) {
        Ok(()) => {
            diagnostics.log_line("sidecar_health=ready");
            Ok(child)
        }
        Err(error) => {
            diagnostics.log_line(&format!("sidecar_health_error={error}"));
            terminate_backend_child(child, diagnostics, "sidecar_failed_start_stop");
            Err(io::Error::other(error).into())
        }
    }
}

fn wait_for_authenticated_backend(
    child: &mut Child,
    connection: &BackendConnection,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let child_exit_status = inspect_child_exit(child)?;
        if let Some(status) = child_exit_status {
            return Err(format!(
                "The local service exited before becoming ready ({status})."
            ));
        }
        let health_ready = probe_authenticated_health(connection).is_ok();
        let child_exit_after_health = if health_ready {
            inspect_child_exit(child)?
        } else {
            None
        };
        match readiness_observation(health_ready, child_exit_after_health.as_deref()) {
            ReadinessObservation::Exited(status) => {
                return Err(format!(
                    "The local service exited before becoming ready ({status})."
                ))
            }
            ReadinessObservation::Ready => return Ok(()),
            ReadinessObservation::Waiting => {}
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("The local service did not pass its authenticated health check after launch.".to_string())
}

fn inspect_child_exit(child: &mut Child) -> Result<Option<String>, String> {
    match child.try_wait() {
        Ok(Some(status)) => Ok(Some(status.to_string())),
        Ok(None) => Ok(None),
        Err(error) => Err(format!(
            "The local service process could not be inspected: {error}"
        )),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ReadinessObservation<'a> {
    Exited(&'a str),
    Ready,
    Waiting,
}

fn readiness_observation(
    health_ready: bool,
    child_exit_after_health: Option<&str>,
) -> ReadinessObservation<'_> {
    match (health_ready, child_exit_after_health) {
        (_, Some(status)) => ReadinessObservation::Exited(status),
        (true, None) => ReadinessObservation::Ready,
        (false, None) => ReadinessObservation::Waiting,
    }
}

fn spawn_backend_supervisor(app: AppHandle) -> io::Result<()> {
    thread::Builder::new()
        .name("sidecar-supervisor".to_string())
        .spawn(move || supervise_backend(app))
        .map(|_| ())
}

fn supervise_backend(app: AppHandle) {
    let connection = app.state::<BackendConnectionState>().0.clone();
    let diagnostics = app.state::<StartupDiagnosticsState>().0.clone();
    diagnostics.log_line("sidecar_supervisor=started");

    loop {
        let restart_plan = {
            let state = app.state::<BackendState>();
            let mut process = lock_backend_state(state.inner());
            if process.shutdown_requested {
                diagnostics.log_line("sidecar_supervisor=stopped");
                return;
            }

            match process.child.as_mut().map(Child::try_wait) {
                Some(Ok(Some(status))) => {
                    process.child.take();
                    process.running_since = None;
                    diagnostics.log_line(&format!("sidecar_exit_status={status}"));
                }
                Some(Err(error)) => {
                    if let Some(child) = process.child.take() {
                        terminate_backend_child(
                            child,
                            &diagnostics,
                            "sidecar_supervisor_wait_error_stop",
                        );
                    }
                    process.running_since = None;
                    diagnostics.log_line(&format!("sidecar_supervisor_wait_error={error}"));
                }
                Some(Ok(None)) if should_reset_restart_budget(&process) => {
                    reset_restart_budget(&mut process);
                    diagnostics.log_line("sidecar_restart_backoff=reset_after_60_seconds");
                }
                _ => {}
            }

            if process.child.is_none() && !process.restart_in_progress {
                match automatic_restart_delay(process.restart_attempts) {
                    Some(delay) => {
                        process.restart_attempts += 1;
                        process.restart_in_progress = true;
                        Some((process.restart_attempts, delay))
                    }
                    None => {
                        if !process.restart_exhaustion_logged {
                            diagnostics.log_line(
                                "sidecar_restart=exhausted_after_three_automatic_attempts",
                            );
                            process.restart_exhaustion_logged = true;
                        }
                        None
                    }
                }
            } else {
                None
            }
        };

        let Some((attempt, delay)) = restart_plan else {
            thread::sleep(BACKEND_SUPERVISOR_POLL_INTERVAL);
            continue;
        };
        diagnostics.log_line(&format!(
            "sidecar_restart_scheduled_attempt={attempt} delay_seconds={}",
            delay.as_secs()
        ));
        thread::sleep(delay);

        {
            let state = app.state::<BackendState>();
            let mut process = lock_backend_state(state.inner());
            if process.shutdown_requested {
                process.restart_in_progress = false;
                diagnostics.log_line("sidecar_supervisor=stopped_before_restart");
                return;
            }
        }

        let restart_result = start_backend(&app, &connection, &diagnostics);
        let state = app.state::<BackendState>();
        let mut process = lock_backend_state(state.inner());
        process.restart_in_progress = false;
        match restart_result {
            Ok(child) if process.shutdown_requested => {
                drop(process);
                terminate_backend_child(child, &diagnostics, "sidecar_supervisor_shutdown_stop");
                return;
            }
            Ok(child) if process.child.is_some() => {
                drop(process);
                terminate_backend_child(child, &diagnostics, "sidecar_supervisor_duplicate_stop");
            }
            Ok(child) => {
                process.child = Some(child);
                process.running_since = Some(Instant::now());
                process.restart_exhaustion_logged = false;
                diagnostics.log_line(&format!("sidecar_restart_ready_attempt={attempt}"));
            }
            Err(error) => {
                process.running_since = None;
                diagnostics.log_line(&format!(
                    "sidecar_restart_error_attempt={attempt} error={error}"
                ));
            }
        }
    }
}

fn automatic_restart_delay(completed_attempts: usize) -> Option<Duration> {
    BACKEND_RESTART_DELAYS_SECONDS
        .get(completed_attempts)
        .copied()
        .map(Duration::from_secs)
}

fn should_reset_restart_budget(process: &BackendProcessState) -> bool {
    process.restart_attempts > 0
        && process
            .running_since
            .is_some_and(|started| started.elapsed() >= BACKEND_RESTART_RESET_AFTER)
}

fn reset_restart_budget(process: &mut BackendProcessState) {
    process.restart_attempts = 0;
    process.restart_exhaustion_logged = false;
    process.running_since = None;
}

fn terminate_backend_child(mut child: Child, diagnostics: &StartupDiagnostics, log_prefix: &str) {
    diagnostics.log_line(&format!("{log_prefix}_pid={}", child.id()));
    if let Err(error) = child.kill() {
        diagnostics.log_line(&format!("{log_prefix}_kill_error={error}"));
    }
    match child.wait() {
        Ok(status) => diagnostics.log_line(&format!("{log_prefix}_exit_status={status}")),
        Err(error) => diagnostics.log_line(&format!("{log_prefix}_wait_error={error}")),
    }
}

pub(crate) fn stop_backend(app: &AppHandle) {
    let state = app.state::<BackendState>();
    let diagnostics = app.state::<StartupDiagnosticsState>().0.clone();
    let child = {
        let mut process = lock_backend_state(state.inner());
        process.shutdown_requested = true;
        process.restart_in_progress = false;
        process.running_since = None;
        process.child.take()
    };
    if let Some(child) = child {
        terminate_backend_child(child, &diagnostics, "sidecar_application_exit_stop");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, thread};

    #[test]
    fn automatic_restart_uses_bounded_backoff() {
        assert_eq!(automatic_restart_delay(0), Some(Duration::from_secs(1)));
        assert_eq!(automatic_restart_delay(1), Some(Duration::from_secs(2)));
        assert_eq!(automatic_restart_delay(2), Some(Duration::from_secs(4)));
        assert_eq!(automatic_restart_delay(3), None);
    }

    #[test]
    fn manual_restart_resets_exhausted_budget() {
        let mut process = BackendProcessState {
            restart_attempts: 3,
            restart_exhaustion_logged: true,
            ..Default::default()
        };
        reset_restart_budget(&mut process);
        assert_eq!(process.restart_attempts, 0);
        assert!(!process.restart_exhaustion_logged);
    }

    #[test]
    fn exited_child_never_becomes_ready_from_another_health_responder() {
        assert_eq!(
            readiness_observation(true, Some("exit code 1")),
            ReadinessObservation::Exited("exit code 1")
        );
        assert_eq!(
            readiness_observation(true, None),
            ReadinessObservation::Ready
        );
        assert_eq!(
            readiness_observation(false, None),
            ReadinessObservation::Waiting
        );
    }

    #[test]
    fn backend_state_lock_recovers_poisoned_state_without_panicking() {
        let state = Arc::new(BackendState::default());
        let poisoning_state = Arc::clone(&state);
        let _ = thread::spawn(move || {
            let _guard = poisoning_state.0.lock().unwrap();
            panic!("synthetic mutex poison");
        })
        .join();

        let mut recovered = lock_backend_state(&state);
        recovered.shutdown_requested = true;
        assert!(recovered.shutdown_requested);
    }
}
