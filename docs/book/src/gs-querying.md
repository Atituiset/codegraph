# 查询层:对这张图提问

图建好了,本章用**三个真实提问**走完消费侧。每个问题对应一种查询机制,也各带一个值得记住的坑。

## 提问一:"搜 logCompletion"——搜索是瀑布,不是一次查询

`searchNodes(query)` 听起来是一次 FTS 查询,实际是一个**四级降级瀑布**:每一级都假设上一级会空手而归。

**第一级:FTS 全文匹配。** 用户输入先清洗:`::` 换成空格(Rust/C++ 的路径分隔符,不拆开会把 `stage_apply::run` 黏成一个词)、FTS 特殊字符剥掉、布尔关键字(AND/OR)剔除防止注入语法,然后每个词加引号加前缀通配:

```
"logCompletion"*  →  命中,排序交给 BM25
```

BM25 的列权重表值得背下来:`bm25(nodes_fts, 0, 20, 5, 1, 2)`——name 权重 20,碾压 qualified_name(5)和 docstring(1)。设计意图:**名字里命中远比文档里顺嘴一提值钱**。还有个一行代码的暗坑:SQLite 的 BM25 返回负数,源码里 `Math.abs(row.score)` 不是装饰,漏了它整个排序方向就反了。

**第二级:LIKE 子串。** FTS 为什么会空手?"signIn" 搜 "Sign" 这种大小写/分词错位时就会。回落到 `LIKE '%..%'`,并用 CASE WHEN 给出人工分数:精确 1.0、前缀 0.9、包含 0.8。

**第三级:编辑距离模糊。** 还空?容忍 1–2 个字符的拼写错误再扫一遍。这个 Levenshtein 实现做了滚动数组 + 提前剪枝,快到敢拿去扫几万个名字。

**第四级兜底之后还有补场**:无论如何都跑一次精确名查找(`lower(name) = lower(?)`,走表达式索引)。因为 BM25 有个盲区——搜 "getBean" 时,几百个含 getBean 的长名会把真身埋在深处;精确名几乎总是用户要的那个。

四级结果最后统一进**多信号重排**:函数/method 加 10 分、test 文件减 15 分、路径与查询词相关度加分、整名相等加 80 分……所有分数只用于排序——它们量纲不同(BM25 无界,模糊分 0–1),混着比大小没有意义。

## 提问二:"谁调用了 complete?"——遍历的四个不变式

`getCallers(id)` 背后是教科书 BFS 加四个防身补丁(`traverseBFS`,graph/traversal.ts:48)。直接看代码骨架,注释即人话:

```ts
const enqueued = new Set([start.id]);   // 排过队的
const visited  = new Set();             // 已入场的

while (queue.length > 0 && nodes.size < limit) {
  const step = queue.shift();
  if (visited.has(step.node.id)) continue;
  visited.add(step.node.id);            // 入场盖章

  // 邻居先批量取回,再逐边处理(否则就是 N+1)
  const neighborNodes = this.queries.getNodesByIds(wantIds);

  for (const edge of adjacentEdges) {
    if (!visited.has(next) && !enqueued.has(next)) {
      if (nodes.size >= limit) continue;      // 补丁③:每个入队点查预算
      enqueued.add(next); queue.push(...);
    }
    // 补丁④:按五元组身份去重后再记录这条边
    if (!seenEdges.has(edgeKey(edge))) edges.push(edge);
  }
}
```

四个补丁各自堵一个真实的洞(括号内为事故编号):

1. **enqueued 和 visited 必须分开**(排号 ≠ 入场)。合并的话,经两条平行边可达的目标会被排队两次,第二次出队撞上 visited 直接跳过——它的邻接边就丢了(#1090);
2. **边也要去重**:双向遍历时同一条 A→B 边会从两端各见一次;
3. **预算在每个入队点检查**,不能只在循环口——一个热门节点的百个邻居能一口气冲爆上限(#1087);
4. **邻居按 contains < calls < 其他排序出队**,让输出"先内部结构、后外部引用",符合阅读直觉。

这些补丁单看都是废话,少任何一个都是线上 bug——所以每个都挂着编号,**防止后人当冗余清理掉**。读任何遍历类源码,优先找这类守卫,它们是作者踩坑史的化石层。

顺带回答一个设计疑问:getCallers 的边类型清单里为什么有 `instantiates`(实例化)?因为 `new TaskRepository()` 本质上就是在调用构造器——不算上的话,查类的 callers 只剩 import 它的文件,而 trace 也会在"函数→类→方法"处断掉。

## 提问三:"改了 Task 接口影响谁?"——影响半径是一收一放

`getImpactRadius` 沿所有入边向上游爬,但有一条刻意的排除规则:**contains 边不传播**。"容器包含成员"不等于"依赖此成员"——不排除的话,改一个方法签名,影响半径会先爬到父类、再展开父类的所有兄弟成员,爆炸成半个仓库。

反向却要做**容器下探**:焦点如果是 class/interface 这种容器,主动沿 contains 进入成员、以同等深度继续上溯。道理同样朴素——改类签名当然波及其方法的调用者。

一收一放之间,是对"依赖"这个词的语义建模,而不是无脑的图可达性。

## 从查询到答案:ContextBuilder 与诚实脚注

前三问是积木,`buildContext("修复登录超时")` 是把它们组装成一份 markdown 报告的高层入口:检索定位种子 → 图扩展补周边 → 截取代码块 → 格式化输出。三个设计细节:

- **预算单位是字符不是 token**——token 化需要额外依赖,字符数是稳定够用的代理指标;
- **单文件占比设上限**(约 20%):防止一个巨型文件把配额吃光,输出变成"该文件的独白";
- **low-confidence 是一等公民**:多词散文查询若没有入口被两个以上的词共同佐证,结果打上低置信标记并在输出里追加诚实脚注。对 agent 来说,"我不确定"比自信的错答有用得多——它触发的是换策略,而不是沿着错误方向深挖。

## 带走三句话

1. 搜索是瀑布:FTS → LIKE → 模糊 → 精确名补充,统一重排但分数只用于排序;
2. 遍历的四个不变式全是事故化石,enqueued≠visited 是其中最反直觉的一个;
3. 影响半径 = 上溯排除 contains + 焦点容器下探;"包含"不等于"依赖"。
