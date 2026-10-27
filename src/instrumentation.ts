// Next.js instrumentation hook. Runs once per server process at startup.
//
// 此文件会被 Edge Runtime 和 Node.js Runtime 同时加载，因此绝对不能
// 在顶层静态 import 任何依赖 Node.js 内置模块（node:async_hooks、
// node:crypto）或 Node.js API（process.on、process.exit）的模块。
//
// 所有 Node.js 专用的初始化逻辑（prom-client、WebSocket 服务器、
// SIGTERM/SIGINT 信号处理器）都被隔离在 instrumentation-node.ts 中，
// 通过条件动态 import 加载。Edge Runtime 不会分析条件分支内的
// 动态 import，因此可以避免 Edge Runtime 报错。

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 仅在 Node.js runtime 中加载 Node.js 专用代码：
    //   - prom-client 默认指标采集
    //   - WebSocket 服务器（实时课堂同步）
    //   - SIGTERM / SIGINT 优雅关闭信号处理器
    const nodeInstrumentation = await import("./instrumentation-node");
    await nodeInstrumentation.register();
  }
}
