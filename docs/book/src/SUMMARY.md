# Summary

[引言：为什么需要 CodeGraph](intro.md)

# 总体架构

- [一条流水线，两种旅程](architecture.md)

# Tree-sitter 与提取基础设施

- [Tree-sitter 入门：语法、错误恢复与 WASM](tree-sitter.md)

# 实证：一张图是怎么长出来的

- [一个玩具仓库的六站解剖](empiria.md)

# 源码级入门

- [数据模型：types.ts 与 schema.sql](gs-data-model.md)
- [提取器解剖：AST 如何变成图](gs-extractor.md)
- [存储层：node:sqlite 与 QueryBuilder](gs-storage.md)
- [查询层：遍历、搜索与上下文](gs-querying.md)

# 源码级进阶

- [引用解析：两阶段流水线](adv-resolution.md)
- [动态分发与合成边](adv-synthesis.md)
- [原生内核：Rust 加速路径](adv-kernel.md)
- [MCP 服务器与进程拓扑](adv-mcp.md)
- [为 agent 设计工具：codegraph_explore](adv-agent-tools.md)
- [性能工程：watchdog、WAL 与内存纪律](adv-performance.md)

# 附录

- [公共 API 导航](appendix-api.md)
- [对比：code-review-graph 交叉分析](compare-crg.md)
