// netlify/functions/notify.js
const { GoogleAuth } = require('google-auth-library');
const https = require('https');

// ⚙️ Adatta questi due se usi un altro progetto / RTDB
const PROJECT_ID = 'fanta-wagner';
const RTDB_URL   = 'https://fanta-wagner-default-rtdb.europe-west1.firebasedatabase.app';

// ---------- Helpers credenziali / token Google ----------
function getServiceAccountFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT non impostata');

  try {
    return JSON.parse(raw);
  } catch {
    // supporto a var d'ambiente base64
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }
}

async function getAccessToken() {
  const sa = getServiceAccountFromEnv();
  const auth = new GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Impossibile ottenere access token FCM');
  return token;
}

// ---------- Lettura token device da Realtime Database ----------
function fetchAllTokensFromRTDB() {
  return new Promise((resolve, reject) => {
    https.get(`${RTDB_URL}/tokens.json`, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          const val = JSON.parse(String(data || 'null')) || {};
          // Struttura attesa: { key1: { token, user }, key2: { token, user }, ... }
          const tokens = Object.values(val)
            .map((x) => (x && x.token) || null)
            .filter(Boolean);
          resolve(tokens);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function fetchTokensByUser(name) {
  return new Promise((resolve, reject) => {
    https.get(`${RTDB_URL}/tokens.json`, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          const val = JSON.parse(String(data || 'null')) || {};
          const tokens = Object.values(val)
            .filter(
              (x) =>
                x &&
                x.user &&
                x.token &&
                String(x.user).trim() === String(name).trim()
            )
            .map((x) => x.token);
          resolve(tokens);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ---------- Costruzione messaggi ----------
function buildNotificationFromType(type, payload = {}) {
  switch (type) {
    case 'auction_open':
      return {
        title: 'Asta aperta',
        body: `${payload.player || 'Giocatore'}${payload.role ? ' (' + payload.role + ')' : ''}${payload.team ? ', ' + payload.team : ''}${payload.bid ? ' – base ' + payload.bid + ' crediti' : ''}`,
        link: '/',
      };
    case 'bid':
      return {
        title: 'Nuovo rilancio',
        body: `${payload.player || 'Giocatore'}: ${payload.bid || '?'} crediti${payload.bidder ? ' da ' + payload.bidder : ''}`,
        link: '/',
      };
    case 'assigned':
      return {
        title: 'Asta chiusa',
        body: `${payload.player || 'Giocatore'} a ${payload.winner || '?'} per ${payload.price || '?'} crediti`,
        link: '/',
      };
    default:
      return {
        title: 'FantAsta',
        body: 'Aggiornamento',
        link: '/',
      };
  }
}

// ---------- Invio a FCM v1 ----------
async function sendToToken(accessToken, token, notif) {
  const payload = {
    message: {
      token,
      webpush: {
        // La notifica viene renderizzata nativamente dal browser
        notification: {
          title: notif.title,
          body: notif.body,
          // opzionali, se vuoi aggiungerli in /public
          // icon: '/icons/icon-192.png',
          // badge: '/icons/badge-72.png',
        },
        fcm_options: {
          link: notif.link || '/',
        },
      },
    },
  };

  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request(
      {
        method: 'POST',
        host: 'fcm.googleapis.com',
        path: `/v1/projects/${PROJECT_ID}/messages:send`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': data.length,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true });
          } else {
            resolve({
              ok: false,
              error: `HTTP ${res.statusCode}: ${body}`,
            });
          }
        });
      }
    );

    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(data);
    req.end();
  });
}

// (facoltativo) log essenziale a console
async function logResult(token, ok, error) {
  if (ok) {
    console.log(`[FCM] ✔ inviato a token ${token.slice(0, 8)}...`);
  } else {
    console.warn(`[FCM] ✖ errore su token ${token.slice(0, 8)}... -> ${error}`);
  }
}

// ---------- CORS ----------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

// ---------- Handler Netlify ----------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: 'ok' };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    // Supporto 1: { type, payload, tokens?, targetUser? }
    // Supporto 2: { title, body, tokens?, targetUser? }

    // 1) Determina notifica
    let notif = null;
    if (body.type) {
      notif = buildNotificationFromType(body.type, body.payload || {});
    } else if (body.title && body.body) {
      notif = { title: body.title, body: body.body, link: body.link || '/' };
    }

    if (!notif) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: 'Payload non valido (manca type oppure title/body)',
      };
    }

    // 2) Determina destinatari
    let tokens = Array.isArray(body.tokens) ? body.tokens.filter(Boolean) : null;

    // 🌟 se c'è targetUser e non sono stati passati tokens espliciti
    if (!tokens && body.targetUser) {
      tokens = await fetchTokensByUser(body.targetUser);
    }

    // se ancora non abbiamo tokens, fallback a TUTTI
    if (!tokens || tokens.length === 0) {
      tokens = await fetchAllTokensFromRTDB();
    }

    if (!tokens || tokens.length === 0) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: 'Nessun token registrato',
      };
    }

    // 3) Invia
    const accessToken = await getAccessToken();
    const results = await Promise.all(
      tokens.map(async (t) => {
        const r = await sendToToken(accessToken, t, notif);
        await logResult(t, r.ok, r.error);
        return r;
      })
    );

    const ok = results.filter((r) => r.ok).length;
    const ko = results.length - ok;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: `Inviate: ${ok}, errori: ${ko}`,
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: 'ERR: ' + (e && e.message) || String(e),
    };
  }
};
