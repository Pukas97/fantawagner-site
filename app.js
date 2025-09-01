// Banner
(function(){
  var bs = document.getElementById('bootStatus');
  if (bs) bs.textContent = 'HTML caricato — avvio JS…';
})();

// Debug helper
function debug(msg){
  try {
    var box = document.getElementById('debugBox');
    if (!box) return;
    var line = document.createElement('div');
    line.textContent = msg;
    box.appendChild(line);
    console.log('[ASTA]', msg);
  } catch(e){}
}

// === Firebase
var firebaseConfig = {
  apiKey: "AIzaSyBoMl0n8V1qk6hYB7HtPBmQy8JY1OxnGec",
  authDomain: "fanta-wagner.firebaseapp.com",
  databaseURL: "https://fanta-wagner-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "fanta-wagner",
  storageBucket: "fanta-wagner.firebasestorage.app",
  messagingSenderId: "97053268763",
  appId: "1:97053268763:web:95ec2acd4f41b65a9091be",
  measurementId: "G-Y0BB797KJG"
};
firebase.initializeApp(firebaseConfig);
debug('firebase init ok');
const db = firebase.database();

// ping
db.ref('__ping').set(Date.now()).then(()=>debug('rtdb write: ok')).catch(err=>debug('rtdb write ERROR: ' + (err && err.message || String(err))));

// Refs
const auctionsRef     = db.ref('auctions');
const assignmentsRef  = db.ref('assignments');
const participantsRef = db.ref('participants');
const settingsRef     = db.ref('settings');
const timerMinutesRef = db.ref('settings/timerMinutes');
const extendSecondsRef= db.ref('settings/extendSeconds');

const START_BUDGET = 500;

// Stato
var rows = [];
var headers = [];
var filterValue = '';
var participants = {};
var assignmentsCache = [];
var auctionsCache = {}; // key -> auction
var openPlayersSet = new Set();
var closedPlayersSet = new Set();
var expiredHandled = new Set(); // per evitare doppie chiusure

// Impostazioni locali (default)
var timerMinutes = 2;   // durata nuove aste
var extendSeconds = 15; // estensione sotto 60s

function el(id){ return document.getElementById(id); }
function toNumber(v){ var n = Number(String(v||'').replace(/[^0-9.-]/g,'')); return isNaN(n)?0:n; }
function norm(s){ return String(s||'').trim().toLowerCase(); }
function now(){ return Date.now(); }
function fmtMMSS(ms){
  if (ms < 0) ms = 0;
  var s = Math.floor(ms/1000);
  var m = Math.floor(s/60);
  var r = s % 60;
  return (m<10?'0':'')+m+':'+(r<10?'0':'')+r;
}

// === SETTINGS (sync UI <-> RTDB)
function bindSettingsUI(){
  var minInput = el('timerMinutes');
  var extInput = el('extendSeconds');

  timerMinutesRef.on('value', function(s){
    var v = Number(s.val());
    if (!isNaN(v) && v>0) { timerMinutes = v; if (minInput) minInput.value = v; }
  });
  extendSecondsRef.on('value', function(s){
    var v = Number(s.val());
    if (!isNaN(v) && v>=0) { extendSeconds = v; if (extInput) extInput.value = v; }
  });

  if (minInput) {
    minInput.addEventListener('change', function(){
      var v = Math.max(1, parseInt(minInput.value||timerMinutes, 10));
      timerMinutesRef.set(v);
    });
  }
  if (extInput) {
    extInput.addEventListener('change', function(){
      var v = Math.max(0, parseInt(extInput.value||extendSeconds, 10));
      extendSecondsRef.set(v);
    });
  }

  settingsRef.once('value').then(function(s){
    var val = s.val()||{};
    if (typeof val.timerMinutes === 'undefined') timerMinutesRef.set(timerMinutes);
    if (typeof val.extendSeconds === 'undefined') extendSecondsRef.set(extendSeconds);
  });
}

