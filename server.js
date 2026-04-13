/**
 * SIGNAL TRADING APP — PROXY SERVER
 * 
 * This server sits between your trading app and Yahoo Finance.
 * It fetches stock prices and candle data, then sends them to your app.
 * 
 * You do NOT need to understand this code. Just deploy it as instructed.
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Allow your HTML app to talk to this server ──
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Yahoo Finance symbol map (NSE stocks) ──
const SYMBOLS = {
  // Indices
  'NIFTY50':      '^NSEI',
  'BANKNIFTY':    '^NSEBANK',
  'SENSEX':       '^BSESN',
  'FINNIFTY':     'NIFTY_FIN_SERVICE.NS',
  // Stocks
  'RELIANCE':     'RELIANCE.NS',
  'HDFCBANK':     'HDFCBANK.NS',
  'TCS':          'TCS.NS',
  'INFY':         'INFY.NS',
  'ICICIBANK':    'ICICIBANK.NS',
  'SBIN':         'SBIN.NS',
  'TATAMOTORS':   'TATAMOTORS.NS',
  'BAJFINANCE':   'BAJFINANCE.NS',
  'WIPRO':        'WIPRO.NS',
  'AXISBANK':     'AXISBANK.NS',
  'MARUTI':       'MARUTI.NS',
  'SUNPHARMA':    'SUNPHARMA.NS',
  'TITAN':        'TITAN.NS',
  'HCLTECH':      'HCLTECH.NS',
  'LT':           'LT.NS',
  'KOTAKBANK':    'KOTAKBANK.NS',
  'ADANIENT':     'ADANIENT.NS',
  'ADANIPORTS':   'ADANIPORTS.NS',
  'ULTRACEMCO':   'ULTRACEMCO.NS',
  'BAJAJFINSV':   'BAJAJFINSV.NS',
  'NTPC':         'NTPC.NS',
  'POWERGRID':    'POWERGRID.NS',
  'ONGC':         'ONGC.NS',
  'NESTLEIND':    'NESTLEIND.NS',
  'HINDUNILVR':   'HINDUNILVR.NS',
  'ASIANPAINT':   'ASIANPAINT.NS',
  'TECHM':        'TECHM.NS',
  'DRREDDY':      'DRREDDY.NS',
  'CIPLA':        'CIPLA.NS',
};

// ── Yahoo Finance headers (makes it look like a real browser) ──
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com',
};

// ── Helper: fetch one symbol from Yahoo Finance ──
async function fetchYahoo(nseSymbol) {
  const yfSym = SYMBOLS[nseSymbol.toUpperCase()] || (nseSymbol + '.NS');
  
  try {
    // Fetch current quote + 5-min candles in one call
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=5m&range=1d&includePrePost=false`;
    const resp = await axios.get(url, { 
      headers: YF_HEADERS,
      timeout: 10000 
    });
    
    const result = resp.data?.chart?.result?.[0];
    if (!result) return { sym: nseSymbol, error: 'No data returned' };

    const meta   = result.meta;
    const quote  = result.indicators?.quote?.[0] || {};
    const closes = (quote.close  || []).filter(x => x != null);
    const opens  = (quote.open   || []).filter(x => x != null);
    const highs  = (quote.high   || []).filter(x => x != null);
    const lows   = (quote.low    || []).filter(x => x != null);
    const vols   = (quote.volume || []).filter(x => x != null);

    const price      = meta.regularMarketPrice || closes[closes.length - 1] || 0;
    const prevClose  = meta.chartPreviousClose || meta.previousClose || price;
    const changePct  = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const avgVol     = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 1;

    // Last 10 candles for pattern analysis
    const candles = closes.slice(-10).map((c, i) => ({
      o: +(opens[i]  || c).toFixed(2),
      h: +(highs[i]  || c).toFixed(2),
      l: +(lows[i]   || c).toFixed(2),
      c: +c.toFixed(2),
      v: vols[i] || 0,
    }));

    return {
      sym:        nseSymbol,
      yfSym:      yfSym,
      price:      +price.toFixed(2),
      open:       +(meta.regularMarketOpen || opens[0] || price).toFixed(2),
      high:       +(meta.regularMarketDayHigh || Math.max(...highs)).toFixed(2),
      low:        +(meta.regularMarketDayLow  || Math.min(...lows)).toFixed(2),
      prevClose:  +prevClose.toFixed(2),
      changePct:  +changePct.toFixed(2),
      volume:     vols[vols.length - 1] || 0,
      avgVolume:  Math.round(avgVol),
      volRatio:   avgVol > 0 ? +((vols[vols.length-1]||0) / avgVol).toFixed(2) : 0,
      candles:    candles,
      marketState: meta.marketState || 'CLOSED',
      currency:   meta.currency || 'INR',
      fetchedAt:  new Date().toISOString(),
    };

  } catch (err) {
    return { 
      sym: nseSymbol, 
      error: err.response?.status === 404 ? 'Symbol not found' : err.message 
    };
  }
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// Health check — lets your app know the server is alive
app.get('/', (req, res) => {
  res.json({ 
    status: 'Signal server running',
    time: new Date().toISOString(),
    endpoints: ['/price/:symbol', '/prices?symbols=A,B,C', '/candles/:symbol', '/health']
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) + 's', time: new Date().toISOString() });
});

// Single symbol price + candles
// Example: GET /price/RELIANCE
app.get('/price/:symbol', async (req, res) => {
  const data = await fetchYahoo(req.params.symbol.toUpperCase());
  res.json(data);
});

// Multiple symbols at once — most efficient
// Example: GET /prices?symbols=RELIANCE,HDFCBANK,NIFTY50,TCS
app.get('/prices', async (req, res) => {
  const raw     = req.query.symbols || '';
  const symbols = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);

  if (!symbols.length) {
    return res.json({ error: 'Provide ?symbols=RELIANCE,HDFCBANK,...' });
  }

  // Fetch all in parallel — server has no CORS restriction
  const results = await Promise.allSettled(symbols.map(fetchYahoo));
  const data    = {};

  results.forEach((r, i) => {
    const sym = symbols[i];
    data[sym] = r.status === 'fulfilled' ? r.value : { sym, error: r.reason?.message };
  });

  res.json({
    fetchedAt: new Date().toISOString(),
    count: symbols.length,
    data,
  });
});

// Just candles for a symbol (for detailed pattern analysis)
// Example: GET /candles/RELIANCE?interval=5m&range=5d
app.get('/candles/:symbol', async (req, res) => {
  const yfSym   = SYMBOLS[req.params.symbol.toUpperCase()] || (req.params.symbol + '.NS');
  const interval = req.query.interval || '5m';
  const range    = req.query.range    || '1d';

  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${interval}&range=${range}`;
    const resp = await axios.get(url, { headers: YF_HEADERS, timeout: 12000 });
    const result = resp.data?.chart?.result?.[0];
    if (!result) return res.json({ error: 'No candle data' });

    const q        = result.indicators?.quote?.[0] || {};
    const times    = result.timestamp || [];
    const candles  = times.map((t, i) => ({
      time:  new Date(t * 1000).toISOString(),
      o: +(q.open?.[i]   || 0).toFixed(2),
      h: +(q.high?.[i]   || 0).toFixed(2),
      l: +(q.low?.[i]    || 0).toFixed(2),
      c: +(q.close?.[i]  || 0).toFixed(2),
      v:   q.volume?.[i] || 0,
    })).filter(c => c.c > 0);

    res.json({ sym: req.params.symbol, interval, range, candles, count: candles.length });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// List all supported symbols
app.get('/symbols', (req, res) => {
  res.json({ 
    count: Object.keys(SYMBOLS).length,
    symbols: Object.keys(SYMBOLS),
    note: 'Any other symbol will be tried as SYMBOL.NS on Yahoo Finance'
  });
});

// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Signal proxy server running on port ${PORT}`);
  console.log(`Test it: http://localhost:${PORT}/health`);
});
