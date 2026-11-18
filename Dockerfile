FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS web-build
WORKDIR /src
COPY package*.json ./
COPY clients/web/package.json clients/web/
COPY clients/mobile/package.json clients/mobile/
COPY clients/shared/package.json clients/shared/
RUN npm ci --workspace @attendance/web --workspace @attendance/shared --include-workspace-root=false --no-audit --no-fund
COPY clients/web clients/web
COPY clients/shared clients/shared
RUN npm run build --workspace @attendance/web

FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 STATIC_DIR=/srv/web
WORKDIR /srv/backend
RUN groupadd --system attendance && useradd --system --gid attendance --no-create-home attendance
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/attendance attendance
COPY backend/migrations migrations
COPY backend/fixtures fixtures
COPY --from=web-build /src/clients/web/dist /srv/web
USER attendance
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=4 \
    CMD ["python", "-c", "from urllib.request import urlopen; urlopen('http://127.0.0.1:8000/readyz', timeout=2).close()"]
CMD ["uvicorn", "attendance.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
