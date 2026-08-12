/* The three DOM helpers every view wanted. Deliberately not a framework. */

export const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel)!;

export function el<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const tag = (text: string, kind = "") => el("span", `tag ${kind}`.trim(), text);
