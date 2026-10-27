import { observeSubmissionSaveReceipts, confirmSubmissionSave, removeAcknowledgedDocumentDrafts } from './classroom-acceptance-save-confirmation.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { expect } from '@playwright/test';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const view = row => row.payload?.view ?? row.payload;

/** A small, visibly two-colour PNG exercises real upload/decoding/download. */
function observationImage(seed) {
  const width = 64; const height = 40;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    pixels[offset] = x < width / 2 ? 35 + seed : 30;
    pixels[offset + 1] = x < width / 2 ? 90 : 170 + seed;
    pixels[offset + 2] = x < width / 2 ? 190 : 110;
  }
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
    const suffix = Buffer.alloc(4); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, data, suffix]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function inspectDocument(input) {
  const element = typeof input === 'string' ? new DOMParser().parseFromString(input, 'text/html').body : input;
  return {
    text: element.textContent ?? '',
    bold: [...element.querySelectorAll('strong,b')].map(node => node.textContent),
    italic: [...element.querySelectorAll('em,i')].map(node => node.textContent),
    tables: [...element.querySelectorAll('table')].map(table => [...table.rows]
      .map(row => [...row.cells].filter(cell => cell.getAttribute('contenteditable') !== 'false')
        .map(cell => cell.textContent.trim())).filter(row => row.length)),
    images: [...element.querySelectorAll('img')].map(image => image.getAttribute('src')),
  };
}

/** Read native focus/selection only; never manufacture a DOM or Slate range. */
function inspectNativeSelection(editor) {
  const clean = text => (text ?? '').replace(/[\u200B-\u200D\uFEFF]/gu, '');
  const blocks = [...editor.querySelectorAll('[data-slate-node="element"]')].filter(element => {
    const ancestor = element.parentElement?.closest('[data-slate-node="element"]');
    return !ancestor || !editor.contains(ancestor);
  });
  const last = blocks.at(-1);
  const selection = window.getSelection();
  const nodePath = node => {
    if (!node || !editor.contains(node)) return null;
    const path = [];
    while (node !== editor) {
      path.unshift([...node.parentNode.childNodes].indexOf(node));
      node = node.parentNode;
    }
    return path;
  };
  const point = (node, offset) => ({ path: nodePath(node), offset,
    text: node?.textContent?.slice(0, 250) ?? null,
    block: blocks.findIndex(block => block.contains(node)),
    cell: [...editor.querySelectorAll('td[data-slate-node],th[data-slate-node]')].findIndex(cell => cell.contains(node)) });
  let lastText;
  if (last) {
    const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) lastText = walker.currentNode;
  }
  const focus = selection?.focusNode;
  const focusOffset = selection?.focusOffset;
  const focusAtEnd = Boolean(selection?.isCollapsed && last && focus && last.contains(focus)
    && (clean(last.textContent) === ''
      || focus === lastText && (focusOffset === lastText.textContent.length || clean(lastText.textContent) === '')
      || focus.nodeType === Node.ELEMENT_NODE && focus.contains(lastText) && focusOffset === focus.childNodes.length));
  const floatingButton = [...document.querySelectorAll('[role="toolbar"] button')]
    .find(button => button.textContent?.trim() === '询问 AI 组员' && button.getClientRects().length
      && getComputedStyle(button).visibility !== 'hidden');
  const contextToolbarVisible = [...document.querySelectorAll('[data-radix-popper-content-wrapper] [role="toolbar"]')]
    .some(toolbar => toolbar.getClientRects().length && getComputedStyle(toolbar).visibility !== 'hidden');
  return { activeEditor: document.activeElement === editor, documentHasFocus: document.hasFocus(),
    activeElement: { tag: document.activeElement?.tagName ?? null, role: document.activeElement?.getAttribute('role') ?? null },
    collapsed: selection?.isCollapsed ?? null, selectedText: selection?.toString() ?? '',
    anchor: point(selection?.anchorNode, selection?.anchorOffset), focus: point(focus, focusOffset),
    blockCount: blocks.length, lastBlockText: clean(last?.textContent), lastBlockTag: last?.tagName ?? null,
    focusAtEnd, floatingToolbarVisible: Boolean(floatingButton), contextToolbarVisible };
}

