# 行迹 · 定制旅游规划平台

用户输入旅行需求 → 大模型生成 3 个差异化定制方案 → 用户挑选 → 再调用大模型优化成完整旅游指南（详细逐日行程 + 地点图文卡 + 高德 / Google Maps 定位）→ 导出单文件图文 HTML。支持自定义大模型端点与三种主流协议，登录后保留会话记录与文件生成记录。

本期范围：**HTML 导出**（模板带打印样式，可用浏览器「另存为 PDF」）、**邮箱直注登录**（微信登录仅预留接入点）。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | React 18 + Vite 6 + TypeScript | 无路由库，页面按视图状态切换 |
| 后端 | Express 4 + TypeScript（tsx 运行） | 统一 8888 端口提供页面与 API |
| 数据库 | SQLite（better-sqlite3） | 单机零配置，后续可平滑迁 PostgreSQL |
| 校验 | zod | 前后端共享 `shared/types.ts` 的结构化 schema |
| 安全 | node:crypto | scrypt 密码哈希、AES-256-GCM 加密 API Key、服务端会话 |

## 快速开始

**一键启动（本地与服务器通用）**

```bash
cd travel-planner
./start.sh
```

`start.sh` 依次完成：检查 Node 20+ → 首次运行生成含固定密钥的 `.env` → 安装依赖 → 类型检查 + 构建前端 → 在 8888 端口启动。前端构建产物与 API 由**同一个 Express 进程**提供，所以一条命令即可把前后端都起来：

- 页面 http://localhost:8888 ／ 健康检查 http://localhost:8888/api/health
- 已有 `web-dist` 时可 `./start.sh --skip-build` 跳过构建；`Ctrl+C` 停止
- 服务器上交给 systemd 守护并开机自启：`sudo systemctl start travel-planner`（见「部署」章节）

**本地开发模式（需要前端热更新时）**

```bash
npm install
npm run dev            # 一条命令同时启动 API(8888) 与 Vite(5173)
```

开发模式：前端 http://localhost:5173，API http://127.0.0.1:8888（Vite 已配置 `/api` 代理）。**页面和 API 必须同时启动**：只跑 `npm run dev:web` 会出现「页面能打开，但注册报后端未启动」；只跑 `npm run dev:server` 则 5173 打不开。先用 `curl http://127.0.0.1:8888/api/health` 确认 API 返回 `{"ok":true,...}`。

> 当前本地目录已生成好 `.env`（含固定密钥）。`start.sh` 生成的 `.env` 默认 `HOST=0.0.0.0` 便于服务器访问，纯本地调试可改成 `127.0.0.1`；该文件不要提交到仓库。

> **更换 `APP_ENCRYPTION_KEY` 后，之前加密保存的 API Key 将无法解密**，需要到「模型设置」重新填写。密钥请长期保持稳定，且不要提交到仓库。

## 模型配置

### 系统内置默认模型（开箱即用）

服务端 `.env` 配好以下变量后，**用户注册后不需要添加任何配置、也不用选模型**，打开「行程规划」直接输入需求即可生成：

| 变量 | 说明 |
|---|---|
| `DEFAULT_LLM_BASE_URL` | 阿里云百炼 OpenAI 兼容端点，如 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `DEFAULT_LLM_API_KEY` | API Key，只存 `.env`，不落库、不回显、不参与发布同步 |
| `DEFAULT_LLM_MODEL` | 默认模型 ID，如 `qwen-plus` |
| `DEFAULT_LLM_PROTOCOL` | 默认 `chat_completions` |

- 该配置以虚拟 ID `__default__` 出现在配置列表末尾：没有自建配置时自动选中它；用户一旦新增自己的配置，优先用自己的。
- 它的模型列表**只返回预置的那一个模型**，不会拉百炼 `/models` 的上百个平台模型目录，避免误选未开通模型触发 `product is not activated`。
- 系统默认项在「模型设置」里只读，接口同样拒绝编辑与删除。
- 留空 `DEFAULT_LLM_API_KEY` 即关闭内置默认模型，平台回到「必须自行新增配置」的行为。
- 更换 Key 只需改服务器 `.env` 后 `sudo systemctl restart travel-planner`。

在「模型设置」新增配置，三种协议按需选择：

| 协议 | 请求路径 | baseUrl 示例 | 鉴权 |
|---|---|---|---|
| OpenAI Chat Completions | `/chat/completions` | `https://api.openai.com/v1` | Bearer |
| OpenAI Responses | `/responses` | `https://api.openai.com/v1` | Bearer |
| Anthropic Messages | `/messages` | `https://api.anthropic.com/v1` | `x-api-key` + `anthropic-version` |

- baseUrl 填到**版本前缀**即可；粘贴完整端点（如 `.../v1/chat/completions`）会自动归一化。
- 「获取模型列表」调用 `/models`；中转端点若不支持会明确提示并切换为**手动填写模型名**，不会静默返回空列表。
- 「行程规划」页每次可重新选择模型，配置里的默认模型只是初始值。
- API Key 加密落库，接口永不回显明文；编辑时留空表示沿用旧密钥。

