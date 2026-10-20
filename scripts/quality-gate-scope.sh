#!/usr/bin/env bash
set -euo pipefail

# Main pushes and manual runs always retain the complete release gate.
if [[ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]]; then
  printf 'run_full=true\nrun_images=true\n'
  exit 0
fi

# Do not silently skip gates if either revision is missing or the diff fails.
: "${SMEDC_PR_BASE_SHA:?Missing PR base revision}"
: "${SMEDC_PR_HEAD_SHA:?Missing PR head revision}"
changed_files="$(mktemp)"
trap 'rm -f -- "$changed_files"' EXIT
git diff --name-only --no-renames -z "$SMEDC_PR_BASE_SHA...$SMEDC_PR_HEAD_SHA" > "$changed_files"

run_full=true
run_images=true
if [[ -s "$changed_files" ]]; then
  run_full=false
  run_images=false
  while IFS= read -r -d '' changed_path; do
    case "$changed_path" in
      docs/*|*.md) ;;
      *.test.ts|skills/*) run_full=true ;;
      *) run_full=true; run_images=true; break ;;
    esac
  done < "$changed_files"
fi
printf 'run_full=%s\nrun_images=%s\n' "$run_full" "$run_images"
