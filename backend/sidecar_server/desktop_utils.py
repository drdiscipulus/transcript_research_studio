from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def pick_folder(initial_directory: str | None = None) -> str | None:
    initial_path = _normalize_directory_hint(initial_directory)

    if sys.platform == "win32":
        return _pick_folder_windows(initial_path)
    if sys.platform == "darwin":
        return _pick_folder_macos(initial_path)

    raise RuntimeError("Native folder picking is currently supported on Windows and macOS only.")


def open_path(path_value: str, *, expect_directory: bool = False, create_if_missing: bool = False) -> str:
    target_path = Path(path_value).expanduser()
    if not target_path.is_absolute():
        target_path = target_path.resolve()

    if expect_directory and create_if_missing:
        target_path.mkdir(parents=True, exist_ok=True)

    if not target_path.exists():
        raise ValueError(f"Path does not exist: {target_path}")

    if sys.platform == "win32":
        os.startfile(str(target_path))  # type: ignore[attr-defined]
        return str(target_path)

    if sys.platform == "darwin":
        completed = subprocess.run(
            ["open", str(target_path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
    else:
        completed = subprocess.run(
            ["xdg-open", str(target_path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )

    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "Open path command failed."
        raise RuntimeError(message)
    return str(target_path)


def _normalize_directory_hint(value: str | None) -> str | None:
    if not value:
        return None
    candidate = Path(value).expanduser()
    if candidate.is_dir():
        return str(candidate.resolve())
    return None


def _pick_folder_windows(initial_directory: str | None) -> str | None:
    script = """
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder'
$dialog.ShowNewFolderButton = $true
$initial = $env:TRANSCRIPT_RESEARCH_STUDIO_INITIAL_DIRECTORY
if ($initial) {
  $dialog.SelectedPath = $initial
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
""".strip()
    environment = os.environ.copy()
    if initial_directory:
        environment["TRANSCRIPT_RESEARCH_STUDIO_INITIAL_DIRECTORY"] = initial_directory

    completed = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            script,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=environment,
        check=False,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "Windows folder picker failed."
        raise RuntimeError(message)
    selected = completed.stdout.strip()
    return selected or None


def _pick_folder_macos(initial_directory: str | None) -> str | None:
    script_lines = []
    if initial_directory:
        escaped = initial_directory.replace("\\", "\\\\").replace('"', '\\"')
        script_lines.append(
            f'set selectedFolder to choose folder with prompt "Choose a folder" default location POSIX file "{escaped}"'
        )
    else:
        script_lines.append('set selectedFolder to choose folder with prompt "Choose a folder"')
    script_lines.append("POSIX path of selectedFolder")

    command = ["osascript"]
    for line in script_lines:
        command.extend(["-e", line])

    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        if "User canceled" in stderr:
            return None
        raise RuntimeError(stderr or completed.stdout.strip() or "macOS folder picker failed.")

    selected = completed.stdout.strip()
    return selected or None