## 主要接口

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/register` `/login` `/logout` | 邮箱直注 / 登录 / 退出 |
| GET | `/api/auth/me` `/sessions` | 当前用户、会话记录 |
| GET | `/api/auth/wechat/status` `/redirect` `/callback` | 微信登录状态与接入点（未启用返回 501） |
| GET/POST/PUT/DELETE | `/api/configs` | 模型配置增删改查 |
| GET | `/api/configs/:id/models` | 模型列表（含降级原因） |
| POST | `/api/configs/:id/test` | 连通性测试 |
| POST | `/api/plans` | 需求 → 定制方案（同步 JSON） |
| POST | `/api/plans/stream` | 同上，但返回 SSE 实时事件流 |
| POST | `/api/plans/:id/select` | 保存用户选择 |
| POST | `/api/plans/:id/guide` | 生成完整指南（同步 JSON） |
| POST | `/api/plans/:id/guide/stream` | 同上，分块生成 + SSE 实时事件流 |
| POST | `/api/plans/:id/export` | 导出 HTML 并写文件记录 |
| GET | `/api/plans` `/api/files` | 规划与文件历史 |
| GET | `/api/files/:id/download` | 下载 HTML |
| GET | `/api/evidence/sources` | 数据源状态、留存条款、出网提示与 CSV 模板 |
| GET/POST/DELETE | `/api/evidence` | 证据列表 / 手动录入 / 删除 |
| POST | `/api/evidence/import` | CSV 批量导入 |
| GET | `/api/evidence/matrix?pois=a,b` | 只读对比矩阵，不触发外部请求 |
| GET | `/api/evidence/xhs/status` | 独立笔记检索通道状态（只查本机 /health） |
| GET | `/api/evidence/xhs/search?keyword=&limit=` | 关键词检索笔记；未启用/熔断时返回官方搜索深链 |
| POST | `/api/xhs-research/queries` | 需求拆四类小红书检索词（实采工作流） |
| GET | `/api/xhs-research` | 实采线索列表 |
| POST | `/api/xhs-research/import` | 导入扩展采集 JSON（强制登录凭证） |
| DELETE | `/api/xhs-research` `/api/xhs-research/:id` | 清空 / 删除单条实采线索 |

数据表：`users` / `sessions` / `llm_configs` / `plans`（含 `evidence_json`、`geo_json`、`research_json`）/ `generated_files` / `login_attempts` / `evidence_items` / `xhs_research`。

## 第三方口碑证据层

生成候选方案时，模型额外输出方案涉及的具体地点（`places`）；后端拿这些地点核对第三方评分，把结果作为**证据**注入指南生成的提示词，并在页面与导出的 HTML 里形成多源对比矩阵。AI 只做基于证据的归纳，不再凭空生成评分。

**合规边界**：主服务不实现任何绕过反爬的措施——不破解验证码、不逆向签名、不伪装浏览器指纹、不用代理池规避封锁。除下方「小红书笔记检索」外，所有证据通道都是官方授权 API / 开放数据 / 用户录入 / 回源深链；那个检索通道是**独立、默认关闭、仅本机**的可选进程，主服务只调它的 HTTP 接口，见下一节。除了合规（Google Maps Platform ToS 3.2.3 "No Scraping"、Tripadvisor 主协议禁止 robot/spider、小红书开放平台禁止高频批量抓取、国内已有突破反爬被认定不正当竞争的判赔报道），还有工程现实：页面改版即中断、评分口径不一致，而且就算取到了，条款也普遍禁止存储或再展示。

有效的处理方式是**让业务不依赖任何单一不可控来源**：

| 层级 | 通道 | 留存策略 |
|---|---|---|
| L0 | 官方授权 API / 合规网关（配置 `EVIDENCE_<源>_ENABLED` 与 `_URL` 才启用） | `none`，实时取用不落库 |
| L1 | 开放数据集（OSM / Overture / FSQ OS Places / 文旅开放数据） | `persistent`，可长期保存，须保留来源 |
| L2 | 手动录入 / CSV 导入 | `persistent`，标为低可信 |
| L3 | 回源深链（各平台搜索页） | 不取数据，只给跳转入口 |

- 撞到 `403` / `429` / 风控页面：**熔断 5 分钟，不重试**；SSE 明确推送降级原因，页面标「已熔断」，证据包的 `degraded` 与提示词会持续带上该源，避免模型假设它有数据。
- 缓存按条款分级：Google Places 只允许永久存 `place_id`（坐标 30 天），其余字段不可缓存；Tripadvisor Terra 禁止缓存内容；高德/百度协议禁止存储服务内部数据。因此所有官方 API 数据一律不落库。
- 评分归一化到 0–5 但保留原始值与满分；**不算跨平台平均分**（口径不同），缺失显示「—」，并列出未获取的源。
- 提示词硬约束：只能引用给定证据，禁止编造评分、星级或「网友评价」，引用必须带来源与获取日期，分歧要提示回源核实。
- 导出的 HTML 增加「第三方口碑与数据来源」表格与回源链接，打印时保留。

**接入一个官方源**（取得授权后改服务器 `.env` 并重启，无需重新发版）：

```bash
EVIDENCE_AMAP_ENABLED=1
EVIDENCE_AMAP_URL=https://your-compliant-gateway/places?name={name}&city={city}
EVIDENCE_AMAP_KEY=your-key
```

`{name}` / `{city}` 会被替换，`_KEY` 可选并作为 Bearer 发送。网关负责把各家专有响应归一化成 `{ items: [{ rating, ratingScale, reviewCount, url, snippet }] }`（也接受顶层数组或 `data` / `results` / `places`）——这样不必把未经验证的各家 API 结构写死在代码里。`.env.example` 列出了 5 个官方源的变量名。

**出网通道**：实测上海 Lighthouse 实例 DNS 可解析但 TCP 连不通 `places.googleapis.com` / `maps.googleapis.com`，`www.tripadvisor.com` 返回 403；`open.xiaohongshu.com`、`www.mafengwo.cn` 可达。海外源因此默认禁用。若部署方已有**企业合规跨境通道或自有节点**，在 `.env` 填 `HTTPS_PROXY=...`，`start.sh` 会自动打开 `NODE_USE_ENV_PROXY=1`（Node 22.21+ 内置 fetch 读取代理环境变量）；也可直接把 `_URL` 指向可达的网关。不要在服务器上安装来源不明的第三方代理：它会接管全部出站流量（含模型密钥与数据库）。

前端「口碑数据」页可查看 7 个源的状态与留存条款、手动录入、CSV 批量导入、预览对比矩阵、删除记录。CSV 列名：`poiName,source,rating,ratingRaw,ratingScale,reviewCount,url,snippet`。

## 小红书笔记检索（独立研究通道，默认关闭）

用户提出参考 [Spider_XHS](https://github.com/cv-cat/Spider_XHS) 接入「搜索查询笔记」。上游的实际情况需要先说清楚：

- README 自述「**仅供学习交流使用，禁止任何商业化行为**」，仓库**没有 LICENSE**；
- 它靠本地纯算 `x-s / x-t / x-rap-param` 等签名模拟浏览器请求，属于绕过平台接口鉴权，且必须使用你本人账号的完整 Cookie（含 `web_session`）；
- 因此**不集成进主服务、不复制上游代码、不把 Cookie 带进发布包、不默认启用**。`deploy.sh` 只同步 `tools/xhs-notes/` 下的几个脚本与配置模板，服务器上不会自动安装依赖或启动进程；线上默认仍是官方搜索深链。

```
[口碑数据页] → Node 主服务(8888) → 仅本机 127.0.0.1:8901 → Python sidecar → Spider_XHS → 小红书
                    ↑ XHS_NOTES_ENABLED=0 时整条链路断开，不发任何第三方请求
