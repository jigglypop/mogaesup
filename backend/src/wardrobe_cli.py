"""Image -> Meshy retexture -> Blender clothing fit and baseline rig transfer."""

import argparse
import asyncio
import json
import os
from pathlib import Path

import httpx
from src.paths import load_environment as load_dotenv

from src.services.blender_mcp import BlenderMCP
from src.services.wardrobe import Wardrobe, run_lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--port", type=int, default=9878)
    parser.add_argument("--timeout", type=float, default=300)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--base", type=Path, default=Path("data/ally.glb"))
    prepare.add_argument("--reference", type=Path, required=True)
    prepare.add_argument("--source-object", default="tee.001")
    commands.add_parser("submit", help="Submit one paid Meshy retexture task")
    status = commands.add_parser("status", help="Poll once; never creates another task")
    status.add_argument("--task-id", help="Recover a submission using its Meshy dashboard ID")
    commands.add_parser("download")
    dress = commands.add_parser("dress")
    dress.add_argument("--garment", type=Path, help="Default: downloaded generated.glb")
    dress.add_argument("--fit", choices=["bounds", "none"], default="bounds")
    args = parser.parse_args()
    load_dotenv()
    try:
        with run_lock(args.run, args.port):
            result = execute(args)
    except httpx.HTTPStatusError as exc:
        parser.exit(1, f"Provider HTTP {exc.response.status_code}; inspect run.json and resume with status.\n")
    except (ValueError, OSError, RuntimeError, httpx.RequestError) as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


def execute(args):
    wardrobe = Wardrobe(args.run, BlenderMCP(port=args.port, timeout=args.timeout))
    if args.command == "prepare":
        result = asyncio.run(wardrobe.prepare(args.base, args.reference, args.source_object))
    elif args.command == "dress":
        result = asyncio.run(wardrobe.dress(args.garment or args.run / "generated.glb", args.fit))
    elif args.command == "download":
        with httpx.Client(timeout=120, follow_redirects=True) as client:
            result = {"garment": str(wardrobe.download(client))}
    else:
        key = os.getenv("MESHY_API_KEY")
        if not key:
            raise ValueError("MESHY_API_KEY is required")
        with httpx.Client(base_url=os.getenv("MESHY_API_BASE_URL", "https://api.meshy.ai"),
                          headers={"Authorization": f"Bearer {key}"}, timeout=120) as client:
            result = wardrobe.submit(client) if args.command == "submit" else wardrobe.status(client, args.task_id)
        # Signed download URLs remain in local state, not terminal output.
        result = {k: v for k, v in result.items() if k != "garment_url"}
    return result


if __name__ == "__main__":
    main()
