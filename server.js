/**
 * SIGNAL SERVER v8.0.2 — Lifecycle Release + Shadow Tracking + BE-Window + Leg-2 Gate
 *
 * v8.0.2 CHANGES (May 13, 2026 evening) — BACKLOG #1
 *   - New helper releaseStock(symbol, push_id, reason): frees a stock from
 *     Tier 2 watchlist and blocked_pushes so Tier 1 can detect fresh pushes
 *     on it. Called on: dismiss, manual exit, auto-close.
 *   - STATE.shadow_trades: parallel tracker for dismissed alerts. System
 *     keeps watching the alert's original entry/target/stop in the background
 *     ("what would have happened?") without affecting real P&L.
 *   - New endpoint POST /v8/dismiss-alert: moves alert to history with status
 *     DISMISSED, starts shadow tracking, releases stock.
 *   - New endpoint POST /v8/manual-exit-trade: closes a live trade at user-
 *     supplied fill price/time, moves to history (MANUAL_EXIT), releases stock.
 *   - New endpoint GET /v8/shadow-history: returns shadow (dismissed) trades.
 *   - Tier 3 auto-close now calls releaseStock after logging outcome.
 *   - Tier 3 shadow runner: tracks shadow trades alongside live trades, same
 *     target/stop/timeout logic but never affects real P&L. Hard EOD close
 *     at 15:30 IST.
 *   - /v8/dismiss (legacy endpoint) preserved for backwards compatibility,
 *     now also runs the new release+shadow flow.
 *   - reset-day clears shadow_trades.
 *   - LOG_MONITOR_BARS flipped to false (no longer needed for diagnosis;
 *     was filling Railway logs).
 *
 * v8.0.2 ADDITIONS (May 14, 2026 morning) — BACKLOG #7 + #9
 *   - Breakeven-window stop in Tier3Tracker (live + shadow):
 *       at +0.5R unrealized → move stop to entry + BE_BUFFER_ATR×ATR
 *       at +0.7R unrealized → release stop back to original (once released,
 *       never re-activates)
 *       Backtest: WR 53.6% → 56.9%, total R +15.21 → +13.16. Tradeoff: small
 *       EV cost for variance reduction.
 *       New trade fields: breakeven_active, breakeven_released, original_stop,
 *       stop_history[].
 *   - Leg-2 retrace gate in _buildCounterSignal:
 *       when counter trade about to fire AND leg 2 has extended past original
 *       push extreme, compute leg-2 retrace (% retreat from leg-2 peak back
 *       toward pullback-1 bottom, as % of leg-2 range). If < 40%, CANCEL with
 *       reason 'leg2_retrace_shallow'.
 *       Backtest (614 stock-days): rejects 8 fires worth −2.47R, WR 50% → 52%,
 *       total R +1.61 → +4.09.
 *
 * v8.0.1 CHANGES (May 12, 2026 evening)
 *   - Universe restricted to Nifty 100 (NIFTY100_SYMBOLS ∩ INSTRUMENT_TOKENS = 92 stocks).
 *     5-day backtest on full ~350-stock universe showed NEW engine has negative
 *     EV on mid/small caps. New engine was validated on 25-stock large-cap subset
 *     in May 13 backtest — restricting to Nifty 100 keeps the universe aligned
 *     with validation. To revert: clear NIFTY100_SYMBOLS to an empty Set.
 *
 * v8.0 CHANGES (May 14, 2026)
 *   - Tier 2 Monitor REPLACED with new pullback engine (NewTier2Monitor port from
 *     /mnt/project/new_pullback_engine.py — backtest +0.127 R/trade vs old +0.006).
 *   - 4 active strategies: Continuation at Level (pullback_at_level),
 *     Quick Reversal (deep_retrace_pb1), Combo (combo), Second Pullback Reversal
 *     (deep_retrace_pb2). Standalone swing_low_break and ema_fail gated off.
 *   - Score floor raised 50 → 60 (NEW_CFG.SCORE_FLOOR).
 *   - PB1 quality gate: ≥2 non-doji counter bars + ≥35% retrace before
 *     transitioning to POST_PULLBACK_1_NO_RT (kills shallow single-bar pullbacks).
 *   - S/R reconfirmation bonus (+5) and path-blocker penalty (−10) on counter trades.
 *   - Push quality reconfirmation bonus (+1 to +6) on counter trades.
 *   - Old Tier2Monitor preserved in server_old_engine_backup.js for rollback.
 *   - Orchestrator: passes entry.day_bars as 7th arg to Tier2Monitor constructor
 *     (needed for swing-stop / swing-veto on counter signals).
 *   - Orchestrator: old-engine CANCEL→COUNTER fallback gated by
 *     ENG.ALLOW_OLD_COUNTER_FALLBACK (defaulted false). New engine never returns
 *     CANCEL; its rejection paths return DUMP to keep new-engine self-contained.
 *
 * Prior v6.0 history retained:
 *   - Tier 1: Pattern pre-filter (H2 + RT candidates) via Kite API 5-min candles
 *   - Tier 1: Runs every 20 min, market hours only
 *   - Capital cap, stop validation, RT filters all preserved
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
  instrumentTokens: {},   // symbol -> token, fetched fresh after each login
  instrumentsFetchedAt: null,
};
function kiteToday() { return new Date().toISOString().split('T')[0]; }
function kiteReady() { return KITE.accessToken && KITE.authenticatedDate === kiteToday(); }

// ─── FETCH FRESH INSTRUMENT TOKENS FROM KITE ─────────────────────────────────
// Called once after each successful login
// Kite tokens can change — always fetch fresh, never hardcode
async function fetchInstrumentTokens() {
  if (!kiteReady()) return;
  try {
    console.log('[Kite] Fetching fresh instrument tokens from NSE...');
    const resp = await axios.get(`${KITE_BASE}/instruments/NSE`, {
      headers: {
        'X-Kite-Version': '3',
        'Authorization': `token ${KITE_API_KEY}:${KITE.accessToken}`
      },
      timeout: 15000,
    });
    // Response is CSV text: instrument_token,exchange_token,tradingsymbol,...
    const lines = resp.data.split('\n');
    const header = lines[0].toLowerCase().split(',');
    const tokenIdx  = header.indexOf('instrument_token');
    const symbolIdx = header.indexOf('tradingsymbol');
    const typeIdx   = header.indexOf('instrument_type');
    const map = {};
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 3) continue;
      const type   = parts[typeIdx]?.trim();
      const symbol = parts[symbolIdx]?.trim();
      const token  = parseInt(parts[tokenIdx]?.trim());
      // Only EQ (equity) instruments, skip futures/options
      if (type === 'EQ' && symbol && token && NSE_UNIVERSE.includes(symbol)) {
        map[symbol] = token;
        count++;
      }
    }
    KITE.instrumentTokens = map;
    KITE.instrumentsFetchedAt = new Date().toISOString();
    console.log(`[Kite] Instrument tokens loaded: ${count} stocks mapped`);
    // Trigger a fresh Tier 1 scan now that we have tokens
    if (isMarketHours()) {
      console.log('[Kite] Triggering Tier 1 scan with fresh tokens...');
      runTier1v7().catch(e => console.error('[Tier1 post-login] Error:', e.message));
    }
  } catch(e) {
    console.error('[Kite] Failed to fetch instruments:', e.response?.data?.message || e.message);
    // Will fall back to Yahoo Finance in fetchKite5Min
  }
}

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
  // ── EXPANSION: Nifty Midcap + popular F&O ──────────────────────────────
  'HAL':2513409,'BEL':98049,'BHARATFORG':81153,'ESCORTS':2901249,
  'MAXHEALTH':3916801,'NIACL':3875585,'GICRE':2974721,
  'MCX':3732737,'IEX':3920897,'CDSL':3445249,'CAMS':2704129,
  'MANAPPURAM':3400961,'ANGELONE':3771905,'MOTILALOS':3424513,
  'SBICARD':10666497,'LICHOUSING':511233,'CANFINHOME':149249,
  'PAYTM':3897601,'DELHIVERY':3905025,'NAUKRI':13209089,
  'ZYDUSLIFE':4003329,'GRANULES':2407425,'NATCOPHARM':3871489,
  'SUNDRPHARM':3957505,'IPCALAB':3878913,'AJANTPHARM':14977,
  'ALKEM':3748609,'AUROPHARMA':69121,'GLENMARK':305921,
  'LUPIN':2672641,'MANKIND':17857793,'TORNTPHARM':900609,
  'DIVISLAB':2800641,'BIOCON':3536129,
  'DEEPAKNTR':2172929,'NAVINFLUOR':3016193,'SRF':3796225,
  'FINEORG':3835393,'NOCIL':3881985,'VINATIORGA':3980801,
  'ROSSARI':3935745,'SUDARSCHEM':3955969,'LINDEINDIA':2938369,
  'GSFC':3475713,'GNFC':2937601,'CHAMBLFERT':194561,
  'ASTRAL':975873,'RELAXO':3927553,'BATAINDIA':70401,
  'RAYMOND':3924993,'WHIRLPOOL':3985921,'WESTLIFE':3984897,
  'PHOENIXLTD':3901697,'PRESTIGE':1790977,'SOBHA':3603969,
  'BRIGADE':3696641,'OBEROIRLTY':3633153,
  'DALBHARAT':2203073,'RAMCOCEM':3921921,'JKCEMENT':3832321,
  'IRCTC':3379969,'IRFC':3884545,'IRCON':3895297,'HUDCO':3519489,
  'GMRINFRA':3514369,'ADANIGREEN':2530049,'INOXWIND':2945793,
  'CESC':166913,'RPOWER':3939073,'NLCINDIA':3879937,
  'LATENTVIEW':3921921,'HAPPSTMNDS':3397121,'MASTEK':3851265,
  'TANLA':3965697,'INTELLECT':2979073,'TATATECH':23650049,
  'MINDTREE':3421441,'TATACOMM':3035137,
  'CHOLAFIN':175361,'SUNDARMFIN':857345,'MFSL':1068545,
  'RECLTD':3739137,'GODREJPROP':3061633,
  'MOIL':3404801,'JSPL':3001089,'JINDALSTEL':3001089,
  'BOSCHLTD':1136385,'TVSMOTOR':2170625,'MOTHERSON':4506753,
  'ENDURANCE':13209857,'JKTYRE':3664641,
  'APOLLOHOSP':41729,'LALPATHLAB':2983169,'METROPOLIS':17884161,
  'IIFL':3739393,'MUTHOOTFIN':3400961,'UJJIVAN':3974401,
  'UJJIVANSFB':3975425,'PNBHOUSING':3899649,
  'INDUSTOWER':3951617,'ZEEL':3991041,'SAREGAMA':3940865,
  'DELTACORP':2906881,'DEVYANI':2379265,'INDHOTEL':500209,
  'TEAMLEASE':3968257,'QUESS':3916545,
  'MPHASIS':4125697,'PERSISTENT':685569,'COFORGE':3358465,
  'LTTS':10751745,'HEXAWARE':3812609,'OFSS':621569,
  // ── BATCH 2: Nifty Midcap 150 + SmallCap F&O ──────────────────────────
  'ABCAPITAL':5533,'ABFRL':4668,'APLLTD':1956353,'ATUL':4337,
  'BAJAJHLDNG':2513,'CROMPTON':3463681,'DCMSHRIRAM':2205697,
  'ELGIEQUIP':2913,'ENGINERSIN':3536897,'GILLETTE':3492353,
  'GLAXO':2768641,'GODFRYPHLP':2937857,'GRAPHITE':393473,
  'GUJGASLTD':3001857,'HFCL':2697473,'HINDPETRO':359937,
  'IOC':415745,'JBCHEPHARM':3791105,'JINDALSAW':3504897,
  'JMFINANCIL':3749121,'KANSAINER':3840769,'KARURVYSYA':3845889,
  'KEI':3744513,'KNRCON':3714305,'KRBL':3805953,'L&TFH':2370049,
  'LUXIND':3848449,'MAHINDCIE':3826177,'MRPL':3869697,
  'NILKAMAL':3877633,'ORIENTELEC':3889409,'PGHH':3899393,
  'POLYMED':3905793,'PRAJIND':3910913,'PRINCEPIPE':3911425,
  'RAJESHEXPO':3921665,'RATNAMANI':3923969,'REDINGTON':3926529,
  'RITES':3931649,'ROUTE':3936257,'SAFARI':3939841,
  'SCHAEFFLER':3942657,'SKFINDIA':3948033,'SOLARINDS':3950337,
  'STARCEMENT':3952129,'STLTECH':3952641,'SUMICHEM':3956993,
  'SUPREMEIND':3960577,'SYNGENE':3963393,'VAIBHAVGBL':3977217,
  'VIPIND':3981569,'VSTIND':3982593,'WOCKPHARMA':3987713,
  'ZYDUSWELL':3992577,'BAJAJELEC':3459073,'BLUESTARCO':3469697,
  'BORORENEW':3471489,'CEATLTD':158465,'CENTURYPLY':3473281,
  'CHAMBLFERT':194561,'CMSINFO':3475585,'COCHINSHIP':178433,
  'CREDITACC':2796801,'CRISIL':2994177,'DATAPATTNS':3410433,
  'EIHOTEL':3490817,'EQUITASBNK':3995393,'FIVESTAR':3997441,
  'FORTIS':3803905,'FSL':3820289,'GRINDWELL':3831553,
  'HATSUN':2508289,'HGS':3823873,'HIKAL':2984449,
  'HINDCOPPER':3505921,'HUDCO':3519489,'IGPL':3521025,
  'INDIAMART':3843329,'INTELLECT':2979073,'ISGEC':3534337,
  'ITDCEM':3536129,'J&KBANK':3362561,'JKLAKSHMI':3542529,
  'JKPAPER':3545601,'JKTYRE':3664641,'JSWENERGY':3547393,
  'JUBILANT':3549697,'KALPATPOWR':3553537,'KAVERI':3554817,
  'KFINTECH':3744769,'KNR':3714305,'KOTAKBANK':492033,
  'KPRMILL':3563777,'LANTMANH':3566081,'LAXMIMACH':3567361,
  'LEMONTREE':3774209,'LICHOUSING':511233,'LLOYDSENGG':3574209,
  'MAFANG':3577025,'MARICO':1041153,'MASTEK':3851265,
  'MAXIND':3584769,'MCDOWELL-N':3586817,'MINDAIND':3590913,
  'MIRZAINT':3592961,'MGL':3595777,'MMTC':3867649,
  'MOSCHIP':3601025,'MSTCLTD':3603329,'NAUKRI':13209089,
  'NAVA':3609601,'NAVNETEDUL':3611393,'NBCC':3050497,
  'NESCO':3613697,'NETWORK18':3615489,'NLCINDIA':3879937,
  'NOCIL':3881985,'NRBBEARING':3619329,'NUVOCO':3621377,
  'OLECTRA':3625729,'PAGEIND':3628033,'PANACHE':3629825,
  'PCBL':3632129,'PDSL':3634177,'PFIZER':3636481,
  'PNCINFRA':3638785,'PNBHOUSING':3899649,'POLYCAB':3898241,
  'POWERINDIA':3641089,'POWERIND':3642625,'PRESTIGE':1790977,
  'PRICOLLTD':3644929,'PRISMJOHNS':3646721,'PRIVISCL':3913473,
  'QUESS':3916545,'RAIN':3651841,'RAJRATAN':3653633,
  'RAMCOIND':3655681,'RAMKRISHNA':3657729,'RANE':3659777,
  'RBLBANK':4707329,'RECLTD':3739137,'REPCO':3665985,
  'ROSSARI':3935745,'RPSGVENT':3938305,'RTNPOWER':3672321,
  'SADBHAV':3676161,'SANOFI':3678209,'SAPPHIRE':3680257,
  'SBILIFE':21001217,'SEQUENT':3944705,'SHARDACROP':3686401,
  'SHRIRAMFIN':3688449,'SIEMENS':806401,'SOBHA':3603969,
  'SOLARA':3693825,'SPANDANA':3951105,'SPARC':3695361,
  'SSWL':3699201,'SURYAROSNI':3701249,'SUZLON':837633,
  'SYMPHONY':3703553,'TANLA':3965697,'TATACONSUM':878593,
  'TATAINVEST':3966721,'TATAPOWER':877057,'TCNSCLOTH':3967489,
  'TEAMLEASE':3968257,'TECHNOE':3969793,'TEXRAIL':3971073,
  'THYROCARE':3972609,'TIMKEN':3974401,'TITAN':897537,
  'TRENT':1598465,'TRIDENT':3977729,'TRITURBINE':3978497,
  'UJJIVAN':3974401,'ULTRACEMCO':2952193,'UNIPARTS':3981057,
  'VAIBHAVGBL':3977217,'VARDHMAN':3983105,'VBL':2988801,
  'VEDL':784129,'VINATIORGA':3980801,'VOLTAMP':3986433,
  'VSTIND':3982593,'WELCORP':3990017,'WENDT':3991297,
  'WESTLIFE':3984897,'WHIRLPOOL':3985921,'WIPRO':969473,
  'WOCKPHARMA':3987713,'WONDERLA':3989249,'YESBANK':3250049,
  'ZEEL':3991041,'ZENSARTECH':3993089,'ZOMATO':2123777,
  'ZENTEC':3992577,'ZUARIIND':3994881,
};

// ─── NIFTY 100 FILTER (v8.0.1, May 12, 2026) ─────────────────────────────────
// Backtest on full ~350-stock universe showed NEW engine has negative EV on
// mid/small caps. Restrict to Nifty 100 (where the May 13 backtest validated
// +0.127 R/trade EV) to keep signal quality high while running NEW engine live.
// To revert: change NIFTY100_SYMBOLS to an empty Set — universe falls back to
// the full INSTRUMENT_TOKENS list.
const NIFTY100_SYMBOLS = new Set([
  // Nifty 50
  'RELIANCE','HDFCBANK','ICICIBANK','TCS','INFY','BHARTIARTL','SBIN','ITC',
  'HINDUNILVR','LT','KOTAKBANK','AXISBANK','BAJFINANCE','MARUTI','ASIANPAINT',
  'TITAN','HCLTECH','SUNPHARMA','NESTLEIND','ULTRACEMCO','ADANIENT','WIPRO',
  'M&M','ONGC','JSWSTEEL','TATAMOTORS','NTPC','POWERGRID','TATASTEEL',
  'BAJAJFINSV','COALINDIA','HINDALCO','TECHM','INDUSINDBK','CIPLA','DRREDDY',
  'BAJAJ-AUTO','BPCL','ADANIPORTS','SHRIRAMFIN','GRASIM','HEROMOTOCO',
  'DIVISLAB','SBILIFE','HDFCLIFE','BRITANNIA','EICHERMOT','APOLLOHOSP',
  'LTIM','TATACONSUM',
  // Nifty Next 50
  'ABB','ADANIGREEN','ADANIPOWER','AMBUJACEM','BAJAJHLDNG','BANKBARODA',
  'BERGEPAINT','BOSCHLTD','CANBK','CGPOWER','CHOLAFIN','COLPAL','DABUR',
  'DLF','DMART','GAIL','GODREJCP','HAL','HAVELLS','HINDPETRO','ICICIGI',
  'ICICIPRULI','INDIGO','INDUSTOWER','IOC','IRCTC','IRFC','JINDALSTEL',
  'JIO','JIOFIN','JSWENERGY','LICI','LODHA','MARICO','MOTHERSON','NAUKRI',
  'NHPC','OFSS','PFC','PIDILITIND','POWERFIN','PNB','RECLTD','SIEMENS',
  'SUZLON','TATAPOWER','TORNTPHARM','TRENT','TVSMOTOR','VBL','ZOMATO',
  'ZYDUSLIFE','UNIONBANK',
]);

// All stocks we scan — symbols only (Kite tokens looked up from map above).
// Filtered to Nifty 100 intersected with INSTRUMENT_TOKENS (some Nifty 100
// names like ITC/JIO/JIOFIN don't have hardcoded tokens — they'll be skipped
// unless you add them to INSTRUMENT_TOKENS).
const NSE_UNIVERSE = Object.keys(INSTRUMENT_TOKENS).filter(s => NIFTY100_SYMBOLS.has(s));

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
  'HAL':'Defence','BEL':'Defence','MIDHANI':'Defence','BHARAT FORGE':'Defence',
  'BHARATFORG':'Auto','ESCORTS':'Auto','FORCEMOT':'Auto',
  'MAXHEALTH':'Healthcare','APOLLOHOSP':'Healthcare','METROPOLIS':'Healthcare',
  'RITES':'Infra','IRCON':'Infra','IRFC':'Infra','HUDCO':'Infra','NBCC':'Infra',
  'INDUSTOWER':'Telecom','ZEEL':'Media','ZEEMEDIA':'Media','SAREGAMA':'Media',
  'MCX':'Finance','IEX':'Finance','CDSL':'Finance','CAMS':'Finance',
  'MANAPPURAM':'Finance','MUTHOOTFIN':'Finance','LICHSGFIN':'Finance',
  'ANGELONE':'Finance','NUVAMA':'Finance','MOTILALOS':'Finance',
  'PAYTM':'FinTech','SBICARD':'Finance',
  'ZYDUSLIFE':'Pharma','SUNDRPHARM':'Pharma','GRANULES':'Pharma',
  'NATCOPHARM':'Pharma','SEQUENT':'Pharma','SUVENPHAR':'Pharma',
  'DEEPAKNTR':'Chemicals','NAVINFLUOR':'Chemicals','SRF':'Chemicals',
  'FINEORG':'Chemicals','NOCIL':'Chemicals','SUDARSCHEM':'Chemicals',
  'TATACHEM':'Chemicals','ROSSARI':'Chemicals','VINATIORGA':'Chemicals',
  'ASTRAL':'Consumer','RELAXO':'Consumer','BATA':'Consumer','BATAINDIA':'Consumer',
  'RAYMOND':'Consumer','WHIRLPOOL':'Consumer','WESTLIFE':'Consumer',
  'TEAMLEASE':'Services','QUESS':'Services','HGS':'Services',
  'DELHIVERY':'Logistics','CONCOR':'Logistics','SNOWMAN':'Logistics',
  'LATENTVIEW':'IT','HAPPSTMNDS':'IT','MASTEK':'IT','TANLA':'IT',
  'KPITTECH':'IT','INTELLECT':'IT','BIRLASOFT':'IT','CYIENT':'IT',
  'GMRINFRA':'Infra','ADANIGREEN':'Energy','INOXWIND':'Energy',
  'TATAPOWER':'Energy','SUZLON':'Energy','NHPC':'Energy','SJVN':'Energy',
  'CESC':'Energy','RPOWER':'Energy',
  'DALBHARAT':'Cement','RAMCOCEM':'Cement','JKCEMENT':'Cement',
  'PHOENIXLTD':'Realty','PRESTIGE':'Realty','SOBHA':'Realty',
  'BRIGADE':'Realty','OBEROIRLTY':'Realty','GODREJPROP':'Realty',
  'JKTYRE':'Auto','APOLLOTYRE':'Auto','CEATLTD':'Auto','MRF':'Auto',
  'BALKRISIND':'Auto','MOTHERSON':'Auto','BOSCHLTD':'Auto',
  'LINDEINDIA':'Chemicals','GSFC':'Chemicals','GNFC':'Chemicals',
  'CHAMBLFERT':'Chemicals','EIDPARRY':'FMCG','GODREJCP':'FMCG',
  'TATACONSUM':'FMCG','JUBLFOOD':'Consumer','VBL':'FMCG',
}

// ─── CACHE ────────────────────────────────────────────────────────────────────
let CACHE = {
  tier1H2: [],   // H2 candidates from pattern pre-filter
  tier1RT: [],   // RT candidates from pattern pre-filter
  tier1At: null,
  tier1Running: false,
  tier1Progress: { scanned: 0, total: 0, status: 'idle' },
  tier2: [],
  tier2At: null,
  autoAlerts:   [],   // Latest signals from auto Tier 2
  autoAlertsAt: null, // When last generated
};

// ─── CACHE ────────────────────────────────────────────────────────────────────

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
    // Fetch fresh instrument tokens in background (don't await — let login page respond fast)
    fetchInstrumentTokens().catch(e => console.error('[Instruments] Error:', e.message));
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

// ─── 5-MIN CANDLE FETCH — Kite primary, Yahoo fallback ──────────────────────
// Uses fresh instrument tokens fetched from Kite /instruments/NSE after login
// Falls back to Yahoo Finance if token not available yet (e.g. before first login)
async function fetchKite5Min(symbol) {
  // Try Kite first (authoritative NSE data)
  const token = KITE.instrumentTokens[symbol];
  if (token && kiteReady()) {
    const now     = new Date();
    const from    = new Date(now); from.setDate(from.getDate() - 5);
    const fromStr = from.toISOString().split('T')[0];
    const toStr   = now.toISOString().split('T')[0];
    try {
      const url = `${KITE_BASE}/instruments/historical/${token}/5minute?from=${fromStr}&to=${toStr}&continuous=0&oi=0`;
      const resp = await axios.get(url, {
        headers: {
          'X-Kite-Version': '3',
          'Authorization': `token ${KITE_API_KEY}:${KITE.accessToken}`
        },
        timeout: 8000,
      });
      const candles = (resp.data?.data?.candles || []).map(c => ({
        t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5]
      })).filter(c => c.c > 0);
      if (candles.length >= 10) return candles;
      // If Kite returned empty (holiday/error), fall through to Yahoo
    } catch(e) {
      if (e.response?.status === 403) {
        KITE.accessToken = null;
        console.log('[Kite] Token expired — re-login required');
      }
      // Fall through to Yahoo
    }
  }

  // Fallback: Yahoo Finance (used before first login or if Kite fails)
  const yfSym = symbol + '.NS';
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=5m&range=2d&includePrePost=false`,
      { headers: YF_HDR, timeout: 10000 }
    );
    const result = r.data?.chart?.result?.[0];
    if (!result) return null;
    const q  = result.indicators?.quote?.[0] || {};
    const ts = result.timestamp || [];
    const candles = ts.map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      o: q.open?.[i]  != null ? +q.open[i].toFixed(2)  : null,
      h: q.high?.[i]  != null ? +q.high[i].toFixed(2)  : null,
      l: q.low?.[i]   != null ? +q.low[i].toFixed(2)   : null,
      c: q.close?.[i] != null ? +q.close[i].toFixed(2) : null,
      v: q.volume?.[i] || 0,
    })).filter(c => c.c != null && c.h != null && c.l != null && c.c > 0);
    return candles.length >= 10 ? candles : null;
  } catch(e) {
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

// computeMicroZones removed (replaced by computeZonesPD in new engine)
function computeSR(candles) {
  const n = candles.length;
  if (n < 20) return { supports: [], resistances: [], atr: 1 };
  const atr      = computeATR(candles);
  const cur      = candles[n-1].c;
  const touchTol = atr * 0.5;
  const minClose = atr * 0.15;
  const avgVol   = candles.reduce((s,b) => s+b.v, 0) / n || 1;
  const today    = candles[n-1].t.slice(0, 10);

  // Grid scan: ±9% of current price in steps of 0.25×ATR
  const step = atr * 0.25;
  const lo   = cur * 0.91;
  const hi   = cur * 1.09;
  const grid = [];
  for (let lev = lo; lev <= hi; lev += step) grid.push(+lev.toFixed(2));

  const results = [];

  grid.forEach(level => {
    const rr = [], rc = [], sr2 = [], sc = [];

    for (let i = 1; i < n; i++) {
      const b    = candles[i];
      const prev = candles[i-1];
      const isToday = b.t.slice(0,10) === today;
      const vm   = b.v > avgVol * 1.5 ? 1.3 : 1.0;
      const br   = b.h - b.l || atr;
      const date = b.t.slice(0,10);

      // Resistance interactions (approach from below)
      if (prev.c < level) {
        if (Math.abs(b.h - level) <= touchTol && b.c < level - minClose) {
          // Sharp rejection
          rr.push({ q: Math.min((level-b.c)/br, 1)*vm, today:isToday, date, sharp:true });
        } else if (Math.abs(b.h - level) <= touchTol && b.c < level) {
          // Mild cluster
          rc.push({ q: (1-(level-b.c)/touchTol)*vm*0.6, today:isToday, date, sharp:false });
        }
      }

      // Support interactions (approach from above)
      if (prev.c > level) {
        if (Math.abs(b.l - level) <= touchTol && b.c > level + minClose) {
          // Sharp rejection
          sr2.push({ q: Math.min((b.c-level)/br, 1)*vm, today:isToday, date, sharp:true });
        } else if (Math.abs(b.l - level) <= touchTol && b.c > level) {
          // Mild cluster
          sc.push({ q: (1-(b.c-level)/touchTol)*vm*0.6, today:isToday, date, sharp:false });
        }
      }

      // Consolidation: bar opened AND closed near level (price AT level)
      if (Math.abs(b.c - level) <= touchTol*0.5 && Math.abs(b.o - level) <= touchTol*0.5) {
        rr.push({ q: 0.3*vm, today:isToday, date, sharp:false });
        sr2.push({ q: 0.3*vm, today:isToday, date, sharp:false });
      }
    }

    const scoreSide = (rej, cls, tp) => {
      const allR = [...rej, ...cls];
      if (!allR.length) return;
      const priorDates = new Set(allR.filter(r => !r.today).map(r => r.date));
      const todayHits  = allR.filter(r => r.today);
      const pc = priorDates.size;
      let base = pc>=3 ? 60 : pc===2 ? 45 : pc===1 ? 25
               : todayHits.length>=3 ? 15 : todayHits.length>=2 ? 8 : 0;
      if (!base) return;
      const avgQ    = allR.reduce((s,r) => s+r.q, 0) / allR.length;
      const sharpRatio = rej.length / allR.length;
      const score   = (base + avgQ*40) / 100 * (0.65 + 0.35*sharpRatio);
      results.push({
        level, type: tp,
        score:           +score.toFixed(3),
        priorDayTouches: pc,
        totalTouches:    allR.length,
        sharpRejections: rej.length,
        mildClusters:    cls.length,
        tier: pc>=2 ? 'T1' : pc>=1 ? 'T2' : 'T3',
      });
    };

    scoreSide(rr, rc, 'res');
    scoreSide(sr2, sc, 'sup');
  });

  // Deduplicate: 0.75×ATR minimum distance between same-type levels
  results.sort((a,b) => b.score - a.score);
  const deduped = [];
  results.forEach(r => {
    if (!deduped.find(d => d.type===r.type && Math.abs(d.level-r.level) <= atr*0.75))
      deduped.push(r);
  });

  return {
    supports:    deduped.filter(l => l.type==='sup').slice(0, 8),
    resistances: deduped.filter(l => l.type==='res').slice(0, 8),
    atr,
  };
}

// findH2Signals, computeBreakoutScore — removed (replaced by Tier2Monitor)
function computeRSI(candles, idx, period=14){
  if(idx < period+1) return null;
  const slice = candles.slice(Math.max(0,idx-period*2), idx+1);
  if(slice.length < period+1) return null;
  let gains=0, losses=0;
  for(let i=slice.length-period; i<slice.length; i++){
    const d = slice[i].c - slice[i-1].c;
    if(d>0) gains+=d; else losses+=(-d);
  }
  const ag=gains/period, al=losses/period;
  if(al===0) return 100;
  return Math.round(100 - 100/(1+ag/al));
}

// findRTSignals removed
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// NEW ENGINE v7.1 — Full port of Python tier2_engine.py
// ═══════════════════════════════════════════════════════════════════════════

const ENG = {
  MIN_SLOPE_PCT: 0.30, MIN_ATR_MULT: 2.0, MIN_BARS: 3,
  RETRACE_CANCEL: 0.80, RETRACE_MIN: 0.20, RETRACE_FLAG: 0.30,
  RETRACE_H1_HIGH: 0.40, RETRACE_H1_DEEP: 0.60,
  MAX_BARS: 12, EARLY_DUMP_BARS: 5,
  STOP_BUFFER: 1.0, TARGET_PCT: 0.50,
  DOJI_BODY: 0.30, EXHAUSTION_BARS: 3,
  RSI_PERIOD: 9, RSI_BULL: 60, RSI_BEAR: 40,
  RT_TOUCH_TOL: 0.75,
  EXHAUSTION_RANGE_MULT: 1.5, EXHAUSTION_CLOSE_PCT: 0.40,
  STOP_VALIDATION_LOOKBACK: 5, STOP_VALIDATION_TOL: 0.30,
  PUSH_EXPIRY_BARS: 2,
  // v8.0: disable old-engine CANCEL→COUNTER fallback path in orchestrator.
  // New engine's counter signals are self-contained; rejection should DUMP,
  // not silently fall back to old-engine counter logic. Flip to true only if
  // rolling back to the old engine.
  ALLOW_OLD_COUNTER_FALLBACK: false,
};

const RULE = {
  H2_ENDS_MONITOR: true, H1_CONFIRMATION: false,
  EXHAUSTION_FILTER: true, TARGET_VS_RESIST: true,
  STOP_VALIDATION: true, BROKEN_BY_CLOSE: true,
};

// ── New Tier 2 engine config (May 13, 2026 redesign — v8.0) ──
const NEW_CFG = {
  // Pullback 1 quality gate — single-bar / shallow pullbacks blocked
  PB1_MIN_COUNTER_BARS: 2,
  PB1_MIN_RETRACE: 0.35,

  // Trigger enable/disable (standalone disabled, combo keeps both signals)
  ENABLE_EMA_FAIL_STANDALONE: false,
  ENABLE_PB_LOW_BREAK_STANDALONE: false,

  // Retrace thresholds
  RETRACE_DEEP_PULLBACK_1: 0.70,  // Quick Reversal fires above this
  RETRACE_DEEP_PULLBACK_2: 0.50,  // Second Pullback Reversal fires above this

  // Leg 2 quality (for adaptive target on counter trades)
  MEANINGFUL_LEG2_BARS: 2,
  MEANINGFUL_LEG2_ATR_MULT: 1.0,

  // Combo trigger bonus
  COMBO_TRIGGER_BONUS: 5,

  // S/R reconfirmation
  ENABLE_SR_RECONFIRMATION: true,
  SR_RECONFIRM_TOL_ATR: 0.30,
  SR_RECONFIRM_BONUS: 5,
  SR_PATH_BLOCKER_PENALTY: -10,

  // Push quality reconfirmation
  ENABLE_PUSH_QUALITY_RECONFIRM: true,
  PUSH_QUALITY_MIN_BARS: 4,
  PUSH_QUALITY_MIN_ATR_MULT: 3.0,
  PUSH_QUALITY_MIN_END_TIME: '10:00',

  // Score floor (raised from 50 to 60 in v8.0)
  SCORE_FLOOR: 60,

  // v8.0.1: diagnostic logging. True = one log line per bar per monitor.
  // Verbose but tells us why monitors aren't firing. Set false once issue understood.
  // v8.0.2 (May 13 EOD): flipped to false — engine verified working live, no longer needed.
  LOG_MONITOR_BARS: false,

  // v8.0.2 (BACKLOG #7): Breakeven-window stop on Tier3Tracker
  ENABLE_BREAKEVEN_WINDOW: true,
  BE_ACTIVATE_R: 0.5,          // unrealized R to turn BE on
  BE_RELEASE_R: 0.7,           // unrealized R to release BE back to original
  BE_BUFFER_ATR: 0.05,         // buffer past entry (× ATR) in profit direction

  // v8.0.2 (BACKLOG #9): Leg-2 retrace gate on counter signals
  ENABLE_LEG2_RETRACE_GATE: true,
  LEG2_RETRACE_MIN: 0.40,      // reject counter fire if leg-2 retrace < this
};

function barMove(bar, prevClose) {
  if (prevClose <= 0) return bar.c > bar.o ? 'up' : bar.c < bar.o ? 'down' : 'flat';
  const chg = (bar.c - prevClose) / prevClose * 100;
  if (chg > 0.005) return 'up';
  if (chg < -0.005) return 'down';
  if (bar.c > bar.o) return 'up';
  if (bar.c < bar.o) return 'down';
  return 'flat';
}
function bodyPct(bar) { const br = bar.h - bar.l; return br <= 0 ? 0 : Math.abs(bar.c - bar.o) / br; }
function isDoji(bar) { const br = bar.h - bar.l; if (br <= 0) return true; return Math.abs(bar.c - bar.o) / br < ENG.DOJI_BODY; }
function computeRetrace(bar, push) {
  const pushRange = push.push_range || Math.abs(push.extreme - push.start_price);
  if (pushRange <= 0) return 0;
  let diff;
  if (push.is_up) { const sh = push.swing_high || push.extreme; diff = sh - bar.l; }
  else { const sl = push.swing_low || push.extreme; diff = bar.h - sl; }
  return Math.max(0, diff) / pushRange;
}
function computeRSIEngine(candles, period) {
  period = period || ENG.RSI_PERIOD;
  if (candles.length < period + 1) return 50.0;
  const closes = candles.slice(-(period+1)).map(c => c.c);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses += -diff;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - (100 / (1 + avgG / avgL));
}

function computeZonesPD(candles) {
  const minRun = 3, dropThr = 0.0005, riseThr = 0.0005, minZoneBars = 3, sharpMove = 0.0025;
  const n = candles.length;
  if (n < 2) return [];
  const bm = new Array(n).fill('flat');
  if (candles[0].c > candles[0].o) bm[0] = 'up';
  else if (candles[0].c < candles[0].o) bm[0] = 'down';
  for (let i = 1; i < n; i++) {
    const chg = (candles[i].c - candles[i-1].c) / (candles[i-1].c || 1) * 100;
    if (chg > 0.005) bm[i] = 'up';
    else if (chg < -0.005) bm[i] = 'down';
    else { if (candles[i].c < candles[i].o) bm[i] = 'down'; else if (candles[i].c > candles[i].o) bm[i] = 'up'; }
  }
  const bd = new Array(n).fill('range');
  const sharp = new Set();
  let i = 1;
  while (i < n) {
    const rd = bm[i]; if (rd === 'flat') { i++; continue; }
    let re = i, ints = 0;
    for (let j = i+1; j < n; j++) {
      if (bm[j] === rd) { re = j; ints = 0; }
      else if (bm[j] === 'flat' && ints < 1) ints++;
      else break;
    }
    let rs = i; if (i > 0 && bm[i-1] === rd && bd[i-1] === 'range') rs = i - 1;
    const rl = re - rs + 1;
    if (rl >= minRun) {
      const sp = rs > 0 ? candles[rs-1].c : candles[0].o;
      const ep = candles[re].c;
      const tm = (ep - sp) / (sp || 1) * 100;
      if ((rd === 'down' && tm < -dropThr*100) || (rd === 'up' && tm > riseThr*100)) {
        for (let k = rs; k <= re; k++) bd[k] = rd;
        i = re + 1; continue;
      }
    }
    i++;
  }
  for (let i = 1; i < n-1; i++) {
    if (bd[i] !== 'range' && bd[i+1] !== 'range') continue;
    const d1 = bm[i], d2 = bm[i+1];
    if (d1 !== d2 || d1 === 'flat') continue;
    const tm = (candles[i+1].c - candles[i-1].c) / (candles[i-1].c || 1) * 100;
    if ((d1 === 'up' && tm > sharpMove*100) || (d1 === 'down' && tm < -sharpMove*100)) {
      bd[i] = d1; bd[i+1] = d1; sharp.add(i); sharp.add(i+1);
    }
  }
  const raw = [];
  let zs = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || bd[i] !== bd[i-1]) { raw.push({ start: zs, end: i-1, dir: bd[i-1], bars: i-zs }); zs = i; }
  }
  const merged = [];
  for (const z of raw) {
    if (merged.length && merged[merged.length-1].dir === z.dir) { merged[merged.length-1].end = z.end; merged[merged.length-1].bars += z.bars; }
    else merged.push({...z});
  }
  const absorbed = [];
  for (const z of merged) {
    let hasS = false;
    for (let k = z.start; k <= z.end; k++) if (sharp.has(k)) { hasS = true; break; }
    if (z.bars >= minZoneBars || hasS) absorbed.push({...z});
    else if (absorbed.length) { absorbed[absorbed.length-1].end = z.end; absorbed[absorbed.length-1].bars += z.bars; }
    else absorbed.push({...z});
  }
  const MID_MIN = 0.15;
  for (const z of absorbed) {
    const zb = candles.slice(z.start, z.end+1);
    z.slope = zb.length > 1 ? ((zb[zb.length-1].c - zb[0].o) / (zb[0].o || 1) * 100) : 0;
    if (zb.length > 1) { const f = (zb[0].h+zb[0].l)/2; const l = (zb[zb.length-1].h+zb[zb.length-1].l)/2; z.slope_mid = (l-f)/(f||1)*100; }
    else z.slope_mid = 0;
    if (z.dir !== 'range' && Math.abs(z.slope_mid) < MID_MIN) z.dir = 'range';
    if (z.dir !== 'range') {
      const thr = z.dir === 'up' ? riseThr : dropThr;
      const ratio = Math.abs(z.slope) / ((thr*100) || 0.05);
      z.strength = ratio >= 5 ? 'Strong' : ratio >= 2 ? 'Moderate' : 'Weak';
    } else {
      if (zb.length < 2) z.strength = 'Weak';
      else {
        const r = zb.map(b => (b.h-b.l)/(b.l||1)*100);
        const m = r.reduce((a,b)=>a+b,0)/r.length || 1;
        const v = r.reduce((s,x)=>s+(x-m)**2,0)/r.length;
        const cv = Math.sqrt(v) / m;
        z.strength = cv < 0.25 ? 'Strong' : cv < 0.50 ? 'Moderate' : 'Weak';
      }
    }
  }
  const final = [];
  for (const z of absorbed) {
    if (final.length && final[final.length-1].dir === 'range' && z.dir === 'range') { final[final.length-1].end = z.end; final[final.length-1].bars += z.bars; }
    else final.push({...z});
  }
  return final;
}

function findQualifyingPush(todayBars, atr) {
  if (todayBars.length < 6) return null;
  const zones = computeZonesPD(todayBars);
  const n = todayBars.length;
  const qual = [];
  for (const z of zones) {
    if (z.dir !== 'up' && z.dir !== 'down') continue;
    if (z.bars < ENG.MIN_BARS) continue;
    if (z.strength !== 'Strong') continue;
    if ((n - 1 - z.end) < 2) continue;
    const ts = todayBars[z.start].t.slice(11,16);
    const te = todayBars[z.end].t.slice(11,16);
    const net = Math.abs(todayBars[z.end].c - todayBars[z.start].o);
    const mid = Math.abs(z.slope_mid || 0);
    if (mid < ENG.MIN_SLOPE_PCT || net < atr * ENG.MIN_ATR_MULT) continue;
    const isUp = z.dir === 'up';
    const pb = todayBars.slice(z.start, z.end+1);
    const sh = Math.max(...pb.map(b => b.h));
    const sl = Math.min(...pb.map(b => b.l));
    const ext = isUp ? sh : sl;
    const hc = Math.max(...pb.map(b => b.c));
    const lc = Math.min(...pb.map(b => b.c));
    const pr = sh - sl;
    qual.push({
      dir: z.dir, is_up: isUp, start_idx: z.start, end_idx: z.end, bars: z.bars,
      start_time: ts, end_time: te,
      start_price: todayBars[z.start].o, end_price: todayBars[z.end].c,
      extreme: +ext.toFixed(2), highest_close: +hc.toFixed(2), lowest_close: +lc.toFixed(2),
      swing_high: +sh.toFixed(2), swing_low: +sl.toFixed(2),
      push_range: +pr.toFixed(2), net_move: +pr.toFixed(2), move: +pr.toFixed(2),
      slope_mid: +mid.toFixed(3), atr: +atr.toFixed(2),
      push_id: `${z.dir}_${ts}_${Math.round(ext*10)/10}`,
    });
  }
  return qual.length ? qual[qual.length-1] : null;
}

function checkRTTouch(bar, push, brokenSR, atr) {
  for (const lvl of brokenSR) {
    const lv = lvl.level;
    let dist, held;
    if (push.is_up) { dist = Math.abs(bar.l - lv); held = bar.c > lv - atr * 0.3; }
    else { dist = Math.abs(bar.h - lv); held = bar.c < lv + atr * 0.3; }
    if (dist <= atr * ENG.RT_TOUCH_TOL && held) return lvl;
  }
  return null;
}

function checkCounterSwingVeto(push, bar, atr, dayBars) {
  const counterIsUp = !push.is_up;
  const entry = bar.c;
  const tol = atr * 0.5;
  if (dayBars.length < 7) return true;
  if (counterIsUp) {
    for (let j = 3; j < dayBars.length - 3; j++) {
      const tH = dayBars[j].h;
      const lM = Math.max(...dayBars.slice(j-3, j).map(b => b.h));
      const rM = Math.max(...dayBars.slice(j+1, j+4).map(b => b.h));
      if (tH > lM && tH > rM && tH - entry > 0 && tH - entry < tol) return false;
    }
  } else {
    for (let j = 3; j < dayBars.length - 3; j++) {
      const tL = dayBars[j].l;
      const lM = Math.min(...dayBars.slice(j-3, j).map(b => b.l));
      const rM = Math.min(...dayBars.slice(j+1, j+4).map(b => b.l));
      if (tL < lM && tL < rM && entry - tL > 0 && entry - tL < tol) return false;
    }
  }
  return true;
}

function scoreSignal(push, h1Retrace, h1Bars, signalBar, srLevels, ema, contextScore, atr, sigType, rsi) {
  const sc = {};
  const slope = push.slope_mid || 0;
  const netAtr = (push.net_move || push.move) / (push.atr || atr || 1);
  let pq;
  if (slope >= 1.0 && netAtr >= 6) pq = 20;
  else if (slope >= 0.75 && netAtr >= 5) pq = 17;
  else if (slope >= 0.60 && netAtr >= 4) pq = 14;
  else if (slope >= 0.50 && netAtr >= 3) pq = 10;
  else pq = 5;
  sc.push_quality = pq;

  let rq;
  if (sigType === 'RT' || sigType === 'RT+H1') rq = 18;
  else if (h1Retrace <= 0.30) rq = 20;
  else if (h1Retrace <= 0.40) rq = 18;
  else if (h1Retrace <= 0.60) rq = 10;
  else rq = 5;
  sc.retrace_quality = rq;

  let eq;
  if (ema == null) eq = 5;
  else if (push.is_up && signalBar.c > ema) eq = 10;
  else if (!push.is_up && signalBar.c < ema) eq = 10;
  else if (push.is_up && signalBar.c < ema - atr * 0.5) eq = 0;
  else if (!push.is_up && signalBar.c > ema + atr * 0.5) eq = 0;
  else eq = 5;
  sc.ema_alignment = eq;

  let srs = 0;
  for (const lv of srLevels) {
    const d = Math.abs(lv.level - signalBar.c);
    if (d <= atr * 1.0 && lv.tier === 'T1') srs = Math.max(srs, 15);
    else if (d <= atr * 1.5 && (lv.tier === 'T1' || lv.tier === 'T2')) srs = Math.max(srs, 8);
  }
  const tMove = (push.net_move || push.move) * ENG.TARGET_PCT;
  const obs = srLevels.filter(l => l.tier === 'T1' && (push.is_up ? (signalBar.c < l.level && l.level < signalBar.c + tMove) : (signalBar.c - tMove < l.level && l.level < signalBar.c)));
  if (obs.length >= 3) srs -= 10;
  sc.sr_confluence = srs;

  const bp = bodyPct(signalBar);
  const br = signalBar.h - signalBar.l || 0.001;
  const cp = push.is_up ? (signalBar.c - signalBar.l) / br : (signalBar.h - signalBar.c) / br;
  let bs;
  if (bp >= 0.70 && cp >= 0.70) bs = 15;
  else if (bp >= 0.50 && cp >= 0.60) bs = 11;
  else if (bp >= 0.35) bs = 7;
  else bs = 3;
  sc.bar_strength = bs;

  let rs;
  if (push.is_up) { if (rsi > ENG.RSI_BULL) rs = 5; else if (rsi < ENG.RSI_BEAR) rs = -5; else rs = 0; }
  else { if (rsi < ENG.RSI_BEAR) rs = 5; else if (rsi > ENG.RSI_BULL) rs = -5; else rs = 0; }
  sc.rsi = rs;

  sc.context = Math.max(-10, Math.min(10, Math.floor(contextScore / 5) * 5));
  const total = Object.values(sc).reduce((a,b) => a+b, 0);
  return [total, sc];
}

function computeBrokenSR(srLevels, push) {
  const upTop = RULE.BROKEN_BY_CLOSE ? push.highest_close : push.extreme;
  const downBtm = RULE.BROKEN_BY_CLOSE ? push.lowest_close : push.extreme;
  const broken = [];
  for (const lv of srLevels) {
    if (lv.tier !== 'T1' && lv.tier !== 'T2') continue;
    if (push.is_up && push.start_price < lv.level && lv.level <= upTop) broken.push(lv);
    else if (!push.is_up && downBtm <= lv.level && lv.level < push.start_price) broken.push(lv);
  }
  return broken;
}

function checkPreSignalFilters(bar, ep, stop, target, ema, dayOpen, push, atr) {
  const isUp = push.is_up;
  const risk = Math.abs(ep - stop);
  const reward = Math.abs(target - ep);
  if (risk > 0 && reward / risk < 1.0) return `R:R=${(reward/risk).toFixed(2)} below 1:1`;
  if (ema) {
    const da = Math.abs(bar.c - ema) / atr;
    if (da > 2.0) {
      const ss = (isUp && bar.c > ema) || (!isUp && bar.c < ema);
      if (ss) return `Stretched ${da.toFixed(1)}xATR`;
    }
  }
  if (dayOpen && dayOpen > 0) {
    const pct = (bar.c - dayOpen) / dayOpen * 100;
    if ((isUp && pct > 4.0) || (!isUp && pct < -4.0)) return `Day move ${pct.toFixed(1)}% extended`;
  }
  return null;
}

function buildExplanation(push, monitor, bar, sigType, score, ema, signalDir) {
  // v8.0.2 (#11 fix): use the actual signal direction (LONG/SHORT) instead of
  // the push direction. For counter trades, the trade direction is opposite
  // the push. signalDir is 'up' for LONG, 'down' for SHORT.
  const pushDirStr = push.is_up ? 'UP' : 'DOWN';
  const sigIsLong = signalDir != null ? (signalDir === 'up') : push.is_up;
  const actStr = sigIsLong ? 'LONG' : 'SHORT';
  // v8.0.2 (#11 fix): use monitor.max_retrace (the actual tracked value),
  // not the non-existent h1_retrace field. Fall back gracefully.
  const ret = (monitor.max_retrace != null) ? monitor.max_retrace
            : (monitor.h1_retrace || 0);
  const retDesc = ret <= 0.30 ? 'shallow flag' : ret <= 0.40 ? 'high-conviction pullback' : ret <= 0.60 ? 'moderate pullback' : 'deep pullback held at S/R';
  const parts = [];
  parts.push(`${pushDirStr} push ${push.start_time}→${push.end_time} (₹${push.net_move.toFixed(1)} = ${(push.net_move/push.atr).toFixed(1)}× ATR)`);
  parts.push(`${retDesc}, ${(ret*100).toFixed(0)}%`);
  if (sigType && sigType.startsWith('RT')) parts.push('Pullback held at previously broken level');
  if (ema) parts.push(`Price ${bar.c > ema ? 'above' : 'below'} EMA`);
  parts.push(`${actStr} | Score ${score}`);
  return parts.join(' | ');
}

// Detailed multi-section rationale for home page alerts
function buildDetailedRationale(sig, push, brokenSR, isCounter) {
  const lines = [];
  const isUp = sig.dir === 'up';
  const pushDir = push.is_up ? 'UP' : 'DOWN';
  const pushBars = push.bars || ((push.end_idx || 0) - (push.start_idx || 0) + 1);
  const atrMult = push.net_move && push.atr ? (push.net_move / push.atr).toFixed(1) : '?';

  // SECTION 1: What the engine saw
  lines.push(`📊 PUSH DETECTED`);
  lines.push(`• ${pushDir} ${pushBars}-bar push from ${push.start_time} → ${push.end_time}`);
  lines.push(`• Price moved ₹${push.start_price?.toFixed(2)} → ₹${push.extreme?.toFixed(2)} (₹${push.net_move?.toFixed(2)} = ${atrMult}× ATR)`);
  if (push.slope_mid) lines.push(`• Slope ${push.slope_mid.toFixed(2)}%/bar, strength: ${push.strength || 'Strong'}`);

  // SECTION 2: Key levels broken (if any)
  if (brokenSR && brokenSR.length > 0) {
    lines.push('');
    lines.push(`🎯 LEVELS BROKEN BY PUSH`);
    brokenSR.slice(0, 3).forEach(lv => {
      lines.push(`• ${lv.tier} ${lv.type === 'res' ? 'resistance' : 'support'} @ ₹${lv.level} (${lv.priorDayTouches || 0} prior-day touches)`);
    });
  }

  // SECTION 3: What happened after push
  lines.push('');
  if (isCounter) {
    // v8.0.2 (#11 fix): describe what the new engine actually does, not the
    // old hardcoded "80% retrace" / "1.5× target" assumption.
    const retPctCt = sig.retrace_pct ? (sig.retrace_pct * 100).toFixed(0) : '?';
    const trigger = sig.trigger || 'unknown';
    lines.push(`🔄 COUNTER TRADE LOGIC`);
    if (trigger === 'deep_retrace_pb1') {
      lines.push(`• Pullback 1 retraced ${retPctCt}% of push (≥70% threshold met)`);
    } else if (trigger === 'deep_retrace_pb2') {
      lines.push(`• Pullback 2 retraced ${retPctCt}% of push after leg-2 attempt failed`);
    } else if (trigger === 'combo' || trigger === 'combo_or_structural_break') {
      lines.push(`• Structural break — push high/low broken by counter wave`);
    } else {
      lines.push(`• Counter trigger: ${trigger} (retrace ${retPctCt}%)`);
    }
    lines.push(`• Trading AGAINST original ${pushDir} direction — now ${isUp ? 'LONG' : 'SHORT'}`);
    lines.push(`• Counter swing veto passed (no recent swing extreme within 0.5× ATR blocking entry)`);
    lines.push(`• Note: counter trades are higher-risk — push direction reversed entirely`);
  } else {
    lines.push(`🔄 PULLBACK PATTERN`);
    const retPct = sig.retrace_pct ? (sig.retrace_pct * 100).toFixed(0) : '?';
    const ret = sig.retrace_pct || 0;
    const retDesc = ret <= 0.30 ? 'Shallow flag pullback — strong continuation' :
                    ret <= 0.40 ? 'High-conviction pullback' :
                    ret <= 0.60 ? 'Moderate pullback — needs confirmation' :
                    'Deep pullback held at support/resistance';
    lines.push(`• ${retDesc}`);
    lines.push(`• Retrace ${retPct}% from extreme (counter bars only)`);
    if (sig.type === 'RT+H1' && sig.rt_level) {
      lines.push(`• Bonus: Pullback tested broken level @ ₹${sig.rt_level} and held — adds confluence`);
    }
    if (sig.type === 'B') {
      lines.push(`• H2 (second-leg) resumption — push attempted to resume after 1st pullback`);
    }
  }

  // SECTION 4: Trade thesis
  lines.push('');
  lines.push(`💡 TRADE THESIS`);
  if (isCounter) {
    lines.push(`• Original ${pushDir} momentum exhausted/reversed; ride the new direction`);
    lines.push(`• Stop ₹${sig.stop_price} = beyond recent swing extreme + 0.5× ATR`);
    // v8.0.2 (#11 fix): show real R:R from the signal, not hardcoded 1.5
    const rrCt = sig.rr || (Math.abs(sig.target_price - sig.entry_price) / Math.abs(sig.entry_price - sig.stop_price)).toFixed(2);
    const trgPctCt = (sig.trigger === 'deep_retrace_pb2' || sig.trigger === 'combo')
      ? '50% of leg-2 range'
      : '50% of push extension';
    lines.push(`• Target ₹${sig.target_price} = ${trgPctCt} (R:R ${rrCt})`);
  } else {
    lines.push(`• ${pushDir} momentum holding through pullback — expecting continuation`);
    lines.push(`• Stop ₹${sig.stop_price} = beyond pullback extreme + 1× ATR buffer`);
    const rr = sig.rr || (Math.abs(sig.target_price - sig.entry_price) / Math.abs(sig.entry_price - sig.stop_price)).toFixed(2);
    lines.push(`• Target ₹${sig.target_price} = 50% of push extension (R:R ${rr})`);
  }

  // SECTION 5: Score breakdown
  if (sig.breakdown) {
    lines.push('');
    lines.push(`📈 SCORE: ${sig.score}${sig.final_score && sig.final_score !== sig.score ? ' → ' + sig.final_score : ''} (${sig.conviction || 'MODERATE'})`);
    const bd = sig.breakdown;
    const parts = [];
    if (bd.push_quality != null) parts.push(`Push: ${bd.push_quality}`);
    if (bd.retrace_quality != null) parts.push(`Retrace: ${bd.retrace_quality}`);
    if (bd.ema_alignment != null) parts.push(`EMA: ${bd.ema_alignment}`);
    if (bd.sr_confluence != null) parts.push(`S/R: ${bd.sr_confluence}`);
    if (bd.bar_strength != null) parts.push(`Bar: ${bd.bar_strength}`);
    if (bd.rsi != null) parts.push(`RSI: ${bd.rsi}`);
    if (bd.context != null) parts.push(`Context: ${bd.context}`);
    if (parts.length) lines.push(`• ${parts.join(' | ')}`);
    if (sig.context && sig.context.detail) lines.push(`• Context detail: ${sig.context.label || ''}`);
  }

  return lines.join('\n');
}

function buildRationale(sig, push, brokenSR) {
  return buildDetailedRationale(sig, push, brokenSR, sig.type === 'COUNTER');
}

class Tier2Monitor {
  /**
   * NEW Tier 2 monitor — v8.0 (May 13, 2026 redesign).
   * Port of NewTier2Monitor from /mnt/project/new_pullback_engine.py.
   *
   * Strategies (4 active, 2 disabled-via-flag):
   *   - Continuation at Level      (trigger: pullback_at_level)
   *   - Quick Reversal             (trigger: deep_retrace_pb1)
   *   - Combo (PB Low + EMA Fail)  (trigger: combo)
   *   - Second Pullback Reversal   (trigger: deep_retrace_pb2)
   *   - swing_low_break / ema_fail standalones gated off via NEW_CFG flags.
   *
   * States: WATCHING → PULLBACK_1_FORMING → POST_PULLBACK_1_NO_RT
   *         → PULLBACK_2_FORMING → FIRED
   *
   * Constructor signature (orchestrator-facing):
   *   new Tier2Monitor(push, srLevels, brokenSR, contextScore, dayOpen,
   *                    priorCandles, dayBarsRef)
   * The 7th arg `dayBarsRef` is REQUIRED for counter trades — supplies the
   * day's bar history used for the swing-stop and counter-swing-veto.
   * If absent (e.g. someone rolls back the orchestrator), the class falls
   * back to elapsedCandles only — stop will be tighter than Python intends.
   */
  constructor(push, srLevels, brokenSR, contextScore, dayOpen, priorCandles, dayBarsRef) {
    this.push = push;
    this.sr_levels = srLevels || [];
    this.broken_sr = brokenSR || [];
    this.context_score = contextScore || 0;
    this.atr = push.atr;
    this.day_open = dayOpen;
    this.rsi_candles = priorCandles || [];
    this.day_bars_ref = dayBarsRef || []; // 7th-arg fallback
    this.bar_count = 0;
    this.prev_close = push.end_price;
    this.elapsed_candles = [];
    // Pullback tracking
    this.counter_bars_in_pullback = 0;
    this.pullback_extreme = null;          // low for up-push, high for down-push
    this.pullback_1_extreme = null;        // FROZEN once set (May 13 bug fix)
    this.pullback_extreme_current = null;  // tracks current pullback (1 or 2)
    this.max_retrace = 0;
    // Phase tracking
    this.state = 'WATCHING';
    this.first_resumption_close = null;
    this.leg_2_bars = 0;
    this.leg_2_high = null;                // high of leg up (or low for down-push)
    this.leg_2_start_close = null;
    this.entry_price = null;
    this.profit_doji_count = 0;
    // Legacy fields retained for orchestrator compatibility (read at line ~1976).
    // New engine never sets exhaustion_skip=true (no exhaustion-skip logic in new
    // engine and no 'B'-type signal exists), but defining as false is defensive.
    this.exhaustion_skip = false;
    // v8.0.2 (BACKLOG #9): per-bar leg-2 retrace gate rejection log.
    // Orchestrator drains this after each processBar call and appends to
    // STATE.audit_log so we can validate the rule live.
    this.leg2_rejections = [];
  }

  _result(action, reason, signal) {
    // v8.0.1: per-bar diagnostic logging (turned on for current investigation).
    // Logs one line per processBar invocation showing symbol, bar count, state,
    // retrace, action. Keep concise. Set NEW_CFG.LOG_MONITOR_BARS = false to disable.
    if (NEW_CFG.LOG_MONITOR_BARS && this.symbol) {
      const lastBar = this.elapsed_candles[this.elapsed_candles.length - 1];
      const bt = lastBar && lastBar.t ? lastBar.t.slice(11, 16) : '?';
      const counterBars = this.counter_bars_in_pullback;
      const pbExt = this.pullback_extreme != null ? this.pullback_extreme.toFixed(2) : '-';
      console.log(`[T2 ${this.symbol}] b${this.bar_count} ${bt} state=${this.state} retrace=${(this.max_retrace*100).toFixed(0)}% counterBars=${counterBars} pbExt=${pbExt} action=${action} reason="${reason || ''}"`);
    }
    return {
      action,
      reason: reason || '',
      signal: signal || null,
      state: this.state,
      retrace: +this.max_retrace.toFixed(3),
      bar_num: this.bar_count,
    };
  }

  /**
   * Orchestrator entry point. Returns { action, reason, signal, state, retrace, bar_num }.
   * action ∈ { 'SIGNAL', 'WAIT', 'DUMP', 'EXHAUSTION' }. CANCEL is never returned
   * by the new engine (deep-retrace rejection paths return DUMP to avoid the
   * orchestrator's old-counter fallback firing on rejected new-engine counters).
   */
  processBar(bar, atrOv, emaOv, rsiOv) {
    this.bar_count++;
    this.elapsed_candles.push(bar);
    const bm = barMove(bar, this.prev_close);
    const same = bm === this.push.dir;
    const ema = (emaOv != null) ? emaOv : (bar.ema != null ? bar.ema : null);
    const doji = isDoji(bar);
    const bp = bodyPct(bar);
    const rsi = (rsiOv != null) ? rsiOv : computeRSIEngine([...this.rsi_candles, ...this.elapsed_candles]);
    const isUp = this.push.is_up;

    if (this.bar_count > ENG.MAX_BARS) {
      this.prev_close = bar.c;
      return this._result('DUMP', 'Timeout 12 bars');
    }

    // For ema_fail trigger we need previous bar's close vs previous EMA.
    const prevCloseForEma = this.elapsed_candles.length >= 2
      ? this.elapsed_candles[this.elapsed_candles.length - 2].c
      : this.prev_close;
    const prevEma = this.elapsed_candles.length >= 2
      ? this.elapsed_candles[this.elapsed_candles.length - 2].ema
      : ema;

    // ─────────────────────────────────────────────────────────────────
    // State: WATCHING — waiting for first counter bar
    // ─────────────────────────────────────────────────────────────────
    if (this.state === 'WATCHING') {
      if (same || doji) {
        // Push extending. Doji harmless here.
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      }
      // First counter bar (non-doji, opposite direction)
      this.counter_bars_in_pullback = 1;
      if (isUp) {
        this.pullback_extreme = bar.l;
        this.pullback_extreme_current = bar.l;
      } else {
        this.pullback_extreme = bar.h;
        this.pullback_extreme_current = bar.h;
      }
      this.max_retrace = Math.max(this.max_retrace, computeRetrace(bar, this.push));
      this.state = 'PULLBACK_1_FORMING';
      this.prev_close = bar.c;
      // Even on first counter, check deep retrace (Quick Reversal)
      if (this.max_retrace > NEW_CFG.RETRACE_DEEP_PULLBACK_1) {
        const sig = this._buildCounterSignal(bar, ema, rsi, 'deep_retrace_pb1', false);
        if (sig) {
          this.state = 'FIRED';
          return this._result('SIGNAL', `COUNTER ${sig.score}`, sig);
        }
        return this._result('DUMP', 'deep retrace but counter signal rejected');
      }
      return this._result('WAIT', this.state);
    }

    // ─────────────────────────────────────────────────────────────────
    // State: PULLBACK_1_FORMING — waiting for resumption or more counter
    // ─────────────────────────────────────────────────────────────────
    if (this.state === 'PULLBACK_1_FORMING') {
      if (same && !doji) {
        // Resumption bar — does pullback's low touch a previously-broken RT level?
        const rt = checkRTTouch(bar, this.push, this.broken_sr, this.atr);
        if (rt) {
          // FIRE PULLBACK_AT_LEVEL
          const [score, bd] = scoreSignal(
            this.push, this.max_retrace, this.counter_bars_in_pullback,
            bar, this.sr_levels, ema, this.context_score, this.atr, 'RT+H1', rsi
          );
          if (score >= NEW_CFG.SCORE_FLOOR) {
            const sig = this._buildContinuationSignal(bar, score, bd, 'PULLBACK_AT_LEVEL', rt, ema);
            if (sig) {
              this.entry_price = bar.c;
              this.state = 'FIRED';
              return this._result('SIGNAL', `PB@L ${score}`, sig);
            }
          }
        }
        // No RT (or RT but rejected) → check pullback 1 quality gate before
        // transitioning to reversal-hunt mode.
        if (this.counter_bars_in_pullback < NEW_CFG.PB1_MIN_COUNTER_BARS
            || this.max_retrace < NEW_CFG.PB1_MIN_RETRACE) {
          // Pullback too shallow — push retains conviction. Reset pullback
          // counters; this resumption bar starts a new pullback window.
          this.counter_bars_in_pullback = 0;
          this.pullback_extreme = null;
          this.pullback_extreme_current = null;
          this.max_retrace = 0;
          this.state = 'WATCHING';
          this.prev_close = bar.c;
          return this._result('WAIT', `${this.state} (pb1 too shallow)`);
        }
        // Gate passes: freeze pullback_1_extreme, transition to POST_PULLBACK_1_NO_RT
        this.first_resumption_close = bar.c;
        this.pullback_1_extreme = this.pullback_extreme;  // FROZEN
        this.leg_2_bars = 1;
        this.leg_2_high = isUp ? bar.h : bar.l;
        this.leg_2_start_close = bar.c;
        this.state = 'POST_PULLBACK_1_NO_RT';
        this.counter_bars_in_pullback = 0;
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      } else if (!same && !doji) {
        // Another counter bar (non-doji)
        this.counter_bars_in_pullback++;
        if (isUp) {
          this.pullback_extreme = Math.min(this.pullback_extreme, bar.l);
          this.pullback_extreme_current = this.pullback_extreme;
        } else {
          this.pullback_extreme = Math.max(this.pullback_extreme, bar.h);
          this.pullback_extreme_current = this.pullback_extreme;
        }
        this.max_retrace = Math.max(this.max_retrace, computeRetrace(bar, this.push));
        if (this.max_retrace > NEW_CFG.RETRACE_DEEP_PULLBACK_1) {
          const sig = this._buildCounterSignal(bar, ema, rsi, 'deep_retrace_pb1', false);
          if (sig) {
            this.state = 'FIRED';
            return this._result('SIGNAL', `COUNTER ${sig.score}`, sig);
          }
          return this._result('DUMP', 'deep retrace but counter signal rejected');
        }
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      } else {
        // Doji — May 13 bug fix: doji's low/high updates pullback_extreme but
        // DOES NOT increment counter_bars_in_pullback (gate counts non-doji only).
        if (this.pullback_extreme != null) {
          if (isUp) {
            this.pullback_extreme = Math.min(this.pullback_extreme, bar.l);
          } else {
            this.pullback_extreme = Math.max(this.pullback_extreme, bar.h);
          }
          this.pullback_extreme_current = this.pullback_extreme;
          this.max_retrace = Math.max(this.max_retrace, computeRetrace(bar, this.push));
        }
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // State: POST_PULLBACK_1_NO_RT — hunting reversal (no RT confirmation)
    // ─────────────────────────────────────────────────────────────────
    if (this.state === 'POST_PULLBACK_1_NO_RT') {
      if (same && !doji) {
        // Leg up continuing
        this.leg_2_bars++;
        this.leg_2_high = isUp
          ? Math.max(this.leg_2_high, bar.h)
          : Math.min(this.leg_2_high, bar.l);
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      } else if (!same && !doji) {
        // Counter bar — check combo / pb_low_break / ema_fail triggers
        let pbLowBreak = isUp
          ? (bar.c < this.pullback_1_extreme)
          : (bar.c > this.pullback_1_extreme);
        let emaFail = (ema != null && prevEma != null) && (
          (isUp && bar.c < ema && prevCloseForEma >= prevEma)
          || (!isUp && bar.c > ema && prevCloseForEma <= prevEma)
        );
        // May 13: EMA standalone disabled (combo still uses both)
        if (!NEW_CFG.ENABLE_EMA_FAIL_STANDALONE && emaFail && !pbLowBreak) {
          emaFail = false;
        }
        // May 13: PLB standalone disabled (combo still uses both)
        if (!NEW_CFG.ENABLE_PB_LOW_BREAK_STANDALONE && pbLowBreak && !emaFail) {
          pbLowBreak = false;
        }
        if (pbLowBreak || emaFail) {
          const trigger = (pbLowBreak && emaFail)
            ? 'combo'
            : (pbLowBreak ? 'swing_low_break' : 'ema_fail');
          const sig = this._buildCounterSignal(bar, ema, rsi, trigger, false);
          if (sig) {
            this.state = 'FIRED';
            return this._result('SIGNAL', `COUNTER ${sig.score}`, sig);
          }
        }
        // Counter bar but no trigger fired — enter pullback 2
        this.pullback_extreme_current = isUp ? bar.l : bar.h;
        this.counter_bars_in_pullback = 1;
        this.state = 'PULLBACK_2_FORMING';
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      } else {
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // State: PULLBACK_2_FORMING — second pullback (deeper expected)
    // ─────────────────────────────────────────────────────────────────
    if (this.state === 'PULLBACK_2_FORMING') {
      if (!same && !doji) {
        this.counter_bars_in_pullback++;
        if (isUp) {
          this.pullback_extreme_current = Math.min(this.pullback_extreme_current, bar.l);
        } else {
          this.pullback_extreme_current = Math.max(this.pullback_extreme_current, bar.h);
        }
        // Use pullback_1_extreme (frozen earlier) as the swing reference
        let pb1LowBreak = isUp
          ? (bar.c < this.pullback_1_extreme)
          : (bar.c > this.pullback_1_extreme);
        let emaFail = (ema != null && prevEma != null) && (
          (isUp && bar.c < ema && prevCloseForEma >= prevEma)
          || (!isUp && bar.c > ema && prevCloseForEma <= prevEma)
        );
        // Standalone gates (combo still uses both)
        if (!NEW_CFG.ENABLE_EMA_FAIL_STANDALONE && emaFail && !pb1LowBreak) {
          emaFail = false;
        }
        if (!NEW_CFG.ENABLE_PB_LOW_BREAK_STANDALONE && pb1LowBreak && !emaFail) {
          pb1LowBreak = false;
        }
        const retraceFromStart = computeRetrace(bar, this.push);
        const deepPb2 = retraceFromStart > NEW_CFG.RETRACE_DEEP_PULLBACK_2;
        if (pb1LowBreak || emaFail || deepPb2) {
          let trigger;
          if (pb1LowBreak && emaFail) trigger = 'combo';
          else if (deepPb2) trigger = 'deep_retrace_pb2';
          else if (pb1LowBreak) trigger = 'swing_low_break';
          else trigger = 'ema_fail';
          const sig = this._buildCounterSignal(bar, ema, rsi, trigger, true);
          if (sig) {
            this.state = 'FIRED';
            return this._result('SIGNAL', `COUNTER ${sig.score}`, sig);
          }
        }
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      } else if (same && !doji) {
        // Resumption from pullback 2 — do NOT fire continuation. Go back to
        // POST_PULLBACK_1_NO_RT. CRITICAL (May 13 bug fix): do NOT overwrite
        // pullback_1_extreme — it stays frozen at original pullback 1's low.
        this.counter_bars_in_pullback = 0;
        this.state = 'POST_PULLBACK_1_NO_RT';
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      } else {
        this.prev_close = bar.c;
        return this._result('WAIT', this.state);
      }
    }

    // FIRED or anything else — passthrough
    this.prev_close = bar.c;
    return this._result('WAIT', this.state);
  }

  _meaningfulLeg2() {
    if (this.leg_2_bars < NEW_CFG.MEANINGFUL_LEG2_BARS) return false;
    if (this.first_resumption_close == null || this.leg_2_high == null) return false;
    const move = Math.abs(this.leg_2_high - this.first_resumption_close);
    return move >= this.atr * NEW_CFG.MEANINGFUL_LEG2_ATR_MULT;
  }

  /**
   * v8.0.2 (BACKLOG #9): Leg-2 retrace gate.
   *
   * Plain English:
   *   When leg 2 has extended past the original push extreme, the relevant
   *   pullback structure is leg 2 itself, NOT the original push. Measure how
   *   far price has retreated from the leg-2 peak back toward the pullback-1
   *   bottom as a percentage of the leg-2 range. If under 40%, the move
   *   hasn't been consumed — fire is premature.
   *
   * Returns: { rejected: bool, retrace_pct: float|null, reason: string|null }
   *
   * Returns rejected=false (gate does not apply) when:
   *   - leg 2 has not extended past push extreme
   *   - leg_2_high not set (no leg 2 formed yet)
   *   - pullback_1_extreme not set (defensive)
   */
  _checkLeg2RetraceGate(bar) {
    const push = this.push;
    const isUp = push.is_up;
    const pushExtreme = push.extreme;
    const leg2Peak = this.leg_2_high;
    const pb1Bottom = this.pullback_1_extreme;

    // Defensive: gate doesn't apply if we don't have the data
    if (leg2Peak == null || pb1Bottom == null || pushExtreme == null) {
      return { rejected: false, retrace_pct: null, reason: null };
    }

    // Has leg 2 extended past original push extreme?
    const extended = isUp
      ? (leg2Peak > pushExtreme)
      : (leg2Peak < pushExtreme);
    if (!extended) {
      return { rejected: false, retrace_pct: null, reason: null };
    }

    // Compute leg-2 range
    const leg2Range = Math.abs(leg2Peak - pb1Bottom);
    if (leg2Range <= 0) {
      return { rejected: false, retrace_pct: null, reason: null };
    }

    // Compute current retreat from leg-2 peak toward pb1 bottom, using bar close
    // (the bar that's about to fire). For up-push, retreat = leg2Peak − bar.c.
    // For down-push, retreat = bar.c − leg2Peak.
    const retreat = isUp ? (leg2Peak - bar.c) : (bar.c - leg2Peak);
    const retracePct = retreat / leg2Range;

    if (retracePct < NEW_CFG.LEG2_RETRACE_MIN) {
      return {
        rejected: true,
        retrace_pct: +retracePct.toFixed(3),
        reason: 'leg2_retrace_shallow',
      };
    }
    return { rejected: false, retrace_pct: +retracePct.toFixed(3), reason: null };
  }

  _buildContinuationSignal(bar, score, bd, sigType, rt, ema) {
    const push = this.push;
    const atr = this.atr;
    const ep = bar.c;
    const isUp = push.is_up;
    // Stop = RT level ∓ 1×ATR
    const lv = rt.level;
    let stop = isUp ? lv - atr * ENG.STOP_BUFFER : lv + atr * ENG.STOP_BUFFER;
    let target = isUp
      ? ep + push.net_move * ENG.TARGET_PCT
      : ep - push.net_move * ENG.TARGET_PCT;
    // Target vs resist
    if (RULE.TARGET_VS_RESIST) {
      let blk = null;
      for (const lvx of this.sr_levels) {
        if (lvx.tier !== 'T1' && lvx.tier !== 'T2') continue;
        if (isUp && ep < lvx.level && lvx.level < target) {
          if (blk == null || lvx.level < blk) blk = lvx.level;
        } else if (!isUp && target < lvx.level && lvx.level < ep) {
          if (blk == null || lvx.level > blk) blk = lvx.level;
        }
      }
      if (blk != null) {
        const buf = atr * 0.1;
        target = isUp ? blk - buf : blk + buf;
      }
    }
    const rej = checkPreSignalFilters(bar, ep, stop, target, ema, this.day_open, push, atr);
    if (rej) return null;
    const risk = Math.abs(ep - stop);
    if (risk <= 0) return null;
    return {
      type: sigType,                 // 'PULLBACK_AT_LEVEL'
      trigger: 'pullback_at_level',
      dir: push.dir,
      push_id: push.push_id,
      push_start: push.start_time, push_end: push.end_time,
      push_extreme: push.extreme, push_move: push.net_move,
      h1_retrace: +this.max_retrace.toFixed(3),
      entry_time: bar.t.slice(11, 16),
      entry_price: +ep.toFixed(2),
      stop_price: +stop.toFixed(2),
      target_price: +target.toFixed(2),
      stop_dist: +risk.toFixed(2),
      rr: +(Math.abs(target - ep) / risk).toFixed(2),
      retrace_pct: +this.max_retrace.toFixed(3),
      score, breakdown: bd,
      rt_level: rt.level, rt_tier: rt.tier,
      bar_count: this.bar_count, bar_time: bar.t,
      is_counter: false,
      atr: +atr.toFixed(4),  // v8.0.2: needed by Tier3Tracker for BE buffer
      explanation: buildExplanation(push, this, bar, sigType, score, ema, push.dir),
    };
  }

  _buildCounterSignal(bar, ema, rsi, trigger, useLeg2Target) {
    const push = this.push;
    const atr = this.atr;
    const ep = bar.c;
    const isUpPush = push.is_up;
    const counterIsUp = !isUpPush;
    const counterDir = counterIsUp ? 'up' : 'down';

    // Combine day_bars_ref + elapsed_candles for swing veto and stop window.
    const fullBars = (this.day_bars_ref || []).concat(this.elapsed_candles);

    // Swing veto — checkCounterSwingVeto returns true if OK to fire, false if vetoed
    if (!checkCounterSwingVeto(push, bar, atr, fullBars)) {
      return null;
    }

    // v8.0.2 (BACKLOG #9): Leg-2 retrace gate.
    // When leg 2 has pushed past the original push extreme, measure how far
    // price has retreated from leg-2 peak as % of leg-2 range. If < 40%, the
    // move hasn't been consumed enough — cancel the counter signal.
    if (NEW_CFG.ENABLE_LEG2_RETRACE_GATE && this.pullback_1_extreme != null) {
      const leg2Gate = this._checkLeg2RetraceGate(bar);
      if (leg2Gate.rejected) {
        this._last_leg2_reject = leg2Gate;
        // Record a rejection for orchestrator to drain into audit log
        this.leg2_rejections.push({
          trigger,
          reason: leg2Gate.reason,
          retrace_pct: leg2Gate.retrace_pct,
          leg2_peak: this.leg_2_high,
          pb1_bottom: this.pullback_1_extreme,
          push_extreme: push.extreme,
          bar_time: bar.t,
        });
        return null;
      }
    }

    // Stop = recent 6-bar swing extreme ± 0.5×ATR (against the trade)
    const lookBars = fullBars.slice(-6);
    if (lookBars.length === 0) return null;
    let stop;
    if (counterIsUp) {
      stop = Math.min(...lookBars.map(b => b.l)) - atr * 0.5;
    } else {
      stop = Math.max(...lookBars.map(b => b.h)) + atr * 0.5;
    }
    const risk = Math.abs(ep - stop);
    if (risk <= 0) return null;

    // Target: depends on trigger
    let target;
    if (trigger === 'deep_retrace_pb1') {
      target = counterIsUp ? ep + risk * 1.5 : ep - risk * 1.5;
    } else if (trigger === 'swing_low_break' || trigger === 'ema_fail'
               || trigger === 'combo' || trigger === 'deep_retrace_pb2') {
      if (this._meaningfulLeg2() && this.first_resumption_close != null) {
        target = this.first_resumption_close;
      } else {
        target = push.start_price;
      }
      // Ensure target is in counter direction; if not, fall back to 1.5R
      if (counterIsUp && target <= ep) target = ep + risk * 1.5;
      if (!counterIsUp && target >= ep) target = ep - risk * 1.5;
    } else {
      target = counterIsUp ? ep + risk * 1.5 : ep - risk * 1.5;
    }

    // Score — feed scoreSignal a pseudo-push flipped to counter direction
    const pseudo = { ...push, is_up: counterIsUp, dir: counterDir };
    let [score, bd] = scoreSignal(
      pseudo, 0.0, 0, bar, this.sr_levels, ema,
      this.context_score, atr, 'COUNTER', rsi
    );
    if (trigger === 'combo') {
      score += NEW_CFG.COMBO_TRIGGER_BONUS;
      bd.combo_bonus = NEW_CFG.COMBO_TRIGGER_BONUS;
    }

    // S/R reconfirmation bonus + path-blocker penalty
    if (NEW_CFG.ENABLE_SR_RECONFIRMATION) {
      let srBonus = 0;
      const tol = atr * NEW_CFG.SR_RECONFIRM_TOL_ATR;
      if (counterIsUp) {
        // LONG counter: bar tested support, closed above
        for (const lv of this.sr_levels) {
          if (lv.tier !== 'T1' && lv.tier !== 'T2') continue;
          if (lv.type !== 'sup') continue;
          if ((bar.l - tol) <= lv.level && lv.level <= (bar.l + tol)) {
            if (bar.c > lv.level) {
              srBonus = Math.max(srBonus, NEW_CFG.SR_RECONFIRM_BONUS);
              break;
            }
          }
        }
      } else {
        // SHORT counter: bar tested resistance, closed below
        for (const lv of this.sr_levels) {
          if (lv.tier !== 'T1' && lv.tier !== 'T2') continue;
          if (lv.type !== 'res') continue;
          if ((bar.h - tol) <= lv.level && lv.level <= (bar.h + tol)) {
            if (bar.c < lv.level) {
              srBonus = Math.max(srBonus, NEW_CFG.SR_RECONFIRM_BONUS);
              break;
            }
          }
        }
      }
      // Path blocker penalty: count strong levels between entry and target
      let blockers = 0;
      if (counterIsUp) {
        for (const lv of this.sr_levels) {
          if (lv.tier !== 'T1' && lv.tier !== 'T2') continue;
          if (lv.type !== 'res') continue;
          if (ep < lv.level && lv.level < target) blockers++;
        }
      } else {
        for (const lv of this.sr_levels) {
          if (lv.tier !== 'T1' && lv.tier !== 'T2') continue;
          if (lv.type !== 'sup') continue;
          if (target < lv.level && lv.level < ep) blockers++;
        }
      }
      if (blockers >= 2) srBonus += NEW_CFG.SR_PATH_BLOCKER_PENALTY;
      score += srBonus;
      bd.sr_reconfirm = srBonus;
      bd.path_blockers = blockers;
    }

    // Push quality reconfirmation bonus
    if (NEW_CFG.ENABLE_PUSH_QUALITY_RECONFIRM) {
      let pq = 0;
      if ((push.bars || 0) >= NEW_CFG.PUSH_QUALITY_MIN_BARS) pq += 2;
      const netAtr = (push.net_move || push.move || 0) / (push.atr || atr || 1);
      if (netAtr >= NEW_CFG.PUSH_QUALITY_MIN_ATR_MULT) pq += 3;
      const pet = push.end_time || '';
      if (pet && pet >= NEW_CFG.PUSH_QUALITY_MIN_END_TIME) pq += 1;
      score += pq;
      bd.push_quality_reconfirm = pq;
    }

    if (score < NEW_CFG.SCORE_FLOOR) return null;
    const rrVal = Math.abs(target - ep) / risk;
    if (rrVal < 1.0) return null;

    // Map internal trigger → public type name (handoff spec)
    let publicType;
    if (trigger === 'deep_retrace_pb1') publicType = 'QUICK_REVERSAL';
    else if (trigger === 'combo') publicType = 'COMBO';
    else if (trigger === 'deep_retrace_pb2') publicType = 'SECOND_PULLBACK_REVERSAL';
    else if (trigger === 'swing_low_break' || trigger === 'ema_fail') publicType = 'COUNTER'; // gated off normally
    else publicType = 'COUNTER';

    return {
      type: publicType,
      trigger,
      dir: counterDir,
      push_id: push.push_id,
      push_start: push.start_time, push_end: push.end_time,
      push_extreme: push.extreme, push_move: push.net_move,
      entry_time: bar.t.slice(11, 16),
      entry_price: +ep.toFixed(2),
      stop_price: +stop.toFixed(2),
      target_price: +target.toFixed(2),
      stop_dist: +risk.toFixed(2),
      rr: +rrVal.toFixed(2),
      retrace_pct: +this.max_retrace.toFixed(3),
      score, breakdown: bd,
      rt_level: null, rt_tier: null,
      bar_count: this.bar_count, bar_time: bar.t,
      is_counter: true,
      atr: +atr.toFixed(4),  // v8.0.2: needed by Tier3Tracker for BE buffer
      explanation: buildExplanation(push, this, bar, publicType, score, ema, counterDir),
    };
  }
}
class Tier3Tracker {
  constructor(alert, fillPrice, fillTime, shares, isShadow) {
    this.alert = alert; this.fill_price = fillPrice; this.fill_time = fillTime;
    this.shares = shares || 1;
    this.bars_since_fill = 0; this.mfe = 0; this.mae = 0; this.exit_override = false;
    this.outcome = null; this.exit_reason = null; this.exit_price = null; this.exit_time = null;
    this.last_price = fillPrice;
    // v8.0.2 (BACKLOG #7): Breakeven-window stop. The "active stop" used for
    // hit detection lives in `current_stop`, starts equal to alert.stop_price,
    // moves to entry + buffer when BE activates, returns to original on release.
    this.original_stop = alert.stop_price;
    this.current_stop = alert.stop_price;
    this.breakeven_active = false;
    this.breakeven_released = false;
    this.stop_history = [];  // [{ time, from, to, reason }]
    // v8.0.2: capture ATR from alert for BE buffer (matches backtest spec).
    // Falls back to null for legacy alerts that don't carry it.
    this.atr = (alert.atr != null) ? alert.atr : null;
    // v8.0.2 (BACKLOG #14): Distinguish shadow vs live taken trade.
    // Shadow: early-exit rules auto-close (no real money).
    // Live taken: early-exit rules become NOTIFY only — never auto-close.
    // Trade closes only on target, stop (original or BE), manual exit, or EOD.
    this.is_shadow = !!isShadow;
    // v8.0.2 (BACKLOG #14, #16): notifications queued for orchestrator to drain
    // and push to Telegram + dashboard. Shape:
    //   { type: 'BE_ACTIVATE' | 'BE_RELEASE' | 'EARLY_EXIT_ADVISORY',
    //     reason, time, current_stop, current_price, mfe, mae, unrealized_R, advisory_text }
    this.notifications = [];
  }
  _pnl(price) {
    const isUp = this.alert.dir === 'up';
    return (isUp ? (price - this.fill_price) : (this.fill_price - price)) * this.shares;
  }
  /**
   * v8.0.2 (BACKLOG #7): Breakeven-window update.
   * Called once per bar BEFORE target/stop hit checks. Updates current_stop in
   * place. Activate at +0.5R, release back at +0.7R, never re-activate.
   */
  _updateBreakevenStop(bar, R) {
    if (!NEW_CFG.ENABLE_BREAKEVEN_WINDOW) return;
    const isUp = this.alert.dir === 'up';
    // Use bar close for the R-check (consistent with backtest harness).
    const m = isUp ? (bar.c - this.fill_price) : (this.fill_price - bar.c);
    const unrealR = m / R;
    // Buffer = ATR × BE_BUFFER_ATR (matches backtest spec). Falls back to
    // 1R-distance (R) for legacy alerts that don't carry atr.
    const bufferBase = (this.atr != null && this.atr > 0) ? this.atr : R;
    const buffer = bufferBase * NEW_CFG.BE_BUFFER_ATR;

    // ACTIVATE: +0.5R, not yet active, not yet released
    if (!this.breakeven_active && !this.breakeven_released
        && unrealR >= NEW_CFG.BE_ACTIVATE_R) {
      const newStop = isUp
        ? this.alert.entry_price + buffer
        : this.alert.entry_price - buffer;
      this.stop_history.push({
        time: bar.t, from: +this.current_stop.toFixed(2),
        to: +newStop.toFixed(2), reason: 'BE_ACTIVATE',
        unrealized_R: +unrealR.toFixed(3),
      });
      this.current_stop = newStop;
      this.breakeven_active = true;
      // v8.0.2 (BACKLOG #16): queue notification for live trades only
      if (!this.is_shadow) {
        this.notifications.push({
          type: 'BE_ACTIVATE',
          time: bar.t,
          current_stop: +newStop.toFixed(2),
          original_stop: +this.original_stop.toFixed(2),
          current_price: +bar.c.toFixed(2),
          unrealized_R: +unrealR.toFixed(3),
        });
      }
      return;
    }

    // RELEASE: +0.7R, currently active
    if (this.breakeven_active && !this.breakeven_released
        && unrealR >= NEW_CFG.BE_RELEASE_R) {
      const newStop = this.original_stop;
      this.stop_history.push({
        time: bar.t, from: +this.current_stop.toFixed(2),
        to: +newStop.toFixed(2), reason: 'BE_RELEASE',
        unrealized_R: +unrealR.toFixed(3),
      });
      this.current_stop = newStop;
      this.breakeven_active = false;
      this.breakeven_released = true;
      // v8.0.2 (BACKLOG #16): queue notification for live trades only
      if (!this.is_shadow) {
        this.notifications.push({
          type: 'BE_RELEASE',
          time: bar.t,
          current_stop: +newStop.toFixed(2),
          original_stop: +this.original_stop.toFixed(2),
          current_price: +bar.c.toFixed(2),
          unrealized_R: +unrealR.toFixed(3),
        });
      }
    }
  }
  processBar(bar) {
    this.last_price = bar.c;
    if (this.outcome) return { status: 'closed', ...this.summary() };
    this.bars_since_fill++;
    const isUp = this.alert.dir === 'up';
    const R = Math.abs(this.alert.entry_price - this.original_stop);
    const m = isUp ? (bar.c - this.fill_price) : (this.fill_price - bar.c);
    const mR = m / R;
    if (mR > this.mfe) this.mfe = mR;
    if (mR < this.mae) this.mae = mR;
    if (this.mfe > 0.7) this.exit_override = true;
    // v8.0.2: target/stop hit checks use the stop level that was in effect
    // DURING this bar (i.e. before the close). BE adjustments take effect for
    // SUBSEQUENT bars only — matches real-broker semantics where a stop is
    // placed after a bar closes.
    const stopInEffect = this.current_stop;
    const beWasActiveBeforeBar = this.breakeven_active;
    // Target check (unchanged — target never moves)
    if (isUp && bar.h >= this.alert.target_price) return this._close('WIN', this.alert.target_price, 'target', bar.t);
    if (!isUp && bar.l <= this.alert.target_price) return this._close('WIN', this.alert.target_price, 'target', bar.t);
    // Stop check uses the stop that was in effect during the bar
    if (isUp && bar.l <= stopInEffect) {
      const exitReason = beWasActiveBeforeBar ? 'breakeven_stop' : 'stop';
      return this._close('LOSS', stopInEffect, exitReason, bar.t);
    }
    if (!isUp && bar.h >= stopInEffect) {
      const exitReason = beWasActiveBeforeBar ? 'breakeven_stop' : 'stop';
      return this._close('LOSS', stopInEffect, exitReason, bar.t);
    }
    // No hit on this bar — now update BE for subsequent bars based on this close
    this._updateBreakevenStop(bar, R);
    if (!this.exit_override) {
      // v8.0.2 (BACKLOG #14): For LIVE TAKEN trades, the early-exit rules
      // (bar2_reversal, pattern_break, time_stagnation) become advisory only —
      // they queue a notification but DO NOT close the trade. Engine continues
      // to track. Trade only closes on target, original/BE stop, manual exit,
      // or EOD. For SHADOW trades, behavior is unchanged: auto-close.
      const advisorize = (reason, advisoryText) => {
        if (this.is_shadow) return this._close('EARLY_EXIT', bar.c, reason, bar.t);
        // Live: notify once per reason per trade (avoid spam every bar)
        const alreadyFired = (this._advisories_fired = this._advisories_fired || {});
        if (!alreadyFired[reason]) {
          alreadyFired[reason] = true;
          this.notifications.push({
            type: 'EARLY_EXIT_ADVISORY',
            reason,
            advisory_text: advisoryText,
            time: bar.t,
            current_price: +bar.c.toFixed(2),
            current_stop: +this.current_stop.toFixed(2),
            mfe: +this.mfe.toFixed(2),
            mae: +this.mae.toFixed(2),
            unrealized_R: +mR.toFixed(3),
          });
        }
        return null;  // do not close; fall through to open-status return below
      };

      if (this.bars_since_fill === 2 && mR <= -0.5 && this.mfe > 0) {
        const out = advisorize('bar2_reversal',
          'Bar 2 reversal: trade reached MFE then reversed to ≤−0.5R. Consider exiting.');
        if (out) return out;
      }
      if (this.alert.type === 'RT+H1' && this.alert.rt_level) {
        const lv = this.alert.rt_level;
        if (isUp && bar.c < lv) {
          const out = advisorize('pattern_break',
            `Pattern broken: close ${bar.c.toFixed(2)} below RT level ${lv.toFixed(2)}. Consider exiting.`);
          if (out) return out;
        }
        if (!isUp && bar.c > lv) {
          const out = advisorize('pattern_break',
            `Pattern broken: close ${bar.c.toFixed(2)} above RT level ${lv.toFixed(2)}. Consider exiting.`);
          if (out) return out;
        }
      }
      if (this.bars_since_fill >= 6 && this.mfe < 0.5 && this.mae <= -0.5) {
        const out = advisorize('time_stagnation',
          `Time stagnation: ${this.bars_since_fill} bars, MFE +${this.mfe.toFixed(2)}R, MAE ${this.mae.toFixed(2)}R. Consider exiting.`);
        if (out) return out;
      }
    }
    return {
      status: 'open',
      mfe: +this.mfe.toFixed(2), mae: +this.mae.toFixed(2),
      bars_since_fill: this.bars_since_fill,
      current_price: +bar.c.toFixed(2),
      current_stop: +this.current_stop.toFixed(2),
      breakeven_active: this.breakeven_active,
      breakeven_released: this.breakeven_released,
      pnl: +this._pnl(bar.c).toFixed(2),
      pnl_pct: +((this._pnl(bar.c) / (this.fill_price * this.shares)) * 100).toFixed(2),
    };
  }
  _close(outcome, price, reason, time) {
    this.outcome = outcome; this.exit_price = +price.toFixed(2); this.exit_reason = reason; this.exit_time = time;
    return { status: 'closed', ...this.summary() };
  }
  summary() {
    return {
      outcome: this.outcome, exit_price: this.exit_price, exit_reason: this.exit_reason, exit_time: this.exit_time,
      mfe: +this.mfe.toFixed(2), mae: +this.mae.toFixed(2),
      bars_held: this.bars_since_fill,
      pnl: this.exit_price != null ? +this._pnl(this.exit_price).toFixed(2) : 0,
      pnl_pct: this.exit_price != null ? +((this._pnl(this.exit_price) / (this.fill_price * this.shares)) * 100).toFixed(2) : 0,
      shares: this.shares,
      // v8.0.2 (BACKLOG #7): breakeven audit
      original_stop: this.original_stop,
      breakeven_active: this.breakeven_active,
      breakeven_released: this.breakeven_released,
      stop_history: this.stop_history,
    };
  }
}

// ── CONTEXT ENGINE (port of context_engine.py) ──────────────────────────
const CTX = {
  GAP_THRESHOLD: 0.5, GAP_PTS: 5,
  TODAY_WEIGHT: [1.0, 0.7, 0.4],
  YESTERDAY_WEIGHT: 0.3,
  STRENGTH_WEIGHT: { Strong: 1.0, Moderate: 0.6, Weak: 0.2 },
  LABEL_THRESHOLDS: [[10, 'Strong bullish'], [4, 'Mild bullish'], [-3, 'Mixed'], [-9, 'Mild bearish'], [-99, 'Strong bearish']],
  SIGNAL_MODIFIER: {
    'up_Strong bullish': 10, 'up_Mild bullish': 5, 'up_Mixed': 0, 'up_Mild bearish': -5, 'up_Strong bearish': -10,
    'down_Strong bearish': 10, 'down_Mild bearish': 5, 'down_Mixed': 0, 'down_Mild bullish': -5, 'down_Strong bullish': -10,
  },
};

function computeContext(allCandles, currentBarIdx, todayDate, signalDir) {
  const upto = allCandles.slice(0, currentBarIdx + 1);
  const todayBars = upto.filter(c => c.t.slice(0,10) === todayDate && c.t.slice(11,16) >= '09:45');
  const targetTotal = 150;
  const remaining = targetTotal - todayBars.length;
  let prevBars = [];
  if (remaining > 0) {
    const beforeToday = upto.filter(c => c.t.slice(0,10) < todayDate);
    prevBars = beforeToday.length >= remaining ? beforeToday.slice(-remaining) : beforeToday;
  }
  // Gap
  let gapPts = 0, gapPct = 0;
  if (todayBars.length && prevBars.length) {
    const todayOpenBar = upto.find(c => c.t.slice(0,10) === todayDate);
    if (todayOpenBar) {
      const todayOpen = todayOpenBar.o;
      const prevClose = prevBars[prevBars.length-1].c;
      gapPct = (todayOpen - prevClose) / (prevClose || 1) * 100;
      if (gapPct > CTX.GAP_THRESHOLD) gapPts = CTX.GAP_PTS;
      else if (gapPct < -CTX.GAP_THRESHOLD) gapPts = -CTX.GAP_PTS;
    }
  }
  // Today zones
  let todayPts = 0;
  if (todayBars.length >= 3) {
    const tz = computeZonesPD(todayBars);
    const dz = tz.filter(z => z.dir === 'up' || z.dir === 'down');
    const rev = [...dz].reverse();
    rev.forEach((z, rank) => {
      const wIdx = Math.min(rank, CTX.TODAY_WEIGHT.length - 1);
      const rW = CTX.TODAY_WEIGHT[wIdx];
      const sW = CTX.STRENGTH_WEIGHT[z.strength || 'Weak'] || 0.2;
      const slope = Math.abs(z.slope_mid || 0);
      const szW = Math.min(slope / 1.0, 1.5);
      todayPts += rW * sW * szW * (z.dir === 'up' ? 10 : -10);
    });
  }
  // Yesterday zones
  let ydyPts = 0;
  if (prevBars.length >= 3) {
    const pz = computeZonesPD(prevBars);
    const dz = pz.filter(z => z.dir === 'up' || z.dir === 'down');
    for (const z of dz) {
      const sW = CTX.STRENGTH_WEIGHT[z.strength || 'Weak'] || 0.2;
      const slope = Math.abs(z.slope_mid || 0);
      const szW = Math.min(slope / 1.0, 1.5);
      ydyPts += CTX.YESTERDAY_WEIGHT * sW * szW * (z.dir === 'up' ? 10 : -10);
    }
  }
  const raw = todayPts + gapPts + ydyPts;
  const score = Math.round(raw);
  let label = 'Strong bearish';
  for (const [thr, lbl] of CTX.LABEL_THRESHOLDS) {
    if (score >= thr) { label = lbl; break; }
  }
  const sigMod = CTX.SIGNAL_MODIFIER[`${signalDir || 'up'}_${label}`] || 0;
  return { score, label, gap_pts: gapPts, gap_pct: +gapPct.toFixed(2), today_pts: +todayPts.toFixed(1), yesterday_pts: +ydyPts.toFixed(1), signal_mod: sigMod };
}

function applyContext(baseScore, context) {
  let final = baseScore + context.signal_mod;
  final = Math.max(0, Math.min(100, final));
  const conviction = final >= 70 ? 'HIGH' : final >= 50 ? 'MODERATE' : 'LOW';
  return { base_score: baseScore, signal_mod: context.signal_mod, final_score: final, conviction, alarm: final >= 50, context_label: context.label };
}
const SPD = {
  INSIG_PCT_THRESHOLD: 0.05,
  INSIG_RANGE_ATR_MULT: 0.30,
  INSIG_BODY_THRESHOLD: 0.30,
  DIR_THRESHOLD_PCT: 0.005,
};

function classifyBar(bar, prevClose, atr) {
  if (prevClose <= 0) {
    const bd = bar.c > bar.o ? 'up' : bar.c < bar.o ? 'down' : 'flat';
    return { direction: bd, absChg: 0 };
  }
  const chg = (bar.c - prevClose) / prevClose * 100;
  if (chg > SPD.DIR_THRESHOLD_PCT) return { direction: 'up', absChg: Math.abs(chg) };
  if (chg < -SPD.DIR_THRESHOLD_PCT) return { direction: 'down', absChg: Math.abs(chg) };
  if (bar.c > bar.o) return { direction: 'up', absChg: Math.abs(chg) };
  if (bar.c < bar.o) return { direction: 'down', absChg: Math.abs(chg) };
  return { direction: 'flat', absChg: Math.abs(chg) };
}

function isInsignificant(bar, absChgPct, atr) {
  if (atr <= 0) atr = 0.001;
  const range = bar.h - bar.l;
  const body = Math.abs(bar.c - bar.o);
  const bp = body / (range || 0.001);
  return absChgPct < SPD.INSIG_PCT_THRESHOLD && range < SPD.INSIG_RANGE_ATR_MULT * atr && bp < SPD.INSIG_BODY_THRESHOLD;
}

function isDojiSPD(bar) {
  const r = bar.h - bar.l;
  if (r <= 0) return true;
  return Math.abs(bar.c - bar.o) / r < SPD.INSIG_BODY_THRESHOLD;
}

class StreamingPushDetector {
  constructor(atr, minBars) {
    this.atr = atr;
    this.minBars = minBars || 3;
    this.reset();
  }
  reset() {
    this.state = 'IDLE';
    this.candles = [];
    this.barClasses = [];
    this.barSignificant = [];
    this.pushDir = null;
    this.pushStartIdx = null;
    this.lastPushIdx = null;
    this.heldIndices = [];
    this.idleStreakDir = null;
    this.idleStreakBars = [];
  }
  processBar(bar) {
    const idx = this.candles.length;
    const prevClose = this.candles.length ? this.candles[this.candles.length-1].c : 0;
    const cls = classifyBar(bar, prevClose, this.atr);
    const insig = isInsignificant(bar, cls.absChg, this.atr);
    const barClass = insig ? 'insig' : cls.direction;
    const sig = !insig;
    this.candles.push(bar);
    this.barClasses.push(barClass);
    this.barSignificant.push(sig);
    if (this.state === 'IDLE') return this._handleIdle(idx, barClass, sig, cls.direction);
    if (this.state === 'IN_PUSH') return this._handleInPush(idx, barClass, sig, cls.direction, bar);
    if (this.state === 'HOLD_1') return this._handleHold1(idx, barClass, sig, cls.direction, bar);
    if (this.state === 'HOLD_2') return this._handleHold2(idx, barClass, sig, cls.direction, bar);
    return null;
  }
  _handleIdle(idx, barClass, sig, dir) {
    if (!sig || dir === 'flat') { this.idleStreakDir = null; this.idleStreakBars = []; return null; }
    if (dir !== this.idleStreakDir) { this.idleStreakDir = dir; this.idleStreakBars = [idx]; }
    else this.idleStreakBars.push(idx);
    if (this.idleStreakBars.length >= this.minBars) {
      this.state = 'IN_PUSH';
      this.pushDir = dir;
      this.pushStartIdx = this.idleStreakBars[0];
      this.lastPushIdx = idx;
      this.heldIndices = [];
      this.idleStreakDir = null;
      this.idleStreakBars = [];
    }
    return null;
  }
  _handleInPush(idx, barClass, sig, dir, bar) {
    if (sig && dir === this.pushDir) { this.lastPushIdx = idx; return null; }
    if (!sig) { this.state = 'HOLD_1'; this.heldIndices = [idx]; return null; }
    return this._endPush(idx, idx, []);
  }
  _handleHold1(idx, barClass, sig, dir, bar) {
    if (sig && dir === this.pushDir) { this.lastPushIdx = idx; this.heldIndices = []; this.state = 'IN_PUSH'; return null; }
    if (sig && dir !== this.pushDir) return this._endPush(idx, idx, this.heldIndices);
    const heldBar = this.candles[this.heldIndices[0]];
    if (isDojiSPD(heldBar) && isDojiSPD(bar)) { this.heldIndices.push(idx); this.state = 'HOLD_2'; return null; }
    return this._endPush(idx, idx, this.heldIndices);
  }
  _handleHold2(idx, barClass, sig, dir, bar) {
    if (sig && dir === this.pushDir) { this.lastPushIdx = idx; this.heldIndices = []; this.state = 'IN_PUSH'; return null; }
    return this._endPush(idx, idx, this.heldIndices);
  }
  _endPush(curIdx, counterStartsAt, retroCounters) {
    const allCounters = [...retroCounters];
    if (!allCounters.includes(counterStartsAt)) allCounters.push(counterStartsAt);
    const pushDict = {
      start_idx: this.pushStartIdx,
      end_idx: this.lastPushIdx,
      dir: this.pushDir,
      bars: this.lastPushIdx - this.pushStartIdx + 1,
      counter_indices: allCounters,
      candles: [...this.candles],
      detected_at_idx: curIdx,
    };
    this.state = 'IDLE';
    this.pushDir = null;
    this.pushStartIdx = null;
    this.lastPushIdx = null;
    this.heldIndices = [];
    // Seed new idle streak from significant counters in opposite direction
    let nsd = null, nsb = [];
    for (const ci of allCounters) {
      if (ci >= this.barSignificant.length || !this.barSignificant[ci]) continue;
      const c = this.barClasses[ci];
      if (c === 'up' || c === 'down') {
        if (nsd === null || nsd === c) { nsd = c; nsb.push(ci); }
        else { nsd = c; nsb = [ci]; }
      }
    }
    this.idleStreakDir = nsd;
    this.idleStreakBars = nsb;
    return pushDict;
  }
}

function eventToQualifyingPush(event, atr, minAtrMult, minSlopePct, minBars) {
  const candles = event.candles;
  const startIdx = event.start_idx;
  const endIdx = event.end_idx;
  const isUp = event.dir === 'up';
  const bars = endIdx - startIdx + 1;
  if (bars < (minBars || 3)) return null;
  const pushBars = candles.slice(startIdx, endIdx + 1);
  const startOpen = pushBars[0].o;
  const endClose = pushBars[pushBars.length - 1].c;
  const swingHigh = Math.max(...pushBars.map(b => b.h));
  const swingLow = Math.min(...pushBars.map(b => b.l));
  const extreme = isUp ? swingHigh : swingLow;
  const pushRange = swingHigh - swingLow;
  const netMove = pushRange;
  const slopeOcPct = (endClose - startOpen) / (startOpen || 1) * 100;
  const midF = (pushBars[0].h + pushBars[0].l) / 2;
  const midL = (pushBars[pushBars.length-1].h + pushBars[pushBars.length-1].l) / 2;
  const slopeMidPct = (midL - midF) / (midF || 1) * 100;
  if (Math.abs(slopeMidPct) < (minSlopePct || 0.30)) return null;
  if (netMove < atr * (minAtrMult || 2.0)) return null;
  const MID_MIN = 0.15;
  if (Math.abs(slopeMidPct) < MID_MIN) return null;
  const slopeRatio = Math.abs(slopeOcPct) / 0.05;
  let strength;
  if (slopeRatio >= 5) strength = 'Strong';
  else if (slopeRatio >= 2) strength = 'Moderate';
  else strength = 'Weak';
  if (strength !== 'Strong') return null;
  const highestClose = Math.max(...pushBars.map(b => b.c));
  const lowestClose = Math.min(...pushBars.map(b => b.c));
  return {
    dir: event.dir, is_up: isUp,
    start_idx: startIdx, end_idx: endIdx, bars,
    start_time: pushBars[0].t.slice(11,16),
    end_time: pushBars[pushBars.length-1].t.slice(11,16),
    start_price: +startOpen.toFixed(2),
    end_price: +endClose.toFixed(2),
    extreme: +extreme.toFixed(2),
    highest_close: +highestClose.toFixed(2),
    lowest_close: +lowestClose.toFixed(2),
    swing_high: +swingHigh.toFixed(2),
    swing_low: +swingLow.toFixed(2),
    push_range: +pushRange.toFixed(2),
    net_move: +pushRange.toFixed(2),
    move: +pushRange.toFixed(2),
    slope: +slopeOcPct.toFixed(3),
    slope_mid: +Math.abs(slopeMidPct).toFixed(3),
    strength,
    atr: +atr.toFixed(2),
    push_id: `${event.dir}_${pushBars[0].t.slice(11,16)}_${Math.round(extreme*10)/10}`,
    detected_at_idx: event.detected_at_idx,
    counter_indices_at_end: event.counter_indices,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ENG, RULE, computeZonesPD, findQualifyingPush,
    StreamingPushDetector, eventToQualifyingPush,
    computeRSIEngine, checkRTTouch, checkCounterSwingVeto, scoreSignal,
    Tier2Monitor, computeBrokenSR, buildRationale, Tier3Tracker,
    barMove, bodyPct, isDoji, computeRetrace,
    computeContext, applyContext,
  };
}
// ═══════════════════════════════════════════════════════════════════════════
// END NEW ENGINE
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR v7 — Tier 1 / Tier 2 / Tier 3 cycles
// ═══════════════════════════════════════════════════════════════════════════

// ── ACTIVE STATE ────────────────────────────────────────────────────────────
const STATE = {
  watchlist: {},      // sym -> { push, detector_state, monitor, fetched_at }
  alerts: [],         // open alerts NOT yet taken
  live_trades: {},    // alert_id -> { alert, fill_price, fill_time, tracker, last_bar_t }
  shadow_trades: {},  // alert_id -> { alert, tracker, last_bar_t, dismissed_at } — what-if tracker for dismissed alerts
  history: [],        // closed live trades AND dismissed alerts (entry_type: REALIZED or SHADOW or DISMISSED)
  audit_log: [],      // ALL alerts ever fired today (permanent record, never deleted)
  // v8.0.2 (BACKLOG #14, #16): Tier 3 notifications queued for dashboard polling.
  // Dashboard polls /v8/tier3-notifications, sends to Telegram from browser,
  // marks them as read via /v8/tier3-notifications/mark-read.
  tier3_notifications: [],
  blocked_pushes: new Set(),  // push_ids that already fired (don't refire same)
  tier1_running: false,
  tier1_progress: { scanned: 0, total: 0, status: 'idle' },
  tier1_at: null,
  tier2_running: false,
  tier2_at: null,
  tier3_at: null,
};

// ── STATE PERSISTENCE ──────────────────────────────────────────────────
// Snapshot to /tmp/state.json (Railway preserves /tmp across deploys
// as long as container isn't fully replaced; for cold restarts, state is lost).
// For more durable storage, would need Postgres — deferred per project notes.

const fs = require('fs');
const STATE_FILE = '/tmp/signal_state.json';
let saveStateTimer = null;
let lastSaveAt = 0;

// ─────────────────────────────────────────────────────────────────────────
// LIFECYCLE — releaseStock (BACKLOG #1, v8.0.2)
// ─────────────────────────────────────────────────────────────────────────
// Server-side cleanup: removes a stock from Tier 2 watchlist and clears
// its push_id from blocked_pushes, so Tier 1 can detect fresh pushes
// on the same stock without waiting for natural timeout.
// Called by: dismiss-alert, manual-exit-trade, Tier 3 auto-close.
function releaseStock(symbol, push_id, reason) {
  let releasedWatchlist = false;
  let releasedBlocked = false;
  if (symbol && STATE.watchlist[symbol]) {
    delete STATE.watchlist[symbol];
    releasedWatchlist = true;
  }
  if (push_id && STATE.blocked_pushes.has(push_id)) {
    STATE.blocked_pushes.delete(push_id);
    releasedBlocked = true;
  }
  STATE.audit_log.push({
    event: 'RELEASED',
    symbol: symbol || null,
    push_id: push_id || null,
    reason: reason || 'unspecified',
    released_watchlist: releasedWatchlist,
    released_blocked: releasedBlocked,
    time: new Date().toISOString(),
  });
  console.log(`[RELEASE] ${symbol} push_id=${push_id} reason=${reason} wl=${releasedWatchlist} blk=${releasedBlocked}`);
  return { released_watchlist: releasedWatchlist, released_blocked: releasedBlocked };
}

function snapshotState() {
  // Watchlist: drop monitor (will rebuild from day_bars + counter_indices)
  const watchlistOut = {};
  for (const [sym, w] of Object.entries(STATE.watchlist)) {
    watchlistOut[sym] = {
      push: w.push, push_id: w.push_id,
      sr_levels: w.sr_levels, broken_sr: w.broken_sr,
      context_score: w.context_score,
      day_bars: w.day_bars,
      atr: w.atr,
      counter_indices: w.counter_indices || [],
      push_end_idx: w.push_end_idx,
      last_bar_t: w.last_bar_t,
      added_at: w.added_at,
      monitor_was_created: w.monitor_was_created || false,   // for restart-detection guard
      // monitor omitted — rebuilt on next Tier 2 cycle
    };
  }
  // Live trades: serialize tracker state
  const liveTradesOut = {};
  for (const [id, t] of Object.entries(STATE.live_trades)) {
    liveTradesOut[id] = {
      alert: t.alert,
      fill_price: t.fill_price,
      fill_time: t.fill_time,
      shares: t.shares,
      closed: t.closed,
      last_bar_t: t.last_bar_t,
      last_status: t.last_status,
      // Serialize tracker internal state for reconstruction
      tracker_state: t.tracker ? {
        bars_since_fill: t.tracker.bars_since_fill,
        mfe: t.tracker.mfe,
        mae: t.tracker.mae,
        exit_override: t.tracker.exit_override,
        outcome: t.tracker.outcome,
        exit_reason: t.tracker.exit_reason,
        exit_price: t.tracker.exit_price,
        exit_time: t.tracker.exit_time,
        last_price: t.tracker.last_price,
        // v8.0.2 (BACKLOG #7): breakeven state
        original_stop: t.tracker.original_stop,
        current_stop: t.tracker.current_stop,
        breakeven_active: t.tracker.breakeven_active,
        breakeven_released: t.tracker.breakeven_released,
        stop_history: t.tracker.stop_history,
        // v8.0.2 (BACKLOG #14): live vs shadow distinction
        is_shadow: !!t.tracker.is_shadow,
      } : null,
    };
  }
  // Shadow trades: same shape, just for dismissed alerts
  const shadowTradesOut = {};
  for (const [id, t] of Object.entries(STATE.shadow_trades)) {
    shadowTradesOut[id] = {
      alert: t.alert,
      dismissed_at: t.dismissed_at,
      closed: t.closed,
      last_bar_t: t.last_bar_t,
      last_status: t.last_status,
      tracker_state: t.tracker ? {
        bars_since_fill: t.tracker.bars_since_fill,
        mfe: t.tracker.mfe,
        mae: t.tracker.mae,
        exit_override: t.tracker.exit_override,
        outcome: t.tracker.outcome,
        exit_reason: t.tracker.exit_reason,
        exit_price: t.tracker.exit_price,
        exit_time: t.tracker.exit_time,
        last_price: t.tracker.last_price,
        // v8.0.2 (BACKLOG #7): breakeven state for shadow tracker
        original_stop: t.tracker.original_stop,
        current_stop: t.tracker.current_stop,
        breakeven_active: t.tracker.breakeven_active,
        breakeven_released: t.tracker.breakeven_released,
        stop_history: t.tracker.stop_history,
        // v8.0.2 (BACKLOG #14): live vs shadow distinction
        is_shadow: true,
      } : null,
    };
  }
  return {
    version: 2,
    saved_at: new Date().toISOString(),
    watchlist: watchlistOut,
    alerts: STATE.alerts,
    live_trades: liveTradesOut,
    shadow_trades: shadowTradesOut,
    history: STATE.history,
    audit_log: STATE.audit_log,
    tier3_notifications: STATE.tier3_notifications || [],
    blocked_pushes: Array.from(STATE.blocked_pushes),
    tier1_at: STATE.tier1_at,
    tier2_at: STATE.tier2_at,
    tier3_at: STATE.tier3_at,
  };
}

function saveStateNow() {
  try {
    const snap = snapshotState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(snap));
    lastSaveAt = Date.now();
  } catch (e) {
    console.warn('[STATE] save error:', e.message);
  }
}

// Debounced save: schedules a save 2s after the last call (so multiple rapid
// mutations within a Tier 2 cycle coalesce into one disk write).
function saveStateDebounced() {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveStateNow, 2000);
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log('[STATE] no snapshot found — starting fresh');
      return false;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const snap = JSON.parse(raw);
    if (snap.version !== 1 && snap.version !== 2) {
      console.warn(`[STATE] snapshot version mismatch (${snap.version}), ignoring`);
      return false;
    }
    // Check freshness — if older than 24h, probably stale (new trading day)
    const savedAt = new Date(snap.saved_at).getTime();
    const ageHr = (Date.now() - savedAt) / 3600000;
    if (ageHr > 24) {
      console.log(`[STATE] snapshot is ${ageHr.toFixed(1)}h old — too stale, starting fresh`);
      return false;
    }
    // Check trading day — only restore if same calendar day in IST
    const savedDay = new Date(savedAt + 5.5 * 3600000).toISOString().slice(0, 10);
    const nowDay = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    if (savedDay !== nowDay) {
      console.log(`[STATE] snapshot is from ${savedDay}, today is ${nowDay} — starting fresh`);
      return false;
    }

    // Restore watchlist (monitor will be reconstructed on next Tier 2)
    STATE.watchlist = snap.watchlist || {};
    STATE.alerts = snap.alerts || [];
    STATE.history = snap.history || [];
    STATE.audit_log = snap.audit_log || [];
    STATE.tier3_notifications = snap.tier3_notifications || [];
    STATE.blocked_pushes = new Set(snap.blocked_pushes || []);
    STATE.tier1_at = snap.tier1_at;
    STATE.tier2_at = snap.tier2_at;
    STATE.tier3_at = snap.tier3_at;

    // Live trades — reconstruct trackers from saved state
    STATE.live_trades = {};
    for (const [id, t] of Object.entries(snap.live_trades || {})) {
      const tracker = new Tier3Tracker(t.alert, t.fill_price, t.fill_time, t.shares || 1, false);
      if (t.tracker_state) {
        tracker.bars_since_fill = t.tracker_state.bars_since_fill || 0;
        tracker.mfe = t.tracker_state.mfe || 0;
        tracker.mae = t.tracker_state.mae || 0;
        tracker.exit_override = t.tracker_state.exit_override || false;
        tracker.outcome = t.tracker_state.outcome;
        tracker.exit_reason = t.tracker_state.exit_reason;
        tracker.exit_price = t.tracker_state.exit_price;
        tracker.exit_time = t.tracker_state.exit_time;
        tracker.last_price = t.tracker_state.last_price || t.fill_price;
        // v8.0.2 (BACKLOG #7): rehydrate breakeven state
        if (t.tracker_state.original_stop != null) tracker.original_stop = t.tracker_state.original_stop;
        if (t.tracker_state.current_stop != null) tracker.current_stop = t.tracker_state.current_stop;
        tracker.breakeven_active = t.tracker_state.breakeven_active || false;
        tracker.breakeven_released = t.tracker_state.breakeven_released || false;
        tracker.stop_history = Array.isArray(t.tracker_state.stop_history) ? t.tracker_state.stop_history : [];
        // v8.0.2 (BACKLOG #14): always re-assert live trade
        tracker.is_shadow = false;
      }
      STATE.live_trades[id] = {
        alert: t.alert,
        fill_price: t.fill_price,
        fill_time: t.fill_time,
        shares: t.shares || 1,
        tracker,
        last_bar_t: t.last_bar_t,
        closed: t.closed || false,
        last_status: t.last_status || { status: 'open' },
      };
    }
    // Shadow trades — reconstruct trackers (entry_price used as "fill", shares=1)
    STATE.shadow_trades = {};
    for (const [id, t] of Object.entries(snap.shadow_trades || {})) {
      const fillPx = t.alert.entry_price;
      const fillTime = t.dismissed_at || new Date().toISOString();
      const tracker = new Tier3Tracker(t.alert, fillPx, fillTime, 1, true);
      if (t.tracker_state) {
        tracker.bars_since_fill = t.tracker_state.bars_since_fill || 0;
        tracker.mfe = t.tracker_state.mfe || 0;
        tracker.mae = t.tracker_state.mae || 0;
        tracker.exit_override = t.tracker_state.exit_override || false;
        tracker.outcome = t.tracker_state.outcome;
        tracker.exit_reason = t.tracker_state.exit_reason;
        tracker.exit_price = t.tracker_state.exit_price;
        tracker.exit_time = t.tracker_state.exit_time;
        tracker.last_price = t.tracker_state.last_price || fillPx;
        // v8.0.2 (BACKLOG #7): rehydrate breakeven state for shadow tracker
        if (t.tracker_state.original_stop != null) tracker.original_stop = t.tracker_state.original_stop;
        if (t.tracker_state.current_stop != null) tracker.current_stop = t.tracker_state.current_stop;
        tracker.breakeven_active = t.tracker_state.breakeven_active || false;
        tracker.breakeven_released = t.tracker_state.breakeven_released || false;
        tracker.stop_history = Array.isArray(t.tracker_state.stop_history) ? t.tracker_state.stop_history : [];
        // v8.0.2 (BACKLOG #14): always re-assert shadow trade
        tracker.is_shadow = true;
      }
      STATE.shadow_trades[id] = {
        alert: t.alert,
        dismissed_at: t.dismissed_at,
        tracker,
        last_bar_t: t.last_bar_t,
        closed: t.closed || false,
        last_status: t.last_status || { status: 'open' },
      };
    }
    console.log(`[STATE] restored from ${snap.saved_at}: ${Object.keys(STATE.watchlist).length} watchlist, ${STATE.alerts.length} alerts, ${Object.keys(STATE.live_trades).length} live trades, ${Object.keys(STATE.shadow_trades).length} shadow trades, ${STATE.history.length} history`);
    return true;
  } catch (e) {
    console.warn('[STATE] load error:', e.message);
    return false;
  }
}

