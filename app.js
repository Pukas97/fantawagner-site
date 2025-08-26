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
debug('app.js caricato ✅');

// Firebase compat
const firebaseConfig = {
  apiKey: "AIzaSyBRo2tcepT9VqHYo7TekSGnG93kpTm6KaY",
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

// test DB
db.ref('__ping').set(Date.now()).then(()=>debug('rtdb write: ok')).catch(err=>debug('rtdb write ERROR: ' + (err && err.message || String(err))));

// === Refs
const auctionsRef     = db.ref('auctions');
const assignmentsRef  = db.ref('assignments');
// manteniamo per compat storica
const participantsRef = db.ref('participants');

// Settings condivise
const settingsRef       = db.ref('settings');
const timerMinutesRef   = db.ref('settings/timerMinutes');
const extendSecondsRef  = db.ref('settings/extendSeconds');

const START_BUDGET = 500;

// === Stato
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

  // applica valori UI agli input quando cambiano da DB
  timerMinutesRef.on('value', function(s){
    var v = Number(s.val());
    if (!isNaN(v) && v>0) { timerMinutes = v; if (minInput) minInput.value = v; }
  });
  extendSecondsRef.on('value', function(s){
    var v = Number(s.val());
    if (!isNaN(v) && v>=0) { extendSeconds = v; if (extInput) extInput.value = v; }
  });

  // salva su DB quando l'admin modifica
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

  // scrivi default iniziali se mancanti
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

// === Elenco giocatori (CSV)
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
    tr0.innerHTML = '<td colspan="5" class="muted">Nessun giocatore da mostrare (controlla separatore e intestazioni CSV)</td>';
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
    var label = openPlayersSet.has(norm(nome)) ? 'In asta' :
                (closedPlayersSet.has(norm(nome)) ? 'Asta chiusa' : 'Metti all\'asta');
    var buttonHtml = disabled ? '<button class="btn sm" disabled>'+label+'</button>'
                              : '<button class="btn primary sm" data-idx="'+idx+'">'+label+'</button>';
    tr.innerHTML = '<td>'+nome+'</td>'+
      '<td class="nowrap">'+ruolo+'</td>'+
      '<td>'+squadra+'</td>'+
      '<td class="nowrap">'+quota+'</td>'+
      '<td class="nowrap">'+buttonHtml+'</td>';
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-idx]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      var i = Number(e.currentTarget.getAttribute('data-idx'));
      var r = filtered[i];
      startAuctionFromRow(r);
      // blocco immediato lato UI
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'In asta';
      e.currentTarget.classList.remove('primary');
    });
  });
}

// === Aste multiple
function startAuctionFromRow(r){
  var player = getField(r, ['Nome','Giocatore','Player']);
  var role   = getField(r, ['Ruolo','R','Role']);
  var team   = getField(r, ['Squadra','Team','Club']);
  var quota  = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);
  var startBid = toNumber(quota);
  if (isLockedPlayer(player)) return;

  var endAt = now() + Math.max(1, parseInt(timerMinutes,10)||1) * 60000;

  auctionsRef.push({
    player: player,
    role: role,
    team: team,
    bid: startBid,
    lastBidder: '',
    status: 'open',
    createdAt: now(),
    endAt: endAt
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
  var val = toNumber(document.getElementById('manualBid-'+key).value); if (!val) return;

  var endAt = a.endAt || (a.createdAt ? a.createdAt + timerMinutes*60000 : now()+timerMinutes*60000);
  var remain = endAt - now();
  var patch = { bid: val, lastBidder: me };
  if (remain <= 60000 && extendSeconds > 0) {
    patch.endAt = endAt + (extendSeconds*1000);
  }
  db.ref('auctions/'+key).update(patch);
  document.getElementById('manualBid-'+key).value = '';
};

// Chiudi/assegna manuale
window.assignAuction = function(key){
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;
  if (!a.lastBidder || !toNumber(a.bid)) { alert('Nessuna offerta valida da assegnare.'); return; }
  assignmentsRef.push({
    player: a.player, role: a.role, team: a.team,
    price: toNumber(a.bid), winner: a.lastBidder, at: now()
  }, function(err){
    if (err) { debug('assign ERROR: ' + err.message); return; }
    db.ref('auctions/'+key).update({ status: 'closed' });
  });
};

// Auto-chiusura allo scadere
function handleExpiry(key, a){
  if (expiredHandled.has(key)) return;
  expiredHandled.add(key);
  if (a.lastBidder && toNumber(a.bid) > 0) {
    // auto-assegna
    assignmentsRef.push({
      player: a.player, role: a.role, team: a.team,
      price: toNumber(a.bid), winner: a.lastBidder, at: now()
    }, function(err){
      if (err) { debug('auto-assign ERROR: ' + err.message); }
      db.ref('auctions/'+key).update({ status: 'closed' });
    });
  } else {
    // chiudi senza assegnazione
    db.ref('auctions/'+key).update({ status: 'closed' });
  }
}

// Reset (UI sbloccata)
window.resetOpenAuctions = function () {
  if (!confirm('Sicuro di voler cancellare TUTTE le aste APERTE?')) return;

  auctionsRef.once('value').then(function (s) {
    var val = s.val() || {};
    var updates = {};
    Object.keys(val).forEach(function (k) {
      if (val[k] && val[k].status === 'open') updates[k] = null;
    });

    var doAfter = function () {
      Object.keys(auctionsCache).forEach(function (k) {
        if (auctionsCache[k] && auctionsCache[k].status === 'open') delete auctionsCache[k];
      });
      openPlayersSet.clear();
      renderAuctions();
      renderTable();
      debug('Reset aste aperte: UI sbloccata');
    };

    if (Object.keys(updates).length) {
      db.ref('auctions').update(updates).then(doAfter).catch(doAfter);
    } else {
      doAfter();
    }
  });
};

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

    renderAuctions();
    renderTable();
    renderParticipants([]);

    debug('Reset totale completato: tutto sbloccato');
  }).catch(function(){
    auctionsCache = {};
    openPlayersSet.clear();
    closedPlayersSet.clear();
    renderAuctions();
    renderTable();
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

      // Assicurati che le vecchie aste abbiano endAt: se manca, lo imposta ora
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
          <button class="btn primary sm" onclick="customBid('${key}')">Rilancia</button>
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
    if (remain <= 0) {
      handleExpiry(key, a);
    }
  });
}, 1000);

