import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('./verify-capacity-fault-recovery.mjs', import.meta.url));

for (const extraMode of [undefined, 'OPENPBL_VERIFY_LEARNING_EVENTS_ONLY']) {
  test(`rejects the retired whiteboard flag before temporary fixtures or subprocesses${extraMode ? ' even with another mode' : ''}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'retired-board-entrypoint-'));
    const temporary = path.join(directory, 'temporary');
    const binaries = path.join(directory, 'bin');
    mkdirSync(temporary);
    mkdirSync(binaries);
    const marker = path.join(directory, 'unexpected-subprocess');
    // If the guard regresses, block real Docker/pnpm and record the attempt.
    for (const executable of ['docker', 'pnpm']) {
      writeFileSync(path.join(binaries, executable), '#!/bin/sh\nprintf attempted > "$RETIRED_ENTRYPOINT_MARKER"\nexit 99\n', { mode: 0o700 });
    }
    try {
      const result = spawnSync(process.execPath, [entrypoint], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: binaries, TMPDIR: temporary, RETIRED_ENTRYPOINT_MARKER: marker,
          OPENPBL_VERIFY_WHITEBOARD_ONLY: '1', ...(extraMode ? { [extraMode]: '1' } : {}) },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /OPENPBL_VERIFY_WHITEBOARD_ONLY is no longer supported/);
      assert.deepEqual(readdirSync(temporary), []);
      assert.deepEqual(readdirSync(directory).sort(), ['bin', 'temporary']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
