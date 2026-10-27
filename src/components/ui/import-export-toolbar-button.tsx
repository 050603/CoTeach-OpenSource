'use client';

import * as React from 'react';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import { MarkdownPlugin } from '@platejs/markdown';
import {
  ArrowDownToLineIcon,
  ArrowUpDownIcon,
  ArrowUpToLineIcon,
  FileCode2Icon,
  FileImageIcon,
  FileTextIcon,
} from 'lucide-react';
import { createSlateEditor, type SlatePlugin } from 'platejs';
import { useEditorRef } from 'platejs/react';
import { getEditorDOMFromHtmlString, serializeHtml } from 'platejs/static';
import { toast } from 'sonner';
import { useFilePicker } from 'use-file-picker';

import { BaseEditorKit } from '@/components/editor/editor-base-kit';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EditorStatic } from '@/components/ui/editor-static';
import { inlineHtmlImagesForDocx } from '@/lib/project-practice/docx-image-embedding';

import { ToolbarButton } from './toolbar';

type ImportType = 'html' | 'markdown';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readBlobAsDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败，请重新上传后再导出。'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片格式无法识别，请重新上传后再导出。'));
      image.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) {
      throw new Error('图片格式无法识别，请重新上传后再导出。');
    }
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error('图片转换失败，请稍后重试。')),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadDocxImage(source: string): Promise<string> {
  const response = await fetch(source, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('文档中的图片已失效，请重新上传后再导出。');
  let blob = await response.blob();
  if (!blob.size || !blob.type.toLowerCase().startsWith('image/')) {
    throw new Error('文档中的图片不是有效图片，请重新上传后再导出。');
  }
  if (!/^image\/(?:png|jpe?g|gif)$/i.test(blob.type)) {
    blob = await convertImageBlobToPng(blob);
  }
  return readBlobAsDataUri(blob);
}

export function ImportExportToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  const insertImportedNodes = React.useCallback(
    (text: string, type: ImportType) => {
      const nodes = type === 'html'
        ? editor.api.html.deserialize({ element: getEditorDOMFromHtmlString(text) })
        : editor.getApi(MarkdownPlugin).markdown.deserialize(text);

      editor.tf.insertNodes(nodes);
      editor.tf.focus();
      toast.success('文档已导入');
    },
    [editor]
  );

  const { openFilePicker: openMarkdownPicker } = useFilePicker({
    accept: ['.md', '.mdx'],
    multiple: false,
    onFilesSelected: async ({ plainFiles }) => {
      const file = plainFiles[0];
      if (!file) return;
      try {
        insertImportedNodes(await file.text(), 'markdown');
      } catch {
        toast.error('Markdown 导入失败，请检查文件内容。');
      }
    },
  });

  const { openFilePicker: openHtmlPicker } = useFilePicker({
    accept: ['text/html'],
    multiple: false,
    onFilesSelected: async ({ plainFiles }) => {
      const file = plainFiles[0];
      if (!file) return;
      try {
        insertImportedNodes(await file.text(), 'html');
      } catch {
        toast.error('HTML 导入失败，请检查文件内容。');
      }
    },
  });

  const { openFilePicker: openWordPicker } = useFilePicker({
    accept: ['.docx'],
    multiple: false,
    onFilesSelected: async ({ plainFiles }) => {
      const file = plainFiles[0];
      if (!file) return;
      try {
        const { importDocx } = await import('@platejs/docx-io');
        const result = await importDocx(editor, await file.arrayBuffer());
        editor.tf.insertNodes(result.nodes as typeof editor.children);
        editor.tf.focus();
        toast.success('Word 文档已导入');
      } catch {
        toast.error('Word 导入失败，请检查文件是否有效。');
      }
    },
  });

  const getCanvas = async () => {
    const { default: html2canvas } = await import('html2canvas-pro');
    return html2canvas(editor.api.toDOMNode(editor)!, {
      backgroundColor: '#ffffff',
      scale: Math.min(window.devicePixelRatio || 1, 2),
    });
  };

  const runExport = async (task: () => Promise<void>, success: string) => {
    try {
      await task();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败，请稍后重试。');
    }
  };

  const serializeEditorHtml = async () => {
    const staticEditor = createSlateEditor({
      plugins: BaseEditorKit as SlatePlugin[],
      value: editor.children,
    });
    return serializeHtml(staticEditor, {
      editorComponent: EditorStatic,
      props: { style: { margin: '0 auto', maxWidth: '760px', padding: '48px' } },
    });
  };

  const exportHtml = () => runExport(async () => {
    const content = await serializeEditorHtml();
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>项目成果</title><style>body{margin:0;color:#171717;background:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;line-height:1.7}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d4d4d4;padding:8px}</style></head><body>${content}</body></html>`;
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), '项目成果.html');
  }, 'HTML 已导出');

  const exportMarkdown = () => runExport(async () => {
    const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
    downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), '项目成果.md');
  }, 'Markdown 已导出');

  const exportWord = () => runExport(async () => {
    const { htmlToDocxBlob } = await import('@platejs/docx-io');
    const content = await inlineHtmlImagesForDocx(await serializeEditorHtml(), loadDocxImage);
    const blob = await htmlToDocxBlob(content, {
      allowRemoteImages: false,
      orientation: 'portrait',
    });
    downloadBlob(blob, '项目成果.docx');
  }, 'Word 文档已导出');

  const exportPdf = () => runExport(async () => {
    const canvas = await getCanvas();
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([canvas.width, canvas.height]);
    const image = await pdf.embedPng(canvas.toDataURL('image/png'));
    page.drawImage(image, { x: 0, y: 0, width: canvas.width, height: canvas.height });
    const bytes = await pdf.save();
    downloadBlob(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }), '项目成果.pdf');
  }, 'PDF 已导出');

  const exportImage = () => runExport(async () => {
    const canvas = await getCanvas();
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png');
    });
    downloadBlob(blob, '项目成果.png');
  }, '图片已导出');

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton pressed={open} tooltip="导入与导出" isDropdown>
          <ArrowUpDownIcon />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[180px]">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ArrowUpToLineIcon />
            <span>导入</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={openHtmlPicker}><FileCode2Icon />从 HTML 导入</DropdownMenuItem>
            <DropdownMenuItem onSelect={openMarkdownPicker}><FileTextIcon />从 Markdown 导入</DropdownMenuItem>
            <DropdownMenuItem onSelect={openWordPicker}><FileTextIcon />从 Word 导入</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ArrowDownToLineIcon />
            <span>导出</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => void exportHtml()}><FileCode2Icon />导出为 HTML</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportMarkdown()}><FileTextIcon />导出为 Markdown</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportWord()}><FileTextIcon />导出为 Word</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportPdf()}><FileTextIcon />导出为 PDF</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportImage()}><FileImageIcon />导出为图片</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
