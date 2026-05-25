// ══════════════════════════════════════════════════════════════════
//  Vitavix CRM — Netlify Function: lead-webhook
//  Recebe leads do Make (Meta Ads) e distribui pela roleta automática
// ══════════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hslskaocwddphucdinaq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzbHNrYW9jd2RkcGh1Y2RpbmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MjkyMDIsImV4cCI6MjA5MTQwNTIwMn0.WR8TerjTBbfIxZYnrL7MWTcbzyHyHcevxTBcwC4CteA';
const WEBHOOK_TOKEN = 'vitavix_webhook_2026';

// ── Helper: chamar a API do Supabase ──
async function supabase(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ── Pegar próximo corretor da roleta ──
async function proximoCorretor() {
  const r = await supabase('GET', 'lead_roulette?limit=1');
  if (!r.ok || !r.data || r.data.length === 0) return null;

  const row = r.data[0];
  const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
  if (!cfg || !cfg.corretores || cfg.corretores.length === 0) return null;

  const ativos = cfg.corretores.filter(c => c.ativo);
  if (ativos.length === 0) return null;

  let corretor;
  const modo = cfg.modo || 'igual';

  if (modo === 'peso') {
    // Distribuição por peso
    const total = ativos.reduce((s, c) => s + (Number(c.peso) || 1), 0);
    let rand = Math.random() * total;
    for (const c of ativos) {
      rand -= (Number(c.peso) || 1);
      if (rand <= 0) { corretor = c.nome; break; }
    }
    if (!corretor) corretor = ativos[0].nome;
  } else {
    // Distribuição igualitária (round-robin)
    const idx = (cfg.contadorAtual || 0) % ativos.length;
    corretor = ativos[idx].nome;
    cfg.contadorAtual = (idx + 1) % ativos.length;
  }

  // Atualizar contador no banco
  await supabase('PATCH', `lead_roulette?id=eq.${row.id}`, {
    config: JSON.stringify(cfg)
  });

  return corretor;
}

// ══════════════════════════════════════════════════════════════════
//  Handler principal
// ══════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Só aceita POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ erro: 'Método não permitido. Use POST.' }) };
  }

  // ── Verificar token de segurança ──
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const tokenQuery = event.queryStringParameters?.token || '';
  const tokenRecebido = authHeader.replace('Bearer ', '').trim() || tokenQuery;

  if (tokenRecebido !== WEBHOOK_TOKEN) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ erro: 'Token inválido. Acesso negado.' })
    };
  }

  // ── Parsear body ──
  let dados;
  try {
    dados = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ erro: 'JSON inválido no body.' }) };
  }

  // ── Validar campos obrigatórios ──
  const nome = (dados.nome || dados.full_name || dados.name || '').trim();
  const tel  = (dados.tel || dados.telefone || dados.phone || dados.phone_number || '').trim();

  if (!nome) {
    return { statusCode: 400, headers, body: JSON.stringify({ erro: 'Campo "nome" é obrigatório.' }) };
  }

  // ── Definir origem ──
  const origem = dados.origem || dados.campanha || dados.campaign || 'Ads - Meta';

  // ── Pegar corretor pela roleta ──
  const corretor = await proximoCorretor();

  // ── Inserir lead na tabela clients ──
  const lead = {
    nome,
    tel:       tel || '',
    email:     (dados.email || '').trim(),
    origem,
    corretor:  corretor || '',
    etapa:     'Em Contato',
    obs:       dados.obs || dados.observacao || '',
    operadora: '',
    plano:     dados.plano || '',
    valor:     null,
    modalidade:'',
    empresa:   dados.empresa || '',
    created_at: new Date().toISOString(),
  };

  const insert = await supabase('POST', 'clients', lead);

  if (!insert.ok) {
    console.error('Erro ao inserir lead:', insert.data);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ erro: 'Erro ao salvar lead no banco.', detalhe: insert.data })
    };
  }

  // ── Registrar no histórico ──
  try {
    await supabase('POST', 'historico', {
      tipo: 'lead_ads',
      descricao: `Lead "${nome}" recebido via ${origem} e atribuído a ${corretor || 'sem corretor'}`,
      cliente: nome,
      corretor: corretor || '',
      date: new Date().toLocaleDateString('pt-BR'),
    });
  } catch (e) { console.warn('Histórico não salvo:', e); }

  // ── Resposta de sucesso ──
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      sucesso: true,
      mensagem: `Lead "${nome}" registrado e atribuído a ${corretor || 'sem corretor'}.`,
      corretor: corretor || null,
      origem,
    })
  };
};
