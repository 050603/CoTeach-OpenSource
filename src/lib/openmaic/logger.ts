// 客户端安全的 logger 包装器。
//
// 此模块会被客户端组件导入，因此绝对不能在顶层静态 import 任何
// 依赖 Node.js 内置模块（如 node:async_hooks）的服务器端模块。
// 服务器端的结构化日志（pino）由 API 路由直接使用
// `@/lib/observability/logger`，此处仅提供轻量级 console 实现。
// 客户端日志走 console；服务器端如果需要结构化日志，请直接
// 导入 `@/lib/observability/logger`。

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) =>
      a instanceof Error
        ? (a.stack ?? a.message)
        : typeof a === "string"
          ? a
          : JSON.stringify(a),
    )
    .join(" ");
}

export function createLogger(tag: string): Logger {
  const prefix = `[${tag}]`;
  return {
    debug: (...args) => {
      if (typeof console !== "undefined") console.debug(prefix, formatArgs(args));
    },
    info: (...args) => {
      if (typeof console !== "undefined") console.info(prefix, formatArgs(args));
    },
    warn: (...args) => {
      if (typeof console !== "undefined") console.warn(prefix, formatArgs(args));
    },
    error: (...args) => {
      if (typeof console !== "undefined") console.error(prefix, formatArgs(args));
    },
  };
}
