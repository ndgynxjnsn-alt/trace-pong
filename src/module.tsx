// trace-pong Grafana panel: options, data source resolution and the React wrapper around the
// WebGPU renderer (src/app.ts).
import React, { useEffect, useRef, useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { PanelPlugin, type DataSourceInstanceSettings, type PanelProps, type StandardEditorProps } from '@grafana/data';
import { DataSourcePicker, getBackendSrv, getDataSourceSrv, getTemplateSrv } from '@grafana/runtime';
import { createTracePong, type TracePongHandle } from './app';
import type { Env, PanelOptions, RateWindow, ViewOptions } from './types';

// ---- data sources ------------------------------------------------------------------------
interface TempoJsonData {
  serviceMap?: { datasourceUid?: string };
}

function settings(uid: string | undefined): DataSourceInstanceSettings | undefined {
  if (!uid) return undefined;
  try {
    return getDataSourceSrv().getInstanceSettings(uid);
  } catch {
    return undefined;
  }
}

function firstOfType(type: string): DataSourceInstanceSettings | undefined {
  const list = getDataSourceSrv().getList({ type });
  return list.find((d) => d.isDefault) ?? list[0];
}

/** Panel options -> what the renderer needs (proxy URLs instead of data source UIDs). */
export function resolve(o: PanelOptions): ViewOptions {
  const tempo = settings(o.tempoUid) ?? firstOfType('tempo');
  const promUid = o.promUid || (tempo?.jsonData as TempoJsonData | undefined)?.serviceMap?.datasourceUid;
  const prom = settings(promUid) ?? (o.promUid ? undefined : firstOfType('prometheus'));
  return {
    mode: o.mode || 'live',
    tempoUrl: tempo?.url ?? '',
    promUrl: prom?.url ?? '',
    traceql: o.traceql || '',
    labelFilter: o.labelFilter || '',
    window: o.window || '1m',
    maxTraces: o.maxTraces || 30,
    sampling: o.sampling || 10,
    interpolate: o.interpolate !== false,
    rename: o.rename || '',
    showClock: o.showClock !== false,
    labels: o.labels !== false,
    bloom: o.bloom !== false,
    speed: o.speed || 1,
    stretch: o.stretch || 2,
  };
}

/** Requests go through Grafana's data source proxy, which adds auth and tenant headers. */
function makeEnv(latest: React.RefObject<PanelProps<PanelOptions>>): Env {
  return {
    get: async <T,>(url: string, params?: Record<string, string | number>) => {
      const res = await lastValueFrom(getBackendSrv().fetch<T>({
        url, params, method: 'GET', showErrorAlert: false, showSuccessAlert: false,
      }));
      return res.data;
    },
    // dashboard variables in filters, re-read on every poll
    replace: (s: string) => latest.current?.replaceVariables(s) ?? getTemplateSrv().replace(s),
  };
}

// ---- the panel ---------------------------------------------------------------------------
type TracePongElement = HTMLDivElement & { __tracepong?: TracePongHandle };

function TracePongPanel(props: PanelProps<PanelOptions>) {
  const box = useRef<TracePongElement>(null);
  const app = useRef<TracePongHandle | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState<string | null>(null);
  const opts = resolve(props.options);
  const key = JSON.stringify(opts);

  useEffect(() => {
    let dead = false;
    let inst: TracePongHandle | null = null;
    const el = box.current;
    if (!el) return undefined;
    createTracePong(el, makeEnv(latest), resolve(latest.current.options))
      .then((a) => {
        if (dead) {
          a.destroy();
          return;
        }
        inst = a;
        app.current = a;
        a.setOptions(resolve(latest.current.options));
        el.__tracepong = a;
      })
      .catch((e: unknown) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
      inst?.destroy();
      app.current = null;
    };
  }, []);

  useEffect(() => {
    app.current?.setOptions(opts);
    // `key` captures every resolved option
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div ref={box} className="tracepong-panel" style={{ position: 'relative', width: props.width, height: props.height }}>
      {error && <div style={{ padding: 12, color: '#ff4d5e' }}>trace-pong failed to load: {error}</div>}
    </div>
  );
}

// ---- options -------------------------------------------------------------------------------
function dsPicker(type: string, placeholder: string) {
  return function DsPicker({ value, onChange }: StandardEditorProps<string | undefined>) {
    return (
      <DataSourcePicker
        current={value ?? null}
        type={type}
        noDefault
        placeholder={placeholder}
        onClear={() => onChange(undefined)}
        onChange={(ds: DataSourceInstanceSettings) => onChange(ds.uid)}
      />
    );
  };
}

const isLive = (o: PanelOptions) => o.mode !== 'sim';
const WINDOWS: RateWindow[] = ['30s', '1m', '2m', '5m', '15m'];
const SAMPLING = [100, 50, 25, 20, 10, 5, 2, 1];

export const plugin = new PanelPlugin<PanelOptions>(TracePongPanel)
  .setNoPadding()
  .setPanelOptions((builder) => {
    builder
      .addRadio({
        path: 'mode', name: 'Data', defaultValue: 'live', category: ['Data'],
        settings: { options: [{ value: 'live', label: 'Live (Tempo)' }, { value: 'sim', label: 'Simulator' }] },
      })
      .addCustomEditor({
        id: 'tempoUid', path: 'tempoUid', name: 'Tempo data source', category: ['Data'], showIf: isLive,
        description: 'Traces are replayed from here. Tenant and auth come from the data source settings. Empty: the first Tempo data source.',
        editor: dsPicker('tempo', 'first Tempo data source'),
      })
      .addCustomEditor({
        id: 'promUid', path: 'promUid', name: 'Service graph metrics data source', category: ['Data'], showIf: isLive,
        description: "Mimir/Prometheus holding traces_service_graph_* series. Empty: the Tempo data source's service map data source.",
        editor: dsPicker('prometheus', 'from Tempo service map setting'),
      })
      .addTextInput({
        path: 'traceql', name: 'TraceQL filter', category: ['Data'], showIf: isLive, defaultValue: '{ true }',
        description: 'Which traces to replay, e.g. { resource.deployment.environment = "prod" }. Dashboard variables work.',
      })
      .addTextInput({
        path: 'labelFilter', name: 'Service graph label filter', category: ['Data'], showIf: isLive, defaultValue: '',
        description: 'PromQL label matchers added to the service-graph queries, e.g. cluster="prod". Dashboard variables work.',
      })
      .addSelect({
        path: 'window', name: 'Rate window', category: ['Data'], showIf: isLive, defaultValue: '1m',
        settings: { options: WINDOWS.map((v) => ({ value: v, label: v })) },
      })
      .addNumberInput({
        path: 'maxTraces', name: 'Traces per second', category: ['Data'], showIf: isLive, defaultValue: 30,
        description: 'Upper bound of traces fetched from Tempo per second, per viewer.',
        settings: { min: 1, max: 200, integer: true },
      })
      .addSelect({
        path: 'sampling', name: 'Trace sampling', category: ['Data'], showIf: isLive, defaultValue: 10,
        description: 'Fetch only this share of the traces from Tempo, chosen by trace id (every viewer sees the same ones). '
          + 'Rates still come from the service graph.',
        settings: { options: SAMPLING.map((v) => ({ value: v, label: v === 100 ? 'all traces' : `${v}%` })) },
      })
      .addBooleanSwitch({
        path: 'interpolate', name: 'Interpolate sampled traces', category: ['Data'], showIf: isLive, defaultValue: true,
        description: 'Replay each fetched trace as often as it stands for (10× at 10%, 5× at 20%) at random times, '
          + 'so the traffic looks complete while Tempo serves only the sample. Off: show just the sample.',
      })
      .addTextInput({
        path: 'rename', name: 'Rename nodes', category: ['Data'], defaultValue: '',
        description: 'One per line: name or address = new name, e.g. 10.10.10.10 = prod-postgres. '
          + 'Applies to services, databases and database servers; nodes renamed to the same name merge. Lines starting with # are ignored.',
        settings: { useTextarea: true, rows: 4, placeholder: '10.10.10.10 = prod-postgres' },
      })
      .addBooleanSwitch({ path: 'showClock', name: 'Show playback clock', category: ['Display'], defaultValue: true })
      .addBooleanSwitch({ path: 'labels', name: 'Labels', category: ['Display'], defaultValue: true })
      .addBooleanSwitch({ path: 'bloom', name: 'Bloom', category: ['Display'], defaultValue: true })
      .addSliderInput({ path: 'speed', name: 'Ball speed', category: ['Display'], defaultValue: 1, settings: { min: 0.25, max: 4, step: 0.25 } })
      .addSliderInput({
        path: 'stretch', name: 'Latency stretch', category: ['Display'], defaultValue: 2,
        description: 'How many visual ms a span ms takes while a ball is held inside a service.',
        settings: { min: 0.5, max: 50, step: 0.5 },
      });
  });
