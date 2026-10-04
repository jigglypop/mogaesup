"""Exercise release routing against real commit history without touching the checkout."""
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
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
    done = subprocess.run([BASH, "-c", script], input="\n".join(paths) + "\n", check=True, capture_output=True,
                          text=True)
    return dict(zip(paths, (set(line.split()) for line in done.stdout.splitlines())))


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


if __name__ == "__main__":
    unittest.main()
