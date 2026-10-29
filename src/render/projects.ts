import type { ObjectDef, ObjectInstance } from '../types';

// Drawing of construction sites and finished project buildings. Wave 9 stub.

/** true when this object type is drawn by drawProjectObject */
export function isProjectType(_type: string): boolean {
  return false;
}

export function drawProjectObject(_ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, _def: ObjectDef | undefined, _inst: ObjectInstance, _T: number): void {}
