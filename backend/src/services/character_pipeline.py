"""File-backed character control, public views, and durable action receipts."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from src.services.object_storage import StoredPath as Path
import re
import uuid

from PIL import Image

from src.services.asset_delivery import inspect_glb
from src.services.asset_editor import _retry_file_io, _write_json
from src.services.character_audit import inspect_character
from src.services.glb import parse_glb
from src.services.wardrobe import _digest, run_lock

# Character details are read-only; bounded parallel reads keep the list responsive on S3.
_LISTING_READERS = ThreadPoolExecutor(max_workers=8, thread_name_prefix='character-listing')


class PipelineError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def read_json(path: Path, default=None):
    path = Path(path)
    try:
        contents = _retry_file_io(lambda: path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default or {}
    return json.loads(contents)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CharacterPipeline:
    def __init__(self, root: Path, port: int = 9878, owner: int = 1):
        self.root = Path(root).resolve()
        self.manifest = self.root / "characters/batch.json"
        self.port, self.owner = port, owner
        self.instance = uuid.uuid4().hex

    def sync_storage(self, character_id, user_id):
        from src.services.character_store import sync_after_change
        sync_after_change(self, character_id, user_id)

    def resolve(self, value: str) -> Path:
        path = Path(value)
        if not path.is_absolute():
            if path.parts and path.parts[0] == "data":
                path = Path(*path.parts[1:])
            path = self.root / path
        path = path.resolve()
        if not path.is_relative_to(self.root):
            raise PipelineError("invalid_source", "데이터 경계 밖의 파일입니다.", 400)
        return path

    def records(self) -> list[dict]:
        return read_json(self.manifest, {"characters": []}).get("characters", [])

    def entry(self, character_id: str, user_id: int) -> tuple[dict, Path, dict]:
        for entry in self.records():
            if entry["id"] == character_id and entry.get("owner_id", self.owner) == user_id:
                run = self.resolve(entry["run"])
                return entry, run, read_json(run / "control.json")
        raise PipelineError("not_found", "캐릭터를 찾을 수 없습니다.", 404)

    @contextmanager
    def lock(self, run: Path, *, blender: bool = False):
        try:
            with run_lock(run, self.port, blender=blender):
                yield
        except ValueError as exc:
            if "busy" in str(exc):
                raise PipelineError("busy", "다른 작업이 진행 중입니다. 상태를 확인해 주세요.") from exc
            raise

    def latest_operation(self, run: Path) -> dict | None:
        files = sorted((run / "operations").glob("*/operation.json"))
        if not files:
            return None
        result = max((read_json(path) for path in files), key=lambda item: item["created_at"])
        return self.public_operation(result)

    def public_operation(self, value: dict) -> dict:
        result = {key: value.get(key) for key in ("id", "action_id", "status", "created_at", "updated_at", "error")}
        if result["status"] in {"accepted", "running"} and value.get("executor") != self.instance:
            result.update(status="recovery_required", error={"code": "executor_interrupted",
                          "message": "서버 실행이 중단되었습니다. 기존 작업을 확인한 뒤 복구해 주세요."})
        return result

    def files(self, entry: dict, run: Path, control: dict) -> dict[str, Path]:
        files = {}
        image = control.get("image") or entry.get("image")
        if image:
            path = self.resolve(image)
            if path.is_file():
                files["reference"] = path
        for name in ("generated", "rigged", "walking", "running"):
            if (run / (name + ".glb")).is_file():
                files[name] = run / (name + ".glb")
        pack = read_json(run / "motion-pack.json")
        if pack.get("status") == "complete":
            for name in ("character", "idle", "walk", "run", "jump", "fall"):
                path = run / "motions" / (name + ".glb")
                if path.is_file():
                    files["animated" if name == "character" else name] = path
        if control.get("imported_model"):
            path = self.resolve(control["imported_model"])
            if path.is_file():
                files["imported"] = path
        setups = sorted(run.glob("local-*/setup.json"), key=lambda p: p.stat().st_mtime)
        if setups:
            setup = read_json(setups[-1])
            if setup.get("model"):
                path = self.resolve(setup["model"])
                if path.is_file() and setup.get("model_sha256") == _digest(path):
                    files["local_fallback"] = path
        if control.get("parts_model"):
            path = self.resolve(control["parts_model"])
            if path.is_file():
                files["parts_model"] = path
        for name in ("parts_blend", "rest_render"):
            if control.get(name):
                path = self.resolve(control[name])
                if path.is_file():
                    files[name] = path
        return files

    def model(self, files: dict[str, Path]) -> tuple[str | None, Path | None]:
        for name in ("parts_model", "animated", "imported", "rigged", "local_fallback", "generated"):
            if name in files:
                return name, files[name]
        return None, None

    def revision(self, entry: dict, run: Path, control: dict, *, snapshot: dict | None = None) -> str:
        snapshot = snapshot if snapshot is not None else {
            "provider": read_json(run / "character.json"),
            "motion_pack": read_json(run / "motion-pack.json"),
            "operation": self.latest_operation(run)}
        value = {"entry": entry, "control": control, **snapshot,
                 "files": {key: [str(path), path.stat().st_size, path.stat().st_mtime_ns]
                           for key, path in self.files(entry, run, control).items()}}
        return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:24]

    def detail(self, character_id: str, user_id: int) -> dict:
        entry, run, control = self.entry(character_id, user_id)
        # Workers persist control before marking an operation terminal. Read in the
        # reverse order so a completed operation never accompanies an older result.
        operation = self.latest_operation(run)
        control = read_json(run / "control.json")
        provider = read_json(run / "character.json")
        motion_pack = read_json(run / "motion-pack.json")
        files = self.files(entry, run, control)
        model_id, model = self.model(files)
        busy = operation and operation["status"] in {"accepted", "running", "recovery_required"}
        height = control.get("height_meters", entry.get("height_meters"))
        effective = {**entry, "height_meters": height, "run": str(run)}
        effective["image"] = str(files.get("reference", run / "missing.png"))
        plan = inspect_character(effective, self.root)
        pipeline_status = plan["state"] if plan["state"] in {"blocked", "in_progress", "review_required"} else "ready"
        problems = []
        if plan["next_action"] == "resolve_provenance_conflict":
            problems.append({"code": "source_changed", "message": "입력 이미지가 기존 작업 출처와 다릅니다. 원본을 확인해 주세요."})
        if not height and not model:
            problems.append({"code": "height_required", "message": "캐릭터 키를 입력한 뒤 생성을 시작할 수 있습니다."})
        if provider.get("status") == "submission_rejected":
            problems.append({"code": "provider_rejected", "message": f"Meshy {provider.get('stage')} 요청 거절 (HTTP {provider.get('http_status')}). 기존 결과는 보존됩니다."})
        if provider.get("status") == "submission_uncertain":
            problems.append({"code": "submission_uncertain", "message": "기존 Meshy 작업 ID를 복구해 주세요. 다시 제출하지 않습니다."})
        inspection = control.get("inspection", {})
        current_hash = _digest(model) if model else None
        if inspection.get("model_sha256") != current_hash:
            inspection = {}
        review = control.get("review", {})
        if review.get("model_sha256") != current_hash:
            review = {}
        rig_origin = control.get("rig_origin", "unknown")
        if model_id == "local_fallback":
            rig_origin = "local_fallback"
        elif model_id == "animated":
            rig_origin = "meshy"
        elif model_id == "rigged" and provider.get("stage") == "rigging" and provider.get("status") == "SUCCEEDED":
            rig_origin = "meshy"
        if model:
            pipeline_status = "review_required"
        if review.get("decision") == "approved" and inspection and not inspection.get("errors"):
            pipeline_status = "approved"
        if busy:
            pipeline_status = "blocked" if operation["status"] == "recovery_required" else "in_progress"

        actions = []
        def add(action_id, label, enabled=True, reason=None, external=False):
            actions.append({"id": action_id, "label": label, "enabled": bool(enabled and not busy),
                            "reason": "진행 중인 작업을 먼저 확인해 주세요." if busy else reason,
                            "external_mutation": external})
        if model:
            add("inspect_model", "모델 검사")
            from src.services.character_parts import blender_executable
            can_split = bool(inspection.get("material_boundaries") and inspection.get("metrics", {}).get("skins") and not inspection.get("errors"))
            add("separate_materials", "Blender 재질 경계 분리", can_split and bool(blender_executable()),
                "모델 검사 후 분리 가능한 재질 경계와 Blender 설치가 필요합니다." if not can_split or not blender_executable() else None)
            add("separate_parts", "선택한 영역을 파츠로 분리", bool(inspection.get("metrics", {}).get("skins") and not inspection.get("errors") and blender_executable()),
                "모델 검사 후 편집 도구에서 원본 면을 선택해 주세요.")
            add("organize_parts", "파츠 역할 저장", bool(inspection.get("nodes")), "먼저 모델 검사를 실행해 주세요." if not inspection else None)
            add("record_review", "검수 기록", bool(inspection and not inspection.get("errors")), "오류 없는 모델 검사가 필요합니다." if not inspection or inspection.get("errors") else None)
        key_present = bool(os.getenv("MESHY_API_KEY"))
        if not motion_pack:
            ready = bool(height and (model or provider.get("task_id")) and (not provider or provider.get("status") == "SUCCEEDED"))
            add("prepare_character", "리깅 + 기본 동작 5종 가져오기", key_present and ready,
                "키와 모델 또는 성공한 Meshy 작업이 필요합니다. 최대 리깅 1회 + 동작 5회; 기본 walk/run은 재사용합니다.", True)
        elif motion_pack.get("status") != "complete":
            uncertain = any(t.get("status") == "submission_uncertain" for t in motion_pack.get("tasks", {}).values())
            add("resume_character", "기본 동작 가져오기 이어가기", key_present and not uncertain, "기존 작업 ID와 처음 설정한 제출 한도를 이어갑니다.", True)
            if uncertain:
                add("recover_motion_task", "동작 패키지 작업 ID 복구", key_present)
        if provider.get("task_id"):
            add("refresh_provider", "Meshy 상태 확인", key_present, None if key_present else "서버에 Meshy API 키가 필요합니다.")
        if provider.get("status") == "submission_uncertain" and not provider.get("task_id"):
            add("recover_task", "기존 작업 ID 복구", key_present, None if key_present else "서버에 Meshy API 키가 필요합니다.")
        next_action = plan.get("next_action")
        if next_action in {"submit_generation", "submit_rigging"} and not model_id == "imported":
            add(next_action, "Meshy 3D 생성" if next_action == "submit_generation" else "Meshy 기본 리깅",
                key_present and not problems, None if key_present else "서버에 Meshy API 키가 필요합니다.", True)
        if next_action in {"download_generation", "download_rigging"}:
            add(next_action, "생성 모델 받기" if next_action == "download_generation" else "리깅 모델 받기")
        # Recovery GETs are allowed after a server restart; they do not resubmit work.
        if busy and operation["status"] == "recovery_required" and (operation.get("error") or {}).get("code") != "executor_interrupted":
            for action in actions:
                if action["id"] in {"refresh_provider", "recover_task", "resume_character", "recover_motion_task"}:
                    action.update(enabled=key_present, reason=None)
        artifacts = [{"id": name, "kind": "image" if name in {"reference", "rest_render"} else ("file" if name == "parts_blend" else "model"), "bytes": path.stat().st_size,
                      "url": f"/api/characters/{character_id}/artifacts/{name}"} for name, path in files.items()]
        return {"id": character_id, "name": control.get("name", entry.get("name", f"Character {character_id}")),
                "revision": self.revision(entry, run, control, snapshot={"provider": provider, "motion_pack": motion_pack, "operation": operation}), "height_meters": height,
                "provider": {key: provider.get(key) for key in ("stage", "status", "progress", "task_id", "http_status")},
                "pipeline_status": pipeline_status, "rig_origin": rig_origin, "operation": operation,
                "problems": problems, "next_actions": actions, "artifacts": artifacts,
                "model_id": model_id, "model_sha256": current_hash,
                "motion_pack": {"status": motion_pack.get("status"), "submitted_tasks": motion_pack.get("submitted_tasks", 0),
                    "max_new_tasks": motion_pack.get("max_new_tasks"), "clips": motion_pack.get("clips", {}),
                    "tasks": {slot: {k: task.get(k) for k in ("task_id", "status", "progress", "http_status")} for slot, task in motion_pack.get("tasks", {}).items()}},
                "inspection": inspection, "parts": control.get("parts", []) if control.get("parts_sha256") == current_hash else [],
                "review": review, "body_coverage": control.get("body_coverage", "unknown")}

    def listing(self, user_id: int) -> list[dict]:
        ids = [e["id"] for e in self.records() if e.get("owner_id", self.owner) == user_id]
        return list(_LISTING_READERS.map(lambda character_id: self.detail(character_id, user_id), ids))

    def check_revision(self, entry, run, control, revision):
        if self.revision(entry, run, control) != revision:
            raise PipelineError("revision_conflict", "다른 작업으로 상태가 바뀌었습니다. 새 상태를 확인해 주세요.")

    def check_idle(self, run: Path):
        operation = self.latest_operation(run)
        if operation and operation["status"] in {"accepted", "running", "recovery_required"}:
            raise PipelineError("busy", "기존 작업이 끝나거나 복구된 뒤 변경할 수 있습니다.")

    def update(self, character_id, user_id, values, revision):
        entry, run, _ = self.entry(character_id, user_id)
        with self.lock(run):
            control = read_json(run / "control.json")
            self.check_revision(entry, run, control, revision)
            self.check_idle(run)
            provider = read_json(run / "motion-pack.json") or read_json(run / "character.json")
            if provider and "height_meters" in values and values["height_meters"] != provider.get("height_meters"):
                raise PipelineError("source_frozen", "제출된 작업의 키는 변경할 수 없습니다. 새 캐릭터로 등록해 주세요.")
            run.mkdir(parents=True, exist_ok=True)
            control.update(values)
            _write_json(run / "control.json", control)
        self.sync_storage(character_id, user_id)
        return self.detail(character_id, user_id)

    def create(self, name: str, height: float | None, user_id: int):
        with self.lock(self.root / "characters/.registry"):
            data = read_json(self.manifest, {"version": 1, "characters": []})
            character_id = "char-" + uuid.uuid4().hex[:12]
            data["characters"].append({"id": character_id, "name": name, "height_meters": height,
                                       "run": "characters/" + character_id, "image": "",
                                       "owner_id": user_id, "required_parts": ["body", "outfit_base"]})
            self.manifest.parent.mkdir(parents=True, exist_ok=True)
            _write_json(self.manifest, data)
        self.sync_storage(character_id, user_id)
        return self.detail(character_id, user_id)

    def upload(self, character_id, user_id, content: bytes, kind: str, revision: str):
        if kind == "model":
            quality = inspect_glb(content)
            if quality["errors"]:
                raise PipelineError("invalid_glb", "GLB 구조 검사를 통과하지 못했습니다.", 400)
            doc, _ = parse_glb(content, strict=True)
            # Unrigged imports can enter the Meshy rig + animation preparation action.
            suffix = ".glb"
        else:
            try:
                with Image.open(io.BytesIO(content)) as image:
                    if image.format not in {"PNG", "JPEG"} or image.width * image.height > 32_000_000:
                        raise ValueError("unsupported image")
                    suffix = ".png" if image.format == "PNG" else ".jpg"
                    image.verify()
            except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
                raise PipelineError("invalid_image", "PNG 또는 JPEG 이미지를 선택해 주세요.", 400) from exc
        entry, run, _ = self.entry(character_id, user_id)
        with self.lock(run):
            control = read_json(run / "control.json")
            self.check_revision(entry, run, control, revision)
            self.check_idle(run)
            if (run / "character.json").exists() or (run / "motion-pack.json").exists():
                raise PipelineError("source_frozen", "기존 생성 기록의 출처는 보존됩니다. 새 캐릭터로 등록해 주세요.")
            target = run / "sources" / (uuid.uuid4().hex + suffix)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            field = "imported_model" if kind == "model" else "image"
            control[field] = str(target.relative_to(self.root))
            control[field + "_sha256"] = _digest(target)
            if kind == "model":
                control.update(rig_origin="unknown", parts=[], review={}, inspection={}, body_coverage="unknown")
                control.pop("parts_model", None)
                control.pop("parts_sha256", None)
                control.pop("parts_blend", None)
                control.pop("rest_render", None)
            _write_json(run / "control.json", control)
        self.sync_storage(character_id, user_id)
        return self.detail(character_id, user_id)

    def artifact(self, character_id, user_id, artifact_id):
        entry, run, control = self.entry(character_id, user_id)
        files = self.files(entry, run, control)
        if artifact_id not in files:
            raise PipelineError("not_found", "산출물을 찾을 수 없습니다.", 404)
        return files[artifact_id]

    def accept(self, character_id, user_id, action_id, key, revision, payload):
        entry, run, _ = self.entry(character_id, user_id)
        if not re.fullmatch(r"[a-zA-Z0-9_-]{8,100}", key):
            raise PipelineError("invalid_key", "요청 식별자가 필요합니다.", 400)
        operation_id = hashlib.sha256(f"{user_id}:{character_id}:{action_id}:{key}".encode()).hexdigest()[:32]
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        path = run / "operations" / operation_id / "operation.json"
        with self.lock(run):
            if path.exists():
                old = read_json(path)
                if old["fingerprint"] != fingerprint:
                    raise PipelineError("idempotency_conflict", "같은 요청 식별자에 다른 입력을 사용할 수 없습니다.")
                return self.public_operation(old), False
            control = read_json(run / "control.json")
            self.check_revision(entry, run, control, revision)
            view = self.detail(character_id, user_id)
            if not any(a["id"] == action_id and a["enabled"] for a in view["next_actions"]):
                raise PipelineError("action_unavailable", "현재 상태에서 실행할 수 없는 작업입니다.")
            value = {"id": operation_id, "action_id": action_id, "status": "accepted", "payload": payload,
                     "fingerprint": fingerprint, "created_at": now(), "updated_at": now(),
                     "executor": self.instance, "input_sha256": view["model_sha256"], "error": None}
            from src.services.process_identity import identity
            value["executor_process"] = identity()
            if action_id == "separate_parts" and payload.get("source_artifact_id"):
                source = self.files(entry, run, control).get(payload["source_artifact_id"])
                if not source or _digest(source) != payload["source_sha256"]:
                    raise PipelineError("input_changed", "선택한 원본 버전과 면 선택의 해시가 다릅니다.")
                value["input_sha256"] = payload["source_sha256"]
            reference = self.files(entry, run, control).get("reference")
            value["image_sha256"] = _digest(reference) if reference else None
            path.parent.mkdir(parents=True, exist_ok=False)
            _write_json(path, value)
        self.sync_storage(character_id, user_id)
        return self.public_operation(value), True

    def operation(self, character_id, user_id, operation_id):
        _, run, _ = self.entry(character_id, user_id)
        if not re.fullmatch(r"[a-f0-9]{32}", operation_id):
            raise PipelineError("not_found", "작업을 찾을 수 없습니다.", 404)
        path = run / "operations" / operation_id / "operation.json"
        if not path.is_file():
            raise PipelineError("not_found", "작업을 찾을 수 없습니다.", 404)
        return self.public_operation(read_json(path))