```

**职责切分**：sidecar 只调 `search_some_note()`，回传笔记标题 / 作者 / 点赞收藏评论数 / 类型 / 回源链接；不取正文、图片、视频、评论，不落盘、不写日志原文。主服务只做 token 鉴权、超时、结构校验、链接域名白名单与熔断降级。检索结果**只在「口碑数据」页展示，不落库、不注入模型提示词、不写入导出 HTML，也不产生任何评分**；页面「存为线索」只保存标题与链接（`origin=manual`、低可信、无评分）。

**启用步骤**（仅个人学习研究；对外或商业场景请用平台官方授权接口）：

```bash
cd tools/xhs-notes
./bootstrap.sh          # 克隆上游到 ~/.cache/spider-xhs，建 venv 并安装 Python / Node 依赖
cp xhs.env.example ~/.travel-planner-xhs.env
chmod 600 ~/.travel-planner-xhs.env
# 填入 XHS_COOKIE（你本人账号的完整 Cookie）与 XHS_SIDECAR_TOKEN
./start.sh              # 仅监听 127.0.0.1:8901
```

主服务 `.env` 增加三行后 `sudo systemctl restart travel-planner`：

```bash
XHS_NOTES_ENABLED=1
XHS_NOTES_URL=http://127.0.0.1:8901
XHS_NOTES_TOKEN=<与 sidecar 完全相同的 token>
```

**安全与频率**：Cookie / token 只存 `~/.travel-planner-xhs.env`（项目目录之外；`deploy.sh` 已排除任意子目录 `.env` 与 sidecar 依赖目录）。sidecar 强制 token、全局串行、默认两次检索间隔 ≥3 秒、单次 ≤20 条；撞到 403 / 429 / 验证码 / 登录失效即熔断 5 分钟，主服务降级为官方搜索入口，不重试、不换身份。`start.sh` 已把 `127.0.0.1,localhost` 加入 `NO_PROXY`，避免启用出网代理时本机请求被绕道。

**自检与故障**：`<venv>/bin/python tools/xhs-notes/xhs_sidecar.py --check` 只检查依赖与配置、不发外部请求；`/health` 同样不发外部请求，未配置 Cookie 会明确返回「未就绪」而不是伪造结果。Cookie 有时效，失效后重新获取；上游改版可能导致签名算法失效，此时应停止使用，不要反复重试。

**合规责任**：启用该通道由部署者自行判断用途、账号授权与平台条款；主服务不提供任何规避风控的能力，也不对上游代码的可用性与合法性作背书。正式场景请改用小红书开放平台或取得书面授权的合规网关，接回现有 `EVIDENCE_XHS_ENABLED` / `_URL` 通道即可，无需改业务代码。

## 小红书浏览器采集扩展（用户侧、公网可分发）

上一节的 sidecar 需要部署者自己的 Cookie，适合本机研究；若要给**平台所有用户**用，走这条用户侧路线：抓取发生在**用户自己的浏览器、自己的登录态**里，平台只分发扩展并接收用户主动粘贴的数据，不代抓、不存 Cookie、不碰签名。这样同时满足「公网可用 + 免费 + 能拿到正文/图片（用户浏览器里可见的内容）」。

**为什么不使用小红书官方「快捷搜索插件」**：`https://www.xiaohongshu.com/extension-install` 提供的是官方搜索入口插件，功能仅有「新标签页直达搜索 / 划词右键搜索 / 图片搜索」。它是跳转工具，不导出任何数据，也不对外暴露读取搜索结果的接口；两个独立扩展之间在浏览器沙箱里默认隔离、无法互读数据。因此依赖它无法拿到笔记数据，本项目不改走该路线，只保留「打开小红书搜索」深链跳转。

