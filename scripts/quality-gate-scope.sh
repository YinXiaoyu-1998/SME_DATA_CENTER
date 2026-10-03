#!/usr/bin/env bash
set -euo pipefail

# Main pushes and manual runs always retain the complete release gate.
if [[ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]]; then
  echo 'run_full=true'
  exit 0
fi

# Do not silently skip gates if either revision is missing or the diff fails.
: "${SMEDC_PR_BASE_SHA:?Missing PR base revision}"
: "${SMEDC_PR_HEAD_SHA:?Missing PR head revision}"
changed_files="$(mktemp)"
trap 'rm -f -- "$changed_files"' EXIT
git diff --name-only --no-renames -z "$SMEDC_PR_BASE_SHA...$SMEDC_PR_HEAD_SHA" > "$changed_files"

run_full=true
if [[ -s "$changed_files" ]]; then
  run_full=false
  while IFS= read -r -d '' changed_path; do
    case "$changed_path" in
      docs/*|*.md) ;;
      *) run_full=true; break ;;
    esac
  done < "$changed_files"
fi
echo "run_full=$run_full"
