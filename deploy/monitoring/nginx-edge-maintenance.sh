#!/bin/sh
# Optional same-container replacement for the existing six-hour reload loop.
# No Docker socket, HTTP/DB request or application signal. Only Nginx's own logs.
set -eu
EDGE_DIR=/var/log/openpbl-edge
MAX_BYTES=52428800
RETAINED=5
EDGE_GID=${OPENPBL_EDGE_LOG_GID:?Set the host application primary group ID}
case "$EDGE_GID" in ''|*[!0-9]*) echo 'edge log GID must be numeric' >&2; exit 1;; esac
[ "$(id -u)" -eq 0 ] || { echo 'Nginx log initialization/rotation requires its container master user' >&2; exit 1; }

safe_directory() {
  [ -d "$EDGE_DIR" ] && [ ! -L "$EDGE_DIR" ]
}
safe_file() {
  [ ! -L "$1" ] && { [ ! -e "$1" ] || [ -f "$1" ]; }
}
create_current() {
  safe_file "$EDGE_DIR/current.ndjson" || return 1
  touch "$EDGE_DIR/current.ndjson" || return 1
  chown "nginx:$EDGE_GID" "$EDGE_DIR/current.ndjson" || return 1
  chmod 0640 "$EDGE_DIR/current.ndjson" || return 1
}
heartbeat() {
  safe_file "$EDGE_DIR/.maintenance.tmp" && safe_file "$EDGE_DIR/maintenance.json" || return 1
  umask 027
  printf '{"version":1,"updatedAtMs":%s000,"ok":%s,"maxBytes":%s,"retained":%s}\n' \
    "$(date +%s)" "$1" "$MAX_BYTES" "$RETAINED" > "$EDGE_DIR/.maintenance.tmp" || return 1
  chown "nginx:$EDGE_GID" "$EDGE_DIR/.maintenance.tmp" || return 1
  chmod 0640 "$EDGE_DIR/.maintenance.tmp" || return 1
  mv -f "$EDGE_DIR/.maintenance.tmp" "$EDGE_DIR/maintenance.json"
}
initialize() {
  safe_directory || return 1
  chown "nginx:$EDGE_GID" "$EDGE_DIR" || return 1
  chmod 2750 "$EDGE_DIR" || return 1
  create_current || return 1
  heartbeat true
}
rotate_once() {
  safe_directory && safe_file "$EDGE_DIR/current.ndjson" && [ -f "$EDGE_DIR/current.ndjson" ] || return 1
  size=$(stat -c %s "$EDGE_DIR/current.ndjson") || return 1
  if [ "$size" -ge "$MAX_BYTES" ]; then
    for n in 1 2 3 4 5; do safe_file "$EDGE_DIR/current.ndjson.$n" || return 1; done
    rm -f "$EDGE_DIR/current.ndjson.5" || return 1
    n=4
    while [ "$n" -ge 1 ]; do
      if [ -f "$EDGE_DIR/current.ndjson.$n" ]; then
        mv "$EDGE_DIR/current.ndjson.$n" "$EDGE_DIR/current.ndjson.$((n + 1))" || return 1
      fi
      n=$((n - 1))
    done
    mv "$EDGE_DIR/current.ndjson" "$EDGE_DIR/current.ndjson.1" || return 1
    create_current || return 1
    # If reopen fails, keep trying every maintenance iteration even if the
    # new pathname remains empty while Nginx still has the old file open.
    touch "$EDGE_DIR/.reopen-pending" || return 1
  fi
  if [ -f "$EDGE_DIR/.reopen-pending" ]; then
    nginx -s reopen || { heartbeat false; return 1; }
    rm "$EDGE_DIR/.reopen-pending" || return 1
  fi
  heartbeat true
}
case "${1:-}" in
  init) initialize;;
  once) rotate_once;;
  loop)
    iterations=0
    while sleep 30; do
      if ! rotate_once; then heartbeat false || true; echo 'edge log maintenance incomplete' >&2; fi
      iterations=$((iterations + 1))
      if [ "$iterations" -ge 720 ]; then nginx -s reload; iterations=0; fi
    done
    ;;
  *) echo 'Usage: nginx-edge-maintenance.sh init|once|loop' >&2; exit 2;;
esac