// Load on startup
loadState();

// Periodic save every 60s as backup (in case debounced saves miss something)
setInterval(saveStateNow, 60000);

// ── STOCK UNIVERSE (use NSE_UNIVERSE constant from existing server.js) ──
// NSE_UNIVERSE is already defined in server.js around line ~200

// ── TIER 1: every 10 min, scan all stocks, find qualifying pushes ──────
async function runTier1v7() {
  if (STATE.tier1_running) return;
  if (!isMarketHours()) {
    console.log(`[T1v7 ${new Date().toISOString()}] Skipped — outside market hours`);
    return;
  }
  STATE.tier1_running = true;
  STATE.tier1_progress = { scanned: 0, total: NSE_UNIVERSE.length, status: 'running' };
  console.log(`[T1v7 ${new Date().toISOString()}] Starting scan of ${NSE_UNIVERSE.length} stocks`);

  for (let i = 0; i < NSE_UNIVERSE.length; i++) {
    const symbol = NSE_UNIVERSE[i];
    STATE.tier1_progress.scanned = i + 1;

    // Skip if already on Tier 2 watchlist (monitor active)
    if (STATE.watchlist[symbol] && STATE.watchlist[symbol].monitor) continue;

    try {
      const candles = await fetchKite5Min(symbol);
      if (!candles || candles.length < 30) { await sleep(80); continue; }

      // Only use today's bars from 9:45 onwards for push detection
      const today = candles[candles.length-1].t.slice(0, 10);
      const todayBars = candles.filter(b => b.t.slice(0,10) === today && b.t.slice(11,16) >= '09:45');
      if (todayBars.length < 5) { await sleep(80); continue; }

      // Compute ATR from prior bars (no look-ahead)
      const priorBars = candles.filter(b => b.t.slice(0,10) !== today);
      const atr = priorBars.length > 14 ? computeATR(priorBars.slice(-75)) : computeATR(candles);

      // Run streaming detector on today's bars (re-runs from scratch each cycle)
      const detector = new StreamingPushDetector(atr, ENG.MIN_BARS);
      let lastQP = null;
      let lastEvent = null;
      for (let bi = 0; bi < todayBars.length; bi++) {
        const ev = detector.processBar(todayBars[bi]);
        if (ev) {
          const qp = eventToQualifyingPush(ev, atr, ENG.MIN_ATR_MULT, ENG.MIN_SLOPE_PCT, ENG.MIN_BARS);
          if (qp) { lastQP = qp; lastEvent = ev; }
        }
      }
      if (!lastQP) { await sleep(80); continue; }
      const qp = lastQP;

      // Check if this push was already fired and blocked
      const pushId = qp.push_id;
      if (STATE.blocked_pushes.has(pushId)) { await sleep(80); continue; }

      // Check push is recent (within last 2 bars / 10 min)
      // Was: PUSH_EXPIRY_BARS + 2 = 4 bars / 20 min (too loose)
      const barsSincePush = todayBars.length - 1 - qp.end_idx;
      if (barsSincePush > ENG.PUSH_EXPIRY_BARS) { await sleep(80); continue; }

      // Compute SR (using historical bars for context)
      const srRes = computeSR(candles);
      const srLevels = [...(srRes.supports || []), ...(srRes.resistances || [])];

      // Compute broken_sr with Fix 1
      const brokenSR = computeBrokenSR(srLevels, qp);

      // Context score (proper port of context_engine.py)
      const curBarIdx = candles.length - 1;
      const ctx = computeContext(candles, curBarIdx, today, qp.dir);
      const contextScore = ctx.score;

      // Add to watchlist
      const lastBarT = todayBars[todayBars.length-1].t;
      STATE.watchlist[symbol] = {
        push: qp,
        push_id: pushId,
        sr_levels: srLevels,
        broken_sr: brokenSR,
        context_score: contextScore,
        day_bars: todayBars,
        atr,
        counter_indices: lastEvent ? lastEvent.counter_indices : [],   // for Tier 2 prefill
        push_end_idx: qp.end_idx,
        last_bar_t: lastBarT,
        monitor: null,
        added_at: new Date().toISOString(),
      };
      console.log(`[T1v7] + ${symbol} (${qp.dir} push, ${qp.bars}b, ${qp.move.toFixed(2)} move, ${(qp.move/atr).toFixed(1)}xATR)`);

    } catch (e) {
      console.warn(`[T1v7] ${symbol} error:`, e.message);
    }

    await sleep(80);
  }

  STATE.tier1_running = false;
  STATE.tier1_progress.status = 'done';
  STATE.tier1_at = new Date().toISOString();
  const watchCount = Object.keys(STATE.watchlist).length;
  console.log(`[T1v7 ${new Date().toISOString()}] Done — ${watchCount} stocks on watchlist`);
  saveStateDebounced();
}

