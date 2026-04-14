/**
 * SIGNAL SERVER v5
 *
 * TWO-TIER ARCHITECTURE:
 *
 * TIER 1 — Background universe scan (runs every 55 min, ~400 stocks, daily data only)
 *   → Computes daily indicators + detects price action patterns on daily candles
 *   → Scores and ranks all stocks by signal strength
 *   → Caches top 40 candidates
 *
 * TIER 2 — On-demand live refresh (runs when you click Generate, ~30s)
 *   → Takes the top 40 candidates from Tier 1
 *   → Fetches FRESH 5-min intraday candles for each (just seconds old)
 *   → Re-scores with live data + detects intraday patterns
 *   → Returns final shortlist to Claude
 *
 * This means:
 *   - Swing setups: identified from daily picture (Tier 1 enough)
 *   - Intraday setups: always based on fresh 5-min data (Tier 2)
 *   - Coverage: ~400 liquid NSE stocks (vs 141 before)
 *   - Staleness: max 5 minutes on intraday, max 55 min on daily swing picture
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── CACHE ───────────────────────────────────────────────────────────────────
let CACHE = {
  tier1: [],           // top 40 from daily scan
  tier1At: null,
  tier1Running: false,
  tier1Progress: { scanned: 0, total: 0, status: 'idle' },
  tier2: [],           // final list after live refresh (set on /generate)
  tier2At: null,
};

// ─── FULL NSE LIQUID UNIVERSE (~400 stocks) ──────────────────────────────────
// Criteria: actively traded, retail accessible, >₹50 price, reasonable liquidity
// Covers Nifty50, Next50, Midcap150, Smallcap picks, sectoral leaders
const NSE_ALL = [
  // ── INDICES ──
  '^NSEI','^NSEBANK','NIFTY_FIN_SERVICE.NS','^CNXIT','^NSEMDCP50',

  // ── NIFTY 50 ──
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

  // ── NIFTY NEXT 50 ──
  'PIDILITIND.NS','SIEMENS.NS','DABUR.NS','GODREJCP.NS','BERGEPAINT.NS',
  'AMBUJACEM.NS','ACC.NS','BOSCHLTD.NS','COLPAL.NS','HAVELLS.NS',
  'MARICO.NS','MUTHOOTFIN.NS','PNB.NS','BANKBARODA.NS','CANBK.NS',
  'VEDL.NS','SAIL.NS','NMDC.NS','HINDPETRO.NS','IOC.NS',
  'GAIL.NS','PETRONET.NS','IGL.NS','TRENT.NS','NAUKRI.NS',
  'ZOMATO.NS','IRCTC.NS','DMART.NS','CHOLAFIN.NS','ABCAPITAL.NS',
  'INDHOTEL.NS','ZEEL.NS','GODREJPROP.NS','DLF.NS','LODHA.NS',
  'PRESTIGE.NS','OBEROIRLTY.NS','PHOENIXLTD.NS',

  // ── NIFTY MIDCAP 150 ──
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
  'VOLTAS.NS','ZYDUSLIFE.NS','SCHAEFFLER.NS','SKFINDIA.NS','SONACOMS.NS',
  'UNOMINDA.NS','UTIAMC.NS','POLYMED.NS','LALPATHLAB.NS','METROPOLIS.NS',

  // ── BANKING & FINANCE ──
  'IDBI.NS','INDIANB.NS','UCOBANK.NS','IOB.NS','MAHABANK.NS',
  'YESBANK.NS','IDFC.NS','M&MFIN.NS','BAJAJHFL.NS','LICHOUSING.NS',
  'POONAWALLA.NS','CREDITACC.NS','SPANDANA.NS','IIFL.NS','MOTILALOS.NS',
  'ANGELONE.NS','5PAISA.NS','NUVOCO.NS',

  // ── IT & TECH ──
  'HEXAWARE.NS','MASTEK.NS','MPHASIS.NS','NIITTECH.NS','RATEGAIN.NS',
  'INTELLECT.NS','TATATECH.NS','CYIENT.NS','BIRLASOFT.NS','ZENSAR.NS',
  'ECLERX.NS','FIRSTSOURCE.NS','SONATSOFTW.NS','MINDTREE.NS',

  // ── PHARMA & HEALTHCARE ──
  'AUROPHARMA.NS','BIOCON.NS','GLENMARK.NS','GRANULES.NS','IPCALAB.NS',
  'JBCHEPHARM.NS','JUPITERPHAR.NS','NATCOPHARM.NS','PFIZER.NS',
  'SANOFI.NS','SUVEN.NS','ABBOTINDIA.NS','MANKIND.NS','AJANTPHARM.NS',
  'ERIS.NS','INDOCO.NS','SEQUENT.NS','STRIDES.NS','WOCKPHARMA.NS',

  // ── AUTO & AUTO ANCILLARIES ──
  'ASHOKLEY.NS','FORCEMOT.NS','MAHINDCIE.NS','MRF.NS','CEATLTD.NS',
  'APOLLOTYRE.NS','BALKRISIND.NS','AMARAJABAT.NS','EXIDEIND.NS',
  'SUNDARMFIN.NS','SWARAJENG.NS','TVSMOTOR.NS','ENDURANCE.NS',
  'SUPRAJIT.NS','MINDA.NS','LUMAXTECH.NS','GABRILIND.NS',

  // ── INFRASTRUCTURE & CAPITAL GOODS ──
  'ABB.NS','BHEL.NS','CUMMINSIND.NS','GRINDWELL.NS','HONAUT.NS',
  'KEC.NS','KALPATPOWR.NS','NBCC.NS','NCC.NS','PNCINFRA.NS',
  'RVNL.NS','TITAGARH.NS','THERMAX.NS','TRIVENI.NS','WELCORP.NS',
  'IRB.NS','ASHOKA.NS','HGINFRA.NS','KNRCON.NS','AHLUCONT.NS',

  // ── METALS & MINING ──
  'NATIONALUM.NS','HINDZINC.NS','MOIL.NS','GMRINFRA.NS','JSPL.NS',
  'RATNAMANI.NS','WELSPUNLIV.NS','APL.NS','HIKAL.NS',

  // ── FMCG & CONSUMER ──
  'EMAMILTD.NS','JYOTHYLAB.NS','VADILALIND.NS','ZOMATO.NS','DEVYANI.NS',
  'SAPPHIRE.NS','WESTLIFE.NS','BARBEQUE.NS','JUBLINDFOO.NS',

  // ── ENERGY & POWER ──
  'ADANIPOWER.NS','ADANIGREEN.NS','TATAPOWER.NS','TORNTPOWER.NS',
  'CESC.NS','JSPL.NS','SUZLON.NS','INOXWIND.NS','GREENKO.NS',
  'RPOWER.NS','NHPC.NS','SJVN.NS',

  // ── CHEMICALS ──
  'AAVAS.NS','ALKYLAMINE.NS','BALCHEMLTD.NS','CLEAN.NS','FINEORG.NS',
  'FLUOROCHEM.NS','GALAXYSURF.NS','GUJFLUORO.NS','JUBILANT.NS',
  'NIACL.NS','PHILIPCARB.NS','PIIND.NS','PRSMJOHNSN.NS','ROSSARI.NS',
  'SPECHEM.NS','VINDHYATEL.NS','VINATIORGA.NS','AAVAS.NS',

  // ── REALTY ──
  'BRIGADE.NS','KOLTEPATIL.NS','MAHLIFE.NS','RUSTOMJEE.NS','SOBHA.NS',
  'SUNTECK.NS','GODREJPROP.NS','DLF.NS',

  // ── MEDIA & TELECOM ──
  'HATHWAY.NS','NAZARA.NS','NXTDIGITAL.NS','TATAELXSI.NS',
];

// Deduplicate
const NSE_UNIVERSE = [...new Set(NSE_ALL)];

const YF_HDR = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9',
  'Referer':'https://finance.yahoo.com/',
  'Origin':'https://finance.yahoo.com',
};

// ─── INDICATORS ──────────────────────────────────────────────────────────────
function ema(v, p) {
  if (v.length < p) return [];
  const k = 2/(p+1);
  const r = [v.slice(0,p).reduce((a,b)=>a+b,0)/p];
  for (let i=p; i<v.length; i++) r.push(v[i]*k + r[r.length-1]*(1-k));
  return r;
}
function rsi(c, p=14) {
  if (c.length < p+1) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d);}
  let ag=g/p,al=l/p;
  for (let i=p+1;i<c.length;i++){
    const d=c[i]-c[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?Math.abs(d):0))/p;
  }
  return al===0?100:+(100-100/(1+ag/al)).toFixed(1);
}
function macd(c) {
  if (c.length<26) return null;
  const e12=ema(c,12),e26=ema(c,26);
  const off=c.length-e26.length;
  const ml=e26.map((v,i)=>e12[i+off]-v);
  const sg=ema(ml,9);
  const lm=ml[ml.length-1],ls=sg[sg.length-1];
  const pm=ml[ml.length-2],ps=sg[sg.length-2];
  return {
    macd:+lm.toFixed(3),signal:+ls.toFixed(3),histogram:+(lm-ls).toFixed(3),
    crossover:pm<ps&&lm>ls?'bullish':pm>ps&&lm<ls?'bearish':'none',
    rising:(lm-ls)>(pm-ps),
  };
}
function bb(c,p=20,sd=2) {
  if (c.length<p) return null;
  const sl=c.slice(-p),m=sl.reduce((a,b)=>a+b,0)/p;
  const std=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);
  const last=c[c.length-1],up=m+sd*std,lo=m-sd*std;
  return {
    upper:+up.toFixed(2),middle:+m.toFixed(2),lower:+lo.toFixed(2),
    pctB:std===0?0.5:+((last-lo)/(up-lo)).toFixed(3),
    bandwidth:+(((up-lo)/m)*100).toFixed(2),
    squeeze:((up-lo)/m)<0.035,
  };
}
function stoch(h,l,c,kp=14,dp=3) {
  if (c.length<kp) return null;
  const kv=[];
  for (let i=kp-1;i<c.length;i++){
    const hh=Math.max(...h.slice(i-kp+1,i+1)),ll=Math.min(...l.slice(i-kp+1,i+1));
    kv.push(hh===ll?50:(c[i]-ll)/(hh-ll)*100);
  }
  const dv=ema(kv,dp);
  const lk=kv[kv.length-1],ld=dv[dv.length-1];
  const pk=kv[kv.length-2],pd=dv[dv.length-2];
  return {k:+lk.toFixed(1),d:+ld.toFixed(1),
    overbought:lk>80,oversold:lk<20,
    crossover:pk<pd&&lk>ld?'bullish':pk>pd&&lk<ld?'bearish':'none'};
}
function atr(h,l,c,p=14) {
  if (c.length<p+1) return null;
  const trs=c.slice(1).map((_,i)=>Math.max(h[i+1]-l[i+1],Math.abs(h[i+1]-c[i]),Math.abs(l[i+1]-c[i])));
  return +(trs.slice(-p).reduce((a,b)=>a+b,0)/p).toFixed(2);
}
function adx(h,l,c,p=14) {
  if (c.length<p*2) return null;
  const pd=[],md=[],tr=[];
  for (let i=1;i<c.length;i++){
    const um=h[i]-h[i-1],dm=l[i-1]-l[i];
    pd.push(um>dm&&um>0?um:0); md.push(dm>um&&dm>0?dm:0);
    tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  }
  const st=tr.slice(-p).reduce((a,b)=>a+b,0);
  if(!st) return null;
  const pi=(pd.slice(-p).reduce((a,b)=>a+b,0)/st)*100;
  const mi=(md.slice(-p).reduce((a,b)=>a+b,0)/st)*100;
  const dx=Math.abs(pi-mi)/(pi+mi)*100;
  return {adx:+dx.toFixed(1),plusDI:+pi.toFixed(1),minusDI:+mi.toFixed(1),trending:dx>25};
}
function vwap(candles) {
  let tv=0,vl=0;
  for(const c of candles){const tp=(c.h+c.l+c.c)/3;tv+=tp*c.v;vl+=c.v;}
  return vl>0?+(tv/vl).toFixed(2):null;
}
function indicators(candles) {
  if (!candles||candles.length<5) return {};
  const c=candles.map(x=>x.c),h=candles.map(x=>x.h),l=candles.map(x=>x.l);
  const e8=ema(c,8),e21=ema(c,21),e50=ema(c,50),e200=ema(c,200);
  const last=c[c.length-1];
  const e21l=e21[e21.length-1],e50l=e50.length?e50[e50.length-1]:null;
  const e200l=e200.length?e200[e200.length-1]:null;
  return {
    ema:{
      ema8:  e8.length  ?+e8[e8.length-1].toFixed(2)  :null,
      ema21: e21.length ?+e21l.toFixed(2)              :null,
      ema50: e50l       ?+e50l.toFixed(2)              :null,
      ema200:e200l      ?+e200l.toFixed(2)             :null,
      trend: e8.length&&e21.length?(e8[e8.length-1]>e21l?'bullish':'bearish'):'unknown',
      goldenCross:e50l&&e200l?e50l>e200l:null,
      priceVsEma21:e21l?+((last-e21l)/e21l*100).toFixed(2):null,
      ema21Slope:e21.length>=3?+((e21l-e21[e21.length-3])/e21[e21.length-3]*100).toFixed(3):null,
    },
    rsi:  rsi(c),
    macd: macd(c),
    bb:   bb(c),
    stoch:stoch(h,l,c),
    atr:  atr(h,l,c),
    adx:  adx(h,l,c),
    vwap: vwap(candles),
  };
}

// ─── PRICE ACTION PATTERN DETECTION ──────────────────────────────────────────
function detectPatterns(candles, ind) {
  if (!candles||candles.length<5) return [];
  const pats=[];
  const n=candles.length;
  const last=candles[n-1],prev=candles[n-2],prev2=candles[n-3];
  const body  = x=>Math.abs(x.c-x.o);
  const range = x=>x.h-x.l;
  const green = x=>x.c>x.o;
  const red   = x=>x.c<x.o;
  const trend = x=>range(x)>0&&body(x)/range(x)>0.6;
  const doji  = x=>range(x)>0&&body(x)/range(x)<0.25;
  const uwk   = x=>green(x)?x.h-x.c:x.h-x.o;
  const lwk   = x=>green(x)?x.o-x.l:x.c-x.l;
  const c=candles.map(x=>x.c);
  const h=candles.map(x=>x.h);
  const l=candles.map(x=>x.l);
  const avg8range=candles.slice(-8).reduce((s,x)=>s+range(x),0)/8;

  // ── AL BROOKS ──
  if(trend(last)&&green(last)) pats.push({name:'Brooks: Bull trend bar',dir:'bull',str:3,detail:`Body ${(body(last)/range(last)*100).toFixed(0)}% of range — strong buying`});
  if(trend(last)&&red(last))   pats.push({name:'Brooks: Bear trend bar',dir:'bear',str:3,detail:`Body ${(body(last)/range(last)*100).toFixed(0)}% of range — strong selling`});
  if(doji(last))               pats.push({name:'Brooks: Doji — indecision',dir:'neutral',str:1,detail:'Small body, await next bar for direction'});

  // Bull flag
  if(n>=6){
    const imp=candles[n-6];
    const pb=candles.slice(n-5,n-1);
    if(trend(imp)&&green(imp)&&pb.every(x=>x.l>imp.l)&&range(candles[n-2])<range(candles[n-4])*0.8)
      pats.push({name:'Brooks: Bull flag — tight pullback after impulse',dir:'bull',str:5,detail:'Classic always-in-long continuation'});
  }
  // Bear flag
  if(n>=6){
    const imp=candles[n-6];
    const pb=candles.slice(n-5,n-1);
    if(trend(imp)&&red(imp)&&pb.every(x=>x.h<imp.h)&&range(candles[n-2])<range(candles[n-4])*0.8)
      pats.push({name:'Brooks: Bear flag — tight rally after impulse',dir:'bear',str:5,detail:'Classic always-in-short continuation'});
  }
  // Micro double top
  if(Math.abs(last.h-prev.h)<range(last)*0.3&&red(last)&&last.h>prev.h*0.997)
    pats.push({name:'Brooks: Micro double top at resistance',dir:'bear',str:4,detail:`Twin highs ~₹${last.h.toFixed(1)}`});
  // Micro double bottom
  if(Math.abs(last.l-prev.l)<range(last)*0.3&&green(last)&&last.l<prev.l*1.003)
    pats.push({name:'Brooks: Micro double bottom at support',dir:'bull',str:4,detail:`Twin lows ~₹${last.l.toFixed(1)}`});
  // Buy climax → reversal
  if(range(last)>avg8range*2.5&&green(last)&&uwk(last)>body(last))
    pats.push({name:'Brooks: Buy climax — exhaustion, reversal risk',dir:'bear',str:4,detail:'Outsized green bar with upper wick — late buyers trapped'});
  // Sell climax → reversal
  if(range(last)>avg8range*2.5&&red(last)&&lwk(last)>body(last))
    pats.push({name:'Brooks: Sell climax — exhaustion, reversal setup',dir:'bull',str:4,detail:'Outsized red bar with lower wick — late sellers trapped'});
  // Failed breakout above swing high
  if(n>=10){
    const swH=Math.max(...h.slice(-10,-2));
    if(prev.h>swH&&last.c<swH&&red(last))
      pats.push({name:'Brooks: Failed breakout above swing high (bull trap)',dir:'bear',str:5,detail:`Broke ${swH.toFixed(1)}, closed back below — shorts enter`});
    const swL=Math.min(...l.slice(-10,-2));
    if(prev.l<swL&&last.c>swL&&green(last))
      pats.push({name:'Brooks: Failed breakdown below swing low (bear trap)',dir:'bull',str:5,detail:`Broke below ${swL.toFixed(1)}, recovered — longs enter`});
  }
  // H2 — two-legged pullback buy
  if(n>=5){
    const l1=Math.min(candles[n-4].l,candles[n-3].l);
    const l2=Math.min(candles[n-2].l,candles[n-1].l);
    if(l2>l1&&green(last)&&trend(last))
      pats.push({name:'Brooks: H2 — two-legged pullback buy setup',dir:'bull',str:5,detail:'Higher second low in uptrend — textbook trend continuation'});
  }
  // L2 — two-legged pullback short
  if(n>=5){
    const h1=Math.max(candles[n-4].h,candles[n-3].h);
    const h2=Math.max(candles[n-2].h,candles[n-1].h);
    if(h2<h1&&red(last)&&trend(last))
      pats.push({name:'Brooks: L2 — two-legged pullback short setup',dir:'bear',str:5,detail:'Lower second high in downtrend — textbook trend continuation'});
  }
  // EMA21 bounce
  if(ind?.ema?.ema21){
    const e21=ind.ema.ema21;
    if(prev.l<=e21*1.005&&last.c>e21&&green(last)&&trend(last))
      pats.push({name:'Brooks: EMA21 bounce — dynamic support held',dir:'bull',str:5,detail:`Touched EMA21 (₹${e21}), reversed — ideal pullback-to-MA entry`});
    if(prev.h>=e21*0.995&&last.c<e21&&red(last)&&trend(last))
      pats.push({name:'Brooks: EMA21 rejection — dynamic resistance',dir:'bear',str:5,detail:`Touched EMA21 (₹${e21}), reversed down — short against MA`});
  }

  // ── BOB VOLMAN ──
  const r3=candles.slice(-3).reduce((s,x)=>s+range(x),0)/3;
  const r8=candles.slice(-8).reduce((s,x)=>s+range(x),0)/8;
  if(r3<r8*0.45)
    pats.push({name:'Volman: Tight congestion — breakout pressure building',dir:'neutral',str:3,detail:'Range contracted to <45% of 8-bar avg — breakout imminent'});
  // Breakout-pullback (long)
  if(n>=8){
    const br=candles[n-5],pb=candles.slice(n-4,n-1);
    if(trend(br)&&green(br)&&pb.every(x=>x.l>br.o)&&green(last))
      pats.push({name:'Volman: Breakout-pullback entry (long)',dir:'bull',str:6,detail:'Broke out, pulled back on low vol, resuming — ideal Volman long entry'});
    if(trend(br)&&red(br)&&pb.every(x=>x.h<br.o)&&red(last))
      pats.push({name:'Volman: Breakout-pullback entry (short)',dir:'bear',str:6,detail:'Broke down, rallied on low vol, resuming — ideal Volman short'});
  }
  // Double pressure
  if(trend(last)&&trend(prev)&&green(last)&&green(prev))
    pats.push({name:'Volman: Double pressure (bull) — two consecutive trend bars',dir:'bull',str:4,detail:'Sustained buying — momentum entry'});
  if(trend(last)&&trend(prev)&&red(last)&&red(prev))
    pats.push({name:'Volman: Double pressure (bear) — two consecutive trend bars',dir:'bear',str:4,detail:'Sustained selling — momentum short'});

  // ── WYCKOFF ──
  if(n>=15){
    const sup=Math.min(...l.slice(-15,-3));
    if(prev.l<sup&&last.c>sup&&green(last)&&range(last)>avg8range)
      pats.push({name:'Wyckoff: Spring — shakeout below support, recovery',dir:'bull',str:6,detail:`Dipped below support ₹${sup.toFixed(1)}, recovered — weak hands flushed`});
    const res=Math.max(...h.slice(-15,-3));
    if(prev.h>res&&last.c<res&&red(last)&&range(last)>avg8range)
      pats.push({name:'Wyckoff: UTAD — push above resistance, failed',dir:'bear',str:6,detail:`Pushed above ₹${res.toFixed(1)}, failed — distribution complete`});
  }

  // ── STAN WEINSTEIN STAGE ──
  if(ind?.ema?.ema50&&ind?.ema?.ema200){
    const p=last.c,e50=ind.ema.ema50,e200=ind.ema.ema200;
    if(p>e50&&p>e200&&e50>e200)
      pats.push({name:'Weinstein: Stage 2 uptrend — all aligned bullish',dir:'bull',str:3,detail:'Price>EMA50>EMA200 — only stage to buy'});
    if(p<e50&&p<e200&&e50<e200)
      pats.push({name:'Weinstein: Stage 4 downtrend — all aligned bearish',dir:'bear',str:3,detail:'Price<EMA50<EMA200 — only stage to short'});
  }

  // ── LINDA RASCHKE: 80-20 ──
  // Open near high, close near low = bearish 80-20
  if(last.o>last.h-(range(last)*0.1)&&last.c<last.l+(range(last)*0.2))
    pats.push({name:'Raschke: 80-20 bearish — open near high, close near low',dir:'bear',str:4,detail:'Classic momentum exhaustion — sellers dominating'});
  if(last.o<last.l+(range(last)*0.1)&&last.c>last.h-(range(last)*0.2))
    pats.push({name:'Raschke: 80-20 bullish — open near low, close near high',dir:'bull',str:4,detail:'Classic momentum reversal — buyers dominating'});

  return pats;
}

// ─── SCORE FOR SCREENING ──────────────────────────────────────────────────────
function scoreForScreen(d) {
  if (!d.price||d.error) return null;
  const ind=d.indicators||{};
  const pats=d.patterns||[];
  let score=0;
  const reasons=[];

  // Price action patterns (primary — highest weight)
  for(const p of pats){
    score+=p.str;
    if(p.str>=4) reasons.push(`${p.name.split(':')[0]}: ${p.name.split(':')[1]?.trim()||p.name}`);
  }

  // Indicator confluence (secondary)
  if(ind.macd?.crossover==='bullish'){score+=3;reasons.push('MACD bullish cross');}
  if(ind.macd?.crossover==='bearish'){score+=3;reasons.push('MACD bearish cross');}
  if(ind.macd?.rising&&ind.macd?.histogram>0){score+=1;reasons.push('MACD hist rising');}
  if(ind.rsi!==null){
    if(ind.rsi<30){score+=3;reasons.push(`RSI oversold ${ind.rsi}`);}
    if(ind.rsi>70){score+=3;reasons.push(`RSI overbought ${ind.rsi}`);}
    if(ind.rsi>55&&ind.rsi<70){score+=1;reasons.push(`RSI bull zone ${ind.rsi}`);}
  }
  if(ind.bb?.squeeze){score+=3;reasons.push('BB squeeze');}
  if(ind.bb?.pctB<0.05){score+=2;reasons.push('At lower BB');}
  if(ind.bb?.pctB>0.95){score+=2;reasons.push('At upper BB');}
  if(ind.stoch?.crossover==='bullish'){score+=2;reasons.push('Stoch bull cross');}
  if(ind.stoch?.crossover==='bearish'){score+=2;reasons.push('Stoch bear cross');}
  if(ind.adx?.trending&&ind.adx?.adx>30){score+=2;reasons.push(`ADX ${ind.adx.adx} trending`);}

  // Volume and range
  if(d.volRatio>1.5){score+=2;reasons.push(`Vol ${d.volRatio}x avg`);}
  if(d.volRatio>2.5){score+=1;reasons.push('Extreme volume');}
  const dayRangePct=d.low>0?(d.high-d.low)/d.low*100:0;
  if(dayRangePct>2.5){score+=1;reasons.push(`Wide range ${dayRangePct.toFixed(1)}%`);}

  if(score<8) return null;
  return {...d,screenScore:score,screenReasons:reasons};
}

// ─── FETCH — TIER 1 (daily only, fast) ──────────────────────────────────────
async function fetchDaily(sym) {
  try {
    const r=await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=6mo`,
      {headers:YF_HDR,timeout:10000}
    );
    const result=r.data?.chart?.result?.[0];
    if(!result) return {sym:sym.replace(/\.NS|\.BO|\^/g,''),error:'No data'};
    const meta=result.meta||{};
    const q=result.indicators?.quote?.[0]||{};
    const ts=result.timestamp||[];
    const dc=ts.map((t,i)=>({
      t:new Date(t*1000).toISOString().split('T')[0],
      o:q.open?.[i]!=null?+q.open[i].toFixed(2):null,
      h:q.high?.[i]!=null?+q.high[i].toFixed(2):null,
      l:q.low?.[i]!=null?+q.low[i].toFixed(2):null,
      c:q.close?.[i]!=null?+q.close[i].toFixed(2):null,
      v:q.volume?.[i]||0,
    })).filter(c=>c.c!=null&&c.h!=null&&c.l!=null);
    const price=meta.regularMarketPrice||(dc.length?dc[dc.length-1].c:0);
    const prev=meta.chartPreviousClose||price;
    const vols=dc.map(x=>x.v).filter(v=>v>0);
    const avgVol=vols.length?vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(vols.length,20):1;
    const lastVol=vols[vols.length-1]||0;
    const ind=indicators(dc);
    const pats=detectPatterns(dc,ind);
    const symClean=sym.replace('.NS','').replace('.BO','').replace('^','');
    return {
      sym:symClean,yfSym:sym,
      price:+price.toFixed(2),
      open:+(meta.regularMarketOpen||price).toFixed(2),
      high:+(meta.regularMarketDayHigh||(dc.length?dc[dc.length-1].h:price)).toFixed(2),
      low:+(meta.regularMarketDayLow||(dc.length?dc[dc.length-1].l:price)).toFixed(2),
      prevClose:+prev.toFixed(2),
      changePct:+((price-prev)/prev*100).toFixed(2),
      volume:lastVol,avgVolume:Math.round(avgVol),
      volRatio:avgVol>0?+(lastVol/avgVol).toFixed(2):0,
      marketState:meta.marketState||'CLOSED',
      currency:meta.currency||'INR',
      swingHigh:dc.length?+(Math.max(...dc.slice(-20).map(x=>x.h))).toFixed(2):0,
      swingLow:dc.length?+(Math.min(...dc.slice(-20).map(x=>x.l))).toFixed(2):0,
      last5Daily:dc.slice(-5).map(c=>`${c.t}:O${c.o}H${c.h}L${c.l}C${c.c}`).join(' | '),
      indicators:ind,patterns:pats,
      dailyBars:dc.length,fetchedAt:new Date().toISOString(),
    };
  } catch(e) {
    return {sym:sym.replace(/\.NS|\.BO|\^/g,''),error:e.response?.status===429?'Rate limited':e.message};
  }
}

// ─── FETCH — TIER 2 (adds LIVE 5-min intraday on top of daily) ────────────────
async function fetchLive(stock) {
  try {
    const r=await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.yfSym)}?interval=5m&range=1d&includePrePost=false`,
      {headers:YF_HDR,timeout:10000}
    );
    const result=r.data?.chart?.result?.[0];
    if(!result) return stock; // return daily data if intraday fails
    const q=result.indicators?.quote?.[0]||{};
    const ts=result.timestamp||[];
    const ic=ts.map((t,i)=>({
      t:new Date(t*1000).toISOString(),
      o:q.open?.[i]!=null?+q.open[i].toFixed(2):null,
      h:q.high?.[i]!=null?+q.high[i].toFixed(2):null,
      l:q.low?.[i]!=null?+q.low[i].toFixed(2):null,
      c:q.close?.[i]!=null?+q.close[i].toFixed(2):null,
      v:q.volume?.[i]||0,
    })).filter(c=>c.c!=null&&c.h!=null&&c.l!=null);

    // Update current price from intraday (more fresh than daily meta)
    const meta=result.meta||{};
    const freshPrice=meta.regularMarketPrice||stock.price;

    const intInd=ic.length>=10?indicators(ic):null;
    const intPats=ic.length>=8?detectPatterns(ic,intInd||stock.indicators):[];

    return {
      ...stock,
      price:+freshPrice.toFixed(2),
      marketState:meta.marketState||stock.marketState,
      intradayIndicators:intInd,
      intradayPatterns:intPats,
      last8Intraday:ic.slice(-8).map(c=>`O${c.o}H${c.h}L${c.l}C${c.c}`).join(' '),
      intradayBars:ic.length,
      liveAt:new Date().toISOString(),
    };
  } catch(e) {
    return stock; // graceful fallback to daily data
  }
}

// ─── TIER 1 BACKGROUND SCREENER ──────────────────────────────────────────────
async function runTier1() {
  if(CACHE.tier1Running) return;
  CACHE.tier1Running=true;
  CACHE.tier1Progress={scanned:0,total:NSE_UNIVERSE.length,status:'running'};
  console.log(`[${new Date().toISOString()}] Tier1 screener started — ${NSE_UNIVERSE.length} stocks`);

  const results=[];
  const batchSize=10;
  for(let i=0;i<NSE_UNIVERSE.length;i+=batchSize){
    const batch=NSE_UNIVERSE.slice(i,i+batchSize);
    const fetched=await Promise.allSettled(batch.map(fetchDaily));
    fetched.forEach(r=>{
      if(r.status==='fulfilled'&&r.value&&!r.value.error){
        const scored=scoreForScreen(r.value);
        if(scored) results.push(scored);
      }
    });
    CACHE.tier1Progress.scanned=Math.min(i+batchSize,NSE_UNIVERSE.length);
    if(i+batchSize<NSE_UNIVERSE.length) await new Promise(r=>setTimeout(r,400));
  }

  results.sort((a,b)=>b.screenScore-a.screenScore);
  CACHE.tier1=results.slice(0,40); // keep top 40
  CACHE.tier1At=new Date().toISOString();
  CACHE.tier1Running=false;
  CACHE.tier1Progress.status='done';
  console.log(`[${new Date().toISOString()}] Tier1 done — ${results.length} passed screening, top 40 cached`);
}

// ─── TIER 2 ON-DEMAND LIVE REFRESH ───────────────────────────────────────────
// Called when user clicks Generate — refreshes top 40 with live 5-min data
async function runTier2() {
  if(!CACHE.tier1.length) return [];
  console.log(`[${new Date().toISOString()}] Tier2 live refresh — ${CACHE.tier1.length} stocks`);
  const batchSize=10;
  const results=[];
  for(let i=0;i<CACHE.tier1.length;i+=batchSize){
    const batch=CACHE.tier1.slice(i,i+batchSize);
    const refreshed=await Promise.allSettled(batch.map(fetchLive));
    refreshed.forEach(r=>{
      if(r.status==='fulfilled'&&r.value) results.push(r.value);
    });
    if(i+batchSize<CACHE.tier1.length) await new Promise(r=>setTimeout(r,300));
  }
  // Re-score with live data (intraday patterns may add/remove from list)
  const rescored=results.map(d=>{
    const allPats=[...(d.patterns||[]),...(d.intradayPatterns||[])];
    const scored=scoreForScreen({...d,patterns:allPats});
    return scored||d; // keep even if below threshold (daily score still valid)
  });
  rescored.sort((a,b)=>(b.screenScore||0)-(a.screenScore||0));
  CACHE.tier2=rescored;
  CACHE.tier2At=new Date().toISOString();
  console.log(`[${new Date().toISOString()}] Tier2 done — ${rescored.length} stocks refreshed with live data`);
  return rescored;
}

// Start Tier 1 immediately and repeat every 55 min
runTier1();
setInterval(runTier1, 55*60*1000);

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get('/', (req,res)=>res.json({
  name:'Signal Server v5 — Two-tier screener',
  universe:NSE_UNIVERSE.length,
  tier1:{cached:CACHE.tier1.length,at:CACHE.tier1At,running:CACHE.tier1Running,progress:CACHE.tier1Progress},
  tier2:{cached:CACHE.tier2.length,at:CACHE.tier2At},
}));

app.get('/health',(req,res)=>res.json({
  ok:true,uptime:Math.round(process.uptime())+'s',time:new Date().toISOString(),
  screenerReady:!!CACHE.tier1At,tier1Stocks:CACHE.tier1.length,
}));

// Status endpoint — app polls this to show progress
app.get('/status',(req,res)=>res.json({
  universe:NSE_UNIVERSE.length,
  tier1:{cached:CACHE.tier1.length,at:CACHE.tier1At,running:CACHE.tier1Running,progress:CACHE.tier1Progress},
  tier2:{cached:CACHE.tier2.length,at:CACHE.tier2At},
}));

// ★ GENERATE — the main endpoint called when user clicks Generate
// Runs Tier 2 live refresh then returns final list for Claude
app.get('/generate',async(req,res)=>{
  if(!CACHE.tier1.length){
    return res.json({error:'Tier1 screener still running first scan. Wait 2-3 min.',tier1Progress:CACHE.tier1Progress});
  }
  const live=await runTier2();
  res.json({
    scanned:NSE_UNIVERSE.length,
    tier1Shortlisted:CACHE.tier1.length,
    tier2Refreshed:live.length,
    tier1At:CACHE.tier1At,
    tier2At:CACHE.tier2At,
    stocks:live.slice(0,20),
  });
});

// Batch prices for watchlist strip (uses cached tier1/tier2 if available, else fetches)
app.get('/prices',async(req,res)=>{
  const raw=req.query.symbols||'';
  const syms=raw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,30);
  if(!syms.length) return res.json({error:'Provide ?symbols=RELIANCE,HDFCBANK'});

  // Try to serve from cache first
  const data={};
  const toFetch=[];
  syms.forEach(s=>{
    const cached=[...CACHE.tier2,...CACHE.tier1].find(x=>x.sym===s);
    if(cached) data[s]=cached;
    else toFetch.push(s);
  });

  // Fetch uncached ones
  if(toFetch.length){
    const yfSyms=toFetch.map(s=>NSE_UNIVERSE.find(u=>u.replace('.NS','').replace('^','')===s)||s+'.NS');
    const results=await Promise.allSettled(yfSyms.map(fetchDaily));
    results.forEach((r,i)=>{data[toFetch[i]]=r.status==='fulfilled'?r.value:{sym:toFetch[i],error:r.reason?.message};});
  }
  res.json({fetchedAt:new Date().toISOString(),count:syms.length,data});
});

app.get('/price/:symbol',async(req,res)=>{
  const sym=req.params.symbol.toUpperCase();
  // Check cache first
  const cached=[...CACHE.tier2,...CACHE.tier1].find(x=>x.sym===sym);
  if(cached) return res.json(cached);
  const yf=NSE_UNIVERSE.find(u=>u.replace('.NS','').replace('^','')===sym)||sym+'.NS';
  res.json(await fetchDaily(yf));
});

app.get('/symbols',(req,res)=>res.json({count:NSE_UNIVERSE.length,universe:NSE_UNIVERSE}));

app.listen(PORT,'0.0.0.0',()=>console.log(`Signal server v5 on port ${PORT} — ${NSE_UNIVERSE.length} stocks in universe`));
