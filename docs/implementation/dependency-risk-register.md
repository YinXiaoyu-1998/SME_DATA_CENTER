# 当前依赖风险策略

## 质量门禁

质量工作流对生产 JavaScript 依赖执行 npm audit，对 API、worker、release-ops 镜像执行 Trivy OS 扫描。告警或扫描错误仍显示在日志和摘要中；质量工作流仅两个 audit 步骤允许失败，安装、构建、测试、类型、lint、格式仍阻断。

直接执行 `npm run audit:production` / `audit:report`、launcher 发布和 staging 部署继续使用各自已实现的风险门禁，不继承质量工作流的 continue-on-error 设置。判断阻断范围以当前 workflow/脚本为准。

## 当前例外

唯一机器权威是 [dependency-risk-acceptance.json](../../config/dependency-risk-acceptance.json)。当前 `exceptions` 和 `moderates` 均为空，没有有效的 ExcelJS 或 uuid 豁免；不得引用旧评审日期放行新扫描结果。

新增例外须明确 advisory/package/component、影响、缓解、负责人和到期/复核条件，并通过独立评审进入政策文件。风险状态会随扫描数据变化，本文件不承诺持续零漏洞。历史修复和扫描结论留在 progress 或发布记录。
