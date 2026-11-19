// Technical analysis chart (d3 v7). Files read from ./data/:
//   eur.json, usd.json, ...  daily official rates, one file per currency
//   events.json              optional info markers: date (YYYY-MM-DD), currency
//                            (EUR, USD, ... or '*'), title and description; [] = none
// Parts of this file, in order: number formatting, ForexData (data store),
// Indicators (formulas), HistoricalPriceChart (the chart), start-up.

// Display formatting only; historical values and indicator calculations stay numeric.
const formatFxNumber = (value, grouped = true) => Number.isFinite(value)
  ? d3.format(grouped ? ',.2f' : '.2f')(value) : '—';

// Fibonacci retracement ratios: 0% sits on the latest extreme, 100% on the other one.
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const fibLabel = (ratio, price) => (ratio * 100).toFixed(1).replace(/\.0$/, '') + '% ' + formatFxNumber(price);

// Data store: reads ./data/*.json (GitHub Pages, no backend) and answers the same
// queries as the server's q / cq endpoints. Does not intercept global fetch.
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
    statusNode().textContent=''; // a successful load clears an earlier error
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
  // Today's rates for the currency list. ./data/latest.json (written by the update
  // script) holds the latest and previous rate of every currency, so the page does
  // not download nine histories at start-up. Without it, the histories are used.
  async function latestRates() {
    try {
      const response = await fetch('./data/latest.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error('latest.json: HTTP ' + response.status);
      const latest = await response.json();
      if (codes.every(c => Number.isFinite(latest?.[c]?.current?.[c]) && Number.isFinite(latest[c].previous?.[c]))) return latest;
      throw new Error('latest.json: incomplete');
    } catch (error) {
      console.warn('Using the full histories for the currency list:', error.message);
      // One missing history must not hide the other currencies.
      const latest = {}, failed = [];
      await Promise.all(codes.map(async c => {
        try {
          const rows = await load(c);
          if (rows.length) latest[c] = { current: rows[0], previous: rows[1] || rows[0], unit: c === 'JPY' ? 100 : 1 };
        } catch (loadError) { failed.push(c); }
      }));
      if (failed.length) statusNode().textContent = 'Rates not loaded for: ' + failed.sort().join(', ') + '.';
      return latest;
    }
  }
  async function summary() {
    try {
      const latest = await latestRates();
      for (const c of codes) {
        const row = latest[c];
        if (!row) continue;
        const value = row.current[c], before = row.previous[c], delta = value - before;
        const rate = document.querySelector(`[data-rate="${c}"]`), percent = document.querySelector(`[data-percent="${c}"]`);
        if (rate) rate.textContent = formatFxNumber(value);
        if (percent) {
          percent.textContent = before ? (delta > 0 ? '+' : '') + (100 * delta / before).toFixed(2).replace('-', '−') + '%' : '—';
        }
        if (rate) rate.className = 'rate ' + (delta > 0 ? 'grc' : (delta < 0 ? 'rec' : ''));
        const change = document.querySelector(`[data-delta="${c}"]`);
        if (change) change.textContent = (delta > 0 ? '+' : '') + formatFxNumber(delta);
        const label = document.querySelector(`label[for="${c}"]`);
        if (label) label.title = (row.unit === 100 ? 'Rate for 100 ' + c + '. ' : '') + row.current.Data +
          ': ' + formatFxNumber(value) + ', previous ' + row.previous.Data + ': ' + formatFxNumber(before) +
          ' (' + (delta > 0 ? '+' : '') + delta.toFixed(2) + ')';
      }
      const updated = document.getElementById('updated'), day = latest.EUR?.current?.Data;
      if (updated && day) updated.textContent = d3.utcFormat('%d %b %Y')(new Date(day + 'T00:00:00Z'));
    } catch (e) { statusNode().textContent = 'The currency list could not be loaded: ' + e.message; }
  }
  document.addEventListener('DOMContentLoaded',summary);
  return {query,convert,load,period};
})();



// Technical analysis formulas (StockCharts ChartSchool definitions).
// Pure functions: no DOM, no chart state. All of them expect chronological data
// (oldest first) and return a shorter array whose LAST element belongs to the last
// data point; HistoricalPriceChart.indicatorSeries() flips the results for drawing.
// EMA SMA DEMA MACD ROC RSI Stochastic Bollinger Bands
const Indicators = {
  average(data) {
    let num = 0;
    for (let i = 0; i < data.length; i++) num += Number(data[i]);
    return num / data.length;
  },
  EMA(data, range) {
    if (data.length < range) {
      console.log("EMA: Range greater than array length.");
      return [];
    }
    // Seed with the simple average of the first period, then smooth forward.
    let k = 2 / (range + 1),
      num = Indicators.average(data.slice(0, range)),
      e = [num];
    for (let i = range; i < data.length; i++) {
      num = (k * Number(data[i])) + ((1 - k) * num);
      e.push(num);
    }
    return e;
  },
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
  },
  DEMA(data, range) {
    let firstEma = Indicators.EMA(data, range),
      secondEma = Indicators.EMA(firstEma, range);
    if (!secondEma.length) {
      console.log("DEMA: Range greater than array length.");
      return [];
    }
    // The second EMA starts later: align both series at their latest value.
    const lag = firstEma.length - secondEma.length;
    return secondEma.map((x, i) => (2 * firstEma[i + lag]) - x);
  },
  MACD(data, eshort, elong, esignal) {
    let emashort = Indicators.EMA(data, eshort),
      emalong = Indicators.EMA(data, elong),
      // The two averages have different warm-up lengths; align them at the end.
      n = Math.min(emashort.length, emalong.length),
      macdline = Array.from({ length: n }, (_x, i) =>
        emashort[emashort.length - n + i] - emalong[emalong.length - n + i]),
      macdsignal = Indicators.EMA(macdline, esignal),
      lag = macdline.length - macdsignal.length,
      macdhist = macdsignal.map((x, i) => macdline[i + lag] - x);
    return [{ macdline: macdline, macdsignal: macdsignal, macdhist: macdhist }];
  },
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
  },
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
  },
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
    return { k, d: k.length >= smooth ? Indicators.SMA(k, smooth) : [] };
  },
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
};
window.FxIndicators = Indicators;

class HistoricalPriceChart {
  // ===== Lifecycle =============================================================

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
    this.panelHeights = {}; // Panel heights (chart units) set by dragging the line under a panel.
    this.dateRange = { fd: '', td: '' }; // custom dates, used after "Apply dates"
    this.nextTrendId = 0;
    this.trendDraft = null;
    this.selectedTrendId = null;
    this.selectedLevelId = null; // selected horizontal level
    this.levelDrag = null;
    this.trendEdit = null;
    this.destroyed = false;
    // The crosshair starts switched on; a saved choice overrides this.
    const crosshairButton = document.getElementById('crosshair');
    if (crosshairButton) crosshairButton.checked = true;
    this.restoreState();
    this.updateMovingAverageButton();
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

  // ===== Controls, settings and saved state ====================================

  bindControls() {
    const panel = document.getElementById('cpanel');
    this.bindRuler();
    this.listen(panel, 'change', event => {
      const target = event.target;
      // Dates wait for "Apply dates": nothing reloads while they are being chosen.
      if (target.type === 'date') return;
      // "Custom dates" only opens the fields; turning it off drops applied dates.
      if (target.id === 'custom') {
        if (!target.checked) this.clearDateRange(Boolean(this.dateRange.fd || this.dateRange.td));
        return;
      }
      if (target.matches('input[name=currency], input[name=interval], input[name=ix]')) {
        if (target.name === 'interval') this.switchintervalix(target.value);
        // A range button replaces a custom date range.
        if (target.name === 'ix') { this.clearDateRange(false); this.updateRuler(); }
        // Only a new currency closes the menu on phones; period changes keep it open.
        if (target.name === 'currency') this.closemenu();
        this.reloadData();
      } else if (target.closest('#overlays, #indicators, #tools')) this.refreshIndicators();
    });
    // Buttons: dates, moving averages (add a row and focus its period, remove a row).
    this.listen(panel, 'click', event => {
      if (event.target.id === 'range-apply') {
        this.applyDateRange();
      } else if (event.target.id === 'ma-add') {
        this.addMovingAverage()?.querySelector('.ma-period').focus();
      } else if (event.target.classList.contains('ma-remove')) {
        event.target.closest('.ma-row').remove();
        this.updateMovingAverageButton();
        this.refreshIndicators();
      }
    });
    this.listen(panel, 'keydown', event => {
      if (event.key !== 'Enter' || event.target.id === 'q') return;
      event.preventDefault();
      if (event.target.type === 'date') { this.applyDateRange(); return; }
      this.closemenu();
      if (event.target.closest('#overlays, #indicators, #tools')) this.refreshIndicators();
      else this.reloadData();
    });
    this.listen(document, 'pointerdown', event => {
      if (!this.container.contains(event.target)) this.hideCrosshair?.();
    });
    // A change made just before leaving (or reloading) the page is not lost.
    this.listen(window, 'pagehide', () => this.saveState(true));
    this.listen(window, 'keydown', event => {
      // Delete / Backspace removes the selected trend line (selected by clicking it,
      // drawing it or moving one of its ends) or the selected horizontal level.
      // Never while typing in a field.
      if ((event.key === 'Delete' || event.key === 'Backspace') &&
          (this.selectedTrendId !== null || this.selectedLevelId !== null) && !this.levelDrag &&
          !this.trendEdit && !this.trendDraft && !event.target.closest?.('input, textarea, select, [contenteditable]')) {
        event.preventDefault();
        this.trendLines = this.trendLines.filter(item => item.id !== this.selectedTrendId);
        this.levels = this.levels.filter(item => item.id !== this.selectedLevelId);
        this.selectedTrendId = null;
        this.selectedLevelId = null;
        this.updateTrendLines?.();
        return;
      }
      if (event.key !== 'Escape') return;
      if (this.trendEdit) this.finishTrendEdit(false);
      else if (this.trendDraft) this.cancelTrendDraft();
      else { this.selectedTrendId = null; this.selectedLevelId = null; this.updateTrendLines?.(); }
    });
  }

