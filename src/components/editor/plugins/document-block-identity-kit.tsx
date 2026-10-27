'use client';

import { createPlatePlugin } from 'platejs/react';
import { DOCUMENT_BLOCK_ID_ATTRIBUTE, isDocumentBlockId } from '@/lib/ai-collaboration/document-comment-anchor';

/** Restore only our bounded identity field, preserving every node's existing
 * HTML parser. No comment mark or arbitrary node property is persisted. */
export const DocumentBlockIdentityPlugin = createPlatePlugin({
  key: 'openpblDocumentBlockIdentity',
  inject: {
    targetPlugins: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'tr', 'td', 'th', 'code_block', 'img', 'hr'],
    // Plate stores this in inject.plugins[target]. Its HTML pipeline first
    // runs the target parser, then merges each injected result into that node.
    // Returning only id leaves type, children, styles, image URL and spans intact.
    targetPluginToInject: () => ({
      parsers: { html: { deserializer: { parse: ({ element }) => {
        const id = element.getAttribute(DOCUMENT_BLOCK_ID_ATTRIBUTE);
        return isDocumentBlockId(id) ? { id } : {};
      } } } },
    }),
  },
});
