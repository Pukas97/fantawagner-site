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

// Utils
function el(id){ return document.getElementById(id); }
function now(){ return Date.now(); }
function norm(s){ return String(s||'').trim().toLowerCase(); }
function toNumber(x){ var n = Number(String(x||'').replace(',','.').replace(/[^\d.]/g,'')); return isNaN(n)?0:n; }
function fmtMMSS(ms){
  if (ms<0) ms = 0;
  var sec = Math.floor(ms/1000);
  var m = Math.floor(sec/60);
  var s = sec%60;
  return (m<10?'0':'')+m+':'+(s<10?'0':'')+s;
}
function getField(row, arr){
  for (var i=0;i<arr.length;i++){
    var k = arr[i];
    if (row.hasOwnProperty(k)) return row[k];
  }
  return '';
}

// Firebase
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
var auctionsCache = {};
var assignmentsCache = [];
var participants = {};
var budgets = {};
var openPlayersSet = new Set();
var closedPlayersSet = new Set();
var expiredHandled = new Set();

var csvData = [];
var filterValue = '';

var timerMinutes = 1;
var extendSeconds = 0;

// CSV loader
function loadCSV(){
  var ta = el('csv');
  if (!ta) return;
  try {
    var raw = ta.value.trim();
    if (!raw) { csvData = []; renderTable(); return; }
    var lines = raw.split(/\r?\n/).filter(Boolean);
    var headers = lines[0].split(';').map(s=>s.trim());
    var rows=[];
    for (var i=1;i<lines.length;i++){
      var parts = lines[i].split(';');
      var obj = {};
      headers.forEach(function(h,idx){ obj[h] = (parts[idx]||'').trim(); });
      rows.push(obj);
    }
    csvData = rows;
    renderTable();
  } catch(e){
    debug('CSV parse ERROR: ' + (e && e.message || String(e)));
  }
}