// ── TIER 2: every 5 min, run monitor on each watchlist stock ───────────
async function runTier2v7() {
  if (STATE.tier2_running) return;
  if (!isMarketHours()) return;
  if (!Object.keys(STATE.watchlist).length) return;

  STATE.tier2_running = true;
  console.log(`[T2v7 ${new Date().toISOString()}] Processing ${Object.keys(STATE.watchlist).length} watchlist stocks`);

  for (const symbol of Object.keys(STATE.watchlist)) {
    const entry = STATE.watchlist[symbol];

    try {
      const candles = await fetchKite5Min(symbol);
      if (!candles || candles.length < 30) continue;

      const today = candles[candles.length-1].t.slice(0, 10);
      const todayBars = candles.filter(b => b.t.slice(0,10) === today && b.t.slice(11,16) >= '09:45');
      if (todayBars.length < 5) continue;

      // Find bars AFTER the last bar we processed
      const lastProcessedIdx = todayBars.findIndex(b => b.t === entry.last_bar_t);
      const newBars = lastProcessedIdx >= 0 ? todayBars.slice(lastProcessedIdx + 1) : todayBars.slice(-3);

      if (newBars.length === 0) continue;

      // STALENESS CHECK — if the push end is too old by clock time, drop it.
      // This prevents alerts firing 30+ min after the push ended, even if
      // monitor state was lost (e.g. server restart) and bar_count would
      // otherwise allow more processing.
      // MAX_PUSH_AGE_MIN = 65 — validated against parity test on May 8
      // (40 min killed 5 valid B/H2 setups; 65 min catches LALPATHLAB-style
      // 75-min stale bugs while preserving all legitimate setups)
      const MAX_PUSH_AGE_MIN = 65;
      const pushEndBar = todayBars.find(b => b.t.slice(11, 16) === entry.push.end_time);
      if (pushEndBar) {
        const lastBarT = newBars[newBars.length - 1].t;
        const ageMin = (new Date(lastBarT) - new Date(pushEndBar.t)) / 60000;
        if (ageMin > MAX_PUSH_AGE_MIN) {
          console.log(`[T2v7] ${symbol} push too stale (${Math.round(ageMin)} min since push end ${entry.push.end_time}) — dropping`);
          STATE.audit_log.push({
            event: 'SKIPPED', reason: 'push_stale_clock_time',
            symbol, push_id: entry.push_id,
            push_time: `${entry.push.start_time}→${entry.push.end_time}`,
            push_age_min: Math.round(ageMin),
            bar_time: lastBarT, fired_at: new Date().toISOString(),
          });
          STATE.blocked_pushes.add(entry.push_id);
          delete STATE.watchlist[symbol];
          continue;
        }
      }

      // 14:30 cutoff — no new alerts after this time
      const lastBarTime = newBars[newBars.length-1].t.slice(11, 16);
      if (lastBarTime >= '14:30') {
        console.log(`[T2v7] ${symbol} past 14:30 cutoff, dropping from watchlist`);
        delete STATE.watchlist[symbol];
        continue;
      }

      // Initialize monitor if not yet
      if (!entry.monitor) {
        // If we already processed bars beyond prefill in a PRIOR session
        // (entry.monitor_was_created flag set, but monitor is null now),
        // monitor state was lost (probably server restart). Drop entry to
        // avoid resetting the bar_count timer.
        // First-time Tier 2 (monitor never existed) does NOT trigger this.
        const lastCi = (entry.counter_indices && entry.counter_indices.length)
          ? entry.counter_indices[entry.counter_indices.length - 1] : -1;
        const lastCiBarT = (lastCi >= 0 && lastCi < todayBars.length) ? todayBars[lastCi].t : null;
        if (entry.monitor_was_created && entry.last_bar_t && lastCiBarT && entry.last_bar_t > lastCiBarT) {
          console.log(`[T2v7] ${symbol} monitor state lost (last_bar_t ${entry.last_bar_t.slice(11,16)} > prefill end ${lastCiBarT.slice(11,16)}) — dropping to avoid stale alert`);
          STATE.audit_log.push({
            event: 'SKIPPED', reason: 'monitor_state_lost',
            symbol, push_id: entry.push_id,
            push_time: `${entry.push.start_time}→${entry.push.end_time}`,
            last_bar_processed: entry.last_bar_t,
            bar_time: entry.last_bar_t, fired_at: new Date().toISOString(),
          });
          STATE.blocked_pushes.add(entry.push_id);
          delete STATE.watchlist[symbol];
          continue;
        }
        entry.monitor = new Tier2Monitor(
          entry.push, entry.sr_levels, entry.broken_sr,
          entry.context_score, todayBars[0].o, [],
          entry.day_bars   // v8.0: day_bars_ref for new engine's counter signals
        );
        entry.monitor.symbol = symbol; // for v8.0.1 diagnostic logging
        entry.monitor_was_created = true;   // mark for restart-detection
        // Prefill counter bars from push event
        if (entry.counter_indices) {
          for (const cidx of entry.counter_indices) {
            if (cidx < todayBars.length) {
              entry.monitor.processBar(todayBars[cidx]);
            }
          }
        }
        // Mark last_bar_t to the last counter index we prefed
        if (entry.counter_indices && entry.counter_indices.length) {
          const lastCi2 = entry.counter_indices[entry.counter_indices.length-1];
          if (lastCi2 < todayBars.length) entry.last_bar_t = todayBars[lastCi2].t;
        }
      }

      // Feed each new bar through monitor
      for (const bar of newBars) {
        // Compute fresh atr/ema/rsi at this point
        const idxInCandles = candles.findIndex(c => c.t === bar.t);
        const histBars = candles.slice(0, idxInCandles + 1);
        const liveAtr = computeATR(histBars.slice(-30));
        const liveEma = histBars[histBars.length-1].ema || histBars[histBars.length-1].c;
        const liveRsi = computeRSIEngine(histBars);

        const result = entry.monitor.processBar(bar, liveAtr, liveEma, liveRsi);

        // v8.0.2 (BACKLOG #9): drain any leg-2 retrace gate rejections from
        // this bar into the audit log so the rule's impact is visible.
        if (entry.monitor.leg2_rejections && entry.monitor.leg2_rejections.length) {
          for (const rej of entry.monitor.leg2_rejections) {
            STATE.audit_log.push({
              event: 'COUNTER_REJECTED',
              symbol,
              push_id: entry.push_id,
              push_time: `${entry.push.start_time}→${entry.push.end_time}`,
              trigger: rej.trigger,
              reason: rej.reason,
              retrace_pct: rej.retrace_pct,
              leg2_peak: rej.leg2_peak,
              pb1_bottom: rej.pb1_bottom,
              push_extreme: rej.push_extreme,
              bar_time: rej.bar_time,
              fired_at: new Date().toISOString(),
            });
          }
          entry.monitor.leg2_rejections = [];
        }

        if (result.action === 'SIGNAL') {
          // Fire alert
          const sig = result.signal;
          // Exhaustion B-skip check (already in monitor)
          if (entry.monitor.exhaustion_skip && sig.type === 'B') {
            console.log(`[T2v7] ${symbol} B-signal skipped (exhaustion)`);
            STATE.blocked_pushes.add(entry.push_id);
            delete STATE.watchlist[symbol];
            break;
          }
          // Apply context modifier — get final_score and alarm flag
          const curIdx = candles.findIndex(c => c.t === bar.t);
          const ctxAtSig = computeContext(candles, curIdx >= 0 ? curIdx : candles.length-1, today, sig.dir);
          const finalRes = applyContext(sig.score, ctxAtSig);
          sig.final_score = finalRes.final_score;
          sig.alarm = finalRes.alarm;
          sig.conviction = finalRes.conviction;
          sig.context = ctxAtSig;
          // Only push if alarm passes (matches Python alarm filter)
          if (!sig.alarm) {
            console.log(`[T2v7] ${symbol} ${sig.type} score=${sig.score} final=${finalRes.final_score} below alarm threshold — skipped`);
            STATE.audit_log.push({
              event: 'SKIPPED', reason: 'below_alarm_threshold',
              symbol, type: sig.type, dir: sig.dir,
              score: sig.score, final_score: finalRes.final_score,
              push_id: entry.push_id, push_time: `${entry.push.start_time}→${entry.push.end_time}`,
              bar_time: bar.t, fired_at: new Date().toISOString(),
            });
            STATE.blocked_pushes.add(entry.push_id);
            delete STATE.watchlist[symbol];
            break;
          }
          const alert = {
            alert_id: `${symbol}_${entry.push_id}_${Date.now()}`,
            symbol,
            ...sig,
            rationale: buildRationale(sig, entry.push, entry.broken_sr),
            push: entry.push,
            fired_at: new Date().toISOString(),
            bar_time: bar.t,
            atr: liveAtr,
            status: 'pending',
          };
          STATE.alerts.push(alert);
          STATE.audit_log.push({
            event: 'FIRED', alert_id: alert.alert_id,
            symbol, type: sig.type, dir: sig.dir,
            score: sig.score, final_score: sig.final_score, conviction: sig.conviction,
            entry_price: sig.entry_price, stop_price: sig.stop_price, target_price: sig.target_price,
            rr: sig.rr,
            push_id: entry.push_id, push_time: `${entry.push.start_time}→${entry.push.end_time}`,
            push_extreme: entry.push.extreme, push_move: entry.push.net_move,
            bar_time: bar.t, fired_at: alert.fired_at,
            broken_sr_count: (entry.broken_sr || []).length,
          });
          STATE.blocked_pushes.add(entry.push_id);
          console.log(`[T2v7 ALERT] ${symbol} ${sig.type} ${sig.dir} score=${sig.score}→${finalRes.final_score} entry=${sig.entry_price} stop=${sig.stop_price} target=${sig.target_price}`);
          delete STATE.watchlist[symbol];
          break;
        } else if (result.action === 'CANCEL') {
          // v8.0: CANCEL is only returned by the OLD engine (retrace >80%).
          // NEW engine never returns CANCEL — its counter logic is internal.
          // Old-engine fallback path below is gated off by default; flip
          // ENG.ALLOW_OLD_COUNTER_FALLBACK to true only when rolling back to
          // the old engine.
          if (!ENG.ALLOW_OLD_COUNTER_FALLBACK) {
            STATE.audit_log.push({
              event: 'SKIPPED', reason: 'old_counter_fallback_disabled',
              symbol, push_id: entry.push_id,
              push_time: `${entry.push.start_time}→${entry.push.end_time}`,
              bar_time: bar.t, fired_at: new Date().toISOString(),
            });
            STATE.blocked_pushes.add(entry.push_id);
            delete STATE.watchlist[symbol];
            break;
          }
          // ─── OLD-engine counter fallback (DORMANT under v8.0) ───
          // Check counter trade
          const veto = checkCounterSwingVeto(entry.push, bar, entry.monitor.atr, entry.day_bars);
          if (veto) {
            const isUp = !entry.push.is_up;
            const entry_price = bar.c;
            const swingLook = entry.day_bars.slice(-6);
            const stopExt = isUp ? Math.min(...swingLook.map(b => b.l)) : Math.max(...swingLook.map(b => b.h));
            const stop = isUp ? stopExt - entry.monitor.atr * 0.5 : stopExt + entry.monitor.atr * 0.5;
            const target = isUp ? entry_price + Math.abs(entry_price - stop) * 1.5 : entry_price - Math.abs(entry_price - stop) * 1.5;
            // Compute proper score using scoreSignal on the counter direction
            const counterPush = { ...entry.push, is_up: isUp, dir: isUp ? 'up' : 'down' };
            const [counterScore, counterBreakdown] = scoreSignal(counterPush, 0.5, 0, bar, entry.sr_levels, liveEma, entry.context_score, entry.monitor.atr, 'COUNTER', liveRsi);
            const counterSig = {
              type: 'COUNTER',
              dir: isUp ? 'up' : 'down',
              score: counterScore,
              breakdown: counterBreakdown,
              entry_price: +entry_price.toFixed(2),
              stop_price: +stop.toFixed(2),
              target_price: +target.toFixed(2),
              stop_dist: +Math.abs(entry_price - stop).toFixed(2),
              rr: 1.5,
              bar_time: bar.t,
              push_id: entry.push_id + '_C',
              rt_level: null,
              retrace_pct: null,
            };
            // Apply alarm filter using context
            const curIdx = candles.findIndex(c => c.t === bar.t);
            const ctxAtCounter = computeContext(candles, curIdx >= 0 ? curIdx : candles.length-1, today, counterSig.dir);
            const finalRes = applyContext(counterSig.score, ctxAtCounter);
            counterSig.final_score = finalRes.final_score;
            counterSig.alarm = finalRes.alarm;
            counterSig.conviction = finalRes.conviction;
            counterSig.context = ctxAtCounter;
            if (!counterSig.alarm) {
              console.log(`[T2v7] ${symbol} COUNTER score=${counterScore} final=${finalRes.final_score} below alarm — skipped`);
              STATE.audit_log.push({
                event: 'SKIPPED', reason: 'counter_below_alarm',
                symbol, type: 'COUNTER', dir: counterSig.dir,
                score: counterScore, final_score: finalRes.final_score,
                push_id: entry.push_id, push_time: `${entry.push.start_time}→${entry.push.end_time}`,
                bar_time: bar.t, fired_at: new Date().toISOString(),
              });
              STATE.blocked_pushes.add(entry.push_id);
              delete STATE.watchlist[symbol];
              break;
            }
            const alert = {
              alert_id: `${symbol}_${entry.push_id}_C_${Date.now()}`,
              symbol, ...counterSig,
              rationale: buildRationale(counterSig, entry.push, entry.broken_sr),
              push: entry.push,
              fired_at: new Date().toISOString(),
              bar_time: bar.t,
              atr: entry.monitor.atr,
              status: 'pending',
            };
            STATE.alerts.push(alert);
            STATE.audit_log.push({
              event: 'FIRED', alert_id: alert.alert_id,
              symbol, type: 'COUNTER', dir: counterSig.dir,
              score: counterScore, final_score: counterSig.final_score, conviction: counterSig.conviction,
              entry_price: counterSig.entry_price, stop_price: counterSig.stop_price, target_price: counterSig.target_price,
              rr: counterSig.rr,
              push_id: entry.push_id, push_time: `${entry.push.start_time}→${entry.push.end_time}`,
              push_extreme: entry.push.extreme, push_move: entry.push.net_move,
              bar_time: bar.t, fired_at: alert.fired_at,
              broken_sr_count: (entry.broken_sr || []).length,
              note: 'Counter trade — original push reversed >80%',
            });
            console.log(`[T2v7 COUNTER] ${symbol} score=${counterScore}→${finalRes.final_score} entry=${counterSig.entry_price}`);
          }
          STATE.blocked_pushes.add(entry.push_id);
          delete STATE.watchlist[symbol];
          break;
        } else if (result.action === 'DUMP' || result.action === 'EXHAUSTION') {
          STATE.blocked_pushes.add(entry.push_id);
          delete STATE.watchlist[symbol];
          break;
        }
        // WAITING — continue to next bar
        entry.last_bar_t = bar.t;
      }

    } catch (e) {
      console.warn(`[T2v7] ${symbol} error:`, e.message);
    }
  }

  STATE.tier2_running = false;
  STATE.tier2_at = new Date().toISOString();
  saveStateDebounced();
}

