FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.9 /uv /uvx /bin/

WORKDIR /app
# API_HOST=0.0.0.0 is the container's own interface, so that a published port reaches it. Publish it on the loopback
# only (docker run -p 127.0.0.1:8000:8000, backend/README.md): the API takes X-User-Id from a request whose Host names
# the loopback, which any client can send through a port published on every interface.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    API_HOST=0.0.0.0 \
    ASSET_DATA_ROOT=/app/data

COPY pyproject.toml uv.lock .python-version ./
COPY backend/ backend/

RUN uv sync --locked --no-dev
# The code stays root's; the API runs as a user of its own that writes only its data root.
RUN useradd --system --uid 10001 --home-dir /app/data --shell /usr/sbin/nologin asset-api && install -d -o asset-api -g asset-api /app/data
USER asset-api

EXPOSE 8000
CMD ["asset-api"]
