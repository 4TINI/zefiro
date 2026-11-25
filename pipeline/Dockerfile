# Pipeline dati di Zefiro (multi-arch: amd64 e arm64/Raspberry Pi).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ZEFIRO_OUT=/data \
    ZEFIRO_CACHE=/cache

WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends libexpat1 \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --root-user-action=ignore -r requirements.txt
COPY build.py config.yaml ./

ENTRYPOINT ["python", "build.py"]
