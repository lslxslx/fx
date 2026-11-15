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
        if(items[0]) {items[0].textContent=value;items[0].className=delta>0?'grc':'rec';}
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
    this.config = {};
    this.state = { loading: false, requestId: 0, currency: null, interval: null };
    this.listeners = [];
    this.zoomTransform = d3.zoomIdentity;
    this.infoEvents = [];
    this.infoRequestId = 0;
    this.trendLines = [];
    this.nextTrendId = 0;
    this.trendDraft = null;
    this.selectedTrendId = null;
    this.trendEdit = null;
    this.destroyed = false;
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
      RS: Math.trunc(number('rsi_values',14)), bband:checked('bband'), macd:checked('macd'),
      macdh:checked('macdh'), roc:checked('roc'), rsi:checked('rsi')
    });
    this.config = config;
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
    this.setLoading(true);
    try {
      const rows = await window.ForexData.query('q?'+new URLSearchParams(params));
      if (this.destroyed || requestId !== this.state.requestId) return;
      this.currentData = this.parseData(rows, params.c);
      this.zoomTransform = d3.zoomIdentity;
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
    this.render();
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
    };
    this.updateTrendLines = redraw;
    svg.on('contextmenu.trends', event => {
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
      if (!chart.trendDraft) { chart.selectedTrendId = null; redraw(); return; }
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

  bindChartPointer(svg, paint, hide) {
    const active = new Set();
    const node = svg.node();
    const release = id => {
      if (node.hasPointerCapture?.(id)) node.releasePointerCapture(id);
    };
    svg.on('pointerenter.inspect pointermove.inspect pointerdown.inspect', event => {
      if (event.target?.closest?.('.info-marker, .trend, .trend-hit, .trend-handle')) { hide(); return; }
      if (event.type === 'pointerdown') {
        if (event.button !== 0) { hide(); return; }
        if (event.pointerType !== 'mouse') {
          active.add(event.pointerId);
          node.setPointerCapture?.(event.pointerId);
          // Suppress compatibility mouse drag for pen/touch inspection.
          event.preventDefault();
        }
      }
      if (this.zooming || this.drawingTrend || this.trendEdit || active.size > 1 ||
          (event.pointerType === 'mouse' && event.buttons)) { hide(); return; }
      paint(event);
    });
    svg.on('pointerup.inspect pointercancel.inspect lostpointercapture.inspect', event => {
      active.delete(event.pointerId);
      release(event.pointerId);
      if (event.pointerType !== 'mouse' || event.type !== 'pointerup') hide();
    });
    svg.on('pointerleave.inspect', hide);
    this.pointerCleanup = () => {
      svg.on('.inspect', null);
      active.forEach(release); active.clear();
      hide();
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
        ? `${result.Amount} ${result.Sell} = ${(result.Amount*result.Exchange).toLocaleString('en')} ${result.Buy}\n(${result.Source})`
        : result.Error || '';
    } catch(error) { output.textContent='Gabim: '+error.message; }
  }

  destroy() {
    this.finishTrendEdit(false, false);
    this.destroyed=true; this.state.requestId++;
    this.infoRequestId++;
    this.infoAbort?.abort();
    clearTimeout(this.layoutTimer);
    this.resizeObserver?.disconnect();
    this.pointerCleanup?.();
    this.infoDialog?.close();
    this.infoDialog?.remove();
    this.listeners.forEach(remove=>remove()); this.listeners=[];
    this.svg.on('.zoom', null).on('dblclick.reset', null);
    this.svg.on('.trends', null);
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
let {ma_a,ma_b,ma_c,ma_d,mma_a,mma_b,mma_c,mma_d,N,K,eshort,elong,esignal,RC,RS,bband,macd,macdh,roc,rsi}=this.config;
const svgvB=this.container, interval=this.state.interval, chart=this;
this.drawingTrend = Boolean(this.trendDraft);
const SwMA=this.SwMA.bind(this), SwMALegend=this.SwMALegend.bind(this);
    const limdata = 50,
        limidata = 20,
        macdhbinsl = 1500,
        macdhbinsm = 900,
        minwidth = 300, // screen
        maxlgwidth = 1050, // screen legend
        legendoffsetw = 23,
        legendoffseth = 1,
        margin = { top: 30, right: 60, bottom: 60 },
        width = svgvB.offsetWidth - margin.right,
        // Do not measure content height: it includes panels from the last render.
        height = Math.max(minwidth, window.innerHeight * 0.55) - margin.top,
        padding = 10,
        indicator = { top: height, height: 90 },
        ibottom = { bottom: indicator.top + indicator.height + padding };

    let vdata = Float64Array.from(values.map(d => d.value)),
        ddata = Float64Array.from(values.map(d => d.date)),
        xrx = (_d, i) => x(ddata[i]);

    const vlength = vdata.length;

    bband = vlength < limdata ? false : bband;
    macd = vlength < limdata ? false : macd;
    macdh = vlength < limdata ? false : macdh;
    roc = vlength < limidata ? false : roc;
    rsi = vlength < limidata ? false : rsi;

    let BandData = bband == true ? bollingerband(vdata, N, K) : false,
        LowerBand = bband == true ? BandData.map(d => d.low) : false,
        UpperBand = bband == true ? BandData.map(d => d.high) : false,
        MA_a = !isNaN(ma_a) ? SwMA(mma_a, vdata, ma_a) : false,
        MA_b = !isNaN(ma_b) ? SwMA(mma_b, vdata, ma_b) : false,
        MA_c = !isNaN(ma_c) ? SwMA(mma_c, vdata, ma_c) : false,
        MA_d = !isNaN(ma_d) ? SwMA(mma_d, vdata, ma_d) : false,
        Macd = macd || macdh == true ? MACD(vdata) : false,
        MacdLine = macd == true ? Macd.map(d => d.macdline) : false,
        MacdSignal = macd == true ? Macd.map(d => d.macdsignal) : false,
        MacdHist = macdh == true ? Macd.map(d => d.macdhist) : false,
        Roc = roc == true ? ROC(vdata, RC).map(r => r.roc) : false,
        Rsi = rsi == true ? RSI(vdata, RS).map(r => r.rsi) : false,
        // Price-only bounds keep the scale stable when overlays are toggled.
        MinYScale = d3.min(vdata),
        MaxYScale = d3.max(vdata),
        PricePadding = MaxYScale > MinYScale
            ? (MaxYScale - MinYScale) * 0.05
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
    let yAxis = g => g
        .attr('transform', 'translate(' + width + ', 0)')
        .call(d3.axisRight(y)
            .tickFormat(d3.format(",.2f"))
            .tickSizeOuter(0));

    let xAxis = g => g
        .attr('transform', 'translate(0,' + ((macd || macdh) && (roc || rsi) ? ibottom.bottom + padding + indicator.height + padding * 2 : (macd || macdh || roc || rsi ? ibottom.bottom + padding : height)) + ')')
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
    this.plotGeometry = { x: baseRange.slice(), y: y.range().slice() };

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
        .attr('class', rsi ? 'rocdomain' : '')
        .call((rsi ? d3.axisLeft(yRoc) : d3.axisRight(yRoc)).ticks(3).tickSizeOuter(0));

    // RSI
    let yRAxis = g => g
        .attr('transform', 'translate(' + width + ', 0)')
        .call(d3.axisRight(yRsi).ticks(3).tickSizeOuter(0));

    let yRoc = d3.scaleLinear()
        .domain([MinRocY, MaxRocY])
        .range([(macd || macdh) ? ibottom.bottom + padding * 2 + indicator.height : ibottom.bottom, (macd || macdh) ? ibottom.bottom + padding : indicator.top])
        .nice();

    let yRsi = d3.scaleLinear()
        .domain([0, 100])
        .range([(macd || macdh) ? ibottom.bottom + padding * 2 + indicator.height : ibottom.bottom, (macd || macdh) ? ibottom.bottom + padding : indicator.top])
        .nice();

    let line = d3.line()
        .x(xrx)
        .y(y);

    const svg = this.svg
        .attr('preserveAspectRatio', 'xMinYMin meet')
        .attr('viewBox', '0 0 ' + (width + margin.right) + ' ' + ((macd || macdh) && (roc || rsi) ? height + margin.top + indicator.height * 2 + padding * 4 : (macd || macdh || roc || rsi ? height + margin.top + indicator.height + padding * 2 : height + margin.top)));

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
        rsic = Rsi != 0 ? '#505050' : '';

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
    function hr(y, yscale, color, swd) {
        let dateRange = [d3.max(ddata), d3.min(ddata)];
        svg.append('g')
            .attr('stroke-width', 0.3)
            .selectAll('path')
            .data([[y, y]])
            .join('path')
            .attr('stroke', color)
            .attr('stroke-width', swd)
            .attr('d', d3.line()
                .x((_d, i) => x(dateRange[i]))
                .y(yscale));
    }

    // price chart legend
    const lglatest = function (_d, i) {
        let formatdate = d3.timeFormat('%a, %d %b %Y'),
            fd = d3.format(','),
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

    // rsi roc chart legend
    const rrlglatest = function (_d, i) {
        let fd = d3.format(','),
            txt_roc = roc ? 'ROC: ' + fd(roundn(Roc[0])) : 0,
            txt_rsi = rsi ? 'RSI: ' + fd(roundn(Rsi[0])) : 0;
        return [txt_roc, txt_rsi].filter(x => x != 0)[i];
    }

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
        rsrclg;

    // MACD
    if (macd || macdh) {
        svg.append('g')
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
                .x(xrx)
                .y(yRoc));

        hr(0, yRoc, '#f28f3b', 0.3);
    }

    // RSI
    if (rsi) {
        svg.append('g')
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
                .x(xrx)
                .y(yRsi));

        hr(30, yRsi, '#808080', 0.3);
        hr(70, yRsi, '#808080', 0.3);
    }

    if (roc || rsi) {
        // roc rsi legend
        const rsrclegend = svg.append('g')
            .attr('class', 'rsrclegend')
            .attr('transform', 'translate(' + padding + ',' + ((macd || macdh) ? ibottom.bottom + padding : indicator.top) + ')');

        rsrclg = rsrclegend.selectAll('g')
            .data([Roc, Rsi].filter(x => x != 0 || !isNaN(x)))
            .join('g')
            .append('text')
            .style('fill', (_d, i) => [rocc, rsic].filter(x => x !== '')[i]);

        offset = 0; // roc rsi legend text offset
        rsrclg.text(rrlglatest)
            .attr('transform', offsetf);
    }

    // crosshair
    let crssh = svg.append('g').attr('pointer-events', 'none'),
        label = crssh.append('text'),
        crosshair = crssh.append('g')
            .attr('stroke-width', 0.5);

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

    // roc grid
    if (roc) {
        svg.append('rect')
            .attr('class', 'rsrcgrid')
            .attr('fill', 'none')
            .attr('pointer-events', 'all')
            .attr('x', padding)
            .attr('y', (macd || macdh) ? ibottom.bottom + padding : indicator.top)
            .attr('width', x.range()[0] - padding)
            .attr('height', (macd || macdh) ? yRoc.range()[0] - ibottom.bottom - padding : yRoc.range()[0] - indicator.top);
    }

    // rsi grid
    if (rsi) {
        svg.append('rect')
            .attr('class', 'rsrcgrid')
            .attr('fill', 'none')
            .attr('pointer-events', 'all')
            .attr('x', padding)
            .attr('y', (macd || macdh) ? ibottom.bottom + padding : indicator.top)
            .attr('width', x.range()[0] - padding)
            .attr('height', (macd || macdh) ? yRsi.range()[0] - ibottom.bottom - padding : yRsi.range()[0] - indicator.top);
    }

    function hidePointer() {
            chart.state.pointerIndex = null;
            crosshair.style('display', 'none');
            label.style('display', 'none');
            lg.text(lglatest);
            if (macd || macdh) {
                macdlg.text(macdlglatest);
            }
            if (roc || rsi) {
                rsrclg.text(rrlglatest);
            }
    }
    const pointerSeries = {
        vdata, MA_a, MA_b, MA_c, MA_d, UpperBand, LowerBand,
        MacdLine: macd ? MacdLine[0] : null,
        MacdSignal: macd ? MacdSignal[0] : null,
        MacdHist: macdh ? MacdHist[0] : null, Roc, Rsi
    };
    function paintPointer(event) {
            const [rawX, yval] = d3.pointer(event, svg.node());
            const rsrcTop = (macd || macdh) ? ibottom.bottom + padding : indicator.top;
            const panel = yval >= margin.top && yval <= y.range()[0] ? 'price'
                : (macd || macdh) && yval >= indicator.top && yval <= yMacd.range()[0] ? 'macd'
                : (roc || rsi) && yval >= rsrcTop && yval <= (roc ? yRoc : yRsi).range()[0] ? 'rsrc' : null;
            if (!panel || rawX < plotLeft || rawX > plotRight) { hidePointer(); return; }
            const snapshot = chart.pointerSnapshot(rawX, ddata, x.range(), [plotLeft, plotRight], pointerSeries);
            if (!snapshot) { hidePointer(); return; }
            chart.state.pointerIndex = snapshot.index;
            const xval = snapshot.x, yVonx = snapshot.values;
            crosshair.style('display', null);
            label.style('display', null);

            const sx = xval < width / 2 ? 1 : -1;
            const sy = yval < height / 2 ? 2 : -1;
            const pointerFormat = value => Number.isFinite(value) ? d3.format(',')(roundn(value)) : '—';

            function maintxt(_d, i) {
                let formatdate = d3.timeFormat('%a, %d %b %Y'),
                    fd = pointerFormat,
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

            function rrtxt(_d, i) {
                let fd = pointerFormat,
                    txt_roc = roc ? 'ROC: ' + fd(yVonx.Roc) : 0,
                    txt_rsi = rsi ? 'RSI: ' + fd(yVonx.Rsi) : 0;
                return [txt_roc, txt_rsi].filter(x => x != 0)[i];
            }

            function linelabel() {
                let fd = d3.format(',');
                switch (panel) {
                    case 'rsrc':
                        return roc && rsi ? 'ROC ' + roundx(yRoc.invert(yval)) + ' RSI ' + roundx(yRsi.invert(yval)) : (roc ? roundx(yRoc.invert(yval)) : (rsi ? roundx(yRsi.invert(yval)) : null));
                        break;
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
                .attr('y2', (macd || macdh) && (roc || rsi) ? ibottom.bottom + indicator.height + padding * 3 : (macd || macdh || roc || rsi ? height + indicator.height + padding * 2 : height));

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
                .style('text-anchor', sx > 0 ? 'start' : 'end');

            lg.text(maintxt);

            if (macd || macdh) {
                macdlg.text(macdtxt);
            }

            if (roc || rsi) {
                rsrclg.text(rrtxt);
            }
    }
    hidePointer();
    this.bindChartPointer(svg, paintPointer, hidePointer);

    // draw trendlines
    svg.append('g').attr('class', 'trend-viewport')
        .attr('clip-path', `url(#${this.priceClipId})`).append('g')
        .attr('class', 'trendlines');
    svg.select('.trend-viewport').append('g').attr('class', 'trend-handles');
    this.bindTrendLines(svg, ddata, x, y,
        { left: plotLeft, right: plotRight, top: margin.top, bottom: height - padding }, currency, interval);
    const updateInfoMarkers = this.drawInfoMarkers(svg, ddata, vdata, currency, interval, x, y,
        { left: plotLeft, right: plotRight, top: margin.top, bottom: height - padding });

    // Update only geometry during gestures; indicator values remain calculated
    // from the complete history, so zoom does not restart their warm-up periods.
    const lowerClipId = this.priceClipId + '-indicators';
    svg.select('defs').append('clipPath').attr('id', lowerClipId)
        .append('rect').attr('x', plotLeft).attr('y', indicator.top)
        .attr('width', plotRight - plotLeft)
        .attr('height', indicator.height * 2 + padding * 4);
    svg.selectAll('.zoom-macd, .zoom-histogram, .zoom-roc, .zoom-rsi')
        .attr('clip-path', `url(#${lowerClipId})`);
    const extent = [[plotLeft, margin.top], [plotRight, height - padding]];
    const maxZoom = Math.max(1, Math.min(100, (datalength - 1) / 9));
    const constrain = transform => {
        const k = Math.max(1, Math.min(maxZoom, transform.k));
        const tx = Math.max(plotRight * (1 - k), Math.min(plotLeft * (1 - k), transform.x));
        return d3.zoomIdentity.translate(tx, 0).scale(k);
    };
    const updateZoom = transform => {
        chart.zoomTransform = transform;
        x.range(baseRange.map(pixel => transform.applyX(pixel)));
        svg.select('.dline').selectAll('path').attr('d', line);
        svg.select('.abbc').selectAll('path').attr('d', d3.area().x(xrx)
            .y0((_d, i) => y(BandData[i].high)).y1((_d, i) => y(BandData[i].low)));
        svg.select('.zoom-macd').selectAll('path').attr('d', d3.line().x(xrx).y(yMacd));
        svg.select('.zoom-roc').selectAll('path').attr('d', d3.line().x(xrx).y(yRoc));
        svg.select('.zoom-rsi').selectAll('path').attr('d', d3.line().x(xrx).y(yRsi));
        svg.select('.zoom-histogram').selectAll('rect').attr('x', xrx);
        svg.select('.date-axis').call(xAxis).select('.domain')
            .attr('d', `M${plotLeft},0.5H${plotRight}`);
        chart.updateTrendLines();
        updateInfoMarkers();
        hidePointer();
    };
    this.zoomBehavior = d3.zoom().extent(extent).scaleExtent([1, maxZoom])
        .constrain(constrain)
        .filter(event => !chart.drawingTrend && !chart.trendEdit && !event.altKey &&
            (!event.button || event.type === 'wheel') &&
            !event.target.closest?.('.trend, .trend-hit, .trend-handle, .info-marker') &&
            (event.type === 'touchstart' ? event.touches.length >= 2 : (() => {
                const [px, py] = d3.pointer(event, svg.node());
                return px >= plotLeft && px <= plotRight && py >= margin.top;
            })()))
        .on('start', () => { chart.zooming = true; hidePointer(); })
        .on('zoom', event => updateZoom(constrain(event.transform)))
        .on('end', () => { chart.zooming = false; });
    svg.style('touch-action', 'none').call(this.zoomBehavior)
        .on('dblclick.zoom', null)
        .on('dblclick.reset', event => {
            if (chart.drawingTrend || chart.trendEdit) return;
            event.preventDefault();
            svg.call(chart.zoomBehavior.transform, d3.zoomIdentity);
        });
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
// EMA SMA DEMA MACDH ROC RSI Bollinger Bands
EMA(data, range) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);

    // if (!Array.isArray(data)) {
    //     console.log("Not an array");
    //     return 0;
    // }
    if (data.length < range) {
        console.log("EMA: Range greater than array length.");
        return [];
    }
    let k = 2 / (range + 1),
        num = average(data.slice(0, range)),
        i = range,
        e = [num];
    for (i; i < data.length; i++) {
        num = (k * Number(data[i])) + ((1 - k) * num);
        e.push(num);
    }
    return e;
}
average(data) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);

    let len = data.length,
        i = -1,
        num = 0;
    while (++i < len) num += Number(data[i]);
    return num / len;
}
SMA(data, range) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);

    if (data.length < range) {
        console.log("SMA: Range greater than array length.");
        return [];
    }
    const s = [];
    for (let i = range - 1, n = data.length; i < n; i++) {
        let slc = data.slice(i + 1 - range, i),
            m = slc.reduce((a, b) => a + b) / slc.length;
        s.push(roundn(m));
    }
    return s;
}
DEMA(data, range) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);

    if (data.length < range) {
        console.log("DEMA: Range greater than array length.");
        return [];
    }
    let firstEma = EMA(data, range),
        secondEma = EMA(firstEma, range);
    return firstEma.map((x, i) => (2 * x) - secondEma[i]).filter(v => !Number.isNaN(v));
}
MACD(data) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const ROC = this.ROC.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);
const {eshort,elong,esignal}=this.config;
    let emashort = EMA(data, eshort),
        emalong = EMA(data, elong),
        macdline = emashort.map((x, i) => x - emalong[i]).filter(v => !Number.isNaN(v)),
        macdsignal = EMA(macdline, esignal),
        macdhist = macdline.map((x, i) => x - macdsignal[i]).filter(v => !Number.isNaN(v)),
        macd = [];
    macd.push({
        macdline: macdline,
        macdsignal: macdsignal,
        macdhist: macdhist
    });
    return macd;
}
ROC(data, N) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const RSI = this.RSI.bind(this);
const bollingerband = this.bollingerband.bind(this);

    let i = 0,
        rc = 0,
        roc = [];
    if (data.length < N) {
        console.log("ROC: Range greater than array length.");
        return [];
    }
    // for the first N days
    for (i; i < N; i++) {
        rc = ((data[i] - data[i - N]) / data[i - N]) * 100;
    }
    // for the rest of the data
    for (i = N; i < data.length; i++) {
        rc = ((data[i] - data[i - N]) / data[i - N]) * 100;
        roc.push({
            roc: rc
        });
    }
    return roc;
}
RSI(data, N) {
const parseData = this.parseData.bind(this);
const drawChart = this.drawChart.bind(this);
const roundn = this.roundn.bind(this);
const roundx = this.roundx.bind(this);
const EMA = this.EMA.bind(this);
const average = this.average.bind(this);
const SMA = this.SMA.bind(this);
const DEMA = this.DEMA.bind(this);
const MACD = this.MACD.bind(this);
const ROC = this.ROC.bind(this);
const bollingerband = this.bollingerband.bind(this);

    let i = 0,
        avg = 0,
        avl = 0,
        rsi = [];
    if (data.length < N) {
        console.log("RSI: Range greater than array length.");
        return [];
    }
    // for the first "N" days
    for (i; i < N; i++) {
        const change = data[i] - data[i - 1];
        if (change > 0) {
            avg += change;
        }
        if (change < 0) {
            avl -= change;
        }
    }
    avg /= N;
    avl /= N;
    // for the rest of the data
    for (i = N; i < data.length; i++) {
        const change = data[i] - data[i - 1];
        if (change > 0) {
            avg = (avg * (N - 1) + change) / N;
            avl = (avl * (N - 1)) / N;
        }
        if (change < 0) {
            avl = (avl * (N - 1) - change) / N;
            avg = (avg * (N - 1)) / N;
        }
        rsi.push({
            rsi: 100 - (100 / (1 + (avg === 0 ? 0 : avg) / (avl === 0 ? 100 : avl)))
        });
    }
    return rsi;
}
bollingerband(data, N, K) {
const parseData = this.parseData.bind(this);
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

    const bands = [];
    if (N <= 1) {
        console.log("BB: N period of moving average should be grater than 1.");
        return [];
    }
    for (let i = N - 1, n = data.length; i < n; i++) {
        let slc = data.slice(i + 1 - N, i),
            m = slc.reduce((a, b) => a + b) / slc.length,
            s = Math.sqrt(slc.map(x => Math.pow(x - m, 2)).reduce((a, b) => a + b) / slc.length),
            lband = m - (s * K),
            uband = m + (s * K);
        bands.push({
            low: roundn(lband),
            high: roundn(uband)
        });
    }
    return bands;
}

}
window.HistoricalPriceChart=HistoricalPriceChart;
const startChart=()=>{
window.historicalPriceChart?.destroy();
window.historicalPriceChart=new HistoricalPriceChart();
};
window.cqu=()=>window.historicalPriceChart?.convertOrQuote();
window.updatechart=()=>window.historicalPriceChart?.reloadData();
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',startChart,{once:true}); else startChart();