**目录**：`tools/xhs-extension/`（MV3 扩展，纯前端）

- `manifest.json`：权限 `activeTab` + `scripting` + `tabs`，`host_permissions` 只含 `https://www.xiaohongshu.com/*`；`content_scripts` 同时注入 `parser.js` 与 `content.js`；含一个轻量 `background.js`（仅安装提示，不联网）。
- `parser.js`：页面解析器（纯函数），多选择器兜底 + `__INITIAL_STATE__` 兜底，输出固定 schema；同时支持浏览器与 Node，便于单测。
- `content.js` / `popup.html` / `popup.js`：popup 采集时通过 `chrome.scripting.executeScript` **主动注入 parser 并调用**，因此「刚装完/刚更新、页面早已打开」也能一次成功，不依赖安装前注入的常驻脚本；提供复制 / 下载 JSON。
- `background.js`：MV3 service worker，仅安装提示与扩展自检，无采集/网络逻辑。
- `bridge.js`：注入平台页，暴露 `window.__XHS_COLLECTOR__`（安装标记、版本、最近登录态）供平台「检查项」读取。
- `parser.test.js`：Node 内置断言单测，覆盖计数转换、域名白名单、页面识别、字段提取、去重、登录检测、导出凭证。

**v1.1 修复**：早期版本的 `content.js` 依赖 `window.XhsParser`，但 manifest 未注入 `parser.js`，导致采集必然失败；且常驻 content script 在「扩展安装前已打开的标签页」里不存在。现改为 manifest 正确注入 + popup 主动注入双保险。

**v1.2 登录门禁**：扩展采集前只读页面 DOM 判断小红书登录态（用户头像入口 / 登录按钮 / `INITIAL_STATE.user`），未登录直接拒绝采集、不生成凭证；导出 JSON 带 `loginChecked` / `loggedIn` / `extensionVersion` 凭证，平台后端二次硬校验，无已登录凭证的导入一律 403。`bridge.js` 把最近登录态经 `chrome.storage` 同步到平台页显示。

**安全边界**：只读用户浏览器**当前已渲染**的 DOM；不主动发任何网络请求、不读 Cookie、不模拟登录、不绕过风控、不批量轮询；链接只放行 `xiaohongshu.com` 官方域名。导入侧同样做域名白名单校验。

**安装与使用（Chrome / Edge）**：

1. 浏览器打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本仓库的 `tools/xhs-extension/` 目录。
3. 在小红书**先登录**，打开搜索结果页或某篇笔记详情页，点扩展图标 →「采集当前页」。
   - 如果提示「未识别到笔记数据」：确认页面已加载出笔记卡片、你已登录；小红书改版可能导致选择器失效，需更新 `parser.js`。
   - 如果是「请先在浏览器中打开小红书…」：当前标签页 URL 不是 `www.xiaohongshu.com`，先切到小红书页面。
4. 复制或下载 JSON，回到平台「口碑数据」页 →「导入浏览器采集数据」，粘贴/上传后确认导入。

**落地口径**：通过「口碑数据」页的「导入浏览器采集数据」导入时，内容与「存为线索」同构——只留标题、作者、摘要与链接（`origin=import`、`source=xiaohongshu`、无评分），仅作人工核对，不参与指南生成。若希望这些笔记真正影响行程输出，请走下一节的**实采研究工作流**：它会带上登录凭证、按酒店/交通/饮食/景点四类归档，并明确标注为「用户实采、非评分」后注入模型。是否以及如何对外使用采集内容，由用户自行判断是否符合平台条款与版权要求。浏览器官方商店分发需另行注册开发者账号并审核，本仓库提供的是可自托管的源码。

**加载前自检**（无需浏览器，确认扩展文件完整）：

```bash
node tools/xhs-extension/check.mjs
```

它会校验 manifest 合法、manifest 引用的每个文件都存在、所有 JS 语法正确、`parser.js` 确实在注入列表里——如果这里报错，浏览器加载一定失败。

单测：`node tools/xhs-extension/parser.test.js`（无需第三方依赖，11 项断言）。端到端（可选，需本机 Chrome + Playwright）：在临时目录 `npm i playwright-core` 后用 CDP 加载扩展目录，在模拟小红书 DOM 上验证采集链路。

## 小红书实采研究（需求 → 检索 → 采集 → 注入模型）

这是把小红书数据**真正接进行程生成**的工作流，与上一节"人工核对线索"、口碑评分证据层三者相互独立：

**完整流程**（规划页 cards 顺序）：

1. **描述需求**：填旅行需求、选模型。
2. **小红书实采（可选）**：
   - **检查项**：平台页读取扩展注入的 `window.__XHS_COLLECTOR__`，显示「扩展已安装 / 小红书已登录」。未装扩展时给出加载指引；登录态在采集后经扩展共享存储同步更新。
   - **生成检索词**：把需求交给模型拆成**酒店住宿 / 交通出行 / 饮食美食 / 景点玩乐**四类关键词（模型不可用则自动降级为含目的地 City 的通用词，流程不断）。每类关键词是一键打开小红书搜索的官方深链。
   - **采集**：点深链打开小红书 → 确认已登录 → 用扩展「采集当前页」→ 复制 JSON。**扩展侧强制登录门禁**：未登录不采集、不出凭证。
   - **导入**：回到平台选分类、粘贴 JSON → 后端校验 `loginChecked && loggedIn` 凭证 + 链接域名白名单 + 按 URL 去重 → 落库 `xhs_research`。
