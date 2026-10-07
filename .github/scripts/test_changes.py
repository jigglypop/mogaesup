"""Exercise release routing against real commit history without touching the checkout."""
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCRIPT = HERE / "changes.sh"
KEYS = ("server_check", "backend_check", "frontend_check", "infra_check",
        "deploy_server", "deploy_web", "deploy_studio")
PARTS = ("server", "web", "studio")
BASH = os.environ.get("BASH_EXECUTABLE") or shutil.which("bash")


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
        subprocess.run([BASH, SCRIPT.as_posix()], cwd=self.repo, env=env,
                       check=True, capture_output=True, text=True)
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
                         {"server_check", "backend_check", "frontend_check"})

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
            ("backend/src/services/job.py", {"backend_check", "deploy_studio"}),
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

    def test_tests_and_documents_do_not_deploy(self):
        self.commit("frontend/src/__tests__/page.test.ts", "server/tests/api.rs",
                    "backend/tests/test_api.py", "backend/README.md")
        self.assertEqual(self.route(), {"frontend_check", "server_check", "backend_check"})

    def test_notes_inside_runtime_folders_do_not_deploy(self):
        self.commit("frontend/src/character/AGENTS.md", "backend/src/AGENTS.md",
                    "frontend/vendor/engine.patch", "frontend/vendor/engine.provenance.json")
        self.assertEqual(self.route(), {"frontend_check", "backend_check"})

    def test_python_auth_change_checks_server_contract(self):
        self.commit("backend/src/auth.py")
        self.assertEqual(self.route(), {"server_check", "backend_check", "deploy_studio"})

    def test_workflow_change_checks_and_deploys_everything(self):
        self.commit(".github/workflows/pipeline.yml")
        self.assertEqual(self.route(), set(KEYS))

    def test_routing_helper_change_only_checks(self):
        self.commit(".github/scripts/changes.sh")
        self.assertEqual(self.route(), set(KEYS[:4]))

    def test_deployment_script_changes_roll_out_after_their_tests(self):
        # server/scripts are tested with the character server's tests (backend/tests/infra).
        self.commit("frontend/scripts/deploy-aws.ps1", "server/scripts/deploy-rust-server.py")
        self.assertEqual(self.route(), {"server_check", "backend_check", "frontend_check", "infra_check",
                                      "deploy_server", "deploy_web"})

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
        self.assertEqual(self.route(), {"server_check", "frontend_check", "backend_check", "deploy_studio"})

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

    def test_the_web_the_site_runs_is_its_base_after_a_run_that_did_not_deploy_it(self):
        # The web went out at `live`; a later run passed with a server change only, so the runs give that run's commit
        # as every base. The site still names `live`, which is on main: the next push deploys the web only when a web
        # path changed since `live`.
        self.commit("frontend/src/main.tsx")
        live = self.head()
        self.commit("server/src/main.rs")
        passed = self.head()
        self.commit("docs/notes.txt")
        bases = load_bases()
        found = bases.reconcile({"check": passed, "server": passed, "web": passed, "studio": passed}, live,
                                lambda commit: bases.on_main(commit, cwd=self.repo))
        self.assertEqual(found["web"], live)
        self.base = found["check"]
        self.deployed.update(server=found["server"], web=found["web"], studio=found["studio"])
        self.assertEqual(self.route(), set())
        self.commit("frontend/src/page.tsx")
        self.assertEqual(self.route(), {"frontend_check", "deploy_web"})

    def test_only_commits_of_mains_history_count_as_on_main(self):
        on_main = load_bases().on_main
        first = self.head()
        self.git("checkout", "--quiet", "-b", "elsewhere")
        self.commit("frontend/src/main.tsx")
        elsewhere = self.head()
        self.git("checkout", "--quiet", "-")
        self.commit("server/src/main.rs")
        self.assertTrue(on_main(first, cwd=self.repo))
        self.assertTrue(on_main(self.head(), cwd=self.repo))
        self.assertFalse(on_main(elsewhere, cwd=self.repo))
        self.assertFalse(on_main("f" * 40, cwd=self.repo))


