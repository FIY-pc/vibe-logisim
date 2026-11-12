/** GitHub's Atom body stays in an inert template. Only plain text leaves it;
 * release markup, images and links are never mounted in the workbench. */
export function releaseHighlights(html: string | null | undefined): string[] {
  if (!html || html.length > 64 * 1024) return [];
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  content
    .querySelectorAll("script, style, template, iframe, object, svg, math")
    .forEach((node) => node.remove());
  const items = [...content.querySelectorAll("li")].filter(
    (node) => !node.parentElement?.closest("li"),
  );
  const candidates = items.length ? items : [...content.querySelectorAll("p")];
  return candidates
    .map((node) => {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("ul, ol").forEach((list) => list.remove());
      const text = (copy.textContent || "").replace(/\s+/g, " ").trim();
      // Release notes use bold feature names followed by longer descriptions.
      // Keep those authored headlines; otherwise use the opening sentence.
      const title = copy.querySelector("strong")?.textContent?.trim();
      if (title && text.startsWith(title)) return title;
      return text.match(/^.*?[。！？]/u)?.[0] || text;
    })
    .filter(Boolean)
    .slice(0, 3);
}
