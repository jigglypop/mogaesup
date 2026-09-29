"""Transactional PostgreSQL index of the source-preserving character workspace.

GLBs and resumable JSON journals remain on disk. Each committed operation refreshes
the index; failed syncs leave a replayable outbox marker, never repeat provider POSTs.
"""

import json
import logging
import os

from src.services.wardrobe import _digest

logger = logging.getLogger(__name__)


def configured():
    return bool(os.getenv("CHARACTER_DATABASE_URL", "").strip())


def connect():
    import psycopg
    return psycopg.connect(os.environ["CHARACTER_DATABASE_URL"], connect_timeout=5,
                           application_name="gaesup-character", options="-c statement_timeout=30000")


def read(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def sync(pipeline, character_id, user_id):
    if not configured():
        return False
    entry, run, control = pipeline.entry(character_id, user_id)
    files = pipeline.files(entry, run, control)
    for path in run.glob("operations/*/blender/character.glb"):
        files["version:" + path.parent.parent.name] = path
    for path in run.glob("sources/*.glb"):
        files["source:" + path.stem] = path
    marker = run / "postgres-sync.pending"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("Replay with uv run python -m src.character_db sync\n", encoding="utf-8")
    from psycopg.types.json import Jsonb
    with connect() as conn:
        conn.execute("""INSERT INTO gaesup_character.characters(id,owner_id,name,height_meters,registry,control)
            VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,
            name=excluded.name,height_meters=excluded.height_meters,registry=excluded.registry,control=excluded.control,updated_at=now()""",
            (character_id,user_id,control.get("name",entry.get("name",character_id)),control.get("height_meters",entry.get("height_meters")),Jsonb(entry),Jsonb(control)))
        for kind, path in files.items():
            sha = _digest(path)
            evidence = read(path.parent / "complete.json") if path.name == "character.glb" else {}
            inspection = control.get("inspection", {}) if control.get("inspection", {}).get("model_sha256") == sha else {}
            conn.execute("""INSERT INTO gaesup_character.asset_versions(character_id,sha256,kind,storage_key,byte_size,rig_origin,source_sha256,metadata)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(character_id,sha256) DO UPDATE SET
                source_sha256=COALESCE(excluded.source_sha256,gaesup_character.asset_versions.source_sha256),metadata=excluded.metadata""",
                (character_id,sha,kind,str(path.relative_to(pipeline.root)),path.stat().st_size,
                 "local_fallback" if kind == "local_fallback" else control.get("rig_origin","unknown"),evidence.get("source_sha256"),Jsonb({"inspection": inspection,"separation": evidence})))
        for path in (run / "operations").glob("*/operation.json"):
            op = read(path)
            conn.execute("""INSERT INTO gaesup_character.operations(id,character_id,action_id,status,input_sha256,input_fingerprint,receipt,created_at,updated_at)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET status=excluded.status,receipt=excluded.receipt,updated_at=excluded.updated_at""",
                (op["id"],character_id,op["action_id"],op["status"],op.get("input_sha256"),op["fingerprint"],Jsonb(op),op["created_at"],op["updated_at"]))
            review = read(path.parent / "review.json")
            if review:
                conn.execute("""INSERT INTO gaesup_character.reviews(operation_id,character_id,model_sha256,reviewer_id,decision,evidence,reviewed_at)
                    VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(operation_id) DO NOTHING""",
                    (op["id"],character_id,review["model_sha256"],review["reviewer_id"],review["decision"],Jsonb(review),review["reviewed_at"]))
        pack = read(run / "motion-pack.json")
        provider = read(run / "character.json")
        tasks = {"motion:" + slot: task for slot,task in pack.get("tasks",{}).items()}
        if provider:
            tasks["legacy:" + provider["stage"]] = provider
        for stage, task in tasks.items():
            snapshot = {key: value for key,value in task.items() if key not in {"payload","image"}}
            payload = task.get("payload",{})
            conn.execute("""INSERT INTO gaesup_character.provider_tasks(character_id,stage,provider_task_id,status,action_id,rig_task_id,consumed_credits,snapshot)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(character_id,stage) DO UPDATE SET
                provider_task_id=excluded.provider_task_id,status=excluded.status,consumed_credits=excluded.consumed_credits,snapshot=excluded.snapshot""",
                (character_id,stage,task.get("task_id"),task["status"],payload.get("action_id"),payload.get("rig_task_id"),task.get("consumed_credits"),Jsonb(snapshot)))
        if control.get("parts_sha256"):
            for part in control.get("parts",[]):
                conn.execute("""INSERT INTO gaesup_character.parts(character_id,model_sha256,node_index,role,body_coverage,metadata)
                    VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(character_id,model_sha256,node_index) DO UPDATE SET
                    role=excluded.role,body_coverage=excluded.body_coverage,metadata=excluded.metadata""",
                    (character_id,control["parts_sha256"],part["node_index"],part["role"],control.get("body_coverage","unknown"),Jsonb(part)))
        if pack.get("model_sha256"):
            for slot,clip in pack.get("clips",{}).items():
                conn.execute("""INSERT INTO gaesup_character.animation_clips(character_id,model_sha256,slot,clip_sha256,provider_task_id,action_id,source_kind)
                    VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(character_id,model_sha256,slot) DO NOTHING""",
                    (character_id,pack["model_sha256"],slot,clip["sha256"],clip["task_id"],clip.get("action_id"),clip["source"]))
    marker.unlink(missing_ok=True)
    return True


def sync_after_change(pipeline, character_id, user_id):
    try:
        sync(pipeline, character_id, user_id)
    except Exception:
        # Credentials and connection strings must not leak into API responses/logs.
        logger.error("Character PostgreSQL sync pending for %s; replay the local journal", character_id)
