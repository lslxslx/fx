// Display formatting only; historical values and indicator calculations stay numeric.
const formatFxNumber = (value, grouped = true) => Number.isFinite(value)
  ? d3.format(grouped ? ',.2f' : '.2f')(value) : '—';

// GitHub Pages adaptation: JSON files in ./data/, no backend required.
// Info events are loaded from ./data/events.json. Each item contains date
// (YYYY-MM-DD), currency (EUR, USD, ... or '*'), title and description.
// An empty JSON array [] means no markers. No embedded or sample events.
/* Local replacement for q/cq. Does not intercept global fetch. */
window.ForexData = (() => {
  const codes = ['EUR','USD','GBP','CHF','XAU','XAG','JPY','AUD','CAD'];
  const cache = new Map();
  function statusNode() { return document.getElementById('data-status') || {}; }
  const iso = date => date.toISOString().slice(0,10);
  async function load(code) {
    if (!codes.includes(code)) throw new Error('Valutë e panjohur');
    if (!cache.has(code)) cache.set(code, fetch(`./data/${code.toLowerCase()}.json`).then(r => {
      if (!r.ok) throw new Error(`Nuk u lexua ${code}: ${r.status}`);
      return r.json();
    }).then(rows => rows.slice().sort((a,b)=>b.Data.localeCompare(a.Data))).catch(e=>{cache.delete(code);throw e;}));
    return cache.get(code);
  }
  function period(date, interval) {
    const d = new Date(date+'T00:00:00Z');
    if (interval==='wave') {
      // Match SQL DATEDIFF(WEEK): Sunday-start week, Friday label.
      d.setUTCDate(d.getUTCDate()-d.getUTCDay()+5);
    } else if (interval==='mave') {
      d.setUTCDate(1); d.setUTCDate(31);
    } else if (interval==='quave') {
      d.setUTCDate(1); d.setUTCMonth(Math.floor(d.getUTCMonth()/3)*3); d.setUTCDate(31);
    }
    return iso(d);
  }
  async function query(url) {
    const p=new URL(url,location.href).searchParams;
    const c=(p.get('c')||'EUR').toUpperCase();
    const rows=await load(c);
    const end=p.get('td')||iso(new Date());
    let start=p.get('fd');
    if(!start) {
      const months=Number(p.get('ix')||12);
      const d=new Date(end+'T00:00:00Z'); const day=d.getUTCDate();
      d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()-months);
      const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
      d.setUTCDate(Math.min(day,last)); start=months===0?'1991-01-01':iso(d);
    }
    let result=rows.filter(r=>r.Data>=start&&r.Data<=end&&Number.isFinite(r[c]));
    const interval=p.get('i');
    if(['wave','mave','quave'].includes(interval)) {
      const groups=new Map();
      for(const r of result) {const key=period(r.Data,interval); const g=groups.get(key)||{sum:0,n:0};g.sum+=r[c];g.n++;groups.set(key,g);}
      result=Array.from(groups,([Data,g])=>({Data,[c]:Math.round(g.sum/g.n*100)/100})).sort((a,b)=>b.Data.localeCompare(a.Data));
    }
    if(p.get('o')==='asc') result=result.slice().reverse();
    statusNode().textContent=`Version testimi — ${c}: ${result.length} regjistrime. Burimi lokal deri më ${rows[0]?.Data||'—'}.`;
    return result;
  }
  async function convert(input) {
    const m=input.trim().match(/^(\d+(?:[.,]\d+)?)\s+([A-Za-z]{3})\s+([A-Za-z]{3})$/);
    if(!m) return {R:'E',Error:'Formati: 100.5 EUR ALL'};
    const from=m[2].toUpperCase(),to=m[3].toUpperCase();
    if(![...codes,'ALL'].includes(from)||![...codes,'ALL'].includes(to)) return {R:'E',Error:'Valutë e pambështetur.'};
    const a=from==='ALL'?null:(await load(from))[0];
    const b=to==='ALL'?null:(await load(to))[0];
    if(a&&b&&a.Data!==b.Data) return {R:'E',Error:'Kurset më të fundit kanë data të ndryshme.'};
    const rate=(r,c)=>r?r[c]/(c==='JPY'?100:1):1;
    return {R:'X',Amount:Number(m[1].replace(',','.')),Sell:from,Buy:to,Exchange:rate(a,from)/rate(b,to),Source:`Bank of Albania — JSON ${a?.Data||b?.Data||''}`};
  }
  async function summary() {
    try {
      const latest = {};
      await Promise.all(codes.map(async c => {
        const rows=await load(c);
        if(!rows.length) return;
        latest[c]={current:rows[0],previous:rows[1]||rows[0],unit:c==='JPY'?100:1};
        const row=latest[c], value=row.current[c], before=row.previous[c], delta=value-before;
        const label=document.querySelector('label[for="'+c+'"]');
        if(!label) return;
        const items=label.querySelectorAll('i');
        if(items[0]) {items[0].textContent=formatFxNumber(value, false);items[0].className=delta>0?'grc':'rec';}
        if(items[1]) items[1].textContent=before?(100*delta/before).toFixed(2)+'%':'—';
        if(items[2]) items[2].textContent=delta.toFixed(2);
        label.title=row.current.Data+'; njësi: '+row.unit;
      }));
      if(document.getElementById('currency') && latest.EUR) document.getElementById('currency').dataset.abbr='Updated: '+latest.EUR.current.Data;
    } catch(e) {statusNode().textContent='Përmbledhja nuk u ngarkua: '+e.message;}
  }
  document.addEventListener('DOMContentLoaded',summary);
  return {query,convert,load,period};
})();


// (C) luislamani — class refactor, phase 1
class HistoricalPriceChart {
  constructor(container = document.querySelector('article')) {
    if (!container) throw new Error('Mungon elementi article i grafikut.');
    this.container = container;
    this.priceClipId = `price-clip-${HistoricalPriceChart.nextClipId = (HistoricalPriceChart.nextClipId || 0) + 1}`;
    this.svg = d3.select(container).selectAll('svg').data([null]).join('svg');
    this.currentData = [];
    this.calculationCache = null;
    this.config = {};
    this.oscillatorOrder = []; // RSI / ROC activation order; MACD keeps its fixed position.
    this.state = { loading: false, requestId: 0, currency: null, interval: null };
    this.listeners = [];
    this.zoomTransform = d3.zoomIdentity;
    this.pricePan = 0; // Translation as a fraction of the price panel height, never Y zoom.
    this.infoEvents = [];
    this.infoRequestId = 0;
    this.trendLines = [];
    this.levels = []; // Horizontal support / resistance levels, scoped to currency.
    this.nextTrendId = 0;
    this.trendDraft = null;
    this.selectedTrendId = null;
    this.trendEdit = null;
    this.destroyed = false;
    this.restoreState();
    this.bindControls();
    this.observeLayout();
    this.ready = this.reloadData();
    // Optional metadata must never block the price chart.
    this.eventsReady = this.reloadInfoEvents();
  }

  listen(element, event, handler) {
    if (!element) return;
    element.addEventListener(event, handler);
    this.listeners.push(() => element.removeEventListener(event, handler));
  }

