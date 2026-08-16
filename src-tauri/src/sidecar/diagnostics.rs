use super::runtime::BackendLaunch;
use super::runtime::{detect_portable_package_root, PORTABLE_DATA_FOLDER_NAME};
use super::BackendConnection;
use std::{
    env, fs,
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const APP_DATA_FOLDER_NAME: &str = "Transcript Research Studio";
const LOGS_FOLDER_NAME: &str = "logs";
const STARTUP_LOG_FILE_NAME: &str = "startup.log";

#[derive(Clone)]
pub(crate) struct StartupDiagnostics {
    pub(crate) log_path: PathBuf,
}

pub(crate) struct StartupDiagnosticsState(pub(crate) StartupDiagnostics);

impl StartupDiagnostics {
    pub(crate) fn new() -> io::Result<Self> {
        let log_path = startup_log_path();
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent)?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        Ok(Self { log_path })
    }

    pub(crate) fn open_output_log(&self) -> io::Result<File> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
    }

    pub(crate) fn write_session_header(&self) {
        self.log_line("");
        self.log_line("=== Transcript Research Studio startup ===");
        self.log_line(&format!("timestamp_unix={}", unix_timestamp()));
        match env::current_exe() {
            Ok(path) => self.log_line(&format!("current_exe={}", path.display())),
            Err(error) => self.log_line(&format!("current_exe_error={error}")),
        }
        match detect_portable_package_root() {
            Some(path) => {
                self.log_line("app_mode=portable");
                self.log_line(&format!("portable_package_root={}", path.display()));
            }
            None => self.log_line("app_mode=installed_or_development"),
        }
        self.log_line(&format!("startup_log={}", self.log_path.display()));
    }

    pub(crate) fn log_backend_launch(
        &self,
        launch: &BackendLaunch,
        connection: &BackendConnection,
    ) {
        self.log_line("sidecar_launch=begin");
        self.log_line(&format!(
            "python_executable={}",
            launch.python_executable.display()
        ));
        self.log_line(&format!(
            "working_directory={}",
            launch.working_directory.display()
        ));
        self.log_line(&format!("python_path={}", launch.python_path.display()));
        match &launch.python_home {
            Some(path) => self.log_line(&format!("python_home={}", path.display())),
            None => self.log_line("python_home=<unset>"),
        }
        match &launch.resource_directory {
            Some(path) => self.log_line(&format!("resource_directory={}", path.display())),
            None => self.log_line("resource_directory=<unset>"),
        }
        self.log_line(&format!("backend_host={}", connection.host));
        self.log_line(&format!("backend_port={}", connection.port));
    }

    pub(crate) fn log_line(&self, message: &str) {
        if let Ok(mut file) = self.open_output_log() {
            let _ = writeln!(file, "{message}");
        }
    }
}

fn startup_log_path() -> PathBuf {
    if let Some(package_root) = detect_portable_package_root() {
        return package_root
            .join(PORTABLE_DATA_FOLDER_NAME)
            .join(LOGS_FOLDER_NAME)
            .join(STARTUP_LOG_FILE_NAME);
    }
    app_data_root()
        .join(LOGS_FOLDER_NAME)
        .join(STARTUP_LOG_FILE_NAME)
}

fn app_data_root() -> PathBuf {
    if cfg!(windows) {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(APP_DATA_FOLDER_NAME)
    } else if cfg!(target_os = "macos") {
        home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library")
            .join("Application Support")
            .join(APP_DATA_FOLDER_NAME)
    } else {
        home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local")
            .join("share")
            .join(APP_DATA_FOLDER_NAME)
    }
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::APP_DATA_FOLDER_NAME;

    #[test]
    fn native_data_folder_uses_the_release_name() {
        assert_eq!(APP_DATA_FOLDER_NAME, "Transcript Research Studio");
        assert_ne!(
            APP_DATA_FOLDER_NAME,
            ["AI", "Transcription", "Studio"].join(" ")
        );
    }
}

pub(crate) fn show_startup_error_dialog(log_path: Option<&Path>, message: &str) {
    let description = match log_path {
        Some(path) => format!("Transcript Research Studio could not start its local service.\n\nStartup log: {}\n\n{message}", path.display()),
        None => format!("Transcript Research Studio could not start.\n\n{message}"),
    };
    let _ = rfd::MessageDialog::new()
        .set_title("Transcript Research Studio")
        .set_description(&description)
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}
