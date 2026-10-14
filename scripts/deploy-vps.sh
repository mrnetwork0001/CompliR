#!/usr/bin/env bash
# Zero-downtime app deploy on the VPS (run from the repo root on your machine).
# 1) sync code  2) build the image once  3) restart the standby, wait healthy  4) restart the primary
# (nginx sends traffic to the standby while the primary drains in-flight requests and restarts), wait healthy.
set -euo pipefail
HOST="${DEPLOY_HOST:-root@38.49.213.208}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
rsync -az --delete --exclude-from=.dockerignore --exclude='.env.production' --exclude='PRESENTER_GUIDE.md' -e "ssh -i $KEY" ./ "$HOST:/opt/complir/"
ssh -i "$KEY" "$HOST" 'set -eo pipefail; cd /opt/complir && chown -R root:root .
C="docker compose -f deploy/vps/docker-compose.yml --env-file .env.production"
wait_healthy() { for i in $(seq 1 60); do s=$(docker inspect -f "{{.State.Health.Status}}" "$1" 2>/dev/null || echo none); [ "$s" = healthy ] && return 0; sleep 2; done; echo "$1 not healthy" >&2; return 1; }
nice -n 10 $C build app 2>&1 | tail -1
$C up -d --no-deps --no-build app-standby 2>&1 | tail -1; wait_healthy complir-app-standby
$C up -d --no-deps --no-build app 2>&1 | tail -1; wait_healthy complir-app
docker ps --filter name=complir-app --format "{{.Names}}\t{{.Status}}"'
