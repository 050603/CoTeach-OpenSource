#!/bin/sh
set -eu

/usr/local/bin/openpbl-configure-pgbackrest

until gosu postgres pgbackrest --stanza=openpbl stanza-create; do
  sleep 10
done

while :; do
  if [ "$(date -u +%u)" = "7" ]; then
    backup_type=full
  else
    backup_type=diff
  fi

  if gosu postgres pgbackrest --stanza=openpbl --type="$backup_type" backup; then
    date -u +%FT%TZ > /var/lib/openpbl-backup-status/postgres.last-success
    printf 'openpbl_backup_last_success_timestamp_seconds{kind="postgres"} %s\n' \
      "$(date +%s)" > /var/lib/openpbl-backup-status/postgres.prom.tmp
    mv /var/lib/openpbl-backup-status/postgres.prom.tmp \
      /var/lib/openpbl-backup-status/postgres.prom
    gosu postgres pgbackrest --stanza=openpbl check
  fi
  sleep 86400 &
  wait $!
done
