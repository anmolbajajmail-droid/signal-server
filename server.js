/**
 * SIGNAL TRADING APP - PROXY SERVER v2
 * Fixed: proper PORT binding, Yahoo Finance headers, US market support
 */
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();

// Railway injects PORT automatically - this is critical
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Symbol map: NSE + US stocks ──
const SYMBOLS = {
  // NSE Indices
  'NIFTY50':'NSEI', 'BANKNIFTY':'NSEBANK', 'SENSEX':'BSESN',
  // NSE Stocks  
  'RELIANCE':'RELIANCE.NS','HDFCBANK':'HDFCBANK.NS','TCS':'TCS.NS',
  'INFY':'INFY.NS','ICICIBANK':'ICICIBANK.NS','SBIN':'SBIN.NS',
  'TATAMOTORS':'TATAMOTORS.NS','BAJFINANCE':'BAJFINANCE.NS',
  'WIPRO':'WIPRO.NS','AXISBANK':'AXISBANK.NS','MARUTI':'MARUTI.NS',
  'SUNPHARMA':'SUNPHARMA.NS','TITAN':'TITAN.NS','HCLTECH':'HCLTECH.NS',
  'LT':'LT.NS','KOTAKBANK':'KOTAKBANK.NS','ADANIENT':'ADANIENT.NS',
  'NTPC':'NTPC.NS','POWERGRID':'POWERGRID.NS','ONGC':'ONGC.NS',
  'HINDUNILVR':'HINDUNILVR.NS','ASIANPAINT':'ASIANPAINT.NS',
  'BAJAJFINSV':'BAJAJFINSV.NS','TECHM':'TECHM.NS','DRREDDY':'DRREDDY.NS',
  'NESTLEIND':'NESTLEIND.NS','ULTRACEMCO':'ULTRACEMCO.NS',
  // US stocks (always trade during US hours)
  'AAPL':'AAPL','MSFT':'MSFT','GOOGL':'GOOGL','AMZN':'AMZN',
  'TSLA':'TSLA','META':'META','NVDA':'NVDA','JPM':'JPM',
  'GS':'GS','SPY':'SPY','QQQ':'QQQ','NFLX':'NFLX',
};

const YF_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9',
  'Accept-Encoding':'gzip, deflate, br',
  'Referer':'https://finance.yahoo.com/',
  'Origin':'https://finance.yahoo.com',
};

