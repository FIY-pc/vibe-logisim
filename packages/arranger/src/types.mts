// The observer's view of one circuit definition (run_full "focus"), as far
// as the layout engine reads it. Unlisted fields pass through untouched.

export interface XY {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NetBit {
  bit: number;
  netId: string;
}

export interface Attribute {
  name: string;
  value?: string;
  standard?: string;
  [key: string]: unknown;
}

export interface End {
  index: number;
  location: XY;
  width?: number | null;
  netBits?: NetBit[] | null;
  direction?: string | null;
  exclusive?: boolean;
  runtimeTooltip?: string | null;
  [key: string]: unknown;
}

export interface Component {
  componentId: string;
  factoryName: string;
  location: XY;
  bounds: Bounds;
  visualBounds?: Bounds;
  attributes: Attribute[];
  ends: End[];
  subcircuit?: unknown;
  [key: string]: unknown;
}

export interface Wire {
  from: XY;
  to: XY;
  bundleId?: string;
  wireId?: string;
  [key: string]: unknown;
}

export interface WireBundle {
  bundleId: string;
  valid?: boolean;
  points?: XY[];
  bitNets?: NetBit[];
  wireIds?: string[];
  [key: string]: unknown;
}

export interface Focus {
  circuit?: string | null;
  components: Component[];
  wires?: Wire[];
  wireBundles?: WireBundle[];
  [key: string]: unknown;
}
