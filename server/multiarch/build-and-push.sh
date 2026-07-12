#!/usr/bin/env bash
# Runs INSIDE the docker:dind container (see Dockerfile). Starts an inner Docker
# daemon, sets up QEMU + a multi-platform buildx builder, logs in to the registry
# with credentials inherited from the host (config file and/or ACR_TOKEN), then
# builds and pushes the multi-arch image from /src.
set -euo pipefail

IMAGE="${IMAGE:?IMAGE env required (e.g. myregistry.azurecr.io/claude-account-switcher-sync)}"
VERSION="${VERSION:?VERSION env required (e.g. 0.2.2)}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
MTU="${MTU:-1360}"
REGISTRY="${IMAGE%%/*}"

echo ">> starting inner Docker daemon (mtu $MTU)"
dockerd-entrypoint.sh --mtu="$MTU" >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 60); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
docker info >/dev/null 2>&1 || {
  echo "!! inner dockerd did not come up:" >&2
  tail -50 /var/log/dockerd.log >&2
  exit 1
}

# Inherit the host's registry credentials. The raw config may reference a host-side
# credential helper (Docker Desktop's "credsStore") whose binary doesn't exist in
# here — strip it and rely on plain auths and/or the ACR token.
mkdir -p "$HOME/.docker"
if [ -f /host-docker-config.json ]; then
  jq 'del(.credsStore, .credHelpers, .currentContext)' /host-docker-config.json \
    >"$HOME/.docker/config.json" 2>/dev/null || cp /host-docker-config.json "$HOME/.docker/config.json"
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo ">> DRY_RUN=1 — building without pushing"
elif [ -n "${ACR_TOKEN:-}" ]; then
  echo ">> logging in to $REGISTRY with the ACR access token"
  echo "$ACR_TOKEN" | docker login "$REGISTRY" \
    --username 00000000-0000-0000-0000-000000000000 --password-stdin
elif ! jq -e --arg r "$REGISTRY" '.auths[$r] // empty' "$HOME/.docker/config.json" >/dev/null 2>&1; then
  echo "!! no usable credentials for $REGISTRY." >&2
  echo "   Run 'az acr login --name ${REGISTRY%%.*}' on the host first (the wrapper" >&2
  echo "   forwards an --expose-token automatically when 'az' is available), or set ACR_TOKEN." >&2
  exit 1
fi

echo ">> enabling cross-architecture emulation (QEMU/binfmt)"
docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null

# host networking for both the BuildKit container AND its build-step sandboxes:
# they then share this container's eth0, whose MTU the wrapper already fixed —
# otherwise BuildKit adds its own 1500-MTU bridge and large TLS packets stall
# again ("TLS handshake timeout" on registry pulls behind VPN/Azure networks).
docker buildx create --use --name multiarch \
  --driver-opt network=host \
  --buildkitd-flags '--oci-worker-net=host' >/dev/null

OUTPUT=(--push)
if [ "${DRY_RUN:-0}" = "1" ]; then
  OUTPUT=(--output type=image,push=false)
fi
echo ">> building $IMAGE:$VERSION (+ :latest) for $PLATFORMS"
docker buildx build \
  --platform "$PLATFORMS" \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  "${OUTPUT[@]}" \
  /src

if [ "${DRY_RUN:-0}" != "1" ]; then
  echo ">> pushed. Manifest:"
  docker buildx imagetools inspect "$IMAGE:$VERSION"
fi
echo ">> done"
