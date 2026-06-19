#!/usr/bin/env sh
set -e

flask --app app:create_app init-db
flask --app app:create_app seed-data

exec "$@"
