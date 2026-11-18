import { createContext, domToCanvas } from 'modern-screenshot';
import type { Context, Options } from 'modern-screenshot';
import { isWidget } from './elements.js';
import { documentClone, viewportClone } from './screenshot-layout.js';
import type { Capture, Rect } from './types.js';
const filter = (node: Node) => !(node instanceof Element) || (!node.closest('noscript') && !isWidget(node));
// Fetched images, stylesheets and fonts are inlined as data URLs on every capture, which is slow over a
// tunnel. Keep those results for the page session, so a later capture only fetches what is new.
const cache = { requests: new Map() as Context['requests'], fonts: new Map() as Context['fontCssTexts'] };
const CACHE_LIMIT = 400;
async function render(options: Options): Promise<HTMLCanvasElement> {
  if (cache.requests.size > CACHE_LIMIT) cache.requests.clear();
  const context = await createContext(document.documentElement, options);
  context.requests = cache.requests; context.fontCssTexts = cache.fonts;
  try { return await domToCanvas(context); } finally { context.sandbox?.remove(); }
}
export function canvasFor(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width)); canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not create a drawing canvas.');
  return { canvas, ctx };
}
export async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image(); image.src = url; await image.decode(); return image;
}
export function cropRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width, rect.x - 12));
  const y = Math.max(0, Math.min(height, rect.y - 12));
  const right = Math.max(x, Math.min(width, rect.x + rect.width + 12));
  const bottom = Math.max(y, Math.min(height, rect.y + rect.height + 12));
  return { x, y, width: right - x, height: bottom - y };
}
export async function captureViewport(rect: Rect): Promise<Capture> {
  const x = scrollX, y = scrollY, width = innerWidth, height = innerHeight, scale = devicePixelRatio || 1;
  const source = await render({
    width, height, scale, filter,
    style: { transform: `translate(${-x}px, ${-y}px)`, overflow: 'visible' },
    features: { restoreScrollPosition: true },
    fetch: { requestInit: { credentials: 'same-origin' } },
    onCloneNode: viewportClone({ x, y }),
  });
  const area = cropRect(rect, width, height);
  if (!area.width || !area.height) throw new Error('The capture is outside the viewport.');
  const { canvas, ctx } = canvasFor(area.width * scale, area.height * scale);
  ctx.drawImage(source, area.x * scale, area.y * scale, area.width * scale, area.height * scale, 0, 0, canvas.width, canvas.height);
  // Save the crop before drawing the context outline on a separate canvas.
  const shot = { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, origin: { x: x + area.x, y: y + area.y } };
  const context = canvasFor(width * scale, height * scale);
  context.ctx.drawImage(source, 0, 0);
  context.ctx.strokeStyle = '#b02f62'; context.ctx.lineWidth = 3 * scale;
  context.ctx.strokeRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale);
  return { shot, contextImage: context.canvas.toDataURL('image/png') };
}
export function pageSize() {
  const html = document.documentElement, body = document.body;
  return { width: Math.max(innerWidth, html.scrollWidth, body.scrollWidth), height: Math.max(innerHeight, html.scrollHeight, body.scrollHeight) };
}
export async function capturePage(size: { width: number; height: number }): Promise<Capture> {
  const height = Math.min(size.height, 16000), scale = devicePixelRatio || 1;
  const source = await render({
    width: size.width, height, scale, filter,
    style: { transform: 'none', overflow: 'visible', height: `${height}px` },
    features: { restoreScrollPosition: true },
    fetch: { requestInit: { credentials: 'same-origin' } },
    onCloneNode: documentClone(),
  });
  return {
    shot: { url: source.toDataURL('image/png'), width: source.width, height: source.height, origin: { x: 0, y: 0 } },
    clipped: size.height > height ? `Full page capture clipped at 16 000 px (page height: ${size.height} px).` : undefined,
  };
}
