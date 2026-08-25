# Tree-sitter 入门：语法、错误恢复与 WASM

要读懂 `src/extraction/`，需要先理解 tree-sitter 是什么、它和 yacc/ANTLR 这类传统解析器生成器的区别在哪里。本章前半部分是独立成立的 tree-sitter 概论，后半部分讲 CodeGraph 对它的用法——其中有两处相当非典型。

## tree-sitter 是什么

tree-sitter 诞生于 GitHub，最初的目标很具体：**在编辑器里做实时的语法高亮和代码导航**。这个出身决定了它的三个核心特性，每一个都被 CodeGraph 直接受益：

**1. 具体语法树（concrete syntax tree）。** 与编译器教科书里"丢弃标点、只留语义"的抽象语法树不同，tree-sitter 的树保留一切：括号、分号、逗号都是节点。每个标识符、每个关键字都能通过"字段名"精确定位——比如函数声明节点上一定有 `name` 字段指向名字标识符。CodeGraph 的提取器大量依赖这一点：`getChildByField(node, extractor.nameField)` 一行代码就能拿到任何语言的函数名，不用为每个语言写正则。

**2. 错误恢复（error recovery）。** 编辑器里的代码大部分时间是不完整的、有语法错误的。tree-sitter 的 GLR 风格算法不会在第一个错误处放弃，而是把出错区间包成 `ERROR` 节点继续往下解析。对 CodeGraph 这意味着：一个文件里有一处语法错误，其余部分的符号照样能被提取出来——这在真实世界的代码库上至关重要。代价是错误恢复的产物不保证规范，所以 Rust 内核对包含 `ERROR` 节点的文件会主动弃权，交回 WASM 路径处理（见内核章）。

**3. 增量重解析（incremental reparsing）。** 给定旧树和新版源码，tree-sitter 能只重算改动波及的子树。这主要服务于编辑器场景；CodeGraph 的 sync 路径按文件粒度重建，暂时没有吃到这个红利——但 watcher 的低延迟增量同步正是建立在"单文件解析足够快"之上的。

语法本身用一套 DSL 编写（`grammar.js`），编译产物是纯 C。这份 C 代码可以编成原生库，也可以——关键的一步——编成 **WebAssembly**。

## web-tree-sitter：为什么选 WASM

CodeGraph 通过 npm 包 `web-tree-sitter` + `tree-sitter-wasms` 使用 WASM 版本的运行时与全部 29 个 grammar（`src/extraction/wasm/*.wasm`）。动机写在 `grammars.ts` 的文件头：

> Uses web-tree-sitter (WASM) for universal cross-platform support. Grammars are loaded lazily — only languages actually present in the project are compiled, keeping V8 WASM memory pressure low.

对比一下替代方案：如果用 native binding（node-tree-sitter），npm 安装时需要在用户机器上编译 C 代码，或者为每个平台预构建二进制。CodeGraph 的发行版要同时服务 macOS（x64/ARM）、Windows（x64/ARM）和 Linux（x64/ARM），WASM 让 grammar 层完全平台无关。（后来引入的 Rust 内核重新引入了原生二进制，但它是**可选加速**而非依赖——加载失败静默回落 WASM，这是进阶篇内核章的主题。）

懒加载同样重要。`initGrammars()` 只初始化 WASM 运行时本身；某个语言的 `Language` 只有在扫描发现项目里真的有该语言文件时才编译加载。一个纯 Go 仓库永远不会付出 TypeScript grammar 的内存代价。

### 运行时的几个坑，以及 CodeGraph 的应对

真实工程里 WASM 运行时有三个著名的坑，本仓的应对方式都值得欣赏：

**坑一：并发初始化竞态。** Node 20+ 上多个 `Parser` 并发加载不同 grammar 会触发上游 issue #2338 的崩溃。所以 `loadGrammarsForLanguages()` 用朴素的 for 循环顺序加载，注释直说原因。慢一点，但正确。

**坑二：堆碎片化。** tree-sitter 的 WASM 堆在几千次解析后碎片累积，最终抛 `memory access out of bounds`。应对是周期性重建：worker 每 5000 次解析调用 `resetParser(language)` 删掉重来（`parse-worker.ts:65`），连接池回收 worker 时也顺手 reset。此外每棵解析树的 `tree.delete()` 放在 `finally` 里——树占用的原生堆对 V8 的 GC 完全不可见，不手动释放就永远不还。

**坑三：OOM 即崩溃。** 碎片化积累到极限就是硬崩。CodeGraph 的策略不是防御而是**拥抱**：捕获到 OOM 后原样 re-throw，worker 进程 `process.exit(1)`，池检测到死亡后用一个干净的新进程顶替。与其在半损坏的堆上挣扎，不如快速换血。

还有一个更隐蔽的坑值得单独一节。

### V8 turboshaft 与 `--liftoff-only`