// Bootstrap + nome persistente + settings UI
window.addEventListener('DOMContentLoaded', function(){
  var nameInput = el('myName');
  if (nameInput) {
    var savedName = localStorage.getItem('myName');
    if (savedName) nameInput.value = savedName;
    nameInput.addEventListener('input', function () {
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

  // aggiorna partecipanti/budget
  renderParticipants(items);
});

// Box “Aste chiuse”
function renderClosedBox(items){
  var box = el('closedBox');
  if (!box) return;
  box.innerHTML = '';
  if (!items.length){
    var li0 = document.createElement('li');
    li0.className = 'muted';
    li0.textContent = 'Ancora nessuna asta chiusa.';
    box.appendChild(li0);
    return;
  }
  items.forEach(function(x){
    var li = document.createElement('li');
    li.innerHTML = '<span class="pill">'+x.winner+'</span> ha preso <strong>'+x.player+'</strong> <span class="muted">('+(x.role||'—')+')</span> per <strong>'+x.price+'</strong>';
    box.appendChild(li);
  });
}

// Partecipanti & budget (auto)
function computeBudgets(assignList){
  var map = {};
  assignList.forEach(function(a){
    var key = norm(a.winner || '');
    if (!key) return;
    if (!map[key]) map[key] = { name: a.winner, spent: 0, items: [] };
    map[key].spent += toNumber(a.price);
    map[key].items.push({ player: a.player, role: a.role, price: toNumber(a.price) });
  });
  return map;
}

function renderParticipants(assignList){
  var budgets = computeBudgets(assignList);
  var container = el('participants');
  container.innerHTML = '';
  // elenco persone (storici manuali + auto da assegnazioni)
  var arr = [];
  var p = participants || {};
  Object.keys(p).forEach(function(id){ arr.push({ id:id, name:p[id].name }); });
  Object.values(budgets).forEach(function(b){
    if (b && b.name && !arr.find(function(x){ return norm(x.name)===norm(b.name); })) {
      arr.push({ id:'auto-'+norm(b.name), name:b.name });
    }
  });
  arr.sort(function(a,b){ return a.name.localeCompare(b.name); });

  arr.forEach(function(p){
    var b = budgets[norm(p.name)] || { name:p.name, spent:0, items:[] };
    var remaining = Math.max(0, START_BUDGET - b.spent);
    var percent = Math.max(0, Math.min(100, Math.round((remaining/START_BUDGET)*100)));

    var card = document.createElement('div');
    card.className = 'participant-card';
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">' +
        '<div><strong>'+p.name+'</strong></div>' +
        '<div class="muted">'+remaining+' / '+START_BUDGET+'</div>' +
      '</div>' +
      '<div class="progress"><i style="width:'+percent+'%"></i></div>' +
      (b.items.length
        ? ('<ul style="margin:8px 0 0 16px; padding:0; list-style: disc;">'+
            b.items.map(function(it){ return '<li>'+it.player+' <span class="muted">('+(it.role||'—')+')</span> – '+it.price+'</li>'; }).join('')+
           '</ul>')
        : '<div class="muted" style="margin-top:8px;">Nessun acquisto</div>'
      );
    container.appendChild(card);
  });
}

// === 🔔 Push
let fcmToken = null;
const messaging = firebase.messaging();
let swReg = null;

// attendo la registrazione del SW PRIMA di chiedere il token
const swReady = (async () => {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
    swReg = reg;
    if (messaging.useServiceWorker) messaging.useServiceWorker(reg); // compat
    debug('SW registrato');
    return reg;
  } catch (err) {
    debug('SW ERROR: ' + (err?.message || String(err)));
    return null;
  }
})();

window.enablePush = async function(){
  try {
    await Notification.requestPermission();
    if (Notification.permission !== 'granted') { alert('Permesso negato.'); return; }

    const reg = await swReady; // << aspetta davvero il SW
    if (!reg) { alert('Service Worker non pronto'); return; }

    const vapidKey = 'BDWmtT7_gKB9wdDiPAttBed939_smK9VJNK1aUceF-K3YmNAOA0UECeg2jQzr7x33O2PK6cuoureOYZuLLo8XNA';

    const token = await messaging.getToken({ vapidKey, serviceWorkerRegistration: reg });
    if (!token) { alert('Token non ottenuto'); return; }
    fcmToken = token;
    debug('FCM token ok');

    const tokenKey = token.replace(/[^a-zA-Z0-9_-]/g, '');
    await firebase.database().ref('tokens/' + tokenKey).set({
      token,
      user: (document.getElementById('myName').value || 'Anonimo'),
      ua: navigator.userAgent,
      at: Date.now()
    });

    alert('Push abilitate su questo dispositivo ✔');
  } catch (e) {
    debug('enablePush ERROR: ' + (e?.message || String(e)));
    alert('Impossibile abilitare la push.');
  }
};

// Foreground → SOLO toast
function showToast(msg){
  const box = document.getElementById('debugBox');
  if (box){ const div=document.createElement('div'); div.textContent='🔔 '+msg; box.appendChild(div); }
  console.log('[TOAST]', msg);
}
function showLocalNotification(title, body){ showToast(title+' — '+body); }

// Invio a Netlify (tipo + payload) → Netlify manda data-only
async function sendPushToAll(type, payload){
  try {
    const res = await fetch('/.netlify/functions/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload })
    });
    const txt = await res.text();
    debug('notify status ' + res.status + ' -> ' + txt);
  } catch (e) {
    debug('notify ERROR: ' + (e?.message || String(e)));
  }
}

// Transazione idempotente (una sola push per evento)
async function sendPushOnce(auctionKey, type, payload){
  const flagRef = firebase.database().ref('auctions/'+auctionKey+'/.pushFlags/'+type);
  const myMark = Math.random().toString(36).slice(2);
  const result = await flagRef.transaction(curr => curr || myMark);
  if (result.committed && result.snapshot.val() === myMark) {
    await sendPushToAll(type, payload);
  } else {
    debug('push già inviata per ' + auctionKey + ' ['+type+']');
  }
}

// Listener → toast in-page + push idempotente
auctionsRef.on('child_added', (snap) => {
  const key = snap.key, a = snap.val();
  if (a && a.status === 'open') {
    const title='Asta aperta', body=`${a.player} (${a.role||''}${a.team?', '+a.team:''})`;
    showLocalNotification(title, body);
    sendPushOnce(key, 'auction_open', { player:a.player, role:a.role, bid:a.bid });
  }
});

auctionsRef.on('child_changed', (snap) => {
  const key = snap.key, a = snap.val();
  const prev = (auctionsCache && auctionsCache[key]) || {};
  if (a && a.status === 'open' && Number(a.bid||0) > Number(prev.bid||0)) {
    const title='Nuovo rilancio', body=`${a.player} a ${a.bid} (da ${a.lastBidder||''})`;
    showLocalNotification(title, body);
    sendPushOnce(key, 'bid', { player:a.player, bid:a.bid, bidder:a.lastBidder });
  }
});

// Mantieni cache aggiornata
auctionsRef.on('value', function(s){ auctionsCache = s.val() || {}; });