  // Settings, trend lines and levels survive a reload. Custom dates are not
  // stored: a remembered end date would silently hide newer data.
  restoreState() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(HistoricalPriceChart.storageKey) || 'null'); } catch (error) { return; }
    if (!saved || typeof saved !== 'object') return;
    const node = id => document.getElementById(id);
    for (const id of HistoricalPriceChart.textControls) {
      if (node(id) && typeof saved.text?.[id] === 'string') node(id).value = saved.text[id];
    }
    for (const id of HistoricalPriceChart.checkControls) {
      if (node(id) && typeof saved.checked?.[id] === 'boolean') node(id).checked = saved.checked[id];
    }
    const currency = document.querySelector('input[name=currency][value="' + String(saved.currency).replace(/[^A-Z]/g, '') + '"]');
    if (currency) currency.checked = true;
    const interval = Array.from(document.querySelectorAll('input[name=interval]')).find(input => input.value === saved.interval);
    if (interval) interval.checked = true;
    const select = node('ix');
    if (select && Array.from(select.options).some(option => option.value === saved.ix)) select.value = saved.ix;
    if (Array.isArray(saved.order)) this.oscillatorOrder = saved.order.filter(key => ['roc', 'rsi', 'stoch'].includes(key));
    const point = value => value && Number.isFinite(value.date) && Number.isFinite(value.price);
    if (Array.isArray(saved.trendLines)) {
      this.trendLines = saved.trendLines
        .filter(trend => trend && typeof trend.currency === 'string' && typeof trend.interval === 'string' && point(trend.start) && point(trend.end))
        .map(trend => ({ id: ++this.nextTrendId, currency: trend.currency, interval: trend.interval,
          start: { date: trend.start.date, price: trend.start.price }, end: { date: trend.end.date, price: trend.end.price } }));
    }
    if (Array.isArray(saved.levels)) {
      this.levels = saved.levels.filter(level => level && typeof level.currency === 'string' && Number.isFinite(level.price))
        .map(level => ({ id: ++this.nextTrendId, currency: level.currency, price: level.price }));
    }
  }

  saveState() {
    if (this.destroyed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const node = id => document.getElementById(id);
      const state = {
        currency: document.querySelector('input[name=currency]:checked')?.value,
        interval: document.querySelector('input[name=interval]:checked')?.value,
        ix: node('ix')?.value, order: this.oscillatorOrder,
        text: Object.fromEntries(HistoricalPriceChart.textControls.filter(node).map(id => [id, node(id).value])),
        checked: Object.fromEntries(HistoricalPriceChart.checkControls.filter(node).map(id => [id, node(id).checked])),
        trendLines: this.trendLines.map(({ currency, interval, start, end }) => ({ currency, interval, start, end })),
        levels: this.levels.map(({ currency, price }) => ({ currency, price }))
      };
      // Storage can be disabled or full; the chart must keep working without it.
      try { localStorage.setItem(HistoricalPriceChart.storageKey, JSON.stringify(state)); } catch (error) { /* ignore */ }
    }, 250);
  }

  readIndicators() {
    const value = id => document.getElementById(id)?.value || '';
    const number = (id, fallback, min = 1) => {
      const n = Number(value(id));
      return Number.isFinite(n) && n >= min ? n : fallback;
    };
    const checked = id => Boolean(document.getElementById(id)?.checked);
    const config = {};
    for (const suffix of ['a','b','c','d']) {
      const match = value('ma_'+suffix).trim().match(/^([SED])([1-9]\d*)$/i);
      config['ma_'+suffix] = match ? Number(match[2]) : NaN;
      config['mma_'+suffix] = match ? match[1].toUpperCase() : null;
    }
    Object.assign(config, {
      N: Math.trunc(number('bb_N',20,2)), K: number('bb_K',2),
      eshort: Math.trunc(number('macd_fast',8)), elong: Math.trunc(number('macd_slow',17)),
      esignal: Math.trunc(number('macd_signal',9)), RC: Math.trunc(number('roc_values',12)),
      RS: Math.trunc(number('rsi_values',14)), ST: Math.trunc(number('stoch_values',14,2)),
      bband:checked('bband'), macd:checked('macd'),
      macdh:checked('macdh'), roc:checked('roc'), rsi:checked('rsi'),
      stoch:checked('stoch'), signals:checked('signals')
    });
    this.config = config;
    // Track selections, not data availability: a short history must not erase
    // the user's order. Turning an indicator off removes it; turning it back
    // on appends it after any oscillator that is still selected.
    this.oscillatorOrder = (this.oscillatorOrder || []).filter(key => config[key]);
    for (const key of ['roc', 'rsi', 'stoch']) {
      if (config[key] && !this.oscillatorOrder.includes(key)) this.oscillatorOrder.push(key);
    }
  }

  parameters() {
    return {
      c: document.querySelector('input[name=currency]:checked')?.value || 'EUR',
      fd: document.getElementById('start')?.value || '', td: document.getElementById('end')?.value || '',
      i: document.querySelector('input[name=interval]:checked')?.value || 'daily',
      ix: document.getElementById('ix')?.value || '12'
    };
  }

  setLoading(loading) {
    this.state.loading = loading;
    const button = document.getElementById('update');
    if (button) { button.disabled = loading; button.value = loading ? '\u2026' : '\u21BB'; }
  }

  async reloadData() {
    this.finishTrendEdit(false);
    const requestId = ++this.state.requestId;
    const params = this.parameters();
    this.saveState();
    this.setLoading(true);
    try {
      const rows = await window.ForexData.query('q?'+new URLSearchParams(params));
      if (this.destroyed || requestId !== this.state.requestId) return;
      this.currentData = this.parseData(rows, params.c);
      this.calculationCache = null;
      this.zoomTransform = d3.zoomIdentity;
      this.pricePan = 0;
      this.state.currency = params.c;
      this.state.interval = params.i;
      // Completed lines are scoped to currency and interval. Cancel only the
      // unfinished line when loading a different dataset.
      this.trendDraft = null;
      this.drawingTrend = false;
      this.refreshIndicators();
    } catch (error) {
      if (!this.destroyed && requestId === this.state.requestId) {
        console.error(error);
        this.showError('Nuk u ngarkuan të dhënat: '+error.message);
      }
    } finally {
      if (!this.destroyed && requestId === this.state.requestId) this.setLoading(false);
    }
  }

  refreshIndicators() {
    if (this.destroyed) return;
    this.readIndicators();
    this.saveState();
    this.render();
  }

  prepareChartData(values) {
    const cached = this.calculationCache;
    // Compare the snapshot too: callers may edit a row in place. A date, value,
    // order or length change must never reuse stale indicator calculations.
    if (cached && cached.source === values && cached.vdata.length === values.length &&
        values.every((row, i) => Object.is(+row.value, cached.vdata[i]) && Object.is(+row.date, cached.ddata[i]))) return cached;
    const vdata = Float64Array.from(values, row => row.value);
    const ddata = Float64Array.from(values, row => row.date);
    this.calculationCache = {
      source: values, vdata, ddata,
      min: d3.min(vdata), max: d3.max(vdata), series: new Map()
    };
    return this.calculationCache;
  }

  cachedIndicator(cache, parameters, calculate) {
    const key = JSON.stringify(parameters);
    if (cache.series.has(key)) {
      const result = cache.series.get(key);
      cache.series.delete(key); cache.series.set(key, result);
      return result;
    }
    const result = calculate();
    cache.series.set(key, result);
    // Bound memory when users try many different indicator periods.
    if (cache.series.size > 32) cache.series.delete(cache.series.keys().next().value);
    return result;
  }

  indicatorSeries(values) {
    const cache = this.prepareChartData(values), data = cache.vdata, c = this.config;
    const enabled = {
      bband: data.length >= 50 && c.bband, macd: data.length >= 50 && c.macd,
      macdh: data.length >= 50 && c.macdh, roc: data.length >= 20 && c.roc,
      rsi: data.length >= 20 && c.rsi, stoch: data.length >= 20 && c.stoch
    };
    // Rows arrive newest first, but every indicator formula is defined on
    // chronological data. Calculate oldest -> newest, then flip the result so
    // index 0 is again the latest value and index i lines up with ddata[i].
    const chrono = cache.chrono || (cache.chrono = Array.from(data).reverse());
    const newestFirst = result => Array.from(result).reverse();
    const memo = (parameters, calculate) => this.cachedIndicator(cache, parameters, calculate);
    const ma = suffix => !isNaN(c['ma_' + suffix])
      ? memo(['ma', c['mma_' + suffix], c['ma_' + suffix]], () => newestFirst(this.SwMA(c['mma_' + suffix], chrono, c['ma_' + suffix]))) : false;
    const bands = enabled.bband ? memo(['bb', c.N, c.K], () => {
      const result = newestFirst(this.bollingerband(chrono, c.N, c.K));
      return { data: result, lower: result.map(d => d.low), upper: result.map(d => d.high) };
    }) : null;
    // MACD line, signal and histogram share one calculation and parameter key.
    const macd = enabled.macd || enabled.macdh ? memo(['macd', c.eshort, c.elong, c.esignal], () => {
      const result = this.MACD(chrono)[0];
      return { line: [newestFirst(result.macdline)], signal: [newestFirst(result.macdsignal)], histogram: [newestFirst(result.macdhist)] };
    }) : null;
    const stoch = enabled.stoch ? memo(['stoch', c.ST], () => {
      const result = this.STOCH(chrono, c.ST);
      return { k: newestFirst(result.k), d: newestFirst(result.d) };
    }) : null;
    return {
      vdata: data, ddata: cache.ddata, min: cache.min, max: cache.max, enabled,
      BandData: bands ? bands.data : false, LowerBand: bands ? bands.lower : false, UpperBand: bands ? bands.upper : false,
      MA_a: ma('a'), MA_b: ma('b'), MA_c: ma('c'), MA_d: ma('d'),
      MacdLine: enabled.macd ? macd.line : false, MacdSignal: enabled.macd ? macd.signal : false,
      MacdHist: enabled.macdh ? macd.histogram : false,
      // Crossover markers need both MACD series even when only the histogram is drawn.
      MacdCross: macd ? { line: macd.line[0], signal: macd.signal[0] } : null,
      Roc: enabled.roc ? memo(['roc', c.RC], () => newestFirst(this.ROC(chrono, c.RC).map(d => d.roc))) : false,
      Rsi: enabled.rsi ? memo(['rsi', c.RS], () => newestFirst(this.RSI(chrono, c.RS).map(d => d.rsi))) : false,
      StochK: stoch ? stoch.k : false, StochD: stoch ? stoch.d : false
    };
  }

  // Indices (newest first) where series a crosses series b. up = a moves above b.
  crossings(a, b) {
    const result = [];
    if (!a || !b) return result;
    for (let i = 0, n = Math.min(a.length, b.length) - 1; i < n; i++) {
      const now = a[i] - b[i], before = a[i + 1] - b[i + 1];
      if (!Number.isFinite(now) || !Number.isFinite(before)) continue;
      if (now > 0 && before <= 0) result.push({ index: i, up: true });
      else if (now < 0 && before >= 0) result.push({ index: i, up: false });
    }
    return result;
  }

  render() {
    if (this.destroyed) return;
    this.finishTrendEdit(false, false);
    if (this.container.offsetWidth <= 0) { this.layoutPending = true; return; }
    this.layoutPending = false;
    this.pointerCleanup?.();
    this.infoDialog?.close();
    this.lastLayout = { width: this.container.offsetWidth, height: window.innerHeight };
    this.container.querySelector('[data-chart-error]')?.remove();
    this.svg.on('.trends', null);
    this.updateTrendLines = null;
    this.svg.selectAll('*').remove();
    if (!this.currentData.length) {
      this.zoomBehavior = null;
      this.svg.on('.zoom', null).on('dblclick.reset', null);
      this.showError('Nuk ka të dhëna për intervalin e zgjedhur.'); return;
    }
    this.drawChart(this.currentData, this.state.currency);
  }

  observeLayout() {
    const schedule = () => {
      if (this.destroyed) return;
      clearTimeout(this.layoutTimer);
      this.layoutTimer = setTimeout(() => {
        if (this.destroyed || this.container.offsetWidth <= 0) return;
        const previous = this.lastLayout;
        if (!this.layoutPending && previous && previous.width === this.container.offsetWidth && previous.height === window.innerHeight) return;
        this.render();
      }, 100);
    };
    // Observe width, not content height: adding panels must not create a resize loop.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(schedule);
      this.resizeObserver.observe(this.container);
    }
    this.listen(window, 'resize', schedule);
    this.listen(window, 'orientationchange', schedule);
  }

  resizeZoom(range) {
    const oldRange = this.plotGeometry?.x;
    const transform = this.zoomTransform;
    if (!oldRange || oldRange[0] === oldRange[1]) return transform;
    const ratio = (range[1] - range[0]) / (oldRange[1] - oldRange[0]);
    const tx = range[0] * (1 - transform.k) +
      (transform.x - oldRange[0] * (1 - transform.k)) * ratio;
    return d3.zoomIdentity.translate(tx, 0).scale(transform.k);
  }

  trendPoint(px, py, dates, x, y, bounds, clamp = false) {
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    if (!clamp && (px < bounds.left || px > bounds.right || py < bounds.top || py > bounds.bottom)) return null;
    px = Math.max(bounds.left, Math.min(bounds.right, px));
    py = Math.max(bounds.top, Math.min(bounds.bottom, py));
    const point = this.pointerSnapshot(px, dates, x.range(), [bounds.left, bounds.right], {});
    const price = y.invert(py);
    return point && Number.isFinite(price) ? { date: point.date, price } : null;
  }

  projectTrend(trend, x, y) {
    // Missing dates stay missing: never attach an endpoint to a different date.
    const points = [trend.start, trend.end].map(point => [x(point.date), y(point.price)]);
    return points.every(point => point.every(Number.isFinite)) ? points : null;
  }

  visibleTrendLines(currency, interval, x, y) {
    const lines = this.trendDraft ? [...this.trendLines, this.trendDraft] : this.trendLines;
    return lines.filter(trend => trend.currency === currency && trend.interval === interval && this.projectTrend(trend, x, y));
  }

  cancelTrendDraft() {
    this.trendDraft = null;
    this.drawingTrend = false;
    this.updateTrendLines?.();
  }

  finishTrendEdit(commit = true, redraw = true) {
    const edit = this.trendEdit;
    if (!edit) return;
    this.trendEdit = null;
    if (!commit) {
      const trend = this.trendLines.find(item => item.id === edit.trendId);
      if (trend) trend[edit.key] = { ...edit.original };
    }
    if (edit.node.hasPointerCapture?.(edit.pointerId)) edit.node.releasePointerCapture(edit.pointerId);
    if (redraw) this.updateTrendLines?.();
  }

  bindTrendHandles(handles, svg, dates, x, y, bounds) {
    const chart = this;
    const move = event => {
      const edit = chart.trendEdit;
      if (!edit || edit.pointerId !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const trend = chart.trendLines.find(item => item.id === edit.trendId);
      const [px, py] = d3.pointer(event, svg.node());
      const point = chart.trendPoint(px, py, dates, x, y, bounds, true);
      if (trend && point) { trend[edit.key] = point; chart.updateTrendLines(); }
    };
    handles.on('pointerdown.edit', function (event, handle) {
      event.stopPropagation();
      if (event.button !== 0 || chart.state.loading || chart.drawingTrend || chart.zooming || chart.trendEdit) return;
      event.preventDefault();
      chart.trendEdit = { trendId: handle.trend.id, key: handle.key,
        original: { ...handle.trend[handle.key] }, pointerId: event.pointerId, node: this };
      this.setPointerCapture(event.pointerId);
      this.focus?.({ preventScroll: true });
    }).on('pointermove.edit', move)
      .on('pointerup.edit', event => {
        if (chart.trendEdit?.pointerId !== event.pointerId) return;
        move(event); chart.finishTrendEdit(true);
      })
      .on('pointercancel.edit lostpointercapture.edit', event => {
        if (chart.trendEdit?.pointerId !== event.pointerId) return;
        event.stopPropagation(); chart.finishTrendEdit(false);
      })
      .on('mousedown.edit touchstart.edit click.edit dblclick.edit contextmenu.edit', event => {
        event.stopPropagation();
        if (event.type === 'contextmenu') event.preventDefault();
      })
      .on('keydown.edit', (event, handle) => {
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) || chart.trendEdit || chart.state.loading) return;
        event.preventDefault(); event.stopPropagation();
        const point = handle.trend[handle.key];
        let px = x(point.date), py = y(point.price);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          const index = Array.from(dates).indexOf(point.date);
          const direction = (event.key === 'ArrowRight' ? 1 : -1) * Math.sign(x.range()[1] - x.range()[0]);
          const next = Math.max(0, Math.min(dates.length - 1, index + direction));
          px = x(dates[next]);
        } else py += (event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 10 : 1);
        const nextPoint = chart.trendPoint(px, py, dates, x, y, bounds, true);
        if (nextPoint) { handle.trend[handle.key] = nextPoint; chart.updateTrendLines(); }
      });
  }

  bindTrendLines(svg, dates, x, y, bounds, currency, interval) {
    const chart = this;
    const line = d3.line();
    const redraw = () => {
      const lines = this.visibleTrendLines(currency, interval, x, y);
      // A wider transparent stroke makes selection practical on touch screens.
      svg.select('.trendlines').selectAll('path.trend-hit')
        .data(lines, trend => trend.id).join('path').attr('class', 'trend-hit')
        .attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 16)
        .attr('pointer-events', 'stroke').attr('d', trend => line(this.projectTrend(trend, x, y)));
      svg.select('.trendlines').selectAll('path.trend')
        .data(lines, trend => trend.id)
        .join('path').attr('class', 'trend').attr('fill', 'none')
        .attr('tabindex', 0).attr('role', 'button')
        .attr('aria-label', 'Përzgjidh vijën e trendit për të lëvizur skajet')
        .attr('stroke', trend => trend.id === chart.selectedTrendId ? '#38678f' : '#606060').attr('stroke-width', 2)
        .attr('stroke-linecap', 'round').attr('vector-effect', 'non-scaling-stroke')
        .attr('d', trend => line(this.projectTrend(trend, x, y)));
      svg.select('.trendlines').selectAll('path').style('cursor', 'pointer')
        .on('pointerdown.trends mousedown.trends touchstart.trends', event => {
          if (!chart.drawingTrend) event.stopPropagation();
        })
        .on('click.trends', (event, trend) => {
          if (chart.drawingTrend || chart.trendEdit || chart.state.loading) return;
          event.stopPropagation();
          if (event.altKey) {
            chart.trendLines = chart.trendLines.filter(item => item.id !== trend.id);
            if (chart.selectedTrendId === trend.id) chart.selectedTrendId = null;
          } else chart.selectedTrendId = trend.id;
          redraw();
        }).on('keydown.trends', (event, trend) => {
          if (!['Enter', ' '].includes(event.key) || chart.drawingTrend || chart.trendEdit || chart.state.loading) return;
          event.preventDefault(); event.stopPropagation();
          chart.selectedTrendId = trend.id; redraw();
        });
      const selected = chart.drawingTrend ? null : lines.find(trend => trend.id === chart.selectedTrendId);
      const data = selected ? ['start','end'].map(key => ({ trend: selected, key })) : [];
      const handles = svg.select('.trend-handles').selectAll('g.trend-handle')
        .data(data, handle => `${handle.trend.id}-${handle.key}`).join(enter => {
          const group = enter.append('g').attr('class', 'trend-handle');
          group.append('circle').attr('r', 16).attr('fill', 'transparent');
          group.append('circle').attr('r', 6).attr('fill', '#fff').attr('stroke', '#38678f').attr('stroke-width', 2);
          return group;
        }).attr('tabindex', 0).attr('role', 'button').style('cursor', 'move').style('touch-action', 'none')
        .attr('aria-label', handle => `${handle.key === 'start' ? 'Fillimi' : 'Fundi'} i vijës: ${new Date(handle.trend[handle.key].date).toISOString().slice(0, 10)}, ${handle.trend[handle.key].price.toFixed(2)}. Lëvize me shigjetat.`)
        .attr('transform', handle => `translate(${x(handle.trend[handle.key].date)},${y(handle.trend[handle.key].price)})`)
        .attr('display', handle => {
          const point = handle.trend[handle.key], px = x(point.date), py = y(point.price);
          return px >= bounds.left && px <= bounds.right && py >= bounds.top && py <= bounds.bottom ? null : 'none';
        });
      chart.bindTrendHandles(handles, svg, dates, x, y, bounds);
      // Horizontal levels: Shift+click adds one, Alt+click removes it.
      const levels = svg.select('.levels').selectAll('g.level')
        .data(chart.levels.filter(level => level.currency === currency), level => level.id).join(enter => {
          const group = enter.append('g').attr('class', 'level');
          group.append('line').attr('class', 'level-line');
          group.append('line').attr('class', 'level-hit').attr('stroke', 'transparent')
            .attr('stroke-width', 14).attr('pointer-events', 'stroke').style('cursor', 'pointer');
          group.append('text').attr('class', 'level-label').attr('text-anchor', 'end').attr('dy', -4);
          return group;
        }).attr('transform', level => `translate(0,${y(level.price)})`)
        .attr('display', level => y(level.price) >= bounds.top && y(level.price) <= bounds.bottom ? null : 'none');
      levels.selectAll('line').attr('x1', bounds.left).attr('x2', bounds.right);
      levels.select('.level-label').attr('x', bounds.right - 4).text(level => formatFxNumber(level.price));
      levels.select('.level-hit').on('click.levels', (event, level) => {
        if (!event.altKey || chart.state.loading) return;
        event.stopPropagation();
        chart.levels = chart.levels.filter(item => item.id !== level.id);
        redraw();
      }).select('title').remove();
      levels.select('.level-hit').append('title').text('Alt+click to remove');
      chart.saveState();
    };
    this.updateTrendLines = redraw;
    svg.on('contextmenu.trends', event => {
      if (chart.pointerType === 'touch') { event.preventDefault(); return; }
      if (chart.state.loading || chart.zooming || chart.trendEdit || event.target.closest?.('.info-marker, .trend-handle')) return;
      const [px, py] = d3.pointer(event, svg.node());
      const point = chart.trendPoint(px, py, dates, x, y, bounds);
      if (!point) return;
      event.preventDefault();
      chart.trendDraft = { id: ++chart.nextTrendId, currency, interval, start: point, end: { ...point } };
      chart.selectedTrendId = null;
      chart.drawingTrend = true;
      redraw();
    }).on('mousemove.trends', event => {
      if (!chart.trendDraft || chart.state.loading) return;
      const [px, py] = d3.pointer(event, svg.node());
      const point = chart.trendPoint(px, py, dates, x, y, bounds, true);
      if (point) { chart.trendDraft.end = point; redraw(); }
    }).on('click.trends', event => {
      if (chart.state.loading || chart.trendEdit || event.altKey) return;
      if (!chart.trendDraft) {
        if (event.shiftKey) {
          const [lx, ly] = d3.pointer(event, svg.node());
          const level = chart.trendPoint(lx, ly, dates, x, y, bounds);
          if (level) chart.levels.push({ id: ++chart.nextTrendId, currency, price: Math.round(level.price * 100) / 100 });
        }
        chart.selectedTrendId = null; redraw(); return;
      }
      const [px, py] = d3.pointer(event, svg.node());
      const point = chart.trendPoint(px, py, dates, x, y, bounds);
      if (!point) return;
      chart.trendDraft.end = point;
      chart.trendLines.push(chart.trendDraft);
      chart.selectedTrendId = chart.trendDraft.id;
      chart.trendDraft = null;
      chart.drawingTrend = false;
      redraw();
    });
    redraw();
  }

  normalizeInfoEvents(events) {
    if (!Array.isArray(events)) throw new TypeError('Ngjarjet duhet të jenë një listë.');
    return events.map((event, index) => {
      const date = event?.date;
      const timestamp = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? Date.parse(date + 'T00:00:00Z') : NaN;
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date)
        throw new TypeError(`Data e ngjarjes ${index + 1} duhet të jetë YYYY-MM-DD e vlefshme.`);
      const currency = String(event.currency || '*').toUpperCase();
      if (!['*','EUR','USD','GBP','CHF','XAU','XAG','JPY','AUD','CAD'].includes(currency))
        throw new TypeError(`Monedhë e pavlefshme te ngjarja ${index + 1}.`);
      if (typeof event.title !== 'string' || !event.title.trim())
        throw new TypeError(`Mungon titulli i ngjarjes ${index + 1}.`);
      if (event.description != null && typeof event.description !== 'string')
        throw new TypeError(`Përshkrimi i ngjarjes ${index + 1} duhet të jetë tekst.`);
      return { date, currency, title: event.title.trim(), description: event.description || '' };
    });
  }

  setInfoEvents(events) {
    const normalized = this.normalizeInfoEvents(events);
    if (this.destroyed) return;
    this.infoRequestId++;
    this.infoAbort?.abort();
    this.infoEvents = normalized;
    this.state.infoEventsError = null;
    this.render();
  }

  async reloadInfoEvents() {
    if (this.destroyed) return false;
    const requestId = ++this.infoRequestId;
    this.infoAbort?.abort();
    const controller = new AbortController();
    this.infoAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    let succeeded = false;
    try {
      const response = await fetch('./data/events.json', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`events.json: HTTP ${response.status}`);
      const events = this.normalizeInfoEvents(await response.json());
      if (this.destroyed || requestId !== this.infoRequestId) return false;
      this.infoEvents = events;
      this.state.infoEventsError = null;
      succeeded = true;
    } catch (error) {
      if (this.destroyed || requestId !== this.infoRequestId) return false;
      this.infoEvents = [];
      this.state.infoEventsError = error.name === 'AbortError'
        ? 'Ngarkimi i events.json tejkaloi kohën e pritjes.' : error.message;
      console.warn('Shënuesit I nuk u ngarkuan; grafiku vazhdon pa ngjarje.', this.state.infoEventsError);
    } finally {
      clearTimeout(timeout);
      if (requestId === this.infoRequestId) this.infoAbort = null;
    }
    // Data loading will render the latest events itself when it finishes.
    if (this.currentData.length && !this.state.loading) this.render();
    return succeeded;
  }

  infoEventGroups(dates, currency, interval) {
    const indices = new Map(Array.from(dates, (date, index) => [+date, index]));
    const groups = new Map();
    for (const event of this.infoEvents) {
      if (event.currency !== '*' && event.currency !== currency) continue;
      // Use the same period labels as the data adapter. Never silently move an
      // event on a missing trading day to a different day in the daily chart.
      const date = Date.parse(window.ForexData.period(event.date, interval) + 'T00:00:00Z');
      const index = indices.get(date);
      if (index === undefined) continue;
      if (!groups.has(index)) groups.set(index, { index, date, events: [] });
      groups.get(index).events.push(event);
    }
    return Array.from(groups.values());
  }

  showInfoEvents(group) {
    if (this.destroyed) return;
    if (!this.infoDialog) {
      const dialog = document.createElement('dialog');
      dialog.className = 'chart-info-dialog';
      dialog.setAttribute('aria-labelledby', this.priceClipId + '-info-title');
      dialog.style.cssText = 'max-width: min(440px, 90vw);max-height:80vh;overflow:auto;padding:20px;box-sizing:border-box';
      document.body.appendChild(dialog);
      this.infoDialog = dialog;
    }
    const dialog = this.infoDialog;
    dialog.replaceChildren();
    const heading = document.createElement('h3');
    heading.id = this.priceClipId + '-info-title';
    heading.textContent = 'Informacion';
    dialog.appendChild(heading);
    for (const event of group.events) {
      const section = document.createElement('section');
      const title = document.createElement('strong');
      title.textContent = event.date + ' · ' + event.title;
      const description = document.createElement('p');
      description.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
      description.textContent = event.description;
      section.append(title, description);
      dialog.appendChild(section);
    }
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Mbyll'; close.autofocus = true;
    close.addEventListener('click', () => dialog.close());
    dialog.appendChild(close);
    if (!dialog.open) dialog.showModal();
  }

  drawInfoMarkers(svg, dates, prices, currency, interval, x, y, bounds) {
    const groups = this.infoEventGroups(dates, currency, interval);
    const layer = svg.append('g').attr('class', 'info-markers');
    const markers = layer.selectAll('g').data(groups, group => group.date).join('g')
      .attr('class', 'info-marker').attr('role', 'button').attr('tabindex', 0)
      .attr('aria-haspopup', 'dialog').style('cursor', 'pointer')
      .attr('aria-label', group => group.events.map(event => event.date + ': ' + event.title).join('; '));
    markers.append('circle').attr('r', 16).attr('fill', 'transparent');
    markers.append('circle').attr('r', 10).attr('fill', '#fff').attr('stroke', '#38678f');
    markers.append('text').text('I').attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('fill', '#38678f').style('font-size', '12px').style('font-weight', 'bold');
    markers.append('title').text(group => group.events.map(event => event.date + ': ' + event.title).join('\n'));
    // Do not let marker activation start a trendline, pan or pointer capture.
    markers.on('pointerdown.info mousedown.info touchstart.info dblclick.info contextmenu.info', event => {
      event.stopPropagation();
      if (event.type === 'contextmenu') event.preventDefault();
    }).on('click.info', (event, group) => {
      event.stopPropagation(); this.showInfoEvents(group);
    }).on('keydown.info', (event, group) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation(); this.showInfoEvents(group);
    });
    return () => {
      markers.attr('display', group => {
        const px = x(group.date);
        return Number.isFinite(prices[group.index]) && px >= bounds.left && px <= bounds.right ? null : 'none';
      }).attr('transform', group => {
        const py = Math.max(bounds.top + 16, Math.min(bounds.bottom - 16, y(prices[group.index]) - 20));
        return `translate(${x(group.date)},${py})`;
      });
    };
  }

  pointerSnapshot(pixel, dates, range, bounds, series) {
    if (!dates.length || !Number.isFinite(pixel)) return null;
    const last = dates.length - 1;
    const step = last ? (range[1] - range[0]) / last : 0;
    let index = 0;
    if (step) {
      const edges = bounds.map(p => (p - range[0]) / step);
      const firstVisible = Math.max(0, Math.ceil(Math.min(...edges) - 1e-9));
      const lastVisible = Math.min(last, Math.floor(Math.max(...edges) + 1e-9));
      if (firstVisible > lastVisible) return null;
      index = Math.max(firstVisible, Math.min(lastVisible, Math.round((pixel - range[0]) / step)));
    }
    const values = {};
    for (const [name, data] of Object.entries(series)) {
      const value = data?.[index];
      values[name] = Number.isFinite(value) ? value : null;
    }
    return { index, date: dates[index], x: step ? range[0] + index * step : (range[0] + range[1]) / 2, values };
  }

  // Mouse / trackpad: the crosshair follows the pointer. Touch: one finger scrolls
  // the page, two fingers move and zoom the chart, and a long press (about 300 ms)
  // starts the crosshair. After the finger lifts the crosshair stays until the next touch.
  bindChartPointer(svg, paint, hide) {
    const chart = this, node = svg.node();
    const holdMs = 300, slop = 8;
    let touch = null;
    const touchLike = event => event.pointerType === 'touch';
    const release = id => { if (node.hasPointerCapture?.(id)) node.releasePointerCapture(id); };
    const stopTouch = () => {
      if (!touch) return;
      clearTimeout(touch.timer); release(touch.id); touch = null; chart.touchInspect = false;
    };
    const blocked = event => event.target?.closest?.('.info-marker, .trend, .trend-hit, .trend-handle');
    this.hideCrosshair = hide;
    svg.on('pointerenter.inspect pointermove.inspect pointerdown.inspect', event => {
      chart.pointerType = event.pointerType;
      if (blocked(event)) { hide(); return; }
      if (!touchLike(event)) {
        if (event.type === 'pointerdown' && event.button !== 0) { hide(); return; }
        if (chart.zooming || chart.drawingTrend || chart.trendEdit || event.buttons) { hide(); return; }
        paint(event);
        return;
      }
      if (event.type === 'pointerdown') {
        event.preventDefault(); // no compatibility mouse events
        hide();
        if (touch) { stopTouch(); return; } // a second finger belongs to the zoom gesture
        touch = { id: event.pointerId, x: event.clientX, y: event.clientY, inspecting: false, last: event };
        touch.timer = setTimeout(() => {
          const current = touch;
          if (!current || chart.zooming || chart.drawingTrend || chart.trendEdit) return;
          current.inspecting = true; chart.touchInspect = true;
          node.setPointerCapture?.(current.id);
          navigator.vibrate?.(8);
          paint(current.last);
        }, holdMs);
        return;
      }
      if (event.type === 'pointermove' && touch && touch.id === event.pointerId) {
        touch.last = event;
        if (touch.inspecting) { if (!chart.zooming) paint(event); return; }
        const dx = event.clientX - touch.x, dy = event.clientY - touch.y;
        if (Math.hypot(dx, dy) > slop) {
          clearTimeout(touch.timer); // moving: this is not a long press
        }
      }
    });
    svg.on('pointerup.inspect pointercancel.inspect lostpointercapture.inspect', event => {
      if (touchLike(event)) {
        if (touch && touch.id === event.pointerId) {
          if (event.type === 'pointercancel') { stopTouch(); hide(); } // the browser took over: page scroll
          else if (event.type === 'pointerup') stopTouch();            // a long-press crosshair stays visible
        }
        return;
      }
      if (event.type !== 'pointerup') hide();
    });
    svg.on('pointerleave.inspect', event => { if (!touchLike(event)) hide(); });
    this.pointerCleanup = () => {
      svg.on('.inspect', null);
      stopTouch();
      hide();
      this.hideCrosshair = null;
      this.pointerCleanup = null;
    };
  }

  showError(message) {
    let node = this.container.querySelector('[data-chart-error]');
    if (!node) { node=document.createElement('p'); node.dataset.chartError=''; node.setAttribute('role','status'); this.container.appendChild(node); }
    node.textContent=message;
  }

  bindControls() {
    const panel = document.getElementById('cpanel');
    const select = document.getElementById('ix');
    this.listen(panel, 'change', event => {
      const target=event.target;
      if (target.id==='start' && select) {
        select.disabled=Boolean(target.value); select.style.textDecoration=target.value?'line-through':'unset';
      }
      if (target.matches('input[name=currency], input[name=interval], input[type=date], #ix')) {
        if (target.name==='interval') this.switchintervalix(target.value,select);
        this.closemenu(); this.reloadData();
      } else if (target.matches('#overlays input, #indicators input')) this.refreshIndicators();
    });
    this.listen(panel, 'keydown', event => {
      if(event.key!=='Enter' || event.target.id==='q') return;
      event.preventDefault(); this.closemenu();
      if(event.target.matches('#overlays input, #indicators input')) this.refreshIndicators();
      else this.reloadData();
    });
    this.listen(document.getElementById('update'),'click',()=>{this.closemenu();this.reloadData();});
    this.listen(document, 'pointerdown', event => {
      if (!this.container.contains(event.target)) this.hideCrosshair?.();
    });
    this.listen(window, 'keydown', event => {
      if (event.key !== 'Escape') return;
      if (this.trendEdit) this.finishTrendEdit(false);
      else if (this.trendDraft) this.cancelTrendDraft();
      else { this.selectedTrendId = null; this.updateTrendLines?.(); }
    });
  }

  closemenu() {
    const label=document.querySelector('label[for=menu]'), menu=document.getElementById('menu');
    if(label&&menu&&window.getComputedStyle(label,'::after').content.includes(label.getAttribute('data-abbr'))) menu.checked=false;
  }

  async convertOrQuote() {
    const input=document.getElementById('q'), output=document.getElementById('cqr');
    if(!input||!output)return;
    try {
      const result=await window.ForexData.convert(input.value);
      output.textContent=result.R==='X'
        ? `${formatFxNumber(result.Amount)} ${result.Sell} = ${formatFxNumber(result.Amount*result.Exchange)} ${result.Buy}\n(${result.Source})`
        : result.Error || '';
    } catch(error) { output.textContent='Gabim: '+error.message; }
  }

  destroy() {
    this.finishTrendEdit(false, false);
    this.calculationCache = null;
    this.destroyed=true; this.state.requestId++;
    this.infoRequestId++;
    this.infoAbort?.abort();
    clearTimeout(this.layoutTimer);
    clearTimeout(this.saveTimer);
    this.resizeObserver?.disconnect();
    this.pointerCleanup?.();
    this.infoDialog?.close();
    this.infoDialog?.remove();
    this.listeners.forEach(remove=>remove()); this.listeners=[];
    this.svg.on('.zoom', null).on('dblclick.reset', null);
    this.svg.on('.trends', null).on('.guard', null);
    this.updateTrendLines = null;
    this.trendDraft = null;
    this.drawingTrend = false;
    this.svg.on('contextmenu',null).on('mousemove',null).on('click',null);
    this.setLoading(false);
  }

  // Legacy calculations and rendering follow, retained for parity testing.

