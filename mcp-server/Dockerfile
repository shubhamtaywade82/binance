FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=4003

WORKDIR /app

# System deps for httpx/websockets are pure-python; only need curl for healthcheck-style probes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY crypto_exchange_mcp.py ./

EXPOSE 4003

CMD ["python", "crypto_exchange_mcp.py", "--transport", "http"]