3. **生成方案 / 指南**：`createPlan` 与 `buildGuide` 读取该用户实采线索快照（`researchPrompt`），明确标注「用户实采、非评分、点赞只是热度、开放时间票价需回源核实」后注入模型；SSE 增加 `research` 阶段实时事件。线索快照写入 `plans.research_json`，历史规划可复现，不受之后增删线索影响。

**数据边界**：实采线索只有标题/作者/摘要/点赞数/链接，**没有评分**；模型只把它们当目的地、店名、街区、玩法与避坑参考，不得据此写"评分高/口碑好"，不得虚构未列出的店名，票价与营业时间一律提示回源核实。与 `evidence_items`（评分证据）分表存储，互不污染。

**相关表 / 接口**：`xhs_research`（唯一索引 `user_id + url`）；`plans.research_json`（迁移自动补列）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/xhs-research/queries` | 需求拆四类检索词（模型 + 规则兜底） |
| GET | `/api/xhs-research` | 当前用户实采线索列表 |
| POST | `/api/xhs-research/import` | 导入扩展 JSON（强制登录凭证，未登录 403） |
| DELETE | `/api/xhs-research/:id` | 删除单条线索 |
| DELETE | `/api/xhs-research` | 清空全部线索 |

**验证**：`npm run build`；后端冒烟 8 项（检索词兜底、登录门禁、白名单、去重、提示词免责、CRUD）；HTTP 层 9 项（含真实百炼生成并校验 `plan.research` 快照落库）；扩展单测 11 项 + 加载前自检。

## 地图定位与图文指南

指南不再是一份纯文字行程：导出的单文件 HTML 与页面预览都包含**行程总览图、逐日时段图标、地点图文卡**。每张地点卡带地图图块、官方定位深链、坐标与地址（如已取到）、详细介绍、亮点、贴士、取景建议与费用口径。

**图的来源（合规优先）**：不抓取小红书、马蜂窝、景区站点或点评平台的图片——既有反爬与版权问题，也会把不可控内容沉淀进文档。系统只用两类图：

| 图 | 来源 | 零密钥可用 |
|---|---|---|
| 地点地图截图 | 高德静态地图 / Google Static Maps 官方 API，导出时实时取用并内嵌 | 否 |
| 地点示意图、行程总览图、时段图标 | 系统自绘内联 SVG，明确标注「非实测地图」「非导航路线」 | 是 |

零密钥时每个地点仍可一键跳转高德 / Google Maps 官方搜索结果；**系统不会编造经纬度、地址、门牌号或地铁线路**，提示词把这一点作为硬约束，未取到坐标的地点只给深链与示意图。

| 档位 | 条件 | 得到什么 |
|---|---|---|
| 官方深链（默认） | 无需任何配置 | `uri.amap.com/search?keyword=…` 与 `google.com/maps/search/?api=1&query=…`，均为官方 URI API / Maps URLs，不需要 Key |
| 精确模式 | `GEO_PROVIDER` + `GEO_AMAP_KEY` 或 `GEO_GOOGLE_KEY` | 高德 Web 服务「搜索 POI」（无结果回退地理编码）或 Google Places API (New) Text Search，取回坐标、地址、POI ID；高德深链改用 `/marker?position=…` 直接落到点位 |

```bash
# 取得高德「Web服务API」Key 后，在服务器 .env 增加：
GEO_PROVIDER=amap
GEO_AMAP_KEY=your-amap-webservice-key
GEO_STATIC_MAP=1        # 可选：导出 HTML 内嵌官方静态地图截图
sudo systemctl restart travel-planner
```

- **坐标系**：高德返回 GCJ-02，Google 使用 WGS-84。服务端做 GCJ-02 → WGS-84 转换后写入 `GeoPoi.lng/lat`，供 Google 深链与总览图使用；高德 marker 深链仍用原始 GCJ-02，避免国内数百米偏移。
- **静态地图不落库**：官方条款普遍禁止缓存地图图片。图片只在点击导出时实时请求、转 data URI 内嵌进 HTML（自包含、离线可看），`plans.geo_json` 只存坐标、地址与深链；HTML 中不含任何 Key。默认 `GEO_STATIC_MAP=0`，页面预览始终用自绘示意图。
- **熔断降级**：403 / 429 / 风控响应触发 5 分钟熔断，SSE 推送降级事件，证据包标记 `degraded`，该批地点退回深链 + 示意图；普通网络故障只跳过本次。不重试、不换 UA、不走代理池。
- **生成链路**：第一阶段 `collectGeo()` 与口碑取证一起生成 `GeoBundle` 落库；第二阶段 `geoPrompt()` 作为只读上下文注入概览、逐日行程与地点图册，模型只能引用给定坐标与地址。图册按每 4 地一批生成，schema 不硬卡数组长度，按地点名对齐，漏写用诚实降级的卡补齐，卡片名称强制与定位证据一致。
- **更详细的内容**：逐日行程每段要求写清「具体地点 + 做什么 + 节奏」，交通只做定性描述；图册每地 80–140 字介绍 + 2–3 条亮点 + 贴士 + 取景 + 费用口径（不确定写「以现场公示为准」）。

> Google Places / Static Maps 在上海 Lighthouse 实例默认不可达，需部署方自有合规跨境通道（`HTTPS_PROXY`），与口碑证据层共用同一出网配置；未配置时不要启用 `GEO_PROVIDER=google`。

## 实时生成与结构化容错

生成过程不是「转圈等结果」。两个 SSE 端点（`text/event-stream`，POST 直接返回流）会逐条推送 `stage` / `progress` / `retry` / `log` / `done` / `error` 事件，每条带 `elapsedMs`；前端「任务面板」展示当前阶段、步骤进度、耗时和完整时间线，失败时给出可读原因，并可展开查看上游原文与模型出错片段。

指南采用**分块生成**：先出「概览 + 预算 + 清单」，再按每 2 天一批生成每日行程，接着按每 4 个地点一批生成地点图册，最后合并跑一次全量 zod 校验。单次输出短，从根上减少长 JSON 被截断或格式破损；代价是一次指南会发起多次模型调用（3 天 + 6 个地点约 5–6 次），按量计费与速率限制要留意。

结构化输出在 `server/src/structured.ts` 统一处理：

- `sanitizeJson()` 用状态机修复常见破损：Markdown 围栏、前后解释文字、字符串内裸换行/控制字符、数组元素漏逗号、尾随逗号、token 截断导致的未闭合结构。
- 解析失败时把「错误位置附近原文」回传给模型，降温到 0.2 并放宽 token，最多重试 3 次；不再只是重复「请输出合法 JSON」。
- 仍失败则抛出带最后一次输出结尾的错误，前端可展开查看，便于判断是模型能力还是端点问题。

同步 JSON 接口保留原契约，只是内部改走同一套编排；前端默认使用 SSE 接口。

## 微信登录接入点

网站应用微信登录需要**微信开放平台企业资质 + 认证 + 已备案域名 + HTTPS 回调**，本地 `localhost` 无法联调，因此本期未实现，但接口已留好：

1. 在 `.env` 配置 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_CALLBACK_URL`，`wechatProvider.isEnabled()` 即返回 true。
2. `server/src/auth.ts` 的 `wechatProvider.buildAuthorizeUrl()` 已构造好扫码授权地址。
3. 在 `authRouter` 的 `/wechat/callback` 中补充：校验 state 防 CSRF → code 换 access_token → 取 userinfo → 按 openid 绑定或建号 → 调用 `createSession()`。
4. 前端登录页按 `/api/auth/wechat/status` 的结果显示或隐藏「微信登录」按钮。

