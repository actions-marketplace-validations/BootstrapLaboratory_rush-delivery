# checkov:skip=CKV_DOCKER_2:Intentional non-service scratch image has no executable health endpoint
FROM scratch

COPY --chmod=0444 dist/payload.txt /payload.txt
USER 65532:65532
