import base64
import io
from threading import Barrier, Thread

from PIL import Image
import pytest

from src.services import avatar_expressions, object_storage
from src.services.avatar_expressions import AvatarExpressions
from src.services.avatar_factory import _LOCK, digest
from src.services.character_pipeline import read_json
from wardrobe_fixture import Library, textured_glb

JOB, VERSION = 'e' * 24, 'f' * 24


@pytest.fixture
def expressions(tmp_path, storage_configured):
    library = Library(tmp_path)
    library.job(JOB)
    glb = textured_glb()
    library.assembly(JOB, VERSION, slots=(), contents={'body': glb, 'model': glb})
    library.current(JOB, VERSION)
    return AvatarExpressions(library.factory, 1, JOB, VERSION)


def payload(expressions, color=(10, 20, 30, 255)):
    face = io.BytesIO()
    Image.new('RGBA', (32, 32), color).save(face, 'PNG')
    return {'body_sha256': digest(expressions.body), 'name': '웃음', 'layout': {'eye': .64, 'mouth': .86, 'spacing': .21, 'size': 1},
            'maps': [{'material': 0, 'png': base64.b64encode(face.getvalue()).decode()}]}


class Writes:
    def __init__(self, monkeypatch):
        self.files, self.records = [], []
        real, real_write = object_storage.StoredPath.write_bytes, avatar_expressions._write_json
        files = self.files
        monkeypatch.setattr(object_storage.StoredPath, 'write_bytes',
                            lambda path, data: (files.append((path.name, _LOCK._is_owned())), real(path, data))[1])
        monkeypatch.setattr(avatar_expressions, '_write_json',
                            lambda path, value: (self.records.append((path.name, _LOCK._is_owned())), real_write(path, value))[1])


def test_an_expression_is_built_without_the_process_lock_and_recorded_under_it(expressions, monkeypatch):
    writes = Writes(monkeypatch)
    item = expressions.save(payload(expressions))
    built = {name for name, held in writes.files if name in ('body.glb', 'model.glb', 'material-0.png', 'body-material-0.png')}
    assert built == {'body.glb', 'model.glb', 'material-0.png', 'body-material-0.png'}
    assert not any(held for name, held in writes.files if name in built)
    assert ('record.json', True) in writes.records and ('manifest.json', False) in writes.records
    assert expressions.listing()['items'] == [item] and {artifact['name'] for artifact in item['artifacts']} >= {'body.glb', 'model.glb', 'manifest.json'}
    assert read_json(expressions.root/item['id']/'record.json')['files']['model.glb'] == digest(expressions.root/item['id']/'model.glb')


def test_the_same_expression_saved_again_or_together_is_built_once(expressions, monkeypatch):
    writes = Writes(monkeypatch)
    request = payload(expressions)
    start, results = Barrier(4), [None]*4

    def work(index):
        start.wait()
        try:
            results[index] = expressions.save(request)
        except BaseException as exc:
            results[index] = exc
    threads = [Thread(target=work, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert not [result for result in results if isinstance(result, BaseException)], results
    assert len({result['id'] for result in results}) == 1
    assert [name for name, _ in writes.files].count('model.glb') == 1
    assert expressions.save(request)['id'] == results[0]['id'] and [name for name, _ in writes.files].count('model.glb') == 1
    assert expressions.save(payload(expressions, (200, 10, 10, 255)))['id'] != results[0]['id']
