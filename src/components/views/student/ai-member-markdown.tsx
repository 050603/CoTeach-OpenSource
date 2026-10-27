"use client";

import { code } from "@streamdown/code";
import { Streamdown, type StreamdownTranslations } from "streamdown";

const CHINESE_MARKDOWN_LABELS: Partial<StreamdownTranslations> = {
  close: "关闭",
  copied: "已复制",
  copyCode: "复制代码",
  copyLink: "复制链接",
  copyTable: "复制表格",
  copyTableAsCsv: "复制为 CSV",
  copyTableAsMarkdown: "复制为 Markdown",
  copyTableAsTsv: "复制为 TSV",
  downloadFile: "下载文件",
  downloadImage: "下载图片",
  downloadTable: "下载表格",
  downloadTableAsCsv: "下载为 CSV",
  downloadTableAsMarkdown: "下载为 Markdown",
  externalLinkWarning: "即将打开外部网站，请确认链接安全。",
  imageNotAvailable: "图片暂时无法显示",
  openExternalLink: "打开外部链接？",
  openLink: "打开链接",
  tableFormatCsv: "CSV",
  tableFormatMarkdown: "Markdown",
  tableFormatTsv: "TSV",
};

type AiMemberMarkdownProps = {
  content: string;
};

/** Compact Markdown typography shared by document and code AI-member messages. */
export function AiMemberMarkdown({ content }: AiMemberMarkdownProps) {
  return (
    <Streamdown
      className="min-w-0 space-y-2 break-words text-[13px] leading-5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:font-medium [&_a]:text-sky-700 [&_a]:underline [&_a]:decoration-sky-300 [&_a]:underline-offset-2 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-stone-300 [&_blockquote]:pl-3 [&_blockquote]:text-stone-600 [&_div[data-streamdown=code-block]]:my-2 [&_div[data-streamdown=code-block]]:gap-1 [&_div[data-streamdown=code-block]]:rounded-lg [&_div[data-streamdown=code-block-body]]:max-w-full [&_div[data-streamdown=code-block-body]]:overflow-x-auto [&_h1]:mb-1.5 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-2.5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_hr]:my-2.5 [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_table]:my-2 [&_table]:text-[11px] [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5"
      lineNumbers={false}
      mode="static"
      plugins={{ code }}
      translations={CHINESE_MARKDOWN_LABELS}
    >
      {content}
    </Streamdown>
  );
}