  // On small screens the menu covers the chart: close it after a choice.
  closemenu() {
    const menu = document.getElementById('menu');
    if (menu && window.matchMedia('(max-width: 899px)').matches) menu.checked = false;
  }

  // Default range when the interval changes: 1 year daily, 5 years weekly,
  // 20 years monthly, everything quarterly.
  switchintervalix(v) {
    const months = { quave: 0, mave: 240, wave: 60, daily: 12 };
    if (v in months) this.setRange(String(months[v]));
    return this.rangeValue();
  }

  // Range buttons (1M ... Max): the checked one, or check one by its number of months.
  rangeValue() {
    return document.querySelector('input[name=ix]:checked')?.value || '12';
  }

  // A value that is no longer on the ruler (an older saved 3Y, say) goes to the
  // nearest step on the logarithmic scale; Max stays Max.
  setRange(months) {
    const inputs = Array.from(document.querySelectorAll('input[name=ix]'));
    let input = inputs.find(item => item.value === String(months));
    const wanted = Number(months);
    if (!input && wanted > 0) {
      const distance = item => Number(item.value) > 0 ? Math.abs(Math.log(Number(item.value) / wanted)) : Infinity;
      input = inputs.reduce((best, item) => distance(item) < distance(best) ? item : best, inputs[0]);
    }
    if (input) input.checked = true;
    this.updateRuler();
  }

  // The tag on the ruler follows the checked step.
  updateRuler() {
    const ruler = document.getElementById('range'), mark = ruler?.querySelector('.ruler-mark');
    const input = ruler?.querySelector('input[name=ix]:checked'), label = input && ruler.querySelector(`label[for="${input.id}"]`);
    if (!mark || !label) return;
    mark.style.setProperty('--p', label.style.getPropertyValue('--p'));
    mark.textContent = label.textContent;
  }

  // Pointer on the ruler: the nearest step follows the finger or the mouse, and the
  // chart reloads once, when it is released on a different step.
  bindRuler() {
    const ruler = document.getElementById('range');
    if (!ruler) return;
    const inputs = Array.from(ruler.querySelectorAll('input[name=ix]'));
    const nearest = event => {
      const box = ruler.getBoundingClientRect();
      return inputs.reduce((best, input) => {
        const left = ruler.querySelector(`label[for="${input.id}"]`).getBoundingClientRect();
        const x = left.left + left.width / 2, bestBox = ruler.querySelector(`label[for="${best.id}"]`).getBoundingClientRect();
        return Math.abs(x - event.clientX) < Math.abs(bestBox.left + bestBox.width / 2 - event.clientX) ? input : best;
      }, inputs[0]);
    };
    let start = null;
    const preview = event => { const input = nearest(event); input.checked = true; this.updateRuler(); };
    this.listen(ruler, 'pointerdown', event => {
      if (event.button > 0) return;
      event.preventDefault();
      start = ruler.querySelector('input[name=ix]:checked');
      ruler.setPointerCapture(event.pointerId);
      preview(event);
    });
    this.listen(ruler, 'pointermove', event => { if (start) preview(event); });
    const finish = () => {
      if (!start) return;
      const chosen = ruler.querySelector('input[name=ix]:checked'), changed = chosen !== start;
      start = null;
      if (changed) chosen.dispatchEvent(new Event('change', { bubbles: true }));
    };
    this.listen(ruler, 'pointerup', finish);
    this.listen(ruler, 'pointercancel', finish);
    this.updateRuler();
  }

  // Custom dates are used only after "Apply dates" (or Enter in a date field).
  applyDateRange() {
    const from = document.getElementById('start')?.value || '', to = document.getElementById('end')?.value || '';
    const status = document.getElementById('data-status');
    if (from && to && from > to) {
      if (status) status.textContent = 'The From date must be before the To date.';
      return;
    }
    this.dateRange = { fd: from, td: to };
    document.getElementById('range')?.classList.toggle('inactive', Boolean(from || to));
    this.reloadData();
  }

  clearDateRange(reload) {
    for (const id of ['start', 'end']) { const input = document.getElementById(id); if (input) input.value = ''; }
    const custom = document.getElementById('custom');
    if (custom) custom.checked = false;
    this.dateRange = { fd: '', td: '' };
    document.getElementById('range')?.classList.remove('inactive');
    if (reload) this.reloadData();
  }

  parameters() {
    return {
      c: document.querySelector('input[name=currency]:checked')?.value || 'EUR',
      fd: this.dateRange?.fd || '', td: this.dateRange?.td || '',
      i: document.querySelector('input[name=interval]:checked')?.value || 'daily',
      ix: this.rangeValue()
    };
  }

  readIndicators() {
    const value = id => document.getElementById(id)?.value || '';
    const number = (id, fallback, min = 1) => {
      const n = Number(value(id));
      return Number.isFinite(n) && n >= min ? n : fallback;
    };
    const checked = id => Boolean(document.getElementById(id)?.checked);
    const config = {
      // Moving averages from the list in the menu: type S / E / D, period, colour slot.
      mas: this.readMovingAverages(),
      N: Math.trunc(number('bb_N',20,2)), K: number('bb_K',2),
      eshort: Math.trunc(number('macd_fast',8)), elong: Math.trunc(number('macd_slow',17)),
      esignal: Math.trunc(number('macd_signal',9)), RC: Math.trunc(number('roc_values',12)),
      RS: Math.trunc(number('rsi_values',14)), ST: Math.trunc(number('stoch_values',14,2)),
      bband:checked('bband'), macd:checked('macd'),
      macdh:checked('macdh'), roc:checked('roc'), rsi:checked('rsi'),
      stoch:checked('stoch'), signals:checked('signals'), fib:checked('fib'),
      // Without the button in the page the crosshair simply stays on.
      cross: document.getElementById('crosshair') ? checked('crosshair') : true
    };
    this.config = config;
    // Track selections, not data availability: a short history must not erase
    // the user's order. Turning an indicator off removes it; turning it back
    // on appends it after any oscillator that is still selected.
    this.oscillatorOrder = (this.oscillatorOrder || []).filter(key => config[key]);
    for (const key of ['roc', 'rsi', 'stoch']) {
      if (config[key] && !this.oscillatorOrder.includes(key)) this.oscillatorOrder.push(key);
    }
  }

  // Moving averages in the menu: one row each (colour, type, period, remove), up to
  // HistoricalPriceChart.maxAverages. A row keeps its colour slot while it exists.
  readMovingAverages() {
    return Array.from(document.querySelectorAll('#ma-list .ma-row')).map(row => ({
      type: row.querySelector('.ma-type').value,
      period: Math.trunc(Number(row.querySelector('.ma-period').value)),
      slot: Number(row.dataset.slot)
    })).filter(ma => ['S', 'E', 'D'].includes(ma.type) && Number.isFinite(ma.period) && ma.period >= 1);
  }

  addMovingAverage(type = 'E', period = '', slot = null) {
    const list = document.getElementById('ma-list');
    if (!list) return null;
    const rows = Array.from(list.querySelectorAll('.ma-row'));
    if (rows.length >= HistoricalPriceChart.maxAverages) return null;
    const used = new Set(rows.map(row => Number(row.dataset.slot)));
    if (slot === null || used.has(slot)) slot = [...Array(HistoricalPriceChart.maxAverages).keys()].find(i => !used.has(i));
    const row = document.createElement('div');
    row.className = 'ma-row';
    row.dataset.slot = slot;
    const swatch = document.createElement('span');
    swatch.className = 'ma-swatch';
    swatch.style.background = `var(--c-ma-${slot + 1})`;
    const select = document.createElement('select');
    select.className = 'ma-type';
    select.setAttribute('aria-label', 'Moving average type');
    for (const [key, label] of [['S', 'SMA'], ['E', 'EMA'], ['D', 'DEMA']]) select.add(new Option(label, key, false, key === type));
    const input = document.createElement('input');
    input.type = 'text'; input.inputMode = 'numeric'; input.className = 'ma-period';
    input.placeholder = '20'; input.maxLength = 4; input.value = period;
    input.setAttribute('aria-label', 'Moving average period');
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'ma-remove'; remove.textContent = '×';
    remove.title = 'Remove'; remove.setAttribute('aria-label', 'Remove moving average');
    row.append(swatch, select, input, remove);
    list.appendChild(row);
    this.updateMovingAverageButton();
    return row;
  }

