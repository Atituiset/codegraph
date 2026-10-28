# MCP 服务器与进程拓扑

> **本章要解决的问题**:一个本地索引服务,用户是 IDE 和 agent 会话——它们随时被杀、被重启、被挂起。**你的进程怎么知道自己该死、不该死、还是该替别人收尸?** CodeGraph 的答案是一套五层 watchdog 加三模式启动决策。读之前先记住一个视角:这里每个看似过度的机制,都对应一种真实发生过的崩溃形态(括号里的编号就是病历)。

`src/mcp/` 是仓库里最"工程"的部分：协议、daemon、watchdog、worker 池。它回答一个朴素的问题——**当你的用户是一个不靠谱的宿主（IDE）和一个会话式的 agent 时，一个本地服务要怎么活下来？**

## 三种启动模式

`MCPServer.start()` 的决策树很短：

1. `CODEGRAPH_DAEMON_INTERNAL=1` → 本进程就是 detached daemon；
2. `CODEGRAPH_NO_DAEMON=1` → direct 模式，单 stdio 会话自给自足；
3. 找不到 `.codegraph/` 根 → 也走 direct（没什么可共享的）;
4. 否则 → **proxy 模式**（默认路径）。

默认拓扑值得画出来：

```
Claude Code ──spawn──▶ proxy 进程 ──socket──▶ detached daemon
Cursor       ──spawn──▶ proxy 进程 ──socket──▶ （同一个）
opencode     ──spawn──▶ proxy 进程 ──socket──▶
```

host 启动的 proxy 是个轻量转发器，daemon 才持有全部重状态（CodeGraph 实例、watcher、查询池）。这样设计的原因（#411）：daemon 是 detached 独立进程组，关掉一个终端不会杀掉其他客户端的会话；而每个 host 仍然拥有自己的 proxy，proxy 带着 PPID watchdog——host 被 SIGKILL 后也能回收自己。**每个组件只负责自己的死亡，不假设别人的生命周期。**

## socket 协议与锁仲裁

POSIX 上 daemon 监听 `.codegraph/daemon.sock`（路径过长则退到 tmpdir），Windows 上是命名管道 `\\.\pipe\codegraph-<hash>`。连接建立的第一件事是身份握手：

```
daemon → 一行 JSON: { codegraph: version, pid, socketPath, protocol: 1 }
proxy  → 校验版本后开始字节转发；可选回发 { codegraph_client: 1, pid, hostPid }
```

两个细节体现了防御深度。其一，proxy 自报 pid 是为了 daemon 能做死客户端扫描——Windows 命名管道的 close 事件不可靠（#692），主动 sweep 比被动等待可靠。其二，握手读取器在 finish 前**必须 `socket.pause()`**：移除 data listener 不会让 flowing stream 停下来，unshift 回去的尾字节会在零监听者状态下被丢弃——#662 记录的这个 wedge 让整个会话挂起。

daemon 单例靠文件锁仲裁，实现是教科书级的原子性操作：先把完整 JSON 写进 temp 文件，然后 `fs.linkSync()` 落位到锁路径——link 在目标已存在时失败且原子，杜绝了 O_EXCL create 与 write 之间被插入第二个 daemon 的微秒窗口。无硬链接的文件系统（ExFAT）回退 'wx' 标志打开。

## 生命周期：三种死亡方式

daemon 怎么知道自己该退场？三个独立机制覆盖三种形态：

- **正常空闲**：最后一个客户端断开后 linger 300s（env 可调），然后退出；
- **幽灵客户端**：close 事件永远不来（Windows 管道问题、host 崩溃）——每 30s 扫描一次，对每个客户端做 proxy/host pid 存活探测，全灭才退场。backstop 兜底 30 分钟硬上限。措辞很讲究："绝不杀 live-but-quiet 会话";
- **孤儿 launcher**：见下节 watchdog 家族。

## watchdog 家族

这是本仓可靠性设计的精华，五层机制各对应一种事故形态：

