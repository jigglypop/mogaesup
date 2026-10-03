from __future__ import annotations

import logging
import os


def configure_logging() -> None:
    # httpx logs each request at INFO with its whole URL, and provider download links carry their signatures.
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    root = logging.getLogger()
    if root.handlers:
        return
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )
