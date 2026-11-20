// Source location from a click: a fake fiber tree in the React 18 and React 19 shapes, and a real React development build.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { targetFor } from './elements.js';
import { MAX_COMPONENTS, reactSource } from './reactSource.js';

type Fiber = Record<string, unknown>;
const withFiber = (fiber: Fiber, key = '__reactFiber$abc') => { const el = document.createElement('button'); Object.assign(el, { [key]: fiber }); return el; };
const host = (extra: Fiber = {}, parent?: Fiber): Fiber => ({ type: 'button', return: parent, ...extra });
const component = (name: string, extra: Fiber = {}, parent?: Fiber): Fiber => ({ type: { name }, return: parent, ...extra });
const stack = (...lines: string[]) => ({ stack: ['Error: react-stack-top-frame', ...lines].join('\n') });

describe('reactSource with a fake fiber tree', () => {
  it('has nothing for a node React did not render', () => {
    expect(reactSource(document.createElement('div'))).toEqual({ components: [] });
  });
  it('reads React 18 _debugSource on the element itself', () => {
    const card = component('Card', {}, undefined);
    const el = withFiber(host({ _debugSource: { fileName: '/app/src/Card.tsx', lineNumber: 42, columnNumber: 7 } }, card));
    expect(reactSource(el)).toEqual({ components: ['Card'], source: { file: '/app/src/Card.tsx', line: 42, column: 7, component: 'Card' } });
  });
  it('reads _debugSource from the alternate fiber', () => {
    const el = withFiber(host({ alternate: { _debugSource: { fileName: 'src/Alt.tsx', lineNumber: 3, columnNumber: 1 } } }, component('Alt')));
    expect(reactSource(el).source).toMatchObject({ file: 'src/Alt.tsx', line: 3, column: 1, component: 'Alt' });
  });
  it('reads React 19 _debugStack: skips React and node_modules frames, marks the position runtime, uses the frame name', () => {
    const el = withFiber(host({ _debugStack: stack(
      '    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:200:30)',
      '    at Thing (http://localhost:5173/src/ui/Thing.tsx?t=17:42:9)',
      '    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom.js:1:1)') }, component('Thing')));
    expect(reactSource(el)).toEqual({ components: ['Thing'], source: { file: 'src/ui/Thing.tsx', line: 42, column: 9, component: 'Thing', runtime: true } });
  });
  it('reads Firefox and Safari style stack lines', () => {
    const el = withFiber(host({ _debugStack: stack('jsxDEV@http://localhost/node_modules/react/jsx.js:3:4', 'Row@http://localhost/src/Row.tsx:8:2') }, component('Row')));
    expect(reactSource(el).source).toMatchObject({ file: 'src/Row.tsx', line: 8, column: 2, component: 'Row', runtime: true });
  });
  it('falls back to the nearest ancestor that has source, and says so', () => {
    const outer = component('Page', { _debugSource: { fileName: '/app/src/Page.tsx', lineNumber: 10, columnNumber: 3 } });
    const el = withFiber(host({}, component('Middle', {}, outer)));
    expect(reactSource(el)).toEqual({ components: ['Middle', 'Page'], source: { file: '/app/src/Page.tsx', line: 10, column: 3, component: 'Page', ancestor: true } });
  });
  it('degrades to component names only when nothing has a location (a production build)', () => {
    const el = withFiber(host({}, component('Card', {}, component('Page'))));
    expect(reactSource(el)).toEqual({ components: ['Card', 'Page'] });
  });
  it('caps the component names at 40, innermost first', () => {
    let fiber: Fiber = component('N0');
    for (let i = 1; i < 60; i++) fiber = component(`N${i}`, {}, fiber) as Fiber;
    const names = reactSource(withFiber(host({}, fiber))).components;
    expect(MAX_COMPONENTS).toBe(40);
    expect(names).toHaveLength(40);
    expect(names[0]).toBe('N59'); expect(names[39]).toBe('N20');
  });
  it('names memo and forwardRef components and skips host fibers and anonymous ones', () => {
    const memo = { type: { type: { name: 'Fancy' } }, return: { type: {}, return: component('Shell') } };
    expect(reactSource(withFiber(host({}, memo as Fiber))).components).toEqual(['Fancy', 'Shell']);
  });
  it('survives a cycle in the fiber tree', () => {
    const a: Fiber = component('A'); a.return = a;
    expect(reactSource(withFiber(host({}, a))).components).toEqual(['A']);
  });
  it('finds the old __reactInternalInstance$ key too', () => {
    const el = withFiber(host({ _debugSource: { fileName: 'a.tsx', lineNumber: 1, columnNumber: 1 } }, component('Old')), '__reactInternalInstance$x');
    expect(reactSource(el).source?.file).toBe('a.tsx');
  });
  it('strips control characters and caps long names and paths', () => {
    const long = `/${'a'.repeat(500)}.tsx`;
    const el = withFiber(host({ _debugSource: { fileName: long, lineNumber: 1, columnNumber: 1 } }, component('Bad\u001b[31mName')));
    const result = reactSource(el);
    expect(result.components).toEqual(['Bad[31mName']);
    expect(result.source!.file.length).toBeLessThanOrEqual(300);
  });
  it('adds the source to the captured target and leaves it off when there is none', () => {
    const withSource = withFiber(host({ _debugSource: { fileName: '/app/Card.tsx', lineNumber: 5, columnNumber: 2 } }, component('Card')));
    document.body.append(withSource);
    expect(targetFor(withSource)).toMatchObject({ components: ['Card'], source: { file: '/app/Card.tsx', line: 5, column: 2, component: 'Card' } });
    const plain = document.createElement('i'); document.body.append(plain);
    expect('source' in targetFor(plain)).toBe(false);
    withSource.remove(); plain.remove();
  });
});

function Inner() { return <button type="button">Hi</button>; }
function Outer() { return <section><Inner /></section>; }
describe('reactSource in a real React development build', () => {
  it('finds the file, line and column of the element from the debug stack', () => {
    const { container } = render(<Outer />);
    const result = reactSource(container.querySelector('button')!);
    expect(result.components).toEqual(['Inner', 'Outer']);
    expect(result.source).toMatchObject({ component: 'Inner', runtime: true });
    expect(result.source!.file.endsWith('reactSource.test.tsx')).toBe(true);
    expect(result.source!.line).toBeGreaterThan(0); expect(result.source!.column).toBeGreaterThan(0);
  });
});
