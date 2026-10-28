# 引用解析：两阶段流水线

> **本章要解决的问题**:提取章留下一堆纸条——"第 34 行有个叫 `taskRepo.complete` 的调用"。纸条上只有名字。现在所有文件都入库了,该把每张纸条送到正确的收件人手里。听起来像查个数据库?难点在于:`complete` 可能同时存在于五个类;`getUserId` 可能是本地的也可能是 import 来的;`res.json` 压根不该连向任何业务符号。**怎么在几百万张纸条里,又快又不出错地完成配送**——这就是本章。

提取器留下的几十万条 UnresolvedReference——只有名字、没有目标——如何变成图上真实的边？这是整个仓库算法密度最高的部分，也是"静默优于错边"原则执行最严格的地方。

## 为什么必须两阶段

第一阶段（提取）跑在并行 worker 里，为了速度牺牲了全局视野：它不知道别的文件里有什么符号、import 指向哪里。第二阶段（解析）在索引基本落库后运行，此时可以查询完整的符号表和 import 图。两阶段的交接面就是 `unresolved_refs` 表：

```
pending ──解析成功──▶ 行被删除，边被创建
   │
   └─解析失败──▶ status='failed'，记录 name_tail
```

失败行**不删除**而是 park 起来（#1240），理由读一遍就忘不掉：一条引用所在的文件如果从此不再变更，删掉它的失败记录就意味着永远失去复活机会——直到某个**别的**文件新增了能满足它的导出符号时，只有全量重建才能补上这条边。park 住，sync 才有重试的原料。name_tail 辅助这个场景：`util.greet` 失败时存下尾段 `greet`，将来新出现的 `greet` 符号能通过尾段匹配找到重试入口。

## resolveAndPersistBatched：主循环

`resolution/index.ts:2471` 的主循环是双缓冲流水线：

```
warmCachesYielding()                     ← 流式收集全部已知名字（同步版曾阻塞 28s）
batch = getUnresolvedReferencesBatchAfter(0, 5000)   ← keyset 分页，非 OFFSET
loop:
  beginBatch(batch)                      ← 大批且池健康 → fan-out 给 resolver worker
  nextBatch = 预取下一批                  ← prefetch 与当前批并行
  result = settleBatch(...)
  createEdges(result.resolved)           ← ★ 边必须先于下一批 fan-out 持久化
  insertEdges(chunk 1000 + yield)
  delete 已解 refs（按 rowId）
  mark 未解 refs 为 failed
```

四个设计点：

**keyset 分页替代 OFFSET。** OFFSET 在有大量 failed 前缀时会每次重走整段跳过区，内核规模实测 54.6 秒。`WHERE status='pending' AND id > ?` 让每一页都是索引直达。

**edges-before-fanout 顺序约束。** 后面的批次会读到前面批次刚建的 extends/implements 边（resolveMethodOnType 要沿超类型链走），所以已解边的持久化必须先于下一批的计算 fan-out。dubbo 上验证过：乱序执行会把 typed-receiver 的置信度从 0.9 掉到 0.65——不是崩溃，而是悄悄变笨。

**按 rowId 删除。** #1269 的教训：按 (fromNode, name, kind) 键删除会连带删掉同 caller 同 callee 不同行的兄弟行——当批次边界恰好切开同一个函数的多个同名调用点时，后面那半的边就永远不会被创建了。rowId 精确制导。

**并行池门槛 150k。** `minRefsForPool()` 默认 150,000 条引用才启用 worker 池——中型仓库实测池化反而更慢（分发开销大于收益）。自适应逻辑还会观察前几批耗时：投影出本批 ≥400ms 且没试过池化时中途启动。一切以实测为准，不做理论最优。

## resolveOne：策略阶梯

单条引用的解析是一个有序的策略瀑布（`resolveOne` L1398 起），每级要么给出带置信度的答案，要么放行给下一级。先看真实骨架：

