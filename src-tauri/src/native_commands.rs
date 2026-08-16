use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
pub(crate) fn pick_folder_native(
    initial_directory: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(directory) = initial_directory
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = Path::new(directory);
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else if let Some(parent) = path.parent().filter(|candidate| candidate.is_dir()) {
            dialog = dialog.set_directory(parent);
        }
    }
    Ok(dialog.pick_folder().map(|path| path.display().to_string()))
}

#[tauri::command]
pub(crate) fn pick_transcript_file_native(
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let dialog = set_dialog_initial_path(
        rfd::FileDialog::new().add_filter("Transcript Files", &["json", "csv", "xlsx", "docx"]),
        initial_path.as_deref(),
    );
    Ok(dialog.pick_file().map(|path| path.display().to_string()))
}

#[tauri::command]
pub(crate) fn pick_evidence_project_file_native(
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let dialog = set_dialog_initial_path(
        rfd::FileDialog::new().add_filter("Coding Projects (.evidence.json)", &["json"]),
        initial_path.as_deref(),
    );
    Ok(dialog.pick_file().map(|path| path.display().to_string()))
}

#[tauri::command]
pub(crate) fn pick_media_file_native(
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let dialog = set_dialog_initial_path(
        rfd::FileDialog::new().add_filter(
            "Audio and Video",
            &[
                "wav", "mp3", "m4a", "flac", "ogg", "opus", "aac", "mp4", "m4v", "mov", "mkv",
                "webm", "avi",
            ],
        ),
        initial_path.as_deref(),
    );
    Ok(dialog.pick_file().map(|path| path.display().to_string()))
}

#[tauri::command]
pub(crate) fn pick_save_file_native(
    default_file_name: Option<String>,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = set_dialog_initial_path(
        rfd::FileDialog::new().add_filter("Edited Transcript JSON", &["json"]),
        initial_path.as_deref(),
    );
    if let Some(file_name) = nonempty(default_file_name.as_deref()) {
        dialog = dialog.set_file_name(file_name);
    }
    Ok(dialog.save_file().map(|path| path.display().to_string()))
}

#[tauri::command]
pub(crate) fn pick_editor_export_file_native(
    default_file_name: Option<String>,
    initial_path: Option<String>,
    export_formats: Vec<String>,
) -> Result<Option<String>, String> {
    pick_export_file(
        default_file_name,
        initial_path,
        export_formats,
        "Transcript",
    )
}

fn pick_export_file(
    default_file_name: Option<String>,
    initial_path: Option<String>,
    export_formats: Vec<String>,
    label: &str,
) -> Result<Option<String>, String> {
    let selected_formats = normalize_export_formats(export_formats);

    let mut dialog = set_dialog_initial_path(rfd::FileDialog::new(), initial_path.as_deref());
    for format in &selected_formats {
        dialog = dialog.add_filter(
            format!("{} {label}", format.to_ascii_uppercase()),
            &[format],
        );
    }
    if let Some(file_name) = nonempty(default_file_name.as_deref()) {
        dialog = dialog.set_file_name(file_name);
    }
    Ok(dialog.save_file().map(|path| path.display().to_string()))
}

fn normalize_export_formats(export_formats: Vec<String>) -> Vec<String> {
    let allowed_formats = ["xlsx", "csv", "json", "docx"];
    let mut selected_formats = Vec::new();
    for format in export_formats {
        let normalized = format.trim().to_ascii_lowercase();
        if allowed_formats.contains(&normalized.as_str()) && !selected_formats.contains(&normalized)
        {
            selected_formats.push(normalized);
        }
    }
    if selected_formats.is_empty() {
        selected_formats.push("xlsx".to_string());
    }
    selected_formats
}

#[tauri::command]
pub(crate) fn pick_codes_export_bundle_file_native(
    default_file_name: Option<String>,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = set_dialog_initial_path(
        rfd::FileDialog::new().add_filter("Coding Project Export Bundle", &["zip"]),
        initial_path.as_deref(),
    );
    if let Some(file_name) = nonempty(default_file_name.as_deref()) {
        dialog = dialog.set_file_name(file_name);
    }
    Ok(dialog.save_file().map(|path| ensure_extension(path, "zip")))
}

