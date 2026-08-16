from dataclasses import asdict, dataclass


@dataclass(slots=True)
class HealthStatus:
    status: str
    bind: str
    environment: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)
