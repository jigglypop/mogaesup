from __future__ import annotations

from src.services.avatar_variants import AvatarVariants

BASE = {'base_job_id': 'a'*24, 'base_version': 'b'*24, 'slot': 'top'}


def accepted(monkeypatch, payload):
    service = AvatarVariants(factory=None)
    captured = {}

    def create(owner, key, variant, frozen_context=None):
        captured.update(variant)
        return {'id': 'job'}, True
    monkeypatch.setattr(service, 'create', create)
    service.create_single_part('owner', 'request-key-1', payload)
    return captured


def test_a_single_part_takes_its_own_design_brief_and_name(monkeypatch):
    variant = accepted(monkeypatch, {**BASE, 'description': '  Lavender oversized hoodie, hood down.  ',
                                     'part_name': '라벤더 후드티'})
    assert variant['descriptions'] == {'top': 'Lavender oversized hoodie, hood down.'}
    assert variant['part_name'] == '라벤더 후드티'


def test_without_a_brief_the_prompt_library_describes_the_part(monkeypatch):
    variant = accepted(monkeypatch, {**BASE, 'description': '   '})
    assert variant['descriptions'] == {}
    assert 'part_name' not in variant
