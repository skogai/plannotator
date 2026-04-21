import React from "react";
import { Block } from "../types";
import { slugifyHeading } from "../utils/slugify";
import { InlineMarkdown } from "./InlineMarkdown";
import { ListMarker } from "./ListMarker";
import { CodeBlock } from "./blocks/CodeBlock";
import { HtmlBlock } from "./blocks/HtmlBlock";
import { Callout } from "./blocks/Callout";
import { AlertBlock } from "./blocks/AlertBlock";

const parseTableContent = (
  content: string,
): { headers: string[]; rows: string[][] } => {
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    // Remove leading/trailing pipes, split by unescaped |, then unescape \|
    return line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, "|"));
  };

  const headers = parseRow(lines[0]);
  const rows: string[][] = [];

  // Skip the separator line (contains dashes) and parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip separator lines (contain only dashes, pipes, colons, spaces)
    if (/^[\|\-:\s]+$/.test(line)) continue;
    rows.push(parseRow(line));
  }

  return { headers, rows };
};

export const BlockRenderer: React.FC<{
  block: Block;
  onOpenLinkedDoc?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onToggleCheckbox?: (blockId: string, checked: boolean) => void;
  checkboxOverrides?: Map<string, boolean>;
  orderedIndex?: number | null;
  githubRepo?: string;
}> = ({ block, onOpenLinkedDoc, imageBaseDir, onImageClick, onToggleCheckbox, checkboxOverrides, orderedIndex, githubRepo }) => {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level || 1}` as React.ElementType;
      const styles = {
        1: 'text-2xl font-bold mb-4 mt-6 first:mt-0 tracking-tight',
        2: 'text-xl font-semibold mb-3 mt-8 text-foreground/90',
        3: 'text-base font-semibold mb-2 mt-6 text-foreground/80',
      }[block.level || 1] || 'text-base font-semibold mb-2 mt-4';
      const anchorId = slugifyHeading(block.content) || undefined;

      return <Tag id={anchorId} className={styles} data-block-id={block.id} data-block-type="heading"><InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} /></Tag>;
    }

    case 'blockquote': {
      if (block.alertKind) {
        return (
          <AlertBlock
            blockId={block.id}
            kind={block.alertKind}
            body={block.content}
            onOpenLinkedDoc={onOpenLinkedDoc}
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
            githubRepo={githubRepo}
          />
        );
      }
      // Content may span multiple merged `>` lines. Split on blank-line
      // paragraph breaks so `> a\n>\n> b` renders as two <p> children.
      const paragraphs = block.content.split(/\n\n+/);
      return (
        <blockquote
          className="border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic"
          data-block-id={block.id}
        >
          {paragraphs.map((para, i) => (
            <p key={i} className={i > 0 ? 'mt-2' : ''}>
              <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={para} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} />
            </p>
          ))}
        </blockquote>
      );
    }

    case 'list-item': {
      const indent = (block.level || 0) * 1.25; // 1.25rem per level
      const isCheckbox = block.checked !== undefined;
      const isChecked = checkboxOverrides?.has(block.id)
        ? checkboxOverrides.get(block.id)!
        : block.checked;
      const isInteractive = isCheckbox && !!onToggleCheckbox;
      return (
        <div
          className="flex items-start gap-3 my-1.5"
          data-block-id={block.id}
          style={{ marginLeft: `${indent}rem` }}
        >
          <ListMarker
            level={block.level || 0}
            ordered={block.ordered}
            orderedIndex={orderedIndex}
            checked={isChecked}
            interactive={isInteractive}
            onToggle={isInteractive ? () => onToggleCheckbox!(block.id, !isChecked) : undefined}
          />
          <span className={`text-sm leading-relaxed ${isCheckbox && isChecked ? 'text-muted-foreground line-through' : 'text-foreground/90'}`}>
            <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} />
          </span>
        </div>
      );
    }

    case 'code':
      return <CodeBlock block={block} onHover={() => {}} onLeave={() => {}} isHovered={false} />;

    case 'table': {
      const { headers, rows } = parseTableContent(block.content);
      return (
        <div className="my-4 overflow-x-auto" data-block-id={block.id}>
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                {headers.map((header, i) => (
                  <th
                    key={i}
                    className="px-3 py-2 text-left font-semibold text-foreground/90 bg-muted/30"
                  >
                    <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={header} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border/50 hover:bg-muted/20">
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-3 py-2 text-foreground/80">
                      <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={cell} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'hr':
      return <hr className="border-border/30 my-8" data-block-id={block.id} />;

    case 'html':
      return <HtmlBlock block={block} imageBaseDir={imageBaseDir} onOpenLinkedDoc={onOpenLinkedDoc} />;

    case 'directive': {
      const kind = block.directiveKind || 'note';
      return (
        <Callout
          blockId={block.id}
          kind={kind}
          body={block.content}
          containerClassName={`directive directive-${kind} my-4 px-4 py-3 rounded-md border`}
          blockType="directive"
          kindAttribute={kind}
          onOpenLinkedDoc={onOpenLinkedDoc}
          imageBaseDir={imageBaseDir}
          onImageClick={onImageClick}
          githubRepo={githubRepo}
        />
      );
    }

    default:
      return (
        <p
          className="mb-4 leading-relaxed text-foreground/90 text-[15px]"
          data-block-id={block.id}
        >
          <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} githubRepo={githubRepo} />
        </p>
      );
  }
};
