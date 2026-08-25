# 为 agent 设计工具：codegraph_explore

> **本章要解决的问题**:前几章的读者是工程师;本章的"用户"是一个不看文档、不重试、受挫一次就可能永久拉黑你的 LLM。**怎么让这样的消费者用好一张图?** 答案出人意料:不是教它,而是把工具做到它无法拒绝——并且这个结论是被一组失败的实验反推出来的。

如果说前几章是"怎么把图建好"，这一章是"怎么让一个不会读文档、不重试、一受挫就放弃的消费者用好这张图"。`codegraph_explore` 是整个产品与 agent 的接触面，它的每个设计决定都经过 A/B 实测。

## 方法论：改造工具，而不是改造 agent

CLAUDE.md 里有一段被验证过多次的结论，值得作为本章公理：

> CodeGraph 影响 agent 的通道只有两个低显著度的入口——initialize 指令和工具描述。改变它们**不能**可靠地改变 agent 的工具选择或查询风格（trace-first 措辞实验三次变体全部失败且回退墙钟时间）。有效的是让 agent **已经在调用的工具**对它**已经给出的输入**做更多的事。

翻译成设计语言：不要发明新工具指望 agent 学会用，不要在指令里写使用技巧指望 agent 遵守；把智能做进那个它反正会调的工具里。explore 就是这个公理的产物——它是 agent 默认会碰的那个名字最通用的工具，所以 flow 检索、路径构建、上下文补全全部塞进了它的单次调用里。

## 预算系统：随仓库规模单调

explore 有两套预算，都是文件数的阶梯函数：

| 索引文件数 | 调用预算 | 单次输出上限 | 单文件上限 |
|---|---|---|---|
| <500 | 1 | 18K chars | 3800 |
| <5000 | 2 | 24K | 6500 |
| <15000 | 3 | 24K | 7000 |
| <25000 / ≥25000 | 4 / 5 | 24K | 7000 |

两条硬性不变式写在维护文档里：**更大的档位绝不能拿到更小的 per-file 上限**（回归教训：Excalidraw 的 415KB App.tsx 在某档位只被切了 1% 出来，agent 被迫 Read 全文）；**输出总量不得超过 ~25K 字符**——超过 host 的内联 tool-result cap，结果会被外置成文件让 agent 再读回来，等于重新引入 Read。

预算分配算法（allocateExploreBudget）按 `score × worth × spineBoost` 加权，低于榜首一定比例的非核心文件整体剔除（cliff），每人保底 MIN_CHARS，pinned 文件（查询里点名的路径）权重至少追平最强候选。

## buildFlowFromNamedSymbols：explore 的心脏

agent 调 explore 时给的是一串符号名（这是 initialize 指令反复训练的用法："flow 问题点名跨越流程的符号"）。`buildFlowFromNamedSymbols`（tools.ts:2515）把这些名字变成一条叙事线：

1. **Token 化**：≥3 字符、标识符形状、≤16 个；
2. **共名消歧**：每个 token 经 findAllSymbols 解析；歧义的简单名只有在 container 类也被点名时才保留对应候选——查 "PmsProductServiceImpl list" 时 `list` 绑定到 Pms 的方法而不是 Oms 的同名方法；
3. **主链搜索**：从每个种子 BFS（骑合成边），只接受同为 named 的终点，MAX_HOPS=7，**MAX_BRIDGE=1**——最多容忍连续一跳未命名桥接。这个上限是防走神的缰绳：没有它，搜索会一头扎进 god-function 的扇出里再也出不来；
4. **断链诚实**：链不上的 token 触发三路补充——dynamic boundaries（扫描断链符号 body 里的 computed member/getattr/reflection/bus emit，最多 4 条 bullet 告诉 agent "这里有个运行时分发"）、boundary candidates（约定命名探测如 `onSave`/`handleSave`）、polymorphic boundaries（大同名家族 + 图上可见的多态实现者）。

渲染时 Flow 区段每跳都带内联源码和接线点，合成边标注为 `dynamic: react-render via setState @file:line`——上一章的 registeredAt 在这里兑现价值。

## node 工具：sufficiency 的教科书

explore 找到入口后，agent 用 `codegraph_node` 下钻。这个工具有两种模式：file-only 时是 Read 等价物（字节级对齐 Read 的行格式 + blast-radius 头部）；symbol 模式则体现"sufficiency 原则"——**答案要完整到让 agent 不需要第二个来源**：

- 返回完整函数体 + caller/callee 轨迹；
- **歧义名一次返回所有重载的 body**（12K 预算、硬顶 16 个）。Alibaba/gin 上的实测教训：agent 猜错重载后会去 Read 文件找正确的那个——一次调用给全，Read 就永远不会发生。

## 错误形状即行为工程

tools.ts 的错误处理哲学值得单独背诵。`execute()` 的 catch 分三类：

- `NotIndexedError` → **成功形状**的文本指引（告诉 agent 怎么索引/换 projectPath），绝不 isError；
- `PathRefusalError` → 干净的 isError（希望 agent 放弃这条敏感路径）;
- 真故障 → isError 附带"可重试一次"提示。

为什么未索引不算错误？因为维护者反复观察到：**一两次 isError 就会让 agent 整个会话弃用 codegraph**。agent 的行为模型里，工具报错 = 工具坏了 = 回到 Grep。所以一切预期内的状态都用成功形状传递语义。忙碌、过载同理（query-pool 的 busyGuidance 也是成功形状）。

## 会话感知与去重

daemon 是跨会话共享的，但探索历史必须按会话隔离（CG-17）：两个 agent 同时工作，去重历史互相污染会闹出"你没给我看过这个"的冤案。ExploreSessionState 挂在 session 对象上，容量限额齐全（4 项目 × 8 次调用 × 24 文件）。跨调用的重复内容折叠成一句指针："Already sent earlier in this conversation"——指令里专门解释这是指针不是缺口，防止 agent 把折叠当成信息缺失而重新请求。

## 验证方法论

这套设计的验收标准同样值得一提（详见 docs/benchmarks/ 与 CLAUDE.md）：每个改动跑 with/without codegraph 的 A/B，至少两轮取范围（n=1 的结论一律不作数）；模型固定 Sonnet——刻意用"地板模型"验证，强模型的工具使用能力会掩盖 affordance 缺陷，而在弱模型上成立的改进才能向下泛化到用户实际在用的各种 agent；CLI 被钩子阻断防止 without 臂偷偷用 Bash 调 codegraph 污染数据。Excalidraw 工作样例的最终数字：0–2 Read / 0–4 Grep / 3–4 codegraph / 51–74s，对照无图基线的 9–10 Read / 两分钟以上。

## 本章小结

explore 的设计可以压缩成一个反馈回路：agent 点名符号 → 工具给出端到端的流 → 答案足够完整 → agent 停手。每一环都有对应的工程机制（消歧、合成边、sufficiency 输出、预算控制），而回路的总开关是那条元原则：**别教育 agent，把工具做到它无法拒绝。**
