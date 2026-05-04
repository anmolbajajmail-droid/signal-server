/**
 * SIGNAL SERVER v6.0 — H2 + RT Pattern Engine
 *
 * WHAT'S NEW in v6.0:
 *   - Tier 1: Pattern pre-filter (H2 + RT candidates) instead of RSI/MACD/ADX
 *   - Tier 1: Now uses Kite API for 5-min candles (Yahoo was unreliable)
 *   - Tier 1: Runs every 20 min (was 55 min) — catches setups as they form
 *   - Tier 1: Market hours gate — only runs 9:15-14:30 IST on weekdays
 *   - Tier 2: Full H2+RT scoring with entry/stop/target on each signal
 *   - Alerts: Structured format — DRREDDY H2 BULL sc=74 entry=1182 stop=1179 target=1187
 *   - RT filters: F3≥14 + block 14:xx + stop floor ≥0.5×ATR
 *   - Capital cap: shares = min(risk/stopDist, capital/entryPrice)
 *   - All Yahoo Finance removed from screener (Kite only, Yahoo only for /prices fallback)
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

let KITE = {
  accessToken: null,
  authenticatedAt: null,
  authenticatedDate: null,
};
function kiteToday() { return new Date().toISOString().split('T')[0]; }
function kiteReady() { return KITE.accessToken && KITE.authenticatedDate === kiteToday(); }

// ─── INSTRUMENT TOKEN MAP (symbol → Kite token) ───────────────────────────────
// Used by Tier 1 to fetch 5-min historical data via Kite API
const INSTRUMENT_TOKENS = {
  'RELIANCE':738561,'HDFCBANK':341249,'ICICIBANK':1270529,'INFY':408065,
  'TCS':2953217,'LT':2939649,'BAJFINANCE':81153,'SBIN':779521,
  'HINDUNILVR':356865,'AXISBANK':1510401,'KOTAKBANK':492033,'BHARTIARTL':2714625,
  'ASIANPAINT':60417,'MARUTI':2815745,'TITAN':897537,'WIPRO':969473,
  'ULTRACEMCO':2952193,'SUNPHARMA':857857,'HCLTECH':1850625,'TATAMOTORS':884737,
  'ADANIENT':424961,'NTPC':2977281,'POWERGRID':3834113,'ONGC':633601,
  'COALINDIA':1893249,'BAJAJFINSV':54273,'NESTLEIND':4598529,'DRREDDY':225537,
  'CIPLA':177537,'TECHM':3465729,'HEROMOTOCO':345089,'DIVISLAB':2800641,
  'EICHERMOT':232961,'BPCL':134657,'INDUSINDBK':1346049,'GRASIM':315393,
  'APOLLOHOSP':41729,'JSWSTEEL':3001089,'TATASTEEL':895745,'HINDALCO':348929,
  'ADANIPORTS':15083777,'BRITANNIA':140033,'TATACONSUM':878593,'SBILIFE':21001217,
  'HDFCLIFE':119062276,'LTIM':17818113,'BAJAJ-AUTO':4268801,'M&M':519937,
  'UPL':2889473,'SHREECEM':3771393,'PIDILITIND':650497,'SIEMENS':806401,
  'DABUR':197633,'GODREJCP':298369,'BERGEPAINT':1195009,'AMBUJACEM':1152769,
  'ACC':5633,'BOSCHLTD':1136385,'COLPAL':1837057,'HAVELLS':1512193,
  'MARICO':1041153,'MUTHOOTFIN':3400961,'PNB':2730497,'BANKBARODA':1195521,
  'CANBK':3049729,'VEDL':784129,'SAIL':758529,'NMDC':3145729,
  'HINDPETRO':359937,'IOC':415745,'GAIL':1207553,'PETRONET':2905857,
  'IGL':1215745,'TRENT':1598465,'NAUKRI':13209089,'ZOMATO':2123777,
  'IRCTC':3379969,'DMART':3900673,'CHOLAFIN':175361,'INDHOTEL':500209,
  'GODREJPROP':3061633,'DLF':3771393,'COFORGE':3358465,'PERSISTENT':685569,
  'MPHASIS':4125697,'LTTS':10751745,'KPITTECH':1614337,'TATATECH':23650049,
  'CYIENT':193537,'BIRLASOFT':3609857,'OFSS':621569,'HEXAWARE':3812609,
  'AUROPHARMA':69121,'BIOCON':3536129,'GLENMARK':305921,'LUPIN':2672641,
  'IPCALAB':3878913,'ALKEM':3748609,'TORNTPHARM':900609,'AJANTPHARM':14977,
  'MANKIND':17857793,'LALPATHLAB':2983169,'METROPOLIS':17884161,
  'MRF':3375617,'CEATLTD':158465,'APOLLOTYRE':41217,'BALKRISIND':85761,
  'TVSMOTOR':2170625,'MOTHERSON':4506753,'ENDURANCE':13209857,
  'FEDERALBNK':261889,'RBLBANK':4707329,'BANDHANBNK':2714369,
  'AUBANK':1629185,'IDFCFIRSTB':2863105,'YESBANK':3050241,
  'IDBI':3602433,'INDIANB':2865153,'UNIONBANK':2752769,
  'ABB':3765,'BHEL':112129,'CUMMINSIND':202241,'KEC':3672833,
  'NBCC':3050497,'NCC':3389697,'RVNL':3588673,'THERMAX':898049,
  'TATAPOWER':877057,'ADANIGREEN':2530049,'ADANIPOWER':2154753,
  'SUZLON':837633,'NHPC':3923713,'SJVN':3746817,
  'NATIONALUM':3004929,'HINDZINC':348929,'MOIL':3404801,'JSPL':3001089,
  'EMAMILTD':280833,'JYOTHYLAB':3015937,'JUBLFOOD':1195777,'VBL':2988801,
  'RECLTD':3739137,'SBICARD':10666497,'MOTILALOS':3424513,'ANGELONE':3771905,
  'LICHSGFIN':511233,'CANFINHOME':149249,'MFSL':1068545,'SUNDARMFIN':857345,
  'PRESTIGE':1790977,'SOBHA':3603969,'BRIGADE':3696641,'OBEROIRLTY':3633153,
  'DEEPAKNTR':2172929,'NAVINFLUOR':3016193,'SRF':3796225,'PIIND':3703041,
  'TATACHEM':871681,'TATACOMM':3035137,'VOLTAS':951809,'CROMPTON':3463681,
  'POLYCAB':3898241,'HAVELLS':1512193,'DIXON':3446529,'CONCOR':3063553,
};

// All stocks we scan — symbols only (Kite tokens looked up from map above)
const NSE_UNIVERSE = Object.keys(INSTRUMENT_TOKENS);

// ─── SECTOR MAP ───────────────────────────────────────────────────────────────
const SECTORS = {
  'RELIANCE':'Energy','ONGC':'Energy','COALINDIA':'Energy','BPCL':'Energy',
  'IOC':'Energy','GAIL':'Energy','PETRONET':'Energy','HINDPETRO':'Energy',
  'TATAPOWER':'Energy','ADANIPOWER':'Energy','ADANIGREEN':'Energy',
  'SUZLON':'Energy','NHPC':'Energy','SJVN':'Energy','IGL':'Energy',
  'HDFCBANK':'Banking','ICICIBANK':'Banking','SBIN':'Banking','AXISBANK':'Banking',
  'KOTAKBANK':'Banking','BAJFINANCE':'Finance','BAJAJFINSV':'Finance',
  'INDUSINDBK':'Banking','FEDERALBNK':'Banking','RBLBANK':'Banking',
  'BANDHANBNK':'Banking','AUBANK':'Banking','IDFCFIRSTB':'Banking',
  'YESBANK':'Banking','IDBI':'Banking','INDIANB':'Banking','UNIONBANK':'Banking',
  'PNB':'Banking','BANKBARODA':'Banking','CANBK':'Banking',
  'INFY':'IT','TCS':'IT','WIPRO':'IT','HCLTECH':'IT','TECHM':'IT',
  'LTIM':'IT','LTTS':'IT','MPHASIS':'IT','COFORGE':'IT','PERSISTENT':'IT',
  'KPITTECH':'IT','TATATECH':'IT','CYIENT':'IT','BIRLASOFT':'IT',
  'OFSS':'IT','HEXAWARE':'IT',
  'SUNPHARMA':'Pharma','DRREDDY':'Pharma','CIPLA':'Pharma','DIVISLAB':'Pharma',
  'AUROPHARMA':'Pharma','BIOCON':'Pharma','GLENMARK':'Pharma','LUPIN':'Pharma',
  'IPCALAB':'Pharma','ALKEM':'Pharma','TORNTPHARM':'Pharma','AJANTPHARM':'Pharma',
  'MANKIND':'Pharma','LALPATHLAB':'Pharma','METROPOLIS':'Pharma',
  'TATAMOTORS':'Auto','MARUTI':'Auto','EICHERMOT':'Auto','HEROMOTOCO':'Auto',
  'BAJAJ-AUTO':'Auto','M&M':'Auto','TVSMOTOR':'Auto','MRF':'Auto',
  'CEATLTD':'Auto','APOLLOTYRE':'Auto','BALKRISIND':'Auto','MOTHERSON':'Auto',
  'ENDURANCE':'Auto',
  'HINDUNILVR':'FMCG','NESTLEIND':'FMCG','BRITANNIA':'FMCG','DABUR':'FMCG',
  'MARICO':'FMCG','COLPAL':'FMCG','GODREJCP':'FMCG','EMAMILTD':'FMCG',
  'JYOTHYLAB':'FMCG','VBL':'FMCG',
  'JSWSTEEL':'Metals','TATASTEEL':'Metals','HINDALCO':'Metals','VEDL':'Metals',
  'SAIL':'Metals','NMDC':'Metals','NATIONALUM':'Metals','HINDZINC':'Metals',
  'MOIL':'Metals','JSPL':'Metals',
  'LT':'Infra','NTPC':'Infra','POWERGRID':'Infra','ADANIPORTS':'Infra',
  'ABB':'Infra','BHEL':'Infra','CUMMINSIND':'Infra','KEC':'Infra',
  'NBCC':'Infra','NCC':'Infra','RVNL':'Infra','THERMAX':'Infra',
  'ULTRACEMCO':'Cement','AMBUJACEM':'Cement','ACC':'Cement','SHREECEM':'Cement',
  'TITAN':'Consumer','TRENT':'Consumer','ASIANPAINT':'Consumer',
  'BERGEPAINT':'Consumer','PIDILITIND':'Consumer','HAVELLS':'Consumer',
  'POLYCAB':'Consumer','DIXON':'Consumer','VOLTAS':'Consumer','CROMPTON':'Consumer',
  'BHARTIARTL':'Telecom',
  'APOLLOHOSP':'Healthcare','SIEMENS':'Capital Goods',
  'RECLTD':'Finance','SBICARD':'Finance','MOTILALOS':'Finance',
  'LICHSGFIN':'Finance','CANFINHOME':'Finance','MFSL':'Finance','SUNDARMFIN':'Finance',
  'CHOLAFIN':'Finance','INDHOTEL':'Consumer','TATACONSUM':'FMCG',
  'JUBLFOOD':'Consumer','GODREJPROP':'Realty','DLF':'Realty',
  'PRESTIGE':'Realty','SOBHA':'Realty','BRIGADE':'Realty','OBEROIRLTY':'Realty',
  'DEEPAKNTR':'Chemicals','NAVINFLUOR':'Chemicals','SRF':'Chemicals','PIIND':'Chemicals',
  'TATACHEM':'Chemicals','IRCTC':'Consumer','NAUKRI':'IT','ZOMATO':'Consumer',
  'DMART':'Consumer','IGL':'Energy','GRASIM':'Cement','BOSCHLTD':'Auto',
  'CONCOR':'Infra','TATACHEM':'Chemicals','TATACOMM':'IT',
};

// ─── CACHE ────────────────────────────────────────────────────────────────────
let CACHE = {
  tier1H2: [],   // H2 candidates from pattern pre-filter
  tier1RT: [],   // RT candidates from pattern pre-filter
  tier1At: null,
  tier1Running: false,
  tier1Progress: { scanned: 0, total: 0, status: 'idle' },
  tier2: [],
  tier2At: null,
};

// ─── KITE ROUTES (unchanged from v5.2) ───────────────────────────────────────
app.get('/kite/login', (req, res) => {
  res.redirect(`https://kite.zerodha.com/connect/login?v=3&api_key=${KITE_API_KEY}`);
});

app.get('/kite/callback', async (req, res) => {
  const { request_token, status } = req.query;
  if (status !== 'success' || !request_token)
    return res.send('<h2>❌ Login failed.</h2><a href="/kite/login">Retry</a>');
  try {
    const checksum = crypto.createHash('sha256')
      .update(KITE_API_KEY + request_token + KITE_API_SECRET).digest('hex');
    const resp = await axios.post(`${KITE_BASE}/session/token`,
      new URLSearchParams({ api_key: KITE_API_KEY, request_token, checksum }).toString(),
      { headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    KITE.accessToken       = resp.data.data.access_token;
    KITE.authenticatedAt   = new Date().toISOString();
    KITE.authenticatedDate = kiteToday();
    console.log(`[Kite] Authenticated at ${KITE.authenticatedAt}`);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0d1117;color:#e6edf3">
      <h1 style="color:#3fb950">✅ Zerodha Connected!</h1>
      <p>Pattern screener is now active. Tier 1 scan will use live Kite data.</p>
      <p style="color:#8b949e">You can close this tab and return to your trading app.</p>
    </body></html>`);
  } catch(e) {
    console.error('[Kite] Auth failed:', e.response?.data || e.message);
    res.send(`<h2>❌ Auth failed: ${e.message}</h2><a href="/kite/login">Retry</a>`);
  }
});

app.get('/kite/status', (req, res) => res.json({
  ready: kiteReady(),
  authenticatedAt: KITE.authenticatedAt,
  authenticatedDate: KITE.authenticatedDate,
  today: kiteToday(),
  message: kiteReady()
    ? `✅ Kite active (${new Date(KITE.authenticatedAt).toLocaleTimeString('en-IN')})`
    : '⚠️ Not logged in — click Login with Zerodha',
}));

app.get('/kite/token', (req, res) => {
  if (!kiteReady()) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ ready: true, authenticatedAt: KITE.authenticatedAt });
});

app.get('/kite/historical', async (req, res) => {
  if (!kiteReady()) return res.status(401).json({ error: 'Not authenticated' });
  const { token, interval, from, to } = req.query;
  if (!token || !interval || !from || !to)
    return res.status(400).json({ error: 'Need: token, interval, from, to' });
  try {
    const url = `${KITE_BASE}/instruments/historical/${token}/${interval}?from=${from}&to=${to}&continuous=0&oi=0`;
    const resp = await axios.get(url, {
      headers: { 'X-Kite-Version': '3', 'Authorization': `token ${KITE_API_KEY}:${KITE.accessToken}` }
    });
    res.json(resp.data);
  } catch(e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ─── KITE 5-MIN HISTORICAL FETCH (for screener) ───────────────────────────────
async function fetchKite5Min(symbol) {
  const token = INSTRUMENT_TOKENS[symbol];
  if (!token) return null;
  if (!kiteReady()) return null;

  // Fetch last 2 sessions of 5-min data (enough for pattern detection)
  const now   = new Date();
  const from  = new Date(now); from.setDate(from.getDate() - 3); // 3 days back covers weekends
  const fromStr = from.toISOString().split('T')[0];
  const toStr   = now.toISOString().split('T')[0];

  try {
    const url = `${KITE_BASE}/instruments/historical/${token}/5minute?from=${fromStr}&to=${toStr}&continuous=0&oi=0`;
    const resp = await axios.get(url, {
      headers: { 'X-Kite-Version': '3', 'Authorization': `token ${KITE_API_KEY}:${KITE.accessToken}` },
      timeout: 8000,
    });
    const candles = (resp.data?.data?.candles || []).map(c => ({
      t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5]
    })).filter(c => c.c > 0);
    return candles.length >= 10 ? candles : null;
  } catch(e) {
    if (e.response?.status === 403) {
      KITE.accessToken = null;
      console.log('[Kite] Token expired');
    }
    return null;
  }
}

// ─── PATTERN ENGINE FUNCTIONS ─────────────────────────────────────────────────

function computeATR(candles, period = 14) {
  if (candles.length < 2) return candles[0] ? candles[0].h - candles[0].l : 1;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    ));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function computeMicroZones(candles) {
  const n = candles.length;
  if (n < 4) return [];
  const bm = new Array(n).fill('flat');
  if (candles[0].c > candles[0].o) bm[0] = 'up';
  else if (candles[0].c < candles[0].o) bm[0] = 'down';
  for (let i = 1; i < n; i++) {
    const chg = (candles[i].c - candles[i-1].c) / candles[i-1].c * 100;
    if (chg > 0.005) bm[i] = 'up';
    else if (chg < -0.005) bm[i] = 'down';
    else if (candles[i].c < candles[i].o) bm[i] = 'down';
    else if (candles[i].c > candles[i].o) bm[i] = 'up';
  }
  const bd = new Array(n).fill('range');
  let i = 1;
  while (i < n) {
    let rd = bm[i]; if (rd === 'flat') { i++; continue; }
    let re = i, ints = 0;
    for (let j = i+1; j < n; j++) {
      if (bm[j] === rd) { re = j; ints = 0; }
      else if (bm[j] === 'flat' && ints < 1) ints++;
      else break;
    }
    let rs = i; if (i > 0 && bm[i-1] === rd && bd[i-1] === 'range') rs = i-1;
    const rl = re - rs + 1;
    if (rl >= 3) {
      const sp = rs > 0 ? candles[rs-1].c : candles[0].o;
      const tm = (candles[re].c - sp) / sp * 100;
      if ((rd === 'down' && tm < -0.15) || (rd === 'up' && tm > 0.15)) {
        for (let k = rs; k <= re; k++) bd[k] = rd; i = re + 1; continue;
      }
    }
    i++;
  }
  // Two-bar sharp override
  for (let i = 1; i < n-1; i++) {
    if (bm[i] !== bm[i+1] || bm[i] === 'flat') continue;
    const tm = (candles[i+1].c - candles[i-1].c) / candles[i-1].c * 100;
    if ((bm[i] === 'up' && tm > 0.25) || (bm[i] === 'down' && tm < -0.25)) {
      bd[i] = bm[i]; bd[i+1] = bm[i];
    }
  }
  // Build zones
  const raw = []; let zs = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || bd[i] !== bd[i-1]) {
      raw.push({ start: zs, end: i-1, dir: bd[i-1], bars: i-zs }); zs = i;
    }
  }
  // Merge and absorb tiny zones
  const mg = [];
  raw.forEach(z => {
    const p = mg[mg.length-1];
    if (p && p.dir === z.dir) { p.end = z.end; p.bars += z.bars; }
    else mg.push({...z});
  });
  const ab = [];
  mg.forEach(z => {
    if (z.bars >= 4) ab.push({...z});
    else { const p = ab[ab.length-1]; if (p) { p.end = z.end; p.bars += z.bars; } else ab.push({...z}); }
  });
  const atr = computeATR(candles);
  return ab.map(z => {
    if (z.dir === 'range') return z;
    const nm = Math.abs(candles[z.end].c - candles[z.start].c);
    return nm < atr * 0.5 ? {...z, dir:'range'} : z;
  });
}

function computeSR(candles) {
  const n = candles.length;
  if (n < 20) return { supports: [], resistances: [] };
  const atr = computeATR(candles);
  const touchTol = atr * 0.5;
  const curPrice = candles[n-1].c;
  const priceTol = curPrice * 0.06;
  const avgVol   = candles.reduce((s, b) => s + b.v, 0) / n || 1;
  const minCD    = atr * 0.3;

  const gaps = new Set(); let pC = null, pD = null;
  candles.forEach((b, i) => {
    const d = b.t.slice(0, 10);
    if (pD && d !== pD && pC && Math.abs(b.o - pC) / pC > 0.003) gaps.add(i);
    pC = b.c; pD = d;
  });

  const pLB = 4; const sH = [], sL = [];
  for (let i = pLB; i < n - pLB; i++) {
    if (gaps.has(i)) continue;
    let pH = true, pLo = true;
    for (let j = i-pLB; j <= i+pLB; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) pH = false;
      if (candles[j].l <= candles[i].l) pLo = false;
    }
    if (pH) sH.push(candles[i].h);
    if (pLo) sL.push(candles[i].l);
  }

  const snap = p => { const s = Math.max(atr * 0.5, 0.5); return Math.round(p / s) * s; };
  const cands = new Set();
  [...sH, ...sL].forEach(x => cands.add(snap(x)));
  candles.forEach((b, i) => { if (gaps.has(i)) return; cands.add(snap(b.h)); cands.add(snap(b.l)); });

  const tDay = candles[n-1].t.slice(0, 10);
  const rej = [];
  cands.forEach(level => {
    if (Math.abs(level - curPrice) > priceTol) return;
    const rR = [], rS = [];
    candles.forEach((b, i) => {
      if (gaps.has(i) || i === 0) return;
      const vm = b.v > avgVol * 1.5 ? 1.3 : 1;
      const br = b.h - b.l || 1;
      const isT = b.t.slice(0, 10) === tDay;
      const pb = candles[i-1];
      if (pb.c < level && Math.abs(b.h - level) <= touchTol && b.c < level - minCD)
        rR.push({ q: Math.min((level - b.c) / br, 1) * vm, t: isT });
      if (pb.c > level && Math.abs(b.l - level) <= touchTol && b.c > level + minCD)
        rS.push({ q: Math.min((b.c - level) / br, 1) * vm, t: isT });
    });
    const scoreR = (rs, tp) => {
      if (!rs.length) return;
      const pr = rs.filter(r => !r.t), td = rs.filter(r => r.t);
      const np = pr.length, nt = td.length;
      let sp = np>=3?60:np===2?45:np===1?25:nt>=3?15:nt>=2?8:0;
      if (!sp) return;
      const aq = rs.reduce((s, r) => s + r.q, 0) / rs.length;
      rej.push({ level, type: tp, score: (sp + aq*40)/100, priorDayTouches: np });
    };
    scoreR(rR, 'res'); scoreR(rS, 'sup');
  });

  rej.sort((a, b) => b.score - a.score);
  const ded = [];
  rej.forEach(l => {
    if (!ded.find(d => d.type === l.type && Math.abs(d.level - l.level) <= touchTol * 2))
      ded.push(l);
  });
  return {
    supports:    ded.filter(l => l.type === 'sup').slice(0, 6),
    resistances: ded.filter(l => l.type === 'res').slice(0, 6),
    atr,
  };
}

// ─── H2 PULLBACK SCORING ──────────────────────────────────────────────────────
function findH2Signals(candles, zones, sr, atr, minScore = 60) {
  const n = candles.length;
  const atrV = atr;
  const allSR = [...(sr.supports || []), ...(sr.resistances || [])];
  const signals = [];
  const lastPB = { bull: null, bear: null };

  function gpbc(dir, pbStart, cm) {
    const pv = lastPB[dir];
    if (pv && (pbStart - pv.bar) <= 60 && cm <= atrV * 2) return pv.count + 1;
    return 1;
  }
  function mcm(fb, tb, iu) {
    let ext = candles[fb].c;
    for (let k = fb; k <= Math.min(tb, n-1); k++) {
      ext = iu ? Math.min(ext, candles[k].l) : Math.max(ext, candles[k].h);
    }
    return Math.abs(ext - candles[fb].c);
  }

  for (let zi = 0; zi < zones.length; zi++) {
    const pz = zones[zi];
    if (pz.dir === 'range' || pz.bars < 3) continue;
    const iu = pz.dir === 'up';
    const ps = pz.start, pe = pz.end;
    if (pe + 3 >= n) continue;

    // Merge consecutive same-dir zones
    let me = pe, zi2 = zi + 1;
    while (zi2 < zones.length) {
      const nz = zones[zi2];
      if (nz.dir !== pz.dir) break;
      const nm = Math.abs(candles[nz.end].c - candles[nz.start].c);
      const pm = Math.abs(candles[me].c - candles[ps].c);
      if (nm > pm * 0.3) break;
      me = nz.end; zi2++;
    }

    const pushMove = Math.abs(candles[me].c - candles[ps].c);
    if (pushMove < atrV * 0.5) continue;
    const pushExtreme = iu
      ? Math.max(...candles.slice(ps, me+1).map(b => b.h))
      : Math.min(...candles.slice(ps, me+1).map(b => b.l));
    const pushVol  = candles.slice(ps, me+1).reduce((s, b) => s + b.v, 0) / (me - ps + 1);
    const volPre   = candles.slice(Math.max(0, ps-20), ps).map(b => b.v);
    const avgVolPre = volPre.length ? volPre.reduce((a, b) => a+b, 0) / volPre.length : pushVol;
    let p1 = pushMove >= atrV*1.5 ? 15 : pushMove >= atrV ? 10 : pushMove >= atrV*0.5 ? 5 : 0;
    if (pushVol > avgVolPre * 1.2) p1 = Math.min(p1 + 3, 15);

    // Find pullback zone
    let pbz = null;
    for (let zj = zi2; zj < Math.min(zi2+5, zones.length); zj++) {
      const cz = zones[zj];
      const isC = cz.dir === 'range' || (iu && cz.dir === 'down') || (!iu && cz.dir === 'up');
      if (isC && cz.bars >= 3) { pbz = cz; break; }
    }
    if (!pbz) continue;

    const pbs = pbz.start, pbe = pbz.end, pbb = pbz.bars;
    if (pbe + 1 >= n) continue;
    if (candles[pbe].t.slice(11, 16) >= '14:30') continue;

    const pbExtreme = iu
      ? Math.min(...candles.slice(pbs, pbe+1).map(b => b.l))
      : Math.max(...candles.slice(pbs, pbe+1).map(b => b.h));
    const retracePct = pushMove > 0 ? Math.abs(pushExtreme - pbExtreme) / pushMove : 0;
    if (retracePct > 0.80) continue;

    const p2 = retracePct>=0.30&&retracePct<=0.50 ? 20
              : retracePct<=0.70 ? 12
              : retracePct<0.30 ? 8
              : retracePct<=0.80 ? 4 : 0;

    const pbAvgVol = candles.slice(pbs, pbe+1).reduce((s, b) => s + b.v, 0) / pbb;
    const rat = pbAvgVol / (pushVol || 1);
    const p3 = rat < 0.40 ? 18 : rat < 0.55 ? 12 : rat < 0.70 ? 6 : 0;

    let ov = 0, oc = 0;
    for (let ti = pbs+1; ti <= pbe; ti++) {
      const pv2 = candles[ti-1], cv = candles[ti], pr = pv2.h - pv2.l;
      if (pr <= 0) continue;
      ov += Math.max(0, Math.min(cv.h, pv2.h) - Math.max(cv.l, pv2.l)) / pr; oc++;
    }
    const ao = oc > 0 ? ov / oc : 0;
    let p4 = ao >= 0.65 ? 7 : ao >= 0.50 ? 4 : 2;
    if (candles.slice(pbs, pbe+1).every(b => iu ? b.c > (pbExtreme - atrV*0.5) : b.c < (pbExtreme + atrV*0.5)))
      p4 = Math.min(p4 + 1, 8);

    let p5 = 10;
    const psp = candles[ps].c;
    if (candles.slice(pbs, pbe+1).some(b => iu ? b.c < psp : b.c > psp)) p5 = 0;
    allSR.forEach(lv => {
      if ((lv.priorDayTouches || 0) < 1) return;
      const lb = candles.slice(Math.max(0, ps-20), ps+1).some(b => iu ? b.c > lv.level : b.c < lv.level);
      if (!lb) return;
      if (candles.slice(pbs, pbe+1).some(b =>
        Math.abs(b.l - lv.level) < atrV*0.5 || Math.abs(b.h - lv.level) < atrV*0.5))
        p5 = Math.min(p5 + 3, 10);
    });

    const cm   = mcm(me, pbs, iu);
    const dire = iu ? 'bull' : 'bear';
    const pbc  = gpbc(dire, pbs, cm);
    const p6   = pbc === 2 ? 10 : pbc === 1 ? 5 : pbc === 3 ? 3 : 0;

    let p7 = 0, rbi = -1;
    for (let ri = pbe+1; ri <= Math.min(pbe+5, n-2); ri++) {
      const rb = candles[ri];
      if (!((iu && rb.c > rb.o) || (!iu && rb.c < rb.o))) continue;
      rbi = ri;
      const rr = rb.h - rb.l || 0.001, rbb = Math.abs(rb.c - rb.o);
      const rcp = iu ? (rb.c - rb.l) / rr : (rb.h - rb.c) / rr;
      const rvr = rb.v / (avgVolPre || rb.v);
      if (rbb/rr > 0.60) p7 += 5; else if (rbb/rr > 0.40) p7 += 2;
      if (rcp > 0.70) p7 += 3;
      if (rvr >= 1.0) p7 += 4;
      if ((iu && rb.h > pbExtreme + atrV*0.1) || (!iu && rb.l < pbExtreme - atrV*0.1)) p7 += 3;
      p7 = Math.min(p7, 15); break;
    }
    if (rbi === -1 || candles[rbi].t.slice(11, 16) >= '14:30') continue;

    lastPB[dire] = { bar: pbe, count: pbc };
    const score = p1 + p2 + p3 + p4 + p5 + p6 + p7;
    if (score < minScore || retracePct > 0.80 || pbc !== 2) continue;

    const ep  = candles[rbi].c;
    const stop   = iu ? pbExtreme - atrV*0.5 : pbExtreme + atrV*0.5;
    const target = iu ? ep + atrV*1.5 : ep - atrV*1.5;
    const stopDist = Math.abs(ep - stop);

    signals.push({
      type: 'H2', dir: dire, score,
      p1, p2, p3, p4, p5, p6, p7,
      resumptionBar: rbi,
      entryTime: candles[rbi].t,
      entryPrice: +ep.toFixed(2),
      stopPrice:  +stop.toFixed(2),
      targetPrice: +target.toFixed(2),
      stopDist:   +stopDist.toFixed(2),
      atr: +atrV.toFixed(2),
      pushExtreme: +pushExtreme.toFixed(2),
      retracePct:  +retracePct.toFixed(3),
    });
  }
  return signals;
}

// ─── BREAKOUT SCORE (for RT detection) ───────────────────────────────────────
function computeBreakoutScore(candles, i, sr, atr) {
  const n = candles.length;
  if (i < 6 || i >= n-3) return null;
  const bar = candles[i];
  const isBull = bar.c > bar.o, isBear = bar.c < bar.o;
  if (!isBull && !isBear) return null;
  const body = Math.abs(bar.c - bar.o), br = bar.h - bar.l || 1, brat = body / br;

  // F1
  const sim = [];
  for (let j = Math.max(0, i-25); j < i; j++)
    if ((isBull && candles[j].c > candles[j].o) || (isBear && candles[j].c < candles[j].o))
      sim.push(Math.abs(candles[j].c - candles[j].o));
  const ab = sim.length ? sim.slice(-10).reduce((s,v) => s+v, 0) / Math.min(sim.length, 10) : body;
  const f1 = Math.round(Math.min(brat*0.4 + Math.min((body/(ab||body))/2.5, 0.6), 1) * 10);

  // F2
  const p4c = candles.slice(Math.max(0,i-4), i), p10c = candles.slice(Math.max(0,i-10), i);
  const b4  = isBull ? Math.max(...p4c.map(x=>x.h),0) : Math.min(...p4c.map(x=>x.l), 99999);
  const b10 = isBull ? Math.max(...p10c.map(x=>x.h),0) : Math.min(...p10c.map(x=>x.l), 99999);
  const f2  = (isBull?bar.h>b10:bar.l<b10) ? 6 : (isBull?bar.h>b4:bar.l<b4) ? 4 : 0;

  // F3 — S/R break quality
  let f3 = 0;
  const prevC = candles[i-1].c;
  const allSR = [...(sr.supports||[]), ...(sr.resistances||[])];
  let src = 0;
  allSR.forEach(lv => {
    const cr = isBull ? (prevC < lv.level && bar.c > lv.level) : (prevC > lv.level && bar.c < lv.level);
    if (!cr) return;
    const prior = lv.priorDayTouches || 0;
    const cap   = prior >= 3 ? 12 : prior >= 2 ? 9 : prior >= 1 ? 6 : 3;
    const cl    = Math.min(Math.abs(bar.c - lv.level) / atr, 1);
    src = Math.max(src, Math.min((lv.score || 0.3)*9 + cl*3, cap));
  });
  f3 += Math.round(src);
  f3 = Math.min(f3, 14);

  // F4 15-min slope
  let f4 = 0;
  const m15 = [];
  for (let j = 3; j <= i; j += 3) {
    const sl = candles.slice(j-3, j);
    if (sl.length < 3) break;
    m15.push(sl[sl.length-1].c);
  }
  if (m15.length >= 3) {
    const lb = Math.min(m15.length, 12);
    const sn = (m15[m15.length-1] - m15[m15.length-1-lb+1]) / lb / (atr * 3);
    const al = isBull ? sn : -sn;
    f4 = al>0.15?12:al>0.08?9:al>0.03?6:al>=-0.06?4:al>=-0.08?3:0;
  } else if (i >= 12) {
    const lb = Math.min(36, i);
    const sn = (candles[i-1].c - candles[i-lb].c) / lb / atr;
    const al = isBull ? sn : -sn;
    f4 = al>0.15?12:al>0.08?9:al>0.03?6:al>=-0.06?4:al>=-0.08?3:0;
  }

  // F5 volume
  const rv = candles.slice(Math.max(0,i-20), i);
  const av = rv.length ? rv.reduce((s,c) => s+c.v, 0) / rv.length : bar.v;
  const f5 = Math.round(Math.min(Math.max(bar.v/(av||bar.v)-0.5, 0)/1.5, 1) * 18);

  // F6 candle quality
  let f6 = 0;
  if (brat > 0.70) f6 += 5; else if (brat > 0.55) f6 += 3;
  const cp = isBull ? (bar.c - bar.l)/br : (bar.h - bar.c)/br;
  if (cp > 0.75) f6 += 3; else if (cp > 0.55) f6 += 1;
  f6 = Math.min(f6, 8);

  // F7 tension
  let f7 = 0;
  const tb = candles.slice(Math.max(0,i-8), i);
  if (tb.length >= 4) {
    let to = 0, oc = 0;
    for (let ti = 1; ti < tb.length; ti++) {
      const pv = tb[ti-1], cv = tb[ti], pr = pv.h - pv.l;
      if (pr <= 0) continue;
      to += Math.max(0, Math.min(cv.h,pv.h) - Math.max(cv.l,pv.l)) / pr; oc++;
    }
    f7 += Math.round(Math.min((oc>0?to/oc:0)/0.9, 1) * 7);
    const bH = Math.max(...tb.map(b=>b.h)), bL = Math.min(...tb.map(b=>b.l));
    if (isBull && bar.c > bH*0.998) f7 += 3;
    else if (!isBull && bar.c < bL*1.002) f7 += 3;
    else if (isBull && bar.h > bH) f7 += 1;
    else if (!isBull && bar.l < bL) f7 += 1;
  }
  f7 = Math.min(f7, 10);

  return {
    score: Math.min(f1+f2+f3+f4+f5+f6+f7, 100),
    isBull, f1, f2, f3, f4, f5, f6, f7,
  };
}

// ─── RT RETEST SCORING ────────────────────────────────────────────────────────
function findRTSignals(candles, sr, atr, minScore = 60, minF3 = 14) {
  const n = candles.length;
  const allSR = [...(sr.supports||[]), ...(sr.resistances||[])];
  const signals = [];

  for (let i = 6; i < n - 3; i++) {
    const tStr = candles[i].t.slice(11, 16);
    if (tStr >= '14:00') continue;  // Block 14:xx entries

    const bs = computeBreakoutScore(candles, i, sr, atr);
    if (!bs || bs.score < minScore || (bs.f3 || 0) < minF3) continue;
    if (i + 2 >= n) continue;

    const isBull = bs.isBull;
    const n1 = candles[i+1];

    // Path 1 gate: if BOTH N+1 and N+2 confirm with volume → Path 1, skip RT
    if (i+2 < n) {
      const b1 = candles[i+1], b2 = candles[i+2], sv = candles[i].v;
      const ft1 = isBull ? b1.c > b1.o : b1.c < b1.o;
      const ft2 = isBull ? b2.c > b2.o : b2.c < b2.o;
      if (ft1 && ft2 && b1.v >= sv*0.55 && b2.v >= sv*0.55) continue;
    }

    // N+1 must be wrong direction
    if (isBull ? n1.c >= n1.o : n1.c <= n1.o) continue;

    // Find broken S/R level
    let broken = null;
    allSR.forEach(lv => {
      if ((lv.priorDayTouches || 0) < 1) return;
      const prev = candles[i-1];
      const cr = isBull
        ? (candles[i].c > lv.level && prev.c < lv.level)
        : (candles[i].c < lv.level && prev.c > lv.level);
      if (!cr) return;
      if (!broken || Math.abs(lv.level - candles[i].c) < Math.abs(broken.level - candles[i].c))
        broken = lv;
    });
    if (!broken) continue;

    const srLevel = broken.level;
    const n1Held  = isBull ? n1.c > srLevel - atr*0.1 : n1.c < srLevel + atr*0.1;
    if (!n1Held) continue;

    const entry  = n1.c;
    const stop   = isBull ? srLevel - atr*0.5 : srLevel + atr*0.5;
    const target = isBull ? entry + atr*1.5 : entry - atr*1.5;
    const stopDist = Math.abs(entry - stop);

    // Stop floor filter — skip if stop < 0.5×ATR from entry
    if (stopDist < atr * 0.5) continue;

    const prior = broken.priorDayTouches || 0;
    const tier  = prior >= 3 ? 'T1' : prior >= 2 ? 'T2' : 'T3';
    if (tier === 'T3') continue;

    signals.push({
      type: 'RT', dir: isBull ? 'bull' : 'bear',
      score: bs.score, f3: bs.f3, f4: bs.f4, f5: bs.f5,
      signalBar: i, entryBar: i+1,
      entryTime: n1.t,
      entryPrice: +entry.toFixed(2),
      stopPrice:  +stop.toFixed(2),
      targetPrice: +target.toFixed(2),
      stopDist:   +stopDist.toFixed(2),
      srLevel:    +srLevel.toFixed(2),
      tier, atr: +atr.toFixed(2),
    });
    i += 1; // Skip next bar to avoid duplicate signals
  }
  return signals;
}

// ─── TIER 1 PRE-FILTER ────────────────────────────────────────────────────────
// Runs every 20 minutes during market hours
// Identifies H2 candidates and RT candidates separately

function isMarketHours() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  // Convert to IST (UTC+5:30)
  const utcMs = now.getTime();
  const istMs = utcMs + (5.5 * 60 * 60 * 1000);
  const ist   = new Date(istMs);
  const hm    = ist.getHours() * 100 + ist.getMinutes();
  return hm >= 915 && hm <= 1430;
}

async function runTier1() {
  if (CACHE.tier1Running) return;
  if (!isMarketHours()) {
    console.log(`[${new Date().toISOString()}] Tier1 skipped — outside market hours`);
    return;
  }
  if (!kiteReady()) {
    console.log(`[${new Date().toISOString()}] Tier1 skipped — Kite not authenticated`);
    return;
  }

  CACHE.tier1Running = true;
  CACHE.tier1Progress = { scanned: 0, total: NSE_UNIVERSE.length, status: 'running' };
  console.log(`[${new Date().toISOString()}] Tier1 started — ${NSE_UNIVERSE.length} stocks (pattern pre-filter)`);

  const h2Candidates = [];
  const rtCandidates = [];

  for (let i = 0; i < NSE_UNIVERSE.length; i++) {
    const symbol = NSE_UNIVERSE[i];
    CACHE.tier1Progress.scanned = i + 1;

    try {
      const candles = await fetchKite5Min(symbol);
      if (!candles || candles.length < 30) { await sleep(100); continue; }

      const atr   = computeATR(candles);
      const sr    = computeSR(candles);
      const zones = computeMicroZones(candles);

      // ── H2 PRE-FILTER ──
      // Does this stock have a push+pullback structure that could yield H2?
      const h2Sigs = findH2Signals(candles, zones, sr, atr, 55); // Lower threshold for pre-filter
      if (h2Sigs.length > 0) {
        const best = h2Sigs.reduce((a, b) => a.score > b.score ? a : b);
        h2Candidates.push({
          sym: symbol,
          sector: SECTORS[symbol] || 'Other',
          price: candles[candles.length-1].c,
          h2Score: best.score,
          h2Signal: best,
          atr,
          candles: candles.slice(-120), // Keep last 120 bars for Tier 2 re-scoring
          sr,
          zones,
          fetchedAt: new Date().toISOString(),
        });
      }

      // ── RT PRE-FILTER ──
      // Recent strong S/R break (F3≥14) with incomplete follow-through?
      const rtSigs = findRTSignals(candles, sr, atr, 60, 14);
      if (rtSigs.length > 0) {
        const best = rtSigs.reduce((a, b) => a.score > b.score ? a : b);
        rtCandidates.push({
          sym: symbol,
          sector: SECTORS[symbol] || 'Other',
          price: candles[candles.length-1].c,
          rtScore: best.score,
          rtSignal: best,
          atr,
          candles: candles.slice(-120),
          sr,
          fetchedAt: new Date().toISOString(),
        });
      }

    } catch(e) {
      console.warn(`[Tier1] ${symbol} error:`, e.message);
    }

    await sleep(100); // 100ms between stocks — 3.1 req/s, within Kite limit
  }

  // Sort by score, keep top candidates
  h2Candidates.sort((a, b) => b.h2Score - a.h2Score);
  rtCandidates.sort((a, b) => b.rtScore - a.rtScore);

  CACHE.tier1H2  = h2Candidates.slice(0, 30);
  CACHE.tier1RT  = rtCandidates.slice(0, 30);
  CACHE.tier1At  = new Date().toISOString();
  CACHE.tier1Running = false;
  CACHE.tier1Progress.status = 'done';

  console.log(`[${new Date().toISOString()}] Tier1 done — H2: ${h2Candidates.length} candidates, RT: ${rtCandidates.length} candidates`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── TIER 2 — ON-DEMAND FULL SCORING ─────────────────────────────────────────
async function runTier2() {
  const allCandidates = [
    ...CACHE.tier1H2.map(s => ({ ...s, primaryType: 'H2' })),
    ...CACHE.tier1RT.map(s => ({ ...s, primaryType: 'RT' })),
  ];

  if (!allCandidates.length) return [];

  console.log(`[${new Date().toISOString()}] Tier2 live refresh — ${allCandidates.length} candidates`);

  const results = [];
  const seen = new Set();

  for (const candidate of allCandidates) {
    if (seen.has(candidate.sym)) continue;
    seen.add(candidate.sym);

    try {
      // Fetch fresh candles for this candidate
      const freshCandles = await fetchKite5Min(candidate.sym);
      const candles = freshCandles || candidate.candles;
      if (!candles || candles.length < 20) continue;

      const atr   = computeATR(candles);
      const sr    = freshCandles ? computeSR(candles) : candidate.sr;
      const zones = computeMicroZones(candles);

      // Run full H2 scoring
      const h2Sigs = findH2Signals(candles, zones, sr, atr, 60);
      // Run full RT scoring (with all filters)
      const rtSigs = findRTSignals(candles, sr, atr, 60, 14);

      const allSigs = [...h2Sigs, ...rtSigs];
      if (!allSigs.length) continue;

      const best = allSigs.reduce((a, b) => a.score > b.score ? a : b);

      results.push({
        sym: candidate.sym,
        sector: candidate.sector,
        price: candles[candles.length-1].c,
        type: best.type,
        dir: best.dir,
        score: best.score,
        entryPrice: best.entryPrice,
        stopPrice: best.stopPrice,
        targetPrice: best.targetPrice,
        stopDist: best.stopDist,
        atr: best.atr,
        entryTime: best.entryTime,
        tier: best.tier || null,
        f3: best.f3 || null,
        // Include all signals for Claude context
        allSignals: allSigs.map(s => ({
          type: s.type, dir: s.dir, score: s.score,
          entry: s.entryPrice, stop: s.stopPrice, target: s.targetPrice,
        })),
        liveAt: new Date().toISOString(),
      });

      await sleep(100);
    } catch(e) {
      console.warn(`[Tier2] ${candidate.sym} error:`, e.message);
    }
  }

  results.sort((a, b) => b.score - a.score);
  CACHE.tier2   = results;
  CACHE.tier2At = new Date().toISOString();
  return results;
}

// ─── START TIER 1 ─────────────────────────────────────────────────────────────
// Run on startup (will skip if outside market hours or Kite not ready)
setTimeout(runTier1, 5000); // 5s delay on startup to let Kite auth load
setInterval(runTier1, 20 * 60 * 1000); // Every 20 minutes

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  name: 'Signal Server v6.0 — H2 + RT Pattern Engine',
  kite: { ready: kiteReady(), authenticatedAt: KITE.authenticatedAt },
  universe: NSE_UNIVERSE.length,
  tier1: {
    h2Candidates: CACHE.tier1H2.length,
    rtCandidates: CACHE.tier1RT.length,
    at: CACHE.tier1At,
    running: CACHE.tier1Running,
  },
  tier2: { cached: CACHE.tier2.length, at: CACHE.tier2At },
  marketHours: isMarketHours(),
}));

app.get('/health', (req, res) => res.json({
  ok: true,
  uptime: Math.round(process.uptime()) + 's',
  time: new Date().toISOString(),
  screenerReady: !!CACHE.tier1At,
  h2Candidates: CACHE.tier1H2.length,
  rtCandidates: CACHE.tier1RT.length,
  kiteReady: kiteReady(),
  marketHours: isMarketHours(),
}));

app.get('/status', (req, res) => res.json({
  universe: NSE_UNIVERSE.length,
  tier1: {
    h2Candidates: CACHE.tier1H2.length,
    rtCandidates: CACHE.tier1RT.length,
    at: CACHE.tier1At,
    running: CACHE.tier1Running,
    progress: CACHE.tier1Progress,
    marketHours: isMarketHours(),
  },
  tier2: { cached: CACHE.tier2.length, at: CACHE.tier2At },
  kite: { ready: kiteReady(), authenticatedAt: KITE.authenticatedAt },
}));

app.get('/generate', async (req, res) => {
  if (!kiteReady()) {
    return res.json({
      error: 'Kite not authenticated. Open trading app and login with Zerodha first.',
      kiteLoginUrl: `${SERVER_URL}/kite/login`,
    });
  }
  if (!CACHE.tier1At && !CACHE.tier1Running) {
    return res.json({ error: 'Tier1 has not run yet. Wait for market hours or check /status.' });
  }
  if (CACHE.tier1Running) {
    return res.json({ error: 'Tier1 scan running. Try again in 1-2 min.', progress: CACHE.tier1Progress });
  }

  const live = await runTier2();
  const top  = live.slice(0, 12); // Top 12 for Claude

  // Build compact prompt-ready string for Claude
  const stocksSummary = top.map(s =>
    `${s.sym} [${s.sector}] ${s.type} ${s.dir.toUpperCase()} sc=${s.score} ` +
    `entry=${s.entryPrice} stop=${s.stopPrice} target=${s.targetPrice} ` +
    `ATR=${s.atr}${s.tier ? ` tier=${s.tier}` : ''}${s.f3 ? ` F3=${s.f3}` : ''}`
  ).join('\n');

  res.json({
    scanned: NSE_UNIVERSE.length,
    h2Candidates: CACHE.tier1H2.length,
    rtCandidates: CACHE.tier1RT.length,
    tier2Refreshed: live.length,
    tier1At: CACHE.tier1At,
    tier2At: CACHE.tier2At,
    stocksSummary, // For Claude prompt
    stocks: top,   // Full data for app display
  });
});

// ─── PRICES — Kite first, Yahoo fallback (unchanged from v5.2) ────────────────
const YF_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

function toKiteSymbol(sym) {
  const clean = sym.replace('.NS','').replace('.BO','').replace('^','');
  if (clean==='NSEI'||clean==='NIFTY50') return 'NSE:NIFTY 50';
  if (clean==='NSEBANK'||clean==='BANKNIFTY') return 'NSE:NIFTY BANK';
  return `NSE:${clean}`;
}

async function fetchKitePrices(symbols) {
  if (!kiteReady()) return null;
  try {
    const kiteSyms = symbols.map(toKiteSymbol);
    const params = kiteSyms.map(s => `i=${encodeURIComponent(s)}`).join('&');
    const resp = await axios.get(`${KITE_BASE}/quote?${params}`, {
      headers: { 'X-Kite-Version': '3', 'Authorization': `token ${KITE_API_KEY}:${KITE.accessToken}` },
      timeout: 8000,
    });
    const data = resp.data.data || {};
    const result = {};
    symbols.forEach(sym => {
      const q = data[toKiteSymbol(sym)];
      if (q) result[sym] = {
        sym, price: q.last_price,
        prevClose: q.ohlc?.close || q.last_price,
        changePct: q.ohlc?.close ? +((q.last_price - q.ohlc.close) / q.ohlc.close * 100).toFixed(2) : 0,
        high: q.ohlc?.high || q.last_price, low: q.ohlc?.low || q.last_price,
        open: q.ohlc?.open || q.last_price, volume: q.volume_traded || 0,
        marketState: 'REGULAR', source: 'kite', fetchedAt: new Date().toISOString(),
      };
    });
    return result;
  } catch(e) {
    if (e.response?.status === 403) { KITE.accessToken = null; console.log('[Kite] Token expired'); }
    return null;
  }
}

async function fetchYahooFreshPrice(sym) {
  try {
    const yfSym = sym.includes('.') || sym.startsWith('^') ? sym : sym + '.NS';
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1m&range=1d&includePrePost=false`,
      { headers: YF_HDR, timeout: 8000 }
    );
    const result = r.data?.chart?.result?.[0];
    if (!result) throw new Error('No data');
    const meta = result.meta || {};
    const price = meta.regularMarketPrice || meta.previousClose || 0;
    const prev  = meta.chartPreviousClose || price;
    const clean = sym.replace('.NS','').replace('.BO','').replace('^','');
    return {
      sym: clean, price: +price.toFixed(2), prevClose: +prev.toFixed(2),
      changePct: prev>0 ? +((price-prev)/prev*100).toFixed(2) : 0,
      high: +(meta.regularMarketDayHigh||price).toFixed(2),
      low:  +(meta.regularMarketDayLow||price).toFixed(2),
      open: +(meta.regularMarketOpen||price).toFixed(2),
      marketState: meta.marketState||'CLOSED', source: 'yahoo',
      fetchedAt: new Date().toISOString(),
    };
  } catch(e) { return { sym, error: e.message }; }
}

app.get('/prices', async (req, res) => {
  const raw  = req.query.symbols || '';
  const syms = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 40);
  if (!syms.length) return res.json({ error: 'Provide ?symbols=RELIANCE,HDFCBANK' });

  const data = {};
  if (kiteReady()) {
    const kd = await fetchKitePrices(syms);
    if (kd) Object.assign(data, kd);
  }
  const missing = syms.filter(s => !data[s]);
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 5) {
      const batch = missing.slice(i, i+5);
      const results = await Promise.allSettled(batch.map(s => fetchYahooFreshPrice(s)));
      results.forEach((r, idx) => {
        const sym = batch[idx];
        if (r.status==='fulfilled' && r.value && !r.value.error) data[sym] = r.value;
        else data[sym] = { sym, error: 'Fetch failed' };
      });
      if (i+5 < missing.length) await sleep(200);
    }
  }
  res.json({ fetchedAt: new Date().toISOString(), count: syms.length, kiteActive: kiteReady(), data });
});

app.get('/price/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  if (kiteReady()) { const kd = await fetchKitePrices([sym]); if (kd?.[sym]) return res.json(kd[sym]); }
  const fresh = await fetchYahooFreshPrice(sym);
  if (!fresh.error) return res.json(fresh);
  const cached = [...CACHE.tier2, ...CACHE.tier1H2, ...CACHE.tier1RT].find(x => x.sym === sym);
  if (cached) return res.json({ ...cached, fromCache: true });
  res.json({ sym, error: 'Not found' });
});

app.get('/symbols', (req, res) => res.json({
  count: NSE_UNIVERSE.length,
  universe: NSE_UNIVERSE,
  withTokens: Object.keys(INSTRUMENT_TOKENS).length,
}));


// ─── MANUAL TIER 1 TRIGGER ───────────────────────────────────────────────────
// Allows user to force a Tier 1 rescan without waiting for 20-min interval
// Returns immediately — scan runs in background
app.get('/scan', (req, res) => {
  if (!kiteReady()) {
    return res.json({
      ok: false,
      error: 'Kite not authenticated. Login with Zerodha first.',
      kiteLoginUrl: `${SERVER_URL}/kite/login`,
    });
  }
  if (CACHE.tier1Running) {
    return res.json({
      ok: false,
      message: 'Tier 1 scan already running.',
      progress: CACHE.tier1Progress,
    });
  }
  // Trigger scan in background — don't await, return immediately
  runTier1().catch(e => console.error('[Manual scan] Error:', e.message));
  res.json({
    ok: true,
    message: 'Tier 1 scan started. Check /status for progress. Takes ~60 seconds.',
    universe: NSE_UNIVERSE.length,
    startedAt: new Date().toISOString(),
  });
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`Signal server v6.0 on port ${PORT} — H2+RT Pattern Engine | Kite API | 20-min scan`)
);
