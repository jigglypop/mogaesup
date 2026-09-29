"""Canonical avatar catalog and owner-scoped, atomic equipment save receipts.

The authored fixture catalog is a package, not an approval of imported characters.
Provider files and character journals are never modified here.
"""

from copy import deepcopy
import hashlib
import json
from src.services.object_storage import StoredPath as Path
import re
from threading import RLock
import uuid

from src.paths import BACKEND_ROOT
from src.services.asset_editor import _write_json
from src.services.character_pipeline import PipelineError, read_json


SLOTS = ("face", "hair", "top", "bottom", "onepiece", "shoes", "hat", "ear",
         "back", "bag", "hand", "offhand", "faceAccessory", "neckAccessory")
DEFAULT_STATE = {"body": "body-sd-neutral-v1", "equipment": {
    "hair": "hair-001", "top": "top-001", "bottom": "bottom-001", "shoes": "shoes-001"}}
ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")


class AvatarCatalog:
    def __init__(self, root: Path, package: Path | None = None):
        self.root = root.resolve() / "avatars"
        self.package = (package or BACKEND_ROOT / "assets/avatars/manual-v1").resolve()
        self._lock = RLock()  # The control API runs in one worker, as do character jobs.

    def records(self, user_id=None):
        from src.services.avatar_factory import factory_records
        return json.loads((self.package / "catalog.json").read_text(encoding="utf-8")) + factory_records(self.root.parent, user_id)

    def model(self, asset_id: str, lod: int, user_id=None):
        if not ID.fullmatch(asset_id) or lod not in (0, 1):
            raise PipelineError("invalid_asset", "올바른 에셋 ID와 LOD를 선택해 주세요.", 400)
        if not any(record["id"] == asset_id for record in self.records(user_id)):
            raise PipelineError("not_found", "아바타 에셋을 찾을 수 없습니다.", 404)
        if asset_id.startswith('factory-'):
            from src.services.avatar_factory import AvatarFactory
            _, job_id, slot = asset_id.split('-', 2)
            path = AvatarFactory(self.root.parent).artifact(user_id, job_id, slot + '.glb')
            return path, hashlib.sha256(path.read_bytes()).hexdigest()
        filename = f"{asset_id}{'-lod1' if lod else ''}.glb"
        evidence = read_json(self.package / "evidence.json")
        receipt = next((item for item in evidence.get("assets", []) if item["file"] == filename), None)
        path = (self.package / filename).resolve()
        if not path.is_relative_to(self.package) or not path.is_file() or not receipt:
            raise PipelineError("missing_asset", "에셋 파일을 확인할 수 없습니다.", 404)
        if hashlib.sha256(path.read_bytes()).hexdigest() != receipt["sha256"]:
            raise PipelineError("asset_changed", "에셋 해시가 카탈로그와 다릅니다. 다시 검증해 주세요.", 409)
        return path, receipt["sha256"]

    def validate(self, state, user_id=None):
        def invalid(message):
            raise PipelineError("incompatible_avatar", message, 422)

        if not isinstance(state, dict) or set(state) != {"body", "equipment"}:
            invalid("몸과 장착 ID만 저장할 수 있습니다.")
        equipment = state["equipment"]
        if not isinstance(equipment, dict) or any(slot not in SLOTS for slot in equipment):
            invalid("지원하지 않는 장착 슬롯입니다.")
        if any(not isinstance(value, str) or not ID.fullmatch(value)
               for value in [state["body"], *equipment.values()]):
            invalid("URL이나 경로 대신 에셋 ID를 지정해 주세요.")
        records = {item["id"]: item["metadata"]["avatar"] for item in self.records(user_id)}
        body = records.get(state["body"])
        if not body or body["kind"] != "avatar-body":
            invalid("기준 몸을 찾을 수 없습니다.")
        if "onepiece" in equipment and ("top" in equipment or "bottom" in equipment):
            invalid("원피스와 상하의를 함께 장착할 수 없습니다.")
        for slot, asset_id in equipment.items():
            part = records.get(asset_id)
            if (not part or part["kind"] != "avatar-part" or part["slot"] != slot
                    or part["rig"] != body["rig"]
                    or body["bodyArchetypes"][0] not in part["bodyArchetypes"]):
                invalid("몸, 리그 또는 슬롯이 맞지 않는 파츠입니다.")
            if any(required not in equipment for required in part.get("requires", [])):
                invalid("이 파츠에 필요한 장착물이 없습니다.")
            if any(conflict in equipment for conflict in part.get("conflictsWith", [])):
                invalid("함께 장착할 수 없는 파츠입니다.")
        return deepcopy(state)

    def _path(self, user_id: int):
        # Identity comes from the existing authentication dependency, never request paths.
        return self.root / str(int(user_id)) / "equipment.json"

    def read(self, user_id: int):
        saved = read_json(self._path(user_id))
        return deepcopy(saved.get("current", {"revision": "0", "state": DEFAULT_STATE}))

    def save(self, user_id: int, state: dict, revision: str, key: str):
        if not ID.fullmatch(key):
            raise PipelineError("invalid_key", "올바른 요청 키가 필요합니다.", 422)
        state = self.validate(state, user_id)
        fingerprint = hashlib.sha256(json.dumps({"state": state, "revision": revision},
                                               sort_keys=True).encode()).hexdigest()
        with self._lock:
            path = self._path(user_id)
            journal = read_json(path)
            receipt = journal.get("receipts", {}).get(key)
            if receipt:
                if receipt["fingerprint"] != fingerprint:
                    raise PipelineError("idempotency_conflict", "같은 요청 키에 다른 내용이 있습니다.", 409)
                return deepcopy(receipt["response"])
            current = self.read(user_id)
            if current["revision"] != revision:
                raise PipelineError("stale_revision", "서버에 더 최근의 장착 상태가 있습니다. 다시 불러와 주세요.", 409)
            response = {"revision": uuid.uuid4().hex, "state": state}
            receipts = journal.get("receipts", {})
            receipts[key] = {"fingerprint": fingerprint, "response": response}
            # Old keys still cannot overwrite state: their original revision is stale.
            receipts = dict(list(receipts.items())[-128:])
            path.parent.mkdir(parents=True, exist_ok=True)
            _write_json(path, {"current": response, "receipts": receipts})
            return deepcopy(response)
