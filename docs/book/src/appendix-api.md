# 附录：公共 API 导航

本附录是 `CodeGraph` 类公共方法到内部实现的导航表，供读源码时定位。行号校准于 2026-10-27 的 main；语义细节见各章正文。

## 生命周期

| 方法 | 内部路径 | 说明 |
|---|---|---|
| `CodeGraph.init(root, {index})` | `src/index.ts:351` | 建目录 → 初始化 schema → 可选 indexAll |
| `CodeGraph.open(root, {sync})` | `:407` | 打开 + 迁移 + 自愈（存储章） |
| `CodeGraph.recreate(root)` | `:468` | unlink 三件套后重建（性能章） |
| `reopenIfReplaced()` | `:312` | inode 检测，`.codegraph/` 被删重建时原地换连接 |
| `close()` | `:556` | unwatch → release lock → db.close |

## 索引与同步

| 方法 | 内部路径 | 说明 |
|---|---|---|
| `indexAll(options)` | `:579` | 全量：双互斥 → fast-init → WAL 阀 → bulk 窗口 → 解析 → 合成（架构章） |
| `indexFiles(paths)` | `:879` | watcher 快路径的定向子集 |
| `sync(options)` | `:926` | 增量：复活入边 → definitionDelta rebind → 孤儿清扫（解析章） |
| `watch()/unwatch()` | `:1626/:1648` | FileWatcher，自适应防抖，降级闩 |

## 查询

| 方法 | 内部路径 | 说明 |
|---|---|---|
| `searchNodes(query, options)` | `:2217` | 四级降级瀑布（查询章） |
| `getSegmentMatches(words)` | `:2259` | 段词表匹配 + honesty gate（数据模型章） |
| `getCallers/getCallees(id, depth)` | `:2632/:2643` | GraphTraverser，含 instantiates 与合成边 |
| `getImpactRadius(id, depth)` | `:2656` | 排除 contains 的上游 BFS + 容器下探 |
| `findPath(from, to)` | `:2668` | BFS 最短路 |
| `getTypeHierarchy(id)` | `:2608` | extends/implements 双向 |
| `findCircularDependencies()` | `:2721` | 文件级依赖图 DFS 找环 |
| `buildContext(input, options)` | `:2824` | ContextBuilder 全管线（查询章） |
| `findRelevantContext(query, opts)` | `:2788` | explore 的 gather 核心 |

## MCP 工具面（默认仅 explore）

| 工具 | 入口（tools.ts） | 要点 |
|---|---|---|
| `codegraph_explore` | handleExplore :4200 | buildFlowFromNamedSymbols + PageRank（工具章） |
| `codegraph_node` | :7850 | file 模式 = Read 等价物；symbol 模式全重载一次给全 |
| `codegraph_search` | :3169 | FTS + 重排，generated 文件沉底 |
| `codegraph_callers/callees/impact` | :3229/:3312/:3392 | 多定义分组列出 |
| `codegraph_status/files` | :8278/:8418 | 主线程专用 / 树形输出 |

预算函数：`getExploreBudget`（tools.ts:257）、`getExploreOutputBudget`（:308）——两套阶梯必须保持单调不变式。

## 环境变量速查（高频）

| 变量 | 作用 |
|---|---|
| `CODEGRAPH_MCP_TOOLS` | 重新启用非默认工具，如 `explore,node` |
| `CODEGRAPH_NO_DAEMON=1` | 禁用 daemon，单进程 direct 模式 |
| `CODEGRAPH_KERNEL=0` | 关闭 Rust 内核，全部走 WASM |
| `CODEGRAPH_NO_WATCHDOG=1` | 关闭 liveness watchdog |
| `CODEGRAPH_PARSE_WORKERS` | 覆盖解析池大小（0/1 回滚单线程） |
| `CODEGRAPH_WAL_VALVE_MB` / `CODEGRAPH_WAL_HEAL_MB` | WAL 阈值调优 |
| `CODEGRAPH_DIR` | 数据目录改名（Windows/WSL 共树场景） |
| `DO_NOT_TRACK=1` / `CODEGRAPH_TELEMETRY=0` | 关闭遥测 |

## 构建与验证

```bash
npm run build        # tsc + 复制 schema.sql 和 *.wasm 到 dist/
npm test             # vitest run
npm run eval         # 构建 + 运行评估 runner
cd docs/book && npm install && npx vitepress build   # 本文档(VitePress)
```

注意：新增 SQL 或 grammar wasm 必须同步进 copy-assets 步骤，否则不会随包发布。
