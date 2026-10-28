# 一条流水线，两种旅程

## 分层管线

CodeGraph 的所有模块最终都挂在这条流水线上：

```
文件系统
   │  scanDirectoryAsync（gitignore / 嵌入子仓库处理）
   ▼
ExtractionOrchestrator ── ParseWorkerPool ── tree-sitter (WASM) 或 Rust 内核
   │  ExtractionResult { nodes, edges, unresolvedReferences }
   ▼
SQLite (.codegraph/codegraph.db)          ← schema.sql + FTS5
   │
   ▼
ReferenceResolver                          ← imports / name-matcher / frameworks
   │  把"名字引用"绑定成边；失败的 park 进 unresolved_refs
   ▼
callback-synthesizer                       ← 动态分发合成边（provenance='heuristic'）
   │
   ▼
GraphQueryManager / GraphTraverser         ← callers、callees、impact、findPath
   │
   ▼
ContextBuilder                             ← 混合检索 + 图扩展 → markdown/JSON
   │
   ▼
MCP 工具层（tools.ts）                     ← codegraph_explore 等，面向 agent
```

依赖方向是严格的单向：`index.ts`（公共 API）在 `wireLayers()` 里把各层装配起来，下层不知道上层。库用户只接触 `CodeGraph` 类；CLI 和 MCP 服务器都只是它的两种驱动方式。

## 旅程一：索引一个仓库

`codegraph init` 触发的 `indexAll` 是全仓最重的路径（`src/index.ts:579`）。把它当作全书的地标，后面每一章都会回到这条链上：

1. **互斥**：进程内 `indexMutex` + 跨进程 `FileLock`（`.codegraph/codegraph.lock`）双重把关；
2. **fast-init**：全新数据库时临时切到 `journal_mode=MEMORY + synchronous=OFF`——反正索引中途崩了就整个重来，不值得为它付持久化代价；
3. **WAL 延迟 checkpoint**：把 `wal_autocheckpoint` 置 0，交给后台的 `WalCheckpointValve` 控制回填节奏（HDD 上这一项把 19 分钟变成 45 秒，#1231）;
4. **批量装载窗口**：DROP 掉 FTS 逐行触发器和全部二级索引，让海量 INSERT 直通；
5. **扫描与解析**：`scanDirectoryAsync` 产出文件列表，`ParseWorkerPool` 并行解析——但结果**按文件序**提交（第 5 章）；
6. **解析引用**：`resolveReferencesBatched` 把提取阶段攒下的几十万个"名字引用"批量绑定为边（进阶篇第 1 章）；
7. **两遍 deferred 解析**：`resolveChainedCallsViaConformance`（#750）和 `resolveDeferredThisMemberRefs`（#808）处理必须等 extends/implements 边建好才能解的引用；
8. **合成动态边**：43 个 pass 扫描已解析的图，补上回调、事件、React 重渲染这类静态解析看不见的边（进阶篇第 2 章）；
9. **收尾**：离线程 maintenance（PRAGMA optimize + WAL checkpoint）、按差值重算节点/边计数、盖 `indexed_with_extraction_version` 版本戳。

注意第 8 步：合成边经常占图中边的 50% 以上。静态 AST 只能告诉你代码*写着*什么调用；而 agent 关心的"数据怎么流动"有一半发生在动态分发里。这是 CodeGraph 与朴素 "ctags + grep" 方案的本质区别。

## 旅程二：回答一个 flow 问题

agent 在 Cursor 里问出本章开头那个渲染问题时，MCP 侧发生的事：

```
host (Cursor)                    proxy 进程                detached daemon
    │ spawn: codegraph serve --mcp   │                          │
    ├──────── stdio ────────────────▶│ 连接 .codegraph/daemon.sock
    │                                ├──────── socket ─────────▶│ MCPEngine
    │◀── initialize 响应(含指令) ─────┤                          │  │
    │                                │                          │  ├ ToolHandler
    │◀── tools/list: explore ────────┤                          │  ├ query-pool (workers)
    │                                │                          │  └ FileWatcher
    ├── tools/call explore ─────────▶│──────── 转发 ────────────▶│
```

daemon 里发生的事才是重点：`handleExplore` 先把查询拆成符号名 token，经 `buildFlowFromNamedSymbols` 在图上搜索一条只经过"被点名符号"的路径（最多容忍一跳未命名桥），再由 personalized PageRank 补齐周边上下文，最后渲染成带内联源码的 Flow 区段。整个过程通常落在一次 SQL 密集但毫秒级的图查询上。

