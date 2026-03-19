/**
 * SVG icon definitions and utilities for the Globe plugin.
 * Centralizes all icon SVG data for easy maintenance and extension.
 */

// ============================================================================
// SVG Icon Definitions
// ============================================================================

export interface SvgIconDef {
  id: string;
  viewBox: string;
  svg: string;
}

/**
 * Built-in globe plugin icons
 */
export const GLOBE_ICONS: Record<string, SvgIconDef> = {
  cube: {
    id: 'ic_cube_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L6.04,7.5L12,10.85L17.96,7.5L12,4.15Z" />',
  },
  clock: {
    id: 'ic_clock-time-four_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22C17.5 22 22 17.5 22 12S17.5 2 12 2M16.3 15.2L11 12.3V7H12.5V11.4L17 13.9L16.3 15.2Z" />',
  },
  boxShadow: {
    id: 'ic_box-shadow_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M3,3H18V18H3V3M19,19H21V21H19V19M19,16H21V18H19V16M19,13H21V15H19V13M19,10H21V12H19V10M19,7H21V9H19V7M16,19H18V21H16V19M13,19H15V21H13V19M10,19H12V21H10V19M7,19H9V21H7V19Z" />',
  },
  chevronRight: {
    id: 'ic_chevron_right_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />',
  },
  polygon: {
    id: 'o_polygon_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M3 17.25V21h3.75l11.06-11.06-3.75-3.75L3 17.25zm2.92 2.08H5v-1.92l9.06-9.06 1.92 1.92-9.06 9.06zm13.06-12.19c.39-.39.39-1.02 0-1.41l-2.34-2.34a.995.995 0 0 0-1.41 0l-1.13 1.13 3.75 3.75 1.13-1.13z" />',
  },
  height: {
    id: 'ic_height_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M7 2h10v2H7V2zm0 18h10v2H7v-2zM11 6h2v12h-2V6zm-3 3l-3 3 3 3V9zm8 0v6l3-3-3-3z" />',
  },
  delete: {
    id: 'ic_delete_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />',
  },
  share: {
    id: 'ic_share_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.03-.47-.09-.7l7.02-4.11c.53.5 1.23.81 2.01.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.07 8.81C7.53 8.31 6.83 8 6.05 8c-1.66 0-3 1.34-3 3s1.34 3 3 3c.78 0 1.48-.31 2.01-.81l7.12 4.17c-.05.21-.08.43-.08.64 0 1.52 1.23 2.75 2.75 2.75s2.75-1.23 2.75-2.75-1.23-2.75-2.75-2.75z" />',
  },
  title: {
    id: 'ic_title_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M3 5v14h18V5H3zm16 12H5V7h14v10z" /><path d="M7 9h10v2H7V9zm0 4h6v2H7v-2z" />',
  },
  download: {
    id: 'ic_download_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M5 20h14v-2H5v2zm7-18c-.55 0-1 .45-1 1v10.59l-3.29-3.29c-.63-.63-1.71-.18-1.71.71 0 .39.16.77.44 1.06l5 5c.39.39 1.02.39 1.41 0l5-5c.28-.29.44-.67.44-1.06 0-.89-1.08-1.34-1.71-.71L13 13.59V3c0-.55-.45-1-1-1z" />',
  },
  flash: {
    id: 'ic_flash_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M7 2v11h3v9l7-12h-4l4-8z" />',
  },
  walk: {
    id: 'ic_walk_24px',
    viewBox: '0 0 24 24',
    svg: '<path d="M14.12,10H19V8.2H15.38L13.38,4.87C13.08,4.37 12.54,4.03 11.92,4.03C11.74,4.03 11.58,4.06 11.42,4.11L6,5.8V11H7.8V7.33L9.91,6.67L6,22H7.8L10.67,13.89L13,17V22H14.8V15.59L12.31,11.05L13.04,8.18M14,3.8C15,3.8 15.8,3 15.8,2C15.8,1 15,0.2 14,0.2C13,0.2 12.2,1 12.2,2C12.2,3 13,3.8 14,3.8Z"/>',
  },
};

// ============================================================================
// SVG Injection Utilities
// ============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPRITE_WRAPPER_ID = 'globe-svg-sprite';

/**
 * Ensures a single SVG symbol exists in the sprite
 */
function ensureSymbol(spriteSvg: SVGSVGElement, icon: SvgIconDef): void {
  if (document.getElementById(icon.id)) return;
  
  const symbol = document.createElementNS(SVG_NS, 'symbol');
  symbol.setAttribute('id', icon.id);
  symbol.setAttribute('viewBox', icon.viewBox);
  symbol.innerHTML = icon.svg;
  spriteSvg.appendChild(symbol);
}

/**
 * Gets or creates the SVG sprite wrapper element
 */
function getOrCreateSpriteWrapper(trackNode: (node: HTMLElement) => HTMLElement): HTMLElement {
  let wrapper = document.getElementById(SPRITE_WRAPPER_ID);
  
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = SPRITE_WRAPPER_ID;
    wrapper.style.display = 'none';
    
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    wrapper.appendChild(svg);
    
    document.body.insertBefore(wrapper, document.body.firstChild ?? null);
    trackNode(wrapper);
  }
  
  return wrapper;
}

/**
 * Gets or creates the SVG element inside the sprite wrapper
 */
function getOrCreateSpriteSvg(wrapper: HTMLElement): SVGSVGElement {
  let svg = wrapper.querySelector('svg');
  
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    wrapper.appendChild(svg);
  }
  
  return svg;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initializes all built-in SVG icons
 */
export function initializeSvgIcons(trackNode: (node: HTMLElement) => HTMLElement): void {
  if (typeof document === 'undefined' || !document.body) return;
  
  const wrapper = getOrCreateSpriteWrapper(trackNode);
  const spriteSvg = getOrCreateSpriteSvg(wrapper);
  
  Object.values(GLOBE_ICONS).forEach(icon => {
    ensureSymbol(spriteSvg, icon);
  });
}

/**
 * Adds a custom icon to the sprite
 */
export function addCustomIcon(
  icon: SvgIconDef,
  trackNode: (node: HTMLElement) => HTMLElement
): void {
  if (typeof document === 'undefined' || !document.body) return;
  
  const wrapper = getOrCreateSpriteWrapper(trackNode);
  const spriteSvg = getOrCreateSpriteSvg(wrapper);
  
  ensureSymbol(spriteSvg, icon);
}

/**
 * Adds multiple custom icons to the sprite
 */
export function addCustomIcons(
  icons: SvgIconDef[],
  trackNode: (node: HTMLElement) => HTMLElement
): void {
  if (typeof document === 'undefined' || !document.body) return;
  
  const wrapper = getOrCreateSpriteWrapper(trackNode);
  const spriteSvg = getOrCreateSpriteSvg(wrapper);
  
  icons.forEach(icon => ensureSymbol(spriteSvg, icon));
}

/**
 * Check if an icon exists in the sprite
 */
export function hasIcon(iconId: string): boolean {
  return document.getElementById(iconId) !== null;
}
