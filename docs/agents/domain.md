# Domain docs

## Layout: single-context

[CONTEXT.md](../../CONTEXT.md) 是全仓唯一领域术语入口。技能提及 `GLOSSARY.md` 或 `GLOSSARY-MAP.md` 时，读取该文件；沿用现有单一领域上下文，不另建重复词汇表。

## Read before use

- 写规格或命名领域对象前，先读 `CONTEXT.md`，沿用其术语和普通读取/管理操作边界。
- 现行行为与契约从 [docs/README.md](../README.md) 进入；按任务读取对应规则及所在作用域的 `AGENTS.md`。
- 涉及架构决策时，先读 [docs/adr/README.md](../adr/README.md)，再读相关 ADR。当前 ADR 均保留历史背景，已被取代的规则以索引指向的现行文档为准。
- 遇到真正未被现行文档解决的决策冲突，应明确提出；新决定记录于对应权威文档，避免追加相反规则或复制平行规范。

本配置只说明领域文档的读取方式；根目录和各作用域 `AGENTS.md` 继续管理项目工作规则。
