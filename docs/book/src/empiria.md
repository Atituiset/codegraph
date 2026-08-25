# 实证:一张图是怎么长出来的

前面几章讲的是机制;这一章做实验。我们在 `/tmp/opencode/taskflow` 造了一个 3 文件的 TypeScript 微型项目——刻意埋进三类"考点":观察者模式(考合成边)、Express 路由(考框架提取)、类继承(考引用解析)——然后用本仓构建出的 CLI 真实索引它,直接打开 SQLite 检查每一个中间产物。所有输出都是原样摘录。

## 样本与索引

```ts
// src/audit.ts(节选)
class TaskRepository {
  private listeners = new Set<() => void>();
  onChange(cb: () => void): void { this.listeners.add(cb); }
  private notifyChange(): void {
    for (const cb of this.listeners) cb();
  }
  complete(id: string): Task | null { /* ... */ this.notifyChange(); }
}
export const taskRepo = new TaskRepository();
export function logCompletion(): void { console.log('a task was completed'); }
export function completeTask(id: string): Task | null { return taskRepo.complete(id); }
```

```bash
$ codegraph init .
◆  Indexed 3 files
●  19 nodes, 29 edges in 480ms
```

480 毫秒里发生了什么?按架构章的流水线逐段对账。

## 第一站:nodes 表——kind 判定的现场

```sql
SELECT kind,name,start_line FROM nodes ORDER BY kind,name;
```

```
class      TaskRepository        5
constant   app                   5      ← server.ts 里的 express() 调用结果
constant   taskRepo             27
file       audit.ts / repository.ts / server.ts
function   completeTask         29
import     ./audit  ./repository ×2  express
interface  Task                  1
method     addChangeListener     8      ← TaskRepository::addChangeListener
method     notifyChange         12
method     complete             16
property   listeners             6      ← TaskRepository::listeners
property   tasks                24
route      GET /health          16      ← src/server.ts::GET:/health
route      GET /tasks/:id/complete  7
```

三个值得停留的细节:

**`onChange` 为什么是 method 而 `listeners` 是 property?** 两者在 TS AST 里都是 `public_field_definition`/`method_definition` 家族的节点。`onChange` 有箭头函数体之外还有方法签名;真正的分野发生在 #808 引入的 `classifyTsClassMember`:值为 callable 的类成员判为 method,否则 property。`private tasks = new Map(...)` 的值是 `new` 表达式而非函数,所以落为 property。

**route 节点从哪来?** tree-sitter 对 `app.get('/tasks/:id/complete', ...)` 只会看到一个 call_expression。是 Express 框架提取器(`resolution/frameworks/express.ts`)用正则匹配路由头、平衡括号扫描切出 handler、然后创建了这两个 `kind:'route'` 节点,qualified_name 形如 `src/server.ts::GET:/health`。注意 route 节点的 line(16 和 7)精确对应路由声明行。

**import 节点是符号不是语句。** `./repository` 出现两次是因为 audit.ts 和 server.ts 各 import 了它一次——每个 import 声明产生自己的节点,文件级的依赖关系由后面的 imports 边表达。

## 第二站:edges 表——三种 provenance 的同框

```
provenance    kind          edge
tree-sitter   calls         complete -> notifyChange
tree-sitter   calls         completeTask -> complete
tree-sitter   calls         server.ts -> completeTask
tree-sitter   calls         GET /tasks/:id/complete -> completeTask   ★
tree-sitter   contains      TaskRepository -> onChange/notifyChange/complete/listeners/tasks
tree-sitter   imports       server.ts -> ./audit  ./repository  completeTask  taskRepo ...
tree-sitter   instantiates  audit.ts -> TaskRepository               ← `new TaskRepository()`
tree-sitter   references    completeTask -> taskRepo  complete -> Task ...
```

★ 那条边值得单独解释:route 节点到 `completeTask` 的 calls 边**不是** tree-sitter 提取的——它是框架提取器从内联箭头 handler 的 body 里提出调用名后,作为普通 UnresolvedReference 进入解析管线、再经 import 解析(`server.ts` 第 2 行 import 了 `completeTask`)绑定成功的。框架层和通用管线在这里完成了一次接力。

## 第三站:一次失败的实验——合成边为什么没出现

样本第一版里,注册方法的命名是 `addChangeListener`,dispatcher 叫 `notifyChange`。索引完成后查询合成边:

```sql
SELECT ... FROM edges WHERE provenance='heuristic';
-- 结果:0 行
```

图断了:`complete → notifyChange` 之后没有下一跳,agent 问"任务完成后通知谁"会得到一条断链。为什么?

翻开 `callback-synthesizer.ts` 的 `fieldChannelEdges`(L179),第一步就是名字门:

```ts
const isReg  = REGISTRAR_NAME.test(m.name);    // /^(on[A-Z]|subscribe|addListener|register|watch|listen|addCallback)/
const isDisp = DISPATCHER_NAME.test(m.name);   // /(emit|trigger|notify|dispatch|fire|publish|flush)/i
if (!isReg && !isDisp) continue;
```

