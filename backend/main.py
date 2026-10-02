"""3D asset API entrypoint."""

from __future__ import annotations

import logging
import os

from src.paths import load_environment as load_dotenv

from src import configure_logging


logger = logging.getLogger(__name__)


def run_api() -> None:
    import uvicorn

    uvicorn.run(
        "src.api.server:app",
        host=os.getenv("API_HOST", "127.0.0.1"),
        port=int(os.getenv("API_PORT", "8000")),
        timeout_keep_alive=30,
        timeout_graceful_shutdown=10,
        proxy_headers=False,
        workers=1,
    )


def main() -> None:
    load_dotenv()
    configure_logging()
    logger.info("Starting 3D asset API")
    run_api()


if __name__ == "__main__":
    main()
