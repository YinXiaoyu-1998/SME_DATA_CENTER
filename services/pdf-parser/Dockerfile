# Build with the service directory as the context, never the repository root.
FROM scratch AS model-cache
FROM python:3.12.12-slim-bookworm AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2 \
    SMEDC_PDF_MODELS_PATH=/opt/models TMPDIR=/tmp
WORKDIR /opt/parser

FROM base AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock model-manifest.json model-notices.json ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-editable
# Optional named public-asset cache accelerates preparation; only the manifest
# files are selected, hashed, copied, and made read-only. Default fetch is build-only.
RUN --mount=from=model-cache,target=/cache \
    .venv/bin/python -m smedc_pdf_parser.prepare_models --cache /cache --output /opt/models

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 libgomp1 tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 parser && useradd --uid 10001 --gid 10001 --no-create-home parser
COPY --from=build /opt/parser/.venv /opt/parser/.venv
COPY --from=build /opt/models /opt/models
ENV PATH=/opt/parser/.venv/bin:$PATH
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "python", "-m", "smedc_pdf_parser.server"]
