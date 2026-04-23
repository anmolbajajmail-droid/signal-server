/**
 * SIGNAL SERVER v5.2 — Kite Connect integration for live NSE prices
 *
 * WHAT'S NEW in v5.2:
 *   - Kite Connect (Zerodha) used for real-time prices during market hours
 *   - Yahoo Finance used as fallback when Kite not authenticated or market closed
 *   - /kite/login    — redirects to Zerodha login page
 *   - /kite/callback — Zerodha redirects here after login, stores access token
 *   - /kite/status   — tells app whether Kite is authenticated today
 *   - /prices        — now uses Kite first, Yahoo fallback
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── KITE CONNECT CONFIG ──────────────────────────────────────────────────────
const KITE_API_KEY    = 'gpu1abcpzx25hwv4';
const KITE_API_SECRET = 'gsac2outcu2zz5j9i2m9a4879zylpxa5';
const KITE_BASE       = 'https://api.kite.trade';
const SERVER_URL      = 'https://soothing-comfort-production-a8ce.up.railway.app';

// Kite session — resets daily
let KITE = {
  accessToken: null,
  authenticatedAt: null,
  authenticatedDate: null, // YYYY-MM-DD
};

function kiteToday() {
  return new Date().toISOString().split('T')[0];
}
function kiteReady() {
  return KITE.accessToken && KITE.authenticatedDate === kiteToday();
}

// ─── CACHE ───────────────────────────────────────────────────────────────────
let CACHE = {
  tier1: [], tier1At: null, tier1Running: false,
  tier1Progress: { scanned: 0, total: 0, status: 'idle' },
  tier2: [], tier2At: null,
};

// ─── NSE UNIVERSE ────────────────────────────────────────────────────────────
const NSE_ALL = [
  '^NSEI','^NSEBANK','NIFTY_FIN_SERVICE.NS','^CNXIT','^NSEMDCP50',
  'RELIANCE.NS','HDFCBANK.NS','ICICIBANK.NS','INFY.NS','TCS.NS','LT.NS',
  'BAJFINANCE.NS','SBIN.NS','HINDUNILVR.NS','AXISBANK.NS','KOTAKBANK.NS',
  'BHARTIARTL.NS','ASIANPAINT.NS','MARUTI.NS','TITAN.NS','WIPRO.NS',
  'ULTRACEMCO.NS','SUNPHARMA.NS','HCLTECH.NS','TATAMOTORS.NS','ADANIENT.NS',
  'NTPC.NS','POWERGRID.NS','ONGC.NS','COALINDIA.NS','BAJAJFINSV.NS',
  'NESTLEIND.NS','DRREDDY.NS','CIPLA.NS','TECHM.NS','HEROMOTOCO.NS',
  'DIVISLAB.NS','EICHERMOT.NS','BPCL.NS','INDUSINDBK.NS','GRASIM.NS',
  'APOLLOHOSP.NS','JSWSTEEL.NS','TATASTEEL.NS','HINDALCO.NS','ADANIPORTS.NS',
  'BRITANNIA.NS','TATACONSUM.NS','SBILIFE.NS','HDFCLIFE.NS','LTIM.NS',
  'BAJAJ-AUTO.NS','M&M.NS','UPL.NS','SHREECEM.NS',
  'PIDILITIND.NS','SIEMENS.NS','DABUR.NS','GODREJCP.NS','BERGEPAINT.NS',
  'AMBUJACEM.NS','ACC.NS','BOSCHLTD.NS','COLPAL.NS','HAVELLS.NS',
  'MARICO.NS','MUTHOOTFIN.NS','PNB.NS','BANKBARODA.NS','CANBK.NS',
  'VEDL.NS','SAIL.NS','NMDC.NS','HINDPETRO.NS','IOC.NS',
  'GAIL.NS','PETRONET.NS','IGL.NS','TRENT.NS','NAUKRI.NS',
  'ZOMATO.NS','IRCTC.NS','DMART.NS','CHOLAFIN.NS','ABCAPITAL.NS',
  'INDHOTEL.NS','ZEEL.NS','GODREJPROP.NS','DLF.NS','LODHA.NS',
  'PRESTIGE.NS','OBEROIRLTY.NS','PHOENIXLTD.NS',
  'ABFRL.NS','ALKEM.NS','APLAPOLLO.NS','ASTRAL.NS','ATUL.NS',
  'AUBANK.NS','BALRAMCHIN.NS','BANDHANBNK.NS','BATAINDIA.NS','BIKAJI.NS',
  'BLUESTARCO.NS','CAMS.NS','CANFINHOME.NS','CASTROLIND.NS','CESC.NS',
  'COFORGE.NS','CONCOR.NS','CROMPTON.NS','DEEPAKNTR.NS','DELTACORP.NS',
  'DIXON.NS','ELGIEQUIP.NS','ESCORTS.NS','EXIDEIND.NS','FEDERALBNK.NS',
  'GLAXO.NS','GNFC.NS','GUJGASLTD.NS','HAPPSTMNDS.NS','HFCL.NS',
  'IDFCFIRSTB.NS','JKCEMENT.NS','JUBLFOOD.NS','KAJARIACER.NS','KPITTECH.NS',
  'LAURUSLABS.NS','LICHSGFIN.NS','LTTS.NS','LUPIN.NS','MANAPPURAM.NS',
  'MFSL.NS','MOTHERSON.NS','MPHASIS.NS','NAVINFLUOR.NS','NLCINDIA.NS',
  'OFSS.NS','PAGEIND.NS','PERSISTENT.NS','POLYCAB.NS','RAIN.NS',
  'RBLBANK.NS','RECLTD.NS','RELAXO.NS','RITES.NS','SBICARD.NS',
  'SCHAEFFLER.NS','SRF.NS','STARHEALTH.NS','SUPREMEIND.NS','SYNGENE.NS',
  'TANLA.NS','TATAELXSI.NS','TATACHEM.NS','TATACOMM.NS','TORNTPHARM.NS',
  'TORNTPOWER.NS','TVSMOTORS.NS','UJJIVANSFB.NS','UNIONBANK.NS','VBL.NS',
  'VOLTAS.NS','ZYDUSLIFE.NS','SKFINDIA.NS','SONACOMS.NS',
  'UNOMINDA.NS','UTIAMC.NS','POLYMED.NS','LALPATHLAB.NS','METROPOLIS.NS',
  'IDBI.NS','INDIANB.NS','UCOBANK.NS','IOB.NS','MAHABANK.NS',
  'YESBANK.NS','IDFC.NS','M&MFIN.NS','BAJAJHFL.NS','LICHOUSING.NS',
  'POONAWALLA.NS','CREDITACC.NS','IIFL.NS','MOTILALOS.NS',
  'ANGELONE.NS','5PAISA.NS',
  'HEXAWARE.NS','MASTEK.NS','RATEGAIN.NS',
  'INTELLECT.NS','TATATECH.NS','CYIENT.NS','BIRLASOFT.NS','ZENSAR.NS',
  'ECLERX.NS','FIRSTSOURCE.NS','SONATSOFTW.NS',
  'AUROPHARMA.NS','BIOCON.NS','GLENMARK.NS','GRANULES.NS','IPCALAB.NS',
  'NATCOPHARM.NS','PFIZER.NS','MANKIND.NS','AJANTPHARM.NS',
  'ASHOKLEY.NS','MRF.NS','CEATLTD.NS','APOLLOTYRE.NS','BALKRISIND.NS',
  'SUNDARMFIN.NS','TVSMOTOR.NS','ENDURANCE.NS','MINDA.NS',
  'ABB.NS','BHEL.NS','CUMMINSIND.NS','KEC.NS','NBCC.NS','NCC.NS',
  'RVNL.NS','THERMAX.NS','IRB.NS','HGINFRA.NS','KNRCON.NS',
  'NATIONALUM.NS','HINDZINC.NS','MOIL.NS','JSPL.NS','RATNAMANI.NS',
  'EMAMILTD.NS','JYOTHYLAB.NS','DEVYANI.NS','WESTLIFE.NS',
  'ADANIPOWER.NS','ADANIGREEN.NS','TATAPOWER.NS','SUZLON.NS','NHPC.NS','SJVN.NS',
  'ALKYLAMINE.NS','FINEORG.NS','GALAXYSURF.NS','PIIND.NS','VINATIORGA.NS',
  'BRIGADE.NS','SOBHA.NS','SUNTECK.NS','NAZARA.NS',
];
const NSE_UNIVERSE = [...new Set(NSE_ALL)];

const YF_HDR = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9',
  'Referer':'https://finance.yahoo.com/',
  'Origin':'https://finance.yahoo.com',
};

// ─── KITE ROUTES ─────────────────────────────────────────────────────────────

// Step 1: User clicks "Login with Zerodha" → redirects to Kite login
app.get('/kite/login', (req, res) => {
  const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${KITE_API_KEY}`;
  res.redirect(loginUrl);
});

// Step 2: Zerodha redirects back here with request_token
app.get('/kite/callback', async (req, res) => {
  const { request_token, status } = req.query;
  if (status !== 'success' || !request_token) {
    return res.send('<h2>❌ Login failed. Please try again.</h2><a href="/kite/login">Retry</a>');
  }
  try {
    // Generate checksum: sha256(api_key + request_token + api_secret)
    const checksum = crypto.createHash('sha256')
      .update(KITE_API_KEY + request_token + KITE_API_SECRET)
      .digest('hex');

    // Exchange request_token for access_token
    const resp = await axios.post(`${KITE_BASE}/session/token`,
      new URLSearchParams({ api_key: KITE_API_KEY, request_token, checksum }).toString(),
      { headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    KITE.accessToken      = resp.data.data.access_token;
    KITE.authenticatedAt  = new Date().toISOString();
    KITE.authenticatedDate = kiteToday();

    console.log(`[Kite] Authenticated at ${KITE.authenticatedAt}`);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1117;color:#e6edf3">
        <h1 style="color:#3fb950">✅ Zerodha Connected!</h1>
        <p>Live NSE prices are now active for today.</p>
        <p style="color:#8b949e">You can close this tab and return to your trading app.</p>
        <p style="font-size:12px;color:#8b949e;margin-top:40px">Token stored until midnight. Login again tomorrow morning before trading.</p>
      </body></html>
    `);
  } catch(e) {
    console.error('[Kite] Token exchange failed:', e.response?.data || e.message);
    res.send(`<h2>❌ Auth failed: ${e.message}</h2><a href="/kite/login">Retry</a>`);
  }
});

// Status check — app calls this to show login state
app.get('/kite/status', (req, res) => {
  res.json({
    ready: kiteReady(),
    authenticatedAt: KITE.authenticatedAt,
    authenticatedDate: KITE.authenticatedDate,
    today: kiteToday(),
    message: kiteReady()
      ? `✅ Kite live prices active (authenticated ${new Date(KITE.authenticatedAt).toLocaleTimeString('en-IN')})`
      : '⚠️ Not logged in — click "Login with Zerodha" for live prices',
  });
});
// ─── KITE DATA DOWNLOADER PROXY ROUTES ──────────────────────────────────────
// These routes allow the kite_downloader.html tool to fetch data through the
// server (bypassing browser CORS restrictions on direct Kite API calls)

// Returns current access token so downloader knows server is authenticated
app.get('/kite/token', (req, res) => {
  if (!kiteReady()) {
    return res.status(401).json({ error: 'Not authenticated. Open the trading app and login with Zerodha first.' });
  }
  res.json({ ready: true, authenticatedAt: KITE.authenticatedAt });
});

// Proxy for Kite historical data API
// Usage: GET /kite/historical?token=341249&interval=5minute&from=2026-03-02&to=2026-04-16
app.get('/kite/historical', async (req, res) => {
  if (!kiteReady()) {
    return res.status(401).json({ error: 'Not authenticated. Login via trading app first.' });
  }
  const { token, interval, from, to } = req.query;
  if (!token || !interval || !from || !to) {
    return res.status(400).json({ error: 'Missing params. Need: token, interval, from, to' });
  }
  try {
    const url = `${KITE_BASE}/instruments/historical/${token}/${interval}?from=${from}&to=${to}&continuous=0&oi=0`;
    const resp = await axios.get(url, {
      headers: { 'X-Kite-Version': '3', 'Authorization': `token ${KITE_API_KEY}:${KITE.accessToken}` }
    });
    res.json(resp.data);
  } catch(e) {
    const errMsg = e.response?.data?.message || e.message;
    console.error('[Kite Historical] Error:', errMsg);
    res.status(500).json({ error: errMsg });
  }
});



// ─── KITE PRICE FETCH ─────────────────────────────────────────────────────────
// Converts clean symbol (RELIANCE) to NSE trading symbol format
function toKiteSymbol(sym) {
  // Kite uses exchange:tradingsymbol format
  const clean = sym.replace('.NS','').replace('.BO','').replace('^','');
  // Index handling
  if(clean==='NSEI'||clean==='NIFTY50') return 'NSE:NIFTY 50';
  if(clean==='NSEBANK'||clean==='BANKNIFTY') return 'NSE:NIFTY BANK';
  if(clean==='CNXIT') return 'NSE:NIFTY IT';
  return `NSE:${clean}`;
}

async function fetchKitePrices(symbols) {
  if (!kiteReady()) return null;
  try {
    const kiteSyms = symbols.map(toKiteSymbol);
    const params = kiteSyms.map(s => `i=${encodeURIComponent(s)}`).join('&');
    const resp = await axios.get(`${KITE_BASE}/quote?${params}`, {
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${KITE_API_KEY}:${KITE.accessToken}`,
      },
      timeout: 8000,
    });
    const data = resp.data.data || {};
    const result = {};
    symbols.forEach(sym => {
      const kiteSym = toKiteSymbol(sym);
      const q = data[kiteSym];
      if (q) {
        result[sym] = {
          sym,
          price: q.last_price,
          prevClose: q.ohlc?.close || q.last_price,
          changePct: q.ohlc?.close ? +((q.last_price - q.ohlc.close) / q.ohlc.close * 100).toFixed(2) : 0,
          high: q.ohlc?.high || q.last_price,
          low:  q.ohlc?.low  || q.last_price,
          open: q.ohlc?.open || q.last_price,
          volume: q.volume_traded || 0,
          marketState: 'REGULAR', // if Kite returns data, market is open
          source: 'kite',
          fetchedAt: new Date().toISOString(),
        };
      }
    });
    return result;
  } catch(e) {
    console.warn('[Kite] Price fetch failed:', e.response?.data?.message || e.message);
    // If token expired/invalid, clear it
    if (e.response?.status === 403) {
      KITE.accessToken = null;
      console.log('[Kite] Token expired — cleared. User needs to login again.');
    }
    return null;
  }
}

// ─── INDICATORS ──────────────────────────────────────────────────────────────
function ema(v,p){if(v.length<p)return[];const k=2/(p+1);const r=[v.slice(0,p).reduce((a,b)=>a+b,0)/p];for(let i=p;i<v.length;i++)r.push(v[i]*k+r[r.length-1]*(1-k));return r;}
function rsi(c,p=14){if(c.length<p+1)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}return al===0?100:+(100-100/(1+ag/al)).toFixed(1);}
function macd(c){if(c.length<26)return null;const e12=ema(c,12),e26=ema(c,26);const off=c.length-e26.length;const ml=e26.map((v,i)=>e12[i+off]-v);const sg=ema(ml,9);const lm=ml[ml.length-1],ls=sg[sg.length-1];const pm=ml[ml.length-2],ps=sg[sg.length-2];return{macd:+lm.toFixed(3),signal:+ls.toFixed(3),histogram:+(lm-ls).toFixed(3),crossover:pm<ps&&lm>ls?'bullish':pm>ps&&lm<ls?'bearish':'none',rising:(lm-ls)>(pm-ps)};}
function bb(c,p=20,sd=2){if(c.length<p)return null;const sl=c.slice(-p),m=sl.reduce((a,b)=>a+b,0)/p;const std=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);const last=c[c.length-1],up=m+sd*std,lo=m-sd*std;return{upper:+up.toFixed(2),middle:+m.toFixed(2),lower:+lo.toFixed(2),pctB:std===0?0.5:+((last-lo)/(up-lo)).toFixed(3),bandwidth:+(((up-lo)/m)*100).toFixed(2),squeeze:((up-lo)/m)<0.035};}
function stoch(h,l,c,kp=14,dp=3){if(c.length<kp)return null;const kv=[];for(let i=kp-1;i<c.length;i++){const hh=Math.max(...h.slice(i-kp+1,i+1)),ll=Math.min(...l.slice(i-kp+1,i+1));kv.push(hh===ll?50:(c[i]-ll)/(hh-ll)*100);}const dv=ema(kv,dp);const lk=kv[kv.length-1],ld=dv[dv.length-1];const pk=kv[kv.length-2],pd=dv[dv.length-2];return{k:+lk.toFixed(1),d:+ld.toFixed(1),overbought:lk>80,oversold:lk<20,crossover:pk<pd&&lk>ld?'bullish':pk>pd&&lk<ld?'bearish':'none'};}
function atr(h,l,c,p=14){if(c.length<p+1)return null;const trs=c.slice(1).map((_,i)=>Math.max(h[i+1]-l[i+1],Math.abs(h[i+1]-c[i]),Math.abs(l[i+1]-c[i])));return+(trs.slice(-p).reduce((a,b)=>a+b,0)/p).toFixed(2);}
function adx(h,l,c,p=14){if(c.length<p*2)return null;const pd=[],md=[],tr=[];for(let i=1;i<c.length;i++){const um=h[i]-h[i-1],dm=l[i-1]-l[i];pd.push(um>dm&&um>0?um:0);md.push(dm>um&&dm>0?dm:0);tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}const st=tr.slice(-p).reduce((a,b)=>a+b,0);if(!st)return null;const pi=(pd.slice(-p).reduce((a,b)=>a+b,0)/st)*100;const mi=(md.slice(-p).reduce((a,b)=>a+b,0)/st)*100;const dx=Math.abs(pi-mi)/(pi+mi)*100;return{adx:+dx.toFixed(1),plusDI:+pi.toFixed(1),minusDI:+mi.toFixed(1),trending:dx>25};}
function vwap(candles){let tv=0,vl=0;for(const c of candles){const tp=(c.h+c.l+c.c)/3;tv+=tp*c.v;vl+=c.v;}return vl>0?+(tv/vl).toFixed(2):null;}
function indicators(candles){if(!candles||candles.length<5)return{};const c=candles.map(x=>x.c),h=candles.map(x=>x.h),l=candles.map(x=>x.l);const e8=ema(c,8),e21=ema(c,21),e50=ema(c,50),e200=ema(c,200);const last=c[c.length-1];const e21l=e21[e21.length-1],e50l=e50.length?e50[e50.length-1]:null;const e200l=e200.length?e200[e200.length-1]:null;return{ema:{ema8:e8.length?+e8[e8.length-1].toFixed(2):null,ema21:e21.length?+e21l.toFixed(2):null,ema50:e50l?+e50l.toFixed(2):null,ema200:e200l?+e200l.toFixed(2):null,trend:e8.length&&e21.length?(e8[e8.length-1]>e21l?'bullish':'bearish'):'unknown',goldenCross:e50l&&e200l?e50l>e200l:null,priceVsEma21:e21l?+((last-e21l)/e21l*100).toFixed(2):null,ema21Slope:e21.length>=3?+((e21l-e21[e21.length-3])/e21[e21.length-3]*100).toFixed(3):null},rsi:rsi(c),macd:macd(c),bb:bb(c),stoch:stoch(h,l,c),atr:atr(h,l,c),adx:adx(h,l,c),vwap:vwap(candles)};}

// ─── PATTERN DETECTION ────────────────────────────────────────────────────────
function detectPatterns(candles,ind){if(!candles||candles.length<5)return[];const pats=[];const n=candles.length;const last=candles[n-1],prev=candles[n-2];const body=x=>Math.abs(x.c-x.o);const range=x=>x.h-x.l;const green=x=>x.c>x.o;const red=x=>x.c<x.o;const trend=x=>range(x)>0&&body(x)/range(x)>0.6;const doji=x=>range(x)>0&&body(x)/range(x)<0.25;const uwk=x=>green(x)?x.h-x.c:x.h-x.o;const lwk=x=>green(x)?x.o-x.l:x.c-x.l;const c=candles.map(x=>x.c);const h=candles.map(x=>x.h);const l=candles.map(x=>x.l);const avg8range=candles.slice(-8).reduce((s,x)=>s+range(x),0)/8;
if(trend(last)&&green(last))pats.push({name:'Brooks: Bull trend bar',dir:'bull',str:3,detail:`Body ${(body(last)/range(last)*100).toFixed(0)}% of range`});
if(trend(last)&&red(last))pats.push({name:'Brooks: Bear trend bar',dir:'bear',str:3,detail:`Body ${(body(last)/range(last)*100).toFixed(0)}% of range`});
if(doji(last))pats.push({name:'Brooks: Doji — indecision',dir:'neutral',str:1,detail:'Small body'});
if(n>=6){const imp=candles[n-6];const pb=candles.slice(n-5,n-1);if(trend(imp)&&green(imp)&&pb.every(x=>x.l>imp.l)&&range(candles[n-2])<range(candles[n-4])*0.8)pats.push({name:'Brooks: Bull flag',dir:'bull',str:5,detail:'Tight pullback after impulse'});}
if(n>=6){const imp=candles[n-6];const pb=candles.slice(n-5,n-1);if(trend(imp)&&red(imp)&&pb.every(x=>x.h<imp.h)&&range(candles[n-2])<range(candles[n-4])*0.8)pats.push({name:'Brooks: Bear flag',dir:'bear',str:5,detail:'Tight rally after impulse'});}
if(Math.abs(last.h-prev.h)<range(last)*0.3&&red(last)&&last.h>prev.h*0.997)pats.push({name:'Brooks: Micro double top',dir:'bear',str:4,detail:`Twin highs ~₹${last.h.toFixed(1)}`});
if(Math.abs(last.l-prev.l)<range(last)*0.3&&green(last)&&last.l<prev.l*1.003)pats.push({name:'Brooks: Micro double bottom',dir:'bull',str:4,detail:`Twin lows ~₹${last.l.toFixed(1)}`});
if(range(last)>avg8range*2.5&&green(last)&&uwk(last)>body(last))pats.push({name:'Brooks: Buy climax — exhaustion',dir:'bear',str:4,detail:'Outsized green bar with upper wick'});
if(range(last)>avg8range*2.5&&red(last)&&lwk(last)>body(last))pats.push({name:'Brooks: Sell climax — exhaustion',dir:'bull',str:4,detail:'Outsized red bar with lower wick'});
if(n>=10){const swH=Math.max(...h.slice(-10,-2));if(prev.h>swH&&last.c<swH&&red(last))pats.push({name:'Brooks: Failed breakout (bull trap)',dir:'bear',str:5,detail:`Broke ${swH.toFixed(1)}, closed back below`});const swL=Math.min(...l.slice(-10,-2));if(prev.l<swL&&last.c>swL&&green(last))pats.push({name:'Brooks: Failed breakdown (bear trap)',dir:'bull',str:5,detail:`Broke below ${swL.toFixed(1)}, recovered`});}
if(n>=5){const l1=Math.min(candles[n-4].l,candles[n-3].l);const l2=Math.min(candles[n-2].l,candles[n-1].l);if(l2>l1&&green(last)&&trend(last))pats.push({name:'Brooks: H2 — two-legged pullback buy',dir:'bull',str:5,detail:'Higher second low in uptrend'});}
if(n>=5){const h1=Math.max(candles[n-4].h,candles[n-3].h);const h2=Math.max(candles[n-2].h,candles[n-1].h);if(h2<h1&&red(last)&&trend(last))pats.push({name:'Brooks: L2 — two-legged pullback short',dir:'bear',str:5,detail:'Lower second high in downtrend'});}
if(ind?.ema?.ema21){const e21=ind.ema.ema21;if(prev.l<=e21*1.005&&last.c>e21&&green(last)&&trend(last))pats.push({name:'Brooks: EMA21 bounce',dir:'bull',str:5,detail:`Touched EMA21 (₹${e21}), reversed up`});if(prev.h>=e21*0.995&&last.c<e21&&red(last)&&trend(last))pats.push({name:'Brooks: EMA21 rejection',dir:'bear',str:5,detail:`Touched EMA21 (₹${e21}), reversed down`});}
const r3=candles.slice(-3).reduce((s,x)=>s+range(x),0)/3;const r8=candles.slice(-8).reduce((s,x)=>s+range(x),0)/8;
if(r3<r8*0.45)pats.push({name:'Volman: Tight congestion',dir:'neutral',str:3,detail:'Breakout imminent'});
if(n>=8){const br=candles[n-5],pb=candles.slice(n-4,n-1);if(trend(br)&&green(br)&&pb.every(x=>x.l>br.o)&&green(last))pats.push({name:'Volman: Breakout-pullback (long)',dir:'bull',str:6,detail:'Broke out, pulled back, resuming'});if(trend(br)&&red(br)&&pb.every(x=>x.h<br.o)&&red(last))pats.push({name:'Volman: Breakout-pullback (short)',dir:'bear',str:6,detail:'Broke down, rallied, resuming'});}
if(trend(last)&&trend(prev)&&green(last)&&green(prev))pats.push({name:'Volman: Double pressure (bull)',dir:'bull',str:4,detail:'Two consecutive bull trend bars'});
if(trend(last)&&trend(prev)&&red(last)&&red(prev))pats.push({name:'Volman: Double pressure (bear)',dir:'bear',str:4,detail:'Two consecutive bear trend bars'});
if(n>=15){const sup=Math.min(...l.slice(-15,-3));if(prev.l<sup&&last.c>sup&&green(last)&&range(last)>avg8range)pats.push({name:'Wyckoff: Spring',dir:'bull',str:6,detail:`Shakeout below ₹${sup.toFixed(1)}, recovered`});const res=Math.max(...h.slice(-15,-3));if(prev.h>res&&last.c<res&&red(last)&&range(last)>avg8range)pats.push({name:'Wyckoff: UTAD',dir:'bear',str:6,detail:`Failed above ₹${res.toFixed(1)}`});}
if(ind?.ema?.ema50&&ind?.ema?.ema200){const p=last.c,e50=ind.ema.ema50,e200=ind.ema.ema200;if(p>e50&&p>e200&&e50>e200)pats.push({name:'Weinstein: Stage 2 uptrend',dir:'bull',str:3,detail:'Price>EMA50>EMA200'});if(p<e50&&p<e200&&e50<e200)pats.push({name:'Weinstein: Stage 4 downtrend',dir:'bear',str:3,detail:'Price<EMA50<EMA200'});}
if(last.o>last.h-(range(last)*0.1)&&last.c<last.l+(range(last)*0.2))pats.push({name:'Raschke: 80-20 bearish',dir:'bear',str:4,detail:'Open near high, close near low'});
if(last.o<last.l+(range(last)*0.1)&&last.c>last.h-(range(last)*0.2))pats.push({name:'Raschke: 80-20 bullish',dir:'bull',str:4,detail:'Open near low, close near high'});
return pats;}

// ─── SCORING ─────────────────────────────────────────────────────────────────
function scoreForScreen(d){if(!d.price||d.error)return null;const ind=d.indicators||{};const pats=d.patterns||[];let score=0;const reasons=[];for(const p of pats){score+=p.str;if(p.str>=4)reasons.push(`${p.name.split(':')[0]}: ${p.name.split(':')[1]?.trim()||p.name}`);}
if(ind.macd?.crossover==='bullish'){score+=3;reasons.push('MACD bullish cross');}if(ind.macd?.crossover==='bearish'){score+=3;reasons.push('MACD bearish cross');}if(ind.macd?.rising&&ind.macd?.histogram>0){score+=1;reasons.push('MACD hist rising');}
if(ind.rsi!==null){if(ind.rsi<30){score+=3;reasons.push(`RSI oversold ${ind.rsi}`);}if(ind.rsi>70){score+=3;reasons.push(`RSI overbought ${ind.rsi}`);}if(ind.rsi>55&&ind.rsi<70){score+=1;reasons.push(`RSI bull zone ${ind.rsi}`);}}
if(ind.bb?.squeeze){score+=3;reasons.push('BB squeeze');}if(ind.bb?.pctB<0.05){score+=2;reasons.push('At lower BB');}if(ind.bb?.pctB>0.95){score+=2;reasons.push('At upper BB');}
if(ind.stoch?.crossover==='bullish'){score+=2;reasons.push('Stoch bull cross');}if(ind.stoch?.crossover==='bearish'){score+=2;reasons.push('Stoch bear cross');}
if(ind.adx?.trending&&ind.adx?.adx>30){score+=2;reasons.push(`ADX ${ind.adx.adx} trending`);}
if(d.volRatio>1.5){score+=2;reasons.push(`Vol ${d.volRatio}x avg`);}if(d.volRatio>2.5){score+=1;reasons.push('Extreme volume');}
const dayRangePct=d.low>0?(d.high-d.low)/d.low*100:0;if(dayRangePct>2.5){score+=1;reasons.push(`Wide range ${dayRangePct.toFixed(1)}%`);}
if(score<8)return null;return{...d,screenScore:score,screenReasons:reasons};}

// ─── YAHOO FETCH (daily — for screener) ──────────────────────────────────────
async function fetchDaily(sym){try{const r=await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=6mo`,{headers:YF_HDR,timeout:10000});const result=r.data?.chart?.result?.[0];if(!result)return{sym:sym.replace(/\.NS|\.BO|\^/g,''),error:'No data'};const meta=result.meta||{};const q=result.indicators?.quote?.[0]||{};const ts=result.timestamp||[];const dc=ts.map((t,i)=>({t:new Date(t*1000).toISOString().split('T')[0],o:q.open?.[i]!=null?+q.open[i].toFixed(2):null,h:q.high?.[i]!=null?+q.high[i].toFixed(2):null,l:q.low?.[i]!=null?+q.low[i].toFixed(2):null,c:q.close?.[i]!=null?+q.close[i].toFixed(2):null,v:q.volume?.[i]||0})).filter(c=>c.c!=null&&c.h!=null&&c.l!=null);const price=meta.regularMarketPrice||(dc.length?dc[dc.length-1].c:0);const prev=meta.chartPreviousClose||price;const vols=dc.map(x=>x.v).filter(v=>v>0);const avgVol=vols.length?vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(vols.length,20):1;const lastVol=vols[vols.length-1]||0;const ind=indicators(dc);const pats=detectPatterns(dc,ind);const symClean=sym.replace('.NS','').replace('.BO','').replace('^','');return{sym:symClean,yfSym:sym,price:+price.toFixed(2),open:+(meta.regularMarketOpen||price).toFixed(2),high:+(meta.regularMarketDayHigh||(dc.length?dc[dc.length-1].h:price)).toFixed(2),low:+(meta.regularMarketDayLow||(dc.length?dc[dc.length-1].l:price)).toFixed(2),prevClose:+prev.toFixed(2),changePct:+((price-prev)/prev*100).toFixed(2),volume:lastVol,avgVolume:Math.round(avgVol),volRatio:avgVol>0?+(lastVol/avgVol).toFixed(2):0,marketState:meta.marketState||'CLOSED',currency:meta.currency||'INR',swingHigh:dc.length?+(Math.max(...dc.slice(-20).map(x=>x.h))).toFixed(2):0,swingLow:dc.length?+(Math.min(...dc.slice(-20).map(x=>x.l))).toFixed(2):0,last5Daily:dc.slice(-5).map(c=>`${c.t}:O${c.o}H${c.h}L${c.l}C${c.c}`).join(' | '),indicators:ind,patterns:pats,dailyBars:dc.length,fetchedAt:new Date().toISOString()};}catch(e){return{sym:sym.replace(/\.NS|\.BO|\^/g,''),error:e.response?.status===429?'Rate limited':e.message};}}

// Yahoo fresh price fallback
async function fetchYahooFreshPrice(sym){try{const yfSym=sym.includes('.')||sym.startsWith('^')?sym:sym+'.NS';const r=await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1m&range=1d&includePrePost=false`,{headers:YF_HDR,timeout:8000});const result=r.data?.chart?.result?.[0];if(!result)throw new Error('No data');const meta=result.meta||{};const price=meta.regularMarketPrice||meta.previousClose||0;const prev=meta.chartPreviousClose||price;const symClean=sym.replace('.NS','').replace('.BO','').replace('^','');return{sym:symClean,price:+price.toFixed(2),prevClose:+prev.toFixed(2),changePct:prev>0?+((price-prev)/prev*100).toFixed(2):0,high:+(meta.regularMarketDayHigh||price).toFixed(2),low:+(meta.regularMarketDayLow||price).toFixed(2),open:+(meta.regularMarketOpen||price).toFixed(2),marketState:meta.marketState||'CLOSED',source:'yahoo',fetchedAt:new Date().toISOString()};}catch(e){return{sym,error:e.message};}}

async function fetchLive(stock){try{const r=await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.yfSym)}?interval=5m&range=1d&includePrePost=false`,{headers:YF_HDR,timeout:10000});const result=r.data?.chart?.result?.[0];if(!result)return stock;const q=result.indicators?.quote?.[0]||{};const ts=result.timestamp||[];const ic=ts.map((t,i)=>({t:new Date(t*1000).toISOString(),o:q.open?.[i]!=null?+q.open[i].toFixed(2):null,h:q.high?.[i]!=null?+q.high[i].toFixed(2):null,l:q.low?.[i]!=null?+q.low[i].toFixed(2):null,c:q.close?.[i]!=null?+q.close[i].toFixed(2):null,v:q.volume?.[i]||0})).filter(c=>c.c!=null&&c.h!=null&&c.l!=null);const meta=result.meta||{};const freshPrice=meta.regularMarketPrice||stock.price;const intInd=ic.length>=10?indicators(ic):null;const intPats=ic.length>=8?detectPatterns(ic,intInd||stock.indicators):[];return{...stock,price:+freshPrice.toFixed(2),marketState:meta.marketState||stock.marketState,intradayIndicators:intInd,intradayPatterns:intPats,last8Intraday:ic.slice(-8).map(c=>`O${c.o}H${c.h}L${c.l}C${c.c}`).join(' '),intradayBars:ic.length,liveAt:new Date().toISOString()};}catch(e){return stock;}}

// ─── TIER 1 & 2 ──────────────────────────────────────────────────────────────
async function runTier1(){if(CACHE.tier1Running)return;CACHE.tier1Running=true;CACHE.tier1Progress={scanned:0,total:NSE_UNIVERSE.length,status:'running'};console.log(`[${new Date().toISOString()}] Tier1 started — ${NSE_UNIVERSE.length} stocks`);const results=[];const batchSize=10;for(let i=0;i<NSE_UNIVERSE.length;i+=batchSize){const batch=NSE_UNIVERSE.slice(i,i+batchSize);const fetched=await Promise.allSettled(batch.map(fetchDaily));fetched.forEach(r=>{if(r.status==='fulfilled'&&r.value&&!r.value.error){const scored=scoreForScreen(r.value);if(scored)results.push(scored);}});CACHE.tier1Progress.scanned=Math.min(i+batchSize,NSE_UNIVERSE.length);if(i+batchSize<NSE_UNIVERSE.length)await new Promise(r=>setTimeout(r,400));}results.sort((a,b)=>b.screenScore-a.screenScore);CACHE.tier1=results.slice(0,40);CACHE.tier1At=new Date().toISOString();CACHE.tier1Running=false;CACHE.tier1Progress.status='done';console.log(`[${new Date().toISOString()}] Tier1 done — ${results.length} passed, top 40 cached`);}

async function runTier2(){if(!CACHE.tier1.length)return[];console.log(`[${new Date().toISOString()}] Tier2 live refresh`);const batchSize=10;const results=[];for(let i=0;i<CACHE.tier1.length;i+=batchSize){const batch=CACHE.tier1.slice(i,i+batchSize);const refreshed=await Promise.allSettled(batch.map(fetchLive));refreshed.forEach(r=>{if(r.status==='fulfilled'&&r.value)results.push(r.value);});if(i+batchSize<CACHE.tier1.length)await new Promise(r=>setTimeout(r,300));}const rescored=results.map(d=>{const allPats=[...(d.patterns||[]),...(d.intradayPatterns||[])];const scored=scoreForScreen({...d,patterns:allPats});return scored||d;});rescored.sort((a,b)=>(b.screenScore||0)-(a.screenScore||0));CACHE.tier2=rescored;CACHE.tier2At=new Date().toISOString();return rescored;}

runTier1();
setInterval(runTier1,55*60*1000);

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get('/',(req,res)=>res.json({name:'Signal Server v5.2 — Kite Connect + Yahoo fallback',kite:{ready:kiteReady(),authenticatedAt:KITE.authenticatedAt},universe:NSE_UNIVERSE.length,tier1:{cached:CACHE.tier1.length,at:CACHE.tier1At,running:CACHE.tier1Running},tier2:{cached:CACHE.tier2.length,at:CACHE.tier2At}}));

app.get('/health',(req,res)=>res.json({ok:true,uptime:Math.round(process.uptime())+'s',time:new Date().toISOString(),screenerReady:!!CACHE.tier1At,tier1Stocks:CACHE.tier1.length,kiteReady:kiteReady()}));

app.get('/status',(req,res)=>res.json({universe:NSE_UNIVERSE.length,tier1:{cached:CACHE.tier1.length,at:CACHE.tier1At,running:CACHE.tier1Running,progress:CACHE.tier1Progress},tier2:{cached:CACHE.tier2.length,at:CACHE.tier2At},kite:{ready:kiteReady(),authenticatedAt:KITE.authenticatedAt}}));

app.get('/generate',async(req,res)=>{if(!CACHE.tier1.length){return res.json({error:'Tier1 still running. Wait 2-3 min.',tier1Progress:CACHE.tier1Progress});}const live=await runTier2();res.json({scanned:NSE_UNIVERSE.length,tier1Shortlisted:CACHE.tier1.length,tier2Refreshed:live.length,tier1At:CACHE.tier1At,tier2At:CACHE.tier2At,stocks:live.slice(0,20)});});

// ★ PRICES — Kite first, Yahoo fallback
app.get('/prices',async(req,res)=>{
  const raw=req.query.symbols||'';
  const syms=raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,40);
  if(!syms.length)return res.json({error:'Provide ?symbols=RELIANCE,HDFCBANK'});

  const data={};

  // Try Kite first (real-time, only works when authenticated)
  if(kiteReady()){
    const kiteData=await fetchKitePrices(syms);
    if(kiteData){Object.assign(data,kiteData);console.log(`[Prices] Kite served ${Object.keys(kiteData).length}/${syms.length} symbols`);}
  }

  // Yahoo fallback for any symbols Kite didn't cover
  const missing=syms.filter(s=>!data[s]);
  if(missing.length){
    const batchSize=5;
    for(let i=0;i<missing.length;i+=batchSize){
      const batch=missing.slice(i,i+batchSize);
      const results=await Promise.allSettled(batch.map(s=>fetchYahooFreshPrice(s)));
      results.forEach((r,idx)=>{
        const sym=batch[idx];
        if(r.status==='fulfilled'&&r.value&&!r.value.error){data[sym]=r.value;}
        else{const cached=[...CACHE.tier2,...CACHE.tier1].find(x=>x.sym===sym);if(cached)data[sym]={...cached,fromCache:true};else data[sym]={sym,error:'Fetch failed'};}
      });
      if(i+batchSize<missing.length)await new Promise(r=>setTimeout(r,200));
    }
  }

  res.json({fetchedAt:new Date().toISOString(),count:syms.length,kiteActive:kiteReady(),data});
});

app.get('/price/:symbol',async(req,res)=>{const sym=req.params.symbol.toUpperCase();if(kiteReady()){const kd=await fetchKitePrices([sym]);if(kd&&kd[sym])return res.json(kd[sym]);}const fresh=await fetchYahooFreshPrice(sym);if(!fresh.error)return res.json(fresh);const cached=[...CACHE.tier2,...CACHE.tier1].find(x=>x.sym===sym);if(cached)return res.json({...cached,fromCache:true});res.json(await fetchDaily(sym+'.NS'));});

app.get('/symbols',(req,res)=>res.json({count:NSE_UNIVERSE.length,universe:NSE_UNIVERSE}));

app.listen(PORT,'0.0.0.0',()=>console.log(`Signal server v5.2 on port ${PORT} — Kite Connect enabled`));
