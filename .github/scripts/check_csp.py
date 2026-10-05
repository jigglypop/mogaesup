"""The web page against the Content-Security-Policy of frontend/infra/aws-static.yaml.

    python3 check_csp.py --html frontend/index.html --template frontend/infra/aws-static.yaml
    python3 check_csp.py --html frontend/dist/index.html --template frontend/infra/aws-static.yaml
        fail when the template's policy lacks the hash of an inline script of that page, or when the page loads a script,
        stylesheet or other resource from another origin, which the policy ('self') would block. The pipeline checks the
        source page and the built one: the build may rewrite the inline scripts.
    python3 check_csp.py --html frontend/dist/index.html --live https://mogaesup.com [--template ...]
        warns when the site's policy lacks a script's hash, and, given the template, when the site's policy differs from
        it: the stack was not applied yet (the pipeline never applies it), and until it is, browsers follow the old one.
"""
import argparse
import base64
import hashlib
import re
import sys
import urllib.parse
import urllib.request

# An inline script: no src attribute, its text taken byte for byte as the browser hashes it.
INLINE = re.compile(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', re.S | re.I)
# The resources a page loads from its markup: scripts, stylesheets, preloads, icons, images, media. A <link> counts only
# with a relation that loads something (not canonical or alternate, which only name an address).
TAG = re.compile(r'<(script|link|img|source|video|audio|iframe)\b([^>]*)>', re.I)
ADDRESS = re.compile(r'\b(?:src|href)\s*=\s*["\']([^"\']+)["\']', re.I)
LOADING = re.compile(r'\brel\s*=\s*["\'][^"\']*\b(stylesheet|preload|modulepreload|prefetch|icon|manifest)\b', re.I)
# The policy in the template: the folded scalar after `ContentSecurityPolicy: !Sub` and `- >-`, up to its variables.
TEMPLATE_POLICY = re.compile(r'ContentSecurityPolicy: !Sub\n\s+- >-\n(.*?)\n\s+- LiveRoom: ', re.S)


def hashes(html):
    return [f"'sha256-{base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()}'"
            for body in INLINE.findall(html)]


def foreign(html):
    """References to another origin; data: and blob: URLs and paths on this site are fine."""
    found = []
    for name, attributes in TAG.findall(html):
        address = ADDRESS.search(attributes)
        if not address or (name.lower() == 'link' and not LOADING.search(attributes)):
            continue
        value = address.group(1)
        if value.startswith('//') or (re.match(r'^[a-z][a-z0-9+.-]*:', value, re.I)
                                      and not re.match(r'^(data|blob):', value, re.I)):
            found.append(value)
    return found


def directives(policy):
    found = {}
    for part in policy.split(';'):
        words = part.split()
        if words:
            found[words[0].lower()] = sorted(words[1:])
    return found


def template_policy(text, host):
    """The policy the template gives a site on `host` (the LiveRoom variable as the stack fills it with DomainName)."""
    match = TEMPLATE_POLICY.search(text)
    if not match:
        return None
    policy = ' '.join(line.strip() for line in match.group(1).splitlines())
    return policy.replace('${LiveRoom}', f' wss://{host}' if host else '')


def live_policy(url):
    request = urllib.request.Request(url, method='HEAD', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.headers.get('content-security-policy', '')


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--html', required=True)
    parser.add_argument('--template')
    parser.add_argument('--live')
    args = parser.parse_args(argv)
    if not args.template and not args.live:
        parser.error('--template or --live is required')
    with open(args.html, encoding='utf-8') as file:
        html = file.read()
    wanted = hashes(html)
    template = None
    if args.template:
        with open(args.template, encoding='utf-8') as file:
            template = file.read()
    if not args.live:
        missing = [value for value in wanted if value not in template]
        for value in missing:
            print(f'::error file={args.template}::script-src에 {args.html}의 인라인 스크립트 해시 {value}가 없습니다')
        outside = foreign(html)
        for value in outside:
            print(f"::error file={args.html}::{value} 는 다른 출처라 CSP('self')가 막습니다")
        if not missing and not outside:
            print(f'{args.html}: {len(wanted)}개 인라인 스크립트의 해시가 CSP에 있고 다른 출처의 자원이 없습니다')
        return 1 if missing or outside else 0
    policy = live_policy(args.live)
    for value in wanted:
        if value not in policy:
            print(f'::warning::{args.live}의 CSP에 인라인 스크립트 해시 {value}가 없습니다. '
                  'frontend/infra/aws-static.yaml을 적용(-ProvisionOnly)하기 전까지 브라우저가 그 스크립트를 건너뜁니다')
    if template is not None:
        expected = template_policy(template, urllib.parse.urlsplit(args.live).hostname)
        if expected is None:
            print(f'::error file={args.template}::템플릿에서 CSP를 찾지 못했습니다')
            return 1
        have, want = directives(policy), directives(expected)
        changed = sorted(name for name in set(have) | set(want) if have.get(name) != want.get(name))
        if changed:
            print(f"::warning::{args.live}의 CSP가 frontend/infra/aws-static.yaml과 다릅니다({', '.join(changed)}). "
                  '스택을 적용(-ProvisionOnly)하기 전까지 운영은 예전 정책을 따릅니다')
        else:
            print(f'{args.live}의 CSP가 템플릿과 같습니다')
    return 0


if __name__ == '__main__':
    sys.exit(main())
