import type { List, Nodes, Parents, Root, RootContent, Table } from 'mdast';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString as nodeToString } from 'mdast-util-to-string';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { decodeText } from '../text-decoding';
import {
  failure,
  plainTextOf,
  type Block,
  type ExtractInput,
  type ExtractionLimits,
  type ExtractionResult,
  type ExtractionWarning,
  type Extractor,
  type Link,
  type ListItem,
  type Offsets,
} from '../model';

export const MARKDOWN_EXTRACTION_METHOD = 'markdown-mdast@1.0.0';

const FRONT_MATTER = ['yaml', 'toml'] as const;

interface Context {
  definitions: Map<string, string>;
  htmlBlocks: number;
  frontMatterBlocks: number;
  unsupported: Map<string, number>;
  blocks: Block[];
}

function offsetsOf(node: Nodes): Offsets | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

/**
 * Renders inline content as plain text. Emphasis/strong markers are dropped (they carry no retrieval value),
 * inline code keeps its backticks (it marks identifiers and literals), and links become their visible text with
 * the target collected into `links`.
 */
function inline(node: Nodes, ctx: Context, links: Link[]): string {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'inlineCode':
      return `\`${node.value}\``;
    case 'break':
      return '\n';
    case 'html':
      return node.value;
    case 'image':
    case 'imageReference':
      return node.alt ?? '';
    case 'footnoteReference':
      return `[^${node.label ?? node.identifier}]`;
    case 'link': {
      const text = children(node, ctx, links);
      links.push({ text, href: node.url });
      return text;
    }
    case 'linkReference': {
      const text = children(node, ctx, links);
      const href = ctx.definitions.get(node.identifier);
      if (href) links.push({ text, href });
      return text;
    }
    default:
      if ('children' in node) return children(node as Parents, ctx, links);
      if ('value' in node && typeof node.value === 'string') return node.value;
      return '';
  }
}

function children(node: Parents, ctx: Context, links: Link[]): string {
  return (node.children as Nodes[]).map((child) => inline(child, ctx, links)).join('');
}

function withLinks<T extends object>(block: T, links: Link[]): T & { links?: Link[] } {
  return links.length > 0 ? { ...block, links } : block;
}

function renderList(
  list: List,
  depth: number,
  items: ListItem[],
  lines: string[],
  ctx: Context,
  links: Link[],
): void {
  let counter = list.start ?? 1;
  for (const item of list.children) {
    const parts: string[] = [];
    const nested: List[] = [];
    for (const child of item.children) {
      if (child.type === 'paragraph') parts.push(children(child, ctx, links));
      else if (child.type === 'list') nested.push(child);
      // Other block content (code, tables, quotes) inside a list item is flattened into the item's text.
      else parts.push(nodeToString(child));
    }
    const text = parts.join('\n');
    const checked = item.checked ?? null;
    items.push({ text, depth, checked });

    const marker = list.ordered ? `${counter++}.` : '-';
    const box = checked === null ? '' : checked ? '[x] ' : '[ ] ';
    const indent = '  '.repeat(depth);
    lines.push(`${indent}${marker} ${box}${text.replace(/\n/g, `\n${indent}  `)}`);
    for (const child of nested) renderList(child, depth + 1, items, lines, ctx, links);
  }
}

function renderTable(table: Table, ctx: Context): { header: string[]; rows: string[][]; links: Link[] } {
  const links: Link[] = [];
  const all = table.children.map((row) => row.children.map((cell) => children(cell, ctx, links)));
  return { header: all[0] ?? [], rows: all.slice(1), links };
}

