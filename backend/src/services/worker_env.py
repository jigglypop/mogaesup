"""The environment of a Blender worker process: this server's, without credentials.

Workers parse provider-made GLB and PNG files, so provider keys, the record database URL and cloud credentials stay with
the server. A worker keeps storage on the local disk (ASSET_STORAGE_WORKER_LOCAL) and needs none of them.
"""
import os
import re

SECRET_NAME = re.compile(r"KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL|DSN", re.IGNORECASE)


def without_secrets(environment=None) -> dict:
    """The variables of `environment` (this process's by default) whose names do not look like credentials."""
    source = os.environ if environment is None else environment
    return {name: value for name, value in source.items() if not SECRET_NAME.search(name)}


def worker_environment(**extra) -> dict:
    """What a Blender worker is started with: no credentials, local storage, plus `extra`."""
    return {**without_secrets(), "ASSET_STORAGE_WORKER_LOCAL": "1", **extra}
