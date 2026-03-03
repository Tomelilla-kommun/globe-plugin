export const createElementFromMarkup = (markup: string): HTMLElement | undefined => {
  if (typeof document === 'undefined') return undefined;
  const template = document.createElement('div');
  template.innerHTML = markup.trim();
  return (template.firstElementChild as HTMLElement | null) ?? undefined;
};

export const stopDomEvent = (event: Event) => {
  event.preventDefault();
  (event as any).stopImmediatePropagation?.();
  event.stopPropagation();
};