  updateMovingAverageButton() {
    const add = document.getElementById('ma-add');
    if (add) add.disabled = document.querySelectorAll('#ma-list .ma-row').length >= HistoricalPriceChart.maxAverages;
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
    if (typeof saved.ix === 'string') this.setRange(saved.ix);
    if (Array.isArray(saved.order)) this.oscillatorOrder = saved.order.filter(key => ['roc', 'rsi', 'stoch'].includes(key));
    const point = value => value && Number.isFinite(value.date) && Number.isFinite(value.price);
    if (Array.isArray(saved.trendLines)) {
      this.trendLines = saved.trendLines
        .filter(trend => trend && typeof trend.currency === 'string' && typeof trend.interval === 'string' && point(trend.start) && point(trend.end))
        .map(trend => ({ id: ++this.nextTrendId, currency: trend.currency, interval: trend.interval,
          ...(trend.kind === 'fib' ? { kind: 'fib' } : {}),
          start: { date: trend.start.date, price: trend.start.price }, end: { date: trend.end.date, price: trend.end.price } }));
    }
    if (Array.isArray(saved.levels)) {
      this.levels = saved.levels.filter(level => level && typeof level.currency === 'string' && Number.isFinite(level.price))
        .map(level => ({ id: ++this.nextTrendId, currency: level.currency, price: level.price }));
    }
    // Moving averages; older saves kept four fields such as "E20".
    let averages = Array.isArray(saved.mas) ? saved.mas : ['ma_a', 'ma_b', 'ma_c', 'ma_d']
      .map(id => String(saved.text?.[id] || '').trim().match(/^([SED])([1-9]\d*)$/i))
      .filter(Boolean).map(match => ({ type: match[1].toUpperCase(), period: match[2] }));
    for (const ma of averages.slice(0, HistoricalPriceChart.maxAverages)) {
      if (ma && ['S', 'E', 'D'].includes(ma.type)) this.addMovingAverage(ma.type, String(ma.period ?? ''), Number.isInteger(ma.slot) ? ma.slot : null);
    }
    if (saved.heights && typeof saved.heights === 'object') {
      this.panelHeights = Object.fromEntries(Object.entries(saved.heights)
        .filter(([key, value]) => ['price', 'macd', 'roc', 'rsi', 'stoch'].includes(key) && Number.isFinite(value) && value > 0));
    }
  }

  // Saved shortly after the last change; immediately when the page is left.
  saveState(immediate = false) {
    if (this.destroyed) return;
    clearTimeout(this.saveTimer);
    const save = () => {
      const node = id => document.getElementById(id);
      const state = {
        currency: document.querySelector('input[name=currency]:checked')?.value,
        interval: document.querySelector('input[name=interval]:checked')?.value,
        ix: this.rangeValue(), order: this.oscillatorOrder,
        text: Object.fromEntries(HistoricalPriceChart.textControls.filter(node).map(id => [id, node(id).value])),
        checked: Object.fromEntries(HistoricalPriceChart.checkControls.filter(node).map(id => [id, node(id).checked])),
        trendLines: this.trendLines.map(({ currency, interval, kind, start, end }) => ({ currency, interval, ...(kind ? { kind } : {}), start, end })),
        levels: this.levels.map(({ currency, price }) => ({ currency, price })),
        mas: Array.from(document.querySelectorAll('#ma-list .ma-row')).map(row => ({
          type: row.querySelector('.ma-type').value, period: row.querySelector('.ma-period').value, slot: Number(row.dataset.slot) })),
        heights: this.panelHeights || {}
      };
      // Storage can be disabled or full; the chart must keep working without it.
      try { localStorage.setItem(HistoricalPriceChart.storageKey, JSON.stringify(state)); } catch (error) { /* ignore */ }
    };
    if (immediate) save(); else this.saveTimer = setTimeout(save, 250);
  }

  // ===== Data loading ==========================================================

