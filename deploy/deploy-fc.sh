#!/usr/bin/env bash
# Build, push and deploy an immutable MemoryAgent image to Alibaba Function
# Compute. Secrets are read from the environment and never written to a manifest.
set -euo pipefail

required=(
  ACR_REGISTRY ACR_NAMESPACE ACR_USERNAME ACR_PASSWORD
  DATABASE_URL DASHSCOPE_API_KEY JUDGE_API_KEY
  FC_VPC_ID FC_VSWITCH_ID FC_SECURITY_GROUP_ID
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "ERROR: set ${name}" >&2; exit 2; }
done
command -v docker >/dev/null || { echo "ERROR: docker not found" >&2; exit 2; }
command -v s >/dev/null || { echo "ERROR: Serverless Devs CLI 's' not found" >&2; exit 2; }

REGION="${REGION:-ap-southeast-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "${IMAGE_TAG:-}" ]]; then
  TAG="${IMAGE_TAG}"
elif git -C "${ROOT}" diff --quiet --ignore-submodules -- && \
     git -C "${ROOT}" diff --cached --quiet --ignore-submodules --; then
  TAG="$(git -C "${ROOT}" rev-parse --short=12 HEAD)"
else
  TAG="dirty-$(date -u +%Y%m%d%H%M%S)"
fi
[[ "${TAG}" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || { echo "ERROR: invalid IMAGE_TAG" >&2; exit 2; }
[[ "${DATABASE_URL}" == postgresql://* || "${DATABASE_URL}" == postgres://* ]] \
  || { echo "ERROR: DATABASE_URL must use postgres:// or postgresql://" >&2; exit 2; }
[[ "${FC_VPC_ID}" =~ ^vpc-[A-Za-z0-9]+$ ]] || { echo "ERROR: invalid FC_VPC_ID" >&2; exit 2; }
[[ "${FC_VSWITCH_ID}" =~ ^vsw-[A-Za-z0-9]+$ ]] || { echo "ERROR: invalid FC_VSWITCH_ID" >&2; exit 2; }
[[ "${FC_SECURITY_GROUP_ID}" =~ ^sg-[A-Za-z0-9]+$ ]] || { echo "ERROR: invalid FC_SECURITY_GROUP_ID" >&2; exit 2; }

export IMAGE_URI="${ACR_REGISTRY}/${ACR_NAMESPACE}/archon-qwen-memoryagent:${TAG}"
export REGION DATABASE_URL DASHSCOPE_API_KEY
export JUDGE_API_KEY
export FC_VPC_ID FC_VSWITCH_ID FC_SECURITY_GROUP_ID
export JUDGE_TENANT_ID="${JUDGE_TENANT_ID:-_public}"
export DASHSCOPE_BASE_URL="${DASHSCOPE_BASE_URL:-https://dashscope-intl.aliyuncs.com/compatible-mode/v1}"

echo "==> Validating Serverless Devs manifest"
(cd "${ROOT}/deploy" && s verify)

echo "==> Building ${IMAGE_URI} for linux/amd64"
docker build --pull --platform linux/amd64 -t "${IMAGE_URI}" "${ROOT}"

echo "==> Authenticating to ACR with password-stdin"
printf '%s' "${ACR_PASSWORD}" | docker login "${ACR_REGISTRY}" \
  --username "${ACR_USERNAME}" --password-stdin

echo "==> Pushing immutable image"
docker push "${IMAGE_URI}"

echo "==> Deploying Function Compute"
cd "${ROOT}/deploy"
s deploy -y --skip-push true

echo "==> Deployed ${IMAGE_URI}"
echo "    Verify the trigger URL printed above with: curl -fsS <url>/ready"
