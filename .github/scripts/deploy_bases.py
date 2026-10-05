"""Finds what production runs, part by part, from this workflow's earlier runs on main.

A part's base is the commit of the newest run that deployed it (its deploy-<part> job succeeded, in any attempt), or of
the newest push run that passed in full: such a run skipped a deploy only because that part had not changed. Bases are
kept per part, so a studio that could not be reached leaves only the studio pending, and the server and web are not
deployed again with every later push. `check` is the newest push run that passed in full; the checks look at what changed
since then.

The web also reports what it runs (release.json, written by frontend/scripts/deploy-aws.ps1). When that is another
commit than the runs say, a deploy by hand put it there, and the web is deployed in full again.

Environment: GITHUB_REPOSITORY, GH_TOKEN (read by gh), GITHUB_OUTPUT, SITE_URL (default https://mogaesup.com). Writes
check=, server=, web= and studio=; a value is empty when no run qualifies, which checks or deploys that part in full.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

PARTS = ('server', 'web', 'studio')
# Runs looked at, newest first. A part none of them deployed is deployed in full.
RUNS = 50


def gh(path):
    done = subprocess.run(['gh', 'api', path], check=True, capture_output=True, text=True)
    return json.loads(done.stdout)


def bases(runs, jobs_of):
    """`runs` newest first, as the runs API lists them; `jobs_of(run)` lists the jobs of all its attempts."""
    found = {'check': '', **{part: '' for part in PARTS}}
    for run in runs:
        if run.get('status') != 'completed' or run.get('event') not in ('push', 'workflow_dispatch'):
            continue
        sha = run['head_sha']
        if run['event'] == 'push' and run.get('conclusion') == 'success':
            # Every part not found yet is as this run left it, and nothing older matters.
            for key, value in found.items():
                found[key] = value or sha
            break
        deployed = {job.get('name') for job in jobs_of(run) if job.get('conclusion') == 'success'}
        for part in PARTS:
            if not found[part] and f'deploy-{part}' in deployed:
                found[part] = sha
    return found


def live_web_commit(site):
    """The commit the site says it runs, or None when it does not say (an older release, a failed request)."""
    try:
        request = urllib.request.Request(f'{site}/release.json', headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            commit = json.loads(response.read(4096)).get('git_commit')
    except (OSError, ValueError, AttributeError):
        return None
    return commit if isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit) else None


def reconcile(found, live_web):
    """`found` with the web base dropped when the site runs another commit than the runs recorded."""
    if found.get('web') and live_web and live_web != found['web']:
        print(f"::warning::운영 웹은 {live_web[:12]} 를 돌리는데 마지막 배포 기록은 {found['web'][:12]} 입니다. "
              '손으로 배포한 것으로 보고 웹을 다시 배포합니다')
        return {**found, 'web': ''}
    return found


def main():
    repository = os.environ['GITHUB_REPOSITORY']
    runs = gh(f'repos/{repository}/actions/workflows/pipeline.yml/runs?branch=main&status=completed&per_page={RUNS}')

    def jobs_of(run):
        return gh(f"repos/{repository}/actions/runs/{run['id']}/jobs?filter=all&per_page=100").get('jobs', [])

    found = reconcile(bases(runs.get('workflow_runs', []), jobs_of),
                      live_web_commit(os.environ.get('SITE_URL', 'https://mogaesup.com')))
    lines = [f'{key}={value}' for key, value in found.items()]
    with open(os.environ.get('GITHUB_OUTPUT', '/dev/stdout'), 'a', encoding='utf-8') as out:
        out.write(''.join(f'{line}\n' for line in lines))
    print('\n'.join(lines), file=sys.stderr)


if __name__ == '__main__':
    main()