class ReleasePaths(unittest.TestCase):
    """The studio release (backend/infra/prepare-aws.ps1) and its routing hold the same files."""

    def release_paths(self):
        text = (ROOT / "backend/infra/prepare-aws.ps1").read_text(encoding="utf-8")
        found = re.search(r"\$releasePaths = @\((.*?)\)", text, re.S)
        self.assertIsNotNone(found, "prepare-aws.ps1 must list $releasePaths")
        return re.findall(r"'([^']+)'", found.group(1))

    def test_every_packed_file_deploys_the_studio_and_nothing_else_does(self):
        tracked = subprocess.run(["git", "-C", ROOT.as_posix(), "ls-files"], check=True, capture_output=True,
                                 text=True).stdout.split()
        released = self.release_paths()

        def packed(path):
            return any(path == item or path.startswith(item + "/") for item in released)
        routes = parts_of(tracked)
        for path in tracked:
            with self.subTest(path=path):
                if path == ".github/workflows/pipeline.yml":
                    # A changed pipeline deploys every part on purpose.
                    self.assertEqual(routes[path], set(PARTS))
                elif path.endswith(".md"):
                    self.assertNotIn("studio", routes[path])
                else:
                    self.assertEqual("studio" in routes[path], packed(path))


class Pins(unittest.TestCase):
    """The tool versions the pipeline names are the ones the builds and local checks use."""

    def setUp(self):
        self.pipeline = (ROOT / ".github/workflows/pipeline.yml").read_text(encoding="utf-8")

    def env(self, name):
        found = re.search(rf"^  {name}: (\S+)$", self.pipeline, re.M)
        self.assertIsNotNone(found, f"pipeline.yml must set {name}")
        return found.group(1)

    def test_one_rust_compiler(self):
        version = self.env("RUST_VERSION")
        self.assertTrue(self.env("RUST_IMAGE").startswith(f"rust:{version}-alpine@sha256:"))
        toolchain = (ROOT / "server/rust-toolchain.toml").read_text(encoding="utf-8")
        self.assertIn(f'channel = "{version}"', toolchain)

    def test_one_uv(self):
        dockerfile = (ROOT / "backend/infra/Dockerfile").read_text(encoding="utf-8")
        self.assertIn(f"uv=={self.env('UV_VERSION')}", dockerfile)

    def test_one_postgresql(self):
        compose = (ROOT / "server/docker-compose.yml").read_text(encoding="utf-8")
        major = re.search(r"EngineVersion: '(\d+)\.", (ROOT / "server/infra/aws-server.yaml").read_text(encoding="utf-8"))
        self.assertIsNotNone(major)
        self.assertIn(f"image: postgres:{major.group(1)}-alpine", compose)
        self.assertEqual(set(re.findall(r"image: (postgres:\S+)", self.pipeline)), {f"postgres:{major.group(1)}-alpine"})

    def test_one_aws_account(self):
        # The account, the buckets named after it and the deploy role are written into each script and template that
        # needs them (no shared settings file): they must all name the same account.
        files = (".github/workflows/pipeline.yml", ".github/aws/deploy-role.yaml", "frontend/infra/aws-static.yaml",
                 "frontend/scripts/deploy-aws.ps1", "server/infra/aws-server.yaml", "server/scripts/deploy-rust-server.py",
                 "server/scripts/set-factory-jwt.py", "server/scripts/lock-studio.py", "backend/infra/prepare-aws.ps1",
                 "backend/infra/import-studio-glb.py", "backend/infra/sync-gateway-secret.py")
        found = {}
        for name in files:
            accounts = set(re.findall(r"(?<![0-9A-Za-z])([0-9]{12})(?![0-9A-Za-z])",
                                      (ROOT / name).read_text(encoding="utf-8")))
            with self.subTest(file=name):
                self.assertTrue(accounts, "names no account any more: take it off this list")
            found[name] = accounts
        self.assertEqual(len(set().union(*found.values())), 1, found)


