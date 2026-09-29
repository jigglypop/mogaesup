"""Explicit migration and journal replay for CHARACTER_DATABASE_URL only."""

import argparse

from src.paths import BACKEND_ROOT, data_root, load_environment
from src.services.character_store import connect, sync
from src.services.character_pipeline import CharacterPipeline


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["migrate", "sync", "status"])
    args = parser.parse_args()
    load_environment()
    if args.command == "migrate":
        with connect() as conn:
            conn.execute((BACKEND_ROOT / "migrations/002_character_wardrobe.up.sql").read_text(encoding="utf-8"))
        print("Character schema ready; existing world tables unchanged")
    elif args.command == "sync":
        pipeline = CharacterPipeline(data_root())
        for entry in pipeline.records():
            sync(pipeline, entry["id"], entry.get("owner_id", pipeline.owner))
        print("Character journals indexed")
    else:
        with connect() as conn:
            row = conn.execute("SELECT count(*) FROM gaesup_character.characters").fetchone()
        print(f"PostgreSQL connected: {row[0]} characters")


if __name__ == "__main__":
    main()
