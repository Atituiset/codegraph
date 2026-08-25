# 原生内核：Rust 加速路径

> **本章要解决的问题**:WASM 提取管线已经能跑,为什么还要用 Rust 重写一遍提取逻辑?答案不是"Rust 快"(那只是零头),而是**数据搬运**:几十万个符号对象从 worker 搬到主线程要逐字段拷贝;换成 Rust 侧输出一块平坦内存,搬运就变成一次 memcpy。但引入原生二进制有代价——跨平台分发、版本错配、行为不一致。本章讲 CodeGraph 怎么把这份代价压到"可选、静默、随时可退回"。

`codegraph-kernel/` 是仓库里唯一的 Rust 代码：一个 napi-rs crate，用原生 tree-sitter 绑定重新实现了 TS 提取 walker 的行为等价物。它不是重写，而是**替换**——只替换 worker 内部的 parse+extract 那一步，对外仍走同一个 `ExtractionResult` 契约，下游的 resolution/synthesis/MCP 一概不知情。

## 定位哲学：可选、静默、可回滚

loader（`src/extraction/kernel/loader.ts`）头注释把设计立场说得非常清楚：

> The kernel is OPTIONAL everywhere. Every failure mode here resolves to `null` and the extraction path silently keeps using the wasm pipeline — a missing or stale kernel must never break indexing, only skip the speedup.

加载顺序：环境变量 `CODEGRAPH_KERNEL_PATH` → 发布捆绑位置 `<pkgRoot>/kernel/codegraph-kernel.node` → 源码构建位置 `prebuilds/<platform>-<arch>/`。任何一步失败返回 null，调用方回落 WASM。`CODEGRAPH_KERNEL=0` 是随时可用的总开关。

加载成功后还有一道**契约校验**（verifyContract）：调用内核的 `contractInfo()`，比对 ABI 版本和 NodeKind/EdgeKind 表——后者必须**字节相等**。原因在数据模型章埋过伏笔：kinds 以数组下标跨越 JS/Rust 边界，两边数组顺序不同就是灾难性的错位解码。校验失败的 stale `.node` 静默降级而不是硬错误——宁可慢，不可错。

## 二进制布局：一次跨界，五块 buffer

每次文件提取只发生一次 JS↔Rust 调用，返回五段平坦内存（`layout.ts`，与 Rust 侧 `buffers.rs` 逐字节镜像）：

```
META (36B)    u8 abiVersion | u32 nodeCount/edgeCount/refCount
              | u32 arenaLen | errorsOff/Len(JSON) | f64 durationMs
NODE (96B/行) u8 kind | u8 visibility | u16 flags | u32 起止行列
              | str name | str qualifiedName | str id | str docstring
              | str signature | str decorators(NUL 连接) | str returnType ...
EDGE (44B/行) u32 sourceIdx | u32 targetIdx | u8 kind | u8 provenance
              | u32 line/col | str metadataJson | str sourceIdStr/targetIdStr
REF  (40B/行) u32 fromIdx | u8 kind | u8 flags | u32 line/col
              | str referenceName | str candidates | str fromIdStr
ARENA         全部 UTF-8 字符串的连续存储
```

三个值得咀嚼的设计：

**字符串是 (offset,len) 对**。所有字符串堆进一个 arena，行结构里只存偏移——这是零拷贝序列化的经典手法，让 Rust 侧不需要为每个字段分配独立的 Vec。

**kind 是下标**。u8 存 NODE_KINDS 数组下标而非字符串。省空间只是次要原因，主要原因是让契约校验成为可能：下标方案强制两边声明共享的顺序表，parity 测试才有明确的断言对象。

**NONE = 0xffffffff 哨兵**。"field absent" 用固定值表示而不是空指针或长度 0——跨 FFI 边界上 Option 语义的最廉价编码。

edges 用行号索引指回 node 表，解码端维护 `idByRow[]` 还原；个别无法用行号表达的情形（如引用指向尚未入表的节点）有 `sourceIdStr` fallback 字符串列。`decode.ts` 的解码循环就是逐行 subarray + 读定宽字段的机械操作，183 行写完。

## 路由：哪些文件走内核

默认路由表覆盖 20 种主流语言（TS/TSX/JS/JSX/Java/Python/Go/C/C++/Rust/C#/Ruby/PHP/Swift/Kotlin/R/Lua/Luau/Scala/Dart），每项附带 parity gate 记录——切换该语言的日期、验证仓库、字节级 parity 的文件数、deferral 率。env 可整体覆盖。

per-file 还有一道**安全阀**：解析树含 ERROR 节点的文件，内核主动以 `defer:` 错误抛回，WASM 接管。理由写在注释里：

> error recovery differs between UTF-8 and UTF-16 parsing — wasm's recovery is canonical.

tree-sitter 的错误恢复产物不保证规范，而两条实现路径对同一份残缺代码可能恢复出不同的树。与其让图的内容取决于"这个文件恰好走了哪条路"，不如统一交给 WASM 权威。defer 结果有单槽 memo 缓存——Linux kernel 仓库的 defer 率约 79%（大量宏展开导致的解析错误），不缓存的话每个 seam 都要白付一次 blank+native-parse 的代价。

preParse hook 的处理同样体现了行为等价的执念：C/C++ 宏空白化、CUDA/Metal 方言 token 处理这些 TS 侧的前置变换，会在调内核**之前**应用——两边 parse 相同的字节，Rust 侧就不需要移植任何方言逻辑。

## 零物化快路径

内核最大的性能红利不在解析本身，而在数据搬运。批量索引时 parse-worker 走 `tryKernelExtractRaw()`：五块 buffer **不解码**直接塞进 `ExtractionResult.kernelBuffers`，postMessage 给主线程/ store-worker——Node 的 structured clone 对 Uint8Array 是 memcpy 级别，于是 per-node 的 JS 对象从头到尾没有被创建过。解码被推迟到 store 边界（store-worker 收到 bundle 时执行 decodeKernelBundle）。

对照 WASM 路径：worker 里 walk AST 创建几十万个 `{id, kind, name, ...}` 对象 → structured clone 逐字段拷贝 → 主线程 GC 压力。内核路径把这条链压缩成了三次大块内存复制。

## 构建与分发

`scripts/build-kernel.sh` 包装 cargo build --release 并把产物改名为 `codegraph.node` 放进 prebuilds 目录。发布 workflow 在 macos-arm runner 上交叉编译全部平台。脚本里有一条值得单独记录的注释：

> 复制前先 rm 保证新 inode —— overwriting a signed dylib in place leaves macOS's per-inode signature cache stale, and every process that then dlopens the staged .node is SIGKILLed at load.

macOS 按 inode 缓存签名验证结果，原地覆盖签名库会让后续 dlopen 直接被杀。这类平台深坑在本仓的处理方式一贯是：注释里讲清因果链，然后让代码绕开它。

## 小结

内核章展示的是这个项目演化到后期的典型模式：**新能力一律做成可选旁路 + 契约校验 + 静默降级**，主路径永远保持"没有它也完整正确"。这与 MCP 层的做法（daemon 可禁用、watchdog 可关闭、worker 池可熔断回退）一脉相承——整个系统没有一个单点是不可缺失的。