## 安全与风险

**开发环境（dev）**

- 邮箱直注**不发送验证码**，无法验证邮箱所有权，别用他人邮箱；生产必须补邮箱验证或改用 OAuth。
- 已做：scrypt 密码哈希、AES-256-GCM 加密 API Key、服务端会话（token 只存哈希）、HttpOnly + SameSite=Lax Cookie、同邮箱同 IP 15 分钟内 5 次失败锁定、所有模板输出转义防 XSS、文件名 UUID 化 + 下载前正则校验防目录穿越。
- 未配置 `APP_ENCRYPTION_KEY` 时启动会告警并使用临时密钥；生产环境缺该变量会直接拒绝启动。

**生产环境（prod）**

- 当前以 `http://<公网IP>:8888` 明文访问，密码与会话 Cookie 未经 TLS 保护，仅适合试用。上线务必挂 Nginx 反代 + HTTPS + 域名，并把 8888 收紧为仅本机或安全组放通。
- 8899 部署接收端对公网开放，靠 48 位随机 token + AES-256 加密包保护；建议把来源收紧为自己的出口 IP，并妥善保管 `~/.travel-planner-deploy.env` 与 `/etc/travel-planner-deploy.conf`（均为 600）。
- Cookie 的 `Secure` 由 `.env` 的 `COOKIE_SECURE` **显式控制，不跟随 `NODE_ENV`**：HTTP 访问必须为 `false`，否则浏览器拒绝保存 Cookie，表现为「注册成功但立刻退回登录页」；上 HTTPS 后再改成 `true`。
- 补邮箱验证 / 微信资质，加全局限流与请求日志脱敏。
- SQLite 只适合单机；多实例请迁 PostgreSQL，并把 `data/files` 换成对象存储。
- 生成内容需明确标注 AI 生成，行程与价格引导用户二次核实（HTML 模板已带声明）。
- 第三方数据只走授权通道，**不绕过任何反爬措施**；遇 403/429/风控页面熔断 5 分钟并降级为回源链接，不重试。官方 API 数据不落库；用户录入数据标为低可信，展示时必须带来源与获取日期。

## 故障排查：无法注册 / 无法登录

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面能打开，注册提示「后端 API 未启动（8888 端口无响应）」 | 只起了 Vite，API 进程不在 | 执行 `npm run dev`；或另开终端 `npm run dev:server`。用 `curl http://127.0.0.1:8888/api/health` 确认 |
| 终端报 `EADDRINUSE :8888` / `:5173` | 端口已被上一次启动占用 | 停掉旧进程再启动，或 `lsof -nP -iTCP:8888 -sTCP:LISTEN` 查占用 |
| 提示「该邮箱已注册，请直接登录」 | 邮箱已存在 | 切到「登录」页，或换一个邮箱 |
| 提示「邮箱格式不正确」/「密码至少 8 位」 | 前后端 zod 校验拦截 | 按提示填写；密码至少 8 位 |
| 注册成功但立刻退回登录页 | `.env` 里 `COOKIE_SECURE=true` 但当前是 HTTP 访问，Cookie 带 `Secure` 不被浏览器保存 | 改成 `COOKIE_SECURE=false` 并重启；上 HTTPS 后再改回 `true` |
| 服务器上 `./start.sh` 报「8888 端口已被占用」 | systemd 守护的实例已在运行 | 用 `sudo systemctl restart travel-planner`；或先 `stop` 再前台启动 |
| 提示「服务内部错误」且终端有 `APP_ENCRYPTION_KEY` 相关报错 | 生产模式缺密钥 | 在 `.env` 填 64 位 hex 密钥后重启 |