// ── TIER 3: every 1 min — tracks live trades AND shadow (dismissed) trades ──
async function runTier3v7() {
  // v8.0.2: still run shadow tracker even outside market hours (need to handle
  // EOD close at 15:30 IST, and isMarketHours caps at 14:30).
  const inMarket = isMarketHours();
  const liveIds = Object.keys(STATE.live_trades).filter(id => !STATE.live_trades[id].closed);

  // Process live trades only when market is in tradeable hours
  if (inMarket && liveIds.length) {
    for (const id of liveIds) {
    const lt = STATE.live_trades[id];
    try {
      const candles = await fetchKite5Min(lt.alert.symbol);
      if (!candles || !candles.length) continue;

      const today = candles[candles.length-1].t.slice(0, 10);
      const todayBars = candles.filter(b => b.t.slice(0,10) === today);

      // Process bars after fill_time
      const fillIdx = todayBars.findIndex(b => b.t === lt.fill_time);
      const sinceFill = fillIdx >= 0 ? todayBars.slice(fillIdx + 1) : todayBars.slice(-1);
      const lastSeenIdx = lt.last_bar_t ? sinceFill.findIndex(b => b.t === lt.last_bar_t) : -1;
      const newBars = lastSeenIdx >= 0 ? sinceFill.slice(lastSeenIdx + 1) : sinceFill;

      for (const bar of newBars) {
        const r = lt.tracker.processBar(bar);
        lt.last_bar_t = bar.t;
        lt.last_status = r;
        // v8.0.2 (BACKLOG #14, #16): drain notifications from tracker.
        // The dashboard polls /v8/tier3-notifications and pushes to Telegram
        // from the browser side (server has no Telegram credentials).
        // Live trades only — shadow tracker never queues notifications.
        if (lt.tracker.notifications && lt.tracker.notifications.length) {
          for (const n of lt.tracker.notifications) {
            STATE.tier3_notifications.push({
              alert_id: id,
              symbol: lt.alert.symbol,
              type: lt.alert.type,
              dir: lt.alert.dir,
              entry_price: lt.alert.entry_price,
              ...n,
              created_at: new Date().toISOString(),
              read: false,
            });
            STATE.audit_log.push({
              event: 'TIER3_NOTIFY',
              symbol: lt.alert.symbol,
              alert_id: id,
              notify_type: n.type,
              reason: n.reason || null,
              current_stop: n.current_stop,
              current_price: n.current_price,
              unrealized_R: n.unrealized_R,
              time: n.time,
              fired_at: new Date().toISOString(),
            });
          }
          lt.tracker.notifications = [];
        }
        if (r.status === 'closed') {
          lt.closed = true;
          STATE.history.push({
            entry_type: 'REALIZED',
            ...lt.alert,
            ...r,
            fill_price: lt.fill_price,
            fill_time: lt.fill_time,
            closed_at: new Date().toISOString(),
          });
          // v8.0.2 (BACKLOG #1): release stock so Tier 1 can find fresh pushes
          const pushId = lt.alert.push_id || (lt.alert.push && lt.alert.push.push_id) || null;
          releaseStock(lt.alert.symbol, pushId, `auto_close_${r.exit_reason}`);
          console.log(`[T3v7] CLOSED ${lt.alert.symbol} ${r.outcome} ${r.exit_reason} @ ${r.exit_price}`);
          break;
        }
      }
    } catch (e) {
      console.warn(`[T3v7] ${id} error:`, e.message);
    }
    }  // end for live trade loop
  }  // end if (inMarket && liveIds.length)

  // v8.0.2: Run shadow tracker for dismissed alerts (parallel to live trades)
  await runTier3Shadow();

  STATE.tier3_at = new Date().toISOString();
  saveStateDebounced();
}