class ServerLive(unittest.TestCase):
    """server-live: the site's /api/health must name the commit this run installed (MOGAESUP_COMMIT of the build)."""
    COMMIT = "a" * 40

    def script(self):
        text = (ROOT / ".github/workflows/pipeline.yml").read_text(encoding="utf-8")
        job = text[text.index("\n  server-live:\n"):]
        job = job[:job.index("\n\n  ")]
        return textwrap.dedent(job[job.index("run: |\n") + len("run: |\n"):])

    def check(self, answer):
        """Runs the job's script as the runner does (bash -eo pipefail), with curl answering `answer` (None: fails)."""
        if not BASH:
            self.fail("bash is required")
        stubs = ('curl() { if [ -z "${FAKE_HEALTH+set}" ]; then return 22; fi; printf "%s" "$FAKE_HEALTH"; }\n'
                 'python3() { "$PYTHON_EXE" "$@"; }\n')
        env = {**os.environ, "PYTHON_EXE": sys.executable, "GITHUB_SHA": self.COMMIT}
        env.pop("FAKE_HEALTH", None)
        if answer is not None:
            env["FAKE_HEALTH"] = answer
        done = subprocess.run([BASH, "-eo", "pipefail"], input=(stubs + self.script()).encode("utf-8"),
                              capture_output=True, env=env, timeout=60)
        return done.returncode, done.stdout.decode("utf-8", "replace")

    def test_the_site_must_serve_this_runs_commit(self):
        self.assertEqual(self.check('{"status":"ok","commit":"%s"}' % self.COMMIT)[0], 0)
        code, out = self.check('{"status":"ok","commit":"%s"}' % ("b" * 40))
        self.assertEqual(code, 1)
        self.assertIn("::error::", out)

    def test_a_server_that_names_no_commit_is_a_warning_and_no_answer_fails(self):
        for answer in ('{"status":"ok","commit":null}', '{"status":"ok"}', "not json"):
            with self.subTest(answer=answer):
                code, out = self.check(answer)
                self.assertEqual(code, 0)
                self.assertIn("::warning::", out)
        code, out = self.check(None)
        self.assertEqual(code, 1)
        self.assertIn("::error::", out)


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

    def test_the_web_base_is_the_commit_the_site_runs_when_main_has_it(self):
        reconcile = load_bases().reconcile
        found = {"check": "b", "server": "b", "web": "b", "studio": "b"}
        # A run that passed without deploying the web (nothing of it changed) is every routing base, while the site
        # still names the commit it was deployed from: that commit is the web's base, not a deploy by hand.
        self.assertEqual(reconcile(found, "a" * 40, lambda commit: True), {**found, "web": "a" * 40})
        self.assertEqual(reconcile(found, "b", lambda commit: self.fail("not asked")), found)
        # A site that does not say what it runs (an older release) changes nothing.
        self.assertEqual(reconcile(found, None, lambda commit: self.fail("not asked")), found)
        # No run recorded the web, but the site names a commit of main: deployed since that one, not in full.
        self.assertEqual(reconcile({**found, "web": ""}, "a" * 40, lambda commit: True)["web"], "a" * 40)

    def test_a_web_deployed_by_hand_from_off_main_is_deployed_again(self):
        reconcile = load_bases().reconcile
        found = {"check": "b", "server": "b", "web": "b", "studio": "b"}
        self.assertEqual(reconcile(found, "c" * 40, lambda commit: False), {**found, "web": ""})

    def test_a_web_deployed_by_hand_is_deployed_again_from_the_checked_build(self):
        # A deploy by hand builds from the PC's own node_modules (an older engine, say), not the build a run checked: it
        # stays live only until the next run, even when its commit is main's and nothing of the web changed since.
        reconcile = load_bases().reconcile
        found = {"check": "b", "server": "b", "web": "a" * 40, "studio": "b"}
        self.assertEqual(reconcile(found, "a" * 40, lambda commit: True, manual=True), {**found, "web": ""})
        self.assertEqual(reconcile(found, "c" * 40, lambda commit: True, manual=True), {**found, "web": ""})
        self.assertEqual(reconcile(found, "a" * 40, lambda commit: True, manual=False), found)

    def test_the_site_says_which_commit_it_runs_and_who_deployed_it(self):
        import http.server
        import json
        import threading
        bodies = {"/pipeline/release.json": {"git_commit": "a" * 40, "by": "pipeline"},
                  "/manual/release.json": {"git_commit": "b" * 40, "by": "manual"},
                  "/older/release.json": {"git_commit": "c" * 40},
                  "/none/release.json": {"git_commit": None, "by": "manual"}}

        class Site(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(bodies.get(self.path, {})).encode()
                self.send_response(200 if self.path in bodies else 404)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass
        server = http.server.HTTPServer(("127.0.0.1", 0), Site)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        site = f"http://127.0.0.1:{server.server_port}"
        release = load_bases().live_web_release
        self.assertEqual(release(f"{site}/pipeline"), ("a" * 40, False))
        self.assertEqual(release(f"{site}/manual"), ("b" * 40, True))
        self.assertEqual(release(f"{site}/older"), ("c" * 40, False))
        self.assertEqual(release(f"{site}/none"), (None, False))
        self.assertEqual(release(f"{site}/missing"), (None, False))


if __name__ == "__main__":
    unittest.main()
