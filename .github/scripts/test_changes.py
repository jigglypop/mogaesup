"""Exercise release routing against real commit history without touching the checkout."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("changes.sh").resolve()
KEYS = ("server_check", "backend_check", "frontend_check", "infra_check",
        "deploy_server", "deploy_web", "deploy_studio")
BASH = os.environ.get("BASH_EXECUTABLE") or shutil.which("bash")


class ReleaseRouting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="release-routing-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "--quiet")
        self.git("config", "user.name", "Release routing test")
        self.git("config", "user.email", "test@example.invalid")
        self.commit("README.md")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout

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
        env = {**os.environ, "EVENT": event, "BASE": self.base if base is None else base,
               "REF": ref, "TARGET": target, "GITHUB_OUTPUT": output.as_posix(),
               "GITHUB_STEP_SUMMARY": (self.repo / "summary.md").as_posix()}
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
                self.base = self.git("rev-parse", "HEAD").strip()

    def test_tests_and_documents_do_not_deploy(self):
        self.commit("frontend/src/__tests__/page.test.ts", "server/tests/api.rs",
                    "backend/tests/test_api.py", "backend/README.md")
        self.assertEqual(self.route(), {"frontend_check", "server_check", "backend_check"})

    def test_python_auth_change_checks_server_contract(self):
        self.commit("backend/src/auth.py")
        self.assertEqual(self.route(), {"server_check", "backend_check", "deploy_studio"})

    def test_workflow_change_checks_and_deploys_everything(self):
        self.commit(".github/workflows/pipeline.yml")
        self.assertEqual(self.route(), set(KEYS))

    def test_routing_helper_change_only_checks(self):
        self.commit(".github/scripts/changes.sh")
        self.assertEqual(self.route(), set(KEYS[:4]))

    def test_deployment_script_changes_roll_out(self):
        self.commit("frontend/scripts/deploy-aws.ps1", "server/scripts/deploy-rust-server.py")
        self.assertEqual(self.route(), {"server_check", "frontend_check", "infra_check",
                                      "deploy_server", "deploy_web"})

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
        self.base = self.git("rev-parse", "HEAD").strip()
        (self.repo / "server/src/removed.rs").unlink()
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", "remove runtime file")
        self.assertEqual(self.route(), {"server_check", "deploy_server"})


if __name__ == "__main__":
    unittest.main()
