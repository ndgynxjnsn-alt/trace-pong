// Shared types between the data sources, the scene and the panel.

export type Rgb = [number, number, number];

/** cloud: callers we cannot see (no traceparent, no user), i.e. uninstrumented clients */
export type NodeKind = 'service' | 'database' | 'external' | 'user' | 'cloud';
export type HopKind = 'http' | 'messaging' | 'db' | 'ext';
export type Severity = 'err' | 'warn' | 'redirect' | 'ok';
export type RateWindow = '30s' | '1m' | '2m' | '5m' | '15m';

/** One client->server call, from a span pair of a trace. Times in epoch ms. */
export interface Hop {
  /** start */
  t: number;
  /** duration */
  d: number;
  /** caller (client service) */
  f: string;
  /** callee (server service, or virtual node) */
  to: string;
  /** span name */
  n: string;
  /** HTTP status code, 0 if none */
  c: number;
  /** error */
  e: boolean;
  k: HopKind;
  /** trace id (hex) */
  tr: string;
  /** caller's endpoint: the server span (or frontend view) the call was made from */
  fe?: string;
  /** callee's endpoint: server span name, frontend view, or database table */
  te?: string;
  /** callee's group path for the endpoint view, e.g. ['gateway'] or ['postgres', 'users_db'] */
  tg?: string[];
  /** the end user, when the caller is a user (f === 'user') */
  u?: UserInfo;
}

/** An end user, from OAuth claims that Faro or the backend put on the root span. */
export interface UserInfo {
  id: string;
  /** full name, if known */
  name?: string;
  username?: string;
  email?: string;
}

/** View settings toggled from the help overlay (not panel options). */
export interface ViewMode {
  /** one node per endpoint (and database table), grouped by service */
  endpoints: boolean;
  /** label user nodes with names instead of ids */
  userNames: boolean;
  layout: 'radial' | 'flow';
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  rate: number;
  errRate: number;
  outRate: number;
  mean: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Tempo connection_type: '', 'database', 'messaging_system', 'virtual_node' */
  type: string;
  rate: number;
  errRate: number;
  mean: number | null;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Feeds a scene with graph updates and hops. */
export interface Source {
  status: {
    error: string | null;
    /** what we are waiting for while there is nothing to show */
    waiting: string | null;
  };
  stop(): void;
}

/** What the renderer needs from its host (the Grafana panel). */
export interface Env {
  get<T>(url: string, params?: Record<string, string | number>): Promise<T>;
  /** interpolate dashboard variables */
  replace(s: string): string;
}

/** Panel options as stored in the dashboard. */
export interface PanelOptions {
  mode: 'live' | 'sim';
  tempoUid?: string;
  promUid?: string;
  traceql: string;
  labelFilter: string;
  window: RateWindow;
  maxTraces: number;
  showClock: boolean;
  labels: boolean;
  bloom: boolean;
  speed: number;
  stretch: number;
}

/** Panel options with data sources resolved to proxy URLs. */
export interface ViewOptions extends Omit<PanelOptions, 'tempoUid' | 'promUid'> {
  tempoUrl: string;
  promUrl: string;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  auto: boolean;
}
