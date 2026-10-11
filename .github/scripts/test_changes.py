"""Exercise release routing against real commit history without touching the checkout, and the pipeline's CSP check."""
import contextlib
import http.server
import importlib.util
import io
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
import urllib.request


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCRIPT = HERE / "changes.sh"
KEYS = ("server_check", "backend_check", "frontend_check", "infra_check",
        "deploy_server", "deploy_web", "deploy_studio")
PARTS = ("server", "web", "studio")


def bash_major(path):
    """The major version of the bash at `path`, or 0 when it does not run."""
    try:
        done = subprocess.run([path, "-c", 'echo "${BASH_VERSINFO[0]}"'], capture_output=True, text=True)
    except OSError:
        return 0
    return int(done.stdout) if done.stdout.strip().isdigit() else 0


# changes.sh needs bash 4 or later; macOS's /bin/bash is 3.2 and can come before Homebrew's on PATH. Without a newer
# one, PATH's bash runs it and changes.sh says why it stops.
BASH = os.environ.get("BASH_EXECUTABLE") or next(
    (path for path in (shutil.which("bash"), "/opt/homebrew/bin/bash", "/usr/local/bin/bash")
     if path and bash_major(path) >= 4), shutil.which("bash"))


def load_bases():
    spec = importlib.util.spec_from_file_location("deploy_bases", HERE / "deploy_bases.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parts_of(paths):
    """The release_parts.sh answer for each path."""
    script = f'source "{(HERE / "release_parts.sh").as_posix()}"\nwhile IFS= read -r p; do echo "$(parts_of "$p")"; done\n'
    # Bytes in and out: text mode on Windows would hand bash CRLF line ends, which no pattern matches.
    done = subprocess.run([BASH, "-c", script], input=("\n".join(paths) + "\n").encode("utf-8"), check=True,
                          capture_output=True)
    lines = done.stdout.decode("utf-8").splitlines()
    assert len(lines) == len(paths), "one answer per path"
    return dict(zip(paths, (set(line.split()) for line in lines)))


class ReleaseRouting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="release-routing-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "--quiet")
        self.git("config", "user.name", "Release routing test")
        self.git("config", "user.email", "test@example.invalid")
        self.commit("README.md")
        self.base = self.head()
        # Where each part was last deployed from; None follows the check base.
        self.deployed = dict.fromkeys(PARTS)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout

    def head(self):
        return self.git("rev-parse", "HEAD").strip()

    def commit(self, *files):
        for name in files:
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("test\n", encoding="utf-8")
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", "test fixture")

    def route(self, event="push", base=None, ref="refs/heads/main", target=""):
        if not BASH:
            self.fail("bash is required")
        output = self.repo / "output.txt"
        output.unlink(missing_ok=True)
        base = self.base if base is None else base
        env = {**os.environ, "EVENT": event, "BASE": base, "REF": ref, "TARGET": target,
               "GITHUB_OUTPUT": output.as_posix(), "GITHUB_STEP_SUMMARY": (self.repo / "summary.md").as_posix(),
               **{f"BASE_{part.upper()}": base if self.deployed[part] is None else self.deployed[part]
                  for part in PARTS}}
        done = subprocess.run([BASH, SCRIPT.as_posix()], cwd=self.repo, env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        values = dict(line.split("=", 1) for line in output.read_text().splitlines())
        self.assertEqual(set(values), set(KEYS))
        return {key for key, value in values.items() if value == "true"}

    def test_first_main_push_checks_and_deploys_everything(self):
        self.assertEqual(self.route(base=""), set(KEYS))

    def test_missing_base_commit_checks_and_deploys_everything(self):
        self.assertEqual(self.route(base="f" * 40), set(KEYS))

    def test_pull_request_never_deploys(self):
        self.commit("server/src/main.rs", "backend/src/auth.py", "frontend/src/main.tsx")
        self.assertEqual(self.route(event="pull_request"),
                         {"server_check", "backend_check", "frontend_check", "infra_check"})

    def test_non_main_manual_run_never_deploys(self):
        self.assertEqual(self.route(event="workflow_dispatch", ref="refs/heads/topic", target="all"),
                         set(KEYS[:4]))

    def test_manual_target_checks_all_and_deploys_only_target(self):
        for target, deploy in (("server", "deploy_server"), ("web", "deploy_web"),
                               ("studio", "deploy_studio")):
            with self.subTest(target=target):
                self.assertEqual(self.route(event="workflow_dispatch", target=target),
                                 {*KEYS[:4], deploy})

    def test_manual_all(self):
        self.assertEqual(self.route(event="workflow_dispatch", target="all"), set(KEYS))

    def test_manual_run_also_deploys_what_is_still_pending(self):
        # A manual run that replaced a waiting push takes over what that push would have deployed.
        self.commit("server/src/main.rs")
        self.assertEqual(self.route(event="workflow_dispatch", target="studio"),
                         {*KEYS[:4], "deploy_server", "deploy_studio"})

    def test_runtime_changes_route_to_each_service(self):
        for path, expected in (
            ("frontend/src/main.tsx", {"frontend_check", "deploy_web"}),
            ("frontend/vendor/gaesup-world-fixed.tgz", {"frontend_check", "deploy_web"}),
            ("server/migrations/003.sql", {"server_check", "deploy_server"}),
            ("backend/src/services/job.py", {"backend_check", "infra_check", "deploy_studio"}),
        ):
            with self.subTest(path=path):
                self.commit(path)
                self.assertEqual(self.route(), expected)
                self.base = self.head()

    def test_hangul_paths_are_routed(self):
        self.commit("frontend/public/gltf/모개.glb")
        self.assertEqual(self.route(), {"frontend_check", "deploy_web"})

    def test_new_build_inputs_deploy_without_being_listed(self):
        self.commit("server/build.rs", "frontend/postcss.config.js")
        self.assertEqual(self.route(), {"server_check", "frontend_check", "deploy_server", "deploy_web"})

    def test_new_studio_paths_run_the_release_check(self):
        # They deploy the studio without being listed, and only the infra check (ReleasePaths) sees whether
        # backend/infra/prepare-aws.ps1 packs them too.
        for path in ("backend/prompts/garment.txt", "backend/config.json"):
            with self.subTest(path=path):
                self.commit(path)
                self.assertEqual(self.route(event="pull_request"), {"backend_check", "infra_check"})
                self.assertEqual(self.route(), {"backend_check", "infra_check", "deploy_studio"})
                self.base = self.head()

    def test_tests_and_documents_do_not_deploy(self):
        self.commit("frontend/src/__tests__/page.test.ts", "server/tests/api.rs",
                    "backend/tests/test_api.py", "backend/README.md")
        self.assertEqual(self.route(), {"frontend_check", "server_check", "backend_check", "infra_check"})

    def test_notes_inside_runtime_folders_do_not_deploy(self):
        self.commit("frontend/src/character/AGENTS.md", "backend/src/AGENTS.md",
                    "frontend/vendor/engine.patch", "frontend/vendor/engine.provenance.json")
        self.assertEqual(self.route(), {"frontend_check", "backend_check", "infra_check"})

    def test_python_auth_change_checks_server_contract(self):
        self.commit("backend/src/auth.py")
        self.assertEqual(self.route(), {"server_check", "backend_check", "infra_check", "deploy_studio"})

    def test_workflow_change_checks_and_deploys_everything(self):
        self.commit(".github/workflows/pipeline.yml")
        self.assertEqual(self.route(), set(KEYS))

    def test_routing_helper_change_only_checks(self):
        self.commit(".github/scripts/changes.sh")
        self.assertEqual(self.route(), set(KEYS[:4]))

    def test_deployment_script_changes_roll_out_after_their_tests(self):
        # Both are tested with the character server's tests (backend/tests/infra).
        self.commit("frontend/scripts/deploy-aws.ps1", "server/scripts/deploy-rust-server.py")
        self.assertEqual(self.route(), {"server_check", "backend_check", "frontend_check", "infra_check",
                                      "deploy_server", "deploy_web"})

    def test_web_deploy_script_runs_its_tests(self):
        self.commit("frontend/scripts/deploy-aws.ps1")
        self.assertEqual(self.route(), {"backend_check", "frontend_check", "infra_check", "deploy_web"})

    def test_studio_screens_the_mcp_mirrors_run_its_tests(self):
        self.commit("frontend/src/character/studio/garment-styles.json")
        self.assertEqual(self.route(), {"frontend_check", "backend_check", "deploy_web"})

    def test_prop_generator_runs_its_tests(self):
        self.commit("scripts/props/generate.py")
        self.assertEqual(self.route(), {"backend_check", "infra_check"})

    def test_dependency_locks_route_runtime_releases(self):
        self.commit("package-lock.json", "uv.lock")
        self.assertEqual(self.route(), {"server_check", "backend_check", "frontend_check",
                                      "deploy_web", "deploy_studio"})

    def test_new_push_includes_changes_from_failed_previous_run(self):
        self.commit("server/src/main.rs")
        self.commit("frontend/src/main.tsx")
        self.assertEqual(self.route(), {"server_check", "frontend_check", "deploy_server", "deploy_web"})

    def test_runtime_deletion_still_deploys(self):
        self.commit("server/src/removed.rs")
        self.base = self.head()
        (self.repo / "server/src/removed.rs").unlink()
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", "remove runtime file")
        self.assertEqual(self.route(), {"server_check", "deploy_server"})

    def test_a_studio_left_behind_does_not_redeploy_the_others(self):
        # One run deployed the server and the web, then could not reach the studio: only the studio is still pending.
        self.commit("server/src/main.rs", "frontend/src/main.tsx", "backend/src/services/job.py")
        self.deployed.update(server=self.head(), web=self.head())
        self.commit("docs/notes.txt")
        self.assertEqual(self.route(), {"server_check", "frontend_check", "backend_check", "infra_check",
                                        "deploy_studio"})

    def test_a_part_already_deployed_past_the_check_base_is_not_deployed_again(self):
        self.commit("server/src/main.rs")
        self.deployed.update(server=self.head())
        self.commit("frontend/src/main.tsx")
        self.assertEqual(self.route(), {"server_check", "frontend_check", "deploy_web"})

    def test_a_pending_part_is_checked_in_the_run_that_deploys_it(self):
        # The check base already covers the change, but the studio still runs the old release.
        self.commit("backend/src/services/job.py")
        self.deployed.update(studio=self.base)
        self.base = self.head()
        self.assertEqual(self.route(), {"backend_check", "deploy_studio"})

    @unittest.skipUnless(0 < bash_major("/bin/bash") < 4, "no bash older than 4 here")
    def test_an_older_bash_stops_with_the_reason(self):
        output = self.repo / "output.txt"
        env = {**os.environ, "EVENT": "push", "BASE": self.base, "GITHUB_OUTPUT": output.as_posix(),
               "GITHUB_STEP_SUMMARY": (self.repo / "summary.md").as_posix()}
        done = subprocess.run(["/bin/bash", SCRIPT.as_posix()], cwd=self.repo, env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("needs bash 4 or later", done.stderr)
        self.assertFalse(output.exists())


class ReleasePaths(unittest.TestCase):
    """The studio release (backend/infra/prepare-aws.ps1) and its routing hold the same files."""

    def release_paths(self, repo):
        text = (repo / "backend/infra/prepare-aws.ps1").read_text(encoding="utf-8")
        found = re.search(r"\$releasePaths = @\((.*?)\)", text, re.S)
        self.assertIsNotNone(found, "prepare-aws.ps1 must list $releasePaths")
        return re.findall(r"'([^']+)'", found.group(1))

    def mismatched(self, repo):
        """The files tracked in `repo` that its routing and its studio release disagree on."""
        # Paths as they are, one per line, as changes.sh and prepare-aws.ps1 read them (the default quoting would hide a
        # Hangul name from both lists, and splitting on blanks would cut a name with a space).
        tracked = subprocess.run(["git", "-C", repo.as_posix(), "-c", "core.quotePath=false", "ls-files"], check=True,
                                 capture_output=True, encoding="utf-8").stdout.splitlines()
        released = self.release_paths(repo)

        def packed(path):
            return any(path == item or path.startswith(item + "/") for item in released)

        def agrees(path, parts):
            if path == ".github/workflows/pipeline.yml":
                # A changed pipeline deploys every part on purpose.
                return parts == set(PARTS)
            if path.endswith(".md"):
                return "studio" not in parts
            return ("studio" in parts) == packed(path)
        return [path for path, parts in parts_of(tracked).items() if not agrees(path, parts)]

    def test_every_packed_file_deploys_the_studio_and_nothing_else_does(self):
        self.assertEqual(self.mismatched(ROOT), [])

    def test_hangul_and_spaced_paths_are_compared(self):
        # Both deploy the studio (release_parts.sh), but prepare-aws.ps1 does not pack them.
        unpacked = ["backend/new prompts/x.txt", "backend/프롬프트/의상.txt"]
        with tempfile.TemporaryDirectory(prefix="release-paths-") as temp:
            repo = Path(temp)
            (repo / "backend/infra").mkdir(parents=True)
            shutil.copy(ROOT / "backend/infra/prepare-aws.ps1", repo / "backend/infra")
            for name in unpacked:
                (repo / name).parent.mkdir(parents=True)
                (repo / name).write_text("test\n", encoding="utf-8")
            for args in (("init", "--quiet"), ("add", "--all")):
                subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
            self.assertEqual(self.mismatched(repo), unpacked)


class DeployBases(unittest.TestCase):
    def setUp(self):
        self.bases = load_bases().bases

    @staticmethod
    def run_(sha, event="push", conclusion="success", run_id=None):
        return {"id": run_id or sha, "head_sha": sha, "event": event, "status": "completed", "conclusion": conclusion}

    def test_the_newest_run_that_passed_is_every_base(self):
        found = self.bases([self.run_("b"), self.run_("a")], lambda run: self.fail("jobs are not needed"))
        self.assertEqual(found, {"check": "b", "server": "b", "web": "b", "studio": "b"})

    def test_a_failed_run_keeps_the_parts_it_deployed(self):
        jobs = {"c": [{"name": "deploy-server", "conclusion": "success"},
                      {"name": "deploy-web", "conclusion": "success"},
                      {"name": "deploy-studio", "conclusion": "failure"}]}
        runs = [self.run_("c", conclusion="failure"), self.run_("b")]
        found = self.bases(runs, lambda run: jobs.get(run["head_sha"], []))
        self.assertEqual(found, {"check": "b", "server": "c", "web": "c", "studio": "b"})

    def test_any_attempt_that_deployed_counts(self):
        jobs = {"c": [{"name": "deploy-studio", "conclusion": "failure"}, {"name": "deploy-studio", "conclusion": "success"}]}
        found = self.bases([self.run_("c", conclusion="failure"), self.run_("b")], lambda run: jobs.get(run["head_sha"], []))
        self.assertEqual(found["studio"], "c")

    def test_a_manual_run_counts_only_for_what_it_deployed(self):
        jobs = {"m": [{"name": "deploy-studio", "conclusion": "success"}, {"name": "deploy-server", "conclusion": "skipped"}]}
        runs = [self.run_("m", event="workflow_dispatch"), self.run_("b")]
        found = self.bases(runs, lambda run: jobs.get(run["head_sha"], []))
        self.assertEqual(found, {"check": "b", "server": "b", "web": "b", "studio": "m"})

    def test_other_events_and_unfinished_runs_are_ignored(self):
        runs = [{"id": 1, "head_sha": "x", "event": "pull_request", "status": "completed", "conclusion": "success"},
                {"id": 2, "head_sha": "y", "event": "push", "status": "in_progress", "conclusion": None},
                self.run_("a")]
        self.assertEqual(self.bases(runs, lambda run: []), dict.fromkeys(("check", *PARTS), "a"))

    def test_nothing_found_leaves_every_base_empty(self):
        found = self.bases([self.run_("c", conclusion="failure")], lambda run: [])
        self.assertEqual(found, dict.fromkeys(("check", *PARTS), ""))

    def test_a_web_deployed_by_hand_is_deployed_again(self):
        reconcile = load_bases().reconcile
        found = {"check": "b", "server": "b", "web": "b", "studio": "b"}
        self.assertEqual(reconcile(found, "c" * 40)["web"], "")
        self.assertEqual(reconcile(found, "b"), found)
        # A site that does not say what it runs (an older release) changes nothing.
        self.assertEqual(reconcile(found, None), found)


class CheckCsp(unittest.TestCase):
    """check_csp.py: the template has to allow the page's inline scripts; the live site only ever warns."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("check_csp", HERE / "check_csp.py")
        self.csp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.csp)
        temp = tempfile.TemporaryDirectory(prefix="check-csp-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.html = folder / "index.html"
        self.html.write_text("<script>document.documentElement.dataset.theme = 'dark'</script>"
                             '<script type="module" src="/assets/index.js"></script>', encoding="utf-8")
        [self.hash] = self.csp.hashes(self.html.read_text(encoding="utf-8"))
        self.policy = f"default-src 'self'; script-src 'self' {self.hash}"
        # The policy block as frontend/infra/aws-static.yaml writes it.
        self.template = folder / "aws-static.yaml"
        self.template.write_text("            ContentSecurityPolicy: !Sub\n              - >-\n"
                                 "                default-src 'self';\n"
                                 f"                script-src 'self' {self.hash}\n"
                                 "              - LiveRoom: !If [HasDomain, !Sub ' wss://${DomainName}', '']\n",
                                 encoding="utf-8")
        # The local sites below are reached directly, whatever proxy the machine names.
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
        self.addCleanup(urllib.request.install_opener, None)

    def check(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.csp.main(["--html", self.html.as_posix(), *args])
        return code, out.getvalue()

    def site(self, status=None, policy=""):
        """A local site answering HEAD with `status` and `policy`; without a status, with a line that is not HTTP."""
        class Page(http.server.BaseHTTPRequestHandler):
            def do_HEAD(self):
                if status is None:
                    self.wfile.write(b"nonsense\r\n")
                    return
                self.send_response(status)
                if policy:
                    self.send_header("Content-Security-Policy", policy)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

    def test_a_template_without_a_hash_of_the_page_fails(self):
        self.template.write_text("script-src 'self'", encoding="utf-8")
        code, out = self.check("--template", self.template.as_posix())
        self.assertEqual(code, 1)
        self.assertIn(f"::error file={self.template.as_posix()}::script-src에", out)
        self.template.write_text(f"script-src 'self' {self.hash}", encoding="utf-8")
        self.assertEqual(self.check("--template", self.template.as_posix())[0], 0)

    def test_the_live_policy_only_warns(self):
        site = self.site(200, self.policy)
        self.assertEqual(self.check("--live", site, "--template", self.template.as_posix()),
                         (0, f"{site}의 CSP가 템플릿과 같습니다\n"))
        site = self.site(200, "default-src 'self'; script-src 'self'")
        code, out = self.check("--live", site, "--template", self.template.as_posix())
        self.assertEqual(code, 0)
        self.assertIn(f"::warning::{site}의 CSP에 인라인 스크립트 해시 {self.hash}가 없습니다", out)
        self.assertIn(f"::warning::{site}의 CSP가 frontend/infra/aws-static.yaml과 다릅니다(script-src)", out)

    def test_a_site_that_does_not_answer_only_warns(self):
        # The deploy that would bring the site back must not stop here.
        with socket.socket() as closed:
            closed.bind(("127.0.0.1", 0))
            refused = f"http://127.0.0.1:{closed.getsockname()[1]}"
        for url in (self.site(503), self.site(403), self.site(), refused):
            with self.subTest(url=url):
                code, out = self.check("--live", url, "--template", self.template.as_posix())
                self.assertEqual(code, 0)
                self.assertIn(f"::warning::{url}의 CSP를 확인하지 못했습니다", out)
        with mock.patch.object(urllib.request, "urlopen", side_effect=TimeoutError("timed out")):
            self.assertEqual(self.check("--live", "https://mogaesup.com"),
                             (0, "::warning::https://mogaesup.com의 CSP를 확인하지 못했습니다: timed out\n"))

    def test_a_template_without_a_policy_fails_even_when_the_site_does_not_answer(self):
        # The repository is inconsistent whatever the site does.
        self.template.write_text(f"script-src 'self' {self.hash}", encoding="utf-8")
        with mock.patch.object(urllib.request, "urlopen", side_effect=TimeoutError("timed out")):
            code, out = self.check("--live", "https://mogaesup.com", "--template", self.template.as_posix())
        self.assertEqual(code, 1)
        self.assertIn(f"::error file={self.template.as_posix()}::템플릿에서 CSP를 찾지 못했습니다", out)


if __name__ == "__main__":
    unittest.main()
