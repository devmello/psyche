/**
 * The subset of Chrome DevTools Protocol shapes this package reads. Hand-written instead of
 * pulling `devtools-protocol` (8 MB of types) for ~20 interfaces; field names follow the CDP
 * spec (tip-of-tree, Chromium 152+).
 */

export interface AXValue {
  type: string;
  value?: unknown;
}

export interface AXProperty {
  name: string;
  value: AXValue;
}

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface RareStringData {
  index: number[];
  value: number[];
}
export interface RareBooleanData {
  index: number[];
}
export interface RareIntegerData {
  index: number[];
  value: number[];
}

export interface NodeTreeSnapshot {
  parentIndex?: number[];
  nodeType?: number[];
  nodeName?: number[];
  nodeValue?: number[];
  backendNodeId?: number[];
  attributes?: number[][];
  inputValue?: RareStringData;
  inputChecked?: RareBooleanData;
  contentDocumentIndex?: RareIntegerData;
  isClickable?: RareBooleanData;
}

export interface LayoutTreeSnapshot {
  nodeIndex: number[];
  bounds: number[][];
}

export interface DocumentSnapshot {
  documentURL: number;
  title: number;
  frameId: number;
  nodes: NodeTreeSnapshot;
  layout: LayoutTreeSnapshot;
}

export interface CaptureSnapshotResult {
  documents: DocumentSnapshot[];
  strings: string[];
}

export interface LayoutViewport {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
}

export interface VisualViewport extends LayoutViewport {
  offsetX?: number;
  offsetY?: number;
  scale?: number;
}

export interface LayoutMetrics {
  cssLayoutViewport?: LayoutViewport;
  cssVisualViewport?: VisualViewport;
  cssContentSize?: { x: number; y: number; width: number; height: number };
}

export interface FrameTree {
  frame: { id: string; parentId?: string; url: string; securityOrigin?: string; loaderId: string };
  childFrames?: FrameTree[];
}

export interface NavigationEntry {
  id: number;
  url: string;
  title: string;
}
