// Copy Trader — servidor intermediário (sem dependências). Só repassa as entradas do professor aos alunos liberados.
// Quem vale como aluno liberado: chave do tipo "Copy Trader" gerada no painel de licenças (/admin).
// Variáveis de ambiente (Railway > Variables):
//   PROF_KEY      chave secreta do professor (só o painel dele publica)       [obrigatória]
//   LICENCA_URL   endereço do servidor de licenças (já vem preenchido)         [opcional]
//   ALUNO_KEYS    chaves de TESTE (separadas por vírgula), valem sem o painel  [opcional — deixe vazio quando for vender]
const http = require("http");
const crypto = require("crypto");
const PROF_KEY = (process.env.PROF_KEY || "").trim();
const ALUNOS_TESTE = new Set((process.env.ALUNO_KEYS || "").split(",").map(s => s.trim()).filter(Boolean));
const LICENCA_URL = (process.env.LICENCA_URL || "https://licenca-servidor-production-6a54.up.railway.app").trim().replace(/\/+$/, "");
const PORT = process.env.PORT || 3000;
const VALIDA_MS = 15000;      // uma chave aprovada vale 15 s sem perguntar de novo (bloqueio no painel corta em até ~35 s)
const RECUSA_MS = 8000;       // uma chave recusada não é perguntada de novo por 8 s
const GRACA_MS = 10 * 60000;  // se o servidor de licença cair, quem já estava liberado continua por até 10 min
const ONLINE_MS = 45000;      // aluno "conectado" = falou com o servidor nos últimos 45 s