```ts
resolveOne(ref: UnresolvedRef): ResolvedRef | null {
  if (this.isBuiltInOrExternal(ref)) return null;          // ① builtins

  // ② 快速预过滤:名字在任何地方都不存在、不是本地 import、
  //    框架也不认领 → 直接放弃。import 逃生的注释值得读:
  //    re-export 改名链(import { login } from './barrel')会
  //    调用一个"任何地方都没有声明"的名字,必须放行
  const preFilterPass =
    this.hasAnyPossibleMatch(existenceName) ||
    this.matchesAnyImport(ref) ||
    this.frameworks.some(f => f.claimsReference?.(ref.referenceName));
  if (!preFilterPass) return null;

  // ③ function_ref 严格通道:this.<member> 只对 enclosing class
  //    的自有成员解析——"never a same-named symbol elsewhere"
  if (ref.referenceKind === 'function_ref') { ... }

  // ④ JVM FQN 直查 qualifiedName 索引:
  //    "即使多个包里都有 Bar 也无歧义"
  const jvmImport = resolveJvmImport(ref, this.context);
  if (jvmImport) return jvmImport;

  const candidates: ResolvedRef[] = [];

  // ⑤ 框架优先,confidence ≥0.9 早退
  for (const framework of this.frameworks) {
    const result = this.gateFrameworkLanguage(framework.resolve(ref, this.context), ref);
    if (result?.confidence >= 0.9) { fwEarly = result; break; }
    if (result) candidates.push(result);
  }
  if (fwEarly) return fwEarly;

  // ⑥ import 解析(相对/别名/工作区),≥0.9 早退……
  // ⑦ ……然后才是 name-matcher 打分与 fuzzy(见下文)
}
```

阶梯的排序逻辑是**信息含量递减**:builtins 是确定的知识,预过滤是廉价的否定,JVM FQN 是结构化的肯定,框架知识是领域特权,import 是半结构化线索,最后的同名打分是纯启发式。越靠前的通道给出的答案越可信,所以高置信度结果(≥0.9)允许中途早退,低置信度的一律进 candidates 池最后择优。

几个特判也值得一读。CFML 组件路径(`extends="coldbox.system.web.Controller"`)用点分路径命名超类型,L864 的处理注释以 "silent beats wrong" 收尾——全路径字符串流落到下游只可能错配。Razor 的 `@using` 命名空间解析则展示了相反的场景:`CatalogBrand` 在 DTO 和领域实体两处同名,只有文件头的 using 列表能裁定该连哪个。

**第 ½ 级：快速预过滤。** `hasAnyPossibleMatch` 用 knownNames 集合做存在性检查（处理 `a.b` 尾段、JVM FQN 尾段等各种分隔符形状），这一步把绝大多数垃圾引用挡在了昂贵匹配之外。

**function_ref 严格通道。** 函数值引用走专用路径：先查 import，再 matchFunctionRef，**永不到 fuzzy**。bareFnOnly 语言（TS/JS/C++/Python/PHP）里裸标识符只匹配 function 目标。"unique-or-drop"——两个候选都像就都不选。

**JVM FQN 直查。** Java 的全限定名直接命中 qualified_name 索引，零歧义。

**框架优先于通用匹配。** 36 个框架 resolver 有机会先认领引用（confidence ≥0.9 早退）：Express 认领 middleware 命名约定，Spring 认领注解模式……它们掌握通用 matcher 不可能知道的领域知识。

**import 解析。** `resolveViaImport` 回答"这个名字是从哪个文件来的"。相对导入逐扩展名探测（`.ts,.tsx,.d.ts,.js,/index.ts...`，每种语言一张候选表）；别名导入按 tsconfig paths（递归解析 extends！）→ workspace packages → legacy 硬编码的顺序尝试；Cargo workspace 的成员 glob 由独立模块提供；Go 用 go.mod 的 module path 判定本地包。有一类特殊：C/C++ include、COBOL copybook、PHP include **只解析到文件节点且失败时不回落到符号名匹配**——注释的理由就是那句 mantra："a wrong edge is worse than none"。头文件路径歧义太大，宁可断链。