// === CSV
async function loadCSV(){
  var status = el('csvStatus');
  try{
    if (status) status.textContent = 'Cerco listone.csv…';
    var url = 'listone.csv?v=' + Date.now();
    var res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) { if (status) status.textContent = 'Errore CSV: HTTP ' + res.status; throw new Error('HTTP '+res.status); }
    var text = await res.text();
    parseCSV(text);
    if (status) status.innerHTML = '<span class="pill">'+rows.length+'</span> giocatori caricati';
    renderTable();
  }catch(e){
    if (status) status.textContent = 'listone.csv non trovato o errore di parsing';
    debug('CSV ERROR: ' + (e && e.message ? e.message : String(e)));
  }
}
window.loadCSV = loadCSV;

function parseCSV(text){
  if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
  var sep = ',';
  if (text.indexOf('\t')>-1 && text.indexOf(';')===-1 && text.indexOf(',')===-1) sep='\t';
  else if (text.indexOf(';')>-1 && text.indexOf(',')===-1) sep=';';
  var lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return;

  headers = lines[0].split(sep).map(function(h){ return h.trim(); });
  rows = lines.slice(1).map(function(line){
    var cols = line.split(sep);
    var obj = {}; headers.forEach(function(h,i){ obj[h] = (cols[i]||'').trim(); });
    return obj;
  });
}

function getField(obj, names){
  var map = {}; Object.keys(obj||{}).forEach(function(k){ map[norm(k)] = obj[k]; });
  for (var i=0;i<names.length;i++){ var k = norm(names[i]); if (k in map) return map[k]; }
  var vals = Object.values(obj||{}); return vals.length? vals[0]:'';
}
function isLockedPlayer(name){
  const n = norm(name);
  return openPlayersSet.has(n) || closedPlayersSet.has(n);
}

function renderTable(){
  var tbody = el('tbodyList'); if (!tbody) return; tbody.innerHTML='';
  var q = norm(filterValue);
  var filtered = rows.filter(function(r){ return norm(JSON.stringify(r)).includes(q); });
  if (!filtered.length){
    var tr0 = document.createElement('tr');
    tr0.innerHTML = '<td colspan="5" class="muted">Nessun giocatore trovato</td>';
    tbody.appendChild(tr0);
    return;
  }
  filtered.forEach(function(r, idx){
    var tr = document.createElement('tr');
    var nome = getField(r, ['Nome','Giocatore','Player']);
    var ruolo = getField(r, ['Ruolo','R','Role']);
    var squadra = getField(r, ['Squadra','Team','Club']);
    var quota = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);
    var disabled = isLockedPlayer(nome);
    var label = disabled ? 'In asta' : 'Metti all’asta';
    var btn = disabled
      ? '<button class="btn sm" disabled>'+label+'</button>'
      : '<button class="btn primary sm" data-idx="'+idx+'">'+label+'</button>';
    tr.innerHTML =
      '<td>'+nome+'</td>'+
      '<td class="nowrap">'+ruolo+'</td>'+
      '<td>'+squadra+'</td>'+
      '<td class="nowrap">'+quota+'</td>'+
      '<td class="nowrap">'+btn+'</td>';
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-idx]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      var i = Number(e.currentTarget.getAttribute('data-idx'));
      var r = rows[i];
      startAuctionFromRow(r);
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'In asta';
      e.currentTarget.classList.remove('primary');
    });
  });
}

// === Aste
function startAuctionFromRow(r){
  var player = getField(r, ['Nome','Giocatore','Player']);
  var role   = getField(r, ['Ruolo','R','Role']);
  var team   = getField(r, ['Squadra','Team','Club']);
  var quota  = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);
  var startBid = toNumber(quota);
  if (isLockedPlayer(player)) return;

  // 👇 nome di chi apre (nuovo)
  var me = (document.getElementById('myName') && document.getElementById('myName').value.trim()) || 'Anonimo';

  var endAt = now() + Math.max(1, parseInt(timerMinutes,10)||1) * 60000;

  auctionsRef.push({
    player: player,
    role: role,
    team: team,
    bid: startBid,
    lastBidder: '',
    status: 'open',
    createdAt: now(),
    endAt: endAt,
    openedBy: me // 👈 nuovo
  }, function(err){
    if (err) { debug('create auction ERROR: ' + err.message); }
  });
}

