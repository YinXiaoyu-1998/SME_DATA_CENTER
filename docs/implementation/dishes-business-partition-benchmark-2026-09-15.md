# Business/Dishes Partition Benchmark — 2026-09-15

## Purpose

Validate the hard-migrated `business` and `dishes` workflow at realistic scale through ordinary
macOS Codex requests and the official launcher, then identify where employees wait and where the
staging service spends resources. The agent uploaded original XLSX files without inspecting,
rewriting, or pre-splitting them. Controller access was used only for safe timing, size, health,
and cleanup evidence.

Environment:

- Staging release: `c6633d3505c3`
- Launcher: `enterprise-hub-mcp-launcher@0.4.0`
- Staging worker: 2 vCPU / 1 GiB container limit, `WORKER_CONCURRENCY=2`
- Synthetic employee: clearance 0 in `default-org`

## Upload Results

`Upload call` is the employee-visible MCP call from starting the multipart transfer until the
service accepted the completed source and returned a queued job. `Worker queue` starts after the
completed source was queued. `Worker` is the recorded processing-run duration. `End to end` runs
from job reservation at multipart start through atomic publication.

| Dataset  | Source MiB |    Rows | Partitions | Upload call | Upload MiB/s | Worker queue |   Worker | End to end | Canonical MiB |
| -------- | ---------: | ------: | ---------: | ----------: | -----------: | -----------: | -------: | ---------: | ------------: |
| business |      33.26 |  63,842 |        931 |      6.23 s |         5.34 |       0.35 s | 170.91 s |   177.04 s |         36.63 |
| business |      44.42 |  84,939 |      1,296 |      8.11 s |         5.48 |     163.14 s | 226.66 s |   397.66 s |         48.85 |
| business |     112.59 | 217,321 |      3,246 |     19.61 s |         5.74 |     370.19 s | 579.09 s |   968.48 s |        124.22 |
| dishes   |     191.21 | 944,940 |        810 |     33.38 s |         5.73 |       0.50 s | 817.92 s |   851.22 s |        320.52 |

The four source files total 381.49 MiB. Multipart transfer took 67.33 seconds in aggregate, a
weighted 5.67 MiB/s. Publication produced 6,283 current partition objects totaling 530.22 MiB.

The four uploads required only four upload calls, but the employee tasks issued 99 status calls
while waiting: 63 for the three business jobs and 36 for the dishes job, including one continuation
task for each group after the initial wait window. Individual status requests generally returned in
about 0.2 seconds, so this was not meaningful service compute load. It is meaningful Codex usage:
the current 15-second agent-driven polling loop repeatedly wakes the model to observe an unchanged
asynchronous job.

The 191.21 MiB dishes source is the clearest large-file result: the client transferred it in 33.38
seconds, while validation, million-row XLSX parsing, canonical CSV generation, sequential object
upload/verification, and atomic publication took another 817.92 seconds. It published after 851.22
seconds (14 minutes 11 seconds) end to end. The ordinary upload task's polling window ended shortly
before publication, and one subsequent natural-language status request confirmed success.

## Weekly Report Result

An independent Codex task received only this request: generate the `2025-09-07` through
`2025-09-13` report from Enterprise Hub data.

| Stage                                    | Result                                       |
| ---------------------------------------- | -------------------------------------------- |
| Coverage/discovery calls                 | 1 registry call + 3 coverage calls           |
| Partition-download calls                 | 2                                            |
| Prior-year business trend extract        | 602 files, 41,700 rows, 23.91 MiB, 3.56 s    |
| Current business trend/previous extract  | 1,008 files, 68,738 rows, 39.50 MiB, 5.42 s  |
| Total extract                            | 1,610 files, 110,438 rows, 63.42 MiB, 8.98 s |
| Local streaming aggregation              | 4.50 s                                       |
| HTML report rendering                    | 0.32 s                                       |
| Complete Codex task                      | 315.10 s                                     |
| Durable run directory / HTML             | 6.4 MiB / 929,800 bytes                      |
| Temporary launcher partition directories | Deleted by the report runner                 |

The report rendered correctly and reported 1.885 million CNY revenue, +5.47% week over week,
+17.82% year over year, 28,155 customers, four star stores, and one problem store. The product and
stall modules were honestly omitted: dishes coverage exists for the current and previous windows,
but there is no dish-catalog snapshot at or before the historical report date and no dishes
year-over-year coverage. Business trend charts used only the readable interval.

The report no longer pages tens of thousands of rows through model-visible structured queries. A
large 63.42 MiB / 1,610-file extract crossed the launcher boundary in two tool calls, then local
scripts streamed 110,438 rows. Agent call count and context size are therefore bounded by the
manifest rather than by raw row count.

## Bottlenecks And Blockers

