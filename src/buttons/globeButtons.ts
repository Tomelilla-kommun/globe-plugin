import type { ButtonConfig } from './buttonFactory';

export const BUTTON_IDS = {
  GLOBE: 'globe',
  FLATPICKR: 'flatpickr',
  VIEWSHED: 'viewshed',
  DRAW_TOOL: 'drawTool',
  QUICK_TIME: 'quickTime',
  SHADOWS: 'shadows',
  FX: 'fx',
} as const;

export type ButtonId = typeof BUTTON_IDS[keyof typeof BUTTON_IDS];

export interface GlobeButtonsOptions {
  viewShed?: boolean;
  drawTool?: boolean;
  quickTimeShadowPicker?: boolean;
  fx?: boolean;
}

/**
 * Returns button configurations for the globe plugin.
 * Callbacks are provided separately to keep configs pure data.
 */
export function getGlobeButtonConfigs(options: GlobeButtonsOptions): ButtonConfig[] {
  const { viewShed, drawTool, quickTimeShadowPicker, fx } = options;

  return [
    {
      id: BUTTON_IDS.GLOBE,
      icon: '#ic_cube_24px',
      tooltipText: 'Slå på/av 3D-vy',
      enabled: true,
    },
    {
      id: BUTTON_IDS.SHADOWS,
      icon: '#ic_box-shadow_24px',
      tooltipText: 'Slå på/av skuggor',
      hidden: true,
      enabled: true,
    },
    {
      id: BUTTON_IDS.FLATPICKR,
      icon: '#ic_clock-time-four_24px',
      tooltipText: 'Val av tid',
      hidden: true,
      disabled: true,
      enabled: true,
    },
    {
      id: BUTTON_IDS.QUICK_TIME,
      icon: '#ic_chevron_right_24px',
      tooltipText: 'Snabbval tid',
      hidden: true,
      disabled: true,
      enabled: quickTimeShadowPicker,
    },
    {
      id: BUTTON_IDS.DRAW_TOOL,
      icon: '#fa-pencil',
      tooltipText: 'Rita',
      hidden: true,
      enabled: drawTool,
    },
    {
      id: BUTTON_IDS.VIEWSHED,
      icon: '#ic_visibility_24px',
      tooltipText: 'Siktanalys',
      hidden: true,
      enabled: viewShed,
    },
    {
      id: BUTTON_IDS.FX,
      cls: 'padding-small margin-bottom-smaller icon-smaller round light box-shadow active',
      icon: '#ic_cube_24px',
      tooltipText: 'Toggle FX Settings',
      hidden: true,
      active: true,
      enabled: fx,
    },
  ];
}

/**
 * IDs of buttons that should toggle visibility when globe is activated/deactivated
 */
export const GLOBE_DEPENDENT_BUTTONS: ButtonId[] = [
  BUTTON_IDS.SHADOWS,
  BUTTON_IDS.FLATPICKR,
  BUTTON_IDS.QUICK_TIME,
  BUTTON_IDS.DRAW_TOOL,
  BUTTON_IDS.VIEWSHED,
  BUTTON_IDS.FX,
];

/**
 * IDs of buttons that should be disabled when shadows are off
 */
export const SHADOW_DEPENDENT_BUTTONS: ButtonId[] = [
  BUTTON_IDS.FLATPICKR,
  BUTTON_IDS.QUICK_TIME,
];
