use std::{
    env,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
#[cfg(not(debug_assertions))]
use tauri::Manager;

pub(crate) const PORTABLE_MARKER_FILE: &str = ".transcript_research_studio_portable";
pub(crate) const PORTABLE_DATA_FOLDER_NAME: &str = "transcript_research_studio_data";
#[cfg(any(not(debug_assertions), test))]
const PYTHON_RUNTIME_FOLDER_NAME: &str = "python-runtime";

pub(crate) struct BackendLaunch {
    pub(crate) python_executable: PathBuf,
    pub(crate) working_directory: PathBuf,
    pub(crate) python_path: PathBuf,
    pub(crate) python_home: Option<PathBuf>,
    pub(crate) resource_directory: Option<PathBuf>,
}

pub(crate) struct PortableRuntime {
    pub(crate) data_root: PathBuf,
}

pub(crate) fn resolve_backend_launch(_app: &AppHandle) -> Result<BackendLaunch, String> {
    #[cfg(debug_assertions)]
    {
        resolve_development_launch()
    }
    #[cfg(not(debug_assertions))]
    {
        resolve_release_launch(_app)
    }
}

#[cfg(debug_assertions)]
fn resolve_development_launch() -> Result<BackendLaunch, String> {
    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Could not resolve the development project root.".to_string())?;
    let mut candidates = Vec::new();
    for variable in [
        "TRANSCRIPT_RESEARCH_STUDIO_BACKEND_PYTHON",
        "TRANSCRIPT_RESEARCH_STUDIO_SHARED_VENV_PYTHON",
    ] {
        if let Ok(value) = env::var(variable) {
            if !value.trim().is_empty() {
                candidates.push(development_launch(PathBuf::from(value), &source_root));
            }
        }
    }
    candidates.push(development_launch(
        local_python_candidate(&source_root),
        &source_root,
    ));
    candidates
        .into_iter()
        .find(|candidate| launch_is_complete(candidate))
        .ok_or_else(|| "No usable development Python sidecar runtime was found.".to_string())
}

#[cfg(debug_assertions)]
fn development_launch(python_executable: PathBuf, source_root: &Path) -> BackendLaunch {
    BackendLaunch {
        python_executable,
        working_directory: source_root.to_path_buf(),
        python_path: source_root.to_path_buf(),
        python_home: None,
        resource_directory: None,
    }
}

#[cfg(debug_assertions)]
fn local_python_candidate(source_root: &Path) -> PathBuf {
    if cfg!(windows) {
        source_root.join(".venv").join("Scripts").join("python.exe")
    } else {
        source_root.join(".venv").join("bin").join("python")
    }
}

#[cfg(not(debug_assertions))]
fn resolve_release_launch(app: &AppHandle) -> Result<BackendLaunch, String> {
    let portable_root = detect_portable_package_root().map(|root| root.join("gen").join("runtime"));
    let resource_root = app
        .path()
        .resource_dir()
        .ok()
        .map(|root| root.join("gen").join("runtime"));
    resolve_release_launch_from_roots(portable_root.as_deref(), resource_root.as_deref())
}

#[cfg(any(not(debug_assertions), test))]
fn resolve_release_launch_from_roots(
    portable_root: Option<&Path>,
    resource_root: Option<&Path>,
) -> Result<BackendLaunch, String> {
    portable_root
        .into_iter()
        .chain(resource_root)
        .map(bundled_launch)
        .find(launch_is_complete)
        .ok_or_else(|| "The bundled Python service runtime is missing or incomplete. Reinstall or extract the application again.".to_string())
}

#[cfg(any(not(debug_assertions), test))]
fn bundled_launch(runtime_root: &Path) -> BackendLaunch {
    let python_root = runtime_root.join(PYTHON_RUNTIME_FOLDER_NAME);
    let python_executable = if cfg!(windows) {
        python_root.join("python.exe")
    } else {
        python_root.join("bin").join("python")
    };
    BackendLaunch {
        python_executable,
        working_directory: runtime_root.to_path_buf(),
        python_path: runtime_root.to_path_buf(),
        python_home: Some(python_root),
        resource_directory: Some(runtime_root.to_path_buf()),
    }
}

fn launch_is_complete(launch: &BackendLaunch) -> bool {
    launch.python_executable.is_file()
        && launch
            .python_path
            .join("backend")
            .join("sidecar_server")
            .join("__main__.py")
            .is_file()
}

pub(crate) fn detect_portable_runtime(_app: &AppHandle) -> Option<PortableRuntime> {
    detect_portable_package_root().map(|package_root| PortableRuntime {
        data_root: package_root.join(PORTABLE_DATA_FOLDER_NAME),
    })
}

pub(crate) fn detect_portable_package_root() -> Option<PathBuf> {
    let executable_path = env::current_exe().ok()?;
    portable_package_root_from_executable(&executable_path)
}

fn portable_package_root_from_executable(executable_path: &Path) -> Option<PathBuf> {
    #[allow(unused_mut)]
    let mut candidates = executable_path
        .parent()
        .map(Path::to_path_buf)
        .into_iter()
        .collect::<Vec<_>>();
    #[cfg(target_os = "macos")]
    for ancestor in executable_path.ancestors() {
        if ancestor
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        {
            if let Some(parent) = ancestor.parent() {
                candidates.push(parent.to_path_buf());
            }
            break;
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.join(PORTABLE_MARKER_FILE).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn runtime_fixture(complete: bool) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "transcript-research-runtime-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let python = if cfg!(windows) {
            root.join("python-runtime").join("python.exe")
        } else {
            root.join("python-runtime").join("bin").join("python")
        };
        fs::create_dir_all(python.parent().unwrap()).unwrap();
        fs::write(python, "fixture").unwrap();
        if complete {
            let entrypoint = root
                .join("backend")
                .join("sidecar_server")
                .join("__main__.py");
            fs::create_dir_all(entrypoint.parent().unwrap()).unwrap();
            fs::write(entrypoint, "fixture").unwrap();
        }
        root
    }

    #[test]
    fn release_runtime_requires_python_and_backend_entrypoint() {
        let incomplete = runtime_fixture(false);
        assert!(resolve_release_launch_from_roots(Some(&incomplete), None).is_err());
        fs::remove_dir_all(incomplete).unwrap();
        let complete = runtime_fixture(true);
        assert!(resolve_release_launch_from_roots(Some(&complete), None).is_ok());
        fs::remove_dir_all(complete).unwrap();
    }

    #[test]
    fn portable_runtime_precedes_resource_runtime() {
        let portable = runtime_fixture(true);
        let resource = runtime_fixture(true);
        let launch = resolve_release_launch_from_roots(Some(&portable), Some(&resource)).unwrap();
        assert_eq!(launch.working_directory, portable);
        fs::remove_dir_all(portable).unwrap();
        fs::remove_dir_all(resource).unwrap();
    }

    #[test]
    fn release_resolution_has_no_development_fallback() {
        assert!(resolve_release_launch_from_roots(None, None).is_err());
    }

    #[test]
    fn portable_root_requires_marker_beside_executable() {
        let root = runtime_fixture(true);
        let executable = root.join(if cfg!(windows) { "app.exe" } else { "app" });
        fs::write(&executable, "fixture").unwrap();
        assert!(portable_package_root_from_executable(&executable).is_none());
        let retired_marker = [".ai_", "transcription_", "studio_portable"].concat();
        fs::write(root.join(&retired_marker), "legacy").unwrap();
        assert!(portable_package_root_from_executable(&executable).is_none());
        fs::write(root.join(PORTABLE_MARKER_FILE), "portable").unwrap();
        assert_eq!(
            portable_package_root_from_executable(&executable),
            Some(root.clone())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn portable_identity_uses_the_release_names() {
        assert_eq!(PORTABLE_MARKER_FILE, ".transcript_research_studio_portable");
        assert_eq!(PORTABLE_DATA_FOLDER_NAME, "transcript_research_studio_data");
        assert_ne!(
            PORTABLE_MARKER_FILE,
            [".ai_", "transcription_", "studio_portable"].concat()
        );
        assert_ne!(
            PORTABLE_DATA_FOLDER_NAME,
            ["ai_", "transcription_", "studio_data"].concat()
        );
    }
}
