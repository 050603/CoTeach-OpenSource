// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import nextConfig from '../next.config';
import { createRequire } from 'node:module';
import { copyFile, lstat, mkdtemp, mkdir, readFile, readlink, symlink, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

describe('Content Security Policy', () => {
  it('keeps staged-file detection native and ships its dynamic Node tokenizer in standalone output', async () => {
    const { webpack } = require('next/dist/compiled/webpack/webpack');
    const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
    const glob = require('next/dist/compiled/glob');
    const { PDFDocument } = await import('pdf-lib');
    const project = process.cwd();
    await mkdir(path.join(project, '.cache'), { recursive: true });
    const work = await mkdtemp(path.join(project, '.cache/file-type-config-'));
    const standalone = await mkdtemp(path.join(tmpdir(), 'openpbl-file-type-standalone-'));
    try {
      const entry = path.join(work, 'entry.cjs');
      await writeFile(entry, "module.exports = require('file-type');\n");
      const compiler = webpack({ mode: 'production', target: 'node22', context: project, entry,
        // Exercise Next's module/external rules without its separate minifier
        // integration; signature detection does not depend on minification.
        optimization: { minimize: false },
        output: { path: work, filename: 'bundle.cjs', library: { type: 'commonjs2' } },
        externals: Object.fromEntries((nextConfig.serverExternalPackages ?? []).map(name => [name, `commonjs ${name}`])),
      });
      try {
        await new Promise<void>((resolve, reject) => compiler.run((error: Error | null, stats: { hasErrors(): boolean; hasWarnings(): boolean; toString(): string } | undefined) => {
          if (error) reject(error);
          else if (!stats || stats.hasErrors() || stats.hasWarnings()) reject(new Error(stats?.toString() ?? 'Missing compiler result'));
          else resolve();
        }));
      } finally { await new Promise<void>((resolve, reject) => compiler.close((error: Error | null) => error ? reject(error) : resolve())); }
      const bundle = path.join(work, 'bundle.cjs');
      expect(await readFile(bundle, 'utf8')).toMatch(/require\(["']file-type["']\)/);
      const traced = await nodeFileTrace([bundle], { base: project, processCwd: project });
      const files = new Set<string>(traced.fileList);
      for (const pattern of nextConfig.outputFileTracingIncludes?.['/api/courses/*/showcase/artifacts/pdf'] ?? []) {
        for (const filename of glob.sync(pattern, { cwd: project, dot: true })) files.add(filename);
      }
      expect([...files].some(file => file.endsWith('/strtok3/lib/FileTokenizer.js'))).toBe(true);
      for (const filename of files) {
        const source = path.resolve(project, filename), destination = path.resolve(standalone, filename);
        expect(destination.startsWith(`${standalone}${path.sep}`)).toBe(true);
        const info = await lstat(source);
        await mkdir(path.dirname(destination), { recursive: true });
        if (info.isSymbolicLink()) await symlink(await readlink(source), destination);
        else if (info.isDirectory()) await mkdir(destination, { recursive: true });
        else await copyFile(source, destination);
      }
      const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
      const fixture = path.join(standalone, 'valid-two-page.pdf'); await writeFile(fixture, await pdf.save());
      const isolatedBundle = path.resolve(standalone, path.relative(project, bundle));
      const probe = `require(${JSON.stringify(isolatedBundle)}).fileTypeFromFile(${JSON.stringify(fixture)}).then(result => process.stdout.write(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });`;
      const result = await promisify(execFile)(process.execPath, ['-e', probe], { cwd: standalone,
        env: { ...process.env, NODE_PATH: '' }, timeout: 10_000 });
      expect(JSON.parse(result.stdout)).toEqual({ ext: 'pdf', mime: 'application/pdf' });
    } finally {
      await Promise.all([rm(work, { recursive: true, force: true }), rm(standalone, { recursive: true, force: true })]);
    }
  });

  it('excludes private diagnostic files from actual entry tracing and final packaging', async () => {
    const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
    const picomatch = require('next/dist/compiled/picomatch');
    class TraceEntryPointsPlugin { traceIgnores: string[] = []; }
    const plugin = new TraceEntryPointsPlugin();
    nextConfig.webpack?.({ plugins: [plugin] }, { dev: false, nextRuntime: 'nodejs' } as Parameters<NonNullable<typeof nextConfig.webpack>>[1]);
    const root = await mkdtemp(path.join(tmpdir(), 'openpbl-trace-isolation-'));
    try {
      await mkdir(path.join(root, '.cache', 'diagnostic'), { recursive: true });
      await writeFile(path.join(root, '.cache/diagnostic/private.json'), '{}');
      await writeFile(path.join(root, 'public.json'), '{}');
      const entry = path.join(root, 'entry.js');
      await writeFile(entry, "const fs=require('node:fs');const path=require('node:path');fs.readFileSync(path.join(process.cwd(),'.cache/diagnostic/private.json'));fs.readFileSync(path.join(process.cwd(),'public.json'));");
      const baseline = await nodeFileTrace([entry], { base: root, processCwd: root });
      expect(baseline.fileList.has('.cache/diagnostic/private.json')).toBe(true);
      const traced = await nodeFileTrace([entry], { base: root, processCwd: root,
        ignore: picomatch(plugin.traceIgnores, { contains: true, dot: true }) });
      expect(traced.fileList.has('.cache/diagnostic/private.json')).toBe(false);
      expect(traced.fileList.has('public.json')).toBe(true);
      const finalExcludes = picomatch((nextConfig.outputFileTracingExcludes?.['/**'] ?? []).map(glob => path.join(root, glob)), { dot: true, contains: true });
      expect(finalExcludes(path.join(root, '.cache/diagnostic/private.json'))).toBe(true);
      expect(finalExcludes(path.join(root, 'public.json'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not glob the project root for explicitly published Monaco assets in the real helper', async () => {
    const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
    const picomatch = require('next/dist/compiled/picomatch');
    const ts = require('typescript');
    class TraceEntryPointsPlugin { traceIgnores: string[] = []; }
    const plugin = new TraceEntryPointsPlugin();
    nextConfig.webpack?.({ plugins: [plugin] }, { dev: false, nextRuntime: 'nodejs' } as Parameters<NonNullable<typeof nextConfig.webpack>>[1]);
    const root = await mkdtemp(path.join(tmpdir(), 'openpbl-monaco-trace-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Transpile the actual entry, preserving its path expressions. NFT parses
      // this file; it never executes runtime imports, starts a server or reads
      // the real workspace. Both tracing base and processCwd are this tiny root.
      const source = await readFile(new URL('./lib/openmaic/server/encoded-monaco-runtime.ts', import.meta.url), 'utf8');
      const entry = path.join(root, 'entry.js');
      await writeFile(entry, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
      const baseline = plugin.traceIgnores.filter(pattern => !pattern.includes('/static/openpbl-runtime/monaco'));
      await nodeFileTrace([entry], { base: root, processCwd: root, log: true,
        ignore: picomatch(baseline, { contains: true, dot: true }) });
      expect(log.mock.calls.some(([message]) => String(message).includes(`${root}/**/*/static/openpbl-runtime/monaco`))).toBe(true);
      log.mockClear();
      const traced = await nodeFileTrace([entry], { base: root, processCwd: root, log: true,
        ignore: picomatch(plugin.traceIgnores, { contains: true, dot: true }) });
      expect(log.mock.calls.some(([message]) => String(message).startsWith('Globbing '))).toBe(false);
      expect(traced.fileList.has('entry.js')).toBe(true);
    } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it('allows the WebAssembly compilation required by Python interactions', async () => {
    const routeHeaders = await nextConfig.headers?.();
    const contentSecurityPolicy = routeHeaders
      ?.flatMap((route) => route.headers)
      .find((header) => header.key === 'Content-Security-Policy')?.value;

    expect(contentSecurityPolicy).toContain("script-src 'self' 'unsafe-inline'");
    expect(contentSecurityPolicy).toContain("'wasm-unsafe-eval'");
  });

  it('traces all nested interactive runtime assets into standalone builds', () => {
    expect(nextConfig.outputFileTracingIncludes).toMatchObject({
      '/api/openmaic/interactive-runtime/**': expect.arrayContaining([
        './node_modules/codemirror/**/*',
        './node_modules/katex/dist/**/*',
        './node_modules/pyodide/**/*',
      ]),
    });
  });

  it('traces runtime prompt templates into standalone builds', () => {
    expect(nextConfig.outputFileTracingIncludes).toMatchObject({
      '/**': expect.arrayContaining([
        './src/lib/openmaic/prompts/**/*',
      ]),
    });
  });
});
