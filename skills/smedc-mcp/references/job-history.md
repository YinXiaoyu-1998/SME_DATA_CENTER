# Central Job History

Use the verified service and launcher exposing `query_jobs`. Look up an upload
or run through `query_jobs({query})` using the current authenticated account:

- `{mode: "receipt", enterpriseKey, receiptId}` locates the current uploader's receipt batch.
- `{mode: "detail", kind, id}` reads a row import, partition import, or workflow run.
- `{mode: "list", kind, enterpriseKey, limit: 100}` lists safe job summaries, including failed
  results. Pass `nextCursor` unchanged as `cursor` with the same filter to continue.
- `{mode: "action", workflowId, runId, actionId}` locates the Job linked to a workflow
  upload. Use `{mode: "actions", workflowId, runId, limit: 100}` to page through its links.

Kinds are `row_import`, `partition_import`, and `workflow_run`. Job summaries are
available through the original account or the current authorized workflow assignment, where applicable.
The enabled organization authorization model and current administrator are required.

Automated uploads pass the official `workflowAction` binding with the existing
`upload_structured_dataset` request. The companion owns lease and action handling.
Use the central association after a lost response. An accepted Job can still be queued,
processing or terminally failed. Use its real status when recording a workflow receipt.
For job metadata writes and closed-run corrections use the dedicated authorized management surface.