1. **Deployment correctness blocker:** the first real uploads failed because the bind-mounted
   `/opt/enterprise-hub/partition-work` directory was root-owned. Provisioning had the correct
   owner, but ordinary deploys did not reassert it. The staging directory was repaired to
   `1000:1000` mode `0750`; the accompanying code change now does this on every rollout. Generic
   pre-parser partition failures also receive `PARTITION_IMPORT_FAILED` instead of the unrelated
   evidence-indexing code.
2. **Publication latency is the dominant employee wait:** network transfer is only 2–4% of the
   end-to-end time for the largest sources. The worker phase dominates.
3. **Burst uploads are effectively serialized:** although staging is configured with two worker
   lanes, both claim attempts can select the same oldest row. One conditional update wins and the
   other lane returns idle; the loop then waits for the winning long job before starting another
   claim cycle. The observed business queue exactly followed this serial shape.
4. **Partition-object amplification is material:** three business workbooks became 5,473 objects.
   The worker currently performs one awaited PUT and one awaited HEAD per partition. Long date
   windows therefore add thousands of serialized OSS round trips even when row parsing is modest.
5. **Model-driven polling amplifies Codex usage:** 99 cheap service reads caused many agent/tool
   cycles and status messages. Slow jobs need a launcher/server wait primitive, a background
   completion notification, or materially less frequent polling after the first minute.
6. **Memory and disk remained bounded in spot checks:** the largest observed worker RSS was about
   285 MiB during the 112.59 MiB business job; the dishes parse sample was about 191 MiB RSS. The
   largest observed scratch directory was about 244 MiB, with 29 GiB free on the host. These are
   samples, not instrumented peaks.

## Decision Guidance

The architecture is operationally viable for asynchronous ingestion and is substantially safer
for report generation than MySQL row paging. It is not yet a fast interactive upload workflow:
100–200 MiB sources should currently be described as roughly 10–16 minute processing jobs, plus
queue time during bursts.

Before increasing worker concurrency on this 2 vCPU host, fix claim contention and benchmark it.
Then add bounded per-job concurrency for partition PUT + verification (with atomic failure cleanup),
replace dense agent polling with an asynchronous wait/notification path, and record
parser/export/upload/publish phase timings in service metrics. Those changes target the measured
bottlenecks; raising model/tool-call limits would not.

## Follow-up Instrumentation

The 2026-09-16 follow-up adds one structured `partition_import_timing` log event per worker phase:
source download, XLSX/CSV export, partition upload plus verification, atomic database publication,
source cleanup, local work-directory cleanup, and total processing. Each event records start/end
timestamps, elapsed milliseconds, outcome, job and dataset identifiers, plus row/partition/canonical
byte counts where applicable. It deliberately excludes organization, enterprise, store, object-key,
and row data. A fresh large-file upload after deployment can therefore confirm how much of the
817.92-second dishes run belonged to parsing versus serialized OSS round trips.

The next profiling change splits `source_export` into preparation, workbook structure loading,
merged-cell scanning, row decoding, row routing, canonicalization, partition-file writes, and
finalization. A local pre-deployment run used the same 191.21 MiB dishes workbook as the staging
benchmark (944,940 rows, 810 partitions, 320.52 MiB canonical output):

| `source_export` subphase               |     Duration |    Share |
| -------------------------------------- | -----------: | -------: |
| Row decoding                           |     105.85 s |    50.9% |
| Merged-cell scan                       |      75.06 s |    36.1% |
| Partition-file writes                  |      16.71 s |     8.0% |
| Canonicalization                       |       7.96 s |     3.8% |
| Row routing                            |       2.44 s |     1.2% |
| Structure / preparation / finalization |       0.02 s |    <0.1% |
| **Total**                              | **208.03 s** | **100%** |

The local host is not latency-comparable with the 2 vCPU staging host, but the additive phase
shares identify the optimization target: the two XLSX passes consume about 87% of export time.
The worker emits these values as one aggregate `partition_export_profile` event after a successful
export, avoiding per-row log volume and excluding business data.

## Post-Optimization Staging Re-Benchmark — 2026-09-16

After PR #166 deployed as release `350357dc5559`, the same employee account re-uploaded the exact
191.21 MiB dishes workbook through launcher 0.4.0 with a new idempotency key. The job published
944,940 rows as the same 810 current partitions; post-publish coverage was unchanged.

| Phase                      |   Before |    After | Change                    |
| -------------------------- | -------: | -------: | ------------------------- |
| Client multipart upload    |  33.38 s |  43.15 s | +29.3%; network variance  |
| Source download            |   7.10 s |   7.07 s | -0.5%                     |
| `source_export`            | 763.56 s | 757.71 s | -0.8%                     |
| Partition PUT + HEAD       |  34.26 s |  12.13 s | **-64.6%; 2.82x faster**  |
| Atomic publish             |   6.38 s |   7.62 s | +19.4%; 1.24 s difference |
| Worker total               | 811.44 s | 784.67 s | -3.3%                     |
| Reservation to publication | 851.22 s | 827.92 s | -2.7%                     |

