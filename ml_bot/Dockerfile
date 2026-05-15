FROM python:3.12-slim

RUN groupadd -r mlbot && useradd -r -g mlbot mlbot

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/models && chown -R mlbot:mlbot /app

USER mlbot

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

EXPOSE 8000

CMD ["uvicorn", "inference_server:app", "--host", "0.0.0.0", "--port", "8000"]
