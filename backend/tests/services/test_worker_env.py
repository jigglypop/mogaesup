from src.services.worker_env import worker_environment, without_secrets


def test_workers_get_the_environment_without_credentials(monkeypatch):
    for name, value in {'OPENAI_API_KEY': 'k1', 'MESHY_API_KEY': 'k2', 'AWS_SECRET_ACCESS_KEY': 's', 'AWS_SESSION_TOKEN': 't',
                        'CHARACTER_DATABASE_URL': 'postgresql://u:p@h/db', 'JWT_SECRET': 'j',
                        'ASSET_S3_BUCKET': 'bucket', 'PATH': '/usr/bin', 'ASSET_DATA_ROOT': '/data'}.items():
        monkeypatch.setenv(name, value)
    worker = worker_environment(EXTRA='1')
    assert not [name for name in worker if name.upper() in {'OPENAI_API_KEY', 'MESHY_API_KEY', 'AWS_SECRET_ACCESS_KEY',
                                                            'AWS_SESSION_TOKEN', 'CHARACTER_DATABASE_URL', 'JWT_SECRET'}]
    assert worker['ASSET_STORAGE_WORKER_LOCAL'] == '1' and worker['EXTRA'] == '1'
    assert worker['ASSET_DATA_ROOT'] == '/data' and worker['ASSET_S3_BUCKET'] == 'bucket'
    assert 'PATH' in {name.upper() for name in worker}


def test_without_secrets_filters_a_given_environment():
    assert without_secrets({'A_KEY': '1', 'B': '2', 'db_password': '3'}) == {'B': '2'}