The bounded six-pipeline object transfer therefore removed 22.13 seconds from the measured
PUT/verification phase. End-to-end improvement was smaller because `source_export` still consumed
96.6% of worker time and this upload crossed the client/network boundary more slowly than the
earlier run.

The staging `source_export` profile was:

| Subphase                               |     Duration |    Share |
| -------------------------------------- | -----------: | -------: |
| Row decoding                           |     328.30 s |    43.3% |
| Merged-cell scan                       |     265.45 s |    35.0% |
| Partition-file writes                  |     117.82 s |    15.6% |
| Canonicalization                       |      31.56 s |     4.2% |
| Row routing                            |      14.50 s |     1.9% |
| Structure / preparation / finalization |       0.09 s |    <0.1% |
| **Total**                              | **757.71 s** | **100%** |

The bottleneck is now localized: row decoding plus the separate merged-cell pass consume 78.4% of
export time, while per-row partition writes are another 15.6%. The next implementation should
preserve streaming and bounded memory, first remove unnecessary per-row write syscalls with bounded
writer buffers, then evaluate skipping the merged-cell pre-scan only for the fixed Maijia partition
schemas with explicit regression evidence. This real workbook is not merge-free: its worksheet has
two structural merged ranges, `A1:AY1` and `A2:AY2`, above the canonical table header. Any bypass
must prove those metadata bands can be ignored without changing header resolution or row output;
it must not assume that the input contains no merged cells.

The fixed-source contract was subsequently clarified: Maijia `business` and `dishes` generators do
not merge canonical header or data cells; only presentation rows above the header may be merged, and
those rows are intentionally absent from canonical partition CSVs. The partition exporter now skips
the separate merged-cell pass for these two datasets while the generic XLSX reader retains expansion
support.

Release `0f18063c200b` was then measured on the same staging worker with the exact same 191.21 MiB
source (`e9199ff3…5039`), 944,940 rows, 810 partitions, and 336,088,756 canonical bytes. Job
`pjob_157c6056b67a75fdb70499b3` published successfully; readable coverage remained nine stores,
810 partitions, and 944,940 rows.

| Phase                      | With merge scan |  Scan bypass | Change                     |
| -------------------------- | --------------: | -----------: | -------------------------- |
| Client multipart upload    |         43.15 s |      41.07 s | -4.8%; network variance    |
| Source download            |          7.07 s |       7.10 s | +0.4%                      |
| `source_export`            |        757.71 s |     485.93 s | **-35.9%; 271.79 s saved** |
| Merged-cell scan           |        265.45 s |       0.00 s | **removed**                |
| Row decoding               |        328.30 s |     320.31 s | -2.4%                      |
| Partition-file writes      |        117.82 s |     119.08 s | +1.1%                      |
| Canonicalization           |         31.56 s |      31.96 s | +1.3%                      |
| Row routing                |         14.50 s |      14.49 s | unchanged                  |
| Partition PUT + HEAD       |         12.13 s |      12.20 s | +0.6%                      |
| Atomic publish             |          7.62 s |       7.84 s | +2.9%; 0.22 s difference   |
| **Worker total**           |    **784.67 s** | **513.20 s** | **-34.6%; 271.46 s saved** |
| Reservation to publication |        827.92 s |     553.82 s | **-33.1%; 274.10 s saved** |

The measured export improvement is 6.34 seconds greater than the removed 265.45-second pass,
which is explained by ordinary row-decode variance; every other phase remained close to its
baseline. The next material export targets are now row decoding (320.31 seconds, 65.9% of export)
and partition-file writes (119.08 seconds, 24.5%). Developer-workstation timings are intentionally
excluded from this comparison.

Employee guidance now treats a `business`/`dishes` source larger than 50 MiB as a long-running
partition job: the first status check is after two minutes, subsequent checks are two minutes apart,
unchanged states are not narrated, and the wait window is twenty minutes. This would reduce the
191.21 MiB benchmark from roughly 36 status checks to about eight while still observing its
14-minute publication in the original task.

## Cleanup Evidence

The pre-delete inventory matched the benchmark exactly: four partition jobs, four processing runs,
6,283 partition rows, and 6,283 OSS objects, with every other upload-domain category at zero. Exact
object deletion plus database cleanup completed in about 24 seconds. The storage client reported a
50-socket pool with 2,868 deletion requests temporarily queued; post-cleanup verification returned
zero for every database, OSS, and Qdrant category.

API and worker containers remained healthy, the server partition work directory was empty, and no
release-ops container remained. Launcher logout confirmed both remote session-family revocation and
local credential removal, after which the synthetic employee account and its one login identity
were hard-deleted. The durable HTML report and aggregate provenance remain local for human review;
raw launcher CSV extracts were deleted by the runner.
