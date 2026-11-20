import { reactSource } from './reactSource.js';
import type { ElementTarget, Rect } from './types.js';
export const isWidget = (element: Element) => !!element.closest('[data-feedback-root]');
function unique(selector: string) { return document.querySelectorAll(selector).length === 1; }
function preferred(element: Element): string | null {
  for (const attr of ['data-testid', 'id', 'aria-label']) {
    const value = element.getAttribute(attr);
    if (!value) continue;
    const selector = attr === 'id' ? `#${CSS.escape(value)}` : `[${attr}="${CSS.escape(value)}"]`;
    if (unique(selector)) return selector;
  }
  return null;
}
export function selectorFor(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node) {
    const anchor = preferred(node);
    if (anchor) { parts.unshift(anchor); break; }
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement ? [...node.parentElement.children].filter(el => el.tagName === node?.tagName) : [node];
    parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
    if (unique(parts.join(' > '))) break;
    node = node.parentElement;
  }
  return parts.join(' > ');
}
interface Fiber { type?: { displayName?: string; name?: string }; return?: Fiber }
export function componentChain(element: Element): string[] {
  const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
  let fiber = key ? (element as unknown as Record<string, Fiber>)[key] : undefined;
  const names: string[] = [];
  let depth = 0;
  while (fiber && names.length < 6 && depth++ < 100) {
    const name = fiber.type?.displayName || fiber.type?.name;
    if (name) names.push(name);
    fiber = fiber.return;
  }
  return names;
}
export function rectFor(element: Element): Rect {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}
function accessibleName(element: Element): string {
  const labelled = element.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
  const labels = (element as HTMLInputElement).labels;
  const label = labels ? [...labels].map(el => el.textContent).join(' ') : '';
  return (labelled || element.getAttribute('aria-label') || label || element.getAttribute('alt') || element.getAttribute('title') || element.textContent || '').trim().slice(0, 200);
}
function implicitRole(element: Element) {
  const roles: Record<string, string> = { BUTTON: 'button', A: 'link', IMG: 'img', TEXTAREA: 'textbox', SELECT: 'combobox', INPUT: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', ARTICLE: 'article', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', PROGRESS: 'progressbar' };
  if (element.matches('input[type=checkbox]')) return 'checkbox';
  if (element.matches('input[type=radio]')) return 'radio';
  return roles[element.tagName] ?? '';
}
export function targetFor(element: Element): ElementTarget {
  const react = reactSource(element);
  const hidden = !!element.closest('[data-rf-private]'); // private content reports no words
  return { selector: selectorFor(element), tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') ?? implicitRole(element), name: hidden ? '' : accessibleName(element),
    // biome-ignore lint/performance/useDomNodeTextContent: feedback needs visible text, excluding CSS-hidden content.
    text: hidden ? '' : ((element as HTMLElement).innerText ?? element.textContent ?? '').trim().slice(0, 200),
    rect: rectFor(element), components: react.components, ...(react.source ? { source: react.source } : {}) };
}

const SECTION = 'section, article, main, aside, nav, header, footer, dialog, form, [role="region"], [role="dialog"], [role="main"], [role="complementary"], [role="navigation"]';
function isCard(element: Element) {
  const rect = rectFor(element);
  if (rect.width < 120 || rect.height < 60) return false;
  const style = getComputedStyle(element);
  const border = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const;
  const hasBorder = border.some(side => parseFloat(style[side]) > 0);
  const background = style.backgroundColor;
  const hasBackground = !!background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)' && background !== getComputedStyle(element.parentElement ?? element).backgroundColor;
  return hasBorder || (!!style.boxShadow && style.boxShadow !== 'none') || hasBackground;
}
export function sectionFor(element: Element): Element {
  const semantic = element.closest(SECTION);
  if (semantic) return semantic;
  let node: Element | null = element;
  while (node && node !== document.body) {
    if (isCard(node)) return node;
    node = node.parentElement;
  }
  return element;
}