// ── TIER 3 SHADOW: tracks dismissed alerts in the background (v8.0.2) ──
// Same target/stop/timeout logic as live trades, but never affects real P&L.
// Hard EOD close at 15:30 IST (regardless of outcome).
//
// History flow for a dismissed alert:
//   1. On dismiss: DISMISSED entry pushed to history immediately (visible in UI).
//   2. On shadow close: that same entry is UPGRADED in place to SHADOW with the
//      outcome. We don't push a second entry — that would double-count in sumR.
function upgradeDismissedToShadow(alertId, alertObj, closeResult, dismissedAt) {
  const idx = STATE.history.findIndex(
    h => h.entry_type === 'DISMISSED' && h.alert_id === alertId
  );
  const upgraded = {
    entry_type: 'SHADOW',
    ...alertObj,
    ...closeResult,
    dismissed_at: dismissedAt,
    closed_at: new Date().toISOString(),
  };
  if (idx >= 0) {
    STATE.history[idx] = upgraded;
  } else {
    // Safety net: if DISMISSED entry wasn't found (shouldn't happen), push fresh
    STATE.history.push(upgraded);
  }
}

async function runTier3Shadow() {
  if (!Object.keys(STATE.shadow_trades).length) return;

  // Compute IST time for EOD check
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const ist = new Date(istMs);
  const hm = ist.getHours() * 100 + ist.getMinutes();
  const isAfterClose = hm >= 1530;

  const shadowIds = Object.keys(STATE.shadow_trades).filter(id => !STATE.shadow_trades[id].closed);
  for (const id of shadowIds) {
    const st = STATE.shadow_trades[id];
    try {
      // EOD close: if past 15:30 IST and still open, close at last known price
      if (isAfterClose) {
        const lastPx = st.tracker.last_price || st.alert.entry_price;
        const r = st.tracker._close('EOD', lastPx, 'shadow_eod_close', new Date().toISOString());
        st.closed = true;
        st.last_status = r;
        upgradeDismissedToShadow(id, st.alert, r, st.dismissed_at);
        console.log(`[T3v7-SHADOW] EOD CLOSE ${st.alert.symbol} @ ${lastPx}`);
        continue;
      }

      const candles = await fetchKite5Min(st.alert.symbol);
      if (!candles || !candles.length) continue;

      const today = candles[candles.length-1].t.slice(0, 10);
      const todayBars = candles.filter(b => b.t.slice(0,10) === today);

      // Process bars after dismiss time.
      // dismissed_at is UTC ISO; bar.t is IST-local from Kite. Compare via Date objects.
      const dismissMs = new Date(st.dismissed_at).getTime();
      const dismissIdx = todayBars.findIndex(b => new Date(b.t).getTime() >= dismissMs);
      const sinceDismiss = dismissIdx >= 0 ? todayBars.slice(dismissIdx) : todayBars.slice(-1);
      const lastSeenIdx = st.last_bar_t ? sinceDismiss.findIndex(b => b.t === st.last_bar_t) : -1;
      const newBars = lastSeenIdx >= 0 ? sinceDismiss.slice(lastSeenIdx + 1) : sinceDismiss;

      for (const bar of newBars) {
        const r = st.tracker.processBar(bar);
        st.last_bar_t = bar.t;
        st.last_status = r;
        // v8.0.2: shadow trackers should never queue notifications (is_shadow
        // gate is set true at construct), but clear defensively to keep memory tidy.
        if (st.tracker.notifications && st.tracker.notifications.length) {
          st.tracker.notifications = [];
        }
        if (r.status === 'closed') {
          st.closed = true;
          upgradeDismissedToShadow(id, st.alert, r, st.dismissed_at);
          console.log(`[T3v7-SHADOW] CLOSED ${st.alert.symbol} ${r.outcome} ${r.exit_reason} @ ${r.exit_price}`);
          break;
        }
      }
    } catch (e) {
      console.warn(`[T3v7-SHADOW] ${id} error:`, e.message);
    }
  }
}

