"""Model registry — stores model artifacts with metadata in a JSON manifest."""

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class ModelEntry:
    model_id: str
    file_path: str
    train_start: str
    train_end: str
    feature_schema_version: int
    validation_metrics: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    active: bool = False


MANIFEST_FILENAME = "model_manifest.json"


class ModelRegistry:
    def __init__(self, registry_dir: str = "./models") -> None:
        self.registry_dir = Path(registry_dir)
        self.registry_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.registry_dir / MANIFEST_FILENAME
        self.entries: list[ModelEntry] = []
        self._load()

    def register(self, entry: ModelEntry) -> None:
        existing = self._find(entry.model_id)
        if existing is not None:
            self.entries[existing] = entry
        else:
            self.entries.append(entry)
        self._save()

    def activate(self, model_id: str) -> bool:
        idx = self._find(model_id)
        if idx is None:
            return False
        for e in self.entries:
            e.active = False
        self.entries[idx].active = True
        self._save()
        return True

    def active_model(self) -> ModelEntry | None:
        for e in self.entries:
            if e.active:
                return e
        return None

    def get(self, model_id: str) -> ModelEntry | None:
        idx = self._find(model_id)
        return self.entries[idx] if idx is not None else None

    def list_models(self) -> list[ModelEntry]:
        return list(self.entries)

    def _find(self, model_id: str) -> int | None:
        for i, e in enumerate(self.entries):
            if e.model_id == model_id:
                return i
        return None

    def _load(self) -> None:
        if not self.manifest_path.exists():
            self.entries = []
            return
        raw = json.loads(self.manifest_path.read_text())
        self.entries = [ModelEntry(**item) for item in raw]

    def _save(self) -> None:
        data = [asdict(e) for e in self.entries]
        self.manifest_path.write_text(json.dumps(data, indent=2) + "\n")
