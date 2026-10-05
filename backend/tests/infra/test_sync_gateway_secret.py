import importlib.util
import json
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location('sync_gateway', Path(__file__).parents[2] / 'infra/sync-gateway-secret.py')
gateway_sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway_sync)


class Secrets:
    def __init__(self, key='existing_gateway_123456789', *, current=True, installed=None):
        self.key = key
        self.settings = {'OPENAI_API_KEY': 'test-image', 'MESHY_API_KEY': 'test-mesh', 'OTHER_SETTING': 'preserve'}
        if installed is not None:
            self.settings['STUDIO_GATEWAY_KEY'] = installed
        self.writes = []
        self.version = 'previous'
        self.stages = {'previous': ['AWSCURRENT'] if current else ['AWSPREVIOUS']}
        self.saved = {'previous': dict(self.settings)}
        # Another writer's put that lands just before ours (None: nobody else writes).
        self.interleave = None

    def get_secret_value(self, *, SecretId):
        return {'SecretString': self.key if SecretId == 'server' else json.dumps(self.settings), 'VersionId': self.version}

    def describe_secret(self, **_):
        return {'VersionIdsToStages': {version: list(names) for version, names in self.stages.items()}}

    def _put(self, version, settings):
        for names in self.stages.values():
            if 'AWSPREVIOUS' in names:
                names.remove('AWSPREVIOUS')
            if 'AWSCURRENT' in names:
                names.remove('AWSCURRENT')
                names.append('AWSPREVIOUS')
        self.stages[version] = ['AWSCURRENT']
        self.saved[version] = settings
        self.settings, self.version = settings, version

    def put_secret_value(self, **request):
        if self.interleave:
            other, self.interleave = self.interleave, None
            self._put('other-writer', {**self.settings, **other})
        self.writes.append(request)
        self._put(request['ClientRequestToken'], json.loads(request['SecretString']))
        return {'VersionId': request['ClientRequestToken']}

    def update_secret_version_stage(self, *, SecretId, VersionStage, MoveToVersionId, RemoveFromVersionId):
        self.stages[RemoveFromVersionId].remove(VersionStage)
        self.stages[MoveToVersionId].append(VersionStage)
        self.settings, self.version = self.saved[MoveToVersionId], MoveToVersionId


def test_sync_preserves_provider_settings_uses_existing_key_and_returns_only_receipt():
    client = Secrets()
    old = dict(client.settings)
    receipt = gateway_sync.sync(client, 'server', 'studio', 'same-request')
    assert client.settings == {**old, 'STUDIO_GATEWAY_KEY': client.key}
    assert client.writes[0]['SecretId'] == 'studio'
    assert client.writes[0]['ClientRequestToken'] == 'same-request'
    assert receipt == {'changed': True, 'version_id': 'same-request', 'previous_version_id': 'previous', 'gateway_matches': True}
    assert client.key not in json.dumps(receipt)
    assert not gateway_sync.sync(client, 'server', 'studio', 'same-request')['changed']
    assert len(client.writes) == 1


@pytest.mark.parametrize('key', ['', 'too-short', 'invalid key value 123456789', 'invalid;key;123456789'])
def test_invalid_existing_key_never_updates_the_provider_configuration(key):
    client = Secrets(key)
    with pytest.raises(RuntimeError):
        gateway_sync.sync(client, 'server', 'studio', 'same-request')
    assert client.writes == []


def test_a_known_concurrent_configuration_change_is_preserved():
    client = Secrets(current=False)
    with pytest.raises(RuntimeError, match='changed'):
        gateway_sync.sync(client, 'server', 'studio', 'same-request')
    assert client.writes == []


def test_a_rotation_keeps_the_replaced_key_for_the_server_still_sending_it():
    client = Secrets('rotated_gateway_1234567890', installed='existing_gateway_123456789')
    gateway_sync.sync(client, 'server', 'studio', 'rotation')
    assert client.settings['STUDIO_GATEWAY_KEY'] == 'rotated_gateway_1234567890'
    assert client.settings['STUDIO_GATEWAY_KEY_PREVIOUS'] == 'existing_gateway_123456789'


def test_a_first_key_has_no_previous_one():
    client = Secrets(installed=None)
    client.settings['STUDIO_GATEWAY_KEY_PREVIOUS'] = 'stale_gateway_key_123456789'
    gateway_sync.sync(client, 'server', 'studio', 'first')
    assert 'STUDIO_GATEWAY_KEY_PREVIOUS' not in client.settings


def test_a_write_that_lands_in_between_is_put_back_as_current():
    client = Secrets()
    client.interleave = {'OPENAI_API_KEY': 'rotated-by-someone-else'}
    with pytest.raises(RuntimeError, match='changed during the update'):
        gateway_sync.sync(client, 'server', 'studio', 'late')
    assert client.version == 'other-writer' and client.settings['OPENAI_API_KEY'] == 'rotated-by-someone-else'
    assert 'STUDIO_GATEWAY_KEY' not in client.settings
