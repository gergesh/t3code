import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";

export function markdownImageSources(markdown: string): string[] {
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return [];
  const sources = new Set<string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") sources.add(node.url);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parseMarkdownDocument(markdown));
  return [...sources];
}

/** Image sources and link targets, as the native markdown renderer reads them. */
export function markdownReferences(markdown: string): {
  images: string[];
  links: string[];
} {
  const images: string[] = [];
  const links: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") images.push(node.url);
    if (node.type === "link") links.push(node.url);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parseMarkdownDocument(markdown));
  return { images, links };
}
