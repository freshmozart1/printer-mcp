import MarkdownIt from "markdown-it";
import PDFDocument from "pdfkit";

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type Block =
  | { type: "heading"; level: number; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | { type: "quote"; spans: Span[] }
  | { type: "listItem"; ordered: boolean; index: number; spans: Span[] }
  | { type: "code"; text: string }
  | { type: "rule" };

const md = new MarkdownIt({ html: false, linkify: false });

type MdToken = ReturnType<typeof md.parse>[number];

/** Flatten an inline token's children into styled spans. */
function toSpans(token: MdToken | undefined): Span[] {
  if (!token?.children) return token?.content ? [{ text: token.content }] : [];

  const spans: Span[] = [];
  let bold = 0;
  let italic = 0;

  for (const child of token.children) {
    switch (child.type) {
      case "strong_open": bold++; break;
      case "strong_close": bold--; break;
      case "em_open": italic++; break;
      case "em_close": italic--; break;
      case "softbreak":
      case "hardbreak":
        spans.push({ text: " " });
        break;
      case "code_inline":
        spans.push({ text: child.content, code: true });
        break;
      case "text":
        if (child.content) {
          spans.push({
            text: child.content,
            ...(bold > 0 ? { bold: true } : {}),
            ...(italic > 0 ? { italic: true } : {}),
          });
        }
        break;
      default:
        if (child.content) spans.push({ text: child.content });
    }
  }
  return spans;
}

/** Convert markdown into a flat list of layout blocks. */
export function markdownToBlocks(source: string): Block[] {
  const tokens = md.parse(source, {});
  const blocks: Block[] = [];

  // Tracks the ordered-list counter for the list currently being walked.
  const listStack: { ordered: boolean; counter: number }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    switch (token.type) {
      case "heading_open": {
        const level = Number(token.tag.slice(1));
        blocks.push({ type: "heading", level, spans: toSpans(tokens[i + 1]) });
        break;
      }
      case "paragraph_open": {
        const spans = toSpans(tokens[i + 1]);
        const inList = listStack.length > 0;
        if (!inList && spans.length) blocks.push({ type: "paragraph", spans });
        else if (inList && spans.length) {
          const list = listStack[listStack.length - 1]!;
          blocks.push({
            type: "listItem",
            ordered: list.ordered,
            index: list.counter,
            spans,
          });
        }
        break;
      }
      case "blockquote_open": {
        // The paragraph inside supplies the text; mark it as a quote instead.
        const inline = tokens.slice(i).find((t) => t.type === "inline");
        blocks.push({ type: "quote", spans: toSpans(inline) });
        // Skip to the end of the quote so its paragraph is not emitted twice.
        while (i < tokens.length && tokens[i]!.type !== "blockquote_close") i++;
        break;
      }
      case "bullet_list_open":
        listStack.push({ ordered: false, counter: 0 });
        break;
      case "ordered_list_open":
        listStack.push({ ordered: true, counter: 0 });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        listStack.pop();
        break;
      case "list_item_open": {
        const list = listStack[listStack.length - 1];
        if (list) list.counter++;
        break;
      }
      case "fence":
      case "code_block":
        blocks.push({ type: "code", text: token.content });
        break;
      case "hr":
        blocks.push({ type: "rule" });
        break;
    }
  }

  return blocks;
}

/** Treat the input as literal text: blank lines separate paragraphs, no markdown. */
export function textToBlocks(source: string): Block[] {
  return source
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ({
      type: "paragraph" as const,
      spans: [{ text: chunk.replace(/\s*\n\s*/g, " ") }],
    }));
}

export interface RenderOptions {
  markdown?: boolean;
  title?: string;
}

const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 16, 3: 13.5, 4: 12, 5: 11, 6: 11 };
const BODY_SIZE = 11;

function fontFor(span: Span): string {
  if (span.code) return "Courier";
  if (span.bold && span.italic) return "Helvetica-BoldOblique";
  if (span.bold) return "Helvetica-Bold";
  if (span.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

/** Draw a run of styled spans as one continuous wrapped paragraph. */
function writeSpans(
  doc: PDFKit.PDFDocument,
  spans: Span[],
  size: number,
  baseFont: string,
  indent = 0,
): void {
  if (spans.length === 0) {
    doc.moveDown(0.5);
    return;
  }
  spans.forEach((span, i) => {
    const font = baseFont === "Helvetica" ? fontFor(span) : baseFont;
    doc.font(font).fontSize(span.code ? size - 1 : size);
    doc.text(span.text, {
      continued: i < spans.length - 1,
      indent: i === 0 ? indent : 0,
    });
  });
}

export function renderBlocksToPdf(blocks: Block[], options: RenderOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 64, bottom: 64, left: 64, right: 64 },
      info: options.title ? { Title: options.title } : undefined,
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (options.title) {
      doc.font("Helvetica-Bold").fontSize(22).text(options.title);
      doc.moveDown(0.8);
    }

    for (const block of blocks) {
      switch (block.type) {
        case "heading":
          doc.moveDown(0.6);
          writeSpans(doc, block.spans, HEADING_SIZES[block.level] ?? 12, "Helvetica-Bold");
          doc.moveDown(0.3);
          break;

        case "paragraph":
          writeSpans(doc, block.spans, BODY_SIZE, "Helvetica");
          doc.moveDown(0.6);
          break;

        case "quote":
          doc.moveDown(0.4);
          doc.fillColor("#444444");
          writeSpans(doc, block.spans, BODY_SIZE, "Helvetica-Oblique", 18);
          doc.fillColor("black");
          doc.moveDown(0.6);
          break;

        case "listItem": {
          const marker = block.ordered ? `${block.index}.` : "•";
          doc.font("Helvetica").fontSize(BODY_SIZE);
          doc.text(`${marker}  `, { continued: true, indent: 14 });
          writeSpans(doc, block.spans, BODY_SIZE, "Helvetica");
          doc.moveDown(0.25);
          break;
        }

        case "code": {
          doc.moveDown(0.3);
          doc.font("Courier").fontSize(BODY_SIZE - 1).fillColor("#222222");
          doc.text(block.text.replace(/\n$/, ""), { indent: 14 });
          doc.fillColor("black");
          doc.moveDown(0.6);
          break;
        }

        case "rule": {
          const y = doc.y + 4;
          doc.moveTo(doc.page.margins.left, y)
            .lineTo(doc.page.width - doc.page.margins.right, y)
            .strokeColor("#bbbbbb").stroke().strokeColor("black");
          doc.moveDown(0.8);
          break;
        }
      }
    }

    doc.end();
  });
}

/** Render text or markdown to a printable A4 PDF. */
export async function renderToPdf(content: string, options: RenderOptions = {}): Promise<Buffer> {
  const blocks = options.markdown ? markdownToBlocks(content) : textToBlocks(content);
  if (blocks.length === 0) {
    throw new Error("Nothing to print: the content is empty.");
  }
  return renderBlocksToPdf(blocks, options);
}
