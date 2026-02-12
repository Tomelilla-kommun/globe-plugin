import Origo from 'Origo';

const QUICK_TIME_PRESETS = [
  { date: '2025-03-20', label: '20 Mars' },
  { date: '2025-06-21', label: '21 Juni' },
  { date: '2025-09-22', label: '22 September' },
  { date: '2025-09-23', label: '23 September' },
  { date: '2025-12-21', label: '21 December' }
] as const;

const QUICK_TIME_HOURS = [9, 12, 16] as const;

export default function quickTimePicker(resolvePicker: () => any): { button: any; container: HTMLDivElement; dispose: () => void } | null {
  if (typeof document === 'undefined' || !document.body) return null;

  const container = document.createElement('div');
  Object.assign(container.style, {
    display: 'none',
    position: 'absolute',
    zIndex: '9999',
    padding: '8px',
    background: '#fff',
    border: '1px solid #e9e9e9',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
    borderRadius: '4px',
    fontSize: '13px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
  });

  container.classList.add('quick-time-container', 'origo-popup', 'animate', 'flatpickr');
  document.body.appendChild(container);
  // trackNodeFn(container);

  QUICK_TIME_PRESETS.forEach(({ date, label }) => {
    const header = document.createElement('div');
    header.textContent = label;
    Object.assign(header.style, {
      fontSize: '12px',
      fontWeight: '600',
      color: 'rgba(0,0,0,0.54)',
      margin: '6px 0 4px'
    });
    container.appendChild(header);

    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      gap: '6px',
      marginBottom: '4px'
    });

    QUICK_TIME_HOURS.forEach((hour) => {
      const btn = document.createElement('button');
      btn.textContent = `${hour}:00`;
      Object.assign(btn.style, {
        background: 'transparent',
        border: '1px solid #e9e9e9',
        borderRadius: '4px',
        padding: '6px 10px',
        fontSize: '13px',
        color: '#404848',
        cursor: 'pointer',
        transition: 'background 0.15s ease, border-color 0.15s ease'
      });

      btn.classList.add('quick-time-button', 'small');
      btn.onmouseenter = () => {
        btn.style.background = '#e9e9e9';
        btn.style.borderColor = '#e9e9e9';
      };
      btn.onmouseleave = () => {
        btn.style.background = 'transparent';
        btn.style.borderColor = '#e9e9e9';
      };
      btn.onclick = () => {
        const resolvedPicker = resolvePicker();
        const pickerInstance = Array.isArray(resolvedPicker) ? resolvedPicker[0] ?? null : resolvedPicker;
        if (!pickerInstance) return;
        if (typeof pickerInstance.setDate !== 'function') {
          console.warn('Quick time picker could not update the flatpickr instance.');
          return;
        }
        const d = new Date(date);
        d.setHours(hour, 0, 0);
        pickerInstance.setDate(d, true);
        container.style.display = 'none';
      };

      row.appendChild(btn);
    });

    container.appendChild(row);
  });

  const button = Origo.ui.Button({
    cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow quick-time-button',
    click() {
      const isVisible = container.style.display === 'block';
      container.style.display = isVisible ? 'none' : 'block';

      if (!isVisible) {
        const btnEl = document.getElementById(button.getId());
        if (btnEl) {
          const rect = btnEl.getBoundingClientRect();
          container.style.left = `${rect.right + 10}px`;
          container.style.top = `${rect.top}px`;
        }
      }
    },
    icon: '#ic_clock-time-four_24px',
    tooltipText: 'Snabbval för tid',
    tooltipPlacement: 'east'
  });

  return {
    button,
    container,
    dispose: () => container.remove()
  };
};