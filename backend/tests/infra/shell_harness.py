"""Linux command doubles for the offline shell harness on macOS and Windows."""
import re


def replace_host_paths(text, replacements):
    """Replace original host paths once; a sandbox may itself contain /var/.

    Sequential str.replace corrupts macOS /private/var sandboxes by replacing
    paths inserted by an earlier replacement.
    """
    pattern = '|'.join(re.escape(path) for path in sorted(replacements, key=len, reverse=True))
    return re.sub(pattern, lambda match: replacements[match.group()], text)


def portable_idle_script(text):
    """Keep both fake deployment locks open on Bash 3, using fixed descriptors.

    The production script is still checked unchanged with bash -n. The harness
    holds exactly two fake locks and substitutes only Bash's dynamic-FD syntax.
    """
    original = 'exec {lock_fd}>"$lock"'
    assert text.count(original) == 1
    return text.replace(original,
        'if [[ "$lock" == *deploy.lock ]]; then lock_fd=8; exec 8>"$lock"; '
        'else lock_fd=9; exec 9>"$lock"; fi')


LINUX_FILE_COMMANDS = r'''
stat() {
  if [[ "$1" == -c && ( "$2" == %s || "$2" == %Y ) ]]; then
    "$PYTHON_EXE" -c 'import os,sys; s=os.stat(sys.argv[2]); print(s.st_size if sys.argv[1]=="%s" else int(s.st_mtime))' "$2" "$3"
  else command stat "$@"; fi
}
touch() {
  if [[ "$1" == -d && "$2" == @* ]]; then
    "$PYTHON_EXE" -c 'import os,sys; t=int(sys.argv[1][1:]); os.utime(sys.argv[2],(t,t))' "$2" "$3"
  else command touch "$@"; fi
}
'''