这套拓扑里每个角色都有存在理由：proxy 死了 host 能感知（stdio 断开）；daemon 不随任何一个 host 的死亡而退出（多个会话共享热索引）；而 daemon 自己靠 PPID watchdog、空闲计时器和客户端存活扫描三种机制避免变成孤儿（进阶篇第 4 章）。

## 模块地图:量化视角

先看规模(排除类型声明,实数):

| 目录 | 文件 | 行数 | 占比 | 职责 |
|---|---|---|---|---|
| `src/extraction/` | 64 | 35,252 | 19% | tree-sitter 包装、31 个语言配置、worker 池 |
| `src/resolution/` | 90 | 79,733 | 44% | 引用解析、同名消歧、框架、合成边 |
| `src/mcp/` | 29 | 17,568 | 10% | 协议、daemon、watchdog、工具实现 |
| `src/installer/` | 19 | 5,281 | 3% | 11 个 agent target 的安装器 |
| `src/db/` | 11 | 8,252 | 5% | 连接、schema、QueryBuilder、WAL 阀门 |
| `src/bin/` | 6 | 3,297 | 2% | CLI 与进程引导 |
| 其余(context/sync/graph/search/ui-server…) | 75 | 32,410 | 18% | 见下文 |

两个数字值得咀嚼。其一,**解析层(`resolution/`)一个目录就占了全仓的 44%**,比提取层还多——这个项目的复杂度大头已经不在"把代码读出来",而在"把读出来的名字接对":同名消歧、框架路由、动态分发合成,每一类都是一堆事故编号沉淀下来的启发式。提取 + 解析合计约 63%。SQLite 一共只用了 11 个文件就承载了全部数据需求,这是选对工具的复利。其二,`extraction/languages/` 下有 **31 个语言提取器配置**(对应 29 门语法,个别配置共享语法),平均每语言几百行;而共享的 walker 是一个 9,745 行的单体 `tree-sitter.ts`。语言支持的边际成本是加法,这正是配置表模式的回报。

再看顶层 import 依赖(自动扫描 `from '../<mod>` 得到,已剔除 languages/frameworks/targets 等子目录内部边):

```
bin        → search sync ui extraction telemetry mcp
context    → extraction db graph search
db         → search extraction          ← 反向依赖!
extraction → db resolution              ← 提取层调用框架提取器!
graph      → db
mcp        → resolution sync telemetry extraction search
resolution → db extraction
sync       → extraction
index.ts   → 全部
```

两条违反直觉的边都有真实理由:`extraction → resolution` 是 `tree-sitter.ts` 直接 import `getAllFrameworkResolvers`——框架路由提取必须在解析现场进行,否则内联 handler 的上下文就丢了;`db → search` 则是 QueryBuilder 自己实现了 FTS 查询构造,`search/` 目录反而只放纯函数词汇表(拆词、打分),两者是"SQL 执行 vs 语义计算"的分工而非分层。**依赖方向服务于数据流,不服务于教科书的整洁**——这是读懂本仓结构的钥匙。

## 各章导航

| 章节 | 内容 |
|---|---|
| 实证篇 | 用真实索引产物逐站验证机制 |
| 入门篇四章 | 数据模型 → 提取器 → 存储 → 查询 |
| 进阶篇六章 | 解析 → 合成 → 内核 → MCP → 工具设计 → 性能 |

## 横切原则速览

以下原则会在后续章节以具体形态反复出现，此处先立此存照：

- **确定性高于一切**——文件序提交、grammar revision 锁定、插入序消歧；
- **静默优于错边**——字面量接收者不发边、歧义上限、扇出上限；
- **降级要静默**——Rust 内核加载失败返回 null 回落 WASM；watcher 在 WSL2 `/mnt/` 上自动关闭；一切失败模式都指向"功能少一点"而不是"坏掉";
- **响应形状即行为工程**——`isError: true` 只留给安全拒绝和真故障；未索引、过载、忙碌全部用成功形状携带指引，因为一两次错误响应就会教会 agent 整个会话弃用这个工具；
- **DDL 单一真源**——schema.sql 是唯一的 DDL 权威，崩溃自愈和批量窗口结束时的索引重建都从它正则提取 DDL，杜绝漂移；
- **任何主线程停顿不得超过 60 秒**——这是 #850 liveness watchdog 定下的硬约束，它塑造了本仓大量异步代码的形状（逐语句 yield、离线程 checkpoint、假超时双窗口）。

带着这六条去读源码，你会发现它们几乎能解释每一处"为什么不直接写简单点"。
