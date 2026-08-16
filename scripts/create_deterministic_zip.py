from __future__ import annotations

import os
import shutil
import stat
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def _zip_timestamp() -> tuple[int, int, int, int, int, int]:
    source_date_epoch = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    if source_date_epoch:
        value = datetime.fromtimestamp(int(source_date_epoch), tz=timezone.utc)
        if value.year < 1980:
            value = value.replace(year=1980, month=1, day=1, hour=0, minute=0, second=0)
    else:
        value = datetime(1980, 1, 1, tzinfo=timezone.utc)
    return (value.year, value.month, value.day, value.hour, value.minute, value.second)


def _write_entry(archive: zipfile.ZipFile, source: Path, archive_name: str, timestamp: tuple[int, ...]) -> None:
    info = zipfile.ZipInfo(archive_name, date_time=timestamp)
    info.create_system = 3
    if source.is_dir():
        info.external_attr = (stat.S_IFDIR | 0o755) << 16
        info.compress_type = zipfile.ZIP_STORED
        archive.writestr(info, b"")
        return
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    with source.open("rb") as source_handle, archive.open(info, "w", force_zip64=True) as target_handle:
        shutil.copyfileobj(source_handle, target_handle, length=1024 * 1024)


def create_archive(source_root: Path, output_path: Path) -> None:
    timestamp = _zip_timestamp()
    output_path.unlink(missing_ok=True)
    entries = [source_root, *sorted(source_root.rglob("*"), key=lambda item: item.as_posix().lower())]
    with zipfile.ZipFile(
        output_path,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        allowZip64=True,
    ) as archive:
        for entry in entries:
            relative = entry.relative_to(source_root.parent).as_posix()
            if entry.is_dir():
                relative += "/"
            _write_entry(archive, entry, relative, timestamp)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: create_deterministic_zip.py SOURCE_DIRECTORY OUTPUT_ZIP")
    source_root = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    if not source_root.is_dir():
        raise SystemExit(f"source directory does not exist: {source_root}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    create_archive(source_root, output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
