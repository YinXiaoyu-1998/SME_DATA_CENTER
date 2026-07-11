# Phase 3 将 Qdrant 作为 baseline 依赖和 readiness gate

Phase 3 的证据检索路径包括 MD/TXT/DOCX 解析、切块、embedding、词法索引、Qdrant upsert、hybrid retrieval、rerank 和 MySQL 权限复核。若本地、CI 或 staging 只使用 mock，就无法证明核心检索闭环可用，也无法发现 collection schema、dense/sparse config、payload filter、stale payload、index version 和 upsert/search/delete 行为问题。

**Decision**: Qdrant 是 Phase 3 baseline 运行依赖。Local `docker compose` / MVP bootup 应包含真实 Qdrant。CI 可以分层：单元测试可 mock，但 merge-gating 集成测试必须使用真实 Qdrant 与真实 MySQL，模型 provider 默认可用 deterministic fake。Staging/prod-like 环境必须使用真实 Qdrant，并把 Qdrant connectivity、required collections、dense/sparse configuration、collection health、active retrieval config/index version、upsert/search/delete smoke 和 MySQL metadata/index consistency 纳入 readiness gate。

面向中国大陆/阿里云部署时，Phase 3 baseline 不假设 Qdrant Cloud 有中国大陆阿里云托管区域，也不把跨境托管 Qdrant 当作默认路径。默认方案是在阿里云基础设施上自托管 Qdrant，例如早期 staging 使用 ECS/docker compose，后续如部署模型需要可迁移到 ACK/Kubernetes。Qdrant Cloud、Hybrid Cloud 或 Private Cloud 只有在明确完成商务、区域、网络和数据驻留确认后才可作为替代路径。部署 runbook 还应包含 Qdrant 镜像 pinning，并把镜像同步到 approved Alibaba Cloud ACR 或内部制品仓库，避免 staging/prod 依赖实时拉取公网镜像。

Qdrant OSS 上游仓库标注 Apache-2.0 license，因此 baseline 自托管路径的主要成本不是 Qdrant Cloud 订阅费，而是我们自己的主机、磁盘、备份、监控、安全、升级、故障处理和容量规划。Qdrant Cloud 仍可理解为托管基础设施和托管运维/支持服务，不是 Phase 3 baseline 的运行许可依赖。

External embedding/rerank provider 在 local/CI 可使用 deterministic fake，避免强制真实 API key、费用和数据外发；但 staging preflight 或 manual/nightly smoke 可用合成文本验证真实 provider 的 key、timeout、rate limit、模型维度和 request shape。使用 fake provider 的环境不能被标记为 production-ready external-model operation。

**Considered Options**: 把 Qdrant 仅作为 P2/可选依赖；所有 CI 都只 mock Qdrant；CI 直接依赖共享 staging Qdrant；本地开发不启动 Qdrant；把外部模型 provider 作为所有 PR CI 的强制依赖；默认使用 Qdrant Cloud 跨境托管；等待 Qdrant 在阿里云中国大陆提供托管服务后再实施 Phase 3。

**Consequences**: Phase 3 本地和 CI 能覆盖真实 retrieval index 行为，staging go-live 前有明确依赖门禁，并且大陆部署不依赖未确认的跨境托管服务。代价是本地 compose、CI service container/testcontainer、collection 初始化、readiness 命令、自托管运维、镜像同步和 runbook 更复杂。Qdrant snapshot automation、restore drill、one-command rebuild、blue/green index promotion、operator UI、multi-node HA、cross-region DR 和 chaos testing 作为 P2/P3，除非实际生产规模提前要求。
