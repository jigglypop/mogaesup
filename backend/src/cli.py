from __future__ import annotations

from src.paths import load_environment as load_dotenv

from src import configure_logging


def api() -> None:
    from main import run_api

    load_dotenv()
    configure_logging()
    run_api()


def dev() -> None:
    from main import run_api

    load_dotenv()
    configure_logging()
    run_api(reload=True)