// ── SCHEDULERS ────────────────────────────────────────────────────────
setTimeout(runTier1v7, 8000);                              // 8s after startup
setInterval(runTier1v7, 10 * 60 * 1000);                   // every 10 min
setInterval(runTier2v7, 5 * 60 * 1000);                    // every 5 min
setInterval(runTier3v7, 60 * 1000);                        // every 1 min

// ── ENDPOINTS ────────────────────────────────────────────────────────
app.get('/v8/alerts', (req, res) => {
  res.json({
    alerts: STATE.alerts,
    tier1_at: STATE.tier1_at,
    tier2_at: STATE.tier2_at,
    watchlist_count: Object.keys(STATE.watchlist).length,
    blocked_count: STATE.blocked_pushes.size,
  });
});

app.get('/v8/watchlist', (req, res) => {
  const wl = Object.entries(STATE.watchlist).map(([sym, e]) => ({
    symbol: sym,
    push_dir: e.push.dir,
    push_bars: e.push.bars,
    push_move: e.push.move,
    push_extreme: e.push.extreme,
    added_at: e.added_at,
  }));
  res.json({ watchlist: wl, count: wl.length, scanned: STATE.tier1_progress });
});

app.post('/v8/track', (req, res) => {
  const { alert_id, fill_price, fill_time, shares } = req.body || {};
  if (!alert_id || !fill_price) return res.status(400).json({ error: 'alert_id and fill_price required' });
  const alert = STATE.alerts.find(a => a.alert_id === alert_id);
  if (!alert) return res.status(404).json({ error: 'alert not found' });
  alert.status = 'taken';
  const nShares = shares ? +shares : 1;
  const tracker = new Tier3Tracker(alert, fill_price, fill_time || new Date().toISOString(), nShares, false);
  STATE.live_trades[alert_id] = {
    alert, fill_price: +fill_price, fill_time: fill_time || new Date().toISOString(),
    shares: nShares,
    tracker, last_bar_t: null, closed: false, last_status: { status: 'open' },
  };
  console.log(`[T3v7] TRACKING ${alert.symbol} ${alert.type} fill=${fill_price} shares=${nShares}`);
  saveStateNow();
  res.json({ ok: true, alert_id, fill_price, fill_time, shares: nShares });
});

