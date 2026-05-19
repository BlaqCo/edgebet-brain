
const http = require('http');

// ---- Scoring weights ----
const W = {
  momentum:    0.25,  // BTC price trend
  wallStrength: 0.25, // Orderbook wall signal
  liquidity:   0.15,  // How liquid the book is
  timeDecay:   0.15,  // How much time left (avoid last 60s)
  winRate:     0.20,  // Historical win rate for this pattern
};

// ---- Momentum scorer ----
// btcHistory: [{t, p}] array of recent prices
function scoreMomentum(btcHistory, side) {
  if (!btcHistory || btcHistory.length < 3) return 50;
  const now = Date.now();
  const prices60s = btcHistory.filter(x => now - x.t <= 60000).map(x => x.p);
  const prices30s = btcHistory.filter(x => now - x.t <= 30000).map(x => x.p);
  if (prices60s.length < 2) return 50;
  const oldest = prices60s[0];
  const newest = prices60s[prices60s.length - 1];
  const move60 = (newest - oldest) / oldest * 100;
  const move30 = prices30s.length >= 2
    ? (prices30s[prices30s.length-1] - prices30s[0]) / prices30s[0] * 100
    : move60;
  // Momentum score: does trend agree with our bet side?
  const agreesShort = side === 'yes' ? move30 > 0 : move30 < 0;
  const agreesLong  = side === 'yes' ? move60 > 0 : move60 < 0;
  const strength = Math.min(100, Math.abs(move60) * 500); // 0.02% move = 10 pts
  if (agreesShort && agreesLong)  return Math.min(95, 60 + strength);
  if (agreesShort && !agreesLong) return Math.min(70, 50 + strength * 0.5);
  if (!agreesShort && agreesLong) return Math.max(30, 50 - strength * 0.5);
  return Math.max(5, 40 - strength);
}

// ---- Orderbook wall scorer ----
// ob: { yes: [{price,qty}], no: [{price,qty}] }
// side: 'yes' or 'no'
function scoreWall(ob, side) {
  if (!ob || !ob.yes || !ob.no) return 50;
  const yesTotal = ob.yes.reduce((s, b) => s + b.qty, 0);
  const noTotal  = ob.no.reduce((s, b) => s + b.qty, 0);
  const total = yesTotal + noTotal;
  if (total === 0) return 50;
  // Liquidity imbalance - which side has more bids
  const yesPct = yesTotal / total;
  const imbalance = side === 'yes' ? yesPct : (1 - yesPct);
  // Find dominant wall
  const yesBig = ob.yes.reduce((a, b) => b.qty > a.qty ? b : a, {qty:0,price:0});
  const noBig  = ob.no.reduce((a, b)  => b.qty > a.qty ? b : a, {qty:0,price:0});
  const yesAvg = ob.yes.length > 0 ? yesTotal / ob.yes.length : 0;
  const noAvg  = ob.no.length  > 0 ? noTotal  / ob.no.length  : 0;
  const yesStr = yesAvg > 0 ? yesBig.qty / yesAvg : 0;
  const noStr  = noAvg  > 0 ? noBig.qty  / noAvg  : 0;
  const ourWallStr = side === 'yes' ? yesStr : noStr;
  const theirStr   = side === 'yes' ? noStr  : yesStr;
  // Score: imbalance (0-50) + wall dominance (0-50)
  const imbalanceScore = imbalance * 50;
  const wallScore = ourWallStr > theirStr
    ? Math.min(50, (ourWallStr - theirStr) * 10)
    : Math.max(0, 25 - (theirStr - ourWallStr) * 10);
  return Math.min(95, Math.max(5, imbalanceScore + wallScore));
}

// ---- Liquidity scorer ----
function scoreLiquidity(ob) {
  if (!ob) return 30;
  const total = [...(ob.yes||[]), ...(ob.no||[])].reduce((s, b) => s + b.qty, 0);
  if (total >= 200) return 90;
  if (total >= 100) return 75;
  if (total >= 50)  return 60;
  if (total >= 20)  return 45;
  if (total >= 5)   return 30;
  return 10; // too thin - likely won't fill
}

// ---- Time decay scorer ----
// closeTime: ISO string of market close
function scoreTimeDecay(closeTime) {
  if (!closeTime) return 50;
  const secsLeft = (new Date(closeTime).getTime() - Date.now()) / 1000;
  if (secsLeft <= 60)  return 5;  // last minute - skip
  if (secsLeft <= 120) return 20; // last 2 min - risky
  if (secsLeft <= 180) return 40; // last 3 min
  if (secsLeft <= 300) return 70; // last 5 min - sweet spot
  if (secsLeft <= 480) return 85; // 5-8 min left - good
  if (secsLeft <= 600) return 75; // 8-10 min
  return 55; // too early - less predictable
}

// ---- Historical win rate scorer ----
// history: array of settled bets
// side: 'yes' or 'no'
// prob: entry price
function scoreHistory(history, side, prob) {
  if (!history || history.length < 5) return 50;
  const settled = history.filter(b => b.result === 'won' || b.result === 'lost');
  if (settled.length < 5) return 50;
  // Find similar bets: same side, similar prob (within 0.10)
  const similar = settled.filter(b =>
    b.side === side &&
    Math.abs(b.prob - prob) <= 0.10
  );
  if (similar.length < 3) {
    // Fall back to overall win rate
    const wins = settled.filter(b => b.result === 'won').length;
    const wr = wins / settled.length;
    return Math.round(wr * 100);
  }
  const wins = similar.filter(b => b.result === 'won').length;
  const wr = wins / similar.length;
  // Boost score if sample is large
  const confidence = Math.min(1, similar.length / 20);
  return Math.round((wr * 0.7 + 0.5 * 0.3) * 100 * (0.5 + 0.5 * confidence) + 50 * (1 - confidence) * 0.5);
}

// ---- Master scorer ----
function score(payload) {
  const { side, prob, closeTime, btcHistory, orderbook, betHistory } = payload;
  if (!side || !prob) return { score: 0, reason: 'missing required fields' };
  const s = {
    momentum:    scoreMomentum(btcHistory, side),
    wall:        scoreWall(orderbook, side),
    liquidity:   scoreLiquidity(orderbook),
    timeDecay:   scoreTimeDecay(closeTime),
    winRate:     scoreHistory(betHistory, side, prob),
  };
  const total = Math.round(
    s.momentum   * W.momentum +
    s.wall       * W.wallStrength +
    s.liquidity  * W.liquidity +
    s.timeDecay  * W.timeDecay +
    s.winRate    * W.winRate
  );
  // Hard blocks regardless of score
  const secsLeft = closeTime ? (new Date(closeTime).getTime() - Date.now()) / 1000 : 999;
  if (secsLeft <= 60)  return { score: 0, reason: 'last_minute_block', breakdown: s };
  if (s.liquidity < 15) return { score: 0, reason: 'no_liquidity', breakdown: s };
  return { score: total, breakdown: s, secsLeft: Math.round(secsLeft) };
}

// ---- HTTP Server ----
const PORT = process.env.PORT || 4000;
http.createServer(function(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok', service: 'edgebet-brain' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/score') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const result = score(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, function() {
  console.log('[BRAIN] EdgeBet AI scorer running on port ' + PORT);
});
