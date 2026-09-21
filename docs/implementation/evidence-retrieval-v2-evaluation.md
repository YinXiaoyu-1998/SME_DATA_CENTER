# Evidence Retrieval V2 Evaluation

This document records the deliberately small before-and-after check approved for Evidence
Retrieval V2. Raw reports stay under `.data/evaluation/` during a run and are not committed.
Broader relevance tuning remains a QA follow-up rather than an implementation gate.

## V1 baseline

- Run label: `v1-baseline`
- Base commit: `69b11bdf73d7822416b66d8a990ea26b23b035a1`
- Retrieval config: `phase3.retrieval.v1`
- Embedding: `text-embedding-v4@phase3.retrieval.v1`
- Lexical index: `lexical.v1`
- Rerank: `qwen3.7-text-rerank@phase3.retrieval.v1` (`enabled`)
- Environment: disposable local MySQL and Qdrant with the configured real embedding and rerank
  providers; only the five committed Maijia fixtures were in the searched document scope.

| Metric                                    |     V1 |
| ----------------------------------------- | -----: |
| Hit rate at 5                             | 1.0000 |
| Recall at 10                              | 1.0000 |
| MRR at 10                                 | 1.0000 |
| Unacceptable returned case/document pairs |     20 |
| No-answer false-positive rate             | 1.0000 |
| Automatic download-link coverage          | 0.0000 |

The expected document ranked first for every answerable case, but the service filled the remainder
of each response with unrelated documents. The no-answer query returned four documents. The two
roujiamo queries show the clearest score break: the SOP scored `0.9231` / `0.9060`, while the next
document scored only `0.2668` / `0.2064`. V1 evidence search returned no automatic source links.

| Case                        | Ordered distinct fixture documents                                                             | Top rerank scores                      |
| --------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| `roujiamo-how-to`           | roujiamo-sop, store-opening, restaurant-operations, kitchen-production, front-of-house-service | 0.9231, 0.2668, 0.1984, 0.1880, 0.1599 |
| `roujiamo-steps`            | roujiamo-sop, restaurant-operations, kitchen-production, front-of-house-service, store-opening | 0.9060, 0.2064, 0.1678, 0.1561, 0.1499 |
| `kitchen-manager-duty`      | kitchen-production, restaurant-operations, store-opening, front-of-house-service               | 0.9642, 0.8599, 0.4305, 0.3618         |
| `front-of-house-flow`       | front-of-house-service, restaurant-operations, store-opening, kitchen-production               | 0.8968, 0.7399, 0.3926, 0.3280         |
| `store-opening-preparation` | store-opening, restaurant-operations, kitchen-production, front-of-house-service               | 0.9561, 0.7912, 0.7579, 0.5669         |
| `unanswered-expense-policy` | restaurant-operations, store-opening, front-of-house-service, kitchen-production               | 0.6365, 0.3248, 0.1797, 0.1532         |

## V2 comparison

- Run label: `v2-bm25`
- Base commit: `5298a821eb48dabe2ff832caae433d7f52472b51`
- Retrieval config: `phase3.retrieval.v2-bm25`
- Embedding: `text-embedding-v4@phase3.retrieval.v2-bm25`
- Lexical index: `lexical.bm25.v1@phase3.retrieval.v2-bm25`
- Rerank: `qwen3.7-text-rerank@phase3.retrieval.v2-bm25` (`enabled`)
- Relevance policy: `relevance.v1@phase3.retrieval.v2-bm25`; minimum score `0.30`,
  minimum gap `0.30`, lower-cluster maximum `0.40`
- Environment: disposable local MySQL and Qdrant 1.19.1 with the same configured real embedding
  and rerank providers and the same five-fixture document scope as V1.

The approved single V2 run produced this comparison; no parameters were tuned and the evaluator
was not rerun afterward.

| Metric                                    |     V1 |     V2 | Result                   |
| ----------------------------------------- | -----: | -----: | ------------------------ |
| Hit rate at 5                             | 1.0000 | 1.0000 | unchanged                |
| Recall at 10                              | 1.0000 | 1.0000 | unchanged                |
| MRR at 10                                 | 1.0000 | 1.0000 | unchanged                |
| Unacceptable returned case/document pairs |     20 |      9 | 11 fewer (`-55%`)        |
| No-answer false-positive rate             | 1.0000 | 1.0000 | still needs QA follow-up |
| Automatic download-link coverage          | 0.0000 | 1.0000 | complete                 |

The reported download coverage is calculated per returned result; the HTTP response additionally
deduplicated source issuance to exactly one available `sources[]` entry per distinct document on
each page. No source warning occurred.

| Case                        | Ordered distinct fixture documents                                               | Top rerank scores              |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| `roujiamo-how-to`           | roujiamo-sop                                                                     | 0.9231                         |
| `roujiamo-steps`            | roujiamo-sop                                                                     | 0.9060                         |
| `kitchen-manager-duty`      | kitchen-production, restaurant-operations, store-opening, front-of-house-service | 0.9642, 0.8599, 0.4305, 0.3618 |
| `front-of-house-flow`       | front-of-house-service, restaurant-operations, store-opening, kitchen-production | 0.8968, 0.7399, 0.3926, 0.3280 |
| `store-opening-preparation` | store-opening, restaurant-operations, kitchen-production, front-of-house-service | 0.9561, 0.7912, 0.7579, 0.5669 |
| `unanswered-expense-policy` | restaurant-operations                                                            | 0.6365                         |

The principal regression is fixed: both roujiamo questions now return only the SOP, so restaurant
operations and the other unrelated manuals no longer appear. Broader policy/manual queries still
retain some judged-unacceptable documents whose rerank scores exceed the configured floor, and the
no-answer expense-policy query still returns restaurant operations at `0.6365`. This is recorded as
the known QA follow-up rather than triggering another tuning loop.
