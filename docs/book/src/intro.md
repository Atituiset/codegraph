# 引言：为什么需要 CodeGraph

## 一个关于"读代码"的经济学问题

设想一个 AI 编码 agent 接到这样一个问题：

> "用户更新画布上的一个元素后，画面是怎么重新渲染出来的？"

没有 CodeGraph 时，agent 的典型做法是 Grep 一个关键词、打开一个文件、再 Grep 另一个关键词、再打开另一个文件……每一次工具调用都把新的文本灌进上下文窗口，而 agent 真正需要的答案——一条从 `mutateElement` 出发、穿过回调注册和 React 重渲染、最终落在 `renderStaticScene` 的调用路径——散落在十几个文件里。本仓库的基准测试记录过这类任务在无图状态下的形态：**9–10 次 Read、10–11 次 Grep，两分钟以上的墙钟时间**（见 `docs/design/dynamic-dispatch-coverage-playbook.md` 中 Excalidraw 的工作样例）。

CodeGraph 对这个问题的回答是：把这些结构性关系**预先物化**成一张图。同一个问题变成一次 `codegraph_explore("mutateElement triggerUpdate renderStaticScene")` 调用——工具返回的 Flow 区段直接给出六跳的完整链路，每一跳都带内联源码和"这条边是怎么接上的"接线点位置。实测最好成绩是 **0 Read / 0 Grep / 3 次工具调用 / 51 秒**。

这不是一个检索质量的边际改进。agent 一旦发现 codegraph 的答案不够用，会立刻回退到 Read/Grep；而只要答案足够用，它就会停手。所以整个项目的核心优化目标可以压缩成一句话：**让 agent 在少数几次快速的结构化查询之后获得足以停止阅读的答案。**

## 它是什么

CodeGraph 是一个**本地优先的代码情报系统**，同时以三种形态存在：

1. **库**——`src/index.ts` 导出的 `CodeGraph` 类，暴露 `init/open/indexAll/sync/searchNodes/getCallers/getImpactRadius/buildContext/watch` 等方法；
2. **CLI**——`codegraph init/index/sync/status/query/explore/callers/affected/serve` 等子命令（`src/bin/codegraph.ts`）；
3. **MCP 服务器**——通过 stdio 把八个工具（默认只暴露 `codegraph_explore`）交给 Claude Code、Cursor、Codex CLI、opencode 等 host。

三者共享同一条管线：tree-sitter 解析 → 符号/边写入 SQLite（FTS5 全文索引）→ 引用解析与动态分发合成 → 图查询与上下文构建。每个项目的数据都在项目根的 `.codegraph/` 目录里，没有任何云依赖。

有一个设计决定值得在读第一行源码之前就记住：**提取是确定性的**。所有符号和边都派生自 AST 结构，而不是 LLM 总结。这意味着对同一份代码重复建索引，得到的图是字节级一致的——这是后面无数工程决策（按文件序提交、语法树版本锁定、插入序消歧）共同的锚点。

## 三条贯穿全书的设计主线

深读这个代码库，会发现几乎每个非常规写法背后都有一个可追溯的事故编号（issue #），以及从那次事故提炼出的原则。其中三条主线会在每一章反复出现：

**确定性高于一切。** 引用解析阶段会把歧义引用绑定到"数据库插入序最先"的候选上，所以提取阶段必须保证提交顺序稳定——多 worker 并行解析、乱序完成，但必须**按文件序落库**（`src/extraction/index.ts`）。同理，Rust 内核与 WASM 路径必须使用同一 revision 的 grammar 才允许切换路由。

**静默优于错边。** `", ".join(x)` 这样的字面量接收者不发引用；同名候选超过 500 个直接放弃解析；事件扇出超过上限跳过。"一条错误的边比缺失的边更糟"出现在 name-matcher、synthesizer、import-resolver 每一层的注释里——因为下游的 agent 会沿着错边走向完全无关的代码，然后开始自信地胡说。

**进程拓扑即可靠性。** CLI 启动时可能自我重执行一次（为了给 V8 打 `--liftoff-only` 标志）；MCP 默认跑在一个 detached daemon 上，host 启动的只是轻量 proxy；五层 watchdog 各自负责一种孤儿/卡死形态。这一整套机制不是过度设计，而是 #277/#692/#799/#850/#1185 一连串真实事故的沉积层。

## 如何阅读这本书

全书分为四段:**机制**(总体架构、tree-sitter、实证实验)→ **入门**(数据模型、提取、存储、查询)→ **进阶**(解析、合成边、Rust 内核、MCP 进程拓扑、工具设计、性能)→ **定位与借鉴**(适用场景、边界、以及这套架构对构建静态分析产品的启示)。完整导读见[本书首页](index)。

- 只想建立全景的读者,读**总体架构**一章即可;
- 想动手读源码的,从**实证篇**开始——三个文件的玩具仓库,每张表都查给你看;
- 想评估"这东西适不适合我们团队"的,直接跳到**定位与使用场景**。

本版内容校准于 2026-10-27 的 main 分支;文中所有 `文件:行号` 对应该版本,行号会漂移但函数名不会。
