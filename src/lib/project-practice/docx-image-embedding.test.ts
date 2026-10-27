import { describe, expect, it, vi } from "vitest";
import { inlineHtmlImagesForDocx } from "./docx-image-embedding";

const EMBEDDED_PNG = "data:image/png;base64,aW1hZ2U=";

describe("Word image embedding", () => {
  it("replaces authenticated upload URLs while preserving existing data images", async () => {
    const resolveImage = vi.fn(async () => EMBEDDED_PNG);
    const html = await inlineHtmlImagesForDocx(
      `<p>正文</p><img src="/api/uploads/123"><img src="${EMBEDDED_PNG}">`,
      resolveImage,
    );

    expect(resolveImage).toHaveBeenCalledOnce();
    expect(resolveImage).toHaveBeenCalledWith("/api/uploads/123");
    expect(html.match(/data:image\/png;base64,aW1hZ2U=/g)).toHaveLength(2);
  });

  it("fails instead of silently exporting a Word file without an image", async () => {
    await expect(inlineHtmlImagesForDocx(
      '<img src="/api/uploads/missing">',
      async () => "not-an-image",
    )).rejects.toThrow("图片无法转换为 Word 支持的格式");
  });
});
