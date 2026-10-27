// @vitest-environment node
import { expect, it } from "vitest";
import { boundedShowcaseContext, remapShowcaseReasons, sampleShowcaseEvidence, showcaseAnalysisAvailableAt, showcaseContentChange,
  showcaseContentSnapshot, showcaseHtmlEvidence, SHOWCASE_COOLDOWN_MS } from "./recommendation-preparation";

it("deduplicates styling and paragraph boundaries but detects numbers, materials and structure", () => {
  const snapshot = (html: string) => showcaseContentSnapshot(showcaseHtmlEvidence(html), html);
  const original = snapshot('<h1>实验</h1><p>三个条件下的结果一致。</p>');
  expect(showcaseContentChange(original, snapshot('<h1 style="color:red">实验</h1><p class="large">三个条件下的结果一致。</p>'))).toBe("same");
  expect(showcaseContentChange(snapshot('<p>abcdefghijk</p>'), snapshot('<p>abcde</p><p>fghijk</p>'))).toBe("same");
  expect(showcaseContentChange(snapshot('<p>100℃</p>'), snapshot('<p>101℃</p>'))).toBe("significant");
  expect(showcaseContentChange(snapshot('<p>实验<img src="/asset/a"></p>'), snapshot('<p>实验<img src="/asset/b"></p>'))).toBe("significant");
  expect(showcaseContentChange(snapshot('<p>正文</p><img src="/a?x=1&amp;y=2" data-asset-id="asset">'), snapshot("<p>正文</p><img data-asset-id='asset' src='/a?x=1&y=2'>"))).toBe("same");
  expect(showcaseContentChange(snapshot('<pre><span>return true</span></pre><p>' + '正文'.repeat(100) + '</p>'), snapshot('<pre><span>return false</span></pre><p>' + '正文'.repeat(100) + '</p>'))).toBe("significant");
  expect(showcaseContentChange(original, snapshot('<h2>实验</h2><p>三个条件下的结果一致。</p>'))).toBe("significant");
});
it("compares cumulative changes with the successful baseline and preserves negation", () => {
  const snap = (text: string) => showcaseContentSnapshot([{ location: "段落 1", text }]);
  const text = "这是实验记录与论证。".repeat(100);
  expect(showcaseContentChange(snap(text), snap(text + "补充一句说明。"))).toBe("minor");
  expect(showcaseContentChange(snap(text), snap(text + "补充充分证据。".repeat(60)))).toBe("significant");
  expect(snap("实验成立").fingerprint).not.toBe(snap("实验不成立").fingerprint);
  expect(showcaseContentChange(snap("甲".repeat(100)), snap("乙".repeat(100)))).toBe("significant");
});
it("debounces with a maximum first wait and honors the last real request cooldown", () => {
  const now = 1_000_000;
  expect(showcaseAnalysisAvailableAt(now, now).getTime()).toBe(now + 30_000);
  expect(showcaseAnalysisAvailableAt(now + 80_000, now).getTime()).toBe(now + 90_000);
  expect(showcaseAnalysisAvailableAt(now, now, now - 20_000).getTime()).toBe(now - 20_000 + SHOWCASE_COOLDOWN_MS);
});
it("remaps quotations to current paragraphs and drops absent or ambiguous evidence", () => {
  const reasons = [{ kind: "quality" as const, text: "结论有实验依据", location: "段落 1", quote: "三次实验结果一致" }];
  expect(remapShowcaseReasons(reasons, [{ location: "段落 5", text: "三次实验结果一致，结论成立。" }])[0].location).toBe("段落 5");
  expect(remapShowcaseReasons(reasons, [{ location: "段落 5", text: "结果已删除" }])).toEqual([]);
});
it("samples long works in one bounded payload, retaining the ending and source locators", () => {
  const blocks = Array.from({ length: 50 }, (_, i) => ({ location: `第 ${i + 1} 页`, text: `内容${i}：` + "实验说明".repeat(200) }));
  const sampled = sampleShowcaseEvidence(blocks, "对照实验");
  expect(sampled.coverage).toMatchObject({ mode: "sampled", analyzedCharacters: 8000 });
  expect(sampled.blocks.reduce((n, b) => n + b.text.length, 0)).toBe(8000);
  expect(sampled.blocks.some(b => b.location === "第 50 页")).toBe(true);
  expect(sampleShowcaseEvidence(blocks.slice(0, 1), "").coverage.mode).toBe("full");
});
it("bounds course context while preserving dimension identities and weights", () => {
  const dimensions = [1, 2, 3, 4].map(i => ({ id: `d${i}`, name: "任务", weight: 25, description: "要求".repeat(1000) }));
  const result = boundedShowcaseContext("课程任务".repeat(2000), dimensions);
  expect(result.dimensions.map(d => [d.id, d.weight])).toEqual(dimensions.map(d => [d.id, d.weight]));
  expect(JSON.stringify({ requirements: result.requirements, dimensions: result.dimensions }).length).toBeLessThanOrEqual(2000);
});
