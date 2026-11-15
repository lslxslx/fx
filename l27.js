// GitHub Pages adaptation: JSON files in ./data/, no backend required.
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
  return {query,convert,load};
})();

// (C) luislamani, 112020.112022.324

// global
let nxloading = '\u2026',
    nxupdate = '\u21BB',
    nxloadc = '\u2192';

// match moving average input
function mxi(e) {
    // S - simple moving average; E - exponential moving average; D - double exponential moving average
    let clean = e.value.match(/^([SED]{1})(?!(0))(\d*)$/gi);
    // don't move cursor to end if no change
    if (clean !== e.value) e.value = clean;
}
// match bollinger / macd-h rsi /roc input
function maxi(e) {
    let clean = e.value.match(/^(?!(0))(\d{1,3})$/gi);
    if (clean !== e.value) e.value = clean;
}

document.querySelectorAll('#overlays input[type=text], #indicators input[type=text]').forEach((et) => {
    et.addEventListener('input', () => {
        if (et.id == 'ma_a' || et.id == 'ma_b' || et.id == 'ma_c' || et.id == 'ma_d') {
            mxi(et);
        }
        else {
            maxi(et);
        }
    })
});

// match date input, update date from interval
// function dx(e) {
//     // e.value = e.value.match(/^([0-9.])*$/g);
//     let dt = new Date(),
//         year = dt.getFullYear(),
//         month = dt.getMonth(),
//         day = dt.getDate();
//     return new Date(year - e, month, day).toISOString().split('T')[0];
// }
// document.querySelectorAll('input[name=interval]').forEach((e) => {
//     e.addEventListener('click', () => {
//         document.getElementById('start').value = e.value == 'wave' ? dx(5) : (e.value == 'mave' ? dx(20) : dx(1));
//     })
// });

// update chart from panel and close menu function
let isRunning = false,
    cpx = document.getElementById('cpanel'),
    selectix = cpx.querySelector('select');
