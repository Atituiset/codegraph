# 动态分发与合成边

> **本章要解决的问题**:引用解析再聪明,也只能连接语法树上*写得出来*的调用。但 `notifyChange()` 循环里那句 `cb()` 到底会调到谁?AST 不知道——答案藏在运行时的注册关系里。静态分析在这里有个原则性的天花板:**看不见的调用,任何解析器都无中生有不了。** 本章讲 CodeGraph 怎么用"启发式合成"在天花板上开洞,以及开洞的代价。

引用解析能处理的调用都有共同前提：**AST 里存在静态可见的被调名字**。但现代代码库中大量数据流不满足这个前提——回调注册、事件总线、React 重渲染、依赖注入、消息队列。这些边在 AST 中根本不存在，任何解析器都无中生有不了。

CodeGraph 的回答是第三条生产边通道：**合成**。`callback-synthesizer.ts`（5,471 行）在解析完成后扫描整张图，用启发式模式推断"这里虽然没写 `f()`，但实际上会调用 f"，补上 `kind:'calls'`、`provenance:'heuristic'` 的边。

## 为什么值得：一条断链的价值

先看动机。agent 问"更新元素怎么触发重渲染"，图上真实的链路是：

```
mutateElement → triggerUpdate → [回调注册] triggerRender → [setState→render] render → [JSX 子组件] StaticCanvas.renderStaticScene
```

三个方括号处都是动态分发，静态解析全部断链。没有合成边时，explore 工具只能把断链前后的片段分别给出，agent 不得不 Read 文件自己接上——实测这种"半桥接"状态反而把 Read 次数从基线的 9–10 次推高到 5–10 次：agent 看到了一半答案，于是更执着地想读完另一半。

只有把 **jsx-child 这一跳也补上**之后，Read 才降到 0–2 次。这个实验（记录在 CLAUDE.md 和 coverage playbook）确立了一条铁律：

> **部分覆盖比零覆盖更糟。** 桥接了一个边界却不桥接下一个，等于给 agent 展示了一条它注定走不完的路。每个新 synthesizer 上线前必须验证整条 flow 端到端闭合。

## 合成边的形状

所有合成边遵守统一契约：

```ts
{ source, target, kind: 'calls',
  provenance: 'heuristic',
  metadata: {
    synthesizedBy: 'react-render',        // 哪个 pass 造的
    registeredAt: 'src/scene.ts:142',     // 接线点：注册/绑定发生在哪一行
  } }
```

`registeredAt` 是点睛之笔。注释解释："This is the #1 thing an agent reads/greps to explain the flow."——当 agent 想确认"triggerRender 真的会被调用吗"，它需要的不是更多源码而是那个注册位置；有了行号，一次 codegraph_node 就能验证，不用 Grep。

## 两大通道形态

43 个 pass 大多归结为两种模式（文件头 L1–23 给出了范式）：

**形态一：字段背书的观察者。**

```
onChange(cb) { this.listeners.add(cb); }      // registrar（登记者）
notifyChange() { for (cb of this.listeners) cb(); }   // dispatcher（分发者）
taskRepo.onChange(logCompletion)              // registration（接线）
      ⇒ 合成 notifyChange → logCompletion
```

识别靠命名门 + 体切片。真实代码(`fieldChannelEdges`,callback-synthesizer.ts:165,有删节):