**EARLY_PPID**（`early-ppid.ts`）。CLI 的第一个 import 就记录 `process.ppid`。动机（#1185）：launcher 若在头 ~100ms 被 SIGKILL，等代码跑起来时 ppid 已经 reparent 成 1，基于 ppid 变化的检测永远不会触发。所以要在最早的时刻拍快照。

**ppid-watchdog**。每 5s 对比当前 ppid 与快照——变了就是父进程死了，自杀。Windows 的 ppid 恒定，改用对原始 ppid 做 liveness 探测（平台差异又一次被显式建模而非假装不存在）。

**startup-handshake**。#1185 的另一种形态：host 杀了 launcher 链但 stdin 管道被第三方持有，stdin 永远不 EOF，PPID 检测失效。兜底是 15 分钟内没收到任何 stdin 字节即视为被遗弃的 launch，自行退场。第一个字节到达即解除武装。

**liveness-watchdog**。前面四层管"父进程死了"，这层管"自己卡了"。#850 发现主线程陷入非分配的原生循环时（比如 SQLite 长语句），V8 isolate 到不了 safepoint，连 worker 线程的 watchdog 都会饿死。解法是用**子进程**：parent 每 tick 向 child stdin 写心跳，child 超时 60s 收不到就 SIGKILL parent——子进程没有共享堆，内核信号无视父线程状态。误杀防护是 progressPaths：心跳静默期间检查 DB/WAL 文件的 size/mtime 快照，前进了说明是慢盘上的合法长语句，宽限（上限 10×timeout）。

**liftoff 中间进程的补偿**。提取章讲过 `--liftoff-only` 重执行会插入中间进程，PPID 检测从此失真。补偿是把真 host pid 通过 `CODEGRAPH_HOST_PPID` env 穿透到最终进程，watchdog 直接 poll 它。

五层机制合起来是一张完整的死亡语义表。读这段代码最好的姿势不是记细节，而是问"如果去掉这一层，哪种崩溃形态会成为孤儿/僵尸/冻结？"——每一层都有明确的答案。

## 冷启动竞态与查询池

agent 会话的头几秒是最脆弱的。engine.ts 用三招压冷启动：惰性 `require('../index')` 把 sqlite/graph 层推迟到首次工具调用；initialize 握手**先响应再做重活**（#172）；后台 catchUpSync 作为一次性 gate——首个工具调用等它完成，保证 agent 看到的索引不会落后于磁盘太多。

查询并发用 worker 池解决（daemon 模式）：同步的 node:sqlite 共享一个事件循环，10 个并发 explore 曾把宏任务饿死 25 秒无心跳。池里每个 worker 各持一条 WAL 读连接（WAL 的多读单写模型正好支持），主线程只剩写入和协调。熔断保护齐全：worker 崩溃重试一次、预算 12 次后标记 unhealthy 回退进程内执行；过载时返回**成功形状**的"忙，稍候重试"而不是错误——理由见下一章的错误形状哲学。

## 工具面总览

tools.ts（8,825 行）定义八个工具：search / callers / callees / impact / node / explore / status / files。但默认只暴露一个——`DEFAULT_MCP_TOOLS = new Set(['explore'])`（L1953），其余可用 env 重新启用。这个激进的决定来自实测：agent 面对 8 个工具时会平均用力，explore 的采用率反而下降；只给它一个，flow 问题的解决路径就唯一了。小仓库的差异不在工具面，而在 explore 的调用预算——<500 文件时一次调用就该答完（下一章的预算分档）。

工具行为的核心设计在 explore 和 node 两个工具上，它们是"为 agent 设计工具"方法论的集中体现——值得单独一章（下一章）。

最后提一句指令面：`server-instructions.ts` 是 MCP initialize 响应返回的使用指南，也是全仓**唯一**的 agent 指导真源。曾经 installer 会往 CLAUDE.md/AGENTS.md 里写一份复制品，两处漂移后（issue #529）被砍掉——现在工具指导只此一份。
