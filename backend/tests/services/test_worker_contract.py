"""The assembly version is a hash of the worker's source files; a worker file missing from it can change unnoticed."""
import ast
from pathlib import Path
import re

SERVICES = Path(__file__).resolve().parents[2] / 'src' / 'services'


def imported_services(module: str) -> set[str]:
    """Modules of src.services that a file imports anywhere in it, including inside functions."""
    found = set()
    for node in ast.walk(ast.parse((SERVICES / f'{module}.py').read_text(encoding='utf-8'))):
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module and node.module.startswith('src.services.'):
            found.add(node.module.rsplit('.', 1)[-1])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module == 'src.services':
            found.update(alias.name for alias in node.names if (SERVICES / f'{alias.name}.py').is_file())
        elif isinstance(node, ast.Import):
            found.update(alias.name.rsplit('.', 1)[-1] for alias in node.names if alias.name.startswith('src.services.'))
    return {name for name in found if (SERVICES / f'{name}.py').is_file()}


def worker_closure(module: str) -> set[str]:
    seen, todo = set(), [module]
    while todo:
        current = todo.pop()
        if current not in seen:
            seen.add(current)
            todo.extend(imported_services(current))
    return seen


def test_every_module_the_blender_worker_imports_is_part_of_the_assembly_version():
    hashed = set(re.findall(r"with_name\('([a-z_]+)\.py'\)", (SERVICES / 'avatar_native_parts.py').read_text(encoding='utf-8')))
    missing = worker_closure('avatar_native_parts_blender') - hashed
    assert not missing, f'add {sorted(missing)} to the contract in AvatarNativeParts.start, or a change to them keeps old versions'


from services.test_wardrobe_native_parts import refit  # noqa: E402,F401  (the fixture of a sealed job ready for a refit)


def test_a_version_hashes_every_worker_module_even_without_fit_profiles(refit):
    """The contract a new version is accepted with holds each worker module's hash whatever the parts are: a hair refit
    has no fit profile, and the worker still imports the garment fitting."""
    import hashlib
    from src.services.character_pipeline import read_json
    from wardrobe_fixture import OWNER
    from native_assembly_fixture import JOB, VERSION
    library, native, root = refit
    state, created = native.start_refit(OWNER, JOB, VERSION, 'hair', 'refit-key-0001')
    contract = read_json(root/state['version']/'input.json')['contract']
    assert created and not contract['fit_profiles']
    hashes = {value for value in contract.values() if isinstance(value, str)}
    missing = sorted(module for module in worker_closure('avatar_native_parts_blender')
                     if hashlib.sha256((SERVICES/f'{module}.py').read_bytes()).hexdigest() not in hashes)
    assert not missing, f'{missing} change unnoticed by a version made without fit profiles'
