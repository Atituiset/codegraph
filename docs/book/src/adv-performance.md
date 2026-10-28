# 性能工程：watchdog、WAL 与内存纪律

> **本章要解决的问题**:前面各章的性能手段(批量窗口、worker 池、内核加速)散落各处,但它们都服从同一条军规:**主线程任何停顿不得超过 60 秒**——因为有一个子进程在数着心跳,超时会直接 SIGKILL 你。本章把散落的机制收拢,看这条军规如何塑造了整个代码库的异步形状,以及当两个正确目标打架时(快 vs 活着)谁赢。

最后一章把散落各章的性能机制收拢成一张图。这个仓库的性能工程有一个总纲，先立在此处：

> **任何主线程停顿不得超过 60 秒**（#850 liveness watchdog 的硬约束）。所有异步代码的形状——逐语句 yield、离线程化、双窗口超时——都是这条约束的推论。

## 心跳的三种织法

"别让事件循环饿死"说起来一句话，做起来有三种手法：

**合作式 yield。** 长循环（引用解析、合成 pass、索引重建）周期性调用 `createYielder()` 产出的 `maybeYield()`，让出事件循环让 timer 和 I/O 回调得以执行。endBulkEdgeLoad 重建索引时甚至给每条 CREATE INDEX 之间插 `setImmediate`——单条重建就是 ~20s 的全表扫描，三条连跑就撞线。

**离线程化。** 不能切片的工作整个搬走：WAL checkpoint、PRAGMA optimize 用 eval:true 的内联 Worker 源码在独立连接上执行；查询走 worker 池；解析、存储各有专职 worker。主线程只保留协调职责。

**进度感知的宽限。** 心跳静默不一定是卡死，可能是慢盘上的合法长语句。liveness-watchdog 的 progressPaths 在超时时检查 DB/WAL 的 size/mtime 快照：前进了就宽限（上限 10×timeout=10 分钟）。"区分慢和死"是这个设计最聪明的一步。

## 超时的诚实化

与心跳配套的是一套"假超时"防护。朴素实现里，worker 超时就杀——但 parse-pool 的注释记录了一个反例：主线程同步执行 SQLite store 会推迟 timer phase 的处理，worker 的结果明明已经到了却"迟到"，朴素超时把健康的 worker 杀了。修正后的语义是：base timer 到期**只标记** `timerExpired` 并继续接受迟到结果（worker 自报 parseMs 用于事后归因），3 倍硬窗口之后才真杀。per-parse 预算还随文件大小缩放：`min(base + len/100KB × 10s, max(base,20s))`——#1555 里一个数据头文件曾吃掉 4.5 分钟才被硬杀。

## WAL 截流阀：一个完整的状态机样本

存储章埋的伏笔在这里兑现。`wal-valve.ts` 解决的问题链值得完整复述一遍：

默认 `wal_autocheckpoint=1000` 页在批量索引期间反复把热 B-tree/FTS 页重写进主库文件——实测占全部磁盘 I/O 的 **95%**，HDD 上 45 秒的任务变 19 分钟。所以 indexAll 关闭自动 checkpoint，写入变成纯顺序 WAL 追加。但无限推迟是另一种死法：WAL 每 COMMIT 复制热页，3.3k 文件的索引曾涨出 5.9GB 的 WAL，第一次读取要 >60 秒——健康索引被自己的 watchdog 击毙。

Valve 的关键洞察是一个反直觉的事实：**WAL 文件的尺寸永不缩小**。完整回填后 writer 下次 commit 从顶部循环覆写，文件大小不再反映积压量。所以 valve 维护 `sizeAtLastFullBackfill` 基线（只在 checkpoint 报告 busy===0 且 log===checkpointed 时刷新），按**超出基线的增长量**决策：

- soft 线（默认 clamp(dbSize/4, 256MB, 2GB)）：后台发起离线程 PASSIVE 回填；
- hard 线（2×soft）或裸文件尺寸超 fileCap（4×soft）：暂停 writer，parked barrier 下强制整段回填直到一次完整回填报告，此时无 reader 才敢 TRUNCATE 切小文件；
- **futility latch**：连续两次因 reader 钉住而放弃 ⇒ 60s 内禁用暂停机制，退化回旧行为而不是每次越界烧 20 个线程——这正是某次 OOM（exit 137）的事故现场教训；
- **铁律：对活跃 writer 绝不 TRUNCATE**——truncate checkpoint 会赢锁竞争然后阻塞 writer 整个回填时长，超过 5s busy_timeout 直接令索引报 "database is locked" 失败。

一段 343 行的代码里塞进了背压、基线、熔断、屏障四种模式，而且每一种都能指回一个具体事故。

## 内存纪律

WASM 与原生堆的内存问题在本仓有一套组合拳：

- parser 每 5000 次解析重建（堆碎片化）、池 worker 每 250 次 recycle；
- `tree.delete()` 放 finally——树的原生内存对 GC 不可见；
- OOM 即崩溃即换血（worker process.exit(1)，池顶替新进程）；
- resolver 缓存全部 LRU 有界（max 1000）+ generation tag（依赖中的边在增长时缓存必须失效）；
- 内核路径干脆不让 per-node 对象存在（kernelBuffers 直通 store 边界）;
- 长命 reader 会钉住 WAL checkpoint 进度（实测 deletes 从 42.6s 恶化到 118.8s），所以池 worker 在空闲边界关开连接，QueryBuilder 只清语句缓存保住上层 warm cache。

## 大库上的两个极端手段

最后两招属于"常规手段失效后"的范畴：

**O(1) 重建**。中毒索引（#1065：160 万节点、多 GB WAL）上，逐行 DELETE 会触发 FTS delete-trigger 风暴，开索引之前就把 watchdog 拖死。`CodeGraph.recreate` 直接 unlink 数据库三件套再初始化——删除一个文件的复杂度从 O(nodes) 变成 O(1)。

**reader rebind**。池 worker 的读连接定期关开（rebind，db/queries.ts:459）释放对 checkpoint 的钉扎，代价只是下次使用时重新 prepare 语句。性能账算得非常细：warm cache 保住、语句缓存重编，净收益为正。

## 收束：性能与正确性的同构

回顾全书，会发现本仓的性能工作与正确性工作遵循同一个元模式：**每个机制都锚定在一个可复现的事故上，每个事故都沉淀为一条带编号的不变式。** #850 给出 60 秒约束，#1231 给出 WAL 基线方案，#1090 给出入队去重规则，CG-33 给出 ORDER BY……这不是巧合，而是工程文化：不允许"看起来会更好"的改动，只接受"修掉 #xxx"或"A/B 数据支持"的改动。

读源码时遇到任何费解的防御性写法，先找它的 issue 编号——那通常比代码本身好懂得多。
