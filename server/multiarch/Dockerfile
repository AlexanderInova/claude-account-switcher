# Throwaway docker-in-docker builder for multi-arch image publishing.
#
# Why: `docker buildx build --platform …` needs a non-default build driver (or the
# containerd image store). Instead of reconfiguring the host's Docker, this image
# brings its own inner Docker daemon, QEMU emulation, and buildx setup — run it once
# via ../build-multiarch.sh and throw it away.
FROM docker:27-dind

RUN apk add --no-cache bash jq
COPY build-and-push.sh /usr/local/bin/build-and-push
RUN chmod +x /usr/local/bin/build-and-push

ENTRYPOINT ["build-and-push"]
