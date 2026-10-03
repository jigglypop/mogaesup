"""What the public /health tells about a server, and what its logs leave out."""
import logging

from src import configure_logging
from src.runtime_identity import _database_identity, runtime_identity


def test_the_public_revision_names_the_records_database_by_place_never_by_credentials(monkeypatch):
    monkeypatch.setenv('CHARACTER_DATABASE_URL', 'postgresql://user:first-password@db.internal:5432/records?sslmode=require')
    first = runtime_identity()['revision']
    # Another password (or user) gives the same revision: it says nothing about them.
    monkeypatch.setenv('CHARACTER_DATABASE_URL', 'postgresql://other:second-password@db.internal:5432/records?sslmode=require')
    assert runtime_identity()['revision'] == first
    monkeypatch.setenv('CHARACTER_DATABASE_URL', 'postgresql://user:first-password@db.internal:5432/other-records')
    assert runtime_identity()['revision'] != first


def test_the_database_identity_keeps_host_port_and_name_only():
    assert _database_identity('postgresql://u:secret@db.internal:5432/records?sslmode=require') == 'db.internal/5432/records'
    assert _database_identity('host=db.internal port=6432 dbname=records user=u password=secret') == 'db.internal/6432/records'
    assert _database_identity('') == '' and _database_identity('not a connection string') == 'unreadable'


def test_provider_urls_with_signatures_stay_out_of_the_info_log():
    for name in ('httpx', 'httpcore'):
        logging.getLogger(name).setLevel(logging.NOTSET)
    configure_logging()
    # httpx logs every request at INFO with its whole URL; Meshy and Tripo download links carry their signatures.
    assert logging.getLogger('httpx').getEffectiveLevel() == logging.WARNING
    assert logging.getLogger('httpcore').getEffectiveLevel() == logging.WARNING
