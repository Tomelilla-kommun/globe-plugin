import Origo, { OrigoButton } from 'Origo';

export interface ButtonConfig {
  id: string;
  cls?: string;
  icon: string;
  tooltipText: string;
  tooltipPlacement?: 'east' | 'west' | 'north' | 'south';
  hidden?: boolean;
  active?: boolean;
  disabled?: boolean;
  /** Condition to determine if this button should be created */
  enabled?: boolean;
  onClick?: (instance: ButtonInstance, buttonEl: HTMLElement) => void;
}

export interface ButtonInstance {
  config: ButtonConfig;
  button: OrigoButton;
  getElement: () => HTMLElement | null;
  setVisible: (visible: boolean) => void;
  setActive: (active: boolean) => void;
  setDisabled: (disabled: boolean) => void;
  isActive: () => boolean;
  isVisible: () => boolean;
}

const DEFAULT_BUTTON_CLS = 'padding-small margin-bottom-smaller icon-smaller round light box-shadow';

/**
 * Creates a button instance with helper methods for state management
 */
export function createButton(config: ButtonConfig): ButtonInstance {
  const {
    cls = DEFAULT_BUTTON_CLS,
    icon,
    tooltipText,
    tooltipPlacement = 'east',
    hidden = false,
    active = false,
    onClick,
  } = config;

  const buttonCls = [
    cls,
    hidden ? 'hidden' : '',
    active ? 'active' : '',
  ].filter(Boolean).join(' ');

  // We need to create instance first, then set up the button click handler
  // Use a wrapper object to allow late binding
  let instanceRef: ButtonInstance | null = null;

  const button = Origo.ui.Button({
    cls: buttonCls,
    click() {
      const el = document.getElementById(button.getId());
      if (el && onClick && instanceRef) {
        onClick(instanceRef, el);
      }
    },
    icon,
    tooltipText,
    tooltipPlacement,
  });

  const instance: ButtonInstance = {
    config,
    button,
    
    getElement() {
      return document.getElementById(button.getId());
    },

    setVisible(visible: boolean) {
      const el = this.getElement();
      if (el) {
        el.classList.toggle('hidden', !visible);
      }
    },

    setActive(active: boolean) {
      const el = this.getElement();
      if (el) {
        el.classList.toggle('active', active);
      }
    },

    setDisabled(disabled: boolean) {
      const el = this.getElement();
      if (el) {
        el.classList.toggle('disabled', disabled);
        (el as HTMLButtonElement).disabled = disabled;
      }
    },

    isActive() {
      return this.getElement()?.classList.contains('active') ?? false;
    },

    isVisible() {
      const el = this.getElement();
      return el ? !el.classList.contains('hidden') : false;
    },
  };

  // Set the reference so the click handler can access it
  instanceRef = instance;

  return instance;
}

/**
 * Manages a collection of buttons with group operations
 */
export class ButtonManager {
  private buttons = new Map<string, ButtonInstance>();
  private renderOrder: string[] = [];

  register(config: ButtonConfig): ButtonInstance | null {
    // Skip if button is disabled via config
    if (config.enabled === false) {
      return null;
    }

    const instance = createButton(config);
    this.buttons.set(config.id, instance);
    this.renderOrder.push(config.id);
    return instance;
  }

  get(id: string): ButtonInstance | undefined {
    return this.buttons.get(id);
  }

  getAll(): ButtonInstance[] {
    return this.renderOrder
      .map(id => this.buttons.get(id))
      .filter((b): b is ButtonInstance => b !== undefined);
  }

  getOrigoButtons(): OrigoButton[] {
    return this.getAll().map(b => b.button);
  }

  /**
   * Set visibility for multiple buttons at once
   */
  setGroupVisibility(ids: string[], visible: boolean): void {
    ids.forEach(id => this.get(id)?.setVisible(visible));
  }

  /**
   * Set disabled state for multiple buttons at once
   */
  setGroupDisabled(ids: string[], disabled: boolean): void {
    ids.forEach(id => this.get(id)?.setDisabled(disabled));
  }

  /**
   * Render all buttons into a container element
   */
  renderInto(container: HTMLElement): void {
    this.getAll().forEach(instance => {
      const markup = instance.button.render();
      const node = Origo.ui.dom.html(markup);
      container.appendChild(node);
    });
  }

  /**
   * Render specific buttons by id into a container
   */
  renderButtonsInto(container: HTMLElement, ids: string[]): void {
    ids.forEach(id => {
      const instance = this.get(id);
      if (instance) {
        const markup = instance.button.render();
        const node = Origo.ui.dom.html(markup);
        container.appendChild(node);
      }
    });
  }

  clear(): void {
    this.buttons.clear();
    this.renderOrder = [];
  }
}
