# 数据模型:图长什么样

读源码最忌讳的一件事:还没见过数据,就先背结构。所以这一章不从 types.ts 开始,从**查询结果**开始——下面是我们实证篇那个玩具仓库索引完成后,nodes 表里的真实数据(节选):

```
kind       name             line   qualified_name
---------  ---------------  ----   --------------------------
class      TaskRepository      3   TaskRepository
method     complete           19   TaskRepository::complete
method     notifyChange        9   TaskRepository::notifyChange
function   completeTask       34   completeTask
route      GET /health         8   src/server.ts::GET:/health
file       audit.ts            1   src/audit.ts
```

六行,六个字段。整张 nodes 表几十个字段看着吓人,但真正天天被用到的问题只有五个:**它是什么(kind)、叫什么(name)、全名叫什么(qualified_name)、住在哪(file_path)、身份证号是多少(id)**。其余字段(docstring、签名、可见性……)都是给下游查询加料的。

## 身份证:为什么 id 里掺了行号

```ts
// src/extraction/tree-sitter-helpers.ts:18
id = `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).slice(0,32)}`
```

第一眼会觉得奇怪:函数挪一行,id 就变了,所有指向它的边都得重连——这不是自找麻烦吗?

恰恰相反,**这是把"清理"外包给了数据库**。SQLite 的外键都带 `ON DELETE CASCADE`:节点删掉,边自动跟着消失。于是"某函数整体下移了两行"这种最烦人的变更,处理方式变成了零成本的两步——旧行删了(边级联没了)、新行建了。sync 不需要任何"检测符号移动"的特殊逻辑。你会在本书反复看到这个思路:**与其维护昂贵的对应关系,不如让关系便宜到可以随手重建。**

## 全名:七个 Factory 的故事

`qualified_name` 长这样:`TaskRepository::complete`。它由提取时的"命名空间栈"拼出来——文件顶部如果有 `namespace Foo\Bar;`(PHP)或 C++ namespace,就先压栈,里面每个符号的名字都带上前缀。

为什么要费这个事?Laravel 仓库里有**七个**叫 `Factory` 的接口,分布在不同的命名空间。如果图只用裸名字,`use Illuminate\Contracts\Factory` 这种引用永远说不清指向哪一个;有了全名,精确匹配一击命中。第 8 章讲解析时会反复回到这一点。

## 边:自带信任等级

边表更简单,核心就四列:谁(source)指向谁(target)、什么关系(kind)。真正值得注意的是第五列 **provenance**(出身):

| provenance | 含义 | 实证篇里的例子 |
|---|---|---|
| `NULL` | 语法树上明摆着写的(提取层写入时不打标,即 schema 默认值) | `completeTask → complete`(代码里真有括号) |
| `heuristic` | 合成器推断的动态调用 | `notifyChange → logCompletion`(回调,AST 里看不见) |

类型定义里还预留了 `'tree-sitter'` 与 `'scip'` 两种取值(`src/types.ts`),前者是历史兼容位,后者为外部索引格式预留。为什么要在边上刻"你是怎么来的"?因为下游的信任策略不同:explore 工具愿意骑 heuristic 边给你接通流程,但会显式标注"dynamic:",让你知道这段是推断、可以去 `registeredAt` 记录的接线位置核实。CRG 对比章里我们见过它的兄弟——置信度分数——同一问题的两种解法。

## 两张辅助表:目录卡片和拆词本

schema.sql 里还有几张表容易让人困惑,各用一句话说清它们为什么存在。

**nodes_fts 是目录卡片,不是第二份数据。** 它是 FTS5 全文索引,用了"外部内容模式"——正文只在 nodes 表里,这张虚拟表只存倒排索引(哪个词出现在哪行)。三个触发器负责保持同步:nodes 表增删改时,卡片跟着更新。好处是数据不冗余,代价是删除要走特殊命令形式——这是 FTS5 外部内容表的固定动作,不是 bug。

**name_segment_vocab 是拆词本。** 问题:FTS 把 `notifyChange` 当成一个不可分的词,用户搜 "change"(自然语言!)永远命中不了它。解法:索引时顺手把驼峰名拆开存一份——

```
segment     name
change      notifyChange
change      onChange
completion  logCompletion
```

搜 "change" 就能反查出两个方法。注意表注释里那句反直觉的话:孤儿行**故意不清除**——词条只是提案,每次使用前都会拿去 nodes 表复核,所以留着不碍事,全量重建时才清场。

## schema.sql 是唯一的图纸

最后说一个工程习惯,它解释了散落在 db 层的很多奇怪代码。批量索引为了速度会临时 DROP 掉一批索引和触发器,结束时再建回来;"崩溃自愈"也要检查并补建缺失的索引。这两处代码都**不手写 DDL**,而是运行时从 schema.sql 正则提取对应的 `CREATE INDEX ...;` 语句执行。

为什么?"手写一份"意味着图纸有了副本,副本必然漂移——半年后有人在 schema.sql 加了新索引,忘了同步自愈名单,自愈就永远修不出正确的库。单一事实来源不是洁癖,是把"漂移"这类 bug 从类别上消灭。

(migration v2–v16 每条背后的具体故事,见附录前的进阶篇;初读只需知道:版本号存在库里,`CURRENT_SCHEMA_VERSION` 在 `src/db/migrations.ts`,打开旧库时按需补课。)

## 带走三句话

1. id 掺行号 = 让"移动"变成"删除+新建",清理外包给外键级联;
2. qualified_name 解决同名歧义,provenance 让下游自己决定信多少;
3. schema.sql 只此一份,所有运行期 DDL 都从它现场提取。
