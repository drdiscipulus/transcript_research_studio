from __future__ import annotations

import contextlib
import ctypes
import os
import platform
import shutil
import subprocess
import threading
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .runtime_env import detect_runtime_variant, probe_cuda_runtime, probe_speaker_runtime


@dataclass(slots=True)
class HardwareSummary:
    cpu_model: str
    physical_cores: int
    logical_cores: int
    total_ram_gb: float
    gpu_model: str
    vram_gb: float | None
    has_supported_nvidia_gpu: bool
    cuda_available: bool
    asr_cuda_available: bool
    pyannote_available: bool
    pyannote_cuda_available: bool
    runtime_variant: str
    acceleration_path: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class SystemHardwareSummary:
    cpu_model: str
    physical_cores: int
    logical_cores: int
    total_ram_gb: float
    gpu_model: str
    vram_gb: float | None
    has_supported_nvidia_gpu: bool
    runtime_variant: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class HardwareScanManager:
    """Own one phased hardware scan and expose non-blocking snapshots."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._generation = 0
        self._status = "checking"
        self._phase = "system"
        self._message = "Reading system hardware..."
        self._system: SystemHardwareSummary | None = None
        self._hardware: HardwareSummary | None = None
        self._retryable = False
        self._worker: threading.Thread | None = None

    def start(self) -> bool:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return False
            if self._status == "ready":
                return False
            self._generation += 1
            generation = self._generation
            self._status = "checking"
            self._phase = "system"
            self._message = "Reading system hardware..."
            self._system = None
            self._hardware = None
            self._retryable = False
            worker = threading.Thread(
                target=self._run,
                args=(generation,),
                daemon=True,
                name=f"hardware-scan-{generation}",
            )
            self._worker = worker
            worker.start()
            return True

    def retry(self) -> bool:
        with self._lock:
            if self._status != "failed":
                return False
        return self.start()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "generation": self._generation,
                "status": self._status,
                "phase": self._phase,
                "message": self._message,
                "system": None if self._system is None else self._system.to_dict(),
                "hardware": None if self._hardware is None else self._hardware.to_dict(),
                "retryable": self._retryable,
            }

    def ready_summary(self) -> HardwareSummary | None:
        with self._lock:
            return self._hardware if self._status == "ready" else None

    def _publish_phase(
        self,
        generation: int,
        phase: str,
        message: str,
        *,
        system: SystemHardwareSummary | None = None,
    ) -> bool:
        with self._lock:
            if generation != self._generation:
                return False
            self._status = "checking"
            self._phase = phase
            self._message = message
            if system is not None:
                self._system = system
            return True

    def _run(self, generation: int) -> None:
        try:
            system = detect_system_hardware()
            if not self._publish_phase(
                generation,
                "transcription_acceleration",
                "Checking CUDA runtime...",
                system=system,
            ):
                return

            profile_allows_cuda = system.runtime_variant not in {"windows-cpu", "macos-cpu"}
            asr_cuda_available = (
                system.has_supported_nvidia_gpu
                and profile_allows_cuda
                and probe_cuda_runtime()
            )
            if not self._publish_phase(
                generation,
                "speaker_acceleration",
                "Checking speaker detection acceleration...",
            ):
                return

            speaker_runtime = probe_speaker_runtime()
            pyannote_available = bool(
                speaker_runtime["torch_available"] and speaker_runtime["pyannote_available"]
            )
            pyannote_cuda_available = (
                system.has_supported_nvidia_gpu
                and profile_allows_cuda
                and pyannote_available
                and bool(speaker_runtime["torch_cuda_available"])
            )
            hardware = HardwareSummary(
                cpu_model=system.cpu_model,
                physical_cores=system.physical_cores,
                logical_cores=system.logical_cores,
                total_ram_gb=system.total_ram_gb,
                gpu_model=system.gpu_model,
                vram_gb=system.vram_gb,
                has_supported_nvidia_gpu=system.has_supported_nvidia_gpu,
                cuda_available=asr_cuda_available,
                asr_cuda_available=asr_cuda_available,
                pyannote_available=pyannote_available,
                pyannote_cuda_available=pyannote_cuda_available,
                runtime_variant=system.runtime_variant,
                acceleration_path="NVIDIA / CUDA" if asr_cuda_available else "CPU",
            )
            with self._lock:
                if generation != self._generation:
                    return
                self._status = "ready"
                self._phase = "ready"
                self._message = "Hardware detection complete."
                self._hardware = hardware
                self._retryable = False
        except Exception:  # noqa: BLE001
            with self._lock:
                if generation != self._generation:
                    return
                self._status = "failed"
                self._phase = "failed"
                self._message = "Hardware detection failed. CPU processing remains available."
                self._hardware = None
                self._retryable = True


def detect_system_hardware() -> SystemHardwareSummary:
    logical_cores = os.cpu_count() or 1
    gpu_model, vram_gb = detect_nvidia_gpu()
    return SystemHardwareSummary(
        cpu_model=detect_cpu_model(),
        physical_cores=detect_physical_cores(logical_cores),
        logical_cores=logical_cores,
        total_ram_gb=round(detect_total_ram_gb(), 1),
        gpu_model=gpu_model,
        vram_gb=None if vram_gb is None else round(vram_gb, 1),
        has_supported_nvidia_gpu=gpu_model != "No supported GPU detected",
        runtime_variant=detect_runtime_variant(),
    )


hardware_scan_manager = HardwareScanManager()


def start_hardware_scan() -> None:
    hardware_scan_manager.start()


def detect_cpu_model() -> str:
    system = platform.system()
    if system == "Windows":
        name = detect_windows_cpu_model()
        if name:
            return name
        name, _ = detect_windows_processor_info()
        if name:
            return name
    if system == "Darwin":
        name = run_command(["sysctl", "-n", "machdep.cpu.brand_string"])
        if name:
            return name
    if system == "Linux":
        cpuinfo = Path("/proc/cpuinfo")
        if cpuinfo.exists():
            with contextlib.suppress(OSError):
                for line in cpuinfo.read_text(encoding="utf-8").splitlines():
                    if line.lower().startswith("model name"):
                        return line.split(":", 1)[1].strip()
    return platform.processor() or "Unknown CPU"


def detect_physical_cores(logical_cores: int) -> int:
    system = platform.system()
    if system == "Windows":
        physical_cores = detect_windows_physical_cores()
        if physical_cores is not None:
            return physical_cores
        _, physical_cores = detect_windows_processor_info()
        if physical_cores is not None:
            return physical_cores
    if system == "Darwin":
        value = run_command(["sysctl", "-n", "hw.physicalcpu"])
        if value and value.isdigit():
            return int(value)
    if system == "Linux":
        value = run_command(["bash", "-lc", "lscpu -p=Core | grep -v '^#' | sort -u | wc -l"])
        if value and value.isdigit():
            return int(value)
    return logical_cores


def detect_total_ram_gb() -> float:
    system = platform.system()
    if system == "Windows":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        memory_status = MemoryStatus()
        memory_status.dwLength = ctypes.sizeof(MemoryStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory_status)):
            return memory_status.ullTotalPhys / (1024**3)

    if system == "Darwin":
        value = run_command(["sysctl", "-n", "hw.memsize"])
        if value and value.isdigit():
            return int(value) / (1024**3)

    if system == "Linux":
        meminfo = Path("/proc/meminfo")
        if meminfo.exists():
            with contextlib.suppress(OSError):
                for line in meminfo.read_text(encoding="utf-8").splitlines():
                    if line.startswith("MemTotal:"):
                        parts = line.split()
                        if len(parts) >= 2 and parts[1].isdigit():
                            return int(parts[1]) * 1024 / (1024**3)

    return 0.0


def detect_nvidia_gpu() -> tuple[str, float | None]:
    if shutil.which("nvidia-smi") is None:
        return ("No supported GPU detected", None)

    output = run_command(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ]
    )
    if not output:
        return ("No supported GPU detected", None)

    first_line = output.splitlines()[0]
    parts = [part.strip() for part in first_line.split(",")]
    if not parts:
        return ("No supported GPU detected", None)

    name = parts[0] or "NVIDIA GPU"
    vram_gb = None
    if len(parts) > 1:
        with contextlib.suppress(ValueError):
            vram_gb = float(parts[1]) / 1024
    return (name, vram_gb)


def run_command(command: list[str]) -> str:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""

    if completed.returncode != 0:
        return ""
    return completed.stdout.strip()


def detect_windows_cpu_model() -> str | None:
    try:
        import winreg
    except ImportError:
        return None

    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        ) as key:
            value, _ = winreg.QueryValueEx(key, "ProcessorNameString")
    except OSError:
        return None

    normalized = str(value).strip()
    return normalized or None


def detect_windows_physical_cores() -> int | None:
    if os.name != "nt":
        return None

    relation_processor_core = 0
    returned_length = ctypes.c_ulong(0)
    kernel32 = ctypes.windll.kernel32
    kernel32.GetLogicalProcessorInformationEx(
        relation_processor_core,
        None,
        ctypes.byref(returned_length),
    )
    if returned_length.value <= 0:
        return None

    buffer = ctypes.create_string_buffer(returned_length.value)
    if not kernel32.GetLogicalProcessorInformationEx(
        relation_processor_core,
        buffer,
        ctypes.byref(returned_length),
    ):
        return None

    offset = 0
    physical_cores = 0
    while offset + 8 <= returned_length.value:
        relationship = ctypes.c_int.from_buffer_copy(buffer, offset).value
        record_size = ctypes.c_ulong.from_buffer_copy(buffer, offset + 4).value
        if record_size <= 0:
            break
        if relationship == relation_processor_core:
            physical_cores += 1
        offset += record_size

    return physical_cores or None


@lru_cache(maxsize=1)
def detect_windows_processor_info() -> tuple[str | None, int | None]:
    output = run_command(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores; "
            "if ($cpu) { Write-Output ($cpu.Name + \"`t\" + $cpu.NumberOfCores) }",
        ]
    )
    if not output:
        return None, None

    name, _, cores_text = output.partition("\t")
    normalized_name = name.strip() or None
    physical_cores = None
    if cores_text.strip().isdigit():
        physical_cores = int(cores_text.strip())
    return normalized_name, physical_cores
