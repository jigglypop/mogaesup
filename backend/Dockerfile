FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.9 /uv /uvx /bin/

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

COPY pyproject.toml uv.lock .python-version ./
COPY backend/ backend/

RUN uv sync --locked --no-dev

EXPOSE 8000
CMD ["asset-api"]