`notifyChange` 含 "notify",过 dispatcher 门;但 `addChangeListener` 不匹配 REGISTRAR_NAME 的任何约定分支(`addListener` 是,`addChangeListener` 不是)。启发式的本质在此暴露无遗:**它不理解语义,只认约定**。这不是 bug 而是精度护栏——如果任何 "add*" 方法都算 registrar,`listeners.add(cb)` 这种集合操作会把图炸成噪声网。

把方法改名为 `onChange` 再索引,合成边出现了:

```sql
SELECT ns.name||' --> '||nt.name AS e, e.metadata FROM edges e
JOIN nodes ns ON ns.id=e.source JOIN nodes nt ON nt.id=e.target
WHERE e.provenance='heuristic';
```

```
notifyChange --> logCompletion
   synthesizedBy: callback | registeredAt: src/server.ts:5
```

`src/server.ts:5` 正是接线行 `taskRepo.onChange(logCompletion)`。回看 `fieldChannelEdges` 的实现,这条边的诞生路径完全可复述:registrar 的 incoming `calls` 边找到调用方(server.ts 文件节点),取该行的源码,用 `` new RegExp(`${reg.node.name}\\s*\\(\\s*(?:this\\.)?(\\w+)`) `` 从 `taskRepo.onChange(logCompletion)` 里捕获实参名 `logCompletion`,按名查到 function 节点,与同文件同 field 的 dispatcher 配对成边。**每一步都是纯机械的字符串与图操作——启发式的全部智慧都押在了命名约定上,这正是它既廉价又脆弱的地方。**

## 第四站:unresolved_refs——失败者的名单

```sql
SELECT status, reference_kind, reference_name FROM unresolved_refs;
```

```
failed   instantiates  Set              ← JS builtin,黑名单其实拦了大半,漏网的停在这
failed   calls         cb               ← 局部回调变量,静态不可知
failed   calls         console.log log
failed   imports       express          ← package.json 声明了依赖但我们没 npm install
failed   calls         app.get get      ← 方法链,resolver 拆链需要类型信息
failed   calls         res.status json  ← DOM/框架对象成员
failed   calls         if               ← 甚至有控制流关键字被当调用捕获
```

这张表是"静默优于错边"的实物证据:`res.json` 大概率永远不该连向任何业务符号, park 在这里比猜一个目标正确得多。同时它也是 sync 重试机制的原料库——如果将来装上 node_modules 并重建,express 相关引用就有复活机会。

## 第五站:name_segment_vocab——给 FTS 补的人间词汇

FTS5 把 `notifyChange` 当作单个 token,搜 "change" 永远命中不了它。拆词表解决了这件事:

```
segment     name
change      addChangeListener
change      notifyChange
completion  logCompletion
complete    GET /tasks/:id/complete
get         GET /health
```

"change" 一词反查出两个方法——正是 agent 用自然语言提问时需要的桥梁。

## 第六站:explore 的真实输出

最后让消费者登场。CLI 直驱工具层(与 MCP 同一实现):

```bash
$ codegraph explore "task complete notifyChange logCompletion render"
```

```
**Flow (call path among the symbols you queried)**

1. complete (src/audit.ts:16)
   ↓ calls
2. notifyChange (src/audit.ts:12)
   ↓ dynamic: callback via `onChange` @src/server.ts:5
3. logCompletion (src/audit.ts:29)

> Full source for these symbols is below...

**Blast radius — what depends on these (update/verify before editing)**

- `completeTask` — 2 callers in `src/server.ts`; no tests found within 3 caller hops
- `logCompletion` — 2 callers in `src/audit.ts`, `src/server.ts`; ...

**Source Code**
> The code below is the **verbatim, current on-disk source** ... Treat each block
> as a Read you have already performed: do not Read a file shown here.
```

逐段解读这个输出的设计意图:

1. **Flow 区段打头**,因为它是查询的直接答案。第 2→3 跳标注 `dynamic: callback via \`onChange\` @src/server.ts:5`——上一站的合成边在此兑现:agent 不仅知道 notifyChange 会调 logCompletion,还拿到了验证用的接线位置,不需要任何 Grep;
2. **Blast radius 其次**:编辑这些符号前该检查什么。"no tests found within 3 caller hops" 是诚实的能力边界声明;
3. **源码最后**,且带着那句关键指令:"Treat each block as a Read you have already performed"。这句话是说给 agent 听的——它把"读过了"的状态直接注入 agent 的行为模型,阻止后续冗余 Read。整份输出没有一句"请使用 xx 工具继续查",因为指令章的教训是:**别教育 agent,把答案做到它无法拒绝**。

## 实验结论

一个 3 文件、34 条边的玩具项目,走完了全部六站,每一站都验证了前文的一个论断:kind 判定靠 hook(#808)、route 来自框架层、合成边靠命名约定且失败时静默、失败引用 park 待复、段词表桥接自然语言、explore 输出为 agent 的停止条件而设计。真实仓库只是把这些数字放大三四个数量级,机制一字不变。
