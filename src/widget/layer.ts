import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';
// A native modal makes its siblings inert regardless of z-index. Keep this DOM
// island inside the last open native dialog while one exists. Its React owner
// stays unchanged; restore it before React removes it during unmount.
export function useFeedbackLayer(root: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const node = root.current;
    const home = node?.parentElement;
    if (!node || !home) return;
    const update = () => {
      const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
      const target = dialogs.at(-1) ?? home;
      if (node.parentElement !== target) target.append(node);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    update();
    return () => { observer.disconnect(); if (node.parentElement !== home) home.append(node); };
  }, [root]);
}