cpx.querySelectorAll('input[type=radio], input[type=checkbox], input[type=date], input[type=text]').forEach((targetDetail) => {
    targetDetail.addEventListener('click', () => {
        if (!isRunning) {
            if (targetDetail.type == 'checkbox') {
                updatechart();
            }
            if (targetDetail.type == 'radio') {
                switchintervalix(targetDetail.value, selectix);
                updatechart();
                closemenu();
            }
        }
    });
    targetDetail.addEventListener('change', () => {
        if (targetDetail.id == 'start') {
            targetDetail.value ? selectix.disabled = true : selectix.disabled = false;
            targetDetail.value ? selectix.style.textDecoration = 'line-through' : selectix.style.textDecoration = 'unset';
        }
    });
    targetDetail.addEventListener('keydown', (e) => {
        if (e.key == 'Enter') {
            if (!isRunning) {
                closemenu();
                updatechart();
            }
        }
    });
});
selectix.addEventListener('change', () => {
    if (!isRunning) {
        closemenu();
        updatechart();
    }
});
// switch interval ix
function switchintervalix(v, vix) {
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
function closemenu() {
    let menulabel = document.querySelector('label[for=menu]'),
        pseudolabel = window.getComputedStyle(menulabel, '::after').content,
        menuchecked = document.getElementById('menu').checked;
    pseudolabel.includes(menulabel.getAttribute('data-abbr')) && menuchecked ? document.getElementById('menu').checked = false : null;
}
// switch moving averages 
function SwMA(v, ldata, rdata) {
    switch (v.toUpperCase()) {
        case 'S':
            return SMA(ldata, rdata);
            break;
        case 'E':
            return EMA(ldata, rdata);
            break;
        case 'D':
            return DEMA(ldata, rdata);
            break;
        default:
            return null;
    }
}
// switch moving average symbol on legend
function SwMALegend(v) {
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

// fetch options
let options = {
    method: 'get',
    mode: 'same-origin',
    headers: {
        'Content-type': 'application/json; charset=UTF-8',
        'Clear-Site-Data': 'executionContexts',
        'Accept-Language': 'sq-AL',
        'Cross-Origin-Resource-Policy': 'same-origin'
    }
}

// iq quotes and currency converter
function cqu() {
    let q = document.getElementById('q').value,
        cqr = document.getElementById('cqr'),
        cq = 'cq?q=' + q;
    ForexData.convert(q).then(values => ({ json: () => Promise.resolve(values) }))
        .then(function (response) { return response.json(); })
        .then(function (values) {
            cqr.innerText = null;
            let request = values.R,
                xr;
            switch (request) {
                case 'X':
                    xr = values.Exchange * parseFloat(values.Amount);
                    return cqr.innerText = `${values.Amount} ${values.Sell} = ${parseFloat(xr).toLocaleString('en')} ${values.Buy} \n (${values.Source})`;
                    break;
                case 'Q':
                    return cqr.innerText = `${values.Name}: ${values.Price} \n Change: ${values.Change} (${values.ChangePercent}%) \n Previous Close: ${values.PreviousClose} \n Open: ${values.Open} Low: ${values.Low} High: ${values.High} \n 52 Week Range: ${values.ftWeekRange} \n Vol.: ${values.Volume}`;
                    break;
                case 'E':
                    return cqr.innerText = values.Error;
                    break;
                default:
                    return cqr.innerText = null;
            }
        })
        .catch(function (err) { console.error(err); val.disabled = false; val.value = nxupdate; isRunning = false; (document.getElementById('data-status') || {}).textContent = 'Gabim: ' + err.message; })
}
// end

let currency = document.querySelector('input[name=currency]:checked').value,
    start = document.getElementById('start').value,
    end = document.getElementById('end').value,
    interval = document.querySelector('input[name=interval]:checked').value,
    intervalx = document.getElementById('ix').value,
    val = document.getElementById('update'),
    url = 'q?c=' + currency.toLowerCase() + '&fd=' + start + '&td=' + end + '&i=' + interval + '&ix=' + intervalx,
    svgvB = document.querySelector('article');

// technical indicators variables
let ma_a = parseInt(document.getElementById('ma_a').value.match(/\d+/g), 10),
    ma_b = parseInt(document.getElementById('ma_b').value.match(/\d+/g), 10),
    ma_c = parseInt(document.getElementById('ma_c').value.match(/\d+/g), 10),
    ma_d = parseInt(document.getElementById('ma_d').value.match(/\d+/g), 10),
    mma_a = !isNaN(ma_a) ? document.getElementById('ma_a').value.charAt(0).toUpperCase() : null,
    mma_b = !isNaN(ma_b) ? document.getElementById('ma_b').value.charAt(0).toUpperCase() : null,
    mma_c = !isNaN(ma_c) ? document.getElementById('ma_c').value.charAt(0).toUpperCase() : null,
    mma_d = !isNaN(ma_d) ? document.getElementById('ma_d').value.charAt(0).toUpperCase() : null,
    // default values first load
    N = 20, // N period of moving average
    K = 2, // K * n-period standard deviation above/below moving average
    eshort = 8, // MACD EMA 8 fast 
    elong = 17, // MACD EMA 17 slow
    esignal = 9, // MACD EMA 9 signal
    RC = 12, // Rate of Change ROC
    RS = 14, // Relative Strength Index
    bband = document.getElementById('bband').checked,
    macd = document.getElementById('macd').checked,
    macdh = document.getElementById('macdh').checked,
    roc = document.getElementById('roc').checked,
    rsi = document.getElementById('rsi').checked;

function updatechart() {
    d3.select('article svg').remove();
    // debugger; // inspect elements : update no data
    val.value = nxloading;
    val.disabled = true;
    isRunning = true;
    currency = document.querySelector('input[name=currency]:checked').value;
    start = document.getElementById('start').value;
    end = document.getElementById('end').value;
    interval = document.querySelector('input[name=interval]:checked').value;
    intervalx = document.getElementById('ix').value;
    url = 'q?c=' + currency.toLowerCase() + '&fd=' + start + '&td=' + end + '&i=' + interval + '&ix=' + intervalx;
    // technical indicators
    ma_a = parseInt(document.getElementById('ma_a').value.match(/\d+/g), 10);
    ma_b = parseInt(document.getElementById('ma_b').value.match(/\d+/g), 10);
    ma_c = parseInt(document.getElementById('ma_c').value.match(/\d+/g), 10);
    ma_d = parseInt(document.getElementById('ma_d').value.match(/\d+/g), 10);
    mma_a = !isNaN(ma_a) ? document.getElementById('ma_a').value.charAt(0) : null;
    mma_b = !isNaN(ma_b) ? document.getElementById('ma_b').value.charAt(0) : null;
    mma_c = !isNaN(ma_c) ? document.getElementById('ma_c').value.charAt(0) : null;
    mma_d = !isNaN(ma_d) ? document.getElementById('ma_d').value.charAt(0) : null;
    bband = document.getElementById('bband').checked;
    N = !isNaN(parseInt(document.getElementById('bb_N').value, 10)) ? document.getElementById('bb_N').value : 20;
    K = !isNaN(parseInt(document.getElementById('bb_K').value, 10)) ? document.getElementById('bb_K').value : 2;
    macd = document.getElementById('macd').checked;
    macdh = document.getElementById('macdh').checked;
    eshort = !isNaN(parseInt(document.getElementById('macd_fast').value, 10)) ? document.getElementById('macd_fast').value : 8;
    elong = !isNaN(parseInt(document.getElementById('macd_slow').value, 10)) ? document.getElementById('macd_slow').value : 17;
    esignal = !isNaN(parseInt(document.getElementById('macd_signal').value, 10)) ? document.getElementById('macd_signal').value : 9;
    roc = document.getElementById('roc').checked;
    RC = !isNaN(parseInt(document.getElementById('roc_values').value, 10)) ? document.getElementById('roc_values').value : 12;
    rsi = document.getElementById('rsi').checked;
    RS = !isNaN(parseInt(document.getElementById('rsi_values').value, 10)) ? document.getElementById('rsi_values').value : 14;

    d3.select('article').append('svg');
    ForexData.query(url).then(values => ({ json: () => Promise.resolve(values) }))
        .then(function (response) { return response.json(); })
        .then(function (values) {
            let parsedData = parseData(values, currency);
            val.value = nxupdate;
            val.disabled = false;
            isRunning = false;
            drawChart(parsedData, currency);
        })
        .catch(function (err) {
            console.error(err); val.disabled = false; val.value = nxupdate; isRunning = false; (document.getElementById('data-status') || {}).textContent = 'Gabim: ' + err.message;
            isRunning = false;
        });
}

document.addEventListener('DOMContentLoaded', function () {
    // debugger;
    val.value = nxloading;
    val.disabled = true;
    isRunning = true;
    ForexData.query(url).then(values => ({ json: () => Promise.resolve(values) }))
        .then(function (response) { return response.json(); })
        .then(function (values) {
            let pdata = parseData(values, currency);
            val.value = nxupdate;
            val.disabled = false;
            isRunning = false;
            drawChart(pdata, currency);
        })
        .catch(function (err) { console.error(err); val.disabled = false; val.value = nxupdate; isRunning = false; (document.getElementById('data-status') || {}).textContent = 'Gabim: ' + err.message; });

    // update chart and close "menu"
    document.getElementById('update').addEventListener('click', () => {
        closemenu();
        updatechart();
    });
});

// orientation changes
window.addEventListener('orientationchange', function () {
    val.value = nxloading;
    if (!isRunning) {
        updatechart();
    }
}, false);

function parseData(values, currency) {
    let arr = [];
    for (let i in values) {
        arr.push({
            date: new Date(values[i].Data),
            value: +values[i][currency]
        });
    }
    return arr;
}

function drawChart(values, currency) {
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
        height = svgvB.offsetHeight < minwidth ? minwidth - margin.top : svgvB.offsetHeight - margin.top,
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
        // scale Y
        A = [vdata, (MA_a != false ? MA_a : []), (MA_b != false ? MA_b : []), (MA_c != false ? MA_c : []), (MA_d != false ? MA_d : []), (LowerBand != false ? LowerBand : []), UpperBand != false ? UpperBand : []],
        MinA = A.map(a => Math.min.apply(null, a)),
        MaxA = A.map(a => Math.max.apply(null, a)),
        MinYScale = Math.min.apply(null, MinA),
        MaxYScale = Math.max.apply(null, MaxA),
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
            .tickSizeOuter(0));

    let xAxis = g => g
        .attr('transform', 'translate(0,' + ((macd || macdh) && (roc || rsi) ? ibottom.bottom + padding + indicator.height + padding * 2 : (macd || macdh || roc || rsi ? ibottom.bottom + padding : height)) + ')')
        .call(d3.axisBottom(x)
            .tickSizeOuter(0)
            .tickValues(ddata.filter((_d, i) => !(i % (Math.round(200 * datalength / width)))))
            .tickFormat(tformat));

    let x = d3.scalePoint()
        .domain(ddata)
        .range([width < minwidth ? width + margin.right - padding : width - padding, padding]);

    let y = d3.scaleLinear()
        .domain([MinYScale - 1, MaxYScale + 1])
        .range([height - padding, margin.top])
        .nice();

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

    const svg = d3.select('article svg')
        .attr('preserveAspectRatio', 'xMinYMin meet')
        .attr('viewBox', '0 0 ' + (width + margin.right) + ' ' + ((macd || macdh) && (roc || rsi) ? height + margin.top + indicator.height * 2 + padding * 4 : (macd || macdh || roc || rsi ? height + margin.top + indicator.height + padding * 2 : height + margin.top)))
        .call(trendlines);

    svg.append('g')
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
    let crssh = svg.append('g'),
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
        .attr('height', y.range()[0] - margin.top)
        .on('pointerenter pointerout pointermove touchstart touchend touchmove', onin);

    // macd grid
    if (macd || macdh) {
        svg.append('rect')
            .attr('class', 'macdgrid')
            .attr('fill', 'none')
            .attr('pointer-events', 'all')
            .attr('x', padding)
            .attr('y', indicator.top)
            .attr('width', x.range()[0] - padding)
            .attr('height', yMacd.range()[0] - indicator.top)
            .on('pointerenter pointerout pointermove touchstart touchend touchmove', onin);
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
            .attr('height', (macd || macdh) ? yRoc.range()[0] - ibottom.bottom - padding : yRoc.range()[0] - indicator.top)
            .on('pointerenter pointerout pointermove touchstart touchend touchmove', onin);
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
            .attr('height', (macd || macdh) ? yRsi.range()[0] - ibottom.bottom - padding : yRsi.range()[0] - indicator.top)
            .on('pointerenter pointerout pointermove touchstart touchend touchmove', onin);
    }

    function onin(event) {
        if (event.type === 'pointerenter' || event.type === 'touchstart') {
            crosshair.style('display', null);
            label.style('display', null);
        }
        if (event.type === 'touchstart') {
            crosshair.select('#crsy').style('display', 'none');
            label.style('display', 'none');
        }
        if (event.type === 'touchmove') {
            event.preventDefault();
        }
        if (event.type === 'pointerout' || event.type === 'touchend') {
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
        if (event.type === 'pointermove') {
            let xval,
                yval,
                pts = d3.pointers(event)[0];
            xval = pts[0];
            yval = pts[1];

            const sx = xval < width / 2 ? 1 : -1;
            const sy = yval < height / 2 ? 2 : -1;

            // new function x.invert for scalePoint
            x.invert = (function () {
                let domain = x.domain().reverse(),
                    range = x.range();
                let scale = d3.scaleQuantile().domain(range).range(domain);
                return function (x) {
                    return scale(x)
                }
            })();

            let yVonx = {
                vdata: vdata[ddata.indexOf(x.invert(xval))],
                MA_a: MA_a[ddata.indexOf(x.invert(xval))],
                MA_b: MA_b[ddata.indexOf(x.invert(xval))],
                MA_c: MA_c[ddata.indexOf(x.invert(xval))],
                MA_d: MA_d[ddata.indexOf(x.invert(xval))],
                UpperBand: UpperBand[ddata.indexOf(x.invert(xval))],
                LowerBand: LowerBand[ddata.indexOf(x.invert(xval))],
                MacdLine: macd ? MacdLine[0][ddata.indexOf(x.invert(xval))] : null,
                MacdSignal: macd ? MacdSignal[0][ddata.indexOf(x.invert(xval))] : null,
                MacdHist: macdh ? MacdHist[0][ddata.indexOf(x.invert(xval))] : null,
                Roc: Roc[ddata.indexOf(x.invert(xval))],
                Rsi: Rsi[ddata.indexOf(x.invert(xval))]
            }

            function maintxt(_d, i) {
                let formatdate = d3.timeFormat('%a, %d %b %Y'),
                    fd = d3.format(','),
                    txt_datenprice = formatdate(x.invert(xval)) + ', ' + currency + '/ALL: ' + fd(yVonx.vdata) + ' ' + (interval == 'wave' ? '(W)' : (interval == 'mave' ? '(M)' : (interval == 'quave' ? '(Q)' : '(D)'))),
                    txt_ma_a = !isNaN(MA_a[0]) ? SwMALegend(mma_a) + ma_a + ': ' + fd(roundn(yVonx.MA_a)) : '',
                    txt_ma_b = !isNaN(MA_b[0]) ? SwMALegend(mma_b) + ma_b + ': ' + fd(roundn(yVonx.MA_b)) : '',
                    txt_ma_c = !isNaN(MA_c[0]) ? SwMALegend(mma_c) + ma_c + ': ' + fd(roundn(yVonx.MA_c)) : '',
                    txt_ma_d = !isNaN(MA_d[0]) ? SwMALegend(mma_d) + ma_d + ': ' + fd(roundn(yVonx.MA_d)) : '',
                    txt_upbb = !isNaN(UpperBand[0]) ? 'Upper Band: ' + fd(yVonx.UpperBand) : '',
                    txt_lobb = !isNaN(LowerBand[0]) ? 'Lower Band: ' + fd(yVonx.LowerBand) : '';
                return [txt_datenprice, txt_ma_a, txt_ma_b, txt_ma_c, txt_ma_d, txt_upbb, txt_lobb].filter(x => x !== '')[i];
            }

            function macdtxt(_d, i) {
                let fd = d3.format(','),
                    line = macd ? yVonx.MacdLine : 0,
                    signal = macd ? yVonx.MacdSignal : 0,
                    histogram = macdh ? yVonx.MacdHist : 0,
                    txt_macdl = macd ? 'MACD Line: ' + fd(roundn(line)) : 0,
                    txt_macds = macd ? 'MACD Signal: ' + fd(roundn(signal)) : 0,
                    txt_macdh = macdh ? 'MACD Histogram: ' + fd(roundn(histogram)) : 0;
                return [txt_macdl, txt_macds, txt_macdh].filter(x => x != 0)[i];
            }

            function rrtxt(_d, i) {
                let fd = d3.format(','),
                    txt_roc = roc ? 'ROC: ' + fd(roundn(yVonx.Roc)) : 0,
                    txt_rsi = rsi ? 'RSI: ' + fd(roundn(yVonx.Rsi)) : 0;
                return [txt_roc, txt_rsi].filter(x => x != 0)[i];
            }

            function linelabel() {
                function str(e) {
                    if (!e) return null
                    return e.className.baseVal;
                }
                let et = str(event.target),
                    fd = d3.format(',');
                switch (et) {
                    case 'rsrcgrid':
                        return roc && rsi ? 'ROC ' + roundx(yRoc.invert(yval)) + ' RSI ' + roundx(yRsi.invert(yval)) : (roc ? roundx(yRoc.invert(yval)) : (rsi ? roundx(yRsi.invert(yval)) : null));
                        break;
                    case 'macdgrid':
                        return fd(roundx(yMacd.invert(yval)));
                        break;
                    default:
                        return fd(roundx(y.invert(yval)));
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
                .attr('x1', padding)
                .attr('y1', yval)
                .attr('x2', width)
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
    }

    // draw trendlines
    svg.append('g')
        .attr('class', 'trendlines');

    // trendlines function
    function trendlines(selection) {
        let strc = '#606060', strhc = '#f7dcad', strdc = '#f00', xy, xx, path, keep = false,
            line = d3.line(d => d[0], d => d[1]);

        selection.on('contextmenu',
            function (event) {
                event.preventDefault();
                keep = true;
                xy = d3.pointer(event);
                path = d3.select('.trendlines')
                    .append('path')
                    .attr('class', 'trend')
                    .attr('stroke', strc)
                    .attr('stroke-width', 2)
                    .attr('stroke-linecap', 'round')
                    .attr('d', line([xy, xy]));
            })
            .on('mousemove',
                function (event) {
                    if (keep) {
                        xx = d3.pointer(event).map(x => x - 1);
                        path.attr('d', line([xy, xx]));
                    }
                })
            .on('click',
                function () {
                    keep = false;
                    d3.selectAll('.trend')
                        .on('mouseover',
                            function (event) {
                                d3.select(event.currentTarget)
                                    .attr('stroke', event.altKey ? strdc : strhc)
                                    .on('click',
                                        function (event) {
                                            event.altKey ? event.currentTarget.remove() : null;
                                        });
                            })
                        .on('mouseout',
                            function (event) {
                                d3.select(event.currentTarget).attr('stroke', strc);
                            });
                });
    }
}

// round functions
function roundn(number) {
    return Math.round((number + Number.EPSILON) * 100) / 100;
}

function roundx(number) {
    return Math.round((number + Number.EPSILON) * 10) / 10;
}

// technical analysis functions 
// EMA SMA DEMA MACDH ROC RSI Bollinger Bands
function EMA(data, range) {
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
function average(data) {
    let len = data.length,
        i = -1,
        num = 0;
    while (++i < len) num += Number(data[i]);
    return num / len;
}
function SMA(data, range) {
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
function DEMA(data, range) {
    if (data.length < range) {
        console.log("DEMA: Range greater than array length.");
        return [];
    }
    let firstEma = EMA(data, range),
        secondEma = EMA(firstEma, range);
    return firstEma.map((x, i) => (2 * x) - secondEma[i]).filter(v => !Number.isNaN(v));
}
function MACD(data) {
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
function ROC(data, N) {
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
function RSI(data, N) {
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
function bollingerband(data, N, K) {
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
// bollinger band function
// function bollingerband(data, N, K) {
//     let i = 0, sum = 0, sum2 = 0;
//     let bands = [];
//     for (let n = Math.min(N - 1, data.length); i < n; ++i) {
//         const value = data[i];
//         sum += value; sum2 += Math.pow(value, 2);
//     }
//     for (let n = data.length; i < n; ++i) {
//         const value = data[i];
//         sum += value; sum2 += Math.pow(value, 2);
//         const mean = sum / N,
//             deviation = Math.sqrt((sum2 - Math.pow(sum, 2) / N) / (N - 1));
//         bands.push({
//             low: mean - (deviation * K),
//             high: mean + (deviation * K)
//         });
//         const value0 = data[i - N + 1];
//         sum -= value0; sum2 -= Math.pow(value0, 2);
//     }
//     return bands;
// }