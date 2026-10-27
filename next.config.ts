import type { NextConfig } from "next";
import { contentSecurityPolicy } from "./src/lib/security/content-security-policy";
import { defaultHttpResponseHeaders } from "./src/lib/security/response-headers";
import { MONACO_STATIC_RUNTIME_BASE, MONACO_BUNDLE_RUNTIME_BASE } from "./src/lib/browser/runtime-asset-versions";

const nextConfig: NextConfig = {
  compress: true,
  experimental: {
    webpackBuildWorker: true,
    webpackMemoryOptimizations: true,
  },
  webpack(config, { dev, nextRuntime }) {
    if (!dev && nextRuntime === "nodejs") {
      // Next 16 applies outputFileTracingExcludes after compilation. Its
      // entry trace must also avoid traversing mutable data and old releases.
      // Keep this version-sensitive integration explicit on framework upgrades.
      const tracePlugin = config.plugins?.find(
        (plugin: { constructor?: { name?: string } }) =>
          plugin?.constructor?.name === "TraceEntryPointsPlugin",
      );
      if (!tracePlugin || !Array.isArray(tracePlugin.traceIgnores)) {
        throw new Error("Next.js entry tracing changed; review runtime-data exclusions before building.");
      }
      tracePlugin.traceIgnores.push(
        "**/.openpbl-data/**",
        "**/.openpbl-runtime/**",
        "**/.cache/**",
        // These immutable assets are published, copied and hash-verified by
        // monaco-static-runtime.mjs after compilation. Exclude the directory
        // itself too: NFT checks a dynamic directory glob before traversing.
        "**/static/openpbl-runtime/monaco",
        "**/static/openpbl-runtime/monaco/**",
        "**/.next*/**",
        "**/test-results/**",
        "**/core.*",
        "**/deploy/secrets/**",
      );
    }
    return config;
  },
  // Turbopack chunk names can remain stable across releases. Stamp asset URLs
  // with the build's deployment id so immutable browser caches cannot keep an
  // older application bundle after a server update.
  deploymentId: process.env.NEXT_DEPLOYMENT_ID?.trim() || undefined,
  // Local production commands set NEXT_DIST_DIR=.next-build so `next build`
  // cannot remove chunks owned by a concurrently running `.next/dev` server.
  // Containers explicitly keep `.next` because their copy paths use it.
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  // Uploads live on a runtime volume and must never be copied into the
  // standalone image. Node file tracing cannot infer this from a dynamic
  // stored filename, so keep project/runtime data out of these route traces.
  outputFileTracingExcludes: {
    // All routes use runtime volumes, including adaptive lessons and audit
    // recovery. Never package classroom records, backups or deployment keys.
    "/**": [
      "./.openpbl-data/**/*",
      "./.openpbl-runtime/**/*",
      "./.cache/**/*",
      "./data/classrooms/**/*",
      "./deploy/secrets/**/*",
      "./deploy/.deploy.env",
      "./test-results/**/*",
    ],
    "/api/uploads": [
      "./.openpbl-data/**/*",
      "./coverage/**/*",
      "./deploy/**/*",
      "./docs/**/*",
      "./e2e/**/*",
      "./output/**/*",
      "./packages/**/*",
      "./public/**/*",
      "./src/**/*",
      "./tests/**/*",
      "./*.md",
      "./*.ts",
      "./*.yml",
      "./*.yaml",
    ],
    "/api/uploads/[id]": [
      "./.openpbl-data/**/*",
      "./coverage/**/*",
      "./deploy/**/*",
      "./docs/**/*",
      "./e2e/**/*",
      "./output/**/*",
      "./packages/**/*",
      "./public/**/*",
      "./src/**/*",
      "./tests/**/*",
      "./*.md",
      "./*.ts",
      "./*.yml",
      "./*.yaml",
    ],
  },
  // Interactive Python scenes load these executable assets through a
  // same-origin route. They are read with fs at request time, so explicitly
  // retain them in the standalone image.
  outputFileTracingIncludes: {
    // file-type loads strtok3's Node entry dynamically when detecting staged
    // uploads. NFT sees its static core import, but misses FileTokenizer and
    // the Node entry; retain them for both pnpm and flat standalone layouts.
    "/api/courses/*/showcase/artifacts/pdf": [
      "./node_modules/strtok3/**/*",
      "./node_modules/.pnpm/strtok3@*/node_modules/strtok3/**/*",
    ],
    "/api/openmaic/interactive-runtime/**": [
      "./node_modules/codemirror/**/*",
      "./node_modules/katex/dist/**/*",
      "./node_modules/monaco-editor/min/vs/**/*",
      "./node_modules/pyodide/**/*",
      "./node_modules/three/build/*.js",
      "./node_modules/three/examples/jsm/**/*.js",
    ],
    // sharp 的 prebuilt 二进制在运行时 dlopen vendored libvips 共享库,
    // NFT 追踪不到这些 .so(只带上了 .node 本体),导致 standalone 镜像里
    // 图像处理报 ERR_DLOPEN_FAILED。显式包含整个 @img 目录。
    "/**": [
      "./workers/docx-converter.cjs",
      "./workers/docx-converter-manifest.json",
      "./workers/course-read-worker.cjs",
      "./workers/course-read-worker-manifest.json",
      // The read worker retains Prisma externally. Its generated client/native
      // engine are dynamic dependencies; preserve both pnpm and flat layouts.
      "./node_modules/@prisma/client/**/*",
      "./node_modules/.prisma/client/**/*",
      "./node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client/**/*",
      "./node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/**/*",
      "./node_modules/@img/**",
      // PromptLoader reads the Markdown prompt templates with fs at runtime.
      // Keep them in every standalone production build.
      "./src/lib/openmaic/prompts/**/*",
      "./node_modules/@fontsource/noto-sans-sc/**/*",
      "./node_modules/katex/dist/**/*",
      "./packages/@openmaic/renderer/src/styles.ts",
      "./node_modules/elkjs/LICENSE.md",
      "./node_modules/playwright/LICENSE",
      "./node_modules/playwright/NOTICE",
      // Spatial planning imports playwright-core at runtime. Next.js keeps
      // Playwright external, so standalone tracing must copy its executable
      // JavaScript instead of retaining only license files.
      "./node_modules/playwright-core/**/*",
    ],
  },
  // Stage 9: standalone output for minimal Docker images.
  // Produces `.next/standalone` with only the files needed to run the
  // production server (no `node_modules` install required at runtime).
  output: "standalone",
  // Keep React lifecycle checks enabled in development.
  reactStrictMode: true,
  transpilePackages: [
    "@openmaic/dsl",
    "@openmaic/importer",
    "@openmaic/renderer",
    "mathml2omml",
    "pptxgenjs",
  ],
  serverExternalPackages: [
    "sharp",
    // file-type's Node file reader uses runtime imports. Bundling replaces
    // them with an empty import context and rejects valid staged uploads.
    "file-type",
    "playwright",
    "playwright-core",
    "elkjs",
    "unpdf",
    "undici",
    "jszip",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "pino",
    "pino-pretty",
    "prom-client",
    "redis",
    "ws",
  ],
  images: {
    // Prefer AVIF, fall back to WebP for browsers that don't support AVIF.
    formats: ["image/avif", "image/webp"],
    // Cache optimized images for up to 24 hours on the server.
    minimumCacheTTL: 86400,
  },
  async rewrites() {
    return {
      beforeFiles: [{
        source: `${MONACO_STATIC_RUNTIME_BASE}/:path*`,
        destination: `${MONACO_STATIC_RUNTIME_BASE.replace('/_next/static/openpbl-runtime/', '/api/openmaic/interactive-runtime/')}/:path*`,
      }, {
        source: `${MONACO_BUNDLE_RUNTIME_BASE}/editor.main.js`,
        destination: `${MONACO_BUNDLE_RUNTIME_BASE.replace('/_next/static/openpbl-runtime/', '/api/openmaic/interactive-runtime/')}/editor.main.js`,
      }],
      afterFiles: [
        {
          source: "/logos/:path*",
          destination: "/openmaic/logos/:path*",
        },
        {
          source: "/avatars/:path*",
          destination: "/openmaic/avatars/:path*",
        },
        {
          source: "/logo-horizontal.png",
          destination: "/openmaic/logo-horizontal.png",
        },
        {
          source: "/openmaic-mark.png",
          destination: "/openmaic/openmaic-mark.png",
        },
      ],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        // Expose the request id on every response so clients can correlate
        // logs with a request. The static placeholder here guarantees the
        // header is always present; per-request UUIDs are stamped by route
        // handlers via `setRequestContext` / middleware (when present), and
        // any value set on the Response by a handler overrides this default.
        source: "/:path*",
        headers: defaultHttpResponseHeaders(),
      },
      {
        // Only the embedded resource runtime may be framed, and only by this app.
        source: "/internal/resource-player",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy().replace("frame-ancestors 'none'", "frame-ancestors 'self'") },
        ],
      },
      {
        // Only this pinned public package tree may be read cross-origin.
        // Next sets immutable caching for existing /_next/static files itself;
        // do not attach a year-long cache lifetime to missing resources.
        source: `${MONACO_STATIC_RUNTIME_BASE}/:path*`,
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
      },
      {
        source: `${MONACO_BUNDLE_RUNTIME_BASE}/editor.main.js`,
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
