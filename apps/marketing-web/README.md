# 企业智脑 SMEDC 官网

中文静态介绍页，内容、图片与联系入口独立于业务服务。初始规格为 GitHub Issue #273。

从仓库根目录运行 `npm run build:marketing`，产物为 `dist/marketing`。本地可用 `python3 -m http.server 4173 --bind 127.0.0.1 --directory dist/marketing` 预览。核心流程测试：`npm test -- apps/marketing-web/src/site.test.ts scripts/staging-deploy-workflow.test.ts`。

- `src/index.html`：餐厅场景、真实脱敏周报、两种服务方式、四类日常工作、FAQ 与联系入口。无 JavaScript 时，所有业务说明可读，周报通过普通链接打开。
- `src/styles.css`：深墨色、纸白与砖红；系统宋体/黑体回退，手机布局和减少动态效果支持。
- `src/client.ts`：首屏入场、一次性滚动渐入、轻微视差、阅读进度、键盘可操作的工作切换、服务展开、周报阅读层和联系方式复制。减少动态效果时取消装饰动效。
- `public/assets/hero.webp`：2026-10-26 为用户选定视觉生成的餐馆场景；人物不是客户。周报缩略图来自脱敏报告的浏览器渲染；logo 沿用既有品牌资产。
- `public/samples/weekly-report.*`：用户提供并授权作为公开范例的周报，企业名、全部分店名及嵌入数据中的对应标识已匿名化；经营数字、期间与分析逻辑保留。原始未脱敏文件不得入库。HTML 保留生成格式，样式和执行脚本外置以适配 CSP。后续替换样例时须重新检查正文、嵌入数据和缩略图。

完整报告仅在点击后载入沙箱 iframe；关闭后返回原触发位置，也支持独立窗口。报告内的 Escape 通过限定消息来源的通信关闭阅读层。页面不采集访客信息，不发送业务请求；电话/邮件交给系统工具，点击不等同于已预约。

公开文案描述资料服务、业务 Skills 与可配置自动化组成的整体方案。访客可以自行使用熟悉的 Agent，或选择开发者托管和定制；此页面不实现业务分析或调度。

## 智能体安装示意

`animation/` 是 HyperFrames 合成源，包含 HTML、样式、GSAP 时间轴及局部视觉约定。构建时将同一份内容与本地 GSAP 3.14.2 / TextPlugin 合并进官网已有静态文件，并输出独立的 `dist/marketing-animation` 供 HyperFrames 编辑和验证；不增加公开路由或第三方运行时请求。GSAP 按其 [Standard License](https://gsap.com/standard-license/) 使用，构建保留库内许可头。

演示进入视口后播放一次，离开视口或页面隐藏时暂停，提供播放、重播和进度拖动。减少动态效果或 JavaScript 不可用时保留完整静态示意。复制按钮始终取完整安装请求；剪贴板失败时显示完整对话以便手动复制。演示不执行实际安装、连接或登录，具体客户端按官方 Skill 的当前说明完成配置，登录由用户确认。

修改后先运行 `npm run build:marketing`，再用 `npx hyperframes lint dist/marketing-animation` 和 `npx hyperframes check dist/marketing-animation` 检查。可在 `dist/marketing-animation` 目录运行 `npx hyperframes preview` 编辑时间轴。网页内的示意会随同一次构建更新。

## 交付与静态安全策略

静态文件随既有 release-ops 镜像交付。上线本版前须应用更新的 `deploy/staging/nginx-marketing.conf`：首页只允许同源 frame，只有公开周报允许同源嵌入，新增三个明确的样例路径和静态 SVG 路径；其他未知路径仍返回 404，未开放内联脚本、网络连接或业务服务代理。仅发布静态产物不会更新主机上已有的 nginx 配置。

部署与回滚入口见 [部署手册](../../docs/implementation/staging-deploy-runbook.md#企业智脑官网静态产物)。应用主机配置与发布仍需独立授权。

方向箭头和关闭图标来自 [Phosphor Icons](https://github.com/phosphor-icons/core)，使用 MIT 许可，原始许可保存在 `public/assets/phosphor-license.txt`。不从远端加载字体或运行时脚本。

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