```ts
for (const m of methodAndFunctionNodes(queries)) {   // 惰性迭代器,#610 OOM 教训
  if ((++scanned & 255) === 0) await onYield();      // #1091:大图扫描中途让出心跳
  const isReg  = REGISTRAR_NAME.test(m.name);
  const isDisp = DISPATCHER_NAME.test(m.name);
  if (!isReg && !isDisp) continue;
  const src = sliceLines(ctx.readFile(m.filePath), m.startLine, m.endLine);
  if (isReg)  { const f = registrarField(src);  if (f) registrars.push({ node: m, field: f }); }
  if (isDisp) { const f = dispatcherField(src); if (f) dispatchers.push({ node: m, field: f }); }
}
// 配对阶段:registrar 的每条 incoming calls 边 = 一个潜在接线点
for (const reg of registrars) {
  const chDispatchers = dispatchers.filter(d =>
    d.node.filePath === reg.node.filePath && d.field === reg.field);   // 同文件同 field
  for (const e of queries.getIncomingEdges(reg.node.id, ['calls'])) {
    const line = ctx.readFile(caller.filePath)?.split('\n')[e.line - 1];
    const am = line?.match(new RegExp(`${reg.node.name}\\s*\\(\\s*(?:this\\.)?(\\w+)`));
    if (!am) continue;                                 // 从实参捕获回调名
    const fn = ctx.getNodesByName(am[1]).find(n => n.kind==='method'||n.kind==='function');
    for (const disp of chDispatchers) {
      edges.push({ source: disp.node.id, target: fn.id, kind: 'calls',
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'callback', via: reg.node.name,
          registeredAt: `${caller.filePath}:${e.line}` });   // 接线点入档
    }
  }
}
```

这段代码的每个细节都在实证章的玩具仓库里被验证过——包括它**拒绝工作**的时刻:`addChangeListener` 因不匹配 REGISTRAR_NAME 而静默落空,改名 `onChange` 后 `notifyChange --> logCompletion @src/server.ts:6` 立即出现。启发式的全部智慧押在命名约定上,这正是它既廉价又脆弱的地方。

精度护栏同样清晰:**同文件同 field** 才配对(跨文件的 field channel 会把不相干的类连起来);`MAX_CALLBACKS_PER_CHANNEL=40` 封顶单个 registrar 的扇出;惰性迭代器让内存 O(1) 于节点数(#610 曾因物化全部函数节点在符号密集项目上耗尽数 GB)。

**形态二：字符串键的事件发射器。** `this.on('mount', fn)` 与 `this.emit('mount')` 靠事件名配对，fan-out 上限 6——泛化名字如 'error' 直接跳过，否则一个 error 事件能把几十个 handler 全连上。

## 注册表巡礼

SYNTH_PASSES（L5113）目前 43 个 pass，各自带语言门控。按生态抽样：

- **React 系**：`renderEdges`（class 含 render 且兄弟方法调 `this.setState(` ⇒ 该方法→render；setState 门保证只命中类组件，注释承认 over-approximation 但强调 reachability-correct）；`jsxEdges`（render 返回树里的子组件标签 ⇒ render→子组件）；`thunkEdges`/`rtkEdges`（Redux thunk 与 RTK Query hook 命名约定）；
- **Vue/Pinia/Vuex**：store 的 actions/getters 对象字面量成员在提取层就被提为 function 节点（tree-sitter.ts 顶部的 VUE_STORE_COLLECTION_NAMES），synth 负责把它们接入 dispatch 链；
- **移动端**：Flutter setState、ArkUI 状态/Emitter/Routes、React Native Fabric 事件桥；
- **企业级**：MyBatis（Java mapper 接口 ↔ XML 映射 id）、Spring/MediatR/Celery/Sidekiq/Laravel Event；
- **系统级**：C 函数指针表——这个 pass 有特殊待遇，它调用内核的可选能力 `cfnptrScanFiles()` 在 Rust 侧批量扫描，避免 TS 侧逐文件正则（内核章再会）；
- **Erlang behaviour**：gen_server 回调约定。

执行模型上有个一致性保证：43 个 pass 先各自算完、结果合并去重后**统一插入**。这样无论顺序执行还是池化 fan-out，每个 pass 看到的是同一份提交后的 DB 状态。语言门控用一次 `DISTINCT files.language` 判断——纯 C 仓库直接跳过全部 Kotlin/JVM pass，#1212 记录了不做门控时的 OOM。

## 跨层通道：tier-synthesizer

callback-synthesizer 之外还有一条独立通道：`tier-synthesizer.ts` 处理**跨进程/跨协议**的调用——Web 前端里 `fetch('/api/users')` 到后端路由、消息队列的 job 到 consumer、总线事件到 handler。这类调用连"动态分发"都算不上，而是物理上发生在两个进程之间，图里本来连一个 ref 都没有。合成器用通道名（URL 路径、队列名、事件名）配对两端，边的 metadata 比 callback 更丰富：带 `channel`、`tier` 和 `registeredAt`——前两者记录"哪条通道、属于哪一层"，与接线点一起让下游能验证这条跨界边。

它插在 SYNTH_PASSES 之外、进程内 emitter pass 之前执行，让更具体的边先占位（同一条 (source,target) 对，先到先得）。这标志着合成边从"同仓库内的动态分发"扩展到了"分布式系统的接线图"。

## 边界的诚实

合成边的覆盖范围有清晰的边界声明。CLAUDE.md 把前沿划在这里：

> Reactive/reconciler runtimes are the frontier — flows there have no static edges, so nothing surfaces (**correctly — silent beats wrong**).

Vue 的 Proxy 响应式、Halo 的 ReactiveExtensionClient 这类运行时，注册关系藏在框架内部的反射和代理里，模式匹配不出来。此时正确行为是**沉默**——不给工具输出一个似是而非的假链路。这与"静默优于错边"一脉相承：synthesizer 的野心有边界，而边界之外宁可空白。

另一个边界是成本。每加一个 pass 都是一次全图扫描，所以语言门控、fan-out cap（MAX_CALLBACKS_PER_CHANNEL=40）、pass 合并插入这些工程细节不是洁癖，是让"43 个 pass"在内核规模仓库上仍然秒级完成的必要条件。

至此图的构建全部讲完：tree-sitter 提取静态事实，resolver 补全跨文件绑定，synthesizer 补全动态行为。下一章转向原生内核——当这套管线要在一个 4 万文件的 monorepo 上跑完，解析这一步还有没有数量级的加速空间。
