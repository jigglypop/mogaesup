"""Operator CLI: Blender MCP import -> edit -> inspect -> reviewed delivery."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

from src.services.asset_delivery import DeliveryRecipe, build_delivery
from src.services.asset_editor import AssetEditor
from src.services.blender_edits import EditRecipe
from src.services.blender_mcp import BlenderMCP


def start_blender(executable: Path, root: Path, port: int) -> dict:
    if not executable.is_file():
        raise ValueError("Blender executable not found")
    spec = importlib.util.find_spec("blender_mcp")
    if spec is None:
        raise ValueError("Install the Blender extra: uv sync --extra blender")
    addon = Path(spec.origin).parent / "bundled" / "addon.py"
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise ValueError("Blender port is already in use")
    root.mkdir(parents=True, exist_ok=True)
    log_path = root / f"blender-{port}.log"
    startupinfo = None
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
    with log_path.open("ab") as log:
        process = subprocess.Popen(
            [str(executable.resolve()), "--factory-startup", "--disable-autoexec", "--python",
             str(Path(__file__).with_name("blender_bootstrap.py")), "--", "--addon", str(addon), "--port", str(port)],
            stdout=log, stderr=log, stdin=subprocess.DEVNULL, startupinfo=startupinfo,
            env={**os.environ, "DISABLE_TELEMETRY": "true"},
        )
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError(f"Blender exited; see {log_path}")
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                result = {"pid": process.pid, "port": port, "log": str(log_path.resolve())}
                (root / f"blender-{port}.json").write_text(json.dumps(result), encoding="utf-8")
                return result
        time.sleep(0.2)
    process.terminate()
    process.wait(timeout=10)
    raise RuntimeError(f"Blender did not start listening; see {log_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("data/editor"))
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--timeout", type=float, default=180)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start", help="Start a dedicated Blender instance with the MCP addon")
    start.add_argument("--blender", type=Path, required=True)
    importing = commands.add_parser("import", help="Import a GLB as the first project revision")
    importing.add_argument("project")
    importing.add_argument("model", type=Path)
    importing.add_argument("--prompt", required=True)
    edit = commands.add_parser("edit", help="Apply validated editing commands and save a new revision")
    edit.add_argument("project")
    edit.add_argument("recipe", type=Path)
    edit.add_argument("--expected-revision", type=int, required=True)
    for name in ("inspect", "history"):
        command = commands.add_parser(name)
        command.add_argument("project")
    package = commands.add_parser("deliver", help="Package a reviewed revision without any new AI calls")
    package.add_argument("project")
    package.add_argument("recipe", type=Path)
    package.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        editor = AssetEditor(args.root, BlenderMCP(port=args.port, timeout=args.timeout))
        if args.command == "start":
            result = start_blender(args.blender, args.root, args.port)
        elif args.command == "import":
            result = asyncio.run(editor.import_model(args.project, args.model, args.prompt))
        elif args.command == "edit":
            recipe = EditRecipe.model_validate_json(args.recipe.read_text(encoding="utf-8"))
            result = asyncio.run(editor.edit(args.project, recipe, args.expected_revision))
        elif args.command == "inspect":
            result = editor.inspect(args.project)
        elif args.command == "history":
            result = editor.history(args.project)
        else:
            recipe = DeliveryRecipe.model_validate_json(args.recipe.read_text(encoding="utf-8"))
            head = editor.inspect(args.project)
            if recipe.asset_id != args.project or recipe.revision != head["revision"]:
                raise ValueError("Delivery asset ID/revision must match the current project revision")
            result = build_delivery(Path(head["model"]), Path(head["source"]), recipe, args.output)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
