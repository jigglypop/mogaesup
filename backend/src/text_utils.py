from __future__ import annotations

def redact_url(url: str) -> str:
    if not url:
        return ""
    return url.split("?", 1)[0][:180]
