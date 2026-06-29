# 资料状态机与 Active 可见性

资料上传成功不等于资料可用。第一阶段资料状态按 `uploading -> pending_processing -> processing -> active | processing_failed -> archived` 理解，只有 `active` 资料进入普通查询、搜索和员工智能体检索；`processing_failed` 只对上传者和管理员可见。

**Considered Options**: 上传成功即活跃；上传后部分可见并提示索引处理中。

**Consequences**: 普通用户和员工智能体只看到已经处理完成的资料，系统避免“文件存在但内容不可检索”的中间态解释成本。
