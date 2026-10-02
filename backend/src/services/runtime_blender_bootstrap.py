"""Fixed Blender preflight: retain a real work lease until this worker process exits.

Runs before the recipe via --python and needs only Python's standard library. If the admitting
parent died before preflight, --python-exit-code stops Blender before any recipe can run.
"""
import atexit
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location('_studio_runtime_activity', Path(__file__).with_name('runtime_activity.py'))
_runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_runtime)
_work = _runtime.worker_task()
_work.__enter__()
atexit.register(_work.__exit__, None, None, None)
