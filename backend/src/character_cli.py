"""Resumable Meshy character generation from a single image, followed by rigging."""

import argparse
import asyncio
import json
import os
from pathlib import Path

import httpx

from src.paths import load_environment as load_dotenv, data_root
from src.services import character_jobs
from src.services.wardrobe import download_glb, run_lock


def download(directory: Path, stage: str) -> dict:
    return character_jobs.download(directory, stage, download_model=download_glb)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, default=data_root() / "characters/A")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate")
    generate.add_argument("--image", type=Path, default=data_root() / "image/A.png")
    generate.add_argument("--height", type=float, required=True)
    generate.add_argument("--profile", choices=["meshy-7", "smart-topology"], default="meshy-7")
    generate.add_argument("--body-type", choices=["humanoid", "quadruped"], default="humanoid")
    status = commands.add_parser("status")
    status.add_argument("--task-id", help="Recover an uncertain submission using the Meshy task list")
    commands.add_parser("rig")
    model_rig = commands.add_parser("rig-model", help="Meshy-rig a preserved textured humanoid GLB; does not regenerate geometry")
    model_rig.add_argument("--model", type=Path, required=True)
    model_rig.add_argument("--height", type=float, required=True)
    downloading = commands.add_parser("download")
    downloading.add_argument("--stage", choices=["generation", "rigging"], default="rigging")
    local = commands.add_parser("local-rig", help="Blender fallback using authored landmarks and clothing regions")
    local.add_argument("--model", type=Path)
    local.add_argument("--recipe", type=Path, required=True)
    local.add_argument("--output", type=Path, required=True)
    local.add_argument("--port", type=int, default=9878)
    args = parser.parse_args()
    load_dotenv()
    key = os.getenv("MESHY_API_KEY")
    if not key and args.command not in {"download", "local-rig"}:
        parser.error("MESHY_API_KEY is required")
    with run_lock(args.run, getattr(args, "port", int(os.getenv("BLENDER_PORT", "9878"))), blender=args.command == "local-rig"):
        if args.command == "local-rig":
            from src.services.blender_mcp import BlenderMCP
            from src.services.character_setup import setup_character
            result = asyncio.run(setup_character(args.model or args.run / "generated.glb", args.recipe,
                                                  args.output, BlenderMCP(port=args.port, timeout=300)))
        elif args.command == "download":
            result = download(args.run, args.stage)
        else:
            with httpx.Client(base_url=os.getenv("MESHY_API_BASE_URL", "https://api.meshy.ai"),
                              headers={"Authorization": f"Bearer {key}"}, timeout=120) as client:
                try:
                    if args.command == "generate":
                        result = character_jobs.generate(args.run, args.image, args.height, client, args.profile, body_type=args.body_type)
                    elif args.command == "rig":
                        result = character_jobs.rig(args.run, client)
                    elif args.command == "rig-model":
                        result = character_jobs.rig_model(args.run, args.model, args.height, client)
                    else:
                        result = character_jobs.refresh(args.run, client, args.task_id)
                except ValueError as exc:
                    parser.error(str(exc))
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except httpx.HTTPStatusError as exc:
        raise SystemExit(f"Meshy HTTP {exc.response.status_code}; inspect character.json before retrying") from None
    except (ValueError, OSError, RuntimeError, httpx.RequestError) as exc:
        raise SystemExit(str(exc)) from None
