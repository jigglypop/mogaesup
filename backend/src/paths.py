"""Stable server paths, independent of the process working directory."""

import os
from pathlib import Path

from dotenv import load_dotenv as _load_dotenv


BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent


def load_environment() -> None:
    _load_dotenv(PROJECT_ROOT / ".env")


def data_root() -> Path:
    configured = os.getenv("ASSET_DATA_ROOT")
    return Path(configured).expanduser().resolve() if configured else PROJECT_ROOT / "data"