/** Choose a real editable click point, retaining the normal actionability check. */
function visibleEditorClickPosition(block) {
  const rect = block.getBoundingClientRect();
  const candidates = [];
  for (const vertical of [0.5, 0.25, 0.75]) for (const horizontal of [0.03, 0.97, 0.12, 0.88, 0.5]) {
    const x = rect.left + rect.width * horizontal;
    const y = rect.top + rect.height * vertical;
    if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    const editable = Boolean(hit && block.contains(hit) && !hit.closest('[contenteditable="false"],button,input,textarea,[role="button"]'));
    candidates.push({ x, y, editable, tag: hit?.tagName ?? null });
    if (editable) return { position: { x: x - rect.left, y: y - rect.top }, candidates };
  }
  return { position: null, candidates };
}

/** Uses actual keyboard, toolbar, menus and file chooser. No editor transform
 * or business API is used to manufacture the tested rich document content.
 */
export async function runDocumentEditorAcceptance({ teacher, students, instance, db, request, record, output, origin }) {
  const name = 'document-rich-editing-persistence';
  const directory = path.join(output, 'document-editor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const browserBrands = ['google-chrome', 'microsoft-edge'];
  const concurrency = browserBrands.length;
  const nativeKeyboardConcurrencyPerBrand = 1;
  const evidence = { courseId: instance.id, scope: 'all-enrolled-students-rich-editing-in-real-chrome-and-edge',
    expectedStudents: students.length, concurrency, nativeKeyboardConcurrencyPerBrand,
    scheduling: 'one-native-ui-flow-per-browser-brand',
    businessApiMocks: false, editorInternalMethods: false, students: [], errors: [] };
  const save = (filename, value) => writeFile(path.join(directory, filename), Buffer.isBuffer(value) ? value
    : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  let evidenceWrites = Promise.resolve();
  const saveEvidence = () => {
    const snapshot = `${JSON.stringify(evidence, null, 2)}\n`;
    evidenceWrites = evidenceWrites.then(() => writeFile(path.join(directory, 'document-editor.json'), snapshot, { mode: 0o600 }));
    return evidenceWrites;
  };
  try {
    for (const brand of browserBrands) {
      assert.ok(students.some(student => student.label === brand), `Rich document editing requires a real ${brand} student`);
    }
    const runStudent = async student => {
      const { page, context } = student;
      const observedSaves = observeSubmissionSaveReceipts(page, { origin, courseId: instance.id, studentId: student.user.id });
      const result = { studentId: student.user.id, index: student.index, brand: student.label, steps: [], selectionChecks: [] };
      evidence.students.push(result);
      const errorListener = error => evidence.errors.push({ studentId: student.user.id, message: error.message });
      page.on('pageerror', errorListener);
      const until = async (read, message, timeout = 30000) => {
        const deadline = Date.now() + timeout; let error;
        do {
          try { const value = await read(); if (value) return value; } catch (caught) { error = caught; }
          await delay(200);
        } while (Date.now() < deadline);
        throw new Error(`${message}${error ? `: ${error.message}` : ''}`);
      };
      const submissionId = student.saved?.id;
      const submission = () => db.classroomSubmission.findUniqueOrThrow({ where: { id: submissionId } });
      const editor = page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
      const toolbar = page.locator('.pbl-document-editor [role="toolbar"]').first();
      const tool = async icon => {
        const visible = () => page.locator(`button:has(svg.${icon})`).filter({ visible: true }).first();
        if (!await visible().count()) {
          await toolbar.locator('[data-toolbar-overflow-more] button').first().click({ timeout: 15000 });
        }
        await visible().waitFor({ state: 'visible', timeout: 15000 });
        return visible();
      };
      const snapshot = () => editor.evaluate(inspectDocument);
      const selectionSnapshot = async action => {
        const selection = await editor.evaluate(inspectNativeSelection);
        result.selectionChecks.push({ action, at: new Date().toISOString(), selection });
        return selection;
      };
      const waitSelection = async (action, predicate, { minimumSamples = 2, minimumStableMs = 0 } = {}) => {
        let previous;
        let stableSince;
        let stableSamples = 0;
        let latest;
        await expect.poll(async () => {
          latest = await selectionSnapshot(action);
          const signature = JSON.stringify({ activeEditor: latest.activeEditor, collapsed: latest.collapsed,
            selectedText: latest.selectedText, anchor: latest.anchor, focus: latest.focus,
            blockCount: latest.blockCount, lastBlockText: latest.lastBlockText, focusAtEnd: latest.focusAtEnd,
            floatingToolbarVisible: latest.floatingToolbarVisible, contextToolbarVisible: latest.contextToolbarVisible });
          const ready = predicate(latest);
          const now = performance.now();
          if (!ready || signature !== previous) {
            stableSamples = ready ? 1 : 0;
            stableSince = ready ? now : undefined;
          } else {
            stableSamples += 1;
          }
          previous = ready ? signature : undefined;
          const stableMs = stableSince === undefined ? 0 : now - stableSince;
          if (minimumStableMs > 0) {
            result.selectionChecks.at(-1).stability = { ready, samples: stableSamples,
              stableMs: Math.floor(stableMs), minimumSamples, minimumStableMs };
          }
          return ready && stableSamples >= minimumSamples && stableMs >= minimumStableMs;
        }, { timeout: 10_000, intervals: [100, 150, 250], message: `${action}: native caret/focus did not reach a stable expected state` }).toBe(true);
        return latest;
      };
      const press = async (action, key) => {
        await page.keyboard.press(key);
        return selectionSnapshot(action);
      };
      const focusEnd = async action => {
        const before = await selectionSnapshot(`${action}-before-focus`);
        if (before.activeEditor) {
          await press(`${action}-collapse-selection`, 'ArrowRight');
          await waitSelection(`${action}-selection-collapsed`, selection => selection.activeEditor && selection.collapsed
            && !selection.floatingToolbarVisible);
        }
        // Escape selects the current block in Plate. It must not be used here
        // to dismiss a toolbar, particularly while the caret is inside a table.
        const lastBlock = editor.locator('[data-slate-node="element"]').last();
        await lastBlock.scrollIntoViewIfNeeded({ timeout: 5000 });
        const hitTest = await lastBlock.evaluate(visibleEditorClickPosition);
        result.selectionChecks.push({ action: `${action}-last-block-hit-test`, at: new Date().toISOString(), hitTest });
        assert.ok(hitTest.position, `${action}: no unobstructed editable point in the last block: ${JSON.stringify(hitTest.candidates)}`);
        await lastBlock.click({ position: hitTest.position, timeout: 5000 });
        // Slate throttles DOM selection updates by 100 ms. Let the actual click
        // selection settle before the single native Ctrl+End; never retry End.
        await waitSelection(`${action}-clicked-last-block-stable`, selection => selection.activeEditor
          && selection.documentHasFocus && selection.collapsed
          && selection.anchor.block === selection.blockCount - 1 && selection.focus.block === selection.blockCount - 1
          && !selection.floatingToolbarVisible && !selection.contextToolbarVisible,
        { minimumSamples: 3, minimumStableMs: 250 });
        await press(`${action}-ctrl-end`, 'ControlOrMeta+End');
        return waitSelection(`${action}-end-ready`, selection => selection.activeEditor && selection.collapsed && selection.focusAtEnd
          && !selection.floatingToolbarVisible && !selection.contextToolbarVisible);
      };
      const appendParagraph = async (action, key = 'Enter') => {
        const before = await focusEnd(action);
        await press(`${action}-new-paragraph`, key);
        return waitSelection(`${action}-new-paragraph-ready`, selection => selection.activeEditor
          && selection.collapsed && selection.focusAtEnd && selection.blockCount > before.blockCount && selection.lastBlockText === '');
      };
      const formatText = `编辑验收${student.index}：公平比较须记录日期。`;
      const removedText = `应由撤销移除的临时段落${student.index}`;
      const cells = [`地点${student.index}`, '观察时长', '校园东侧', '十分钟'];
      const imageBytes = observationImage(student.index);
      const filename = `observation-${student.index}.png`;
      let imageUrl;
      const assertOriginal = actual => {
        assert.ok(actual.text.includes(result.originalText), 'Rich editing removed the existing lesson document');
      };
      const assertUndone = actual => {
        assertOriginal(actual);
        assert.ok(!actual.text.includes(removedText), 'Undo did not remain effective');
      };
      const assertFormatting = actual => {
        assertUndone(actual);
        assert.ok(actual.bold.some(text => text.includes(formatText)), 'Bold formatting was lost');
        assert.ok(actual.italic.some(text => text.includes(formatText)), 'Italic formatting was lost');
      };
      const assertTable = actual => {
        assertFormatting(actual);
        assert.ok(actual.tables.some(table => JSON.stringify(table) === JSON.stringify([cells.slice(0, 2), cells.slice(2)])), '2 × 2 table dimensions or cell content changed');
      };
      const assertStructure = actual => {
        assertTable(actual);
        assert.ok(actual.images.includes(imageUrl), 'Uploaded image reference was lost');
      };
      const inspectStep = async (step, verify) => {
        const actual = await snapshot();
        (result.structureChecks ??= []).push({ step, structure: actual });
        try { verify(actual); }
        catch (error) { throw new Error(`${step}: ${error.message}`, { cause: error }); }
        return actual;
      };
      const clearCurrentDraft = async saved => {
        await confirmSubmissionSave({ page, db, courseId: instance.id, studentId: student.user.id,
          participationId: student.participation.id, submission: saved,
          observations: () => [student.initialDocumentSaveReceipt, ...observedSaves.entries].filter(Boolean) });
        await removeAcknowledgedDocumentDrafts(page, { courseId: instance.id, studentId: student.user.id, submission: saved });
      };
      const assertTemporary = actual => {
        assertOriginal(actual);
        assert.ok(actual.text.includes(removedText), 'The temporary text is missing');
      };
      try {
        await page.bringToFront();
        result.broughtToFrontAt = new Date().toISOString();
        assert.ok(submissionId, 'The main lesson must acknowledge its initial document save first');
        // A reload gives Undo its actual user-visible history boundary without
        // relying on a particular batch size or mutating the editor history.
        await clearCurrentDraft(student.saved);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await editor.waitFor({ state: 'visible', timeout: 30000 });
        const initial = await submission();
        const initialStructure = await page.evaluate(inspectDocument, view(initial).content);
        result.originalText = initialStructure.text.trim();
        assert.equal(initial.participationId, student.participation.id);
        assert.ok(['make:document', 'make'].includes(initial.stageKey));
        assert.ok(result.originalText.length > 10, 'The main lesson must save its initial document first');
        result.initialVersion = view(initial).version; result.submissionId = initial.id;
        await until(async () => { assertOriginal(await snapshot()); return true; }, 'Initial server document did not restore');
        await inspectStep('initial-server-restored', assertUndone);
        await selectionSnapshot('initial-server-restored');
        result.initialHistoryResetByReload = true;

        await appendParagraph('temporary');
        await page.keyboard.insertText(removedText); await expect(editor).toContainText(removedText);
        await waitSelection('temporary-text-rendered', selection => selection.activeEditor && selection.collapsed
          && selection.focusAtEnd && selection.lastBlockText === removedText);
        await inspectStep('temporary-text-entered', assertTemporary);
        await (await tool('lucide-undo-2')).click({ timeout: 15000 });
        await selectionSnapshot('temporary-undo-click');
        await expect(editor).not.toContainText(removedText);
        await inspectStep('temporary-text-undone', assertUndone);
        await (await tool('lucide-redo-2')).click({ timeout: 15000 });
        await selectionSnapshot('temporary-redo-click');
        await expect(editor).toContainText(removedText);
        await inspectStep('temporary-text-redone', assertTemporary);
        await (await tool('lucide-undo-2')).click({ timeout: 15000 });
        await selectionSnapshot('temporary-final-undo-click');
        await expect(editor).not.toContainText(removedText);
        await inspectStep('temporary-text-final-undo', assertUndone);
        result.steps.push('Restored the initial server document, then used Undo, Redo and Undo on independent temporary text, preserving the original');

        await appendParagraph('format');
        await page.keyboard.insertText(formatText);
        await expect(editor).toContainText(formatText);
        await waitSelection('format-text-rendered', selection => selection.activeEditor && selection.collapsed
          && selection.focusAtEnd && selection.lastBlockText === formatText);
        // The short marker fits one line in the required desktop views.
        // Native line navigation avoids counting Slate's zero-width caret stops.
        await press('format-end', 'End'); await press('format-home', 'Home'); await press('format-shift-end', 'Shift+End');
        await expect(page.getByRole('button', { name: '询问 AI 组员', exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });
        const formatSelected = selection => selection.activeEditor && !selection.collapsed && selection.selectedText === formatText
          && selection.anchor.block === selection.blockCount - 1 && selection.focus.block === selection.blockCount - 1
          && selection.floatingToolbarVisible;
        await waitSelection('format-selection-ready', formatSelected);
        assert.equal(await page.evaluate(() => window.getSelection()?.toString()), formatText, 'Formatting must act on the intended visible text');
        await inspectStep('before-formatting', assertUndone);
        await selectionSnapshot('before-bold-click');
        await (await tool('lucide-bold')).click({ timeout: 15000 });
        await selectionSnapshot('after-bold-click');
        await expect(editor.locator('strong,b').filter({ hasText: formatText }).first()).toBeVisible();
        await waitSelection('after-bold-selection-ready', formatSelected);
        await inspectStep('after-bold', actual => {
          assertUndone(actual);
          assert.ok(actual.bold.some(text => text.includes(formatText)), 'Bold formatting was not applied');
        });
        await selectionSnapshot('before-italic-click');
        await (await tool('lucide-italic')).click({ timeout: 15000 });
        await selectionSnapshot('after-italic-click');
        await expect(editor.locator('strong,b').filter({ hasText: formatText }).first()).toBeVisible();
        await expect(editor.locator('em,i').filter({ hasText: formatText }).first()).toBeVisible();
        await waitSelection('after-italic-selection-ready', formatSelected);
        await inspectStep('after-italic', assertFormatting);
        result.steps.push('Actual selected text formatted with bold and italic toolbar buttons');

        await inspectStep('before-table', assertFormatting);
        await appendParagraph('table');
        await (await tool('lucide-table')).click({ timeout: 15000 });
        await selectionSnapshot('table-toolbar-click');
        await page.getByRole('menuitem', { name: '表格', exact: true }).hover({ timeout: 15000 });
        await page.getByRole('button', { name: '插入 2 行 2 列表格', exact: true }).click({ timeout: 15000 });
        await selectionSnapshot('table-picker-click');
        const table = editor.locator('table').last();
        await expect(table.locator('tr')).toHaveCount(2);
        const tableCells = table.locator('td[data-slate-node],th[data-slate-node]');
        await expect(tableCells).toHaveCount(4);
        for (const [index, value] of cells.entries()) {
          await tableCells.nth(index).locator('[data-slate-node="element"]').first().click({ timeout: 15000 });
          await selectionSnapshot(`table-cell-${index}-clicked`);
          await waitSelection(`table-cell-${index}-ready`, selection => selection.activeEditor && selection.collapsed && selection.focus.cell === index);
          await page.keyboard.insertText(value);
          await expect(tableCells.nth(index)).toContainText(value);
          await selectionSnapshot(`table-cell-${index}-typed`);
        }
        await inspectStep('after-table', assertTable);
        result.steps.push('Inserted 2 × 2 table using the picker and typed all four cell values');

        await inspectStep('before-image', assertTable);
        await appendParagraph('image', 'ControlOrMeta+Enter');
        const imageTool = await tool('lucide-image');
        await selectionSnapshot('before-image-toolbar-click');
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 15000 }),
          imageTool.click({ position: { x: 14, y: 14 }, timeout: 15000 }),
        ]);
        await selectionSnapshot('after-image-toolbar-click');
        const [uploaded] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === '/api/uploads'
            && response.request().method() === 'POST', { timeout: 60000 }),
          chooser.setFiles({ name: filename, mimeType: 'image/png', buffer: imageBytes }),
        ]);
        const receipt = await uploaded.json();
        assert.ok([200, 201].includes(uploaded.status()), JSON.stringify(receipt).slice(0, 200));
        assert.ok(receipt.id && receipt.url); imageUrl = receipt.url;
        const image = editor.locator('img').filter({ visible: true });
        await until(async () => image.evaluateAll((elements, src) => elements.some(element => element.getAttribute('src') === src
          && element.complete && element.naturalWidth === 64 && element.naturalHeight === 40), imageUrl), 'Uploaded PNG did not decode in the actual document');
        const downloaded = await context.request.get(new URL(imageUrl, origin).href);
        assert.equal(downloaded.status(), 200); assert.equal(sha(await downloaded.body()), sha(imageBytes));
        const teacherDownload = await teacher.context.request.get(new URL(imageUrl, origin).href);
        assert.equal(teacherDownload.status(), 200); assert.equal(sha(await teacherDownload.body()), sha(imageBytes));
        const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: receipt.id } });
        assert.equal(asset.uploadedById, student.user.id); assert.equal(asset.mimeType, 'image/png');
        assert.equal(Number(asset.size), imageBytes.length); assert.equal(asset.deletedAt, null);
        if (asset.sha256 !== null) assert.equal(asset.sha256, sha(imageBytes));
        await save(filename, imageBytes);
        result.image = { uploadId: receipt.id, url: imageUrl, sha256: sha(imageBytes), bytes: imageBytes.length, width: 64, height: 40 };
        await selectionSnapshot('after-image-upload');
        await inspectStep('after-image', assertStructure);
        result.steps.push('Uploaded PNG through the toolbar file chooser; student/teacher downloads match its bytes');

        await inspectStep('before-manual-save', assertStructure);
        await selectionSnapshot('before-manual-save');
        await page.getByRole('button', { name: '保存', exact: true }).click({ timeout: 30000 });
        await selectionSnapshot('after-manual-save-click');
        const saved = await until(async () => {
          const row = await submission(); const html = view(row).content;
          const structure = await page.evaluate(inspectDocument, html);
          result.lastServerDocument = { version: view(row).version, updatedAt: row.updatedAt, html, structure };
          assertStructure(structure);
          return row.updatedAt.getTime() > initial.updatedAt.getTime() ? row : null;
        }, 'Formatted text, table and image were not saved to the server');
        assert.ok(view(saved).version > view(initial).version, 'Rich document save did not advance the acknowledged version');
        await inspectStep('after-server-save', assertStructure);
        const state = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
        assert.ok(state.submissions.some(row => row.studentId === student.user.id && row.content === view(saved).content), 'Teacher state did not receive the exact rich document');
        result.savedVersion = view(saved).version; result.savedHtml = view(saved).content;
        await clearCurrentDraft(saved);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await editor.waitFor({ state: 'visible', timeout: 30000 });
        await until(async () => { assertStructure(await snapshot()); return true; }, 'Server-restored editor lost rich document structure');
        await inspectStep('after-server-restore', assertStructure);
        await selectionSnapshot('after-server-restore');
        await until(async () => editor.locator('img').evaluateAll((elements, src) => elements.some(element => element.getAttribute('src') === src
          && element.complete && element.naturalWidth === 64 && element.naturalHeight === 40), imageUrl), 'Restored image failed to decode');
        const restored = await submission();
        assert.equal(view(restored).content, view(saved).content, 'Reload changed the stored rich document');
        student.saved = restored;
        student.richDocumentImageSha256 = result.image.sha256;
        result.restoredWithoutLocalDraft = true; result.finalStructure = await snapshot();
        result.steps.push('Saved a newer server revision; cleared local document drafts and restored all rich content after reload');
        await page.screenshot({ path: path.join(directory, `student-${student.index}-rich-document.png`), fullPage: true });
      } catch (error) {
        result.error = String(error.stack ?? error).slice(0, 3000);
        await selectionSnapshot('failure-before-cleanup').catch(() => undefined);
        await page.screenshot({ path: path.join(directory, `student-${student.index}-failure.png`), fullPage: true }).catch(() => undefined);
        if (!evidence.firstFailure) {
          evidence.firstFailure = { studentId: student.user.id, index: student.index };
          await page.screenshot({ path: path.join(directory, 'rich-document-failure.png'), fullPage: true }).catch(() => undefined);
        }
        throw new Error(`Student ${student.index} (${student.label}): ${error.message}`, { cause: error });
      } finally {
        try {
          await focusEnd('cleanup');
          await press('cleanup-arrow-right', 'ArrowRight');
          await waitSelection('cleanup-complete', selection => selection.activeEditor && selection.collapsed
            && !selection.floatingToolbarVisible && !selection.contextToolbarVisible);
          result.cleanup = { collapsedSelectionWithRealKeyboard: true, dismissedPopovers: true };
        } catch (error) {
          result.cleanup = { error: error.message };
          evidence.errors.push({ studentId: student.user.id, message: `Document UI cleanup failed: ${error.message}` });
        }
        await observedSaves.close();
        page.off('pageerror', errorListener); await saveEvidence();
      }
    };
    const failures = [];
    // Keep all student contexts open; only this native-keyboard subtest is
    // serialized per brand. Each student runs once and retains its first error.
    const queues = await Promise.allSettled(browserBrands.map(async brand => {
      for (const student of students.filter(candidate => candidate.label === brand)) {
        try { await runStudent(student); } catch (error) { failures.push(error); }
      }
    }));
    failures.push(...queues.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason));
    if (failures.length) throw new AggregateError(failures, `${failures.length}/${students.length} rich document checks failed: ${failures.slice(0, 3).map(error => error.message).join('; ')}`);
    assert.equal(evidence.students.length, students.length);
    assert.equal(new Set(evidence.students.map(student => student.studentId)).size, students.length);
    assert.deepEqual(evidence.errors, [], 'Rich document editing caused browser runtime errors');
    record(name, '通过', { students: evidence.students.length, concurrency, nativeKeyboardConcurrencyPerBrand,
      scheduling: evidence.scheduling,
      browserCounts: Object.fromEntries(['google-chrome', 'microsoft-edge'].map(brand => [brand, evidence.students.filter(student => student.brand === brand).length])),
      documents: evidence.students.map(row => ({ studentId: row.studentId, brand: row.brand, savedVersion: row.savedVersion,
      imageSha256: row.image.sha256, restoredWithoutLocalDraft: row.restoredWithoutLocalDraft })),
    formatting: ['bold', 'italic'], table: '2 × 2 with four saved cells', undoRedo: true, actualFileChooserUpload: true }, 'browser-real-backend');
  } catch (error) {
    evidence.error = String(error.stack ?? error).slice(0, 3000);
    record(name, '失败', evidence.error, 'browser-real-backend');
  } finally { await saveEvidence(); }
  return evidence;
}