// Bids
window.raiseBid = function(key, amount){
  var me = el('myName').value.trim() || 'Anonimo';
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;
  var next = toNumber(a.bid) + amount;

  // Estensione sotto 60s
  var endAt = a.endAt || (a.createdAt ? a.createdAt + timerMinutes*60000 : now()+timerMinutes*60000);
  var remain = endAt - now();
  var patch = { bid: next, lastBidder: me };
  if (remain <= 60000 && extendSeconds > 0) {
    patch.endAt = endAt + (extendSeconds*1000);
  }
  db.ref('auctions/'+key).update(patch);
};

window.customBid = function(key){
  var me = el('myName').value.trim() || 'Anonimo';
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;

  var inp = el('manualBid-'+key); if (!inp) return;
  var v = Math.max(0, parseInt(inp.value||0, 10));
  if (v <= Number(a.bid||0)) { alert('Offerta deve essere maggiore di quella attuale.'); return; }

  var endAt = a.endAt || (a.createdAt ? a.createdAt + timerMinutes*60000 : now()+timerMinutes*60000);
  var remain = endAt - now();
  var patch = { bid: v, lastBidder: me };
  if (remain <= 60000 && extendSeconds > 0) {
    patch.endAt = endAt + (extendSeconds*1000);
  }
  db.ref('auctions/'+key).update(patch).then(function(){
    inp.value = '';
  });
};

// ⏱️ Chiudi e (se c'è un vincitore) assegna l'asta
function handleExpiry(key, a){
  a = a || auctionsCache[key];
  if (!a) return;
  if (expiredHandled.has(key)) return;
  expiredHandled.add(key);

  var price  = Number(a.bid || 0);
  var winner = a.lastBidder || '';

  // chiudi l'asta
  db.ref('auctions/' + key + '/status').set('closed')
    .then(function(){
      // se c'è un vincitore valido, registra l'assegnazione
      if (price > 0 && winner){
        return assignmentsRef.push({
          player: a.player,
          role: a.role,
          team: a.team,
          price: price,
          winner: winner,
          at: now()
        });
      }
    })
    .finally(function(){
      // aggiorna UI locale
      renderAuctions();
      renderTable();
    })
    .catch(function(err){
      debug('handleExpiry ERROR: ' + (err && err.message || String(err)));
    });
}

// 🖐️ Assegnazione manuale (bottone "Chiudi e assegna")
window.assignAuction = function(key){
  var a = auctionsCache[key];
  if (!a || a.status !== 'open') return;
  if (!confirm('Chiudere e assegnare questa asta?')) return;
  handleExpiry(key, a);
};

// 🧹 Reset TOTALE (aste, assegnazioni, partecipanti, tokens)
window.resetEverything = function () {
  if (!confirm('⚠️ RESET TOTALE: cancella aste, assegnazioni e partecipanti. Confermi?')) return;

  var updates = { auctions: null, assignments: null, participants: null, tokens: null };

  db.ref().update(updates).then(function () {
    auctionsCache = {};
    assignmentsCache = [];
    participants = {};
    openPlayersSet.clear();
    closedPlayersSet.clear();
    expiredHandled.clear();

    var closed = document.getElementById('closedBox'); if (closed) closed.innerHTML = '';
    var list   = document.getElementById('auctionsList'); if (list) list.innerHTML = '';
    var left   = document.querySelector('#tbodyList'); if (left) left.innerHTML = '';
    var parts  = document.querySelector('#participants'); if (parts) parts.innerHTML = '';

    alert('Reset completato.');
  }).catch(function (err) {
    alert('Reset fallito: ' + (err && err.message || String(err)));
  });
};

