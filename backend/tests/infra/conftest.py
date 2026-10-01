import os
import shutil
import subprocess
import sys

import pytest


def _usable(candidate):
    """A bash that runs here and can start this interpreter (the WSL launcher on Windows can do neither)."""
    try:
        done = subprocess.run([candidate, '-c', '"$PYTHON_EXE" -c "print(1)"; echo ok'], capture_output=True, text=True,
                              timeout=60, env={**os.environ, 'PYTHON_EXE': sys.executable})
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0 and done.stdout.split() == ['1', 'ok']


@pytest.fixture(scope='session')
def bash():
    """Path of a working bash for scripts that are checked with `bash -n` or run against stubbed commands."""
    candidates = [shutil.which('bash'), r'C:\Program Files\Git\bin\bash.exe', r'C:\Program Files\Git\usr\bin\bash.exe']
    for candidate in dict.fromkeys(filter(None, candidates)):
        if _usable(candidate):
            return candidate
    pytest.skip('no usable bash')
