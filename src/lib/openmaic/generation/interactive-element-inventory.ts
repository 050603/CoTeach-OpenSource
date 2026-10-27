/**
 * Extract stable selectors from the generated widget DOM so narration actions
 * target controls that actually exist instead of guessing from conventions.
 * This follows the current OpenMAIC generation-package inventory contract.
 */
export function extractInteractiveElements(html: string): string {
  if (!html) return '';

  const styledClasses = collectStyledClassNames(html);
  let dom = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const unterminatedScript = dom.search(/<script\b/i);
  if (unterminatedScript !== -1) dom = dom.substring(0, unterminatedScript);

  const tagRegex =
    /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][\w:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`=]+))?)*)\s*\/?>/g;
  const seenIds = new Set<string>();
  const seenClasses = new Set<string>();
  const seenDataAttrs = new Set<string>();
  const idLines: string[] = [];
  const classLines: string[] = [];
  const dataAttrLines: string[] = [];
  const MAX_IDS = 60;
  const MAX_CLASSES = 30;
  const MAX_DATA_ATTRS = 30;

  for (const match of dom.matchAll(tagRegex)) {
    const tag = match[1].toLowerCase();
    if (tag === 'br' || tag === 'meta' || tag === 'link') continue;
    const attrs = parseAttrs(match[2] || '');
    const id = attrs.id;
    const classAttr = attrs.class;
    const ariaLabel = attrs['aria-label'];
    const role = attrs.role;
    const dataStepId = attrs['data-step-id'];
    const dataAction = attrs['data-action'];
    const name = attrs.name;
    const typeAttr = attrs.type;

    if (id && !seenIds.has(id) && idLines.length < MAX_IDS) {
      seenIds.add(id);
      const parts = [
        `#${id}`,
        `<${tag}${typeAttr ? ` type=${cleanAttrValue(typeAttr)}` : ''}>`,
      ];
      if (classAttr) parts.push(`class="${cleanAttrValue(classAttr)}"`);
      if (role) parts.push(`role=${cleanAttrValue(role)}`);
      if (ariaLabel) parts.push(`aria-label="${cleanAttrValue(ariaLabel)}"`);
      if (dataStepId) parts.push(`data-step-id="${cleanAttrValue(dataStepId)}"`);
      if (dataAction) parts.push(`data-action="${cleanAttrValue(dataAction)}"`);
      if (name) parts.push(`name=${cleanAttrValue(name)}`);
      idLines.push(parts.join(' '));
    }

    if (!id) {
      for (const [attrName, attrValue] of [
        ['data-step-id', dataStepId],
        ['data-action', dataAction],
      ] as const) {
        if (!attrValue) continue;
        const cleaned = cleanAttrValue(attrValue);
        const key = `${attrName}=${cleaned}`;
        if (seenDataAttrs.has(key)) continue;
        if (dataAttrLines.length >= MAX_DATA_ATTRS) break;
        seenDataAttrs.add(key);
        dataAttrLines.push(`[${attrName}="${cleaned}"] <${tag}>`);
      }
    }

    if (classAttr) {
      for (const className of classAttr.split(/\s+/).filter(Boolean)) {
        if (!styledClasses.has(className) && isUtilityClass(className)) continue;
        if (!seenClasses.has(className) && classLines.length < MAX_CLASSES) {
          seenClasses.add(className);
          classLines.push(`.${className} <${tag}>`);
        }
      }
    }
  }

  const sections: string[] = [];
  if (idLines.length) sections.push(`Elements with id:\n${idLines.join('\n')}`);
  if (dataAttrLines.length) sections.push(`Stable data attributes:\n${dataAttrLines.join('\n')}`);
  if (classLines.length) sections.push(`Notable classes:\n${classLines.join('\n')}`);
  return sections.join('\n\n');
}

const MAX_ATTR_VALUE_CHARS = 120;

function cleanAttrValue(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ATTR_VALUE_CHARS
    ? `${collapsed.substring(0, MAX_ATTR_VALUE_CHARS - 1)}…`
    : collapsed;
}

function collectStyledClassNames(html: string): Set<string> {
  const styled = new Set<string>();
  for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const match of block[1].matchAll(/\.([a-zA-Z_][\w-]*)/g)) styled.add(match[1]);
  }
  return styled;
}

const ATTR_TOKEN_REGEX = /([a-zA-Z_:][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/g;

function parseAttrs(attrs: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const match of attrs.matchAll(ATTR_TOKEN_REGEX)) {
    const name = match[1].toLowerCase();
    if (parsed[name] !== undefined) continue;
    parsed[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return parsed;
}

const UTILITY_PREFIXES = [
  'p-', 'px-', 'py-', 'pt-', 'pr-', 'pb-', 'pl-',
  'm-', 'mx-', 'my-', 'mt-', 'mr-', 'mb-', 'ml-',
  'w-', 'h-', 'min-w-', 'min-h-', 'max-w-', 'max-h-',
  'text-', 'font-', 'leading-', 'tracking-', 'bg-', 'border-', 'ring-',
  'shadow-', 'opacity-', 'rounded-', 'divide-', 'space-', 'gap-', 'grid-',
  'col-', 'row-', 'top-', 'right-', 'bottom-', 'left-', 'inset-', 'z-',
  'order-', 'flex-', 'items-', 'justify-', 'content-', 'self-', 'place-',
  'overflow-', 'whitespace-', 'break-', 'transition-', 'duration-', 'ease-',
  'delay-', 'animate-', 'translate-', 'rotate-', 'scale-', 'skew-', 'origin-',
  'cursor-', 'select-', 'pointer-events-', 'accent-', 'caret-', 'fill-',
  'stroke-', 'aspect-',
];

const UTILITY_EXACT = new Set([
  'flex', 'grid', 'block', 'inline', 'inline-block', 'inline-flex', 'hidden',
  'absolute', 'relative', 'fixed', 'sticky', 'static', 'container', 'italic',
  'underline', 'uppercase', 'lowercase', 'capitalize', 'truncate',
  'antialiased', 'subpixel-antialiased', 'visible', 'invisible', 'sr-only',
  'not-sr-only',
]);

function isUtilityClass(className: string): boolean {
  if (className.includes(':') || className.includes('[')) return true;
  if (UTILITY_PREFIXES.some((prefix) => className.startsWith(prefix))) return true;
  return UTILITY_EXACT.has(className);
}
