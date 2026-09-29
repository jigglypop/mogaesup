FROM node:22-bookworm-slim AS ui
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
ARG BLENDER_VERSION=4.5.3
RUN apt-get update && apt-get install -y --no-install-recommends nginx curl xz-utils libx11-6 libxxf86vm1 libxi6 libxrender1 libxfixes3 libxkbcommon0 libsm6 libice6 libgl1 libegl1 libgomp1 && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 2 https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}-linux-x64.tar.xz -o /tmp/blender.tar.xz && tar -xJf /tmp/blender.tar.xz -C /opt && ln -s /opt/blender-${BLENDER_VERSION}-linux-x64/blender /usr/local/bin/blender && rm /tmp/blender.tar.xz
# Fails the build when a system library Blender links against is missing.
RUN blender --background --factory-startup --version
WORKDIR /app
COPY backend/ ./backend/
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv==0.11.9 && uv sync --frozen --no-dev
COPY --from=ui /app/frontend/dist /app/frontend/dist
COPY infra/nginx.conf /etc/nginx/nginx.conf
COPY infra/entrypoint.py /app/entrypoint.py
ENV PYTHONPATH=/app/backend ASSET_DATA_ROOT=/app/data BLENDER_EXECUTABLE=/usr/local/bin/blender
ENV PATH="/app/.venv/bin:${PATH}"
CMD ["python", "/app/entrypoint.py"]
