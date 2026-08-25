// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item expanded affix "><a href="intro.html">引言：为什么需要 CodeGraph</a></li><li class="chapter-item expanded affix "><li class="part-title">总体架构</li><li class="chapter-item expanded "><a href="architecture.html"><strong aria-hidden="true">1.</strong> 一条流水线，两种旅程</a></li><li class="chapter-item expanded affix "><li class="part-title">Tree-sitter 与提取基础设施</li><li class="chapter-item expanded "><a href="tree-sitter.html"><strong aria-hidden="true">2.</strong> Tree-sitter 入门：语法、错误恢复与 WASM</a></li><li class="chapter-item expanded affix "><li class="part-title">实证：一张图是怎么长出来的</li><li class="chapter-item expanded "><a href="empiria.html"><strong aria-hidden="true">3.</strong> 一个玩具仓库的六站解剖</a></li><li class="chapter-item expanded affix "><li class="part-title">源码级入门</li><li class="chapter-item expanded "><a href="gs-data-model.html"><strong aria-hidden="true">4.</strong> 数据模型：types.ts 与 schema.sql</a></li><li class="chapter-item expanded "><a href="gs-extractor.html"><strong aria-hidden="true">5.</strong> 提取器解剖：AST 如何变成图</a></li><li class="chapter-item expanded "><a href="gs-storage.html"><strong aria-hidden="true">6.</strong> 存储层：node:sqlite 与 QueryBuilder</a></li><li class="chapter-item expanded "><a href="gs-querying.html"><strong aria-hidden="true">7.</strong> 查询层：遍历、搜索与上下文</a></li><li class="chapter-item expanded affix "><li class="part-title">源码级进阶</li><li class="chapter-item expanded "><a href="adv-resolution.html"><strong aria-hidden="true">8.</strong> 引用解析：两阶段流水线</a></li><li class="chapter-item expanded "><a href="adv-synthesis.html"><strong aria-hidden="true">9.</strong> 动态分发与合成边</a></li><li class="chapter-item expanded "><a href="adv-kernel.html"><strong aria-hidden="true">10.</strong> 原生内核：Rust 加速路径</a></li><li class="chapter-item expanded "><a href="adv-mcp.html"><strong aria-hidden="true">11.</strong> MCP 服务器与进程拓扑</a></li><li class="chapter-item expanded "><a href="adv-agent-tools.html"><strong aria-hidden="true">12.</strong> 为 agent 设计工具：codegraph_explore</a></li><li class="chapter-item expanded "><a href="adv-performance.html"><strong aria-hidden="true">13.</strong> 性能工程：watchdog、WAL 与内存纪律</a></li><li class="chapter-item expanded affix "><li class="part-title">附录</li><li class="chapter-item expanded "><a href="appendix-api.html"><strong aria-hidden="true">14.</strong> 公共 API 导航</a></li><li class="chapter-item expanded "><a href="compare-crg.html"><strong aria-hidden="true">15.</strong> 对比：code-review-graph 交叉分析</a></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split("#")[0].split("?")[0];
        if (current_page.endsWith("/")) {
            current_page += "index.html";
        }
        var links = Array.prototype.slice.call(this.querySelectorAll("a"));
        var l = links.length;
        for (var i = 0; i < l; ++i) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (href && !href.startsWith("#") && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The "index" page is supposed to alias the first chapter in the book.
            if (link.href === current_page || (i === 0 && path_to_root === "" && current_page.endsWith("/index.html"))) {
                link.classList.add("active");
                var parent = link.parentElement;
                if (parent && parent.classList.contains("chapter-item")) {
                    parent.classList.add("expanded");
                }
                while (parent) {
                    if (parent.tagName === "LI" && parent.previousElementSibling) {
                        if (parent.previousElementSibling.classList.contains("chapter-item")) {
                            parent.previousElementSibling.classList.add("expanded");
                        }
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', function(e) {
            if (e.target.tagName === 'A') {
                sessionStorage.setItem('sidebar-scroll', this.scrollTop);
            }
        }, { passive: true });
        var sidebarScrollTop = sessionStorage.getItem('sidebar-scroll');
        sessionStorage.removeItem('sidebar-scroll');
        if (sidebarScrollTop) {
            // preserve sidebar scroll position when navigating via links within sidebar
            this.scrollTop = sidebarScrollTop;
        } else {
            // scroll sidebar to current active section when navigating via "next/previous chapter" buttons
            var activeSection = document.querySelector('#sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        var sidebarAnchorToggles = document.querySelectorAll('#sidebar a.toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(function (el) {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define("mdbook-sidebar-scrollbox", MDBookSidebarScrollbox);
