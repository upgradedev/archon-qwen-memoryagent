#!/usr/bin/env bash
# Deploy the Archon MemoryAgent dashboard (web/dist) to Alibaba Cloud OSS static
# website hosting. Idempotent: safe to re-run — it ensures the bucket, (re)applies
# public-read + website config, and syncs the freshly built site.
#
# This is a USER-GATED script. It needs a working Alibaba Cloud AccessKey with OSS
# permissions on the `aliyun` CLI's `default` profile. It is NOT run in CI.
# (At the time of writing the configured AccessKey is DISABLED — `aliyun oss ls`
#  returns 403 UserDisable — so this script is prepared and documented, not run.)
#
# Everything it does is also achievable from the OSS console.
#
# Env overrides:
#   BUCKET   OSS bucket name           (default: archon-memoryagent-web)
#   REGION   OSS region id             (default: oss-ap-southeast-1)
#   PROFILE  aliyun CLI profile        (default: default)
#   ALIYUN   path to the aliyun binary (default: aliyun on PATH; on this Windows
#            box: /c/tools/aliyun/aliyun.exe)
#
# Usage:  bash deploy/oss-deploy.sh
set -euo pipefail

BUCKET="${BUCKET:-archon-memoryagent-web}"
REGION="${REGION:-oss-ap-southeast-1}"
PROFILE="${PROFILE:-default}"
ALIYUN="${ALIYUN:-aliyun}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${ROOT}/web/dist"
BUCKET_URL="oss://${BUCKET}"

# Zone form used by the static-website endpoint host (strip a leading "oss-").
ZONE="${REGION#oss-}"
WEBSITE_HOST="${BUCKET}.oss-website-${ZONE}.aliyuncs.com"

oss() { "${ALIYUN}" oss "$@" --region "${REGION}" --profile "${PROFILE}"; }

if [[ ! -f "${DIST}/index.html" ]]; then
  echo "ERROR: ${DIST}/index.html not found. Build first:" >&2
  echo "         cd web && npm install && npm run build" >&2
  exit 1
fi

echo "==> Ensuring bucket ${BUCKET_URL} (region ${REGION}, public-read)"
# `mb` fails if the bucket already exists — tolerate that for idempotency.
oss mb "${BUCKET_URL}" --acl public-read 2>/dev/null || \
  echo "    bucket already exists — continuing"

echo "==> Re-asserting public-read ACL on the bucket"
oss set-acl "${BUCKET_URL}" public-read -b -f

echo "==> Enabling static website hosting (index.html as index + error document)"
WEBSITE_XML="$(mktemp -t oss-website-XXXXXX.xml)"
trap 'rm -f "${WEBSITE_XML}"' EXIT
cat > "${WEBSITE_XML}" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<WebsiteConfiguration>
  <IndexDocument>
    <Suffix>index.html</Suffix>
  </IndexDocument>
  <ErrorDocument>
    <Key>index.html</Key>
  </ErrorDocument>
</WebsiteConfiguration>
XML
oss website --method put "${BUCKET_URL}" "${WEBSITE_XML}"

echo "==> Syncing ${DIST}/ → ${BUCKET_URL}"
# -f overwrite without prompt; --delete removes stale remote objects.
oss sync "${DIST}/" "${BUCKET_URL}" -f --delete

echo ""
echo "==> Done. Static website endpoint:"
echo "        http://${WEBSITE_HOST}/"
echo ""
echo "    (HTTP endpoint — matches the HTTP MemoryAgent API, so the Live toggle"
echo "     works without a mixed-content block. See web/README.md.)"
