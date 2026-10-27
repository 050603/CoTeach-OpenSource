#!/usr/bin/env bash
# Run on the deployment host, as the owner of the configured user services.
set -euo pipefail

revision=${1:?Usage: deploy-systemd.sh COMMIT_SHA PROJECT_PATH}
project_path=${2:?Missing project path}
app_port=${3:-${OPENPBL_PORT:-3000}}
[[ "$app_port" =~ ^[0-9]{1,5}$ ]] && (( 10#$app_port > 0 && 10#$app_port <= 65535 )) || {
  echo 'Invalid application port' >&2; exit 2;
}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA' >&2; exit 2; }
[[ "$project_path" = /* ]] || { echo 'Expected an absolute project path' >&2; exit 2; }
cd "$project_path"
[[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ]]

# Serialize manual and CI updates on the host as well as in GitHub Actions.
exec 9>"$(git rev-parse --git-path openpbl-deploy.lock)"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Deployment checkout has local changes' >&2; exit 1; }
for executable in pnpm node python3 systemctl curl; do command -v "$executable" >/dev/null; done
for service in openpbl.service openpbl-code-runner.service openpbl-survey-nlp.service openpbl-speech-alignment.service openpbl-outbound-proxy.service; do
  [[ "$(systemctl --user show "$service" --property=WorkingDirectory --value)" = "$(pwd -P)" ]] || {
    echo "$service must be installed for $project_path before deployment" >&2; exit 1;
  }
done

previous_revision=$(git rev-parse HEAD)
git fetch --no-tags origin "$revision"
git checkout --detach "$revision"
printf 'Deploying %s (previous commit %s)\n' "$revision" "$previous_revision"

python3 scripts/setup-survey-nlp.py
python3 scripts/setup-speech-alignment.py
pnpm install --frozen-lockfile
pnpm build
# A successful build must have prepared this exact immutable runtime, including
# its browser dependencies, before any running service is interrupted.
build_id=$(<.next-build/BUILD_ID)
node scripts/lib/production-runtime-release.mjs "$project_path" "$build_id" >/dev/null
# The application service applies committed migrations before it starts.
# Failed builds never restart the currently serving immutable release.
systemctl --user daemon-reload
systemctl --user show openpbl.service --property=Environment --value | python3 -c '
import shlex
import sys

try:
    environment = shlex.split(sys.stdin.read())
except ValueError:
    sys.exit("Cannot inspect openpbl.service runtime version configuration")
pins = [entry.split("=", 1)[1] for entry in environment
        if entry.startswith("OPENPBL_RUNTIME_BUILD_ID=")]
if pins and pins[-1] != sys.argv[1]:
    sys.exit("openpbl.service has a different OPENPBL_RUNTIME_BUILD_ID; "
             "deployment stopped before restart. Review the explicit version pin.")
' "$build_id"
systemctl --user restart openpbl-outbound-proxy.service openpbl-code-runner.service openpbl-survey-nlp.service openpbl-speech-alignment.service openpbl.service

check_javascript_asset() {
  local metadata status mime
  metadata=$(curl --fail --silent --show-error --max-time 10 --output /dev/null \
    --write-out '%{http_code} %{content_type}' "$1") || return 1
  status=${metadata%% *}
  mime=${metadata#* }
  [[ "$status" =~ ^2[0-9]{2}$ ]] || return 1
  case "${mime,,}" in
    application/javascript|application/javascript\;*|text/javascript|text/javascript\;*|application/x-javascript|application/x-javascript\;*) return 0 ;;
    *) return 1 ;;
  esac
}

for attempt in {1..60}; do
  if systemctl --user is-active --quiet openpbl.service openpbl-code-runner.service openpbl-survey-nlp.service openpbl-speech-alignment.service openpbl-outbound-proxy.service &&
    curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:19999/health/ready" >/dev/null 2>&1 &&
    curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:3003/health/live" >/dev/null 2>&1 &&
    curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:3004/health/live" >/dev/null 2>&1 &&
    curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$app_port/api/health/live" >/dev/null 2>&1 &&
    check_javascript_asset "http://127.0.0.1:$app_port/vendor/pdfjs/pdf.legacy.min.mjs" >/dev/null 2>&1 &&
    check_javascript_asset "http://127.0.0.1:$app_port/vendor/pdfjs/pdf.worker.legacy.min.mjs" >/dev/null 2>&1; then
    printf 'Healthy deployment: %s\n' "$revision"
    exit 0
  fi
  sleep 3
done
printf 'Deployment health check failed; inspect user services. Previous commit: %s\n' "$previous_revision" >&2
# Schema migrations can make automatic rollback unsafe; leave diagnosis explicit.
exit 1
