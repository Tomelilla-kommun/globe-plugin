import flatpickr from 'flatpickr';
import Origo from 'Origo';
import type { CleanupFn } from '../globe/types';

export interface TimeSetterResult {
  fp: flatpickr.Instance;
  cleanup: CleanupFn;
}

export interface TimeSetterOptions {
  target: string;
  trackNode: (node: HTMLElement) => HTMLElement;
  requestSceneRender?: () => void;
}

/**
 * Creates a flatpickr time picker element and mounts it to the target container.
 * Returns the flatpickr instance and a cleanup function.
 */
export default function timeSetter(options: TimeSetterOptions): TimeSetterResult | undefined {
  const { target, trackNode, requestSceneRender } = options;

  const parent = document.getElementById(target);
  if (!parent) return;

  const flatpickrEl = Origo.ui.Element({ tagName: 'div', cls: 'flatpickrEl z-index-ontop-top-times20' });
  const markup = flatpickrEl.render();
  const htmlNode = Origo.ui.dom.html(markup) as (HTMLElement | DocumentFragment | null);
  const targetElement = htmlNode instanceof HTMLElement
    ? htmlNode
    : htmlNode?.firstElementChild as HTMLElement | null;

  if (!htmlNode || !targetElement) return;

  parent.appendChild(htmlNode);
  trackNode(targetElement);

  let positionObserver: MutationObserver | null = null;

  const fp = flatpickr(targetElement, {
    enableTime: true,
    defaultDate: new Date(),
    enableSeconds: true,
    disableMobile: true,
    time_24hr: true,
    onChange: () => {
      requestSceneRender?.();
    },
    onReady: (_selectedDates, _dateStr, instance) => {
      const calendar = instance.calendarContainer;
      if (!calendar) return;
      
      // Use MutationObserver to override flatpickr's positioning
      positionObserver = new MutationObserver(() => {
        if (calendar.style.left !== '60px') {
          calendar.style.setProperty('left', '60px', 'important');
        }
      });
      
      positionObserver.observe(calendar, {
        attributes: true,
        attributeFilter: ['style'],
      });
      
      calendar.style.setProperty('left', '30px', 'important');
    },
  });

  const cleanup: CleanupFn = () => {
    positionObserver?.disconnect();
    fp?.destroy();
    targetElement.remove();
  };

  return { fp, cleanup };
}
