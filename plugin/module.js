// trace-pong Grafana panel. Hand-written AMD module (the format Grafana loads plugins in), so there
// is no build step: the renderer itself lives in native ES modules under js/ and is imported lazily.
define(['react', '@grafana/data', '@grafana/runtime', 'rxjs'], function (React, data, runtime, rxjs) {
  'use strict';
  var h = React.createElement;
  var ID = 'tracepong-live-panel';

  // ---- where our files are served from --------------------------------------------------
  function baseUrl() {
    var meta = (runtime.config.panels || {})[ID] || {};
    var b = meta.baseUrl || 'public/plugins/' + ID;
    if (/^https?:\/\//.test(b)) return b;
    return (runtime.config.appSubUrl || '') + '/' + b.replace(/^\//, '');
  }
  function version() {
    var meta = (runtime.config.panels || {})[ID] || {};
    return (meta.info && meta.info.version) || 'dev';
  }
  var appModule = null;
  function loadApp() {
    // native dynamic import: the renderer is plain ES modules + WGSL
    if (!appModule) appModule = import(/* webpackIgnore: true */ baseUrl() + '/js/app.js?v=' + version());
    return appModule;
  }

  // ---- data sources ------------------------------------------------------------------------
  function dsSrv() { return runtime.getDataSourceSrv(); }
  function settings(uid) {
    try { return uid ? dsSrv().getInstanceSettings(uid) : undefined; } catch (e) { return undefined; }
  }
  function firstOfType(type) {
    var list = dsSrv().getList({ type: type }) || [];
    return list.find(function (d) { return d.isDefault; }) || list[0];
  }
  // Panel options -> what the renderer needs (proxy URLs instead of data source UIDs).
  function resolve(o) {
    var tempo = settings(o.tempoUid) || firstOfType('tempo');
    var promUid = o.promUid || (tempo && tempo.jsonData && tempo.jsonData.serviceMap && tempo.jsonData.serviceMap.datasourceUid);
    var prom = settings(promUid) || (!o.promUid && firstOfType('prometheus')) || undefined;
    return {
      mode: o.mode || 'live',
      tempoUrl: tempo ? tempo.url : '',
      promUrl: prom ? prom.url : '',
      traceql: o.traceql || '',
      labelFilter: o.labelFilter || '',
      window: o.window || '1m',
      maxTraces: o.maxTraces || 30,
      showClock: o.showClock !== false,
      labels: o.labels !== false,
      bloom: o.bloom !== false,
      speed: o.speed || 1,
      stretch: o.stretch || 2,
    };
  }

  // Requests go through Grafana's data source proxy, which adds auth and tenant headers.
  function makeEnv(latest) {
    return {
      get: function (url, params) {
        return rxjs.lastValueFrom(runtime.getBackendSrv().fetch({
          url: url, params: params, method: 'GET', showErrorAlert: false, showSuccessAlert: false,
        })).then(function (r) { return r.data; });
      },
      // dashboard variables in filters, re-read on every poll
      replace: function (s) {
        var p = latest.current;
        return p.replaceVariables ? p.replaceVariables(s) : runtime.getTemplateSrv().replace(s);
      },
    };
  }

  // ---- the panel ---------------------------------------------------------------------------
  function TracePongPanel(props) {
    var box = React.useRef(null);
    var app = React.useRef(null);
    var latest = React.useRef(props);
    latest.current = props;
    var errState = React.useState(null);
    var opts = resolve(props.options);
    var key = JSON.stringify(opts);

    React.useEffect(function () {
      var dead = false;
      var inst = null;
      loadApp()
        .then(function (m) { return m.createTracePong(box.current, makeEnv(latest), resolve(latest.current.options)); })
        .then(function (a) {
          if (dead) { a.destroy(); return; }
          inst = a;
          app.current = a;
          a.setOptions(resolve(latest.current.options));
          if (box.current) box.current.__tracepong = a;
        })
        .catch(function (e) { if (!dead) errState[1](String((e && e.message) || e)); });
      return function () {
        dead = true;
        if (inst) inst.destroy();
        app.current = null;
      };
    }, []);

    React.useEffect(function () {
      if (app.current) app.current.setOptions(opts);
    }, [key]);

    return h('div', { ref: box, className: 'tracepong-panel', style: { position: 'relative', width: props.width, height: props.height } },
      errState[0] ? h('div', { style: { padding: 12, color: '#ff4d5e' } }, 'trace-pong failed to load: ' + errState[0]) : null);
  }

  // ---- options -------------------------------------------------------------------------------
  function dsPicker(type, placeholder) {
    return function (props) {
      if (!runtime.DataSourcePicker) {
        return h('input', { className: 'gf-form-input', value: props.value || '', placeholder: 'data source UID',
          onChange: function (e) { props.onChange(e.target.value || undefined); } });
      }
      return h(runtime.DataSourcePicker, {
        current: props.value || null,
        type: type,
        noDefault: true,
        placeholder: placeholder,
        isClearable: true,
        onClear: function () { props.onChange(undefined); },
        onChange: function (ds) { props.onChange(ds && ds.uid); },
      });
    };
  }
  var isLive = function (o) { return o.mode !== 'sim'; };

  var plugin = new data.PanelPlugin(TracePongPanel)
    .setNoPadding()
    .setPanelOptions(function (builder) {
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
          description: 'Mimir/Prometheus holding traces_service_graph_* series. Empty: the Tempo data source\'s service map data source.',
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
          settings: { options: ['30s', '1m', '2m', '5m', '15m'].map(function (v) { return { value: v, label: v }; }) },
        })
        .addNumberInput({
          path: 'maxTraces', name: 'Traces per second', category: ['Data'], showIf: isLive, defaultValue: 30,
          description: 'Upper bound of traces fetched from Tempo per second, per viewer.',
          settings: { min: 1, max: 200, integer: true },
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

  return { plugin: plugin };
});