// ── v8.0.2: Dismiss alert (BACKLOG #1) ─────────────────────────────────────
// Moves alert to history with status DISMISSED, starts shadow tracking
// (system keeps watching original entry/target/stop), releases stock.
// Both /v8/dismiss (legacy) and /v8/dismiss-alert (new) hit this handler.
function handleDismissAlert(req, res) {
  const { alert_id } = req.body || {};
  if (!alert_id) return res.status(400).json({ error: 'alert_id required' });
  const alert = STATE.alerts.find(a => a.alert_id === alert_id);
  if (!alert) {
    // Already dismissed or doesn't exist — still return ok for idempotency
    return res.json({ ok: true, note: 'alert not in active list (may already be dismissed)' });
  }
  const dismissedAt = new Date().toISOString();

  // 1. Remove from active alerts
  STATE.alerts = STATE.alerts.filter(a => a.alert_id !== alert_id);

  // 2. Add to history as DISMISSED entry (immediately, before shadow resolves)
  STATE.history.push({
    entry_type: 'DISMISSED',
    ...alert,
    dismissed_at: dismissedAt,
    status: 'dismissed',
  });

  // 3. Start shadow tracking — use alert.entry_price as the "fill" price,
  //    alert.bar_time (or now) as the start of tracking
  const shadowFillTime = alert.bar_time || dismissedAt;
  const tracker = new Tier3Tracker(alert, alert.entry_price, shadowFillTime, 1, true);
  STATE.shadow_trades[alert_id] = {
    alert,
    dismissed_at: dismissedAt,
    tracker,
    last_bar_t: null,
    closed: false,
    last_status: { status: 'open' },
  };

  // 4. Release stock so Tier 1 can find fresh pushes
  const pushId = alert.push_id || (alert.push && alert.push.push_id) || null;
  releaseStock(alert.symbol, pushId, 'user_dismissed');

  console.log(`[DISMISS] ${alert.symbol} ${alert.type} → shadow tracking started`);
  saveStateNow();
  res.json({ ok: true, alert_id, dismissed_at: dismissedAt, shadow_started: true });
}
app.post('/v8/dismiss', handleDismissAlert);          // legacy path preserved
app.post('/v8/dismiss-alert', handleDismissAlert);    // new explicit path

