"""Compare assembled characters with the same metrics: uv run asset-quality <assembly folder> ...

Each folder holds body.glb and the fitted part GLBs of one saved assembly version
(for example data/.../native-parts/<version>). Metrics are for comparing methods and
providers; they never change a job or block a result.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from src.services.character_parts import blender_executable


def measure(directory, *, images=None, canvas=None):
    executable = blender_executable()
    if not executable:
        raise SystemExit('Blender is required: set BLENDER_EXECUTABLE')
    worker = Path(__file__).with_name('services')/'avatar_quality_blender.py'
    with tempfile.TemporaryDirectory(prefix='asset-quality-') as scratch:
        scratch = Path(scratch)
        payload = {'directory': str(Path(directory).resolve()), 'output': str(scratch/'metrics.json'),
                   'images': images or {}, 'canvas': canvas}
        (scratch/'input.json').write_text(json.dumps(payload), encoding='utf8')
        process = subprocess.run([executable, '--background', '--factory-startup', '--disable-autoexec',
                                  '--python-exit-code', '1', '--python', str(worker), '--', str(scratch/'input.json')],
                                 capture_output=True, text=True, encoding='utf8', errors='replace')
        if process.returncode:
            raise SystemExit(f'Quality worker failed for {directory}:\n{process.stdout[-2000:]}{process.stderr[-2000:]}')
        return json.loads((scratch/'metrics.json').read_text(encoding='utf8'))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Assembly comparison metrics (rear coverage, penetration, silhouette IoU).')
    parser.add_argument('directories', nargs='+', help='assembly folders with body.glb and part GLBs')
    parser.add_argument('--images', help='JSON file {slot: {view: canvas PNG path}} for silhouette IoU')
    parser.add_argument('--canvas', help='JSON file with the canvas contract (width, height, center_x, sole_y, pixels_per_metre)')
    args = parser.parse_args(argv)
    images = json.loads(Path(args.images).read_text(encoding='utf8')) if args.images else None
    canvas = json.loads(Path(args.canvas).read_text(encoding='utf8')) if args.canvas else None
    results = [measure(directory, images=images, canvas=canvas) for directory in args.directories]
    json.dump(results if len(results) > 1 else results[0], sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
