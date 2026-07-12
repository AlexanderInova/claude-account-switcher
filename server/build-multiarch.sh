#!/usr/bin/env bash
# Builds and pushes the sync-server image for linux/amd64 AND linux/arm64 (Apple
# Silicon) via a TEMPORARY docker-in-docker container, so the host's Docker needs
# no buildx driver or containerd-store reconfiguration ("Multi-platform build is
# not supported for the docker driver").
#
# Registry credentials are inherited from the host like a VS Code devcontainer
# would: the host's ~/.docker/config.json is mounted read-only, and — because
# Docker Desktop usually keeps credentials in a host-side helper the container
# can't run — an ACR access token is fetched via 'az acr login --expose-token'
# when the az CLI is available (or pass ACR_TOKEN yourself).
#
# Usage:
#   ./build-multiarch.sh <version> <image>
#   ./build-multiarch.sh 0.2.2 myregistry.azurecr.io/claude-account-switcher-sync
#   DRY_RUN=1 ./build-multiarch.sh 0.2.2 <image>   # build both platforms, push nothing
#   MTU=1500  ./build-multiarch.sh 0.2.2 <image>   # override the network MTU (see below)
#
# MTU: VPNs and Azure networks often carry less than the Ethernet default of 1500
# bytes per packet. Every nested layer (this container's eth0, the inner Docker
# daemon, BuildKit) would default to 1500 and lose large TLS packets ("TLS
# handshake timeout" while pulling base images). We therefore run everything at a
# conservative MTU (default 1360) — override with MTU=… if your network differs.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-}"
IMAGE="${2:-}"
if [ -z "$VERSION" ] || [ -z "$IMAGE" ]; then
  echo "usage: $0 <version> <image>" >&2
  echo "  e.g. $0 0.2.2 myregistry.azurecr.io/claude-account-switcher-sync" >&2
  exit 2
fi
REGISTRY="${IMAGE%%/*}"

echo ">> building the throwaway builder image"
docker build -t cas-multiarch-builder multiarch/

MOUNTS=()
CONFIG="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
if [ -f "$CONFIG" ]; then
  MOUNTS+=(-v "$CONFIG":/host-docker-config.json:ro)
fi

# Docker Desktop stores registry credentials in a host-only helper; a mounted
# config.json alone then carries no secrets. Fetch a short-lived ACR token instead
# (harmless when the config already contains plain auths).
if [ -z "${ACR_TOKEN:-}" ] && [ "${DRY_RUN:-0}" != "1" ] && command -v az >/dev/null 2>&1; then
  echo ">> fetching an ACR access token via az (${REGISTRY%%.*})"
  ACR_TOKEN="$(az acr login --name "${REGISTRY%%.*}" --expose-token \
    --output tsv --query accessToken 2>/dev/null || true)"
fi

MTU="${MTU:-1360}"
# A dedicated outer network carries the MTU to the DinD container's own eth0
# (docker run has no per-container MTU flag).
NET="cas-multiarch-net"
docker network inspect "$NET" >/dev/null 2>&1 || \
  docker network create --driver bridge --opt com.docker.network.driver.mtu="$MTU" "$NET" >/dev/null
cleanup() { docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --privileged: required for the inner Docker daemon and QEMU/binfmt registration.
docker run --rm --privileged \
  --network "$NET" \
  -v "$PWD":/src:ro \
  ${MOUNTS[@]+"${MOUNTS[@]}"} \
  -e IMAGE="$IMAGE" \
  -e VERSION="$VERSION" \
  -e PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}" \
  -e ACR_TOKEN="${ACR_TOKEN:-}" \
  -e DRY_RUN="${DRY_RUN:-0}" \
  -e MTU="$MTU" \
  cas-multiarch-builder
