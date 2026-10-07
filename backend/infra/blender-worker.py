#!/usr/local/bin/python3 -I
"""/usr/local/bin/blender in the studio image (infra/Dockerfile): every Blender the API or a CLI starts
(BLENDER_EXECUTABLE) runs as studio-worker. The workers parse provider-made and uploaded files; as that user they cannot
read the API's environment (/proc/<pid>/environ holds the provider keys) or the provider secret file, and
infra/worker-guard.sh keeps them away from the instance metadata service and the role's credentials. They write under
the data root, which entrypoint.py shares with their group, in folders the API makes with umask 002; a CLI run in the
container (docker exec) gives itself the same (sh -c 'umask 002 && python -m ...') so that its Blender can write there
too. Started by a user other than root (the image run as another user), Blender runs as that user.
"""
import ctypes
import os
import sys

BLENDER = '/opt/blender/blender'
# studio-worker: infra/Dockerfile creates it, infra/entrypoint.py shares the data root with its group, and
# infra/worker-guard.sh names its uid in the host's firewall.
WORKER = 10001
HOME = '/home/studio-worker'
PR_SET_NO_NEW_PRIVS = 38


def drop(uid=WORKER):
    """Become the worker for good: its own group only, no way back to root, and no setuid program to raise it again."""
    os.setgroups([])
    os.setresgid(uid, uid, uid)
    os.setresuid(uid, uid, uid)
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'prctl(PR_SET_NO_NEW_PRIVS) failed')


def main(argv=None, environ=None, execve=os.execve, getuid=None, become=drop):
    argv = sys.argv if argv is None else argv
    environment = dict(os.environ if environ is None else environ)
    if (getuid or os.getuid)() == 0:
        become()
        environment['HOME'] = HOME
    # The same process (its pid and start time) the caller supervises, now Blender.
    execve(BLENDER, [BLENDER, *argv[1:]], environment)


if __name__ == '__main__':
    main()
