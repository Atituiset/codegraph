# 提取器:一行代码怎么变成图上的点

这一章跟踪一个函数的一生。主角还是实证篇那位:

```ts
export function completeTask(id: string): Task | null {
  const result = taskRepo.complete(id);
  return result;
}
```

索引结束后,图上多了什么?一个 `function` 节点 `completeTask`,一条 `completeTask → complete` 的 calls 边,一条指向 `taskRepo` 的 references 边。本章就回答:**这中间发生了什么。**

## 第一步:代码变成树

tree-sitter 先把源码切成语法树。对第一行,大致是:

```
export_statement                    ← export 关键字在这层!
└── function_declaration
    ├── name: "completeTask"        ← name 字段直接定位名字
    ├── parameters: (id: string)
    └── body: statement_block
        └── return_statement ...
```

两个对后文至关重要的观察:**其一**,每个标识符挂在有名字的字段上(`name:`),提取器不需要写正则去猜;**其二**,`export` 在外面包了一层——这个"包装"稍后会坑我们一次。

## 第二步:认出"这是个函数"

CodeGraph 不为每种语言写解析器,而是每语言交一张**配置表**(TypeScript 的在 `languages/typescript.ts`,全文 307 行):

```ts
functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
classTypes:    ['class_declaration'],
methodTypes:   ['method_definition', 'public_field_definition'],
callTypes:     ['call_expression'],
nameField: 'name',  bodyField: 'body',
```

然后一个 9,745 行的通用 walker(`tree-sitter.ts`)拿着这棵树逐节点问配置表:"你的 functionTypes 认识 `function_declaration` 吗?"认识,于是调用 `extractFunction`:取 name 字段、生成 id、压入结果列表。

为什么不用 tree-sitter 官方更快的 Query(.scm)模式?因为 29 种语言要共享同一套后处理(docstring 提取、qualified_name 拼接、contains 边自动生成)——一个 walker 让这些逻辑只写一次,新语言的成本从"重写一遍"降为"填一张表"。速度损失换来的是覆盖广度,这笔账在静态分析工具里通常这么算。

### 一个真实的坑:class 字段算方法还是属性?

看这两个类成员:

```ts
onChange(cb) { this.listeners.add(cb); }   // 明明是个函数
private tasks = new Map();                 // 明明不是
```

麻烦在于 TS 语法树把**两者**都标成 `public_field_definition`——语法层面它们都是"字段初始化",分不出语义。早期版本一律提为 method,后果是类的形状全错、按类型过滤全部失效(事故 #808)。现在的解法是一个裁决 hook:只有初始化值是函数(箭头函数、或包在 HOF 里如 `onScroll = throttle(...)`)才判 method。这就是"配置表 + walker"模式的日常:通用逻辑管流程,**语言的坑用 hook 填**。

## 第三步:记下"这里有个调用"——只记名字

walker 走到 `taskRepo.complete(id)` 这个 call_expression 时,发生了一件初看很奇怪的事:它**不查任何东西**,只是往清单里塞一张纸条:

```ts
{ fromNodeId: 'func:abc123',      // 谁在调
  referenceName: 'taskRepo.complete',  // 名字而已!
  referenceKind: 'calls',
  line: 34 }
```

没有 target。类比:**快递单上只写了收件人姓名,没写地址。**

为什么不顺手查清?因为提取跑在并行 worker 里(默认池大小 `max(3, availableParallelism())`,可用 `CODEGRAPH_PARSE_WORKERS` 覆盖),此刻别的文件可能还没入库——worker 根本无从知道 `complete` 定义在哪。强行查就得加锁串行,并行白做了。于是设计反转:**先收集所有纸条,等全部文件入库后,由专门的"分拣中心"(下一章的解析阶段)统一配送。** 这就是贯穿本书的"两阶段"结构的第一半。

## 特例博物馆:三件展品

真实语言的调用形态千奇百怪,walker 里塞了一个约 1,200 行的特例区。挑三件感受一下尺度:

**Erlang 的 spawn**:`spawn(Mod, Fun, Args)` 的真正被调方藏在参数里,不在调用位置。walker 维护一张 spawn 家族名单,命中就去参数里搜 (模块名, 函数名) 对,把它提升为边——否则所有 Erlang 进程的行为对图隐形。

**字面量接收者不发边**:`", ".join(parts)` 的接收者是字符串字面量——直接放弃,什么都不记。注释只有六个字:"静默优于错边"。这是全书出现频率最高的原则:下游 agent 会沿着错边走向无关代码然后自信地胡说,断链顶多让它去 Read。

**函数作为值**:`btn.on('click', this.handleClick)` 里 handleClick 没有括号,长得不像调用。专门的捕获层认出这种形态发纸条,但加了严格门控:名字必须匹配本文件定义或本文件 import 才放行——否则 C++ 里满地的 `begin()/end()` 会变成几千条假回调边。

## 最后一步:并行的计算,串行的提交

多个 worker 各自吐结果,谁先完成看 CPU 心情——但落库顺序**必须按文件序**。为什么如此较真?回忆数据模型章:同名引用最终绑定到"插入序最先"的候选。如果提交顺序随机,同一个仓库建两次索引会得到两张不同的图,增量 sync 和全量重建的结果也会漂移(实测差 4.3% 的边)。

所以调度器维护一个游标:结果乱序到达先缓冲,轮到哪个文件才提交哪个。**并行是性能手段,确定性是正确性前提,后者永远赢。**

## 带走三句话

1. 配置表 + 单一 walker:新语言 = 填表,语言的坑 = hook;
2. 调用在提取期只是纸条(名字+行号),目标留到第二阶段——这是并行的代价,也是两阶段结构的由来;
3. 宁可断链不可错边:字面量接收者、歧义回调,一律静默放弃。