#[tauri::command]
pub(crate) fn pick_evidence_project_save_file_native(
    default_file_name: Option<String>,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = set_dialog_initial_path(
        rfd::FileDialog::new().add_filter("Coding Projects (.evidence.json)", &["json"]),
        initial_path.as_deref(),
    );
    if let Some(file_name) = nonempty(default_file_name.as_deref()) {
        dialog = dialog.set_file_name(file_name);
    }
    Ok(dialog.save_file().map(ensure_evidence_project_extension))
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn ensure_extension(path: PathBuf, extension: &str) -> String {
    let selected = if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    {
        path
    } else {
        path.with_extension(extension)
    };
    selected.display().to_string()
}

fn ensure_evidence_project_extension(path: PathBuf) -> String {
    let text = path.to_string_lossy();
    if text.to_ascii_lowercase().ends_with(".evidence.json") {
        return path.display().to_string();
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("coding_project");
    path.with_file_name(format!("{stem}.evidence.json"))
        .display()
        .to_string()
}

fn set_dialog_initial_path(
    mut dialog: rfd::FileDialog,
    initial_path: Option<&str>,
) -> rfd::FileDialog {
    if let Some(path_value) = initial_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = Path::new(path_value);
        if path.is_file() {
            if let Some(parent) = path.parent().filter(|candidate| candidate.is_dir()) {
                dialog = dialog.set_directory(parent);
            }
        } else if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else if let Some(parent) = path.parent().filter(|candidate| candidate.is_dir()) {
            dialog = dialog.set_directory(parent);
        }
    }
    dialog
}

#[tauri::command]
pub(crate) fn open_path_native(
    path: String,
    expect_directory: Option<bool>,
    create_if_missing: Option<bool>,
) -> Result<String, String> {
    let target_path =
        validate_open_target(&path, expect_directory, create_if_missing.unwrap_or(false))?;
    open_path_with_system(&target_path)?;
    Ok(target_path.display().to_string())
}

fn validate_open_target(
    raw_path: &str,
    expect_directory: Option<bool>,
    create_if_missing: bool,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Path is required.".to_string());
    }
    if create_if_missing && expect_directory != Some(true) {
        return Err("Only an expected directory can be created when missing.".to_string());
    }

    let mut target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        target = std::env::current_dir()
            .map_err(|_| "Could not resolve the current directory.".to_string())?
            .join(target);
    }

    if !target.exists() && create_if_missing {
        fs::create_dir_all(&target)
            .map_err(|error| format!("Could not create the requested directory: {error}"))?;
    }
    if !target.exists() {
        return Err("Path does not exist.".to_string());
    }

    let metadata =
        fs::metadata(&target).map_err(|_| "Could not inspect the requested path.".to_string())?;
    match expect_directory {
        Some(true) if !metadata.is_dir() => {
            return Err("The requested path is not a directory.".to_string())
        }
        Some(false) if !metadata.is_file() => {
            return Err("The requested path is not a file.".to_string())
        }
        None if !metadata.is_file() && !metadata.is_dir() => {
            return Err("The requested path is not a file or directory.".to_string())
        }
        _ => {}
    }
    target
        .canonicalize()
        .map_err(|_| "Could not resolve the requested path.".to_string())
}

pub(crate) fn open_path_with_system(target_path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    Command::new("explorer")
        .arg(target_path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("Could not open the requested path: {error}"))?;
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(target_path)
        .spawn()
        .map_err(|error| format!("Could not open the requested path: {error}"))?;
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(target_path)
        .spawn()
        .map_err(|error| format!("Could not open the requested path: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn open_external_url_native(url: String) -> Result<(), String> {
    let validated = validate_external_url(&url)?;
    #[cfg(target_os = "windows")]
    Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(&validated)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("Could not open link: {error}"))?;
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&validated)
        .spawn()
        .map_err(|error| format!("Could not open link: {error}"))?;
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&validated)
        .spawn()
        .map_err(|error| format!("Could not open link: {error}"))?;
    Ok(())
}