switchintervalix(v, vix) {
    switch (v) {
        case 'quave':
            return vix.value = 0;
            break;
        case 'mave':
            return vix.value = 240;
            break;
        case 'wave':
            return vix.value = 60;
            break;
        case 'daily':
            return vix.value = 12;
            break;
        default:
            return vix.value;
    }
}

// switch moving averages 
SwMA(v, ldata, rdata) {
    switch (v.toUpperCase()) {
        case 'S':
            return this.SMA(ldata, rdata);
            break;
        case 'E':
            return this.EMA(ldata, rdata);
            break;
        case 'D':
            return this.DEMA(ldata, rdata);
            break;
        default:
            return null;
    }
}
// switch moving average symbol on legend
SwMALegend(v) {
    switch (v.toUpperCase()) {
        case 'S':
            return 'SMA';
            break;
        case 'E':
            return 'EMA';
            break;
        case 'D':
            return 'DEMA';
            break;
        default:
            return null;
    }
}


parseData(values, currency) {
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);

    let arr = [];
    for (let i in values) {
        arr.push({
            date: new Date(values[i].Data),
            value: +values[i][currency]
        });
    }
    return arr;
}

drawChart(values, currency) {
const parseData = this.parseData.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);
let {ma_a,ma_b,ma_c,ma_d,mma_a,mma_b,mma_c,mma_d,N,K,eshort,elong,esignal,RC,RS,ST,bband,macd,macdh,roc,rsi,stoch,signals}=this.config;
const svgvB=this.container, interval=this.state.interval, chart=this;
this.drawingTrend = Boolean(this.trendDraft);
const SwMA=this.SwMA.bind(this), SwMALegend=this.SwMALegend.bind(this);
    const series = this.indicatorSeries(values);
    const limdata = 50,
        macdhbinsl = 1500,
        macdhbinsm = 900,
        minwidth = 300, // screen
        maxlgwidth = 1050, // screen legend
        legendoffsetw = 23,
        legendoffseth = 1,
        // Keep the original margin for ordinary FX prices; allow large XAU labels
        // to show both decimal digits instead of clipping the final character.
        margin = { top: 30, right: Math.max(60,
            Math.max(formatFxNumber(series.min).length, formatFxNumber(series.max).length) * 6 + 14), bottom: 60 },
        width = svgvB.offsetWidth - margin.right,
        // Do not measure content height: it includes panels from the last render.
        height = Math.max(minwidth, window.innerHeight * 0.55) - margin.top,
        padding = 10,
        indicator = { top: height, height: 90 },
        ibottom = { bottom: indicator.top + indicator.height + padding };

    const { vdata, ddata, BandData, LowerBand, UpperBand, MA_a, MA_b, MA_c, MA_d,
        MacdLine, MacdSignal, MacdHist, MacdCross, Roc, Rsi, StochK, StochD } = series;
    ({ bband, macd, macdh, roc, rsi, stoch } = series.enabled);
    const xrx = (_d, i) => x(ddata[i]);
    // MACD stays first. Only ROC / RSI follow their selection order.
    const panels = [];
    let panelTop = indicator.top;
    const oscillatorPanels = (this.oscillatorOrder || ['roc', 'rsi'])
        .map(key => [key, { roc, rsi, stoch }[key]]);
    for (const [key, enabled] of [['macd', macd || macdh], ...oscillatorPanels]) {
        if (!enabled) continue;
        panels.push({ key, top: panelTop, bottom: panelTop + indicator.height + padding });
        panelTop += indicator.height + padding * 2;
    }
    const panelByKey = Object.fromEntries(panels.map(panel => [panel.key, panel]));
    const lowerBottom = panels.length ? panels[panels.length - 1].bottom : height - padding;
    const dateY = panels.length ? lowerBottom + padding : height;

    // Price-only bounds keep the scale stable when overlays are toggled.
    let MinYScale = series.min,
        MaxYScale = series.max,
        PricePadding = MaxYScale > MinYScale
            ? (MaxYScale - MinYScale) * 0.08
            : Math.max(Math.abs(MinYScale) * 0.01, 0.01),
        // scale MacdY
        MinSignal = macd == true ? d3.min(...MacdSignal) : false,
        MaxSignal = macd == true ? d3.max(...MacdSignal) : false,
        MinLine = macd == true ? d3.min(...MacdLine) : false,
        MaxLine = macd == true ? d3.max(...MacdLine) : false,
        MinHist = macdh == true ? (typeof d3.min(...MacdHist) !== 'undefined' ? d3.min(...MacdHist) : null) : false,
        MaxHist = macdh == true ? (typeof d3.max(...MacdHist) !== 'undefined' ? d3.max(...MacdHist) : null) : false,
        MinMacdY = MinLine < MinSignal ? (MinLine < MinHist ? MinLine : MinHist) : (MinSignal < MinHist ? MinSignal : MinHist),
        MaxMacdY = MaxLine > MaxSignal ? (MaxLine > MaxHist ? MaxLine : MaxHist) : (MaxSignal > MaxHist ? MaxSignal : MaxHist),
        // scale ROC
        MinRocY = roc == true ? (typeof d3.min(Roc) !== 'undefined' ? d3.min(Roc) : null) : false,
        MaxRocY = roc == true ? (typeof d3.max(Roc) !== 'undefined' ? d3.max(Roc) : null) : false;

    // x Axis format
    let datalength = ddata.length,
        format = { monthly: d3.timeFormat('%b %Y'), daily: d3.timeFormat('%d %b %Y') },
        tformat = datalength < limdata ? format.daily : format.monthly;

    // Price chart, bollinger and ema
    // Tick labels need more decimals once zoom narrows the price range.
    const priceDecimals = () => {
        const [low, high] = y.domain(), span = Math.abs(high - low);
        return span > 0 ? Math.min(4, Math.max(2, Math.ceil(-Math.log10(span / 8)))) : 2;
    };
    let yAxis = g => g
        .attr('transform', 'translate(' + width + ', 0)')
        .call(d3.axisRight(y)
            .tickFormat(d3.format(',.' + priceDecimals() + 'f'))
            .tickSizeOuter(0));

    let xAxis = g => g
        .attr('transform', 'translate(0,' + dateY + ')')
        .call(d3.axisBottom(x)
            .tickSizeOuter(0)
            .tickValues(visibleTicks())
            .tickFormat(date => (datalength / (chart.zoomTransform?.k || 1) < limdata ? format.daily : tformat)(date)));

    let x = d3.scalePoint()
        .domain(ddata)
        .range([width < minwidth ? width + margin.right - padding : width - padding, padding]);
    const baseRange = x.range().slice();
    this.zoomTransform = this.resizeZoom(baseRange);
    const plotLeft = Math.min(...baseRange), plotRight = Math.max(...baseRange);
    // Invert by observation index, not elapsed time (weekends remain gap-free).
    x.invert = pixel => {
        const range = x.range();
        const index = datalength < 2 ? 0 : Math.round((pixel - range[0]) / (range[1] - range[0]) * (datalength - 1));
        return ddata[Math.max(0, Math.min(datalength - 1, index))];
    };
    function visibleTicks() {
        const visible = Array.from(ddata).filter(date => x(date) >= plotLeft - 0.5 && x(date) <= plotRight + 0.5);
        const step = Math.max(1, Math.ceil(visible.length / Math.max(2, Math.floor((plotRight - plotLeft) / 140))));
        return visible.filter((_d, i) => i % step === 0);
    }

    let y = d3.scaleLinear()
        .domain([MinYScale - PricePadding, MaxYScale + PricePadding])
        .range([height - padding, margin.top]);
    const baseY = y.copy(), priceHeight = height - padding - margin.top;
    this.pricePan = Number.isFinite(this.pricePan) ? this.pricePan : 0;
    const applyPricePan = () => {
        // Same rescaleY mechanism as chart.js, with k fixed at 1: translate only.
        y.domain(d3.zoomIdentity.translate(0, chart.pricePan * priceHeight).rescaleY(baseY).domain());
    };
    applyPricePan();
    this.plotGeometry = { x: baseRange.slice(), y: y.range().slice() };
    this.panelGeometry = [{ key: 'price', top: margin.top, bottom: height - padding }, ...panels];

    // MACD
    let yMAxis = g => g
        .attr('transform', 'translate(' + width + ', 0)')
        .call(d3.axisRight(yMacd).ticks(3).tickSizeOuter(0));

    let yMacd = d3.scaleLinear()
        .domain([MinMacdY, MaxMacdY])
        .range([ibottom.bottom, indicator.top])
        .nice();

    // ROC
    let yRCAxis = g => g
        .attr('transform', 'translate(' + width + ', 0)')
        .call(d3.axisRight(yRoc).ticks(3).tickSizeOuter(0));

    // RSI
    let yRAxis = g => g
        .attr('transform', 'translate(' + width + ', 0)')
        .call(d3.axisRight(yRsi).ticks(3).tickSizeOuter(0));

    let yRoc = d3.scaleLinear()
        .domain([MinRocY, MaxRocY])
        .range([panelByKey.roc?.bottom ?? ibottom.bottom, panelByKey.roc?.top ?? indicator.top])
        .nice();

    let yRsi = d3.scaleLinear()
        .domain([0, 100])
        .range([panelByKey.rsi?.bottom ?? ibottom.bottom, panelByKey.rsi?.top ?? indicator.top])
        .nice();
    // Stochastic
    let yStoch = d3.scaleLinear()
        .domain([0, 100])
        .range([panelByKey.stoch?.bottom ?? ibottom.bottom, panelByKey.stoch?.top ?? indicator.top]);

    let ySTAxis = g => g
        .attr('transform', 'translate(' + width + ', 0)')
        .call(d3.axisRight(yStoch).tickValues([20, 50, 80]).tickSizeOuter(0));

    this.plotScales = { x, y, ...(macd || macdh ? { macd: yMacd } : {}),
        ...(roc ? { roc: yRoc } : {}), ...(rsi ? { rsi: yRsi } : {}), ...(stoch ? { stoch: yStoch } : {}) };

    let line = d3.line()
        .defined(Number.isFinite)
        .x(xrx)
        .y(y);

    const svg = this.svg
        .attr('preserveAspectRatio', 'xMinYMin meet')
        .attr('viewBox', '0 0 ' + (width + margin.right) + ' ' + (dateY + margin.top));

    svg.append('defs').append('clipPath')
        .attr('id', this.priceClipId)
        .attr('clipPathUnits', 'userSpaceOnUse')
        .append('rect')
        .attr('x', Math.min(...x.range()))
        .attr('y', margin.top)
        .attr('width', Math.abs(x.range()[1] - x.range()[0]))
        .attr('height', Math.max(0, height - padding - margin.top));

    svg.append('g')
        .attr('class', 'date-axis')
        .call(xAxis)
        .attr('text-anchor', 'start');

    svg.append('g')
        .attr('class', 'price-axis')
        .call(yAxis);

    // indicator colors
    let price = '#38678f',
        mca = MA_a != 0 ? '#e04b4b' : '',
        mcb = MA_b != 0 ? '#00b061' : '',
        mcc = MA_c != 0 ? '#ff7dcd' : '',
        mcd = MA_d != 0 ? '#a39354' : '',
        ubbc = UpperBand != 0 ? '#909090' : '',
        lbbc = LowerBand != 0 ? '#909090' : '',
        macdsc = MacdSignal != 0 ? '#ff8084' : '',
        macdlc = MacdLine != 0 ? '#0061cb' : '',
        macdhc = MacdHist != 0 ? '#907070' : '',
        macdhcp = MacdHist != 0 ? '#708070' : '',
        macdhistlegc = MacdHist != 0 ? '#808080' : '',
        rocc = Roc != 0 ? '#f28f3b' : '',
        rsic = Rsi != 0 ? '#505050' : '',
        stochkc = '#7a5fc0',
        stochdc = '#c9a227',
        signalup = '#00b061',
        signaldown = '#e04b4b';

    // Grid lines follow the axis ticks, so they are redrawn on zoom and pan.
    const gridLayer = svg.append('g').attr('class', 'price-grid').attr('pointer-events', 'none');
    const drawGrid = () => {
        gridLayer.selectAll('line.grid-h')
            .data(y.ticks().filter(tick => y(tick) >= margin.top && y(tick) <= height - padding))
            .join('line').attr('class', 'grid-h')
            .attr('x1', plotLeft).attr('x2', plotRight)
            .attr('y1', tick => Math.round(y(tick)) + 0.5).attr('y2', tick => Math.round(y(tick)) + 0.5);
        gridLayer.selectAll('line.grid-v').data(visibleTicks())
            .join('line').attr('class', 'grid-v')
            .attr('x1', date => Math.round(x(date)) + 0.5).attr('x2', date => Math.round(x(date)) + 0.5)
            .attr('y1', margin.top).attr('y2', lowerBottom);
    };

    // Latest price: dashed guide plus a tag on the price axis.
    const lastPrice = svg.append('g').attr('class', 'last-price').attr('pointer-events', 'none');
    lastPrice.append('line').attr('x1', plotLeft).attr('x2', plotRight)
        .attr('stroke', price).attr('stroke-width', 0.75).attr('stroke-dasharray', '2 3');
    const lastTag = lastPrice.append('g').attr('transform', 'translate(' + width + ',0)');
    lastTag.append('rect').attr('x', 1).attr('y', -9).attr('height', 18).attr('rx', 2)
        .attr('width', Math.max(0, margin.right - 2)).attr('fill', price);
    lastTag.append('text').attr('x', 9).attr('dy', '0.32em').attr('fill', '#fff').text(formatFxNumber(vdata[0]));
    const updateLastPrice = () => {
        const py = y(vdata[0]);
        lastPrice.attr('display', py >= margin.top && py <= height - padding ? null : 'none')
            .attr('transform', 'translate(0,' + py + ')');
    };

    // bollinger band area
    if (bband) {
        svg.append('g')
            .attr('class', 'abbc')
            .attr('clip-path', `url(#${this.priceClipId})`)
            .selectAll('path')
            .data([BandData])
            .join('path')
            .attr('d', d3.area()
                .x(xrx)
                .y0((_d, i) => y(BandData[i].high))
                .y1((_d, i) => y(BandData[i].low)));
    }

    svg.append('g')
        .attr('fill', 'none')
        .attr('class', 'dline')
        .attr('clip-path', `url(#${this.priceClipId})`)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round')
        .attr('stroke-width', 1)
        .selectAll('path')
        .data([vdata, MA_a, MA_b, MA_c, MA_d, LowerBand, UpperBand])
        .join('path')
        .attr('stroke', (_d, i) => [price, mca, mcb, mcc, mcd, ubbc, lbbc][i])
        .attr('d', line);

    // horizontal line function
    const hrLines = [];
    function hr(y, yscale, color, swd) {
        let dateRange = [d3.max(ddata), d3.min(ddata)];
        const xs = dateRange.map(date => x(date)); // full plot width, independent of zoom
        const path = svg.append('g')
            .attr('stroke-width', 0.3)
            .selectAll('path')
            .data([[y, y]])
            .join('path')
            .attr('stroke', color)
            .attr('stroke-width', swd);
        const place = () => path.attr('d', d3.line().x((_d, i) => xs[i]).y(() => yscale(y)));
        place();
        hrLines.push(place);
    }

    // price chart legend
    const lglatest = function (_d, i) {
        let formatdate = d3.timeFormat('%a, %d %b %Y'),
            fd = formatFxNumber,
            txt_datenprice = formatdate(ddata[0]) + ', ' + currency + '/ALL: ' + fd(vdata[0]) + ' ' + (interval == 'wave' ? '(W)' : (interval == 'mave' ? '(M)' : (interval == 'quave' ? '(Q)' : '(D)'))),
            txt_ma_a = !isNaN(MA_a[0]) ? SwMALegend(mma_a) + ma_a + ': ' + fd(roundn(MA_a[0])) : '',
            txt_ma_b = !isNaN(MA_b[0]) ? SwMALegend(mma_b) + ma_b + ': ' + fd(roundn(MA_b[0])) : '',
            txt_ma_c = !isNaN(MA_c[0]) ? SwMALegend(mma_c) + ma_c + ': ' + fd(roundn(MA_c[0])) : '',
            txt_ma_d = !isNaN(MA_d[0]) ? SwMALegend(mma_d) + ma_d + ': ' + fd(roundn(MA_d[0])) : '',
            txt_upbb = !isNaN(UpperBand[0]) ? 'Upper Band: ' + fd(UpperBand[0]) : '',
            txt_lobb = !isNaN(LowerBand[0]) ? 'Lower Band: ' + fd(LowerBand[0]) : '';
        return [txt_datenprice, txt_ma_a, txt_ma_b, txt_ma_c, txt_ma_d, txt_upbb, txt_lobb].filter(x => x !== '')[i];
    }

    // macdh chart legend
    const macdlglatest = function (_d, i) {
        let fd = d3.format(','),
            line = macd ? MacdLine[0][0] : 0,
            signal = macd ? MacdSignal[0][0] : 0,
            histogram = macdh ? MacdHist[0][0] : 0,
            txt_macdl = macd ? 'MACD Line: ' + fd(roundn(line)) : 0,
            txt_macds = macd ? 'MACD Signal: ' + fd(roundn(signal)) : 0,
            txt_macdh = macdh ? 'MACD Histogram: ' + fd(roundn(histogram)) : 0;
        return [txt_macdl, txt_macds, txt_macdh].filter(x => x != 0)[i];
    }

    // Keep the original legend text, now attached to each indicator's own panel.
    const rrlatest = (name, data) => name + ': ' +
        (Number.isFinite(data[0]) ? d3.format(',')(roundn(data[0])) : '—');

    // legend global f
    let offset = 0,
        nodeWidth = (d) => d.getBBox().width,
        nodeHeight = (d) => d.getBBox().height;
    const offsetf = function () {
        let x = offset;
        if (svgvB.offsetWidth > maxlgwidth) {
            offset += nodeWidth(this) + legendoffsetw;
            return 'translate(' + x + ', 0)';
        }
        else {
            offset += nodeHeight(this) + legendoffseth;
            return 'translate(0, ' + x + ')';
        }
    }

    // price chart legend
    const legend = svg.append('g')
        .attr('class', 'legend')
        .attr('transform', 'translate(' + padding + ',' + margin.top + ')');

    const lg = legend.selectAll('g')
        .data([vdata, MA_a, MA_b, MA_c, MA_d, UpperBand, LowerBand].filter(x => x != 0 || !isNaN(x)))
        .join('g')
        .append('text')
        .style('fill', (_d, i) => [price, mca, mcb, mcc, mcd, ubbc, lbbc].filter(x => x !== '')[i]);

    offset = 0; // legend text offset
    lg.text(lglatest)
        .attr('transform', offsetf);

    let macdlg,
        roclg, rsilg;

    // MACD
    if (macd || macdh) {
        svg.append('g')
            .attr('class', 'macd-axis')
            .call(yMAxis);

        if (macdh) {
            svg.append('g')
                .attr('class', 'zoom-histogram')
                .selectAll('rect')
                .data(...MacdHist)
                .join('rect')
                .attr('class', 'macdhc')
                .attr('x', xrx)
                .attr('y', d => d > 0 ? yMacd(d) : yMacd(0))
                .attr('height', d => Math.abs(yMacd(d) - yMacd(0)))
                .attr('width', (datalength > macdhbinsl ? 0.5 : (datalength > macdhbinsm ? 1 : 1.5)))
                .attr('transform', 'translate(' + (datalength > macdhbinsl ? -1 : (datalength > macdhbinsm ? -1.5 : -2)) + ', 0)')
                .attr('fill', d => { return d > 0 ? macdhcp : macdhc });
        }

        if (macd) {
            svg.append('g')
                .attr('class', 'zoom-macd')
                .attr('fill', 'none')
                .attr('stroke-linejoin', 'round')
                .attr('stroke-linecap', 'round')
                .attr('stroke-width', 1)
                .selectAll('path')
                .data([...MacdLine, ...MacdSignal])
                .join('path')
                .attr('stroke', (_d, i) => {
                    return [macdlc, macdsc][i];
                })
                .attr('d', d3.line()
                    .defined(Number.isFinite)
                    .x(xrx)
                    .y(yMacd));
        }

        hr(0, yMacd, '#808080', 0.3);

        // macd legend
        const macdlegend = svg.append('g')
            .attr('class', 'macdlegend')
            .attr('transform', 'translate(' + padding + ',' + indicator.top + ')');

        macdlg = macdlegend.selectAll('g')
            .data([MacdLine, MacdSignal, MacdHist])
            .join('g')
            .append('text')
            .style('fill', (_d, i) => [macdlc, macdsc, macdhistlegc].filter(x => x !== '')[i]);

        offset = 0; // macd legend text offset
        macdlg.text(macdlglatest)
            .attr('transform', offsetf);
    }

    // ROC
    if (roc) {
        svg.append('g')
            .attr('class', 'roc-axis')
            .call(yRCAxis);

        svg.append('g')
            .attr('class', 'zoom-roc')
            .attr('fill', 'none')
            .attr('stroke-linejoin', 'round')
            .attr('stroke-linecap', 'round')
            .attr('stroke-width', 1)
            .selectAll('path')
            .data([Roc])
            .join('path')
            .attr('stroke', (_d, i) => {
                return [rocc][i];
            })
            .attr('d', d3.line()
                .defined(Number.isFinite)
                .x(xrx)
                .y(yRoc));

        hr(0, yRoc, '#f28f3b', 0.3);
    }

    // RSI
    if (rsi) {
        svg.append('g')
            .attr('class', 'rsi-axis')
            .call(yRAxis);

        svg.append('g')
            .attr('class', 'zoom-rsi')
            .attr('fill', 'none')
            .attr('stroke-linejoin', 'round')
            .attr('stroke-linecap', 'round')
            .attr('stroke-width', 1)
            .selectAll('path')
            .data([Rsi])
            .join('path')
            .attr('stroke', (_d, i) => {
                return [rsic][i];
            })
            .attr('d', d3.line()
                .defined(Number.isFinite)
                .x(xrx)
                .y(yRsi));

        hr(30, yRsi, '#808080', 0.3);
        hr(70, yRsi, '#808080', 0.3);
    }

    // Stochastic (closing prices only: the source has no high / low).
    if (stoch) {
        svg.append('g')
            .attr('class', 'stoch-axis')
            .call(ySTAxis);

        svg.append('g')
            .attr('class', 'zoom-stoch')
            .attr('fill', 'none')
            .attr('stroke-linejoin', 'round')
            .attr('stroke-linecap', 'round')
            .attr('stroke-width', 1)
            .selectAll('path')
            .data([StochK, StochD])
            .join('path')
            .attr('stroke', (_d, i) => [stochkc, stochdc][i])
            .attr('d', d3.line()
                .defined(Number.isFinite)
                .x(xrx)
                .y(yStoch));

        hr(20, yStoch, '#808080', 0.3);
        hr(80, yStoch, '#808080', 0.3);
    }

    const oscFormat = value => Number.isFinite(value) ? d3.format(',')(roundn(value)) : '—';
    const oscText = {
        roc: i => 'ROC: ' + oscFormat(Roc[i]),
        rsi: i => 'RSI: ' + oscFormat(Rsi[i]),
        stoch: i => 'Stoch' + ST + ' %K: ' + oscFormat(StochK[i]) + ', %D: ' + oscFormat(StochD[i])
    };
    const oscLegends = {};
    for (const [key, enabled, data, color] of [['roc', roc, Roc, rocc], ['rsi', rsi, Rsi, rsic], ['stoch', stoch, StochK, stochkc]]) {
        if (!enabled) continue;
        const text = svg.append('g')
            .attr('class', 'rsrclegend ' + key + 'legend')
            .attr('transform', 'translate(' + padding + ',' + panelByKey[key].top + ')')
            .append('g').append('text').style('fill', color);
        offset = 0;
        text.text(() => oscText[key](0)).attr('transform', offsetf);
        oscLegends[key] = text;
    }

    // crosshair
    let crssh = svg.append('g').attr('class', 'chart-crosshair').attr('pointer-events', 'none'),
        label = crssh.append('text'),
        crosshair = crssh.append('g')
            .attr('stroke-width', 0.5);

    // Touch: the value goes on the price axis and the date on the date axis,
    // so nothing is drawn next to (or under) the finger.
    const axisTag = (width, anchor) => {
        const tag = crssh.append('g').style('display', 'none');
        tag.append('rect').attr('height', 18).attr('rx', 2).attr('y', anchor).attr('fill', '#5b6270');
        tag.append('text').attr('dy', '0.32em').attr('y', anchor + 9).attr('fill', '#fff');
        return tag;
    };
    const axisY = axisTag(0, -9), axisX = axisTag(0, 3);
    axisY.select('rect').attr('x', 1).attr('width', Math.max(0, margin.right - 2));
    axisY.select('text').attr('x', 9);
    axisX.select('rect').attr('x', -40).attr('width', 80);
    axisX.select('text').attr('text-anchor', 'middle');
    const axisDate = d3.timeFormat(interval === 'mave' || interval === 'quave' ? '%b %Y' : '%d %b %Y');

    // horizontal line
    crosshair.append('line')
        .attr('id', 'crsx')
        .attr('stroke', '#cdcdcd');

    // vertical line
    crosshair.append('line')
        .attr('id', 'crsy')
        .attr('stroke', '#cdcdcd');

    // grid
    svg.append('rect')
        .attr('class', 'grid')
        .attr('fill', 'none')
        .attr('pointer-events', 'all')
        .attr('x', padding)
        .attr('y', margin.top)
        .attr('width', x.range()[0] - padding)
        .attr('height', y.range()[0] - margin.top);

    // macd grid
    if (macd || macdh) {
        svg.append('rect')
            .attr('class', 'macdgrid')
            .attr('fill', 'none')
            .attr('pointer-events', 'all')
            .attr('x', padding)
            .attr('y', indicator.top)
            .attr('width', x.range()[0] - padding)
            .attr('height', yMacd.range()[0] - indicator.top);
    }

    // Separate ROC and RSI hit areas; all panels share the same date pointer.
    for (const key of ['roc', 'rsi', 'stoch']) {
        const panel = panelByKey[key];
        if (!panel) continue;
        svg.append('rect')
            .attr('class', 'rsrcgrid ' + key + 'grid')
            .attr('fill', 'none')
            .attr('pointer-events', 'all')
            .attr('x', padding)
            .attr('y', panel.top)
            .attr('width', x.range()[0] - padding)
            .attr('height', panel.bottom - panel.top);
    }

    function hidePointer() {
            chart.state.pointerIndex = null;
            crosshair.style('display', 'none');
            label.style('display', 'none');
            axisY.style('display', 'none');
            axisX.style('display', 'none');
            lg.text(lglatest);
            if (macd || macdh) {
                macdlg.text(macdlglatest);
            }
            for (const key in oscLegends) oscLegends[key].text(oscText[key](0));
    }
    const pointerSeries = {
        vdata, MA_a, MA_b, MA_c, MA_d, UpperBand, LowerBand,
        MacdLine: macd ? MacdLine[0] : null,
        MacdSignal: macd ? MacdSignal[0] : null,
        MacdHist: macdh ? MacdHist[0] : null, Roc, Rsi
    };
    function paintPointer(event) {
            const [rawX, yval] = d3.pointer(event, svg.node());
            const panel = chart.panelGeometry.find(item => yval >= item.top && yval <= item.bottom)?.key;
            if (!panel || rawX < plotLeft || rawX > plotRight) { hidePointer(); return; }
            const snapshot = chart.pointerSnapshot(rawX, ddata, x.range(), [plotLeft, plotRight], pointerSeries);
            if (!snapshot) { hidePointer(); return; }
            chart.state.pointerIndex = snapshot.index;
            const xval = snapshot.x, yVonx = snapshot.values;
            crosshair.style('display', null);

            const touchPointer = event.pointerType === 'touch';
            const sx = xval < width / 2 ? 1 : -1;
            const sy = yval < height / 2 ? 2 : -1;
            const pointerFormat = value => Number.isFinite(value) ? d3.format(',')(roundn(value)) : '—';

            function maintxt(_d, i) {
                let formatdate = d3.timeFormat('%a, %d %b %Y'),
                    fd = formatFxNumber,
                    txt_datenprice = formatdate(snapshot.date) + ', ' + currency + '/ALL: ' + fd(yVonx.vdata) + ' ' + (interval == 'wave' ? '(W)' : (interval == 'mave' ? '(M)' : (interval == 'quave' ? '(Q)' : '(D)'))),
                    txt_ma_a = !isNaN(MA_a[0]) ? SwMALegend(mma_a) + ma_a + ': ' + fd(yVonx.MA_a) : '',
                    txt_ma_b = !isNaN(MA_b[0]) ? SwMALegend(mma_b) + ma_b + ': ' + fd(yVonx.MA_b) : '',
                    txt_ma_c = !isNaN(MA_c[0]) ? SwMALegend(mma_c) + ma_c + ': ' + fd(yVonx.MA_c) : '',
                    txt_ma_d = !isNaN(MA_d[0]) ? SwMALegend(mma_d) + ma_d + ': ' + fd(yVonx.MA_d) : '',
                    txt_upbb = !isNaN(UpperBand[0]) ? 'Upper Band: ' + fd(yVonx.UpperBand) : '',
                    txt_lobb = !isNaN(LowerBand[0]) ? 'Lower Band: ' + fd(yVonx.LowerBand) : '';
                return [txt_datenprice, txt_ma_a, txt_ma_b, txt_ma_c, txt_ma_d, txt_upbb, txt_lobb].filter(x => x !== '')[i];
            }

            function macdtxt(_d, i) {
                let fd = pointerFormat,
                    line = macd ? yVonx.MacdLine : 0,
                    signal = macd ? yVonx.MacdSignal : 0,
                    histogram = macdh ? yVonx.MacdHist : 0,
                    txt_macdl = macd ? 'MACD Line: ' + fd(line) : 0,
                    txt_macds = macd ? 'MACD Signal: ' + fd(signal) : 0,
                    txt_macdh = macdh ? 'MACD Histogram: ' + fd(histogram) : 0;
                return [txt_macdl, txt_macds, txt_macdh].filter(x => x != 0)[i];
            }

            function linelabel() {
                let fd = d3.format(',');
                switch (panel) {
                    case 'roc': return roundx(yRoc.invert(yval));
                    case 'rsi': return roundx(yRsi.invert(yval));
                    case 'stoch': return roundx(Math.max(0, Math.min(100, yStoch.invert(yval))));
                    case 'macd':
                        return fd(roundx(yMacd.invert(yval)));
                        break;
                    default:
                        return d3.format(',.2f')(y.invert(yval));
                }
            }

            // vertical line
            crosshair.select('#crsx')
                .attr('x1', xval)
                .attr('y1', margin.top)
                .attr('x2', xval)
                .attr('y2', lowerBottom);

            // horizontal line
            crosshair.select('#crsy')
                .attr('x1', plotLeft)
                .attr('y1', yval)
                .attr('x2', plotRight)
                .attr('y2', yval);

            label.text(linelabel)
                .attr('fill', '#9f9f9f')
                .attr('x', xval)
                .attr('y', yval)
                .attr('dx', sx * 8)
                .attr('dy', sy * 6)
                .style('font-size', '1.1rem')
                .style('text-anchor', sx > 0 ? 'start' : 'end')
                .style('display', touchPointer ? 'none' : null);

            axisY.style('display', touchPointer ? null : 'none')
                .attr('transform', 'translate(' + width + ',' + yval + ')')
                .select('text').text(linelabel());
            axisX.style('display', touchPointer ? null : 'none')
                .attr('transform', 'translate(' + Math.max(39, Math.min(width + margin.right - 39, xval)) + ',' + dateY + ')')
                .select('text').text(axisDate(snapshot.date));

            lg.text(maintxt);

            if (macd || macdh) {
                macdlg.text(macdtxt);
            }

            for (const key in oscLegends) oscLegends[key].text(oscText[key](snapshot.index));
    }
    hidePointer();
    this.bindChartPointer(svg, paintPointer, hidePointer);

    // draw trendlines
    svg.append('g').attr('class', 'trend-viewport')
        .attr('clip-path', `url(#${this.priceClipId})`).append('g')
        .attr('class', 'trendlines');
    svg.select('.trend-viewport').insert('g', '.trendlines').attr('class', 'levels');
    svg.select('.trend-viewport').append('g').attr('class', 'trend-handles');
    this.bindTrendLines(svg, ddata, x, y,
        { left: plotLeft, right: plotRight, top: margin.top, bottom: height - padding }, currency, interval);
    const updateInfoMarkers = this.drawInfoMarkers(svg, ddata, vdata, currency, interval, x, y,
        { left: plotLeft, right: plotRight, top: margin.top, bottom: height - padding });

    // Crossover signals. With two or more moving averages the first two are
    // compared (shorter period = fast line); with one, price against it.
    let updateSignals = () => {};
    if (signals) {
        const averages = [[MA_a, ma_a], [MA_b, ma_b], [MA_c, ma_c], [MA_d, ma_d]]
            .filter(([data]) => data && data.length > 1).slice(0, 2).sort((p, q) => p[1] - q[1]);
        const fast = averages.length === 2 ? averages[0][0] : (averages.length === 1 ? vdata : null);
        const slow = averages.length ? averages[averages.length - 1][0] : null;
        const marks = [
            ...chart.crossings(fast, slow).map(mark => ({ ...mark, value: fast[mark.index], scale: y, panel: 'price' })),
            // A MACD / signal crossover is where the histogram crosses zero. With the
            // lines hidden the marker sits on that zero line instead of on a line that is not drawn.
            ...((macd || macdh) && MacdCross ? chart.crossings(MacdCross.line, MacdCross.signal)
                .map(mark => ({ ...mark, value: macd ? MacdCross.line[mark.index] : 0, scale: yMacd, panel: 'macd' })) : [])
        ];
        const triangle = d3.symbol().type(d3.symbolTriangle).size(34)();
        const layer = svg.append('g').attr('class', 'signals').attr('pointer-events', 'none');
        const nodes = layer.selectAll('path').data(marks).join('path').attr('d', triangle)
            .attr('fill', mark => mark.up ? signalup : signaldown)
            .attr('clip-path', mark => 'url(#' + chart.priceClipId + (mark.panel === 'price' ? '' : '-' + mark.panel) + '-marks)');
        // Clip the unrotated wrapper, not the rotated symbol.
        nodes.each(function () {
            const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            wrapper.setAttribute('clip-path', this.getAttribute('clip-path'));
            this.removeAttribute('clip-path');
            this.parentNode.insertBefore(wrapper, this); wrapper.appendChild(this);
        });
        // Markers in a crowded panel hide on their own; zooming in brings them back.
        updateSignals = () => {
            const limit = Math.max(10, Math.floor((plotRight - plotLeft) / 14));
            const visible = { price: 0, macd: 0 };
            for (const mark of marks) {
                mark.px = x(ddata[mark.index]);
                if (mark.px >= plotLeft && mark.px <= plotRight) visible[mark.panel]++;
            }
            const crowded = panel => visible[panel] > limit;
            nodes.attr('display', mark => crowded(mark.panel) ? 'none' : null)
                .attr('transform', mark => 'translate(' + mark.px + ',' + (mark.scale(mark.value) + (mark.up ? 9 : -9)) + ')' + (mark.up ? '' : ' rotate(180)'));
        };
    }
    const markClip = (suffix, top, bottom) => svg.select('defs').append('clipPath').attr('id', chart.priceClipId + suffix + '-marks')
        .append('rect').attr('x', plotLeft).attr('y', top).attr('width', plotRight - plotLeft).attr('height', Math.max(0, bottom - top));
    markClip('', margin.top, height - padding);
    if (panelByKey.macd) markClip('-macd', panelByKey.macd.top, panelByKey.macd.bottom);

    // Update only geometry during gestures; indicator values remain calculated
    // from the complete history, so zoom does not restart their warm-up periods.
    for (const panel of panels) {
        const clipId = this.priceClipId + '-' + panel.key;
        svg.select('defs').append('clipPath').attr('id', clipId)
            // 2px of room on each side: a line resting exactly on a limit (closing-price
            // Stochastic often sits on 0 or 100) is not cut in half by the clip.
            .append('rect').attr('x', plotLeft).attr('y', panel.top - 2)
            .attr('width', plotRight - plotLeft).attr('height', panel.bottom - panel.top + 4);
        svg.selectAll(panel.key === 'macd' ? '.zoom-macd, .zoom-histogram' : '.zoom-' + panel.key)
            .attr('clip-path', `url(#${clipId})`);
    }
    const extent = [[plotLeft, margin.top], [plotRight, height - padding]];
    const maxZoom = Math.max(1, Math.min(100, (datalength - 1) / 9));
    const constrain = transform => {
        const k = Math.max(1, Math.min(maxZoom, transform.k));
        const tx = Math.max(plotRight * (1 - k), Math.min(plotLeft * (1 - k), transform.x));
        return d3.zoomIdentity.translate(tx, Number.isFinite(transform.y) ? transform.y : 0).scale(k);
    };
    // Limit the translation to useful space, including any clipped enabled overlays.
    let minPan = -0.25, maxPan = 0.25;
    // Y scales follow the visible part of the data, so zooming in on a quiet
    // stretch is not drawn as a flat line on a scale made for the whole history.
    const visibleIndices = () => {
        const range = x.range(), last = datalength - 1;
        if (last < 1) return [0, Math.max(0, last)];
        const step = (range[1] - range[0]) / last;
        const a = (plotLeft - range[0]) / step, b = (plotRight - range[0]) / step;
        // One extra point on each side lets lines run to the plot edge.
        const low = Math.max(0, Math.ceil(Math.min(a, b) - 1e-9) - 1);
        const high = Math.min(last, Math.floor(Math.max(a, b) + 1e-9) + 1);
        return low <= high ? [low, high] : [0, last];
    };
    const extentOf = (seriesList, low, high, include) => {
        let min = include ?? Infinity, max = include ?? -Infinity;
        for (const series of seriesList) {
            if (!series) continue;
            for (let i = low, end = Math.min(high, series.length - 1); i <= end; i++) {
                const value = series[i];
                if (Number.isFinite(value)) { if (value < min) min = value; if (value > max) max = value; }
            }
        }
        return [min, max];
    };
    const fitDomain = (scale, [min, max], pad = 0) => {
        if (!Number.isFinite(min) || !Number.isFinite(max)) return;
        if (!(max > min)) { const gap = Math.max(Math.abs(min) * 0.01, 0.01); min -= gap; max += gap; }
        scale.domain([min - (max - min) * pad, max + (max - min) * pad]);
    };
    const autoscale = () => {
        const [low, high] = visibleIndices();
        // Price only: overlays toggled on or off must not move the price scale.
        fitDomain(baseY, extentOf([vdata], low, high), 0.08);
        const visiblePlotted = extentOf([vdata, MA_a, MA_b, MA_c, MA_d, UpperBand, LowerBand], low, high);
        if (Number.isFinite(visiblePlotted[0])) {
            minPan = Math.min(-0.25, chart.pricePan, (height - padding * 2 - baseY(visiblePlotted[0])) / priceHeight);
            maxPan = Math.max(0.25, chart.pricePan, (margin.top + padding - baseY(visiblePlotted[1])) / priceHeight);
        }
        // MACD and ROC both draw a zero line, so zero stays inside their range.
        if (macd || macdh) fitDomain(yMacd, extentOf([macd ? MacdLine[0] : null, macd ? MacdSignal[0] : null, macdh ? MacdHist[0] : null], low, high, 0), 0.05);
        if (roc) fitDomain(yRoc, extentOf([Roc], low, high, 0), 0.05);
    };
    const gesturePoint = event => {
        if (!event) return null;
        const points = event.touches ? d3.pointers(event.touches, svg.node()) : [d3.pointer(event, svg.node())];
        return points.length ? [d3.mean(points, point => point[0]), d3.mean(points, point => point[1])] : null;
    };
    let panGesture = null;
    const updateZoom = event => {
        const transform = constrain(event.transform);
        chart.zoomTransform = d3.zoomIdentity.translate(transform.x, 0).scale(transform.k);
        x.range(baseRange.map(pixel => transform.applyX(pixel)));
        autoscale();
        const source = event.sourceEvent;
        if (panGesture && (source?.type === 'mousemove' || source?.type === 'touchmove')) {
            const count = source.touches?.length || 1, point = gesturePoint(source);
            if (point) {
                if (count !== panGesture.count) {
                    panGesture.py = point[1]; panGesture.offset = chart.pricePan; panGesture.count = count;
                }
                if (!source.touches || count >= 2) {
                    const delta = point[1] - panGesture.py;
                    if (Math.abs(delta) >= 3 || panGesture.active) {
                        panGesture.active = true;
                        chart.pricePan = Math.max(minPan, Math.min(maxPan, panGesture.offset + delta / priceHeight));
                    }
                }
            }
        }
        applyPricePan();
        svg.select('.price-axis').call(yAxis);
        svg.select('.dline').selectAll('path').attr('d', line);
        svg.select('.abbc').selectAll('path').attr('d', d3.area().x(xrx)
            .y0((_d, i) => y(BandData[i].high)).y1((_d, i) => y(BandData[i].low)));
        svg.select('.zoom-macd').selectAll('path').attr('d', d3.line().defined(Number.isFinite).x(xrx).y(yMacd));
        svg.select('.zoom-roc').selectAll('path').attr('d', d3.line().defined(Number.isFinite).x(xrx).y(yRoc));
        svg.select('.zoom-rsi').selectAll('path').attr('d', d3.line().defined(Number.isFinite).x(xrx).y(yRsi));
        svg.select('.zoom-stoch').selectAll('path').attr('d', d3.line().defined(Number.isFinite).x(xrx).y(yStoch));
        // Bar width follows the spacing between points (never thinner than the
        // original bins), so zooming in widens the bars instead of leaving lines.
        const histStep = datalength > 1 ? Math.abs(x(ddata[1]) - x(ddata[0])) : 0;
        const histWidth = Math.max(datalength > macdhbinsl ? 0.5 : (datalength > macdhbinsm ? 1 : 1.5), Math.min(histStep * 0.7, 14));
        svg.select('.zoom-histogram').selectAll('rect').attr('transform', null)
            .attr('width', histWidth).attr('x', (d, i) => xrx(d, i) - histWidth / 2)
            .attr('y', d => d > 0 ? yMacd(d) : yMacd(0))
            .attr('height', d => Math.abs(yMacd(d) - yMacd(0)));
        svg.select('.macd-axis').call(yMAxis);
        svg.select('.roc-axis').call(yRCAxis);
        hrLines.forEach(place => place());
        svg.select('.date-axis').call(xAxis).select('.domain')
            .attr('d', `M${plotLeft},0.5H${plotRight}`);
        drawGrid();
        updateLastPrice();
        updateSignals();
        chart.updateTrendLines();
        updateInfoMarkers();
        hidePointer();
    };
    this.zoomBehavior = d3.zoom().extent(extent).scaleExtent([1, maxZoom])
        .constrain(constrain)
        .filter(event => !chart.drawingTrend && !chart.trendEdit && !event.altKey &&
            (!event.button || event.type === 'wheel') &&
            (event.type !== 'wheel' || event.ctrlKey || event.metaKey) &&
            !event.target.closest?.('.trend, .trend-hit, .trend-handle, .info-marker') &&
            (event.type !== 'touchstart' || event.touches.length >= 2) && (() => {
                const points = event.touches ? d3.pointers(event.touches, svg.node()) : [d3.pointer(event, svg.node())];
                return points.every(([px, py]) => px >= plotLeft && px <= plotRight &&
                    chart.panelGeometry.some(panel => py >= panel.top && py <= panel.bottom));
            })())
        .on('start', event => {
            chart.zooming = true; hidePointer();
            const point = gesturePoint(event.sourceEvent);
            panGesture = point && ['mousedown', 'touchstart'].includes(event.sourceEvent?.type) &&
                point[1] >= margin.top && point[1] <= height - padding
                ? { py: point[1], offset: chart.pricePan, count: event.sourceEvent.touches?.length || 1, active: false } : null;
        })
        .on('zoom', updateZoom)
        .on('end', () => { chart.zooming = false; panGesture = null; });
    svg.style('touch-action', 'pan-y').call(this.zoomBehavior)
        .on('dblclick.zoom', null)
        .on('dblclick.reset', event => {
            if (chart.drawingTrend || chart.trendEdit) return;
            event.preventDefault();
            chart.pricePan = 0;
            svg.call(chart.zoomBehavior.transform, d3.zoomIdentity);
        });
    // Cooperative gestures: a plain wheel scrolls the page; two fingers belong to
    // the chart, and a long-press crosshair must not scroll the page.
    svg.on('touchstart.guard', event => { if (event.touches.length >= 2 && event.cancelable) event.preventDefault(); }, { passive: false })
        .on('touchmove.guard', event => { if (chart.touchInspect && event.cancelable) event.preventDefault(); }, { passive: false });
    svg.call(this.zoomBehavior.transform, constrain(this.zoomTransform));

}