async function fetchOne(sym) {
  const input = sym.toUpperCase();
  let yfSym = SYMBOLS[input];
  
  // Auto-detect: if not in map, try as NSE stock
  if (!yfSym) {
    yfSym = input.includes('.') ? input : `${input}.NS`;
  }
  
  // NSE indices need ^ prefix
  if (['NSEI','NSEBANK','BSESN'].includes(yfSym)) {
    yfSym = '^' + yfSym;
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=5m&range=1d&includePrePost=false`;
    const r = await axios.get(url, { headers: YF_HEADERS, timeout: 12000 });
    const result = r.data?.chart?.result?.[0];
    if (!result) return { sym: input, error: 'No data from Yahoo Finance' };

    const meta  = result.meta || {};
    const quote = result.indicators?.quote?.[0] || {};
    const ts    = result.timestamp || [];

    const closes = (quote.close  || []);
    const opens  = (quote.open   || []);
    const highs  = (quote.high   || []);
    const lows   = (quote.low    || []);
    const vols   = (quote.volume || []);

    // Build valid candles (filter nulls)
    const candles = ts.map((t,i) => ({
      time: new Date(t*1000).toISOString(),
      o: opens[i]  != null ? +opens[i].toFixed(2)  : null,
      h: highs[i]  != null ? +highs[i].toFixed(2)  : null,
      l: lows[i]   != null ? +lows[i].toFixed(2)   : null,
      c: closes[i] != null ? +closes[i].toFixed(2) : null,
      v: vols[i]   || 0,
    })).filter(c => c.c != null);

    const validVols   = vols.filter(v => v != null && v > 0);
    const avgVol      = validVols.length ? validVols.reduce((a,b)=>a+b,0)/validVols.length : 1;
    const lastVol     = validVols[validVols.length-1] || 0;
    const price       = meta.regularMarketPrice || (candles.length ? candles[candles.length-1].c : 0);
    const prevClose   = meta.chartPreviousClose || meta.previousClose || price;
    const changePct   = prevClose ? (price - prevClose) / prevClose * 100 : 0;
    const validHighs  = highs.filter(h=>h!=null);
    const validLows   = lows.filter(l=>l!=null);

    return {
      sym:         input,
      yfSym,
      price:       +price.toFixed(2),
      open:        +(meta.regularMarketOpen || opens.find(o=>o!=null) || price).toFixed(2),
      high:        +(meta.regularMarketDayHigh || (validHighs.length ? Math.max(...validHighs) : price)).toFixed(2),
      low:         +(meta.regularMarketDayLow  || (validLows.length  ? Math.min(...validLows)  : price)).toFixed(2),
      prevClose:   +prevClose.toFixed(2),
      changePct:   +changePct.toFixed(2),
      volume:      lastVol,
      avgVolume:   Math.round(avgVol),
      volRatio:    avgVol > 0 ? +(lastVol/avgVol).toFixed(2) : 0,
      candles:     candles.slice(-12),
      marketState: meta.marketState || 'UNKNOWN',
      currency:    meta.currency    || 'INR',
      exchange:    meta.exchangeName || '',
      fetchedAt:   new Date().toISOString(),
    };
  } catch(e) {
    const status = e.response?.status;
    return { 
      sym: input, yfSym,
      error: status === 404 ? `Symbol ${yfSym} not found on Yahoo Finance`
           : status === 429 ? 'Yahoo Finance rate limited — try again in 60s'
           : e.message 
    };
  }
}

// ── ROUTES ──

// Root — basic info
app.get('/', (req, res) => {
  res.json({
    name: 'Signal Trading Proxy',
    status: 'running',
    time: new Date().toISOString(),
    routes: {
      '/health':                  'Server health check',
      '/price/:symbol':           'Single stock  e.g. /price/RELIANCE',
      '/prices?symbols=A,B,C':    'Multiple stocks at once',
      '/candles/:symbol':         'Detailed candle data',
      '/symbols':                 'List all mapped symbols',
    }
  });
});

// Health check — the app pings this to confirm server is alive
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) + 's', time: new Date().toISOString() });
});

// Single price
app.get('/price/:symbol', async (req, res) => {
  const data = await fetchOne(req.params.symbol);
  res.json(data);
});

// Batch prices — all in parallel, server has no CORS restriction
app.get('/prices', async (req, res) => {
  const raw     = req.query.symbols || '';
  const symbols = raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,40);
  if (!symbols.length) return res.json({ error: 'Provide ?symbols=RELIANCE,HDFCBANK' });

  const results = await Promise.allSettled(symbols.map(fetchOne));
  const data    = {};
  results.forEach((r, i) => {
    data[symbols[i]] = r.status === 'fulfilled' ? r.value : { sym: symbols[i], error: r.reason?.message };
  });

  res.json({ fetchedAt: new Date().toISOString(), count: symbols.length, data });
});

// Detailed candles
app.get('/candles/:symbol', async (req, res) => {
  const input    = req.params.symbol.toUpperCase();
  let yfSym      = SYMBOLS[input] || `${input}.NS`;
  if (['NSEI','NSEBANK','BSESN'].includes(yfSym)) yfSym = '^'+yfSym;
  const interval = req.query.interval || '5m';
  const range    = req.query.range    || '1d';
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${interval}&range=${range}`;
    const r   = await axios.get(url, { headers: YF_HEADERS, timeout: 14000 });
    const res2 = r.data?.chart?.result?.[0];
    if (!res2) return res.json({ error: 'No candle data' });
    const q  = res2.indicators?.quote?.[0] || {};
    const ts = res2.timestamp || [];
    const candles = ts.map((t,i)=>({
      time: new Date(t*1000).toISOString(),
      o: q.open?.[i]!=null  ? +q.open[i].toFixed(2)  : null,
      h: q.high?.[i]!=null  ? +q.high[i].toFixed(2)  : null,
      l: q.low?.[i]!=null   ? +q.low[i].toFixed(2)   : null,
      c: q.close?.[i]!=null ? +q.close[i].toFixed(2) : null,
      v: q.volume?.[i] || 0,
    })).filter(c=>c.c!=null);
    res.json({ sym: input, yfSym, interval, range, count: candles.length, candles });
  } catch(e) { res.json({ error: e.message }); }
});

// List symbols
app.get('/symbols', (req, res) => {
  res.json({ count: Object.keys(SYMBOLS).length, symbols: Object.keys(SYMBOLS) });
});

// ── START ──
// Must bind to 0.0.0.0 on Railway, not just localhost
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Signal proxy running on port ${PORT}`);
});
