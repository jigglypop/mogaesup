from __future__ import annotations

from src.services import image_generation


def test_collect_reference_images_prefers_explicit_list_and_first_url():
    refs = image_generation.collect_reference_images(
        {
            "reference_images": [{"url": "https://example.test/list.png", "role": "detail"}],
            "reference_image_url": "https://example.test/direct.png",
            "image_url": "https://example.test/fallback.png",
        },
        default_role="character_reference",
    )

    assert refs == [
        {"url": "https://example.test/list.png", "role": "detail"},
        {"url": "https://example.test/direct.png", "role": "character_reference"},
    ]


def test_generate_reference_image_uses_extracted_3d_support(monkeypatch):
    monkeypatch.setattr(image_generation, "_image_model_fallbacks", lambda: ("gemini-test",))
    monkeypatch.setattr(
        image_generation,
        "_resolve_default_image_model",
        lambda settings, fallbacks: fallbacks[0],
    )
    monkeypatch.setattr(
        image_generation,
        "_resolve_media_model_alias",
        lambda modality, model, settings: model,
    )
    monkeypatch.setattr(
        image_generation,
        "_dispatch_image_generation",
        lambda **kwargs: ("gemini-test", [], [(b"png", "image/png")], [], {"total_tokens": 1}),
    )
    monkeypatch.setattr(image_generation, "_image_dimensions", lambda content: (32, 32))
    monkeypatch.setattr(
        image_generation,
        "_upload_to_s3",
        lambda content, mime_type, media_kind, settings: {
            "bucket": "assets",
            "key": "world/reference.png",
            "url": "https://cdn.example.test/world/reference.png",
        },
    )

    result = image_generation.generate_reference_image(
        settings={},
        prompt="front view character",
        body={},
        user_id=7,
        usage_session="world-reference",
        media_kind="world-reference",
    )

    assert result["status"] == "ready"
    assert result["model"] == "gemini-test"
    assert result["url"] == "https://cdn.example.test/world/reference.png"
    assert result["width"] == 32
    assert result["height"] == 32
