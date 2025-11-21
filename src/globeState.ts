import { ScreenSpaceEventHandler, Scene } from "cesium";

let cameraHeight = 1.6;
let isStreetMode = false;
let measuring  = false;
let handler: ScreenSpaceEventHandler | null = null;

export function getCameraHeight(): number {
  return cameraHeight;
}

export function getMeasuring(): boolean {
  return measuring ;
}

export function setMeasuring(value: boolean): void {
  measuring = value;
}

export function setCameraHeight(value: number): void {
  cameraHeight = value;
}

export function getIsStreetMode(): boolean {
  return isStreetMode;
}

export function setIsStreetMode(value: boolean): void {
  isStreetMode = value;
}

export function getHandler(): ScreenSpaceEventHandler | null {
  return handler;
}

export function setHandler(scene: Scene): void {
  handler = new ScreenSpaceEventHandler(scene.canvas);
}