// ── v8.0.2: Manual exit live trade (BACKLOG #1) ───────────────────────────
// User clicks Exit on a live trade row, supplies fill_price (defaults to last
// known price) and fill_time (defaults to now). Trade closes, moves to history
// as REALIZED+manual_exit, releases stock.
app.post('/v8/manual-exit-trade', (req, res) => {
  const { trade_id, alert_id, fill_price, fill_time } = req.body || {};
  const id = trade_id || alert_id;
  if (!id) return res.status(400).json({ error: 'trade_id (or alert_id) required' });
  const lt = STATE.live_trades[id];
  if (!lt) return res.status(404).json({ error: 'live trade not found', id });
  if (lt.closed) return res.status(400).json({ error: 'trade already closed' });

  const exitPx = fill_price != null ? +fill_price : (lt.tracker.last_price || lt.fill_price);
  const exitTime = fill_time || new Date().toISOString();
  const r = lt.tracker._close('MANUAL_EXIT', exitPx, 'manual_exit', exitTime);
  lt.closed = true;
  lt.last_status = r;

  STATE.history.push({
    entry_type: 'REALIZED',
    ...lt.alert,
    ...r,
    fill_price: lt.fill_price,
    fill_time: lt.fill_time,
    closed_at: new Date().toISOString(),
  });

  const pushId = lt.alert.push_id || (lt.alert.push && lt.alert.push.push_id) || null;
  releaseStock(lt.alert.symbol, pushId, 'user_manual_exit');
  console.log(`[T3v7] MANUAL EXIT ${lt.alert.symbol} @ ${exitPx} R=${r.bars_held}b`);
  saveStateNow();
  res.json({ ok: true, trade_id: id, exit_price: exitPx, exit_time: exitTime, summary: r });
});

app.get('/v8/live-trades', (req, res) => {
  const lt = Object.entries(STATE.live_trades).map(([id, t]) => ({
    alert_id: id,
    symbol: t.alert.symbol,
    type: t.alert.type,
    dir: t.alert.dir,
    fill_price: t.fill_price,
    fill_time: t.fill_time,
    shares: t.shares || 1,
    entry_price: t.alert.entry_price,
    stop_price: t.alert.stop_price,
    target_price: t.alert.target_price,
    closed: t.closed,
    status: t.last_status,
  }));
  res.json({ live: lt.filter(l => !l.closed), closed: lt.filter(l => l.closed), history_count: STATE.history.length });
});

// v8.0.2: history now contains REALIZED + SHADOW + DISMISSED entries.
// Use ?type=REALIZED or ?type=SHADOW or ?type=DISMISSED to filter.
app.get('/v8/history', (req, res) => {
  const t = req.query.type;
  let h = [...STATE.history];
  if (t) h = h.filter(e => e.entry_type === t);
  // Totals
  const realized = STATE.history.filter(e => e.entry_type === 'REALIZED');
  const shadow = STATE.history.filter(e => e.entry_type === 'SHADOW');
  const dismissed = STATE.history.filter(e => e.entry_type === 'DISMISSED');
  const sumR = arr => arr.reduce((s, x) => {
    // R captured: if outcome present, use (exit-fill)/(entry-stop). Else 0.
    if (x.exit_price == null) return s;
    const isUp = (x.dir === 'up') || (x.direction === 'long');
    const fill = x.fill_price != null ? x.fill_price : x.entry_price;
    const stopDist = Math.abs(x.entry_price - x.stop_price);
    if (stopDist === 0) return s;
    const captured = isUp ? (x.exit_price - fill) / stopDist : (fill - x.exit_price) / stopDist;
    return s + captured;
  }, 0);
  res.json({
    history: h,
    totals: {
      realized_count: realized.length,
      realized_R: +sumR(realized).toFixed(3),
      shadow_count: shadow.length,
      shadow_R: +sumR(shadow).toFixed(3),
      dismissed_open: Object.values(STATE.shadow_trades).filter(t => !t.closed).length,
    },
  });
});

// v8.0.2: Shadow trades (dismissed alerts being tracked in background)
app.get('/v8/shadow-history', (req, res) => {
  const open = Object.entries(STATE.shadow_trades)
    .filter(([id, t]) => !t.closed)
    .map(([id, t]) => ({
      alert_id: id,
      symbol: t.alert.symbol,
      type: t.alert.type,
      dir: t.alert.dir,
      entry_price: t.alert.entry_price,
      stop_price: t.alert.stop_price,
      target_price: t.alert.target_price,
      dismissed_at: t.dismissed_at,
      bars_since: t.tracker ? t.tracker.bars_since_fill : 0,
      mfe: t.tracker ? +t.tracker.mfe.toFixed(2) : 0,
      mae: t.tracker ? +t.tracker.mae.toFixed(2) : 0,
      current_price: t.tracker ? t.tracker.last_price : null,
    }));
  const closed = STATE.history.filter(e => e.entry_type === 'SHADOW');
  res.json({ open, closed, open_count: open.length, closed_count: closed.length });
});

// v8.0.2 (BACKLOG #14, #16): Tier 3 notifications endpoint.
// Dashboard polls this, displays + sends to Telegram, then calls mark-read.
app.get('/v8/tier3-notifications', (req, res) => {
  const onlyUnread = req.query.unread === '1' || req.query.unread === 'true';
  const list = (STATE.tier3_notifications || []).filter(n => !onlyUnread || !n.read);
  res.json({ notifications: list, count: list.length });
});

app.post('/v8/tier3-notifications/mark-read', express.json(), (req, res) => {
  const { alert_id, type, time } = req.body || {};
  let updated = 0;
  (STATE.tier3_notifications || []).forEach(n => {
    if (n.read) return;
    if (alert_id && n.alert_id !== alert_id) return;
    if (type && n.type !== type) return;
    if (time && n.time !== time) return;
    n.read = true;
    updated++;
  });
  res.json({ ok: true, marked: updated });
});


// Returns per-trade unrealized R for both live and shadow, plus totals.
app.get('/v8/unrealized', (req, res) => {
  function unrealForTracker(t) {
    if (!t || !t.tracker) return { unreal_R: 0, current_price: null };
    const tr = t.tracker;
    const a = tr.alert;
    const isUp = a.dir === 'up';
    const fill = tr.fill_price;
    const last = tr.last_price != null ? tr.last_price : fill;
    const R = Math.abs(a.entry_price - (tr.original_stop || a.stop_price));
    if (R <= 0) return { unreal_R: 0, current_price: last };
    const m = isUp ? (last - fill) : (fill - last);
    return { unreal_R: +(m / R).toFixed(3), current_price: last };
  }
  function rowFor(id, t, kind) {
    const u = unrealForTracker(t);
    return {
      alert_id: id,
      kind,
      symbol: t.alert.symbol,
      type: t.alert.type,
      dir: t.alert.dir,
      entry_price: t.alert.entry_price,
      original_stop: t.tracker ? t.tracker.original_stop : t.alert.stop_price,
      current_stop: t.tracker ? +t.tracker.current_stop.toFixed(2) : t.alert.stop_price,
      target_price: t.alert.target_price,
      current_price: u.current_price,
      unrealized_R: u.unreal_R,
      mfe: t.tracker ? +t.tracker.mfe.toFixed(2) : 0,
      mae: t.tracker ? +t.tracker.mae.toFixed(2) : 0,
      bars_since: t.tracker ? t.tracker.bars_since_fill : 0,
      breakeven_active: t.tracker ? !!t.tracker.breakeven_active : false,
      breakeven_released: t.tracker ? !!t.tracker.breakeven_released : false,
      fill_time: t.fill_time || t.dismissed_at || null,
    };
  }
  const live = Object.entries(STATE.live_trades)
    .filter(([id, t]) => !t.closed)
    .map(([id, t]) => rowFor(id, t, 'LIVE'));
  const shadow = Object.entries(STATE.shadow_trades)
    .filter(([id, t]) => !t.closed)
    .map(([id, t]) => rowFor(id, t, 'SHADOW'));
  const liveTotal = live.reduce((s, r) => s + r.unrealized_R, 0);
  const shadowTotal = shadow.reduce((s, r) => s + r.unrealized_R, 0);
  res.json({
    live,
    shadow,
    totals: {
      live_count: live.length,
      live_unrealized_R: +liveTotal.toFixed(3),
      shadow_count: shadow.length,
      shadow_unrealized_R: +shadowTotal.toFixed(3),
      grand_unrealized_R: +(liveTotal + shadowTotal).toFixed(3),
    },
  });
});

// AUDIT LOG — every alert that ever fired or got skipped today (permanent, never deleted)
app.get('/v8/audit', (req, res) => {
  const filter = req.query.event;     // optional: 'FIRED' or 'SKIPPED'
  const symbol = req.query.symbol;    // optional: filter by stock
  const type = req.query.type;        // optional: 'H1' | 'RT+H1' | 'B' | 'COUNTER'
  let log = [...STATE.audit_log];
  if (filter) log = log.filter(e => e.event === filter);
  if (symbol) log = log.filter(e => e.symbol === symbol.toUpperCase());
  if (type) log = log.filter(e => e.type === type);
  // Summary stats
  const fired = STATE.audit_log.filter(e => e.event === 'FIRED');
  const skipped = STATE.audit_log.filter(e => e.event === 'SKIPPED');
  const byType = {};
  fired.forEach(e => byType[e.type] = (byType[e.type] || 0) + 1);
  res.json({
    summary: {
      total_fired: fired.length,
      total_skipped: skipped.length,
      by_type: byType,
    },
    log,
  });
});

app.get('/v8/status', (req, res) => {
  res.json({
    market_open: isMarketHours(),
    kite_ready: kiteReady(),
    tier1: { at: STATE.tier1_at, running: STATE.tier1_running, progress: STATE.tier1_progress },
    tier2: { at: STATE.tier2_at, running: STATE.tier2_running },
    tier3: { at: STATE.tier3_at },
    watchlist_count: Object.keys(STATE.watchlist).length,
    alerts_pending: STATE.alerts.filter(a => a.status === 'pending').length,
    live_trades: Object.values(STATE.live_trades).filter(t => !t.closed).length,
    shadow_trades: Object.values(STATE.shadow_trades).filter(t => !t.closed).length,
    blocked_pushes: STATE.blocked_pushes.size,
  });
});

// ── DIAGNOSTIC ENDPOINT — replay engine on a stock to debug recommendations
app.get('/v8/diagnose/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const candles = await fetchCandles(symbol);
    if (!candles || candles.length < 50) return res.status(404).json({ error: 'not enough bar data', symbol });
    const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const dayBars = candles.filter(b => b.t.slice(0, 10) === today);
    const filtered = dayBars.filter(b => b.t.slice(11, 16) >= '09:45');
    if (filtered.length < 6) return res.json({ symbol, message: 'insufficient today bars yet', today_bars: filtered.length });

    // Run streaming detector on today's bars
    const priorBars = candles.filter(b => b.t.slice(0, 10) !== today);
    const atr = priorBars.length > 14 ? computeATR(priorBars.slice(-75)) : computeATR(candles);
    const detector = new StreamingPushDetector(atr, ENG.MIN_BARS);
    const events = [];
    for (const bar of filtered) {
      const ev = detector.processBar(bar);
      if (ev) {
        const qp = eventToQualifyingPush(ev, atr, ENG.MIN_ATR_MULT, ENG.MIN_SLOPE_PCT, ENG.MIN_BARS);
        events.push({
          detected_at: filtered[ev.detected_at_idx].t.slice(11, 16),
          start_time: filtered[ev.start_idx].t.slice(11, 16),
          end_time: filtered[ev.end_idx].t.slice(11, 16),
          dir: ev.dir, bars: ev.bars,
          counter_indices: ev.counter_indices,
          qualifies: !!qp,
          qp: qp ? {
            push_id: qp.push_id, start_price: qp.start_price, end_price: qp.end_price,
            extreme: qp.extreme, net_move: qp.net_move, slope_mid: qp.slope_mid,
            move_atr_ratio: +(qp.net_move / atr).toFixed(2), strength: qp.strength,
          } : null,
        });
      }
    }

    // Watchlist + alerts status
    const inWatchlist = STATE.watchlist[symbol] || null;
    const stockAlerts = STATE.alerts.filter(a => a.symbol === symbol);
    const stockLive = Object.values(STATE.live_trades).filter(t => t.alert && t.alert.symbol === symbol);

    res.json({
      symbol, today, atr: +atr.toFixed(2),
      today_bars: filtered.length,
      detected_events: events,
      in_watchlist: inWatchlist ? {
        push_id: inWatchlist.push_id,
        push_dir: inWatchlist.push.dir,
        push_time: `${inWatchlist.push.start_time}→${inWatchlist.push.end_time}`,
        context_score: inWatchlist.context_score,
        added_at: inWatchlist.added_at,
        has_monitor: !!inWatchlist.monitor,
        monitor_state: inWatchlist.monitor ? {
          bar_count: inWatchlist.monitor.bar_count,
          counter_count: inWatchlist.monitor.counter_count,
          max_retrace: inWatchlist.monitor.max_retrace,
          h1_complete: inWatchlist.monitor.h1_complete,
          leg_bars: inWatchlist.monitor.leg_bars,
          state: inWatchlist.monitor.state,
        } : null,
      } : null,
      alerts: stockAlerts.map(a => ({
        alert_id: a.alert_id, type: a.type, dir: a.dir, score: a.score, final_score: a.final_score,
        entry_price: a.entry_price, stop_price: a.stop_price, target_price: a.target_price,
        push_time: `${a.push_start}→${a.push_end}`, fired_at: a.fired_at, status: a.status,
      })),
      live_trades: stockLive.map(t => ({
        fill_price: t.fill_price, shares: t.shares,
        status: t.last_status, closed: t.closed,
      })),
      last_5_bars: filtered.slice(-5).map(b => ({
        time: b.t.slice(11, 16),
        o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
        body_pct: +(Math.abs(b.c - b.o) / Math.max(b.h - b.l, 0.01)).toFixed(2),
      })),
    });
  } catch (e) {
    console.warn(`[diagnose] ${symbol}:`, e.message);
    res.status(500).json({ error: e.message, symbol });
  }
});

// Manual trigger for testing
app.post('/v8/run-tier1', async (req, res) => {
  runTier1v7();
  res.json({ ok: true, message: 'Tier 1 started in background' });
});
app.post('/v8/run-tier2', async (req, res) => {
  runTier2v7();
  res.json({ ok: true, message: 'Tier 2 started in background' });
});

// EOD reset (call manually after market close to clear blocked pushes for next day)
app.post('/v8/reset-day', (req, res) => {
  STATE.blocked_pushes.clear();
  STATE.alerts = [];
  STATE.watchlist = {};
  STATE.audit_log = [];      // fresh audit each trading day
  STATE.shadow_trades = {};  // v8.0.2: clear open shadow trackers
  // Keep live_trades and history
  saveStateNow();
  res.json({ ok: true });
});


app.get('/health', (req, res) => res.json({
  ok: true,
  uptime: Math.round(process.uptime()) + 's',
  time: new Date().toISOString(),
  kiteReady: kiteReady(),
  marketHours: isMarketHours(),
  engine: 'v8.0.2 — Tier2Monitor (new pullback engine, Nifty 100 universe, lifecycle release + shadow tracking + BE-window stop + leg-2 retrace gate)',
  alerts_pending: STATE.alerts.filter(a => a.status === 'pending').length,
  live_trades: Object.values(STATE.live_trades).filter(t => !t.closed).length,
  shadow_trades: Object.values(STATE.shadow_trades).filter(t => !t.closed).length,
  state_persisted: fs.existsSync(STATE_FILE),
  state_last_save: lastSaveAt ? new Date(lastSaveAt).toISOString() : null,
}));

app.get('/', (req, res) => res.json({
  name: 'Signal Server v8.0.2 — New Pullback Engine + Lifecycle Release Path',
  kite: { ready: kiteReady(), authenticatedAt: KITE.authenticatedAt },
  universe: NSE_UNIVERSE.length,
  endpoints: [
    '/v8/alerts', '/v8/watchlist', '/v8/live-trades', '/v8/history',
    '/v8/shadow-history', '/v8/unrealized', '/v8/tier3-notifications', '/v8/status',
    '/v8/track [POST]', '/v8/dismiss [POST]', '/v8/dismiss-alert [POST]',
    '/v8/manual-exit-trade [POST]',
    '/v8/run-tier1 [POST]', '/v8/run-tier2 [POST]', '/v8/reset-day [POST]',
    '/health', '/prices', '/candles/:symbol', '/kite/login',
  ],
  marketHours: isMarketHours(),
}));

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

// Used by Live Position Tracker to give Claude candle-level context
app.get('/candles/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const n = Math.min(parseInt(req.query.n||'20'), 40); // max 40 bars
  try{
    const candles = await fetchKite5Min(symbol);
    if(!candles || !candles.length){
      return res.status(404).json({ error: 'No candle data for '+symbol });
    }
    // Return last n candles with formatted time
    const recent = candles.slice(-n).map(c=>({
      t: c.t, o: +c.o.toFixed(2), h: +c.h.toFixed(2),
      l: +c.l.toFixed(2), c: +c.c.toFixed(2), v: c.v,
    }));
    const atr = computeATR(candles.slice(-20));
    res.json({ symbol, candles: recent, atr: +atr.toFixed(2), fetchedAt: new Date().toISOString() });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () =>
  console.log('Signal server v7.0 on port ' + PORT + ' — new engine (Tier2Monitor + 5 rules + Fix 1)')
);
