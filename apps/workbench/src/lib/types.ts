import type { Point } from "../generated/Point";
export type { Point } from "../generated/Point";
export type { Component } from "../generated/Component";
export type { Wire } from "../generated/Wire";
export type { Circuit } from "../generated/Circuit";
export type { DocumentView as Document } from "../generated/DocumentView";
export type { Edit } from "../generated/Edit";
export interface Bounds extends Point {
  width: number;
  height: number;
}
export interface XmlNode {
  tag: string;
  attributes: Record<string, string>;
  text: string | null;
  children: XmlNode[];
  exited?: boolean;
}
export interface Simulation {
  documentId: string;
  revision: string;
  circuit: string;
  viewId: string;
  rootCircuit: string;
  instancePath: string[];
  frame: XmlNode;
}
export interface ObservedComponent {
  componentId: string;
  factoryName: string;
  location: Point;
  bounds: Bounds;
  ends: { location: Point; width: number; direction: string; index: number }[];
}
export interface Observation {
  components?: ObservedComponent[];
  [key: string]: unknown;
}
export interface CatalogTool {
  name: string;
  label: string;
  library: string;
  icon?: string;
  disabled?: string;
}
export interface CatalogGroup {
  id: string;
  label: string;
  tools: CatalogTool[];
}
export type Tool = "select" | "wire" | "pan" | "poke";