// round functions
roundn(number) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);

    return Math.round((number + Number.EPSILON) * 100) / 100;
}

roundx(number) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);

    return Math.round((number + Number.EPSILON) * 10) / 10;
}

// technical analysis functions
// EMA SMA DEMA MACD ROC RSI Stochastic Bollinger Bands
// All of them expect chronological data (oldest first) and return a shorter
// array whose LAST element belongs to the last data point; indicatorSeries()
// flips the result for drawing.
average(data) {
    let num = 0;
    for (let i = 0; i < data.length; i++) num += Number(data[i]);
    return num / data.length;
}
EMA(data, range) {
    if (data.length < range) {
        console.log("EMA: Range greater than array length.");
        return [];
    }
    // Seed with the simple average of the first period, then smooth forward.
    let k = 2 / (range + 1),
        num = this.average(data.slice(0, range)),
        e = [num];
    for (let i = range; i < data.length; i++) {
        num = (k * Number(data[i])) + ((1 - k) * num);
        e.push(num);
    }
    return e;
}
SMA(data, range) {
    if (data.length < range) {
        console.log("SMA: Range greater than array length.");
        return [];
    }
    const s = [];
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        sum += data[i];
        if (i >= range) sum -= data[i - range];
        if (i >= range - 1) s.push(sum / range);
    }
    return s;
}
DEMA(data, range) {
    let firstEma = this.EMA(data, range),
        secondEma = this.EMA(firstEma, range);
    if (!secondEma.length) {
        console.log("DEMA: Range greater than array length.");
        return [];
    }
    // The second EMA starts later: align both series at their latest value.
    const lag = firstEma.length - secondEma.length;
    return secondEma.map((x, i) => (2 * firstEma[i + lag]) - x);
}
MACD(data) {
    const { eshort, elong, esignal } = this.config;
    let emashort = this.EMA(data, eshort),
        emalong = this.EMA(data, elong),
        // The two averages have different warm-up lengths; align them at the end.
        n = Math.min(emashort.length, emalong.length),
        macdline = Array.from({ length: n }, (_x, i) =>
            emashort[emashort.length - n + i] - emalong[emalong.length - n + i]),
        macdsignal = this.EMA(macdline, esignal),
        lag = macdline.length - macdsignal.length,
        macdhist = macdsignal.map((x, i) => macdline[i + lag] - x);
    return [{ macdline: macdline, macdsignal: macdsignal, macdhist: macdhist }];
}
ROC(data, N) {
    let roc = [];
    if (data.length <= N) {
        console.log("ROC: Range greater than array length.");
        return [];
    }
    for (let i = N; i < data.length; i++) {
        roc.push({ roc: ((data[i] - data[i - N]) / data[i - N]) * 100 });
    }
    return roc;
}
RSI(data, N) {
    let avg = 0,
        avl = 0,
        rsi = [];
    if (data.length <= N) {
        console.log("RSI: Range greater than array length.");
        return [];
    }
    const value = () => avl === 0 ? (avg === 0 ? 50 : 100) : 100 - (100 / (1 + avg / avl));
    // first "N" changes: simple average of gains and losses
    for (let i = 1; i <= N; i++) {
        const change = data[i] - data[i - 1];
        if (change > 0) avg += change; else avl -= change;
    }
    avg /= N;
    avl /= N;
    rsi.push({ rsi: value() });
    // the rest: Wilder smoothing (an unchanged price still decays both averages)
    for (let i = N + 1; i < data.length; i++) {
        const change = data[i] - data[i - 1];
        avg = (avg * (N - 1) + Math.max(change, 0)) / N;
        avl = (avl * (N - 1) + Math.max(-change, 0)) / N;
        rsi.push({ rsi: value() });
    }
    return rsi;
}
// Stochastic oscillator on closing prices: %K = position of the close inside
// the N-period closing range, %D = 3-period simple average of %K.
STOCH(data, N, smooth = 3) {
    const k = [];
    for (let i = N - 1; i < data.length; i++) {
        let low = Infinity, high = -Infinity;
        for (let j = i - N + 1; j <= i; j++) {
            if (data[j] < low) low = data[j];
            if (data[j] > high) high = data[j];
        }
        k.push(high > low ? (data[i] - low) / (high - low) * 100 : 50);
    }
    return { k, d: k.length >= smooth ? this.SMA(k, smooth) : [] };
}
bollingerband(data, N, K) {
    const bands = [];
    if (N <= 1) {
        console.log("BB: N period of moving average should be grater than 1.");
        return [];
    }
    for (let i = N - 1, n = data.length; i < n; i++) {
        let slc = data.slice(i + 1 - N, i + 1),
            m = slc.reduce((a, b) => a + b) / slc.length,
            s = Math.sqrt(slc.map(x => Math.pow(x - m, 2)).reduce((a, b) => a + b) / slc.length);
        bands.push({ low: m - (s * K), high: m + (s * K) });
    }
    return bands;
}

}
HistoricalPriceChart.storageKey = 'fxchart.v1';
HistoricalPriceChart.textControls = ['ma_a','ma_b','ma_c','ma_d','bb_N','bb_K','macd_fast','macd_slow','macd_signal','roc_values','rsi_values','stoch_values'];
HistoricalPriceChart.checkControls = ['bband','macd','macdh','roc','rsi','stoch','signals'];
window.HistoricalPriceChart=HistoricalPriceChart;
const startChart=()=>{
window.historicalPriceChart?.destroy();
window.historicalPriceChart=new HistoricalPriceChart();
};
window.cqu=()=>window.historicalPriceChart?.convertOrQuote();
window.updatechart=()=>window.historicalPriceChart?.reloadData();
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',startChart,{once:true}); else startChart();
