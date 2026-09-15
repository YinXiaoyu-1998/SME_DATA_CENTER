#!/usr/bin/env bash

set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git gnupg nginx

install -m 0755 -d /etc/apt/keyrings

if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl --retry 3 --retry-all-errors -fsSL \
    https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
fi
chmod a+r /etc/apt/keyrings/docker.asc

architecture="$(dpkg --print-architecture)"
ubuntu_codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"

cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${ubuntu_codename}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF

if [[ ! -s /etc/apt/keyrings/nodesource.gpg ]]; then
  curl --retry 3 --retry-all-errors -fsSL \
    https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
fi

cat >/etc/apt/sources.list.d/nodesource.list <<EOF
deb [arch=${architecture} signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main
EOF

apt-get update
apt-get install -y \
  containerd.io \
  docker-buildx-plugin \
  docker-ce \
  docker-ce-cli \
  docker-compose-plugin \
  nodejs

# The worker image runs as the Node base image's uid/gid 1000. Keep large
# partition work files off the container overlay and writable without root.
install -d -o 1000 -g 1000 -m 0750 /opt/enterprise-hub/partition-work

install -m 0755 -d /etc/docker
if [[ ! -e /etc/docker/daemon.json ]]; then
  cat >/etc/docker/daemon.json <<'EOF'
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-file": "3",
    "max-size": "10m"
  }
}
EOF
fi

cat >/etc/nginx/sites-available/enterprise-hub-default <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;

    location / {
        return 404;
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sfn \
  /etc/nginx/sites-available/enterprise-hub-default \
  /etc/nginx/sites-enabled/enterprise-hub-default

# 2 GiB swapfile backstop so transient memory spikes (for example XLSX ingestion)
# degrade instead of freezing the kernel on this small instance. Idempotent.
if [[ ! -e /swapfile ]]; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
fi
chmod 600 /swapfile
if ! swapon --show | grep -q '^/swapfile '; then
  mkswap /swapfile
  swapon /swapfile
fi
if ! grep -q '^/swapfile ' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
fi
printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-swap.conf
sysctl -p /etc/sysctl.d/99-swap.conf >/dev/null

systemctl daemon-reload
systemctl enable --now docker
systemctl enable --now nginx

nginx -t
systemctl reload nginx
docker version
docker compose version
node --version
npm --version
