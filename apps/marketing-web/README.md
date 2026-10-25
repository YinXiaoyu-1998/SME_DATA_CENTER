# 企业智脑 SMEDC 官网

中文静态介绍页，内容、图片与联系入口独立于业务服务。规格为 GitHub Issue #273。

从仓库根目录运行 `npm run build:marketing`，产物为 `dist/marketing`。本地可用 `python3 -m http.server 4173 --bind 127.0.0.1 --directory dist/marketing` 预览。核心联系流程测试：`npm test -- apps/marketing-web/src/site.test.ts`。

- `src/index.html`：八段内容、语义化导航/FAQ、电话与邮件入口；无 JavaScript 仍可使用。
- `src/styles.css`：暖米白、深海蓝与青绿的响应式排版，系统宋体/黑体回退。
- `src/client.ts`：渐进增强的联系方式复制与失败提示，不发送网络请求。
- `public/assets`：2026-10-25 为已批准“门店日常”视觉方案生成的摄影和合成成果；logo 为用户提供海马标志的透明化重制，品牌文字使用 HTML。图中人物不是客户，成果不是实际业务记录。

公开文案描述资料服务、业务 Skills 与计划工作组成的整体方案；此页面不实现业务分析或调度。电话/邮件交给系统工具处理，点击不等同于已预约。

静态文件随现有 release-ops 镜像交付，初次 HTTPS 启用须单独授权；执行与回滚入口见 [部署手册](../../docs/implementation/staging-deploy-runbook.md#企业智脑官网静态产物)。不要将凭据、客户资料或私有文件放进公开目录。
