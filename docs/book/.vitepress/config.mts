import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'CodeGraph 源码导读',
  description: '从 tree-sitter 到 MCP:CodeGraph 的架构、源码与设计取舍',
  base: '/codegraph/book/',
  srcDir: 'src',

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: 'GitHub', link: 'https://github.com/Atituiset/codegraph' },
    ],

    sidebar: [
      { text: '引言', link: '/intro' },
      {
        text: '总体架构',
        items: [{ text: '一条流水线,两种旅程', link: '/architecture' }],
      },
      {
        text: 'Tree-sitter 与提取基础设施',
        items: [
          { text: 'Tree-sitter 入门:语法、错误恢复与 WASM', link: '/tree-sitter' },
        ],
      },
      {
        text: '实证:一张图是怎么长出来的',
        items: [{ text: '一个玩具仓库的六站解剖', link: '/empiria' }],
      },
      {
        text: '源码级入门',
        items: [
          { text: '数据模型:types.ts 与 schema.sql', link: '/gs-data-model' },
          { text: '提取器解剖:AST 如何变成图', link: '/gs-extractor' },
          { text: '存储层:node:sqlite 与 QueryBuilder', link: '/gs-storage' },
          { text: '查询层:遍历、搜索与上下文', link: '/gs-querying' },
        ],
      },
      {
        text: '源码级进阶',
        items: [
          { text: '引用解析:两阶段流水线', link: '/adv-resolution' },
          { text: '动态分发与合成边', link: '/adv-synthesis' },
          { text: '原生内核:Rust 加速路径', link: '/adv-kernel' },
          { text: 'MCP 服务器与进程拓扑', link: '/adv-mcp' },
          { text: '为 agent 设计工具:codegraph_explore', link: '/adv-agent-tools' },
          { text: '性能工程:watchdog、WAL 与内存纪律', link: '/adv-performance' },
        ],
      },
      {
        text: '定位与借鉴',
        items: [
          { text: '定位与使用场景', link: '/positioning' },
          { text: '工程借鉴:从 codegraph 到企业级静态分析', link: '/sast-layers' },
        ],
      },
      {
        text: '附录',
        items: [
          { text: '公共 API 导航', link: '/appendix-api' },
          { text: '对比:code-review-graph 交叉分析', link: '/compare-crg' },
        ],
      },
    ],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/Atituiset/codegraph/edit/main/docs/book/src/:path',
      text: '在 GitHub 上编辑此页',
    },

    outline: { label: '本章目录', level: [2, 3] },
    docFooter: { prev: '上一章', next: '下一章' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    lastUpdated: { text: '最后更新', formatOptions: { dateStyle: 'short', timeStyle: 'medium' } },
  },
})