function walk(nodes: RootContent[], ctx: Context): void {
  for (const node of nodes) {
    const offsets = offsetsOf(node);
    const base = { page: null, offsets };
    switch (node.type) {
      case 'heading': {
        const links: Link[] = [];
        const text = children(node, ctx, links).trim();
        if (text) ctx.blocks.push(withLinks({ kind: 'heading' as const, level: node.depth, text, ...base }, links));
        break;
      }
      case 'paragraph': {
        const links: Link[] = [];
        const text = children(node, ctx, links).trim();
        if (text) ctx.blocks.push(withLinks({ kind: 'paragraph' as const, text, ...base }, links));
        break;
      }
      case 'list': {
        const items: ListItem[] = [];
        const lines: string[] = [];
        const links: Link[] = [];
        renderList(node, 0, items, lines, ctx, links);
        ctx.blocks.push(
          withLinks({ kind: 'list' as const, ordered: node.ordered ?? false, items, text: lines.join('\n'), ...base }, links),
        );
        break;
      }
      case 'table': {
        const { header, rows, links } = renderTable(node, ctx);
        const text = [header, ...rows].map((row) => row.join(' | ')).join('\n');
        ctx.blocks.push(withLinks({ kind: 'table' as const, header, rows, text, ...base }, links));
        break;
      }
      case 'code':
        ctx.blocks.push({ kind: 'code', language: node.lang ?? null, text: node.value, ...base });
        break;
      case 'blockquote':
      case 'footnoteDefinition':
        walk(node.children, ctx);
        break;
      case 'html':
        ctx.htmlBlocks++;
        if (node.value.trim()) ctx.blocks.push({ kind: 'paragraph', text: node.value.trim(), ...base });
        break;
      case 'yaml':
        ctx.frontMatterBlocks++;
        break;
      case 'thematicBreak':
      case 'definition':
        break;
      default: {
        if ((node.type as string) === 'toml') {
          ctx.frontMatterBlocks++; // TOML front matter node: typed only via the plugin's augmentation
          break;
        }
        // Never drop content silently: keep its text and report the node type we did not model.
        ctx.unsupported.set(node.type, (ctx.unsupported.get(node.type) ?? 0) + 1);
        const text = nodeToString(node).trim();
        if (text) ctx.blocks.push({ kind: 'paragraph', text, ...base });
      }
    }
  }
}

function collectDefinitions(node: Nodes, into: Map<string, string>): void {
  if (node.type === 'definition') into.set(node.identifier, node.url);
  if ('children' in node) for (const child of (node as Parents).children as Nodes[]) collectDefinitions(child, into);
}

export const markdownExtractor: Extractor = {
  format: 'markdown',
  extractionMethod: MARKDOWN_EXTRACTION_METHOD,

  async extract(input: ExtractInput, limits: ExtractionLimits): Promise<ExtractionResult> {
    if (input.bytes.length > limits.maxBytes) {
      return failure('LIMIT_EXCEEDED', `File exceeds the ${limits.maxBytes}-byte limit.`, [], { maxBytes: limits.maxBytes });
    }
    const decoded = decodeText(input.bytes);
    if (!decoded.ok) return failure('INVALID_ENCODING', decoded.message, [], decoded.details);

    let tree: Root;
    try {
      tree = fromMarkdown(decoded.text, {
        extensions: [gfm(), frontmatter([...FRONT_MATTER])],
        mdastExtensions: [...gfmFromMarkdown(), frontmatterFromMarkdown([...FRONT_MATTER])],
      });
    } catch (error) {
      return failure('MALFORMED_DOCUMENT', `Markdown could not be parsed: ${(error as Error).message.slice(0, 200)}`, decoded.warnings);
    }

    const ctx: Context = {
      definitions: new Map(),
      htmlBlocks: 0,
      frontMatterBlocks: 0,
      unsupported: new Map(),
      blocks: [],
    };
    collectDefinitions(tree, ctx.definitions);
    walk(tree.children, ctx);

    const warnings: ExtractionWarning[] = [...decoded.warnings];
    if (ctx.frontMatterBlocks > 0) {
      warnings.push({
        code: 'FRONT_MATTER_SKIPPED',
        message: 'Front matter was recognised and excluded from the extracted content. It remains in the original file.',
      });
    }
    if (ctx.htmlBlocks > 0) {
      warnings.push({
        code: 'HTML_PRESERVED_RAW',
        message: `${ctx.htmlBlocks} raw HTML block(s) were kept as literal text, not interpreted.`,
        details: { count: ctx.htmlBlocks },
      });
    }
    if (ctx.unsupported.size > 0) {
      warnings.push({
        code: 'UNSUPPORTED_MARKDOWN_NODE',
        message: 'Some Markdown constructs are not modelled structurally; their text was kept as paragraphs.',
        details: Object.fromEntries(ctx.unsupported),
      });
    }

    if (ctx.blocks.length === 0) return failure('NO_EXTRACTABLE_TEXT', 'The file contains no text content.', warnings);

    const firstH1 = ctx.blocks.find((b) => b.kind === 'heading' && b.level === 1);
    return {
      ok: true,
      document: {
        format: 'markdown',
        extractionMethod: MARKDOWN_EXTRACTION_METHOD,
        offsetBasis: 'document_text',
        metadata: { title: firstH1?.text ?? null, author: null, pageCount: null, encoding: decoded.encoding },
        pages: [],
        blocks: ctx.blocks,
        text: plainTextOf(ctx.blocks),
        warnings,
      },
    };
  },
};
