import * as Cesium from 'cesium';
import OLCesium from 'olcs/OLCesium';
import flatpickr from 'flatpickr';

import type { PolygonUiApi } from './polygonUi';
import type { MeasureUiApi } from './measureUi';
import type { GlobeSettings } from './types';

/**
 * Centralized state management for the Globe plugin.
 * Provides reactive-style getters/setters for all globe state.
 */

// ============================================================================
// Core State
// ============================================================================

interface GlobeState {
  // Camera
  cameraHeight: number;
  isStreetMode: boolean;
  
  // Scene references
  scene: Cesium.Scene | null;
  oGlobe: OLCesium | null;
  map: any;
  viewer: any;
  
  // Feature info
  featureInfo: any;
  
  // Tools/UI
  measuring: boolean;
  handler: Cesium.ScreenSpaceEventHandler | null;
  flatpickr: flatpickr.Instance | null;
  polygonUi: PolygonUiApi | null;
  measureUi: MeasureUiApi | null;
  
  // Settings
  settings: GlobeSettings;
  
  // Lifecycle
  hasActivatedOnStart: boolean;
  isInitialized: boolean;
}

const defaultState: GlobeState = {
  cameraHeight: 1.6,
  isStreetMode: false,
  scene: null,
  oGlobe: null,
  map: null,
  viewer: null,
  featureInfo: null,
  measuring: false,
  handler: null,
  flatpickr: null,
  polygonUi: null,
  measureUi: null,
  settings: {},
  hasActivatedOnStart: false,
  isInitialized: false,
};

// Single source of truth for all state
const state: GlobeState = { ...defaultState };

// ============================================================================
// Camera State
// ============================================================================

export function getCameraHeight(): number {
  return state.cameraHeight;
}

export function setCameraHeight(value: number): void {
  state.cameraHeight = value;
}

export function getIsStreetMode(): boolean {
  return state.isStreetMode;
}

export function setIsStreetMode(value: boolean): void {
  state.isStreetMode = value;
}

// ============================================================================
// Scene References
// ============================================================================

export function getScene(): Cesium.Scene | null {
  return state.scene;
}

export function setScene(scene: Cesium.Scene | null): void {
  state.scene = scene;
}

export function getOGlobe(): OLCesium | null {
  return state.oGlobe;
}

export function setOGlobe(globe: OLCesium | null): void {
  state.oGlobe = globe;
}

export function getMap(): any {
  return state.map;
}

export function setMap(map: any): void {
  state.map = map;
}

export function getViewer(): any {
  return state.viewer;
}

export function setViewer(viewer: any): void {
  state.viewer = viewer;
}

export function getFeatureInfo(): any {
  return state.featureInfo;
}

export function setFeatureInfo(featureInfo: any): void {
  state.featureInfo = featureInfo;
}

// ============================================================================
// Tools State
// ============================================================================

export function getMeasuring(): boolean {
  return state.measuring;
}

export function setMeasuring(value: boolean): void {
  state.measuring = value;
}

export function getHandler(): Cesium.ScreenSpaceEventHandler | null {
  return state.handler;
}

export function setHandler(scene: Cesium.Scene): void {
  state.handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
}

export function clearHandler(): void {
  state.handler?.destroy();
  state.handler = null;
}

export function getFlatpickr(): flatpickr.Instance | null {
  return state.flatpickr;
}

export function setFlatpickr(fp: flatpickr.Instance | null): void {
  state.flatpickr = fp;
}

export function getPolygonUi(): PolygonUiApi | null {
  return state.polygonUi;
}

export function setPolygonUi(ui: PolygonUiApi | null): void {
  state.polygonUi = ui;
}

export function getMeasureUi(): MeasureUiApi | null {
  return state.measureUi;
}

export function setMeasureUi(ui: MeasureUiApi | null): void {
  state.measureUi = ui;
}

// ============================================================================
// Settings
// ============================================================================

export function getSettings(): GlobeSettings {
  return state.settings;
}

export function setSettings(settings: GlobeSettings): void {
  state.settings = settings;
}

// ============================================================================
// Lifecycle State
// ============================================================================

export function getHasActivatedOnStart(): boolean {
  return state.hasActivatedOnStart;
}

export function setHasActivatedOnStart(value: boolean): void {
  state.hasActivatedOnStart = value;
}

export function isInitialized(): boolean {
  return state.isInitialized;
}

export function setInitialized(value: boolean): void {
  state.isInitialized = value;
}

// ============================================================================
// Globe Active State (derived)
// ============================================================================

export function isGlobeActive(oGlobe?: OLCesium | null): boolean {
  const globe = oGlobe ?? state.oGlobe;
  return globe?.getEnabled() ?? false;
}

// ============================================================================
// State Reset (useful for cleanup/testing)
// ============================================================================

export function resetState(): void {
  // Cleanup handlers before reset
  state.handler?.destroy();
  
  // Reset to defaults
  Object.assign(state, defaultState);
}

// ============================================================================
// State Snapshot (useful for debugging)
// ============================================================================

export function getStateSnapshot(): Readonly<GlobeState> {
  return { ...state };
}

// ============================================================================
// Request render helper
// ============================================================================

export function requestSceneRender(): void {
  state.scene?.requestRender();
}
