#!/bin/sh
set -eu

read_secret() {
  variable_name="$1"
  default_file="$2"
  eval "current_value=\${$variable_name:-}"
  eval "secret_file=\${${variable_name}_FILE:-$default_file}"
  if [ -z "$current_value" ] && [ -r "$secret_file" ]; then
    current_value="$(cat "$secret_file")"
    export "$variable_name=$current_value"
  fi
}

read_secret DATABASE_URL /run/secrets/database_url
read_secret JWT_SECRET /run/secrets/jwt_secret
read_secret PROVIDER_ENCRYPTION_KEY /run/secrets/provider_encryption_key
read_secret INTERNAL_MONITOR_TOKEN /run/secrets/monitor_token
read_secret LOAD_TEST_ADMIN_TOKEN /run/secrets/load_test_admin_token

if id nextjs >/dev/null 2>&1; then
  exec su-exec nextjs "$@"
fi

exec "$@"
