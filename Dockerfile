FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    QUANTUM_SANDBOX_DATA=/data \
    QUANTUM_SANDBOX_WEB_OUT=/app/web/out \
    PORT=8000

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN python3 -m pip install --no-cache-dir .

COPY --from=web-builder /app/web/out ./web/out

EXPOSE 8000
CMD ["python3", "-m", "quantum_sandbox_mcp.api"]
