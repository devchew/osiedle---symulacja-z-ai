import type { World } from '../types';

// Small local interfaces for data the UI shows but other modules own
// (social/relationships relationOf, world/incidents weatherOf). main.ts adapts
// the real functions to these shapes, so UI components stay decoupled and
// degrade gracefully without them.

/** kind of a relationship between two residents, e.g. { label: 'para', icon: '💑' } */
export interface RelationInfo {
  /** Polish, short: "para", "rywale", "przyjaciele" */
  label: string;
  /** only for notable kinds (couple, rivals…): drawn on the network */
  icon?: string;
  /** extra numbers for tooltips, e.g. "romantyczność 40" */
  detail?: string;
}
export type RelationOfFn = (world: World, a: number, b: number) => RelationInfo | null | undefined;

/** current weather, e.g. { icon: '🌧️', label: 'Deszcz' } */
export interface WeatherInfo {
  icon: string;
  label: string;
}
export type WeatherOfFn = (world: World) => WeatherInfo | null | undefined;
