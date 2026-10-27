#!/bin/sh
set -eu

: "${PGBACKREST_S3_BUCKET:?PGBACKREST_S3_BUCKET is required}"
: "${PGBACKREST_S3_ENDPOINT:?PGBACKREST_S3_ENDPOINT is required}"
: "${PGBACKREST_S3_REGION:=us-east-1}"

S3_KEY="$(cat /run/secrets/s3_access_key)"
S3_SECRET="$(cat /run/secrets/s3_secret_key)"
S3_ENDPOINT="${PGBACKREST_S3_ENDPOINT#https://}"
S3_ENDPOINT="${S3_ENDPOINT#http://}"
install -d -m 0750 -o postgres -g postgres /etc/pgbackrest /var/spool/pgbackrest

cat > /etc/pgbackrest/pgbackrest.conf <<EOF
[global]
repo1-type=s3
repo1-path=/openpbl
repo1-s3-bucket=${PGBACKREST_S3_BUCKET}
repo1-s3-endpoint=${S3_ENDPOINT}
repo1-s3-region=${PGBACKREST_S3_REGION}
repo1-s3-key=${S3_KEY}
repo1-s3-key-secret=${S3_SECRET}
repo1-s3-uri-style=path
repo1-retention-full=4
repo1-retention-diff=14
repo1-bundle=y
archive-async=y
spool-path=/var/spool/pgbackrest
process-max=2
start-fast=y
log-level-console=info

[openpbl]
pg1-path=/var/lib/postgresql/data
EOF

chown postgres:postgres /etc/pgbackrest/pgbackrest.conf
chmod 0640 /etc/pgbackrest/pgbackrest.conf