let seq = 0; const events = []; const waiters = new Set(); const vistos = new Map();
const CACHE = new Map(), PENDENTE = new Map();
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const testeOk = k => { for (const a of ALUNOS_TESTE) if (eq(a, k)) return true; return false; };
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let b = ""; req.on("data", c => { b += c; if (b.length > 20000) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r(null); } }); });
const ipDe = req => { const x = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean); return x.length ? x[x.length - 1] : String(req.socket.remoteAddress || ""); };
const normChave = k => String(k || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").trim();

// pergunta ao servidor de licenças se a chave do Copy vale (e prende a chave ao computador do aluno)
async function perguntar(chave, hwid, aparelho, ip) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(LICENCA_URL + "/v1/copy/validar", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chave, hwid, aparelho, ip, sistema: "Copy Trader" }), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.status === 200 && j.ok) return { ok: true, nome: String(j.cliente || "Aluno"), id: "L" + j.id };
    if (r.status === 429 || r.status >= 500) return { ok: false, indisponivel: true, code: 503, erro: "Servidor de licença ocupado. Tentando de novo." };
    if (r.status === 404 && j.erro === "rota") return { ok: false, indisponivel: true, code: 503, erro: "Servidor de licença ainda não atualizado para o Copy Trader." };
    return { ok: false, code: r.status === 404 ? 401 : 403, erro: j.erro || "Chave não liberada." };
  } catch (_) { return { ok: false, indisponivel: true, code: 503, erro: "Sem resposta do servidor de licença. Tentando de novo." }; }
  finally { clearTimeout(t); }
}
// uma pergunta por vez para cada chave; guarda a resposta (só guarda se a licença respondeu de verdade)
function validar(ck, chave, hwid, aparelho, ip) {
  let p = PENDENTE.get(ck);
  if (!p) {
    p = perguntar(chave, hwid, aparelho, ip).then(v => { if (!v.indisponivel) CACHE.set(ck, { v, at: Date.now() }); return v; })
      .finally(() => PENDENTE.delete(ck));
    PENDENTE.set(ck, p);
  }
  return p;
}
// proteção contra quem fica chutando chaves: só conta quando a resposta NÃO estava guardada
const lim = new Map();
const limitaPergunta = (ip) => {
  const n = Date.now(); let e = lim.get(ip);
  if (!e || n - e.t > 60000) e = { t: n, n: 0 };
  e.n++; lim.set(ip, e);
  if (lim.size > 5000) for (const [k, v] of lim) if (n - v.t > 60000) lim.delete(k);
  return e.n <= 40;
};
// fresca = primeiro contato (aluno apertou "Liberar" / "Copiar"): confere de verdade na licença (guarda só 3 s),
// para o bloqueio e o desbloqueio feitos no painel valerem na hora. O acompanhamento do dia a dia (fresca = false) nunca espera a licença.
async function autorizar(req, fresca) {
  const raw = String(req.headers["x-aluno-key"] || "").trim();
  if (!raw) return { ok: false, code: 401, erro: "Digite a sua chave do Copy Trader." };
  if (testeOk(raw)) return { ok: true, nome: "(chave de teste)", id: "T" + raw.slice(0, 4) };
  const chave = normChave(raw), hwid = String(req.headers["x-hwid"] || "").toLowerCase().trim();
  if (!/^TS-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(chave)) return { ok: false, code: 401, erro: "Chave inválida." };
  if (!/^[a-f0-9]{64}$/.test(hwid)) return { ok: false, code: 400, erro: "Atualize o aplicativo do aluno (faltou a identificação do computador)." };
  const ck = chave + "|" + hwid, agora = Date.now(), c = CACHE.get(ck), idade = c ? agora - c.at : Infinity;
  const aparelho = String(req.headers["x-aparelho"] || "").slice(0, 60), ip = ipDe(req);
  if (fresca) {
    if (idade < 3000) return c.v;                                                    // acabou de conferir
  } else {
    if (c && idade < (c.v.ok ? VALIDA_MS : RECUSA_MS)) return c.v;                   // resposta recente: não pergunta de novo
    if (c && c.v.ok && idade < GRACA_MS) {                                           // aprovada há um tempo: responde na hora e confere por trás
      validar(ck, chave, hwid, aparelho, ip);                                        // (a entrada do professor nunca espera a licença)
      return c.v;
    }
  }
  if (!limitaPergunta(ip)) return { ok: false, code: 429, erro: "Muitas tentativas. Aguarde 1 minuto." };
  return await validar(ck, chave, hwid, aparelho, ip);                               // desconhecida / primeiro contato: espera a licença responder
}
const online = () => [...vistos.values()].filter(x => Date.now() - x.t < ONLINE_MS);
setInterval(() => {
  const n = Date.now();
  for (const [k, c] of CACHE) if (n - c.at > GRACA_MS) CACHE.delete(k);
  for (const [k, x] of vistos) if (n - x.t > 24 * 3600 * 1000) vistos.delete(k);
}, 60000).unref();

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/health") return send(res, 200, { ok: true, last: seq, alunos_online: online().length });
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
    // lista dos alunos conectados agora (só o professor vê)
    if (u.pathname === "/alunos" && req.method === "GET") {
      if (!PROF_KEY || !eq(req.headers["x-prof-key"] || "", PROF_KEY)) return send(res, 401, { ok: false });
      const o = online().sort((a, b) => b.t - a.t);
      return send(res, 200, { ok: true, total: o.length, alunos: o.map(x => ({ nome: x.nome, ha_s: Math.round((Date.now() - x.t) / 1000), desde_s: Math.round((Date.now() - x.desde) / 1000) })) });
    }
    if (u.pathname === "/events") {
      const sp = u.searchParams.get("since"); const since = parseInt(sp || "0", 10) || 0;
      const a = await autorizar(req, sp === null);
      if (!a.ok) return send(res, a.code, { ok: false, erro: a.erro });
      const v = vistos.get(a.id) || { nome: a.nome, desde: Date.now(), t: 0 }; v.nome = a.nome; v.t = Date.now(); vistos.set(a.id, v);
      const pega = () => events.filter(e => e.seq > since);
      // primeiro contato do aluno (sem 'since'): só devolve o ponto atual, para NÃO copiar entradas antigas
      if (sp === null) return send(res, 200, { ok: true, last: seq, events: [] });
      const now = pega(); if (now.length) return send(res, 200, { ok: true, last: seq, events: now });
      let fim = false;
      const done = () => { if (fim) return; fim = true; clearTimeout(t); waiters.delete(done); v.t = Date.now(); send(res, 200, { ok: true, last: seq, events: pega() }); };
      const t = setTimeout(done, 20000); waiters.add(done); req.on("close", () => { fim = true; clearTimeout(t); waiters.delete(done); });
      return;
    }
    send(res, 404, { ok: false });
  } catch (e) { try { send(res, 500, { ok: false }); } catch (_) {} }
}).listen(PORT, () => console.log("copy-trader-servidor na porta " + PORT + " • licenças em " + LICENCA_URL));
