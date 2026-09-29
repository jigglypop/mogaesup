"""3D asset API entrypoint."""

from __future__ import annotations

import logging
import os

from src.paths import BACKEND_ROOT, load_environment as load_dotenv

from src import configure_logging


logger = logging.getLogger(__name__)


def run_api(*, reload: bool = False) -> None:
    import uvicorn

    uvicorn.run(
        "src.api.server:app",
        host=os.getenv("API_HOST", "0.0.0.0"),
        port=int(os.getenv("API_PORT", "8000")),
        reload=reload,
        reload_dirs=[str(BACKEND_ROOT / "src")] if reload else None,
        timeout_keep_alive=30,
        timeout_graceful_shutdown=10,
    )


def main() -> None:
    load_dotenv()
    configure_logging()
    logger.info("Starting 3D asset API")
    run_api()


if __name__ == "__main__":
    main()
