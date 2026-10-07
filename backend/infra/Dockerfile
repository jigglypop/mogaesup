# python:3.12-slim-bookworm by digest: the instance and the pipeline build the same base. Raise it on purpose
# (docker buildx imagetools inspect python:3.12-slim-bookworm), with the Blender line below as it needs.
# Production runs Python 3.12; .python-version keeps 3.11 for the local machines and backend/Dockerfile. The pipeline's
# backend-check runs the tests on both, and studio-image builds this image, so a change that works on one only fails there.
FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3
ARG BLENDER_VERSION=4.5.3
# blender-<version>.sha256 next to the download on download.blender.org; change both together.
ARG BLENDER_SHA256=975c58fcb244273838534bba771e64ad87739216b0f9b39a888531a49a72d845
# Not pinned to versions: bookworm's archive keeps only the newest build of each package, so a pin would fail the build
# at the next security fix (the base image digest above fixes the release). The build log names what was installed.
RUN apt-get update && apt-get install -y --no-install-recommends nginx curl xz-utils libx11-6 libxxf86vm1 libxi6 libxrender1 libxfixes3 libxkbcommon0 libsm6 libice6 libgl1 libegl1 libgomp1 && dpkg-query -W nginx curl libgl1 libegl1 && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 2 https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}-linux-x64.tar.xz -o /tmp/blender.tar.xz && echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c - && tar -xJf /tmp/blender.tar.xz -C /opt && ln -s /opt/blender-${BLENDER_VERSION}-linux-x64 /opt/blender && rm /tmp/blender.tar.xz
# The Blender workers run as studio-worker (uid and gid 10001), not as root: /usr/local/bin/blender starts the real one
# under that user (infra/blender-worker.py), the data root is shared with its group (entrypoint.py), and the host's
# firewall keeps that uid away from the instance metadata service (infra/worker-guard.sh). The API stays root in the
# container: nginx's port 80, the rules it writes under /etc/nginx, and stopping its workers need it.
RUN groupadd --gid 10001 studio-worker && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/studio-worker --shell /usr/sbin/nologin studio-worker
COPY infra/blender-worker.py /usr/local/bin/blender
RUN sed -i 's/\r$//' /usr/local/bin/blender && chmod 755 /usr/local/bin/blender
# Fails the build when a system library Blender links against is missing, or Blender cannot start as its worker.
RUN blender --background --factory-startup --version
WORKDIR /app
RUN pip install --no-cache-dir uv==0.11.9
# The locked dependencies first, from the workspace manifests alone: a release that changes only backend/ reuses this
# layer. --locked fails the build when uv.lock no longer matches the manifests.
COPY pyproject.toml uv.lock ./
COPY backend/pyproject.toml ./backend/pyproject.toml
RUN uv sync --locked --no-dev --no-install-workspace
COPY backend/ ./backend/
RUN uv sync --locked --no-dev
COPY infra/nginx.conf /etc/nginx/nginx.conf
# release.json (the git commit, written by prepare-aws.ps1) is optional: the glob matches nothing in older archives.
COPY infra/entrypoint.py release.jso[n] /app/
ENV PYTHONPATH=/app/backend ASSET_DATA_ROOT=/app/data BLENDER_EXECUTABLE=/usr/local/bin/blender
ENV PATH="/app/.venv/bin:${PATH}"
CMD ["python", "/app/entrypoint.py"]
