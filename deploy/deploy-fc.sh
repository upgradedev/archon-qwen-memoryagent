#!/usr/bin/env bash
# Build → push → deploy the MemoryAgent backend to Alibaba Cloud Function Compute.
#
# This is a USER-GATED script: it needs a real Alibaba Cloud account. It is not
# run in CI. Everything it does is also achievable from the FC / ACR console.
#
# Required environment (see ../.env.example + your Alibaba Cloud console):
#   ACR_REGISTRY   e.g. registry.ap-southeast-1.aliyuncs.com
#   ACR_NAMESPACE  your ACR namespace (same region as the function)
#   REGION         e.g. ap-southeast-1  (Singapore / international)
# And, configured via `s config add`:
#   ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET
#
# Usage:  REGION=ap-southeast-1 ACR_NAMESPACE=my-ns ACR_REGISTRY=registry.ap-southeast-1.aliyuncs.com bash deploy/deploy-fc.sh
set -euo pipefail

: "${ACR_REGISTRY:?set ACR_REGISTRY (e.g. registry.ap-southeast-1.aliyuncs.com)}"
: "${ACR_NAMESPACE:?set ACR_NAMESPACE (your ACR namespace)}"
REGION="${REGION:-ap-southeast-1}"
IMAGE="${ACR_REGISTRY}/${ACR_NAMESPACE}/archon-qwen-memoryagent:latest"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building image ${IMAGE} (linux/amd64 for Function Compute)"
docker build --platform linux/amd64 -t "${IMAGE}" "${ROOT}"

echo "==> Logging in to ACR (${ACR_REGISTRY})"
docker login "${ACR_REGISTRY}"

echo "==> Pushing image"
docker push "${IMAGE}"

echo "==> Deploying with Serverless Devs (deploy/s.yaml)"
# `s` reads deploy/s.yaml; override the image + region it uses.
cd "${ROOT}/deploy"
s deploy --skip-push true 2>/dev/null || s deploy

echo "==> Done. The HTTP trigger URL is printed above."
echo "    Verify:  curl <trigger-url>/health"
