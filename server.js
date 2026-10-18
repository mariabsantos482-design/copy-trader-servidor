// Copy Trader — servidor intermediário (sem dependências). Só repassa as entradas do professor aos alunos liberados.
// Variáveis de ambiente (Railway > Variables):
//   PROF_KEY   chave secreta do professor (só o painel dele publica)
//   ALUNO_KEYS chaves dos alunos liberados, separadas por vírgula
const http = require("http");
const crypto = require("crypto");
const PROF_KEY = process.env.PROF_KEY || "";
const ALUNOS = new Set((process.env.ALUNO_KEYS || "").split(",").map(s => s.trim()).filter(Boolean));
const PORT = process.env.PORT || 3000;
let seq = 0; const events = []; const waiters = new Set(); const vistos = new Map();
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isAluno = k => { for (const a of ALUNOS) if (eq(a, k)) return true; return false; };
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let b = ""; req.on("data", c => { b += c; if (b.length > 20000) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r(null); } }); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health") return send(res, 200, { ok: true, last: seq, alunos_online: vistos.size });
  if (u.pathname === "/publish" && req.method === "POST") {
    if (!PROF_KEY || !eq(req.headers["x-prof-key"] || "", PROF_KEY)) return send(res, 401, { ok: false });
    const d = await body(req); if (!d) return send(res, 400, { ok: false });
    const dir = d.direction === "put" ? "put" : d.direction === "call" ? "call" : null;
    if (!d.asset || !dir) return send(res, 400, { ok: false, error: "ordem inválida" });
    const ev = { seq: ++seq, time: Date.now() / 1000, order_id: d.order_id, asset: String(d.asset).slice(0, 40), direction: dir,
      amount: Number(d.amount) || 0, expiration: Number(d.expiration) || 1, gale_level: Number(d.gale_level) || 0, strategy: d.strategy || null };
    events.push(ev); events.splice(0, events.length - 200);
    for (const w of [...waiters]) w();
    return send(res, 200, { ok: true, seq });
  }
  if (u.pathname === "/events") {
    const k = req.headers["x-aluno-key"] || "";
    if (!isAluno(k)) return send(res, 401, { ok: false });
    vistos.set(k.slice(0, 6), Date.now());
    const sp = u.searchParams.get("since"); const since = parseInt(sp || "0", 10) || 0;
    const pega = () => events.filter(e => e.seq > since);
    // primeiro contato do aluno (sem 'since'): só devolve o ponto atual, para NÃO copiar entradas antigas
    if (sp === null) return send(res, 200, { ok: true, last: seq, events: [] });
    const now = pega(); if (now.length) return send(res, 200, { ok: true, last: seq, events: now });
    let fim = false;
    const done = () => { if (fim) return; fim = true; clearTimeout(t); waiters.delete(done); send(res, 200, { ok: true, last: seq, events: pega() }); };
    const t = setTimeout(done, 20000); waiters.add(done); req.on("close", () => { fim = true; clearTimeout(t); waiters.delete(done); });
    return;
  }
  send(res, 404, { ok: false });
}).listen(PORT, () => console.log("copy-trader-servidor na porta " + PORT));