## 常见坑

- **`GET /models` 返回的模型目录 ≠ 你的账号已开通的模型**。阿里云百炼 OpenAI 兼容接口会列出平台上百个模型，对未开通的模型调用时返回 400 `The product is not activated, please confirm that you have activated products and try again after activation.`（官方错误码 `invalid_parameter_error`）。解决：到百炼控制台「模型市场」开通该模型，或改填已开通的模型名（如 `qwen-plus`）；也别把开源社区名（`Qwen/Qwen3-...`）当百炼模型 ID 用。前端不会替你自动选列表第一个模型，需明确选或填。
- **切换模型配置后模型名要跟着换**。不同端点的模型 ID 不通用，把 A 配置的模型名填到 B 配置会得到 `Unsupported model` / `Model not exist`。
- **更换 `APP_ENCRYPTION_KEY` 后，旧配置里的 API Key 密文会解不开**。界面会提示「该模型配置的 API Key 无法解密」，到「模型设置」编辑该配置重新填一次密钥即可；其余数据不受影响。
- 三种协议对「强制 JSON 输出」支持不一致，统一在 `server/src/structured.ts` 做容错修复 + schema 校验 + 带上下文的多次重试；弱模型仍可能失败，可换更强模型。
- Responses 协议用 `input` + `instructions`，不要把 system 塞进 messages；Messages 协议 `max_tokens` 必填。
- 中转端点常缺 `/v1/models` 或返回非标准结构，属正常现象，手动填模型名即可。
- Anthropic 不能从浏览器直连（CORS），所有模型请求统一走后端代理。
- 生成过程有 SSE 阶段进度，但模型响应本身仍是**非流式**（结构化 JSON 逐字展示没有意义）；一次指南会分块多次调用模型。
- 视觉层为自写 CSS，未引入任何 UI 组件库或第三方模板，无额外许可证与依赖负担。
- **`/api/evidence/matrix` 只读本地**，不触发外部请求；真正取第三方数据发生在生成候选方案时的取证阶段，事件经 SSE 推送。
- **模型多列一个地点曾导致整轮生成失败**：`places` 早期用 `max(8)` 硬卡，模型返回 9 个时 `chatStructured` 重试 3 次仍会输出同样的 9 个。现在 schema 不卡数组长度，服务端统一截断到 8；地点图册同样改为按名称对齐 + 降级补齐。确定性结构冲突不能靠重试解决。
- 海外源在国内实例不可达时，未配置的源显示「未启用」而不是报错；配置后仍连不上会显示「本次不可用，已降级」，不会拖垮生成主链路。

## 部署（已在腾讯云 Lighthouse 实例落地）

**当前线上环境**

| 项 | 值 |
|---|---|
| 访问地址 | http://150.158.179.138:8888 |
| 实例 | `lhins-rr3k7cua`，ap-shanghai，Ubuntu 24.04 / Node 22 / 2核2G |
| 代码目录 | `/opt/travel-planner` |
| 服务 | `travel-planner.service`（systemd，已开机自启，崩溃自动重启） |
| 日志 | `/var/log/travel-planner.log`、`journalctl -u travel-planner -f` |
| 数据 | `/opt/travel-planner/data/`（服务器独立数据库，与本地不互通） |

**一键发布（本地改完代码后）**

```bash
./deploy.sh
```

脚本自动完成：本地类型检查与构建 → 打包加密（排除 `.env` / `data/` / `node_modules/` / `web-dist/`）→ 推送到服务器部署接收端 → 接收端按需 `npm ci`、构建、重启服务、自检 → 公网健康检查。一次约 40 秒。

- 凭据在本机 `~/.travel-planner-deploy.env`（chmod 600，不入库），含 `DEPLOY_ENDPOINT` / `DEPLOY_TOKEN` / `DEPLOY_AES_KEY` / `APP_URL`。
- 服务器侧组件：`travel-planner-deploy.service`（`deploy-receiver.py`，监听 8899），云防火墙已放行 TCP 8899；日志 `/var/log/travel-planner-deploy.log`。
- 通道为 **48 位随机 token 路径 + AES-256 加密包**，接收端只执行固定部署流程，不提供任意命令入口。
- **`.env` 与 `data/` 永不参与发布**：服务器上的密钥和用户数据不会被覆盖或删除；只覆盖同名源码文件，不做删除。
- 建议把云防火墙 8899 的来源收紧为你的出口 IP；更换网络后若报「部署接收端不可达」，先检查该规则。

**常用命令**

```bash
sudo systemctl status travel-planner      # 状态
sudo systemctl restart travel-planner    # 重启（自动重新构建前端）
sudo systemctl stop travel-planner       # 停止
tail -f /var/log/travel-planner.log      # 实时日志
sudo systemctl status travel-planner-deploy   # 部署接收端状态
tail -f /var/log/travel-planner-deploy.log   # 发布日志
cd /opt/travel-planner && ./start.sh     # 前台手动启动（调试用，需先 stop systemd 服务）
```