// Render aste (SOLO aperte nel riquadro) + timer label
function renderAuctions(){
  var box = el('auctionsList');
  if (!box) return;
  box.innerHTML = '';
  var keys = Object.keys(auctionsCache);

  // aggiorna set per bloccare bottoni nel listone
  const all = keys.map(k => auctionsCache[k]).filter(Boolean);
  openPlayersSet   = new Set(all.filter(a => a.status === 'open')  .map(a => norm(a.player)));
  closedPlayersSet = new Set(all.filter(a => a.status === 'closed').map(a => norm(a.player)));

  // FILTRO: mostra solo open
  var openKeys = keys.filter(function(k){ return auctionsCache[k] && auctionsCache[k].status === 'open'; });

  if (!openKeys.length){
    var empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Nessuna asta attiva. Aprine una dal listone a destra.';
    box.appendChild(empty);
  } else {
    openKeys.sort(function(a,b){
      var A=auctionsCache[a], B=auctionsCache[b];
      return (A.createdAt||0) - (B.createdAt||0);
    });
    openKeys.forEach(function(key){
      var a = auctionsCache[key];

      // Assicurati endAt
      if (!a.endAt) {
        var fallback = (a.createdAt || now()) + Math.max(1, parseInt(timerMinutes,10)||1)*60000;
        db.ref('auctions/'+key+'/endAt').set(fallback);
        a.endAt = fallback;
      }

      var card = document.createElement('div');
      card.className = 'auction-card';

      var controls =
        `<div class="grid-3" style="margin-top:8px;">
          <button class="btn sm" onclick="raiseBid('${key}',1)">+1</button>
          <button class="btn sm" onclick="raiseBid('${key}',5)">+5</button>
          <button class="btn sm" onclick="raiseBid('${key}',10)">+10</button>
        </div>
        <div class="row" style="margin-top:8px;">
          <input id="manualBid-${key}" type="number" min="0" step="1" placeholder="Offerta manuale" />
          <button class="btn sm" onclick="customBid('${key}')">Offri</button>
          <span></span>
        </div>
        <div class="row" style="margin-top:8px;">
          <button class="btn warn sm" onclick="assignAuction('${key}')">Chiudi e assegna</button>
          <span></span>
        </div>`;

      // Timer placeholder
      var remain = (a.endAt||0) - now();
      var cls = remain <= 10000 ? 'timer danger' : (remain <= 60000 ? 'timer warn' : 'timer');
      var timerSpan = `<span id="timer-${key}" class="${cls}">${fmtMMSS(remain)}</span>`;

      card.innerHTML =
        `<div><strong>${a.player}</strong> <span class="muted">(${a.role||'—'}, ${a.team||''})</span> • ${timerSpan}</div>
         <div class="price">${a.bid||0}</div>
         <div class="opened-by">Aperta da: <span class="who">${a.openedBy||'—'}</span></div>
         <div class="last-bidder">Ultimo rilancio: <span class="who">${a.lastBidder||'—'}</span></div>
         ${controls}`;
      box.appendChild(card);
    });
  }

  // aggiornare il listone per lock corretti
  renderTable();
}

// Ticker countdown leggero: aggiorna solo i numeri e gestisce scadenze
setInterval(function(){
  // aggiorna etichette esistenti
  Object.keys(auctionsCache).forEach(function(key){
    var a = auctionsCache[key];
    if (!a || a.status !== 'open') return;
    if (!a.endAt) return;
    var remain = a.endAt - now();
    var span = el('timer-'+key);
    if (span) {
      span.textContent = fmtMMSS(remain);
      span.className = remain <= 10000 ? 'timer danger' : (remain <= 60000 ? 'timer warn' : 'timer');
    }
    // chiusura automatica allo scadere
    if (remain <= 0) {
      handleExpiry(key, a);
    }
  });
}, 1000);

// Bootstrap
window.addEventListener('DOMContentLoaded', function(){
  var nameInput = el('myName');
  if (nameInput) {
    var saved = localStorage.getItem('myName');
    if (saved) nameInput.value = saved;
    nameInput.addEventListener('change', function(){
      localStorage.setItem('myName', nameInput.value.trim());
    });
  }

  var s = el('search');
  if (s) s.addEventListener('input', function(e){ filterValue = e.target.value; renderTable(); });
  var bs = el('bootStatus'); if (bs) bs.textContent = 'JS avviato ✅';

  bindSettingsUI();
  loadCSV();
});

// Live listeners
auctionsRef.on('value', function(s){
  auctionsCache = s.val() || {};
  renderAuctions(); // solo open
});

participantsRef.on('value', function(s){
  participants = s.val()||{};
  renderParticipants(assignmentsCache);
});

