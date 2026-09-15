from __future__ import annotations

import os
from pathlib import Path

DATA_ENV_VAR = "QUANTUM_SANDBOX_DATA"
DEFAULT_DATA_DIR = "~/.quantum-sandbox"


def get_data_dir() -> Path:
    configured = os.getenv(DATA_ENV_VAR, DEFAULT_DATA_DIR)
    return Path(configured).expanduser().resolve()


def ensure_data_dir() -> Path:
    data_dir = get_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def get_db_path() -> Path:
    return ensure_data_dir() / "jobs.sqlite3"
