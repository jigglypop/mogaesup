"""check_csp.py: the page against the template's policy, and the live comparison that only ever warns."""
import contextlib
import importlib.util
import io
from pathlib import Path
import socket
import tempfile
import unittest
import urllib.error

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TEMPLATE = ROOT / 'frontend/infra/aws-static.yaml'


def load():
    spec = importlib.util.spec_from_file_location('check_csp', HERE / 'check_csp.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Response:
    def __init__(self, policy):
        self.headers = {'content-security-policy': policy}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Policy(unittest.TestCase):
    def setUp(self):
        self.check = load()
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.html = Path(folder.name) / 'index.html'
        self.html.write_text('<script>window.a = 1</script><script type="module" src="/assets/app.js"></script>',
                             encoding='utf-8')

    def run_main(self, *args, opener=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.check.main(['--html', str(self.html), *args],
                                   **({'opener': opener} if opener else {}))
        return code, out.getvalue()

    def test_the_source_page_matches_the_template(self):
        code, out = self.run_main('--html', str(ROOT / 'frontend/index.html'), '--template', str(TEMPLATE))
        self.assertEqual(code, 0, out)

    def test_a_missing_hash_and_another_origin_fail(self):
        self.html.write_text('<script>window.b = 2</script><script src="https://cdn.example/x.js"></script>',
                             encoding='utf-8')
        code, out = self.run_main('--template', str(TEMPLATE))
        self.assertEqual(code, 1)
        self.assertIn('sha256-', out)
        self.assertIn('https://cdn.example/x.js', out)

    def test_a_site_that_does_not_answer_is_a_warning(self):
        def failing(error):
            def opener(request, timeout):
                raise error
            return opener
        for error in (urllib.error.HTTPError('https://mogaesup.com', 503, 'Service Unavailable', {}, None),
                      urllib.error.URLError('no route'), socket.timeout('timed out'), ConnectionResetError()):
            with self.subTest(error=type(error).__name__):
                code, out = self.run_main('--live', 'https://mogaesup.com', '--template', str(TEMPLATE),
                                          opener=failing(error))
                self.assertEqual(code, 0)
                self.assertIn('::warning::', out)
                self.assertNotIn('::error', out)

    def test_a_live_policy_that_differs_only_warns(self):
        code, out = self.run_main('--live', 'https://mogaesup.com', '--template', str(TEMPLATE),
                                  opener=lambda request, timeout: Response("default-src 'self'"))
        self.assertEqual(code, 0)
        self.assertIn('::warning::', out)


if __name__ == '__main__':
    unittest.main()
