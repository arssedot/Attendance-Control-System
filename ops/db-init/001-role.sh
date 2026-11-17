#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE ROLE attendance LOGIN PASSWORD :'app_password';
ALTER DATABASE attendance OWNER TO attendance;
SQL