// tabella listone
function renderTable(){
  var tbody = el('listBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  var rows = csvData.slice();

  if (filterValue){
    var f = norm(filterValue);
    rows = rows.filter(function(r){
      var nome   = norm(getField(r, ['Nome','Giocatore','Player']));
      var ruolo  = norm(getField(r, ['Ruolo','R','Role']));
      var team   = norm(getField(r, ['Squadra','Team','Club']));
      return nome.includes(f) || ruolo.includes(f) || team.includes(f);
    });
  }

  rows.forEach(function(r, idx){
    var tr = document.createElement('tr');
    var nome = getField(r, ['Nome','Giocatore','Player']);
    var ruolo = getField(r, ['Ruolo','R','Role']);
    var squadra = getField(r, ['Squadra','Team','Club']);
    var quota = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);

    var disabled = openPlayersSet.has(norm(nome)) || closedPlayersSet.has(norm(nome));
    var label = disabled ? 'In asta' : 'Apri asta';
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
  var player   = getField(r, ['Nome','Giocatore','Player']);
  var role     = getField(r, ['Ruolo','R','Role']);
  var team     = getField(r, ['Squadra','Team','Club']);
  var quota    = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);
  var startBid = toNumber(quota);
  if (isLockedPlayer(player)) return;

  // nome di chi apre
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
    openedBy: me
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
  db.ref('auctions/'+key).update(patch).catch(function(err){
    debug('raiseBid ERROR: ' + (err && err.message || String(err)));
  });
};

window.raiseManual = function(key){
  var me = el('myName').value.trim() || 'Anonimo';
  var inp = el('manualBid-'+key); if (!inp) return;
  var v = Math.max(0, parseInt(inp.value||0, 10));
  var a = auctionsCache[key];
  if (!a || a.status !== 'open') return;
  if (v <= Number(a.bid||0)) { alert('Offerta deve essere maggiore di quella attuale.'); return; }

  var endAt = a.endAt || (a.createdAt ? a.createdAt + timerMinutes*60000 : now()+timerMinutes*60000);
  var remain = endAt - now();
  var patch = { bid: v, lastBidder: me };
  if (remain <= 60000 && extendSeconds > 0) {
    patch.endAt = endAt + (extendSeconds*1000);
  }
  db.ref('auctions/'+key).update(patch).then(function(){
    inp.value = '';
  }).catch(function(err){
    debug('raiseManual ERROR: ' + (err && err.message || String(err)));
  });
};

function handleExpiry(key, a){
  if (expiredHandled.has(key)) return;
  expiredHandled.add(key);

  // chiudi asta e assegna
  var price = Number(a.bid||0);
  var winner = a.lastBidder||'';
  var patch = { status: 'closed', endAt: a.endAt };
  db.ref('auctions/'+key).update(patch).then(function(){
    if (price>0 && winner){
      var item = {
        player:a.player, role:a.role, team:a.team,
        price:price, winner:winner, at:now()
      };
      assignmentsRef.push(item);
      // aggiorna budgets
      var B = budgets[norm(winner)] || { name:winner, spent:0, items:[] };
      B.items.push({ player:a.player, role:a.role, price:price });
      B.spent += price;
      budgets[norm(winner)] = B;
      renderParticipants(assignmentsCache.concat([item]));
      renderClosedBox(assignmentsCache.concat([item]).slice().sort(function(a,b){ return b.at-a.at; }));
    }
    // rimuovi dalla lista open
    delete auctionsCache[key];
    renderAuctions();
    renderTable();
  }).catch(function(err){
    debug('handleExpiry ERROR: ' + (err && err.message || String(err)));
  });
}

window.assignAuction = function(key){
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;
  if (!confirm('Chiudere e assegnare?')) return;
  handleExpiry(key, a);
};

window.unlockAll = function(){
  if (!confirm('Sbloccare i bottoni "Apri asta" per i giocatori attualmente in asta?')) return;
  // rileggi auctions, cancella tutti gli "open"
  auctionsRef.once('value').then(function(s){
    var val = s.val() || {};
    var updates = {};
    Object.keys(val).forEach(function(k){
      if (val[k] && val[k].status === 'open'){
        updates['/auctions/'+k] = null;
        if (auctionsCache[k] && auctionsCache[k].status === 'open') delete auctionsCache[k];
      }
    });
    var doAfter = function(){
      openPlayersSet.clear();
      renderAuctions();
      renderTable();
      debug('Sbloccati.');
    };
    if (Object.keys(updates).length){
      db.ref().update(updates).then(doAfter).catch(doAfter);
    } else {
      doAfter();
    }
  });
};

window.resetOpenAuctions = function(){
  if (!confirm('⚠️ Reset aste aperte?')) return;
  auctionsRef.once('value').then(function(s){
    var val = s.val() || {};
    var updates = {};
    Object.keys(val).forEach(function(k){
      if (val[k] && val[k].status === 'open'){
        updates['/auctions/'+k] = null;
        if (auctionsCache[k] && auctionsCache[k].status === 'open') delete auctionsCache[k];
      }
    });
    var doAfter = function(){
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
    var list = document.getElementById('auctionsList'); if (list) list.innerHTML = '';
    var left = document.querySelector('#listBody'); if (left) left.innerHTML = '';
    var parts = document.querySelector('#participants'); if (parts) parts.innerHTML = '';

    alert('Reset completato.');
  }).catch(function (err) {
    alert('Reset fallito: ' + (err && err.message || String(err)));
  });
};

// Participants
function renderParticipants(items){
  var container = document.getElementById('participants');
  if (!container) return;
  // ricalcola budgets
  budgets = {};
  items.forEach(function(it){
    var key = norm(it.winner||'');
    if (!key) return;
    if (!budgets[key]) budgets[key] = { name:it.winner, spent:0, items:[] };
    budgets[key].spent += Number(it.price||0);
    budgets[key].items.push({ player:it.player, role:it.role, price:Number(it.price||0) });
  });

  container.innerHTML = '';
  var names = Object.keys(participants).map(function(uid){ return participants[uid]; });
  names.sort(function(a,b){ return a.name.localeCompare(b.name); });

  names.forEach(function(p){
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

// === 🔔 Push (INVARIATO)
let fcmToken = null;
const messaging = firebase.messaging();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/firebase-messaging-sw.js')
    .then(function(reg) {
      debug('SW registrato');
      messaging.useServiceWorker(reg);
    })
    .catch(function(err){ debug('SW ERROR: ' + (err && err.message || String(err))); });
}

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

// UI bootstrap
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
  if (s) s.addEventListener('input', function(e){ filterValue = e.target.value; renderTable();
