"""Reconcile interrupted executors, never replay provider submissions or Blender."""

from pathlib import Path
import tempfile

from src.services.asset_editor import _write_json
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.process_identity import lease_guard, state
from src.services.wardrobe import _digest


def recover(pipeline, character_id, user_id, operation_id, revision):
    pipeline.operation(character_id, user_id, operation_id)  # Ownership and opaque ID validation.
    entry, run, _ = pipeline.entry(character_id, user_id)
    path = run / "operations" / operation_id / "operation.json"
    try:
        with lease_guard(run):
            operation = read_json(path)
            if operation.get("recovered_at"):
                return pipeline.public_operation(operation)
            control = read_json(run / "control.json")
            pipeline.check_revision(entry, run, control, revision)
            if (operation.get("status") not in {"accepted", "running"}
                    or pipeline.latest_operation(run)["id"] != operation_id):
                raise PipelineError("recovery_unavailable", "중단된 최신 작업만 복구할 수 있습니다.")
            owner = operation.get("executor_process")
            if state(owner) != "exited":
                raise PipelineError("executor_unconfirmed", "이전 실행 프로세스가 살아 있거나 종료를 확인할 수 없습니다. 잠금을 유지합니다.")
            leases = []
            for lock in (run.with_name(run.name + ".lock"),
                         Path(tempfile.gettempdir()) / f"asset-wardrobe-blender-{pipeline.port}.lock"):
                if not lock.exists():
                    continue
                try:
                    lease = read_json(lock)
                except (ValueError, OSError) as exc:
                    raise PipelineError("legacy_lock", "기존 잠금의 실행 정보를 확인할 수 없습니다. 수동 점검이 필요합니다.") from exc
                if lock != run.with_name(run.name + ".lock") and lease.get("directory") != str(run):
                    continue
                if (lease.get("version") != 1 or not lease.get("token") or lease.get("directory") != str(run)
                        or lease.get("owner") != owner or state(lease.get("owner")) != "exited"):
                    raise PipelineError("lock_unconfirmed", "잠금 소유자의 종료를 확인할 수 없습니다. 잠금을 유지합니다.")
                leases.append(lock)
            result = "interrupted"
            if operation["status"] == "running" and operation["action_id"] in {"separate_materials", "separate_parts"}:
                output = path.parent / "blender"
                runner = read_json(output / "runner.json")
                if state(runner.get("process")) != "exited":
                    raise PipelineError("worker_unconfirmed", "Blender가 실행 중이거나 종료를 확인할 수 없습니다. 기존 작업을 보존합니다.")
                if (output / "worker-complete.json").is_file():
                    from src.services.character_actions import publish_parts
                    from src.services.character_parts import finalize
                    payload = read_json(output / "input.json")
                    model = pipeline.resolve(payload.get("original_model", ""))
                    if not model.is_file() or _digest(model) != operation.get("input_sha256"):
                        raise PipelineError("input_changed", "복구할 작업의 원본 해시가 일치하지 않습니다.")
                    try:
                        finalize(model, output)
                    except (ValueError, OSError, KeyError, TypeError) as exc:
                        raise PipelineError("completion_invalid", "완료 파일 검증에 실패했습니다. 원본과 잠금을 보존합니다.") from exc
                    publish_parts(pipeline, entry, run, control, operation, user_id)
                    _write_json(run / "control.json", control)
                    result = "adopted"
            stamp = now()
            operation.update(status="succeeded" if result == "adopted" else "failed", updated_at=stamp,
                             recovered_at=stamp, recovery_result=result,
                             error=None if result == "adopted" else {"code": "executor_interrupted",
                                 "message": "중단된 실행을 정리했습니다. 기존 Meshy 작업 ID와 파일은 보존됩니다. 상태 확인 후 이어가세요."})
            for lock in leases:
                lock.unlink()
            _write_json(path, operation)
    except ValueError as exc:
        if "busy" in str(exc):
            raise PipelineError("busy", "다른 요청이 작업 잠금을 확인 중입니다. 잠시 후 다시 확인해 주세요.") from exc
        raise
    pipeline.sync_storage(character_id, user_id)
    return pipeline.public_operation(operation)