**同名消歧打分。** 到达 name-matcher 的引用已经排除了所有结构化线索，只剩名字。matchByExactName 对多候选打分：同文件最强，其次是目录邻近度（公共目录段 ×15、上限 80）、同语言族（jvm/apple/web/c/dotnet 四族，跨族引用直接禁掉）、函数方法优先、exported 优先。但首先有个天花板：**AMBIGUOUS_NAME_CEILING = 500**，超过直接放弃——#999 里 vendored 主题目录让一个名字撞出几千个候选，O(K²) 打分直接把进程拖死。fuzzy 匹配只在唯一候选时生效，camelCase 词重叠才敢算数。

## 第二遍：等边建好的那些引用

第一遍有两种引用注定失败，它们被收进内存中的 deferred 队列（必须是内存态——DB 里的行已经被删了）：

**链式调用（#750）。** `Foo::instance().bar()` 编码成的 `instance().().bar` 形状需要知道 `instance()` 的返回类型才能继续，而返回类型信息要沿 implements/extends 边找 conformance——这些边第一遍还没建完。于是 `resolveChainedCallsViaConformance` 在主 pass 结束后运行：clearCaches 重读新鲜边，逐条拆链。receiver 类型来自 inner callee 的 returnType（提取器 getReturnType hook 存的）或 self/static 标记；resolveMethodOnType 的 conformance fallback 经 generation-tagged memo 走超类型图——memo 必须 tagged，因为 supertype 边在循环中持续增长，普通缓存会冻结早期批次的空答案。

**this 成员回调（#808）。** `btn.on('click', this.handleClick)` 注册在子类，handleClick 声明在父类 `FormBase`。第一遍既没有继承边也做不了类型推断。deferred 版本的实现是个漂亮的图算法：上溯起点锚定为 **ref 自己文件里的同名 class 节点**——注释强调 "never a same-named class elsewhere; rails has a dozen `Engine`s"，曾经按名字找起点导致每个 Engine 的父类被合并出错边——然后 node-anchored BFS 沿 implements/extends 上溯（深度上限 5），在每个超类型上沿 contains 边找同名成员，命中给 0.85 置信度。

两个 deferred pass 的共同哲学：**不是所有事都能一次做完，但每件事都应该在它能做对的最早时刻做。**

## sync 时的正确性维护

增量同步对解析层的挑战比全量更微妙。三个机制值得记住：

**复活（resurrection）。** sync 删除文件前，先把指向它的入边还原成原始引用文本存回 unresolved_refs。关键细节是 edge metadata 里存了 `refName`——原始引用文本而非 target 名字。从 `h.greet` 的 target 还原只能得到 `greet`，丢掉 receiver 上下文后重新解析的绑定范围会比全量重建宽。原文的表述值得抄录："a faithful resurrection, so re-resolution can never bind anywhere a full re-index wouldn't."

**改绑（rebind, CG-33）。** 一个未 touch 的文件引用了 `helper.parse`；这次 sync 里 helper 文件变了，parse 的定义移动或消失。definitionDelta 在 sync 前后采样 `(file, name)` 定义对，差集驱动 `resurrectStaleResolutionEdges` 把受影响文件的旧边重新裁决。body-only 编辑产生空 delta，零成本通过。实测这个机制纠正了 4.3% 的边——增量正确性的成本远比想象高。

**孤儿清扫（#1187）。** 进程中途被杀会在 unresolved_refs 里留下 pending 行。不变式："after a COMPLETED pass nothing it processed is still 'pending'"——于是任何静止状态的 pending 行都属于中断的运行，sync 开头批量磨平即可。这让 `codegraph sync` 成为 wedged index 的标准恢复命令。

## 本章小结

两阶段流水线一句话概括：**第一阶段用并行换速度、用暂存表换视野；第二阶段用策略阶梯换精度、用 deferred 队列换依赖顺序的正确处理。** 所有环节共享同一条底线——不确定的时候宁可断链，因为下游有一个会沿着错边走向深渊的 agent。

下一章处理解析永远做不到的事：那些根本没有静态调用点的动态分发。

