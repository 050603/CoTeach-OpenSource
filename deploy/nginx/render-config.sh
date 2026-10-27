#!/bin/sh
# Directory binds follow atomically replaced templates. Render one selected
# template without discovering the other HTTP/HTTPS/bootstrap server blocks.
set -eu

template=${OPENPBL_NGINX_TEMPLATE:-openpbl.conf.template}
case "$template" in
  openpbl.conf.template)
    : "${OPENPBL_UPSTREAM_HOST:?Set OPENPBL_UPSTREAM_HOST}"
    : "${NGINX_INTERNAL_LISTEN:?Set NGINX_INTERNAL_LISTEN}"
    : "${LOAD_TEST_CLIENT_IP:?Set LOAD_TEST_CLIENT_IP}"
    ;;
  openpbl-http.conf.template|bootstrap.conf.template) ;;
  *) echo 'Unknown OPENPBL_NGINX_TEMPLATE' >&2; exit 1 ;;
esac
: "${PUBLIC_HOST:?Set PUBLIC_HOST}"
source_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
[ -s "$source_dir/$template" ] || { echo "Missing Nginx template: $template" >&2; exit 1; }

work_dir=$(mktemp -d /etc/nginx/conf.d/.openpbl-render.XXXXXX)
check_config=
trap 'rm -rf "$work_dir"; if [ -n "$check_config" ]; then rm -f "$check_config"; fi' EXIT
mkdir "$work_dir/templates" "$work_dir/output" "$work_dir/conf.d"
ln -s "$source_dir/$template" "$work_dir/templates/default.conf.template"
NGINX_ENVSUBST_TEMPLATE_DIR="$work_dir/templates" \
NGINX_ENVSUBST_OUTPUT_DIR="$work_dir/output" \
NGINX_ENVSUBST_TEMPLATE_SUFFIX='.template' \
  /docker-entrypoint.d/20-envsubst-on-templates.sh
[ -s "$work_dir/output/default.conf" ] || { echo 'Nginx template rendering produced no configuration' >&2; exit 1; }

# Validate the complete configuration while the live default.conf stays intact.
# Retain include names/order and all independent sites. Keep the temporary main
# file next to nginx.conf so relative includes retain their original base.
for include in /etc/nginx/conf.d/*.conf; do
  [ -e "$include" ] || [ -L "$include" ] || continue
  [ "${include##*/}" = default.conf ] && continue
  ln -s "$include" "$work_dir/conf.d/${include##*/}"
done
ln -s "$work_dir/output/default.conf" "$work_dir/conf.d/default.conf"
check_config=$(mktemp /etc/nginx/.openpbl-check.XXXXXX)
awk -v candidate="$work_dir/conf.d/*.conf" '
  /^[[:space:]]*include[[:space:]]+\/etc\/nginx\/conf[.]d\/[*][.]conf;[[:space:]]*(#.*)?$/ {
    sub(/\/etc\/nginx\/conf[.]d\/[*][.]conf/, candidate)
    replaced++
  }
  { print }
  END { if (replaced != 1) exit 1 }
' /etc/nginx/nginx.conf > "$check_config" || {
  echo 'Cannot locate the official Nginx conf.d include for candidate validation' >&2
  exit 1
}
nginx -t -c "$check_config"
# Only the CoTeach entry is replaced. Independent sites and optional edge log
# includes in conf.d retain their files and mounts.
mv -f "$work_dir/output/default.conf" /etc/nginx/conf.d/default.conf
