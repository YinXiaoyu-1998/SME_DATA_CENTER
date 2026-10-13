# 资料状态机与 Active 可见性

> 历史记录：保留当时的决定、修订或验证证据，不表示当前运行状态，也不是执行授权。当前契约与操作入口见 [文档索引](../README.md)。旧文件名与版本仅为历史引用。

资料上传成功不等于资料可用。第一阶段资料状态按 `uploading -> pending_processing -> processing -> active | processing_failed -> archived` 理解，只有 `active` 资料进入普通查询、搜索和员工智能体检索；`processing_failed` 只对上传者和管理员可见。

**Considered Options**: 上传成功即活跃；上传后部分可见并提示索引处理中。

**Consequences**: 普通用户和员工智能体只看到已经处理完成的资料，系统避免“文件存在但内容不可检索”的中间态解释成本。
