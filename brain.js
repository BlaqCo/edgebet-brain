const http = require('http');

// ---- Scoring weights ----
const W = {
  momentum:     0.25,
  wallStrength: 0.25,
  liquidity:    0.15,
  timeDecay:    0.15,
  winRate:      0.20,
};

function scoreMomentum(btcHistory, side) {
  if (!btcHistory || btcHistory.length < 3) return 50;
  const now = Date.now();
  const p60 = btcHistory.filter(x => now - x.t <= 60000).map(x => x.p);
  const p30 = btcHistory.filter(x => now - x.t <= 30000).map(x => x.p);
  if (p60.length < 2) return 50;
  const move60 = (p60[p60.length-1] - p60[0]) / p60[0] * 100;
  const move30 = p30.length >= 2 ? (p30[p30.length-1] - p30[0]) / p30[0] * 100 : move60;
  const agreesShort = side === 'yes' ? move30 > 0 : move30 < 0;
  const agreesLong  = side === 'yes' ? move60 > 0 : move60 < 0;
  const strength = Math.min(100, Math.abs(move60) * 500);
  if (agreesShort && agreesLong)  return Math.min(95, 60 + strength);
  if (agreesShort && !agreesLong) return Math.min(70, 50 + strength * 0.5);
  if (!agreesShort && agreesLong) return Math.max(30, 50 - strength * 0.5);
  return Math.max(5, 40 - strength);
}

function scoreWall(ob, side) {
  if (!ob || !ob.yes || !ob.no) return 50;
  const yesTotal = ob.yes.reduce((s, b) => s + b.qty, 0);
  const noTotal  = ob.no.reduce((s, b) => s + b.qty, 0);
  const total = yesTotal + noTotal;
  if (total === 0) return 50;
  const yesPct = yesTotal / total;
  const imbalance = side === 'yes' ? yesPct : (1 - yesPct);
  const yesBig = ob.yes.reduce((a, b) => b.qty > a.qty ? b : a, {qty:0,price:0});
  const noBig  = ob.no.reduce((a, b) => b.qty > a.qty ? b : a, {qty:0,price:0});
  const yesAvg = ob.yes.length > 0 ? yesTotal / ob.yes.length : 0;
  const noAvg  = ob.no.length  > 0 ? noTotal  / ob.no.length  : 0;
  const yesStr = yesAvg > 0 ? yesBig.qty / yesAvg : 0;
  const noStr  = noAvg  > 0 ? noBig.qty  / noAvg  : 0;
  const ourStr   = side === 'yes' ? yesStr : noStr;
  const theirStr = side === 'yes' ? noStr  : yesStr;
  const imbalanceScore = imbalance * 50;
  const wallScore = ourStr > theirStr
    ? Math.min(50, (ourStr - theirStr) * 10)
    : Math.max(0, 25 - (theirStr - ourStr) * 10);
  return Math.min(95, Math.max(5, imbalanceScore + wallScore));
}

function scoreLiquidity(ob) {
  if (!ob) return 30;
  const total = [...(ob.yes||[]), ...(ob.no||[])].reduce((s, b) => s + b.qty, 0);
  if (total >= 200) return 90;
  if (total >= 100) return 75;
  if (total >= 50)  return 60;
  if (total >= 20)  return 45;
  if (total >= 5)   return 30;
  return 10;
}

function scoreTimeDecay(closeTime) {
  if (!closeTime) return 50;
  const secsLeft = (new Date(closeTime).getTime() - Date.now()) / 1000;
  if (secsLeft <= 60)  return 5;
  if (secsLeft <= 120) return 20;
  if (secsLeft <= 180) return 40;
  if (secsLeft <= 300) return 70;
  if (secsLeft <= 480) return 85;
  if (secsLeft <= 600) return 75;
  return 55;
}

function scoreHistory(history, side, prob) {
  if (!history || history.length < 5) return 50;
  const settled = history.filter(b => b.result === 'won' || b.result === 'lost');
  if (settled.length < 5) return 50;
  const similar = settled.filter(b => b.side === side && Math.abs(b.prob - prob) <= 0.10);
  if (similar.length < 3) {
    const wins = settled.filter(b => b.result === 'won').length;
    return Math.round((wins / settled.length) * 100);
  }
  const wins = similar.filter(b => b.result === 'won').length;
  const wr = wins / similar.length;
  const confidence = Math.min(1, similar.length / 20);
  return Math.round((wr * 0.7 + 0.5 * 0.3) * 100 * (0.5 + 0.5 * confidence) + 50 * (1 - confidence) * 0.5);
}

function score(payload) {
  const { side, prob, closeTime, btcHistory, orderbook, betHistory } = payload;
  if (!side || !prob) return { score: 0, reason: 'missing fields' };
  const secsLeft = closeTime ? (new Date(closeTime).getTime() - Date.now()) / 1000 : 999;
  if (secsLeft <= 60) return { score: 0, reason: 'last_minute_block' };
  const s = {
    momentum:  scoreMomentum(btcHistory, side),
    wall:      scoreWall(orderbook, side),
    liquidity: scoreLiquidity(orderbook),
    timeDecay: scoreTimeDecay(closeTime),
    winRate:   scoreHistory(betHistory, side, prob),
  };
  if (s.liquidity < 15) return { score: 0, reason: 'no_liquidity', breakdown: s };
  const total = Math.round(
    s.momentum   * W.momentum +
    s.wall       * W.wallStrength +
    s.liquidity  * W.liquidity +
    s.timeDecay  * W.timeDecay +
    s.winRate    * W.winRate
  );
  return { score: total, breakdown: s, secsLeft: Math.round(secsLeft) };
}

const PORT = process.env.PORT || 4000;

http.createServer(function(req, res) {
  // Health check - handles both / and /health for Railway
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'edgebet-brain', port: PORT }));
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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
}).listen(PORT, function() {
  console.log('[BRAIN] EdgeBet AI scorer running on port ' + PORT);
});