assignmentsRef.on('value', function(s){
  var val = s.val()||{};
  var items = Object.values(val).sort(function(a,b){ return a.at-b.at; });
  assignmentsCache = items;

  // Box “Aste chiuse” (più recente in alto)
  renderClosedBox(items.slice().sort(function(a,b){ return b.at - a.at; }));
});

// === Push helpers già presenti ===
async function fetchAllTokens(){
  const snap = await firebase.database().ref('tokens').once('value');
  const val = snap.val() || {};
  return Object.values(val).map(x => x.token).filter(Boolean);
}

async function sendPushToAll(title, body){
  try {
    const tokens = await fetchAllTokens();
    if (!tokens.length) { debug('Nessun token registrato'); return; }
    const res = await fetch('/.netlify/functions/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tokens })
    });
    const j = await res.json().catch(()=> ({}));
    debug('notify status ' + res.status + ' -> ' + JSON.stringify(j));
  } catch (e) {
    debug('notify ERROR: ' + (e && e.message || String(e)));
  }
}

// 👇 nuova utility: invia solo ad un utente (rilanciante)
async function sendPushToUser(user, title, body){
  try {
    const res = await fetch('/.netlify/functions/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, targetUser: user })
    });
    const j = await res.json().catch(()=> ({}));
    debug('notify-to-user status ' + res.status + ' -> ' + JSON.stringify(j));
  } catch (e) {
    debug('notify-to-user ERROR: ' + (e && e.message || String(e)));
  }
}

// Notifiche push
auctionsRef.on('child_added', function(snap){
  const a = snap.val();
  if (a && a.status === 'open') {
    const title = 'Asta aperta';
    const body  = a.player + ' (' + (a.role||'') + (a.team ? ', ' + a.team : '') + ') • aperta da ' + (a.openedBy || '—');
    // showLocalNotification(title, body);
    sendPushToAll(title, body);
  }
});

auctionsRef.on('child_changed', function(snap){
  const a = snap.val();
  const prev = (auctionsCache && auctionsCache[snap.key]) || {};
  if (a && a.status === 'open' && Number(a.bid||0) > Number(prev.bid||0)) {
    const title = 'Nuovo rilancio';
    const body  = a.player + ' a ' + a.bid + ' (da ' + (a.lastBidder||'') + ')';
    // showLocalNotification(title, body);
    if (a.lastBidder) { sendPushToUser(a.lastBidder, title, body); }
  }
});

// Mantieni cache aggiornata
auctionsRef.on('value', function(s){ auctionsCache = s.val() || {}; });

// FCM
const messaging = firebase.messaging();
let fcmToken = null;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/firebase-messaging-sw.js')
    .then(function(reg) {
      debug('SW registrato');
      messaging.useServiceWorker(reg);
    })
    .catch(function(err){ debug('SW ERROR: ' + (err && err.message || String(err))); });
}

window.enablePush = async function(){
  try {
    await Notification.requestPermission();
    if (Notification.permission !== 'granted') { alert('Permesso negato.'); return; }
    const vapidKey = 'BDWmtT7_gKB9wdDiPAttBed939_smK9VJNK1aUceF-K3YmNAOA0UECeg2jQzr7x33O2PK6cuoureOYZuLLo8XNA';
    const token = await messaging.getToken({ vapidKey });
    if (!token) { alert('Token non ottenuto'); return; }
    fcmToken = token;
    debug('FCM token ok');

    const tokenKey = token.replace(/[^a-zA-Z0-9_-]/g, '');
    await firebase.database().ref('tokens/' + tokenKey).set({
      token: token,
      user: (document.getElementById('myName').value || 'Anonimo'),
      ua: navigator.userAgent,
      at: Date.now()
    });

    alert('Push abilitate su questo dispositivo ✔');
  } catch (e) {
    debug('enablePush ERROR: ' + (e && e.message || String(e)));
    alert('Impossibile abilitare la push.');
  }
};

// (rimane definita ma NON usata per evitare doppioni)
function showLocalNotification(title, body){
  try {
    if (!("Notification" in window)) return;
    if (document.hidden) return; // evita quando non in foreground
    // disattivata: gestiamo via FCM
    // new Notification(title, { body });
  } catch(e){}
}
