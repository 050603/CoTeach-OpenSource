export type DocxImageResolver = (source: string) => Promise<string>;

function isSupportedEmbeddedImage(source: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif);base64,/i.test(source);
}

/**
 * Plate's DOCX converter only packages data-URI images by default. Convert
 * every relative/authenticated image reference before handing HTML to it so
 * the resulting Word file is self-contained and remains valid after logout.
 */
export async function inlineHtmlImagesForDocx(
  html: string,
  resolveImage: DocxImageResolver,
): Promise<string> {
  const document = new DOMParser().parseFromString(html, "text/html");
  const images = Array.from(document.querySelectorAll("img"));

  await Promise.all(images.map(async (image) => {
    const source = image.getAttribute("src")?.trim();
    if (!source || isSupportedEmbeddedImage(source)) return;
    const embedded = await resolveImage(source);
    if (!isSupportedEmbeddedImage(embedded)) {
      throw new Error("图片无法转换为 Word 支持的格式，请重新上传后再导出。");
    }
    image.setAttribute("src", embedded);
  }));

  return document.body.innerHTML;
}
