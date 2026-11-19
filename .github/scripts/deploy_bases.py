"""Finds what production runs, part by part, from this workflow's earlier runs on main.

A part's base is the commit of the newest run that deployed it (its deploy-<part> job succeeded, in any attempt), or of
the newest push run that passed in full: such a run skipped a deploy only because that part had not changed. Bases are
kept per part, so a studio that could not be reached leaves only the studio pending, and the server and web are not
deployed again with every later push. `check` is the newest push run that passed in full; the checks look at what changed
since then.

The web also reports what it runs (release.json, written by frontend/scripts/deploy-aws.ps1), and that is its base when
it is a commit of main's history up to this run's that the pipeline deployed: the web is deployed when a web path changed
since then. That holds after a run that passed without deploying the web (its routing base is that run's commit, the
site still names the commit it was last deployed from). A site deployed by hand (`by: manual`: built on a PC from its
own node_modules, not the build this pipeline checks) or from a commit off that history is deployed in full again; one
that names no commit changes nothing.

Run from the repository root of a full clone (git answers which commits are on main's history). Environment:
GITHUB_REPOSITORY, GH_TOKEN (read by gh), GITHUB_OUTPUT, SITE_URL (default https://mogaesup.com). Writes check=,
server=, web= and studio=; a value is empty when no run qualifies, which checks or deploys that part in full.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

PARTS = ('server', 'web', 'studio')
# Runs looked at, newest first. A part none of them deployed is deployed in full.
RUNS = 50


def gh(path, attempts=4, wait=5):
    """`gh api path`, read as JSON. A refusal the API may not repeat (a 5xx, a moment's limit) is asked again a few
    times, a little later each time; the last one says why on the run's page (an annotation) before it ends the step."""
    for attempt in range(attempts):
        done = subprocess.run(['gh', 'api', path], capture_output=True, text=True)
        if done.returncode == 0:
            return json.loads(done.stdout)
        if attempt + 1 < attempts:
            time.sleep(wait * (attempt + 1))
    why = ' '.join((done.stderr or done.stdout or '').split())[:400]
    print(f'::error::gh api {path} 이(가) {attempts}번 모두 실패했습니다: {why}')
    raise SystemExit(1)


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


def live_web_release(site):
    """The commit the site says it runs and whether it was deployed by hand; (None, False) when it does not say (an
    older release, a failed request)."""
    try:
        request = urllib.request.Request(f'{site}/release.json', headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            release = json.loads(response.read(4096))
        commit, by = release.get('git_commit'), release.get('by')
    except (OSError, ValueError, AttributeError):
        return None, False
    if not (isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit)):
        return None, False
    return commit, by == 'manual'


def on_main(commit, cwd=None):
    """Whether `commit` is this checkout's HEAD or one of its ancestors (main's history up to this run's commit)."""
    done = subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'HEAD'], cwd=cwd, capture_output=True)
    return done.returncode == 0


def reconcile(found, live_web, is_on_main=on_main, manual=False):
    """`found` with the web base set to the commit the site runs: kept when it is on main's history (the routing then
    deploys the web only for a web change since that commit), dropped (a full deploy) when it is not or when the site
    was deployed by hand (`manual`), whose build no run checked."""
    if live_web and manual:
        print(f'::warning::운영 웹은 손으로 배포한 빌드({live_web[:12]})입니다. 점검을 거친 이 실행의 빌드로 웹을 다시 배포합니다')
        return {**found, 'web': ''}
    if not live_web or live_web == found.get('web'):
        return found
    if is_on_main(live_web):
        if found.get('web'):
            print(f"운영 웹은 {live_web[:12]} 에서 배포됐습니다(실행 기록의 기준 {found['web'][:12]}). 그 뒤 바뀐 웹 경로가 "
                  '있을 때만 웹을 배포합니다', file=sys.stderr)
        return {**found, 'web': live_web}
    print(f"::warning::운영 웹은 main에 없는 커밋 {live_web[:12]} 를 돌립니다. 손으로 배포한 것으로 보고 웹을 다시 배포합니다")
    return {**found, 'web': ''}


def main():
    repository = os.environ['GITHUB_REPOSITORY']
    runs = gh(f'repos/{repository}/actions/workflows/pipeline.yml/runs?branch=main&status=completed&per_page={RUNS}')

    def jobs_of(run):
        return gh(f"repos/{repository}/actions/runs/{run['id']}/jobs?filter=all&per_page=100").get('jobs', [])

    live_web, manual = live_web_release(os.environ.get('SITE_URL', 'https://mogaesup.com'))
    found = reconcile(bases(runs.get('workflow_runs', []), jobs_of), live_web, manual=manual)
    lines = [f'{key}={value}' for key, value in found.items()]
    with open(os.environ.get('GITHUB_OUTPUT', '/dev/stdout'), 'a', encoding='utf-8') as out:
        out.write(''.join(f'{line}\n' for line in lines))
    print('\n'.join(lines), file=sys.stderr)


if __name__ == '__main__':
    main()