  setLoading(loading) {
    this.state.loading = loading;
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
        const status = document.getElementById('data-status');
        if (status) status.textContent = 'The data could not be loaded: ' + error.message;
      }
    } finally {
      if (!this.destroyed && requestId === this.state.requestId) this.setLoading(false);
    }
  }

  // Rows from the data store ({ Data, EUR: 90.67 }) to { date, value }.
  parseData(values, currency) {
    return Array.from(values, row => ({ date: new Date(row.Data), value: +row[currency] }));
  }

  refreshIndicators() {
    if (this.destroyed) return;
    this.readIndicators();
    this.saveState();
    this.render();
  }

  showError(message) {
    let node = this.container.querySelector('[data-chart-error]');
    if (!node) { node=document.createElement('p'); node.dataset.chartError=''; node.setAttribute('role','status'); this.container.appendChild(node); }
    node.textContent=message;
  }

  // ===== Indicator series (formulas live in Indicators, above) =================

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
    const MAs = (c.mas || []).map(ma => ({ ...ma,
      data: memo(['ma', ma.type, ma.period], () => newestFirst(this.SwMA(ma.type, chrono, ma.period))) }));
    const bands = enabled.bband ? memo(['bb', c.N, c.K], () => {
      const result = newestFirst(Indicators.bollingerband(chrono, c.N, c.K));
      return { data: result, lower: result.map(d => d.low), upper: result.map(d => d.high) };
    }) : null;
    // MACD line, signal and histogram share one calculation and parameter key.
    const macd = enabled.macd || enabled.macdh ? memo(['macd', c.eshort, c.elong, c.esignal], () => {
      const result = Indicators.MACD(chrono, c.eshort, c.elong, c.esignal)[0];
      return { line: [newestFirst(result.macdline)], signal: [newestFirst(result.macdsignal)], histogram: [newestFirst(result.macdhist)] };
    }) : null;
    const stoch = enabled.stoch ? memo(['stoch', c.ST], () => {
      const result = Indicators.STOCH(chrono, c.ST);
      return { k: newestFirst(result.k), d: newestFirst(result.d) };
    }) : null;
    return {
      vdata: data, ddata: cache.ddata, min: cache.min, max: cache.max, enabled,
      BandData: bands ? bands.data : false, LowerBand: bands ? bands.lower : false, UpperBand: bands ? bands.upper : false,
      MAs,
      MacdLine: enabled.macd ? macd.line : false, MacdSignal: enabled.macd ? macd.signal : false,
      MacdHist: enabled.macdh ? macd.histogram : false,
      // Crossover markers need both MACD series even when only the histogram is drawn.
      MacdCross: macd ? { line: macd.line[0], signal: macd.signal[0] } : null,
      Roc: enabled.roc ? memo(['roc', c.RC], () => newestFirst(Indicators.ROC(chrono, c.RC).map(d => d.roc))) : false,
      Rsi: enabled.rsi ? memo(['rsi', c.RS], () => newestFirst(Indicators.RSI(chrono, c.RS).map(d => d.rsi))) : false,
      StochK: stoch ? stoch.k : false, StochD: stoch ? stoch.d : false
    };
  }

  // Moving average by its letter: S simple, E exponential, D double exponential.
  SwMA(v, ldata, rdata) {
    const average = { S: Indicators.SMA, E: Indicators.EMA, D: Indicators.DEMA }[v.toUpperCase()];
    return average ? average(ldata, rdata) : null;
  }

  // Moving average name for the legend.
  SwMALegend(v) {
    return { S: 'SMA', E: 'EMA', D: 'DEMA' }[v.toUpperCase()] || null;
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

  // ===== Rendering and layout ==================================================

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

  // Draws the chart in parts, in this order (the order of the SVG layers): frame and
  // axes, price panel, MACD panel, ROC / RSI / Stochastic panels, legends, crosshair,
  // trend lines and levels, info markers, crossover signals, panel dividers, zoom.
  // Each part returns what the zoom handler needs to update it.
  drawChart(values, currency) {
    this.drawingTrend = Boolean(this.trendDraft);
    const ctx = this.chartLayout(values, currency);
    this.drawFrame(ctx);
    const price = this.drawPricePanel(ctx);
    const macd = this.drawMacdPanel(ctx);
    const oscillators = this.drawOscillatorPanels(ctx);
    const legends = this.drawLegends(ctx);
    const hidePointer = this.drawCrosshair(ctx, legends);
    const { svg, ddata, vdata, x, y, plotLeft, plotRight, margin, height, padding, interval } = ctx;
    const priceBounds = { left: plotLeft, right: plotRight, top: margin.top, bottom: height - padding };
    // draw trendlines
    svg.append('g').attr('class', 'trend-viewport')
      .attr('clip-path', `url(#${this.priceClipId})`).append('g')
      .attr('class', 'trendlines');
    svg.select('.trend-viewport').insert('g', '.trendlines').attr('class', 'levels');
    svg.select('.trend-viewport').append('g').attr('class', 'trend-handles');
    this.bindTrendLines(svg, ddata, x, y, priceBounds, currency, interval);
    const updateInfoMarkers = this.drawInfoMarkers(svg, ddata, vdata, currency, interval, x, y, priceBounds);
    const updateSignals = this.drawSignals(ctx);
    this.drawPanelDividers(ctx);
    this.setupZoom(ctx, {
      panels: [price.update, macd.update, oscillators.update],
      afterAxes: [price.updateOverlay, updateSignals, () => this.updateTrendLines(), updateInfoMarkers],
      hidePointer
    });
  }

  // Layout, scales and everything the drawing parts share. Also publishes the
  // geometry and scales other features read (plotGeometry, panelGeometry, plotScales).
  chartLayout(values, currency) {
    const series = this.indicatorSeries(values);
    const interval = this.state.interval;
    const legends = this.legendEntries(series, currency, interval);
    const geometry = this.layoutGeometry(series, legends);
    const time = this.timeScale(series.ddata, geometry);
    const price = this.priceScale(series, geometry);
    this.plotGeometry = { x: time.baseRange.slice(), y: price.y.range().slice() };
    this.panelGeometry = [{ key: 'price', top: geometry.margin.top, bottom: geometry.height - geometry.padding }, ...geometry.panels];
    const scales = this.indicatorScales(series, geometry);
    const { macd, macdh, roc, rsi, stoch } = series.enabled;
    this.plotScales = { x: time.x, y: price.y, ...(macd || macdh ? { macd: scales.yMacd } : {}),
      ...(roc ? { roc: scales.yRoc } : {}), ...(rsi ? { rsi: scales.yRsi } : {}), ...(stoch ? { stoch: scales.yStoch } : {}) };
    const ctx = {
      chart: this, svg: this.svg, currency, interval, config: this.config,
      series, ...series, macd, macdh, roc, rsi, stoch, legends,
      ...geometry, ...time, ...price, ...scales,
      colors: this.chartColors(series),
      pointerFormat: value => Number.isFinite(value) ? d3.format(',')(this.roundn(value)) : '—',
      macdhbinsl: 1500, macdhbinsm: 900
    };
    this.addDrawingHelpers(ctx);
    return ctx;
  }

  // Legend entries of every panel: colour and text, for the latest values (no
  // argument) or for the date under the crosshair (a pointer snapshot).
  legendEntries(series, currency, interval) {
    const { vdata, ddata, MAs, UpperBand, LowerBand, MacdLine, MacdSignal, MacdHist, Roc, Rsi, StochK, StochD, enabled } = series;
    const roundn = this.roundn.bind(this), config = this.config;
    const intervalTag = interval == 'wave' ? '(W)' : (interval == 'mave' ? '(M)' : (interval == 'quave' ? '(Q)' : '(D)'));
    const pair = (currency === 'JPY' ? '100 JPY' : currency) + '/ALL';
    const at = (s, key, latest) => s ? s.values[key] : latest;
    const fmt = formatFxNumber;
    const latestNumber = value => d3.format(',')(roundn(value));
    const pointerNumber = value => Number.isFinite(value) ? d3.format(',')(roundn(value)) : '—';
    const legends = { price: [], macd: [], roc: [], rsi: [], stoch: [] };
    legends.price.push({ color: 'var(--c-price)',
      text: s => d3.timeFormat('%a, %d %b %Y')(s ? s.date : ddata[0]) + ', ' + pair + ': ' + fmt(at(s, 'vdata', vdata[0])) + ' ' + intervalTag });
    MAs.forEach((ma, i) => {
      if (isNaN(ma.data[0])) return;
      legends.price.push({ color: `var(--c-ma-${ma.slot + 1})`,
        text: s => this.SwMALegend(ma.type) + ma.period + ': ' + fmt(at(s, 'MA' + i, roundn(ma.data[0]))) });
    });
    if (!isNaN(UpperBand[0])) legends.price.push({ color: 'var(--c-band)', text: s => 'Upper Band: ' + fmt(at(s, 'UpperBand', UpperBand[0])) });
    if (!isNaN(LowerBand[0])) legends.price.push({ color: 'var(--c-band)', text: s => 'Lower Band: ' + fmt(at(s, 'LowerBand', LowerBand[0])) });
    const macdValue = (s, key, latest) => s ? pointerNumber(s.values[key]) : latestNumber(latest);
    if (enabled.macd) {
      legends.macd.push({ color: 'var(--c-macd)', text: s => 'MACD Line: ' + macdValue(s, 'MacdLine', MacdLine[0][0]) });
      legends.macd.push({ color: 'var(--c-signal)', text: s => 'MACD Signal: ' + macdValue(s, 'MacdSignal', MacdSignal[0][0]) });
    }
    if (enabled.macdh) legends.macd.push({ color: 'var(--c-hist-legend)', text: s => 'MACD Histogram: ' + macdValue(s, 'MacdHist', MacdHist[0][0]) });
    const index = s => s ? s.index : 0;
    if (enabled.roc) legends.roc.push({ color: 'var(--c-roc)', text: s => 'ROC: ' + pointerNumber(Roc[index(s)]) });
    if (enabled.rsi) legends.rsi.push({ color: 'var(--c-rsi)', text: s => 'RSI: ' + pointerNumber(Rsi[index(s)]) });
    if (enabled.stoch) legends.stoch.push({ color: 'var(--c-stoch-k)',
      text: s => 'Stoch' + config.ST + ' %K: ' + pointerNumber(StochK[index(s)]) + ', %D: ' + pointerNumber(StochD[index(s)]) });
    return legends;
  }

  // Legend entries flow left to right and wrap onto new rows when the chart is
  // narrow; the rows get their own space above each panel, so they never cover lines.
  layoutLegend(entries, width) {
    const probe = this.svg.append('g').attr('class', 'legend-row').attr('visibility', 'hidden');
    const text = probe.append('text');
    let x = 0, row = 0;
    const items = entries.map(entry => {
      // Room for a slightly longer value under the crosshair than the latest one.
      const w = text.text(entry.text()).node().getComputedTextLength() * 1.12 + 6;
      if (x > 0 && x + w > width) { x = 0; row++; }
      const item = { x, row };
      x += w + 14;
      return item;
    });
    probe.remove();
    return { items, rows: entries.length ? row + 1 : 0 };
  }

  // Sizes of the chart and the vertical position of every panel. By default the whole
  // chart fits the window: the price panel takes 3.5 parts, every indicator panel 1.
  // A panel whose height was set by dragging the line under it keeps that height;
  // the panels below simply move down (the chart grows) or up.
  layoutGeometry(series, legends) {
    const { macd, macdh, roc, rsi, stoch } = series.enabled;
    const minwidth = 300, padding = 10, rowHeight = 14, gap = 10, bottomSpace = 30;
    const minPrice = 140, minPanel = 45;
    // Keep the original margin for ordinary FX prices; allow large XAU labels
    // to show both decimal digits instead of clipping the final character.
    const right = Math.max(60, Math.max(formatFxNumber(series.min).length, formatFxNumber(series.max).length) * 6 + 14);
    const width = this.container.offsetWidth - right;
    const legendWidth = Math.max(120, width - 2 * padding);
    const legendLayout = {};
    for (const key of Object.keys(legends)) legendLayout[key] = this.layoutLegend(legends[key], legendWidth);
    const priceHeader = legendLayout.price.rows * rowHeight + 6;
    const margin = { top: priceHeader + 8, right, bottom: bottomSpace };
    // MACD stays first. Only ROC / RSI / Stochastic follow their selection order.
    const keys = [];
    const oscillatorPanels = (this.oscillatorOrder || ['roc', 'rsi'])
      .map(key => [key, { roc, rsi, stoch }[key]]);
    for (const [key, enabled] of [['macd', macd || macdh], ...oscillatorPanels]) if (enabled) keys.push(key);
    const header = key => legendLayout[key].rows * rowHeight + 4;
    // Total height: 65% of the window for the price alone, 12% more per indicator,
    // never more than the window.
    const vh = window.innerHeight;
    const total = Math.min(vh - 24, vh * (0.65 + 0.12 * keys.length));
    const fixed = margin.top + keys.reduce((sum, key) => sum + gap + header(key), 0) + padding + bottomSpace;
    const weight = key => key === 'price' ? 3.5 : 1;
    const totalWeight = weight('price') + keys.length;
    const free = Math.max(0, total - fixed);
    const heights = this.panelHeights || {};
    const plot = key => Math.max(key === 'price' ? minPrice : minPanel,
      Number.isFinite(heights[key]) && heights[key] > 0 ? Math.round(heights[key]) : Math.round(free * weight(key) / totalWeight));
    const priceBottom = margin.top + plot('price');
    const height = priceBottom + padding;
    const panels = [];
    let previous = priceBottom;
    for (const key of keys) {
      const headerTop = previous + gap, top = headerTop + header(key), bottom = top + plot(key);
      panels.push({ key, headerTop, top, bottom });
      previous = bottom;
    }
    const panelByKey = Object.fromEntries(panels.map(panel => [panel.key, panel]));
    const lowerBottom = panels.length ? previous : height - padding;
    const dateY = panels.length ? lowerBottom + padding : height;
    return { minwidth, margin, width, height, padding, panels, panelByKey, lowerBottom, dateY,
      legendLayout, rowHeight, minPrice, minPanel };
  }

  // Date scale and axis. One position per observation (weekends leave no gaps).
  timeScale(ddata, { minwidth, margin, width, padding, dateY }) {
    // The last point stops this far from the price axis, so markers and histogram
    // bars drawn on it stay whole.
    const chart = this, limdata = 50, axisGap = 12;
    let datalength = ddata.length,
      format = { monthly: d3.timeFormat('%b %Y'), daily: d3.timeFormat('%d %b %Y') },
      tformat = datalength < limdata ? format.daily : format.monthly;
    let x = d3.scalePoint()
      .domain(ddata)
      .range([width - axisGap, padding]);
    const baseRange = x.range().slice();
    this.zoomTransform = this.resizeZoom(baseRange);
    const plotLeft = Math.min(...baseRange), plotRight = Math.max(...baseRange);
    // Drawing is clipped to this wider band: from the left edge up to the price axis.
    const clipLeft = 0, clipRight = Math.max(width, plotRight);
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
    let xAxis = g => g
      .attr('transform', 'translate(0,' + dateY + ')')
      .call(d3.axisBottom(x)
        .tickSizeOuter(0)
        .tickValues(visibleTicks())
        .tickFormat(date => (datalength / (chart.zoomTransform?.k || 1) < limdata ? format.daily : tformat)(date)));
    const xrx = (_d, i) => x(ddata[i]);
    return { x, xAxis, xrx, baseRange, plotLeft, plotRight, clipLeft, clipRight, visibleTicks, datalength };
  }

  // Price scale and axis. Price-only bounds keep the scale stable when overlays are
  // toggled; vertical panning moves the domain without zooming it.
  priceScale(series, { margin, width, height, padding }) {
    const chart = this;
    let MinYScale = series.min,
      MaxYScale = series.max,
      PricePadding = MaxYScale > MinYScale
        ? (MaxYScale - MinYScale) * 0.08
        : Math.max(Math.abs(MinYScale) * 0.01, 0.01);
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
    return { y, yAxis, baseY, priceHeight, applyPricePan };
  }

  // Scales and axes of the MACD, ROC, RSI and Stochastic panels.
  indicatorScales(series, { width, height, panelByKey }) {
    const { MacdLine, MacdSignal, MacdHist, Roc } = series;
    const { macd, macdh, roc } = series.enabled;
    let MinSignal = macd == true ? d3.min(...MacdSignal) : false,
      MaxSignal = macd == true ? d3.max(...MacdSignal) : false,
      MinLine = macd == true ? d3.min(...MacdLine) : false,
      MaxLine = macd == true ? d3.max(...MacdLine) : false,
      MinHist = macdh == true ? (typeof d3.min(...MacdHist) !== 'undefined' ? d3.min(...MacdHist) : null) : false,
      MaxHist = macdh == true ? (typeof d3.max(...MacdHist) !== 'undefined' ? d3.max(...MacdHist) : null) : false,
      MinMacdY = MinLine < MinSignal ? (MinLine < MinHist ? MinLine : MinHist) : (MinSignal < MinHist ? MinSignal : MinHist),
      MaxMacdY = MaxLine > MaxSignal ? (MaxLine > MaxHist ? MaxLine : MaxHist) : (MaxSignal > MaxHist ? MaxSignal : MaxHist),
      MinRocY = roc == true ? (typeof d3.min(Roc) !== 'undefined' ? d3.min(Roc) : null) : false,
      MaxRocY = roc == true ? (typeof d3.max(Roc) !== 'undefined' ? d3.max(Roc) : null) : false;
    const rightAxis = (scale, ticks) => g => g
      .attr('transform', 'translate(' + width + ', 0)')
      .call(d3.axisRight(scale).ticks(ticks).tickSizeOuter(0));
    const panelRange = key => [panelByKey[key]?.bottom ?? height + 100, panelByKey[key]?.top ?? height];

    let yMacd = d3.scaleLinear()
      .domain([MinMacdY, MaxMacdY])
      .range(panelRange('macd'))
      .nice();
    let yRoc = d3.scaleLinear()
      .domain([MinRocY, MaxRocY])
      .range(panelRange('roc'))
      .nice();
    let yRsi = d3.scaleLinear()
      .domain([0, 100])
      .range(panelRange('rsi'))
      .nice();
    let yStoch = d3.scaleLinear()
      .domain([0, 100])
      .range(panelRange('stoch'));
    let ySTAxis = g => g
      .attr('transform', 'translate(' + width + ', 0)')
      .call(d3.axisRight(yStoch).tickValues([20, 50, 80]).tickSizeOuter(0));
    return {
      yMacd, yMAxis: rightAxis(yMacd, 3), yRoc, yRCAxis: rightAxis(yRoc, 3),
      yRsi, yRAxis: rightAxis(yRsi, 3), yStoch, ySTAxis
    };
  }

  // Line colours: CSS variables, so the dark theme changes them (css.css).
  // An empty colour marks a series that is not drawn.
  chartColors(series) {
    const { UpperBand, LowerBand, MacdLine, MacdSignal, MacdHist } = series;
    return {
      price: 'var(--c-price)',
      ma: series.MAs.map(ma => `var(--c-ma-${ma.slot + 1})`),
      band: UpperBand != 0 || LowerBand != 0 ? 'var(--c-band)' : '',
      macdLine: MacdLine != 0 ? 'var(--c-macd)' : '',
      macdSignal: MacdSignal != 0 ? 'var(--c-signal)' : '',
      histDown: MacdHist != 0 ? 'var(--c-hist-down)' : '',
      histUp: MacdHist != 0 ? 'var(--c-hist-up)' : '',
      roc: 'var(--c-roc)',
      rsi: 'var(--c-rsi)',
      stochK: 'var(--c-stoch-k)',
      stochD: 'var(--c-stoch-d)',
      signalUp: 'var(--c-signal-up)',
      signalDown: 'var(--c-signal-down)'
    };
  }

  // Small drawing helpers shared by the panels.
  addDrawingHelpers(ctx) {
    const { svg, x, ddata } = ctx;
    ctx.hrLines = [];
    // Horizontal reference line (zero, 30 / 70, 20 / 80) across the whole plot.
    ctx.hr = (value, yscale, className = 'ref-line', swd = 0.3) => {
      let dateRange = [d3.max(ddata), d3.min(ddata)];
      const xs = dateRange.map(date => x(date)); // full plot width, independent of zoom
      const path = svg.append('g')
        .attr('stroke-width', 0.3)
        .selectAll('path')
        .data([[value, value]])
        .join('path')
        .attr('class', className)
        .attr('stroke-width', swd);
      const place = () => path.attr('d', d3.line().x((_d, i) => xs[i]).y(() => yscale(value)));
      place();
      ctx.hrLines.push(place);
    };
  }

  // ===== Chart parts ===========================================================

  // SVG frame: size, price clip and the two main axes.
  drawFrame(ctx) {
    const { svg, clipLeft, clipRight, margin, width, height, padding, dateY, xAxis, yAxis } = ctx;
    svg
      // Cursor: a dot while the crosshair is on, the default arrow when it is off,
      // and a grabbing hand while the chart is dragged (see css.css).
      .classed('crosshair-on', Boolean(this.config.cross))
      .classed('panning', false)
      .attr('preserveAspectRatio', 'xMinYMin meet')
      .attr('viewBox', '0 0 ' + (width + margin.right) + ' ' + (dateY + margin.top));

    svg.append('defs').append('clipPath')
      .attr('id', this.priceClipId)
      .attr('clipPathUnits', 'userSpaceOnUse')
      .append('rect')
      .attr('x', clipLeft)
      .attr('y', margin.top)
      .attr('width', clipRight - clipLeft)
      .attr('height', Math.max(0, height - padding - margin.top));

    svg.append('g')
      .attr('class', 'date-axis')
      .call(xAxis)
      .attr('text-anchor', 'start');

    svg.append('g')
      .attr('class', 'price-axis')
      .call(yAxis);
  }

  // Price panel: grid, latest price, Bollinger area, Fibonacci, price and overlay lines.
  drawPricePanel(ctx) {
    const { svg, x, y, xrx, vdata, BandData, LowerBand, UpperBand, MAs, colors,
      margin, width, height, padding, plotLeft, plotRight, lowerBottom, visibleTicks, yAxis } = ctx;
    const bband = ctx.enabled.bband;

    let line = d3.line()
      .defined(Number.isFinite)
      .x(xrx)
      .y(y);

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
      .attr('stroke-width', 0.75).attr('stroke-dasharray', '2 3');
    const lastTag = lastPrice.append('g').attr('transform', 'translate(' + width + ',0)');
    lastTag.append('rect').attr('x', 1).attr('y', -9).attr('height', 18).attr('rx', 2)
      .attr('width', Math.max(0, margin.right - 2));
    lastTag.append('text').attr('x', 9).attr('dy', '0.32em').text(formatFxNumber(vdata[0]));
    const updateLastPrice = () => {
      const py = y(vdata[0]);
      lastPrice.attr('display', py >= margin.top && py <= height - padding ? null : 'none')
        .attr('transform', 'translate(0,' + py + ')');
    };

    // bollinger band area
    const bandArea = () => d3.area().x(xrx)
      .y0((_d, i) => y(BandData[i].high)).y1((_d, i) => y(BandData[i].low));
    if (bband) {
      svg.append('g')
        .attr('class', 'abbc')
        .attr('clip-path', `url(#${this.priceClipId})`)
        .selectAll('path')
        .data([BandData])
        .join('path')
        .attr('d', bandArea());
    }

    // Automatic Fibonacci retracement of the visible part of the chart.
    const updateFib = this.drawAutoFibonacci(ctx);

    svg.append('g')
      .attr('fill', 'none')
      .attr('class', 'dline')
      .attr('clip-path', `url(#${this.priceClipId})`)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')
      .attr('stroke-width', 1)
      .selectAll('path')
      .data([vdata, ...MAs.map(ma => ma.data), LowerBand, UpperBand])
      .join('path')
      .style('stroke', (_d, i) => [colors.price, ...colors.ma, colors.band, colors.band][i])
      .attr('d', line);

    return {
      // Lines that follow the price scale; called after the price pan is applied.
      update: () => {
        svg.select('.price-axis').call(yAxis);
        svg.select('.dline').selectAll('path').attr('d', line);
        svg.select('.abbc').selectAll('path').attr('d', bandArea());
      },
      updateOverlay: () => { drawGrid(); updateLastPrice(); updateFib(); }
    };
  }

  // Automatic Fibonacci retracement (button "Fib"): from the highest and lowest close
  // in the visible range; 0% on whichever came last. Redrawn on zoom and pan.
  drawAutoFibonacci(ctx) {
    const { svg, x, y, vdata, plotLeft, plotRight, datalength, config } = ctx;
    if (!config.fib) return () => {};
    const layer = svg.append('g').attr('class', 'fib-auto')
      .attr('clip-path', `url(#${this.priceClipId})`).attr('pointer-events', 'none');
    return () => {
      const range = x.range(), last = datalength - 1;
      let low = 0, high = last;
      if (last > 0) {
        const step = (range[1] - range[0]) / last;
        const a = (plotLeft - range[0]) / step, b = (plotRight - range[0]) / step;
        low = Math.max(0, Math.ceil(Math.min(a, b) - 1e-9));
        high = Math.min(last, Math.floor(Math.max(a, b) + 1e-9));
      }
      let iMax = -1, iMin = -1;
      for (let i = low; i <= high; i++) {
        if (!Number.isFinite(vdata[i])) continue;
        if (iMax < 0 || vdata[i] > vdata[iMax]) iMax = i;
        if (iMin < 0 || vdata[i] < vdata[iMin]) iMin = i;
      }
      // Index 0 is the newest point: a smaller index came later.
      const levels = iMax < 0 || vdata[iMax] === vdata[iMin] ? [] : FIB_LEVELS.map(ratio => {
        const top = vdata[iMax], bottom = vdata[iMin];
        return { ratio, price: iMax < iMin ? top - (top - bottom) * ratio : bottom + (top - bottom) * ratio };
      });
      const rows = layer.selectAll('g.fib-level').data(levels, level => level.ratio).join(enter => {
        const row = enter.append('g').attr('class', 'fib-level');
        row.append('line').attr('class', 'fib-line');
        row.append('text').attr('class', 'fib-label').attr('text-anchor', 'end').attr('dy', -3);
        return row;
      }).attr('transform', level => 'translate(0,' + y(level.price) + ')');
      rows.select('line').attr('x1', plotLeft).attr('x2', plotRight);
      rows.select('text').attr('x', plotRight - 4).text(level => fibLabel(level.ratio, level.price));
    };
  }

  // MACD panel: histogram, MACD and signal lines, zero line.
  drawMacdPanel(ctx) {
    const { svg, xrx, yMacd, yMAxis, MacdLine, MacdSignal, MacdHist, macd, macdh, colors,
      datalength, macdhbinsl, macdhbinsm } = ctx;
    if (!(macd || macdh)) return { update: () => {} };
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
        .style('fill', d => d > 0 ? colors.histUp : colors.histDown);
    }

    const macdLine = () => d3.line().defined(Number.isFinite).x(xrx).y(yMacd);
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
        .style('stroke', (_d, i) => [colors.macdLine, colors.macdSignal][i])
        .attr('d', macdLine());
    }

    ctx.hr(0, yMacd);

    return {
      update: () => {
        svg.select('.zoom-macd').selectAll('path').attr('d', macdLine());
        // Bar width follows the spacing between points (never thinner than the
        // original bins), so zooming in widens the bars instead of leaving lines.
        const { x, ddata } = ctx;
        const histStep = datalength > 1 ? Math.abs(x(ddata[1]) - x(ddata[0])) : 0;
        const histWidth = Math.max(datalength > macdhbinsl ? 0.5 : (datalength > macdhbinsm ? 1 : 1.5), Math.min(histStep * 0.7, 14));
        svg.select('.zoom-histogram').selectAll('rect').attr('transform', null)
          .attr('width', histWidth).attr('x', (d, i) => xrx(d, i) - histWidth / 2)
          .attr('y', d => d > 0 ? yMacd(d) : yMacd(0))
          .attr('height', d => Math.abs(yMacd(d) - yMacd(0)));
        svg.select('.macd-axis').call(yMAxis);
      }
    };
  }

  // ROC, RSI and Stochastic panels, each with its reference lines.
  drawOscillatorPanels(ctx) {
    const { svg, xrx, yRoc, yRCAxis, yRsi, yRAxis, yStoch, ySTAxis, Roc, Rsi, StochK, StochD,
      roc, rsi, stoch, colors } = ctx;
    const oscLine = scale => d3.line().defined(Number.isFinite).x(xrx).y(scale);
    const draw = (key, scale, axis, data, strokes) => {
      svg.append('g')
        .attr('class', key + '-axis')
        .call(axis);
      svg.append('g')
        .attr('class', 'zoom-' + key)
        .attr('fill', 'none')
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round')
        .attr('stroke-width', 1)
        .selectAll('path')
        .data(data)
        .join('path')
        .style('stroke', (_d, i) => strokes[i])
        .attr('d', oscLine(scale));
    };
    // ROC
    if (roc) {
      draw('roc', yRoc, yRCAxis, [Roc], [colors.roc]);
      ctx.hr(0, yRoc, 'ref-line roc-zero');
    }
    // RSI
    if (rsi) {
      draw('rsi', yRsi, yRAxis, [Rsi], [colors.rsi]);
      ctx.hr(30, yRsi);
      ctx.hr(70, yRsi);
    }
    // Stochastic (closing prices only: the source has no high / low).
    if (stoch) {
      draw('stoch', yStoch, ySTAxis, [StochK, StochD], [colors.stochK, colors.stochD]);
      ctx.hr(20, yStoch);
      ctx.hr(80, yStoch);
    }
    return {
      update: () => {
        svg.select('.zoom-roc').selectAll('path').attr('d', oscLine(yRoc));
        svg.select('.zoom-rsi').selectAll('path').attr('d', oscLine(yRsi));
        svg.select('.zoom-stoch').selectAll('path').attr('d', oscLine(yStoch));
        svg.select('.roc-axis').call(yRCAxis);
      }
    };
  }

  // Legends of all panels, in the rows reserved for them by layoutGeometry.
  // Returns one { reset, show } per panel for the crosshair.
  drawLegends(ctx) {
    const { svg, legends, legendLayout, panels, padding, rowHeight } = ctx;
    const tops = { price: 4, ...Object.fromEntries(panels.map(panel => [panel.key, panel.headerTop])) };
    const result = [];
    for (const key of ['price', ...panels.map(panel => panel.key)]) {
      const entries = legends[key], layout = legendLayout[key];
      if (!entries?.length) continue;
      const texts = svg.append('g')
        .attr('class', 'legend-row legend-' + key)
        .attr('transform', 'translate(' + padding + ',' + tops[key] + ')')
        .selectAll('text').data(entries).join('text')
        .attr('x', (_d, i) => layout.items[i].x)
        .attr('y', (_d, i) => layout.items[i].row * rowHeight + 11)
        .style('fill', entry => entry.color)
        .text(entry => entry.text());
      result.push({
        reset: () => texts.text(entry => entry.text()),
        show: snapshot => texts.text(entry => entry.text(snapshot))
      });
    }
    return result;
  }

  // Crosshair: lines, tags on the axes, pointer hit areas and the legends it drives.
  // Returns hidePointer().
  drawCrosshair(ctx, legends) {
    const chart = this;
    const { svg, x, y, yMacd, yRoc, yRsi, yStoch, ddata, vdata, MAs, UpperBand, LowerBand,
      MacdLine, MacdSignal, MacdHist, Roc, Rsi, StochK, StochD, macd, macdh, interval,
      margin, width, padding, panels, plotLeft, plotRight, lowerBottom, dateY, pointerFormat } = ctx;
    const roundx = this.roundx.bind(this);
    let crssh = svg.append('g').attr('class', 'chart-crosshair').attr('pointer-events', 'none'),
      crosshair = crssh.append('g')
        .attr('stroke-width', 0.5);

    // The value goes on the price axis and the date on the date axis,
    // so nothing is drawn next to (or under) the cursor or the finger.
    const axisTag = (width, anchor) => {
      const tag = crssh.append('g').attr('class', 'axis-tag').style('display', 'none');
      tag.append('rect').attr('height', 18).attr('rx', 2).attr('y', anchor);
      tag.append('text').attr('dy', '0.32em').attr('y', anchor + 9);
      return tag;
    };
    const axisY = axisTag(0, -9), axisX = axisTag(0, 3);
    axisY.select('rect').attr('x', 1).attr('width', Math.max(0, margin.right - 2));
    axisY.select('text').attr('x', 9);
    axisX.select('rect').attr('x', -40).attr('width', 80);
    axisX.select('text').attr('text-anchor', 'middle');
    const axisDate = d3.timeFormat(interval === 'mave' || interval === 'quave' ? '%b %Y' : '%d %b %Y');

    // vertical line
    crosshair.append('line')
      .attr('id', 'crsx');

    // horizontal line
    crosshair.append('line')
      .attr('id', 'crsy');

    // grid
    svg.append('rect')
      .attr('class', 'grid')
      .attr('fill', 'none')
      .attr('pointer-events', 'all')
      .attr('x', padding)
      .attr('y', margin.top)
      .attr('width', x.range()[0] - padding)
      .attr('height', y.range()[0] - margin.top);

    // One hit area per indicator panel; all panels share the same date pointer.
    for (const panel of panels) {
      svg.append('rect')
        .attr('class', panel.key === 'macd' ? 'macdgrid' : 'rsrcgrid ' + panel.key + 'grid')
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
      axisY.style('display', 'none');
      axisX.style('display', 'none');
      legends.forEach(legend => legend.reset());
    }
    const pointerSeries = {
      vdata, ...Object.fromEntries(MAs.map((ma, i) => ['MA' + i, ma.data])), UpperBand, LowerBand,
      MacdLine: macd ? MacdLine[0] : null,
      MacdSignal: macd ? MacdSignal[0] : null,
      MacdHist: macdh ? MacdHist[0] : null, Roc, Rsi, StochK, StochD
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

      // Value at the pointer height, used where no series has a value.
      function linelabel() {
        let fd = d3.format(',');
        switch (panel) {
          case 'roc': return roundx(yRoc.invert(yval));
          case 'rsi': return roundx(yRsi.invert(yval));
          case 'stoch': return roundx(Math.max(0, Math.min(100, yStoch.invert(yval))));
          case 'macd': return fd(roundx(yMacd.invert(yval)));
          default: return d3.format(',.2f')(y.invert(yval));
        }
      }

      // vertical line
      crosshair.select('#crsx')
        .attr('x1', xval)
        .attr('y1', margin.top)
        .attr('x2', xval)
        .attr('y2', lowerBottom);

      // Like the vertical line snaps to the date, the horizontal line snaps to a
      // series value at that date. In panels with several lines (MACD line, signal,
      // histogram; Stochastic %K, %D; price and its overlays) it takes the one
      // closest to the pointer.
      // Where no series has a value (an indicator still warming up) it keeps the
      // pointer's own height.
      const oscillator = value => d3.format(',')(roundx(value));
      const candidates = ({
        // Price plus every overlay that is drawn (moving averages, Bollinger bands).
        price: [yVonx.vdata, ...MAs.map((_ma, i) => yVonx['MA' + i]),
          yVonx.UpperBand, yVonx.LowerBand].map(value => [value, y, formatFxNumber]),
        macd: [[macd ? yVonx.MacdLine : null, yMacd, pointerFormat],
            [macd ? yVonx.MacdSignal : null, yMacd, pointerFormat],
            [macdh ? yVonx.MacdHist : null, yMacd, pointerFormat]],
        roc: [[yVonx.Roc, yRoc, oscillator]],
        rsi: [[yVonx.Rsi, yRsi, oscillator]],
        stoch: [[yVonx.StochK, yStoch, oscillator], [yVonx.StochD, yStoch, oscillator]]
      })[panel] || [];
      let target = null, distance = Infinity;
      for (const candidate of candidates) {
        if (!Number.isFinite(candidate[0])) continue;
        const gap = Math.abs(candidate[1](candidate[0]) - yval);
        if (gap < distance) { distance = gap; target = candidate; }
      }
      const snapped = target !== null;
      const panelBox = chart.panelGeometry.find(item => item.key === panel);
      const lineY = snapped ? Math.max(panelBox.top, Math.min(panelBox.bottom, target[1](target[0]))) : yval;
      const valueText = snapped ? target[2](target[0]) : linelabel();

      // horizontal line
      crosshair.select('#crsy')
        .attr('x1', plotLeft)
        .attr('y1', lineY)
        .attr('x2', plotRight)
        .attr('y2', lineY);

      axisY.style('display', null)
        .attr('transform', 'translate(' + width + ',' + lineY + ')')
        .select('text').text(valueText);
      axisX.style('display', null)
        .attr('transform', 'translate(' + Math.max(39, Math.min(width + margin.right - 39, xval)) + ',' + dateY + ')')
        .select('text').text(axisDate(snapshot.date));

      legends.forEach(legend => legend.show(snapshot));
    }
    hidePointer();
    this.bindChartPointer(svg, paintPointer, hidePointer);
    return hidePointer;
  }

  // Crossover signals. With two or more moving averages the first two are
  // compared (shorter period = fast line); with one, price against it.
  // Returns the function that places them after zoom.
  drawSignals(ctx) {
    const chart = this;
    const { svg, x, y, yMacd, ddata, vdata, MAs, MacdCross, macd, macdh,
      config, colors, margin, height, padding, plotLeft, plotRight, panelByKey } = ctx;
    let updateSignals = () => {};
    if (config.signals) {
      const averages = MAs.map(ma => [ma.data, ma.period])
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
        .style('fill', mark => mark.up ? colors.signalUp : colors.signalDown)
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
      .append('rect').attr('x', ctx.clipLeft).attr('y', top).attr('width', ctx.clipRight - ctx.clipLeft).attr('height', Math.max(0, bottom - top));
    markClip('', margin.top, height - padding);
    if (panelByKey.macd) markClip('-macd', panelByKey.macd.top, panelByKey.macd.bottom);
    return updateSignals;
  }

  // The line under every panel (also under the last one, above the dates) can be
  // dragged: only that panel changes height, the panels below move with it.
  // Double-click gives every panel its default height again.
  drawPanelDividers(ctx) {
    const chart = this;
    const { svg, panels, margin, height, padding, plotLeft, plotRight, minPrice, minPanel, dateY } = ctx;
    const areas = [{ key: 'price', top: margin.top, bottom: height - padding }, ...panels];
    const layer = svg.append('g').attr('class', 'panel-dividers');
    const guide = layer.append('line').attr('class', 'panel-divider-guide')
      .attr('x1', plotLeft).attr('x2', plotRight).attr('display', 'none');
    areas.forEach((area, i) => {
      // From the bottom of this panel to the top of the next one (its legend included),
      // or to the date axis under the last panel.
      const next = areas[i + 1];
      const below = next ? next.headerTop ?? next.top : dateY;
      const minimum = area.key === 'price' ? minPrice : minPanel;
      let drag = null;
      layer.append('rect').attr('class', 'panel-divider')
        .attr('x', plotLeft).attr('width', plotRight - plotLeft)
        .attr('y', area.bottom).attr('height', Math.max(8, below - area.bottom))
        .attr('fill', 'transparent').style('touch-action', 'none')
        .on('pointerdown.divider', function (event) {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          drag = { y: event.clientY, pointerId: event.pointerId, delta: 0 };
          this.setPointerCapture?.(event.pointerId);
          chart.hideCrosshair?.();
        })
        .on('pointermove.divider', event => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          // Screen pixels to chart units (the SVG is scaled to the article width).
          const scale = svg.node().viewBox.baseVal.width / svg.node().getBoundingClientRect().width || 1;
          drag.delta = Math.max(minimum - (area.bottom - area.top), (event.clientY - drag.y) * scale);
          guide.attr('display', null).attr('y1', area.bottom + drag.delta).attr('y2', area.bottom + drag.delta);
        })
        .on('pointerup.divider pointercancel.divider', event => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          const delta = drag.delta;
          drag = null;
          guide.attr('display', 'none');
          if (event.type === 'pointercancel' || Math.abs(delta) < 1) return;
          chart.panelHeights = { ...chart.panelHeights, [area.key]: Math.round(area.bottom - area.top + delta) };
          chart.saveState();
          chart.render();
        })
        .on('mousedown.divider touchstart.divider click.divider', event => event.stopPropagation())
        .on('dblclick.divider', event => {
          event.preventDefault(); event.stopPropagation();
          chart.panelHeights = {};
          chart.saveState();
          chart.render();
        });
    });
  }

  // Zoom and pan. Only geometry is updated during gestures; indicator values stay
  // calculated from the loaded history, so zoom does not restart their warm-up.
  setupZoom(ctx, { panels: panelUpdates, afterAxes, hidePointer }) {
    const chart = this;
    const { svg, x, y, baseY, baseRange, ddata, vdata, MAs, UpperBand, LowerBand,
      MacdLine, MacdSignal, MacdHist, Roc, macd, macdh, roc, yMacd, yRoc, datalength,
      margin, height, padding, panels, plotLeft, plotRight, priceHeight, applyPricePan, xAxis } = ctx;
    for (const panel of panels) {
      const clipId = this.priceClipId + '-' + panel.key;
      svg.select('defs').append('clipPath').attr('id', clipId)
        // 2px of room on each side: a line resting exactly on a limit (closing-price
        // Stochastic often sits on 0 or 100) is not cut in half by the clip.
        .append('rect').attr('x', ctx.clipLeft).attr('y', panel.top - 2)
        .attr('width', ctx.clipRight - ctx.clipLeft).attr('height', panel.bottom - panel.top + 4);
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
      const visiblePlotted = extentOf([vdata, ...MAs.map(ma => ma.data), UpperBand, LowerBand], low, high);
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
      panelUpdates.forEach(update => update());
      ctx.hrLines.forEach(place => place());
      svg.select('.date-axis').call(xAxis).select('.domain')
        .attr('d', `M${plotLeft},0.5H${plotRight}`);
      afterAxes.forEach(update => update());
      hidePointer();
    };
    this.zoomBehavior = d3.zoom().extent(extent).scaleExtent([1, maxZoom])
      .constrain(constrain)
      .filter(event => !chart.drawingTrend && !chart.trendEdit && !event.altKey &&
        (!event.button || event.type === 'wheel') &&
        (event.type !== 'wheel' || event.ctrlKey || event.metaKey) &&
        !event.target.closest?.('.trend, .trend-hit, .trend-handle, .info-marker, .level-hit') &&
        (event.type !== 'touchstart' || event.touches.length >= 2) && (() => {
          const points = event.touches ? d3.pointers(event.touches, svg.node()) : [d3.pointer(event, svg.node())];
          return points.every(([px, py]) => px >= plotLeft && px <= plotRight &&
            chart.panelGeometry.some(panel => py >= panel.top && py <= panel.bottom));
        })())
      .on('start', event => {
        chart.zooming = true; hidePointer();
        if (event.sourceEvent?.type === 'mousedown') svg.classed('panning', true);
        const point = gesturePoint(event.sourceEvent);
        panGesture = point && ['mousedown', 'touchstart'].includes(event.sourceEvent?.type) &&
          point[1] >= margin.top && point[1] <= height - padding
          ? { py: point[1], offset: chart.pricePan, count: event.sourceEvent.touches?.length || 1, active: false } : null;
      })
      .on('zoom', updateZoom)
      .on('end', () => { chart.zooming = false; panGesture = null; svg.classed('panning', false); });
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

  // ===== Pointer and crosshair input ===========================================

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
    const blocked = event => event.target?.closest?.('.info-marker, .trend, .trend-hit, .trend-handle, .level-hit');
    this.hideCrosshair = hide;
    svg.on('pointerenter.inspect pointermove.inspect pointerdown.inspect', event => {
      chart.pointerType = event.pointerType;
      if (!chart.config.cross) return; // button off: nothing is drawn (already hidden by render())
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

  // ===== Trend lines and horizontal levels =====================================

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
        .attr('aria-label', 'Përzgjidh vijën e trendit për të lëvizur skajet ose për ta fshirë me Delete')
        .attr('stroke-linecap', 'round').attr('vector-effect', 'non-scaling-stroke')
        .attr('d', trend => line(this.projectTrend(trend, x, y)));
      svg.select('.trendlines').selectAll('path').style('cursor', 'pointer')
        .on('pointerdown.trends mousedown.trends touchstart.trends', event => {
          if (!chart.drawingTrend) event.stopPropagation();
        })
        .on('click.trends', (event, trend) => {
          if (chart.drawingTrend || chart.trendEdit || chart.state.loading) return;
          event.stopPropagation();
          chart.selectedTrendId = trend.id; chart.selectedLevelId = null; // Delete / Backspace removes it
          redraw();
        }).on('keydown.trends', (event, trend) => {
          if (!['Enter', ' '].includes(event.key) || chart.drawingTrend || chart.trendEdit || chart.state.loading) return;
          event.preventDefault(); event.stopPropagation();
          chart.selectedTrendId = trend.id; chart.selectedLevelId = null; redraw();
        });
      // Drawn Fibonacci: levels from the first point to the right edge; 0% at the
      // second point, 100% at the first. Selected, moved and deleted like a line.
      const fibs = svg.select('.trendlines').selectAll('g.fib-drawn')
        .data(lines.filter(trend => trend.kind === 'fib'), trend => trend.id)
        .join(enter => enter.insert('g', ':first-child').attr('class', 'fib-drawn').attr('pointer-events', 'none'));
      fibs.each(function (trend) {
        const [[x1], [x2]] = chart.projectTrend(trend, x, y);
        const left = Math.min(x1, x2), from = trend.end.price, span = trend.end.price - trend.start.price;
        const rows = d3.select(this).selectAll('g.fib-level').data(FIB_LEVELS).join(enter => {
          const row = enter.append('g').attr('class', 'fib-level');
          row.append('line').attr('class', 'fib-line');
          row.append('text').attr('class', 'fib-label').attr('dy', -3);
          return row;
        }).attr('transform', ratio => 'translate(0,' + y(from - span * ratio) + ')');
        rows.select('line').attr('x1', left).attr('x2', bounds.right);
        rows.select('text').attr('x', left + 4).text(ratio => fibLabel(ratio, from - span * ratio));
      });
      svg.select('.trendlines').selectAll('path.trend')
        .attr('stroke-dasharray', trend => trend.kind === 'fib' ? '4 3' : null)
        // Thin while idle, thicker when selected; always grey, never the blue of the price line.
        .attr('stroke-width', trend => trend.id === chart.selectedTrendId ? 2 : (trend.kind === 'fib' ? 1 : 1.25));
      const selected = chart.drawingTrend ? null : lines.find(trend => trend.id === chart.selectedTrendId);
      const data = selected ? ['start','end'].map(key => ({ trend: selected, key })) : [];
      const handles = svg.select('.trend-handles').selectAll('g.trend-handle')
        .data(data, handle => `${handle.trend.id}-${handle.key}`).join(enter => {
          const group = enter.append('g').attr('class', 'trend-handle');
          group.append('circle').attr('r', 16).attr('fill', 'transparent');
          group.append('circle').attr('class', 'handle-dot').attr('r', 6).attr('stroke-width', 2);
          return group;
        }).attr('tabindex', 0).attr('role', 'button').style('cursor', 'move').style('touch-action', 'none')
        .attr('aria-label', handle => `${handle.key === 'start' ? 'Fillimi' : 'Fundi'} i vijës: ${new Date(handle.trend[handle.key].date).toISOString().slice(0, 10)}, ${handle.trend[handle.key].price.toFixed(2)}. Lëvize me shigjetat.`)
        .attr('transform', handle => `translate(${x(handle.trend[handle.key].date)},${y(handle.trend[handle.key].price)})`)
        .attr('display', handle => {
          const point = handle.trend[handle.key], px = x(point.date), py = y(point.price);
          return px >= bounds.left && px <= bounds.right && py >= bounds.top && py <= bounds.bottom ? null : 'none';
        });
      chart.bindTrendHandles(handles, svg, dates, x, y, bounds);
      // Horizontal levels: Shift+click adds one. Click selects it (drawn thicker),
      // dragging moves it up or down only, Delete / Backspace removes it.
      const levels = svg.select('.levels').selectAll('g.level')
        .data(chart.levels.filter(level => level.currency === currency), level => level.id).join(enter => {
          const group = enter.append('g').attr('class', 'level');
          group.append('line').attr('class', 'level-line');
          group.append('line').attr('class', 'level-hit').attr('stroke', 'transparent')
            .attr('stroke-width', 14).attr('pointer-events', 'stroke')
            .attr('tabindex', 0).attr('role', 'button')
            .style('cursor', 'pointer').style('touch-action', 'none');
          group.append('text').attr('class', 'level-label').attr('text-anchor', 'end').attr('dy', -4);
          return group;
        }).classed('selected', level => level.id === chart.selectedLevelId)
        .attr('transform', level => `translate(0,${y(level.price)})`)
        .attr('display', level => y(level.price) >= bounds.top && y(level.price) <= bounds.bottom ? null : 'none');
      levels.selectAll('line').attr('x1', bounds.left).attr('x2', bounds.right);
      levels.select('.level-label').attr('x', bounds.right - 4).text(level => formatFxNumber(level.price));
      const moveLevel = (level, py) => {
        const price = y.invert(Math.max(bounds.top, Math.min(bounds.bottom, py)));
        if (Number.isFinite(price)) { level.price = Math.round(price * 100) / 100; redraw(); }
      };
      levels.select('.level-hit')
        .attr('aria-label', level => 'Niveli ' + formatFxNumber(level.price) + '. Lëvize me shigjetat lart / poshtë, fshije me Delete.')
        .on('pointerdown.levels', function (event, level) {
          event.stopPropagation();
          if (event.button !== 0 || chart.state.loading || chart.drawingTrend || chart.trendEdit) return;
          event.preventDefault();
          chart.selectedLevelId = level.id; chart.selectedTrendId = null;
          chart.levelDrag = { id: level.id, pointerId: event.pointerId };
          svg.classed('panning', true); // same closed hand as when the chart is dragged
          this.setPointerCapture?.(event.pointerId);
          this.focus?.({ preventScroll: true });
          redraw();
        })
        .on('pointermove.levels', (event, level) => {
          if (chart.levelDrag?.id !== level.id || chart.levelDrag.pointerId !== event.pointerId) return;
          event.preventDefault(); event.stopPropagation();
          moveLevel(level, d3.pointer(event, svg.node())[1]);
        })
        .on('pointerup.levels pointercancel.levels lostpointercapture.levels', (event, level) => {
          if (chart.levelDrag?.id !== level.id) return;
          chart.levelDrag = null;
          svg.classed('panning', false);
          redraw();
        })
        .on('mousedown.levels touchstart.levels click.levels dblclick.levels', event => event.stopPropagation())
        .on('keydown.levels', (event, level) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault(); event.stopPropagation();
          chart.selectedLevelId = level.id; chart.selectedTrendId = null;
          moveLevel(level, y(level.price) + (event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 10 : 1));
        });
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
      // Alt (Option) + secondary click draws a Fibonacci retracement instead of a line.
      chart.trendDraft = { id: ++chart.nextTrendId, currency, interval, ...(event.altKey ? { kind: 'fib' } : {}),
        start: point, end: { ...point } };
      chart.selectedTrendId = null; chart.selectedLevelId = null;
      chart.drawingTrend = true;
      redraw();
    }).on('mousemove.trends', event => {
      if (!chart.trendDraft || chart.state.loading) return;
      const [px, py] = d3.pointer(event, svg.node());
      const point = chart.trendPoint(px, py, dates, x, y, bounds, true);
      if (point) { chart.trendDraft.end = point; redraw(); }
    }).on('click.trends', event => {
      if (chart.state.loading || chart.trendEdit || (event.altKey && !chart.trendDraft)) return;
      if (!chart.trendDraft) {
        if (event.shiftKey) {
          const [lx, ly] = d3.pointer(event, svg.node());
          const level = chart.trendPoint(lx, ly, dates, x, y, bounds);
          if (level) chart.levels.push({ id: ++chart.nextTrendId, currency, price: Math.round(level.price * 100) / 100 });
        }
        chart.selectedTrendId = null; chart.selectedLevelId = null; redraw(); return;
      }
      const [px, py] = d3.pointer(event, svg.node());
      const point = chart.trendPoint(px, py, dates, x, y, bounds);
      if (!point) return;
      chart.trendDraft.end = point;
      chart.trendLines.push(chart.trendDraft);
      chart.selectedTrendId = chart.trendDraft.id; chart.selectedLevelId = null;
      chart.trendDraft = null;
      chart.drawingTrend = false;
      redraw();
    });
    redraw();
  }

  // ===== Information events (data/events.json) =================================

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
    markers.append('circle').attr('class', 'marker-dot').attr('r', 10);
    markers.append('text').text('I').attr('text-anchor', 'middle').attr('dy', '0.35em')
      .style('font-size', '12px').style('font-weight', 'bold');
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

  // ===== Currency converter ====================================================

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

  // ===== Formatting ============================================================

  // Rounding for display: two decimals, one decimal.
  roundn(number) {
    return Math.round((number + Number.EPSILON) * 100) / 100;
  }

  roundx(number) {
    return Math.round((number + Number.EPSILON) * 10) / 10;
  }
}
// Saved settings (localStorage) and the controls they cover.
HistoricalPriceChart.storageKey = 'fxchart.v1';
HistoricalPriceChart.maxAverages = 10;
HistoricalPriceChart.textControls = ['bb_N','bb_K','macd_fast','macd_slow','macd_signal','roc_values','rsi_values','stoch_values'];
HistoricalPriceChart.checkControls = ['bband','macd','macdh','roc','rsi','stoch','signals','crosshair','fib'];

// ===== Start-up ================================================================
window.HistoricalPriceChart = HistoricalPriceChart;
const startChart = () => {
  window.historicalPriceChart?.destroy();
  window.historicalPriceChart = new HistoricalPriceChart();
};
// Used by index.html: the converter field calls cqu() on Enter.
window.cqu = () => window.historicalPriceChart?.convertOrQuote();
window.updatechart = () => window.historicalPriceChart?.reloadData();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startChart, { once: true });
else startChart();
