// These functions run inside the existing locked staging release transaction.
// No certificate, nginx configuration, or public host is activated by a release.
export const marketingReleaseFunctions = String.raw`
marketing_root=/opt/smedc/marketing
marketing_previous=/opt/smedc/previous-marketing-release
marketing_container=""
marketing_pending=""

marketing_save() {
  if [ -L "$marketing_root/current" ]; then
    readlink "$marketing_root/current" > "$marketing_previous"
  else
    : > "$marketing_previous"
  fi
}

marketing_restore() {
  if [ -n "$marketing_container" ]; then docker rm "$marketing_container" >/dev/null; fi
  if [ -n "$marketing_pending" ]; then rm -rf "$marketing_pending"; fi
  if [ ! -f "$marketing_previous" ]; then return 0; fi
  local previous
  previous="$(cat "$marketing_previous")"
  if [ -z "$previous" ]; then
    rm -f "$marketing_root/current"
  else
    if ! [[ "$previous" =~ ^releases/[a-zA-Z0-9.-]+$ ]]; then
      echo "Invalid previous marketing release." >&2
      return 1
    fi
    test -f "$marketing_root/$previous/index.html"
    rm -f "$marketing_root/restore-next"
    ln -s "$previous" "$marketing_root/restore-next"
    mv -Tf "$marketing_root/restore-next" "$marketing_root/current"
  fi
}

marketing_publish() {
  local image="$1" tag
  tag="$(printf '%s' "$image" | sed -n 's/.*:ops-\([a-f0-9]\{12\}\)$/\1/p')"
  test -n "$tag"
  install -d -m 0755 "$marketing_root" "$marketing_root/releases"
  marketing_pending="$(mktemp -d "$marketing_root/releases/$tag.XXXXXX")"
  marketing_container="$(docker create --network none "$image")"
  docker cp "$marketing_container:/app/dist/marketing/." "$marketing_pending/"
  docker rm "$marketing_container" >/dev/null
  marketing_container=""
  test -s "$marketing_pending/index.html"
  test -s "$marketing_pending/version.json"
  test -s "$marketing_pending/assets/hero.webp"
  chmod -R a+rX "$marketing_pending"
  rm -f "$marketing_root/current-next"
  ln -s "releases/$(basename "$marketing_pending")" "$marketing_root/current-next"
  mv -Tf "$marketing_root/current-next" "$marketing_root/current"
  marketing_pending=""
}

marketing_verify() {
  # The opt-in marker is created only after separately authorized TLS bootstrap.
  if [ ! -f /opt/smedc/marketing-enabled ]; then return 0; fi
  curl -fsS --max-time 15 https://smedatacenter.xyz/version.json | cmp - "$marketing_root/current/version.json"
  curl -fsS --max-time 15 -o /dev/null https://smedatacenter.xyz/
  curl -fsS --max-time 15 -o /dev/null https://smedatacenter.xyz/assets/hero.webp
  local url destination status
  for url in http://smedatacenter.xyz/ http://www.smedatacenter.xyz/ https://www.smedatacenter.xyz/; do
    destination="$(curl -sS --max-time 15 -o /dev/null -w '%{redirect_url}' "$url")"
    test "$destination" = "https://smedatacenter.xyz/"
  done
  for url in https://smedatacenter.xyz/readyz https://smedatacenter.xyz/api/unknown; do
    status="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$url")"
    test "$status" = "404"
  done
}
`;