Node ≥22 的 V8 引入 turboshaft 作为 WASM 的优化编译器后，大型 grammar（TypeScript、C++ 这种几 MB 的 WASM）在优化编译阶段会耗尽 V8 每次编译的 Zone arena，报 `Fatal process out of memory: Zone`——注意这与系统内存无关，多少都没用。解法是让 WASM 永远停留在 Liftoff（baseline）层，即给 node 进程传 `--liftoff-only`。

问题在于这个标志必须在 **V8 引擎初始化时**读取。CodeGraph 试过所有事后注入的路子并逐一记录了失败原因（`src/extraction/wasm-runtime-flags.ts`）：`v8.setFlagsFromString` 太晚；Worker 的 execArgv 被 node 拒绝；`NODE_OPTIONS` 白名单不含它。唯一可行的方案是**自我重执行**：

```ts
// src/extraction/wasm-runtime-flags.ts:119
spawnSync(process.execPath,
  [...NODE_RUNTIME_FLAGS, ...WASM_FLAGS, ...preservedArgs, scriptPath, ...args],
  { env: { ...process.env, CODEGRAPH_WASM_RELAUNCHED: '1' } });
process.exit(result.status);
```

`CODEGRAPH_WASM_RELAUNCHED=1` 防止无限递归。副作用是多出一个中间进程——host 被杀时 PPID watchdog 会看到 ppid 变成中间进程而不是宿主，于是真宿主的 pid 被塞进 `CODEGRAPH_HOST_PPID` 穿透下去（进阶篇 MCP 章会回收这条线）。npm 发布的捆绑版 launcher 则直接带着标志启动 node，无需重执行。

## 非典型用法之一：不用 `.scm` Query

tree-sitter 官方推荐的高效模式是 Query API：写一份 `.scm` 文件声明模式匹配（`(function_declaration name: (identifier) @fn.name)`），由 C 层高效执行。全仓 grep 找不到任何一处 `Query(` 调用——CodeGraph 刻意不走这条路。

取而代之的是一个三件套结构：

1. **声明式配置表**。每种语言一个 `LanguageExtractor`（接口在 `tree-sitter-types.ts:80`），内容全是 AST 节点类型名字符串：`functionTypes: ['function_declaration', 'arrow_function']`、`nameField: 'name'`、`bodyField: 'body'`……外加约 30 个可选 hook；
2. **单一通用 walker**。6790 行的 `tree-sitter.ts` 只有一个手写递归的 `visitNode()`，按 `node.type` 对配置表做 if/else 分派：落在 `functionTypes` 就走 `extractMethod`，落在 `callTypes` 就走 `extractCall`……
3. **逃生 hook**。语言结构太特殊时（PHP 的 trait-use、Scala 的 val/var），`visitNode` hook 接管整棵子树，返回 true 则主 walker 不再下钻。

这样设计的账是这样算的：30 种语言共享一个 walker 意味着"新增一种语言 = 一个几百行的配置文件"，而 `.scm` 方案意味着 30 份各自维护的模式文件加上一套跨语言的捕获命名约定。更重要的是，通用 walker 让**跨语言统一的后处理**成为可能——docstring 提取、qualified-name 构建、contains 边自动生成这些逻辑只写一次。

代价同样真实：`extractCall()` 一个方法约 850 行，里面塞着 Erlang MFA、Ruby receiver 字段名差异、C++ 链式调用编码等特例分支。这是可维护性与覆盖广度之间做出的明确取舍。

## 非典型用法之二：同一棵语法树的两套实现

2024 年末起，CodeGraph 引入了 `codegraph-kernel/`——一个 napi-rs 的 Rust crate，用 Rust 侧的 tree-sitter 绑定**重新实现**了 TS walker 的行为等价物。它不改变架构，只是替换 parse+extract 这一步：输入 `(filePath, content, language)`，输出五块平坦的二进制 buffer，一次跨界返回。

于是同一个文件可能走两条路：默认路由到内核（20 种主流语言）；含 `ERROR` 节点的文件、或内核不可用时，回落到 WASM。两条路必须产出**字节级一致**的图——为此 vendored WASM 中 TS/JS/Java/Python/Go/C/C++/Rust 等 grammar 与内核 Cargo.toml 锁定同一 revision，并有专门的 kernel-grammar-parity 测试断言 node-kind 表相等。

这段历史最好的注脚是 `grammars.ts:275` 的注释：vendored wasm 不是为了绕过上游 bug 就是为了和内核保持同源。"图的中立性"（graph-neutrality）在这里被当作硬性验收标准。

## 小结

把这一章的内容压缩成三句话：tree-sitter 给了 CodeGraph 一个**跨 30 种语言、带错误恢复、字段寻址**的统一语法树接口；WASM 化让它在任意用户机器上零编译安装；而"配置表 + 通用 walker"的组织方式让语言支持成为加法题。下一章我们进入数据模型——先看这套机制吐出来的东西长什么样。