fn validate_external_url(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("A valid http or https link is required.".to_string());
    }
    let (scheme, remainder) = value
        .split_once("://")
        .ok_or_else(|| "Only http and https links can be opened.".to_string())?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("Only http and https links can be opened.".to_string());
    }
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return Err("A valid http or https link is required.".to_string());
    }
    let (host, port) = if authority.starts_with('[') {
        let closing = authority
            .find(']')
            .ok_or_else(|| "A valid http or https link is required.".to_string())?;
        let suffix = &authority[closing + 1..];
        let port = if suffix.is_empty() {
            None
        } else {
            Some(
                suffix
                    .strip_prefix(':')
                    .ok_or_else(|| "A valid http or https link is required.".to_string())?,
            )
        };
        (&authority[1..closing], port)
    } else {
        if authority.matches(':').count() > 1 {
            return Err("A valid http or https link is required.".to_string());
        }
        authority
            .split_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)))
    };
    let host_is_valid = if authority.starts_with('[') {
        host.parse::<std::net::Ipv6Addr>().is_ok()
    } else if host.parse::<std::net::IpAddr>().is_ok() {
        true
    } else {
        host.split('.').all(|label| {
            !label.is_empty()
                && label
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_alphanumeric())
                && label
                    .chars()
                    .last()
                    .is_some_and(|character| character.is_ascii_alphanumeric())
                && label
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
    };
    if !host_is_valid {
        return Err("A valid http or https link is required.".to_string());
    }
    if let Some(port) = port {
        if port.is_empty()
            || port
                .parse::<u16>()
                .ok()
                .filter(|value| *value > 0)
                .is_none()
        {
            return Err("A valid http or https link is required.".to_string());
        }
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "transcript-research-studio-native-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn coding_project_extension_is_reliable() {
        assert!(
            ensure_evidence_project_extension(PathBuf::from("study.json"))
                .ends_with("study.evidence.json")
        );
        assert!(
            ensure_evidence_project_extension(PathBuf::from("study.evidence.json"))
                .ends_with("study.evidence.json")
        );
    }

    #[test]
    fn export_formats_preserve_valid_caller_order_while_deduplicating() {
        assert_eq!(
            normalize_export_formats(vec![
                "docx".to_string(),
                "XLSX".to_string(),
                "docx".to_string(),
                "invalid".to_string(),
            ]),
            vec!["docx".to_string(), "xlsx".to_string()]
        );
        assert_eq!(
            normalize_export_formats(vec!["invalid".to_string()]),
            vec!["xlsx".to_string()]
        );
    }

    #[test]
    fn open_target_enforces_kind_and_creation_rules() {
        let root = test_root();
        let file = root.join("transcript.json");
        fs::write(&file, "{}").unwrap();
        assert!(validate_open_target(file.to_str().unwrap(), Some(false), false).is_ok());
        assert!(validate_open_target(file.to_str().unwrap(), Some(true), false).is_err());
        let directory = root.join("outputs");
        assert!(validate_open_target(directory.to_str().unwrap(), Some(true), true).is_ok());
        assert!(validate_open_target(root.join("bad").to_str().unwrap(), None, true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_url_validation_allows_only_well_formed_http_links() {
        assert!(validate_external_url("https://example.org/help").is_ok());
        assert!(validate_external_url("http://127.0.0.1:8765/health").is_ok());
        assert!(validate_external_url("file:///tmp/secret").is_err());
        assert!(validate_external_url("https://example.org/\nnext").is_err());
        assert!(validate_external_url("https:///missing-host").is_err());
        assert!(validate_external_url("https://example.org:not-a-port").is_err());
        assert!(validate_external_url("https://user@example.org").is_err());
        assert!(validate_external_url("https://-invalid.example").is_err());
        assert!(validate_external_url("https://[example.org]/help").is_err());
    }
}
