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
        self.current = current
        self.writes = []
        self.version = 'previous'

    def get_secret_value(self, *, SecretId):
        return {'SecretString': self.key if SecretId == 'server' else json.dumps(self.settings), 'VersionId': self.version}

    def describe_secret(self, **_):
        return {'VersionIdsToStages': {self.version: ['AWSCURRENT'] if self.current else ['AWSPREVIOUS']}}

    def put_secret_value(self, **request):
        self.writes.append(request)
        self.settings = json.loads(request['SecretString'])
        self.version = request['ClientRequestToken']
        return {'VersionId': self.version}


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