更新代码或改 `.env` 后执行 `sudo systemctl restart travel-planner` 即可，脚本会重新跑类型检查与前端构建。

**systemd unit**（`/etc/systemd/system/travel-planner.service`）

```ini
[Unit]
Description=Travel Planner (Web + API on port 8888)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/travel-planner
ExecStart=/opt/travel-planner/start.sh
Restart=on-failure
RestartSec=5
TimeoutStartSec=300
StandardOutput=append:/var/log/travel-planner.log
StandardError=append:/var/log/travel-planner.log

[Install]
WantedBy=multi-user.target
```

**从零重新部署**

1. 服务器装 Node 20+，把仓库（含 `start.sh`）放到 `/opt/travel-planner`，执行 `npm ci && npm run build`。
2. 生成 `.env`：`PORT=8888`、`HOST=0.0.0.0`、`APP_ENCRYPTION_KEY=<64位hex>`、`COOKIE_SECURE=false`（HTTP 访问时）。
3. 按上面的 unit 建服务，`systemctl daemon-reload && systemctl enable --now travel-planner`；云平台防火墙放行 TCP 8888。
4. 正式上线接 Nginx 反代 + HTTPS + 域名后，把 `COOKIE_SECURE` 改为 `true`，并收紧 8888 的来源或只保留 80/443 对外。
5. 若要启用一键发布，把 `deploy-receiver.py` 放到部署目录，写 `/etc/travel-planner-deploy.conf`（600，字段见下）与下面的 unit，云防火墙放行 TCP 8899，并在本机生成 `~/.travel-planner-deploy.env`。

`/etc/travel-planner-deploy.conf` 字段：`DEPLOY_TOKEN` / `DEPLOY_AES_KEY`（与本机凭据一致）、`DEPLOY_DIR` / `DEPLOY_SERVICE` / `DEPLOY_PORT=8899`。

```ini
# /etc/systemd/system/travel-planner-deploy.service
[Unit]
Description=Travel Planner deploy receiver (token + AES)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/travel-planner/deploy-receiver.py
Restart=on-failure
RestartSec=3
StandardOutput=append:/var/log/travel-planner-deploy.log
StandardError=append:/var/log/travel-planner-deploy.log

[Install]
WantedBy=multi-user.target
```

> 服务器是全新的空数据库：需在网页上重新注册账号、在「模型设置」重新填一次大模型 API Key。本地 `data/` 不会自动同步过去；若确需迁移，两边 `APP_ENCRYPTION_KEY` 必须一致，否则已加密的 API Key 解不开。

## 推送 GitHub 前

仓库里**不要**包含以下内容（本项目未擅自创建 `.gitignore`，请按需自行添加）：

```gitignore
node_modules/
.env
data/
web-dist/
*.log
```

建议同时提交 `.env.example`（已提供），并在 README 中保留密钥生成方式。本机 `~/.travel-planner-deploy.env`（发布凭据）与 `~/.travel-planner-xhs.env`（小红书 Cookie / sidecar token）都在项目目录之外，切勿复制进仓库；服务器 `/etc/travel-planner-deploy.conf` 同理。`deploy.sh`、`deploy-receiver.py`、`start.sh`、`tools/xhs-notes/` 只含脚本与配置模板，不含任何密钥；`deploy.sh` 还额外排除了任意子目录的 `.env`。

## 已知限制

- 本期只导出 HTML；模板已做打印反白与分页适配，PDF 请用浏览器「打印 / 另存为 PDF」，未做服务端 PDF 生成。
- 未接入任何官方评分 API（暂无凭据）。代码提供的是标准 provider 接口、条款声明、状态机与降级链路；拿到授权后由合规网关把各家响应归一化即可启用，不需要改业务代码。官方源数据按条款不落库，每次生成会重新取证。
- 地图精确模式默认关闭（暂无高德 / Google Key）。零密钥下只有官方深链与自绘示意图，不含真实坐标与地图截图；配置 Key 并开启 `GEO_STATIC_MAP=1` 后才会出现官方静态地图。景点照片不在接入范围内（反爬与版权），如需照片请自行接入有授权的开放图库。
- 小红书笔记检索是独立、默认关闭的研究通道：未启用时只给官方搜索入口；上游为逆向签名项目，自述仅供学习、无 LICENSE，其代码与凭据不进发布包，也不会自动参与指南生成。详见「小红书笔记检索」章节。
- 小红书浏览器采集扩展为用户侧工具：只读用户自己浏览器已渲染的 DOM，不代抓；小红书 DOM 改版会导致选择器失效，需更新 `parser.js` 的选择器（已做多选择器 + 初始状态兜底）。官方「快捷搜索插件」不提供数据接口，未采用。扩展带登录门禁（未登录不采集、不出凭证），后端二次校验。
- 实采工作流注入的是**非评分线索**：模型只参考地点/店名/玩法，不产生评分；登录检测基于页面 DOM 特征（用户头像/登录按钮），小红书改版或反爬可能让检测失效，此时扩展会给出"无法确认登录状态"而不出凭证，需更新 `detectLogin` 的选择器。登录态凭证可由用户自行伪造 JSON 绕过，本方案定位为「提醒用户自觉登录、并阻止误采」而非身份鉴权，正式对外需走平台授权接口。
- 微信登录未实现，仅预留 provider 与回调接入点。
- 邮箱注册无验证码，仅限开发/小范围试用。
- 模型响应非流式（有 SSE 阶段进度）、单机会话存储、无并发渲染队列。
