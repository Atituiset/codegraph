# 实证:一张图是怎么长出来的

前面几章讲的是机制;这一章做实验。我们在 `/tmp/taskflow` 造了一个 3 文件的 TypeScript 微型项目——刻意埋进三类"考点":观察者模式(考合成边)、Express 路由(考框架提取)、类继承与接口(考引用解析)——然后用本仓构建出的 CLI 真实索引它,直接打开 SQLite 检查每一个中间产物。所有输出都是原样摘录(本版校准于 2026-10-27 的 main)。

## 样本与索引

```ts
// src/repository.ts
export interface Task {
  id: string;
  title: string;
  done: boolean;
}
```

```ts
// src/audit.ts
import { Task } from './repository';

class TaskRepository {
  private listeners = new Set<() => void>();
  private tasks = new Map<string, Task>();

  onChange(cb: () => void): void { this.listeners.add(cb); }

  private notifyChange(): void {
    for (const cb of this.listeners) cb();
  }

  add(id: string, title: string): Task {
    const task: Task = { id, title, done: false };
    this.tasks.set(id, task);
    return task;
  }

  complete(id: string): Task | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.done = true;
    this.notifyChange();
    return task;
  }
}

export const taskRepo = new TaskRepository();

export function logCompletion(): void {
  console.log('a task was completed');
}

export function completeTask(id: string): Task | null {
  return taskRepo.complete(id);
}
```

```ts
// src/server.ts
import express from 'express';
import { completeTask, logCompletion, taskRepo } from './audit';
import { Task } from './repository';

const app = express();
taskRepo.onChange(logCompletion);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/tasks/:id/complete', (req, res) => {
  const task: Task | null = completeTask(req.params.id);
  if (!task) { res.status(404).json({ error: 'not found' }); return; }
  res.json(task);
});

app.listen(3000);
```

`package.json` 里声明了 `express` 依赖,但**刻意不 `npm install`**——后面会看到这件事在 unresolved_refs 表里留下痕迹。

```bash
$ codegraph init .
●  Indexed 3 files
●  24 nodes, 41 edges in 1.9s
```

不到 2 秒里发生了什么?按架构章的流水线逐段对账。

## 第一站:nodes 表——kind 判定的现场

```sql
SELECT kind, name, file_path, start_line FROM nodes
WHERE kind != 'file' ORDER BY kind, name;
```

```
class       TaskRepository               src/audit.ts:3
constant    app                          src/server.ts:5
constant    taskRepo                     src/audit.ts:28
function    completeTask                 src/audit.ts:34
function    logCompletion                src/audit.ts:30
import      ./audit                      src/server.ts:2
import      ./repository                 src/audit.ts:1
import      ./repository                 src/server.ts:3
import      express                      src/server.ts:1
interface   Task                         src/repository.ts:1
method      add                          src/audit.ts:13
method      complete                     src/audit.ts:19
method      notifyChange                 src/audit.ts:9
method      onChange                     src/audit.ts:7
property    done                         src/repository.ts:4
property    id                           src/repository.ts:2
property    listeners                    src/audit.ts:4
property    tasks                        src/audit.ts:5
property    title                        src/repository.ts:3
route       GET /health                  src/server.ts:8
route       GET /tasks/:id/complete      src/server.ts:12
```

(24 = 上表 21 个符号节点 + 3 个 file 节点。)

四个值得停留的细节:

