# 企业智脑 SMEDC 官网

中文静态介绍页，内容、图片与联系入口独立于业务服务。规格为 GitHub Issue #273。

从仓库根目录运行 `npm run build:marketing`，产物为 `dist/marketing`。本地可用 `python3 -m http.server 4173 --bind 127.0.0.1 --directory dist/marketing` 预览。核心联系流程测试：`npm test -- apps/marketing-web/src/site.test.ts`。

- `src/index.html`：九段内容（含通用智能体接入）、语义化导航/FAQ、电话与邮件入口；无 JavaScript 仍可使用。
- `src/styles.css`：暖米白、深海蓝与青绿的响应式排版，系统宋体/黑体回退。
- `src/client.ts`：渐进增强的联系方式复制与失败提示，不发送网络请求。
- `public/assets`：2026-10-25 为已批准“门店日常”视觉方案生成的摄影和合成成果；logo 为用户提供海马标志的透明化重制，品牌文字使用 HTML。图中人物不是客户，成果不是实际业务记录。

公开文案描述资料服务、业务 Skills 与计划工作组成的整体方案；此页面不实现业务分析或调度。电话/邮件交给系统工具处理，点击不等同于已预约。

静态文件随现有 release-ops 镜像交付，初次 HTTPS 启用须单独授权；执行与回滚入口见 [部署手册](../../docs/implementation/staging-deploy-runbook.md#企业智脑官网静态产物)。不要将凭据、客户资料或私有文件放进公开目录。

## 应用标识来源

接入章节的应用标识仅作产品识别，不表示联合品牌或官方合作。2026-10-26 获取并本地托管，保持原标识外观；SVG 转 PNG 或等比例缩小，TRAE 保留原 PNG。标识权利归各品牌所有。

| 本地文件                | 官方来源                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-workbuddy.png`   | [WorkBuddy 官网](https://www.workbuddy.cn/)引用的[图标](https://assets.workbuddy.cn/web/workbuddy/a5b2fb510f0e7b156f19d072fae0cd12ae1f2f19/assets/logo.svg)        |
| `agent-trae.png`        | [TRAE 官网](https://www.trae.cn/)引用的[图标](https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae_website_prod_cn/favicon.png)                                         |
| `agent-doubao-work.png` | [豆包工作官网](https://www.doubao.com/work)引用的[图标](https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/doubaowork-logo-f.png)；“豆包办公”为用户常用称呼 |
| `agent-qoder.png`       | [Qoder 官网](https://qoder.com/)引用的[图标](https://img.alicdn.com/imgextra/i4/O1CN01QkSxiCocd3D0prc8_!!6000000008124-2-tps-412-412.png)                          |
| `agent-codex.png`       | [Codex](https://openai.com/codex/) 官方 macOS 客户端 26.1021.31345 的 `Contents/Resources/icon-codex-light.png`                                                    |

接入文案不等于各客户端已经完成登录到业务工具的完整验收；实际适配沿用官方 launcher 的客户端能力核对、配置与试运行边界，不在本页面改动中变更协议或客户端支持矩阵。
