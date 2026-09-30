# Shared by rollout EXIT recovery and explicit/post-verification rollback.
# Caller holds deploy.lock. Only immutable IDs are probed, never host Prisma.
pdf_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
pdf_tool() {
  docker run --rm --network host --read-only --user 0 --env-file "$runtime_file" \
    -v /opt/smedc/pdf-runtime:/state --entrypoint node "$pdf_guard_image" \
    dist/release/pdf-release.js "$@" </dev/null
}
pdf_reader_proof() {
  local image="$1" id capability
  docker pull "$image" >&2 || return 1
  id="$(docker image inspect --format '{{.Id}}' "$image")" || return 1
  capability="$(docker run --rm --network none --read-only --entrypoint node "$id" \
    -e 'let marker;try{marker=JSON.parse(require("fs").readFileSync("/app/pdf-runtime-capabilities.json","utf8"))}catch{};process.stdout.write(JSON.stringify(require("@prisma/client").FileType?.pdf === "pdf" && marker?.schemaVersion === 1 && marker.pdfReader === true && marker.pdfWorkerScope === true))' </dev/null)" || return 1
  case "$capability" in true|false) ;; *) echo "Invalid PDF reader probe" >&2; return 1 ;; esac
  node -e 'process.stdout.write(JSON.stringify({image:process.argv[1],id:process.argv[2],pdfReader:JSON.parse(process.argv[3])}))' "$image" "$id" "$capability"
}
pdf_bundle() {
  local api="$1" worker="$2" ops="$3" parser="$4" processing="$5" uploads="$6"
  local api_proof worker_proof ops_proof parser_proof=null parser_id fingerprint
  api_proof="$(pdf_reader_proof "$api")" || return 1
  worker_proof="$(pdf_reader_proof "$worker")" || return 1
  ops_proof="$(pdf_reader_proof "$ops")" || return 1
  if [ -n "$parser" ]; then
    docker pull "$parser" >&2 || return 1
    parser_id="$(docker image inspect --format '{{.Id}}' "$parser")" || return 1
    fingerprint="$(docker run --rm --network none --read-only --memory 512m --entrypoint python "$parser_id" -c 'import hashlib,json,importlib.resources; m=json.loads(importlib.resources.files("smedc_pdf_parser").joinpath("model-manifest.json").read_text()); assert m["adapterVersion"]=="0.1.3"; print(hashlib.sha256(json.dumps(m,sort_keys=True,separators=(",",":")).encode()).hexdigest())' </dev/null)" || return 1
    parser_proof="$(node -e 'process.stdout.write(JSON.stringify({image:process.argv[1],id:process.argv[2],parserFingerprint:process.argv[3],schemaVersion:1}))' "$parser" "$parser_id" "$fingerprint")" || return 1
  fi
  node -e 'const [api,worker,releaseOps,parser,pdfProcessing,uploads]=process.argv.slice(1).map(JSON.parse);process.stdout.write(JSON.stringify({api,worker,releaseOps,parser,pdfProcessing,uploads}))' \
    "$api_proof" "$worker_proof" "$ops_proof" "$parser_proof" "$processing" "$uploads"
}
pdf_update_runtime() {
  local api="$1" worker="$2" ops="$3" parser="$4" processing="$5" uploads="$6" temporary
  temporary="$(mktemp "${runtime_file}.XXXXXX")"
  awk '!/^SMEDC_(API_IMAGE|WORKER_IMAGE|RELEASE_OPS_IMAGE|PDF_PARSER_IMAGE|PDF_PROCESSING_ENABLED|PDF_UPLOAD_ENABLED)=/' "$runtime_file" > "$temporary"
  printf 'SMEDC_API_IMAGE=%s\nSMEDC_WORKER_IMAGE=%s\nSMEDC_RELEASE_OPS_IMAGE=%s\nSMEDC_PDF_PARSER_IMAGE=%s\nSMEDC_PDF_PROCESSING_ENABLED=%s\nSMEDC_PDF_UPLOAD_ENABLED=%s\n' \
    "$api" "$worker" "$ops" "$parser" "$processing" "$uploads" >> "$temporary"
  install -o root -g root -m 0600 "$temporary" "$runtime_file"
  rm -f "$temporary"
}
pdf_stop_consumer() {
  local services
  services="$(compose --profile pdf config --services)" || return 1
  case "$services" in *pdf-worker*) compose --profile pdf stop pdf-worker ;; esac
}
pdf_require_budget() {
  if [ "$1" = true ]; then
    test "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -ge 12582912 || return 1
    test "$(getconf _NPROCESSORS_ONLN)" -ge 4 || return 1
    test "$(pdf_value "$runtime_file" SMEDC_PDF_SERVICE_TOKEN | wc -c)" -ge 33 || return 1
  fi
}
pdf_stop_parser() {
  local services
  services="$(compose --profile pdf config --services)" || return 1
  case "$services" in *pdf-parser*) compose --profile pdf stop pdf-parser ;; esac
}
pdf_restore_previous() {
  local api worker ops parser processing uploads proof
  api="$(pdf_value "$previous_file" SMEDC_API_IMAGE)"
  worker="$(pdf_value "$previous_file" SMEDC_WORKER_IMAGE)"
  ops="$(pdf_value "$previous_file" SMEDC_RELEASE_OPS_IMAGE)"
  parser="$(pdf_value "$previous_file" SMEDC_PDF_PARSER_IMAGE)"
  processing="$(pdf_value "$previous_file" SMEDC_PDF_PROCESSING_ENABLED)"; processing="${processing:-false}"
  uploads="$(pdf_value "$previous_file" SMEDC_PDF_UPLOAD_ENABLED)"; uploads="${uploads:-false}"
  test -n "$api" && test -n "$worker" && test -n "$ops" || return 1
  proof="$(pdf_bundle "$api" "$worker" "$ops" "$parser" "$processing" "$uploads")" || return 1
  # Check the sticky floor BEFORE stopping services, touching jobs or image state.
  pdf_tool check /state/state.json "$proof" || return 1
  pdf_require_budget "$processing" || return 1
  pdf_stop_consumer || return 1
  if [ "$processing" != true ] && [ "$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).api.pdfReader))' "$proof")" = true ]; then
    pdf_tool park /state || return 1
  fi
  if [ "$processing" != true ]; then pdf_stop_parser || return 1
  fi
  pdf_tool transition /state/state.json "$proof" "$proof" || return 1
  if [ -f "$previous_compose" ]; then install -o root -g root -m 0644 "$previous_compose" "$compose_file" || return 1; fi
  pdf_update_runtime "$api" "$worker" "$ops" "$parser" "$processing" "$uploads" || return 1
  compose pull api worker || return 1
  if [ "$processing" = true ]; then
    compose --profile pdf up -d pdf-parser || return 1
    compose --profile release run -T --rm release-ops node dist/release/readiness.js pdf-parser </dev/null || return 1
    pdf_tool restore /state || return 1
    compose --profile pdf up -d pdf-worker || return 1
  fi
  compose up -d api worker || return 1
  cp "$previous_file" /opt/smedc/current-release.env || return 1
}
