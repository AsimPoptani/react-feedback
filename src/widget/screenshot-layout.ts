import { isWidget, rectFor, selectorFor } from './elements.js';
import type { Rect } from './types.js';
interface Positioned { selector: string; rect: Rect; sticky: boolean; clip: string | null }
// Reset only document scroll restoration; nested scrollers keep their offsets.
export function documentClone() {
  const scroller = document.scrollingElement ?? document.documentElement;
  const children = [...scroller.children].filter(element => !isWidget(element) && !element.matches('noscript')).map(element => ({ selector: selectorFor(element), transform: getComputedStyle(element).transform }));
  return (clone: Node) => {
    if (!(clone instanceof HTMLElement)) return;
    for (const child of children) {
      const node = clone.querySelector<HTMLElement>(child.selector);
      if (node) node.style.transform = child.transform;
    }
  };
}
// modern-screenshot restores nested scrollers by translating their children.
// Undo that translation only at the document scroller: our root transform
// already applies document scrolling. Snapshot fixed/sticky viewport geometry
// separately so translating the document does not move its floating controls.
export function viewportClone(scroll: { x: number; y: number }) {
  const scroller = document.scrollingElement ?? document.documentElement;
  const documentChildren = (scroller.scrollTop || scroller.scrollLeft)
    ? [...scroller.children].map(element => ({ selector: selectorFor(element), transform: getComputedStyle(element).transform })) : [];
  const positioned: Positioned[] = [];
  for (const element of document.querySelectorAll('*')) {
    if (isWidget(element)) continue;
    const position = getComputedStyle(element).position;
    if (position === 'fixed' || position === 'sticky') positioned.push(positionedSnapshot(element, position === 'sticky')); 
  }
  return (clone: Node) => {
    if (!(clone instanceof HTMLElement)) return;
    for (const child of documentChildren) {
      const node = clone.querySelector<HTMLElement>(child.selector);
      if (node) node.style.transform = child.transform;
    }
    // Descendants first, so a lifted ancestor cannot duplicate a floating child.
    for (const item of positioned.toReversed()) liftPositioned(clone, item, scroll);
  };
}

function liftPositioned(clone: HTMLElement, item: Positioned, scroll: { x: number; y: number }) {
  const node = clone.querySelector<HTMLElement>(item.selector);
  if (!node) return;
  const floating = item.sticky ? node.cloneNode(true) as HTMLElement : node;
  if (item.sticky) node.style.visibility = 'hidden'; // retain its space in the flow
  Object.assign(floating.style, {
    position: 'absolute', left: `${item.rect.x + scroll.x}px`, top: `${item.rect.y + scroll.y}px`,
    width: `${item.rect.width}px`, height: `${item.rect.height}px`, right: 'auto', bottom: 'auto',
    margin: '0', transform: 'none', boxSizing: 'border-box', maxWidth: 'none', maxHeight: 'none',
  });
  if (item.clip) floating.style.clipPath = item.clip;
  clone.append(floating);
}

function positionedSnapshot(element: Element, sticky: boolean): Positioned {
  const rect = rectFor(element);
  return { selector: selectorFor(element), rect, sticky, clip: ancestorClip(element, rect, sticky) };
}
function ancestorClip(element: Element, rect: Rect, sticky: boolean): string | null {
  const ancestors: Element[] = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
  const containingBlock = ancestors.some(parent => getComputedStyle(parent).transform !== 'none' && !!getComputedStyle(parent).transform);
  if (!sticky && !containingBlock) return null;
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
  for (const parent of ancestors) {
    const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowX || style.overflow)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (/auto|scroll|hidden|clip/.test(style.overflowY || style.overflow)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  return `inset(${Math.max(0, top - rect.y)}px ${Math.max(0, rect.x + rect.width - right)}px ${Math.max(0, rect.y + rect.height - bottom)}px ${Math.max(0, left - rect.x)}px)`;
}