**`onChange` 为什么是 method 而 `listeners` 是 property?** 两者在 TS AST 里都是类成员定义节点。真正的分野发生在 `classifyTsClassMember`(`src/extraction/languages/typescript.ts:29`,#808 引入):值为 callable 的类成员判为 method,否则 property。`private tasks = new Map(...)` 的值是 `new` 表达式而非函数,所以落为 property。

**接口成员也是节点。** `id`/`title`/`done` 三个 property 来自 `interface Task`——接口字段同样进入符号表,并用 contains 边挂在 Task 下。接口在"图"里不是二等公民。

**route 节点从哪来?** tree-sitter 对 `app.get('/tasks/:id/complete', ...)` 只会看到一个 call_expression。是 Express 框架提取器(`src/resolution/frameworks/express.ts`)用正则匹配路由头、平衡括号扫描切出 handler、然后创建了这两个 `kind:'route'` 节点,qualified_name 形如 `src/server.ts::GET:/health`。route 节点的行号(8 和 12)精确对应路由声明行。

**import 节点是符号不是语句。** `./repository` 出现两次是因为 audit.ts 和 server.ts 各 import 了它一次——每个 import 声明产生自己的节点;文件级依赖由 imports 边表达,被 import 的名字还会各自长出一个 import 节点(`completeTask`/`logCompletion`/`taskRepo`/`Task`)。

## 第二站:edges 表——provenance 的同框

```sql
SELECT e.kind, ns.name AS src, nt.name AS dst, e.provenance
FROM edges e JOIN nodes ns ON ns.id=e.source JOIN nodes nt ON nt.id=e.target
ORDER BY e.kind, src;
```

```
calls        GET /tasks/:id/complete -> completeTask
calls        complete -> notifyChange
calls        completeTask -> complete
calls        server.ts -> onChange
calls        server.ts -> completeTask
contains     Task -> id / title / done
contains     TaskRepository -> listeners / tasks / onChange / notifyChange / add / complete
contains     audit.ts -> ./repository / TaskRepository / taskRepo / logCompletion / completeTask
contains     repository.ts -> Task
contains     server.ts -> express / ./audit / ./repository / app
imports      audit.ts -> repository.ts / Task
imports      server.ts -> audit.ts / completeTask / logCompletion / taskRepo / repository.ts / Task
instantiates taskRepo -> TaskRepository
references   add -> Task, complete -> Task, completeTask -> taskRepo, completeTask -> Task, server.ts -> Task, server.ts -> logCompletion
NULL         notifyChange -> logCompletion        ← 唯一带 provenance 的行,见第三站
```

先解释一个表象:普通提取边的 `provenance` 是 **NULL**(schema 里的默认值)——只有合成边才写 `'heuristic'`。所以这张表同框的是"无标记的事实边"与"有出身的启发式边",这个不对称本身就是设计:不确定的东西必须自报家门,确定的东西无需背书。

★ 那条 route 到 `completeTask` 的 calls 边**不是** tree-sitter 提取的——它是框架提取器从内联箭头 handler 的 body 里提出调用名后,作为普通 UnresolvedReference 进入解析管线、再经 import 解析(`server.ts` 第 2 行从 `./audit` import 了 `completeTask`)绑定成功的。框架层和通用管线在这里完成了一次接力。

## 第三站:一次失败的实验——合成边为什么没出现

样本第一版里,注册方法的命名是 `addChangeListener`,dispatcher 叫 `notifyChange`。索引完成后查询合成边:

```sql
SELECT count(*) FROM edges WHERE provenance='heuristic';
-- 结果:0 行
```

图断了:`complete → notifyChange` 之后没有下一跳,agent 问"任务完成后通知谁"会得到一条断链。为什么?

翻开 `callback-synthesizer.ts` 的 `fieldChannelEdges`(L165),第一步就是名字门:

```ts
const isReg = REGISTRAR_NAME.test(m.name);   // /^(on[A-Z]\w*|subscribe|addListener|addEventListener|register|watch|listen|addCallback)$/
const isDisp = DISPATCHER_NAME.test(m.name); // /(emit|trigger|notify|dispatch|fire|publish|flush)/i
if (!isReg && !isDisp) continue;
```

`notifyChange` 含 "notify",过 dispatcher 门;但 `addChangeListener` 不匹配 REGISTRAR_NAME 的任何分支(`addListener` 是,`addChangeListener` 不是;`on[A-Z]` 要求名字**以** "on" 开头,而它是 `add` 开头)。启发式的本质在此暴露无遗:**它不理解语义,只认约定**。这不是 bug 而是精度护栏——如果任何 "add*" 方法都算 registrar,`listeners.add(cb)` 这种集合操作会把图炸成噪声网。

把方法改名为 `onChange` 再索引,合成边出现了:

```sql
SELECT ns.name||' --> '||nt.name AS e, e.metadata FROM edges e
JOIN nodes ns ON ns.id=e.source JOIN nodes nt ON nt.id=e.target
WHERE e.provenance='heuristic';
```

```
notifyChange --> logCompletion
   {"synthesizedBy":"callback","via":"onChange","field":"listeners","registeredAt":"src/server.ts:6"}
```

`src/server.ts:6` 正是接线行 `taskRepo.onChange(logCompletion)`。回看 `fieldChannelEdges` 的实现,这条边的诞生路径完全可复述:registrar 的 incoming `calls` 边找到调用方(server.ts 文件节点),取该行的源码,用正则从 `taskRepo.onChange(logCompletion)` 里捕获实参名 `logCompletion`,按名查到 function 节点,与同 field 的 dispatcher 配对成边。**每一步都是纯机械的字符串与图操作——启发式的全部智慧都押在了命名约定上,这正是它既廉价又脆弱的地方。**

## 第四站:unresolved_refs——失败者的名单

```sql
SELECT status, reference_kind, reference_name FROM unresolved_refs;
```

```
failed  instantiates  Set
failed  instantiates  Map
failed  calls  this.listeners.add
failed  calls  cb
failed  calls  this.tasks.set
failed  calls  this.tasks.get
failed  calls  console.log
failed  imports  express          ← package.json 声明了依赖但我们没 npm install
failed  imports  express
failed  calls  express
failed  calls  app.get
failed  calls  app.listen
failed  calls  res.json
failed  calls  res.status
failed  calls  res.status().json
```

这张表是"静默优于错边"的实物证据:`res.json` 大概率永远不该连向任何业务符号,park 在这里比猜一个目标正确得多。两个细节值得注意:

- **成员链被完整保留**:`res.status().json`、`this.tasks.get` 这类链式名字整体入表——失败也是结构化失败,复活时能拿到全部线索;
- **它也是 sync 重试机制的原料库**:如果将来装上 node_modules 并重建,express 相关引用就有复活机会。

## 第五站:name_segment_vocab——给 FTS 补的人间词汇

FTS5 把 `notifyChange` 当作单个 token,搜 "change" 永远命中不了它。拆词表解决了这件事:

```
segment      name
change       notifyChange
change       onChange
complete     complete
complete     completeTask
complete     GET /tasks/:id/complete
completion   logCompletion
get          GET /health
get          GET /tasks/:id/complete
task         Task / TaskRepository / completeTask / taskRepo
tasks        GET /tasks/:id/complete / tasks
...
```

"change" 一词反查出两个方法——正是 agent 用自然语言提问时需要的桥梁。

## 第六站:explore 的真实输出

最后让消费者登场。CLI 直驱工具层(与 MCP 同一实现):

```bash
$ codegraph explore "task complete notifyChange logCompletion render"
```

```
**Flow (call path among the symbols you queried)**

1. complete (src/audit.ts:19)
   ↓ calls (when task)
2. notifyChange (src/audit.ts:9)
   ↓ dynamic: callback via `onChange` @src/server.ts:6
3. logCompletion (src/audit.ts:30)

> Full source for these symbols is below — the call flow among them, followed by their bodies.
**Blast radius — what depends on these (update/verify before editing)**

- `complete` (src/audit.ts:19) — 1 caller in `src/audit.ts`; no tests found within 3 caller hops
- `completeTask` (src/audit.ts:34) — 2 callers in `src/server.ts`; no tests found within 3 caller hops
- `logCompletion` (src/audit.ts:30) — 2 callers in `src/audit.ts`, `src/server.ts`; no tests found within 3 caller hops
- `notifyChange` (src/audit.ts:9) — 1 caller in `src/audit.ts`; no tests found within 3 caller hops

**Source Code**

> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. Treat each block as a Read you have already performed: do not Read a file shown here.
```

逐段解读这个输出的设计意图:

1. **Flow 区段打头**,因为它是查询的直接答案。第 2→3 跳标注 `dynamic: callback via \`onChange\` @src/server.ts:6`——第三站的合成边在此兑现:agent 不仅知道 notifyChange 会调 logCompletion,还拿到了验证用的接线位置,不需要任何 Grep。第 1→2 跳的注解 `(when task)` 来自条件分支分析:这条调用发生在"task 存在"的守卫内;
2. **Blast radius 其次**:编辑这些符号前该检查什么。"no tests found within 3 caller hops" 是诚实的能力边界声明;
3. **源码最后**,且带着那句关键指令:"Treat each block as a Read you have already performed"。这句话是说给 agent 听的——它把"读过了"的状态直接注入 agent 的行为模型,阻止后续冗余 Read。整份输出没有一句"请使用 xx 工具继续查",因为指令章的教训是:**别教育 agent,把答案做到它无法拒绝**。

## 实验结论

一个 3 文件、41 条边的玩具项目,走完了全部六站,每一站都验证了前文的一个论断:kind 判定靠 hook(#808)、route 来自框架层、合成边靠命名约定且失败时静默、失败引用 park 待复活、段词表桥接自然语言、explore 输出为 agent 的停止条件而设计。真实仓库只是把这些数字放大三四个数量级,机制一字不变。

如果你手痒想复现:整个实验只需上面三个文件 + `codegraph init .` + 任意 SQLite 客户端。改一个方法名再 `codegraph sync .`,就能亲眼看到第三站的合成边出现与消失。
