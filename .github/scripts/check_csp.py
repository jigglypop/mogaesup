"""The inline scripts of the web page against the Content-Security-Policy that has to allow them by hash.

    python3 check_csp.py --html frontend/index.html --template frontend/infra/aws-static.yaml
        fails when the template's policy lacks a script's hash (the repository is inconsistent).
    python3 check_csp.py --html frontend/dist/index.html --live https://mogaesup.com
        warns when the site's policy lacks it: the stack (frontend/infra/aws-static.yaml) was not applied yet, and until it
        is, browsers skip that script.
"""
import argparse
import base64
import hashlib
import re
import sys
import urllib.request

# An inline script: no src attribute, its text taken byte for byte as the browser hashes it.
INLINE = re.compile(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', re.S | re.I)


def hashes(html):
    return [f"'sha256-{base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()}'"
            for body in INLINE.findall(html)]


def live_policy(url):
    request = urllib.request.Request(url, method='HEAD', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.headers.get('content-security-policy', '')


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--html', required=True)
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument('--template')
    where.add_argument('--live')
    args = parser.parse_args(argv)
    with open(args.html, encoding='utf-8') as file:
        wanted = hashes(file.read())
    if args.template:
        with open(args.template, encoding='utf-8') as file:
            policy = file.read()
    else:
        policy = live_policy(args.live)
    missing = [value for value in wanted if value not in policy]
    for value in missing:
        if args.template:
            print(f'::error file={args.template}::script-src에 {args.html}의 인라인 스크립트 해시 {value}가 없습니다')
        else:
            print(f'::warning::{args.live}의 CSP에 인라인 스크립트 해시 {value}가 없습니다. '
                  'frontend/infra/aws-static.yaml을 적용(-ProvisionOnly)하기 전까지 브라우저가 그 스크립트를 건너뜁니다')
    if not missing:
        print(f'{len(wanted)}개 인라인 스크립트의 해시가 CSP에 있습니다')
    return 1 if missing and args.template else 0


if __name__ == '__main__':
    sys.exit(main())
