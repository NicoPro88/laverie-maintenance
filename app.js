'use strict';

/* ============ Données ============ */

const TABLES = ['Laveries', 'Equipements', 'Interventions', 'Pieces', 'Maintenances'];
const S = { Laveries: [], Equipements: [], Interventions: [], Pieces: [], Maintenances: [] };
const TYPES_EQUIPEMENT = ['Lave-linge', 'Sèche-linge', 'Centrale de paiement', 'Distributeur de lessive', 'Chauffe-eau', 'Adoucisseur', 'Autre'];
const TYPES_INTERVENTION = ['Préventive', 'Corrective', 'Dépannage', 'Installation', 'Autre'];
const STATUTS_PIECE = ['À commander', 'Commandée', 'Reçue', 'Changée'];

let cfg = {};
try { cfg = JSON.parse(localStorage.getItem('laverie.settings') || '{}'); } catch (e) { cfg = {}; }
function saveCfg() { localStorage.setItem('laverie.settings', JSON.stringify(cfg)); }

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('laverie', 1);
      req.onupgradeneeded = () => {
        TABLES.concat('pdfQueue').forEach((t) => req.result.createObjectStore(t, { keyPath: 'id' }));
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbAll = (store) => idb(store, 'readonly', (s) => s.getAll());
const idbPut = (store, obj) => idb(store, 'readwrite', (s) => s.put(obj));
const idbDel = (store, id) => idb(store, 'readwrite', (s) => s.delete(id));

const live = (t) => S[t].filter((r) => !r.deleted);
const get = (t, id) => S[t].find((r) => r.id === id && !r.deleted);

function save(table, row) {
  if (!row.id) row.id = crypto.randomUUID();
  row.updatedAt = Date.now();
  row.dirty = true;
  const i = S[table].findIndex((r) => r.id === row.id);
  if (i >= 0) S[table][i] = row; else S[table].push(row);
  idbPut(table, row);
  scheduleSync();
  return row;
}

function remove(table, row) {
  row.deleted = true;
  save(table, row);
  const cascade = (t, key) => S[t].filter((r) => !r.deleted && r[key] === row.id).forEach((r) => { r.deleted = true; save(t, r); });
  if (table === 'Laveries') ['Equipements', 'Interventions', 'Pieces', 'Maintenances'].forEach((t) => cascade(t, 'laverieId'));
  if (table === 'Equipements') cascade('Maintenances', 'equipementId');
}

/* ============ Outils ============ */

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => iso(new Date());
const fmt = (d) => (d ? d.split('-').reverse().join('/') : '');
function addDays(d, n) {
  const [y, m, j] = d.split('-').map(Number);
  return iso(new Date(y, m - 1, j + Number(n)));
}
function daysUntil(d) {
  const p = (s) => { const [y, m, j] = s.split('-').map(Number); return Date.UTC(y, m - 1, j); };
  return Math.round((p(d) - p(today())) / 86400000);
}
function equipLabel(e) {
  if (!e) return 'Général (toute la laverie)';
  return [e.type, e.numero ? 'n°' + e.numero : '', e.marque, e.modele].filter(Boolean).join(' ');
}
function dueBadge(d) {
  if (!d) return '';
  const n = daysUntil(d);
  if (n < 0) return `<span class="badge red">Retard ${-n} j</span>`;
  if (n === 0) return '<span class="badge orange">Aujourd\'hui</span>';
  if (n <= 7) return `<span class="badge orange">Dans ${n} j</span>`;
  return `<span class="badge">${fmt(d)}</span>`;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.updatedAt || 0) - (a.updatedAt || 0);

/* ============ Synchronisation ============ */

let syncing = false;
let syncTimer;
let lastError = '';

async function api(action, data) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action, token: cfg.token, urlApp: location.origin + location.pathname }, data)),
    redirect: 'follow'
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || 'Erreur du serveur');
  if (out.sujetNtfy && out.sujetNtfy !== cfg.sujetNtfy) { cfg.sujetNtfy = out.sujetNtfy; saveCfg(); }
  return out;
}

function scheduleSync() {
  updateSyncDot();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), 1500);
}

async function pendingCount() {
  const queue = await idbAll('pdfQueue');
  return TABLES.reduce((n, t) => n + S[t].filter((r) => r.dirty).length, 0) + queue.length;
}

async function updateSyncDot() {
  const dot = $('#syncDot');
  const n = await pendingCount();
  dot.className = syncing ? 'busy pending' : lastError ? 'error' : n ? 'pending' : cfg.url ? 'ok' : '';
}

async function sync(manual) {
  if (!cfg.url || !cfg.token) {
    if (manual) { toast('Renseignez d\'abord la connexion au Google Sheet'); location.hash = '#/reglages'; }
    return false;
  }
  if (syncing) return false;
  if (!navigator.onLine) { if (manual) toast('Hors ligne : les données seront envoyées plus tard'); return false; }
  syncing = true;
  updateSyncDot();
  try {
    const changes = {};
    const sent = [];
    TABLES.forEach((t) => {
      const dirty = S[t].filter((r) => r.dirty);
      if (!dirty.length) return;
      changes[t] = dirty.map((r) => { const c = Object.assign({}, r); delete c.dirty; return c; });
      dirty.forEach((r) => sent.push([t, r, r.updatedAt]));
    });
    const res = await api('sync', { since: cfg.since || 0, changes });
    sent.forEach(([t, r, stamp]) => {
      if (r.updatedAt === stamp) { r.dirty = false; idbPut(t, r); }
    });
    let changed = false;
    TABLES.forEach((t) => (res.rows[t] || []).forEach((remote) => {
      const i = S[t].findIndex((r) => r.id === remote.id);
      if (i >= 0 && S[t][i].dirty && S[t][i].updatedAt > remote.updatedAt) return;
      remote.dirty = false;
      if (i >= 0) S[t][i] = remote; else S[t].push(remote);
      idbPut(t, remote);
      changed = true;
    }));
    cfg.since = res.now;
    saveCfg();
    const queue = await idbAll('pdfQueue');
    for (const item of queue) {
      const up = await api('uploadPdf', item);
      await idbDel('pdfQueue', item.id);
      const itv = S.Interventions.find((r) => r.id === item.interventionId);
      if (itv) { itv.pdfUrl = up.url; idbPut('Interventions', itv); changed = true; }
      if (up.emailed) toast('Rapport envoyé à ' + item.sendTo);
    }
    lastError = '';
    if (manual) toast('Synchronisation terminée');
    if (changed && !document.querySelector('form')) render();
    return true;
  } catch (err) {
    lastError = err.message || String(err);
    if (manual) toast('Échec : ' + lastError);
    return false;
  } finally {
    syncing = false;
    updateSyncDot();
  }
}

/* ============ PDF ============ */

function buildPdf(itv) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const lav = S.Laveries.find((r) => r.id === itv.laverieId) || {};
  const eq = S.Equipements.find((r) => r.id === itv.equipementId);
  const pieces = live('Pieces').filter((p) => p.interventionId === itv.id);
  const W = 210, M = 15;
  let y = M;

  if (cfg.logo) {
    const ratio = (cfg.logoW || 1) / (cfg.logoH || 1);
    let h = 24, w = h * ratio;
    if (w > 60) { w = 60; h = w / ratio; }
    try { doc.addImage(cfg.logo, cfg.logo.indexOf('image/png') > 0 ? 'PNG' : 'JPEG', M, y, w, h); } catch (e) { /* logo illisible */ }
  }
  doc.setFontSize(12).setFont('helvetica', 'bold');
  doc.text(cfg.societe || '', W - M, y + 5, { align: 'right' });
  doc.setFontSize(9).setFont('helvetica', 'normal');
  const infos = [cfg.societeAdresse, cfg.societeTel, cfg.societeEmail, cfg.siret ? 'SIRET ' + cfg.siret : '']
    .filter(Boolean).join('\n');
  doc.text(doc.splitTextToSize(infos, 80), W - M, y + 10, { align: 'right' });
  y += 30;
  doc.setDrawColor(15, 76, 129).setLineWidth(0.6).line(M, y, W - M, y);
  y += 10;
  doc.setFontSize(16).setFont('helvetica', 'bold').setTextColor(15, 76, 129);
  doc.text('RAPPORT D\'INTERVENTION', M, y);
  doc.setFontSize(10).setFont('helvetica', 'normal').setTextColor(60);
  doc.text('Date : ' + fmt(itv.date), W - M, y, { align: 'right' });
  doc.setTextColor(0);
  y += 6;

  const block = (title, rows) => {
    doc.autoTable({
      startY: y,
      head: [[{ content: title, colSpan: 2 }]],
      body: rows.filter((r) => r[1]),
      theme: 'grid',
      margin: { left: M, right: M },
      styles: { fontSize: 10, cellPadding: 2 },
      headStyles: { fillColor: [15, 76, 129] },
      columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold', fillColor: [240, 244, 248] } }
    });
    y = doc.lastAutoTable.finalY + 6;
  };
  block('Laverie', [['Nom', lav.nom], ['Adresse', lav.adresse], ['Propriétaire', lav.proprietaire], ['Téléphone', lav.telephone]]);
  block('Équipement', eq
    ? [['Type', eq.type], ['Numéro', eq.numero], ['Marque', eq.marque], ['Modèle', eq.modele], ['N° de série', eq.numeroSerie]]
    : [['Type', 'Intervention générale sur la laverie']]);
  block('Intervention', [
    ['Type', itv.type],
    ['Durée', itv.dureeMinutes ? itv.dureeMinutes + ' min' : ''],
    ['Travaux réalisés', itv.description || 'Non renseigné']
  ]);
  if (pieces.length) {
    doc.autoTable({
      startY: y,
      head: [['Pièce', 'Référence', 'Qté', 'Statut']],
      body: pieces.map((p) => [p.designation, p.reference || '', p.quantite || 1, p.statut || '']),
      theme: 'grid',
      margin: { left: M, right: M },
      styles: { fontSize: 10, cellPadding: 2 },
      headStyles: { fillColor: [15, 76, 129] },
      columnStyles: { 2: { halign: 'center', cellWidth: 15 }, 3: { cellWidth: 32 } }
    });
    y = doc.lastAutoTable.finalY + 6;
  }
  if (y > 240) { doc.addPage(); y = M; }
  y += 4;
  doc.setFontSize(10).setFont('helvetica', 'bold');
  doc.text('Signature du technicien', M, y);
  doc.text('Signature du client', W / 2 + 5, y);
  doc.setDrawColor(170).setLineWidth(0.2);
  doc.rect(M, y + 2, W / 2 - M - 5, 28);
  doc.rect(W / 2 + 5, y + 2, W / 2 - M - 5, 28);

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8).setFont('helvetica', 'normal').setTextColor(120);
    doc.text('Document généré le ' + fmt(today()) + (cfg.societe ? ' par ' + cfg.societe : ''), M, 290);
    doc.text('Page ' + i + ' / ' + pages, W - M, 290, { align: 'right' });
  }
  const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename = ['Intervention', itv.date, slug(lav.nom), slug(eq ? equipLabel(eq) : 'General'), itv.id.slice(0, 4)]
    .filter(Boolean).join('_') + '.pdf';
  return { doc, filename, lav };
}

async function queuePdf(itv, sendTo) {
  const { doc, filename, lav } = buildPdf(itv);
  const item = {
    id: itv.id, interventionId: itv.id, filename,
    base64: doc.output('datauristring').split(',')[1]
  };
  if (sendTo) {
    item.sendTo = sendTo;
    item.subject = 'Rapport d\'intervention du ' + fmt(itv.date) + ' - ' + (lav.nom || 'Laverie');
    item.body = 'Bonjour,\n\nVeuillez trouver ci-joint le rapport de l\'intervention du ' + fmt(itv.date) +
      (lav.nom ? ' à la laverie ' + lav.nom : '') + '.\n\nCordialement,\n' + (cfg.societe || '');
  }
  // Un envoi par e-mail déjà en attente ne doit pas être effacé par un simple partage.
  const waiting = (await idbAll('pdfQueue')).find((q) => q.id === item.id);
  if (waiting && waiting.sendTo && !sendTo) {
    item.sendTo = waiting.sendTo; item.subject = waiting.subject; item.body = waiting.body;
  }
  await idbPut('pdfQueue', item);
  scheduleSync();
  return { doc, filename };
}

async function sharePdf(itv) {
  const { doc, filename } = await queuePdf(itv);
  const file = new File([doc.output('blob')], filename, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  doc.save(filename);
}

/* ============ Écrans ============ */

const view = $('#view');
function setTitle(t, tab) {
  $('#title').textContent = t;
  $('#back').hidden = !!tab;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
}
const li = (href, main, sub, right) =>
  `<li><a href="${href}"><div class="grow"><div>${main}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${right || ''}<span class="chev">›</span></a></li>`;
const list = (items, empty) => (items.length ? `<ul class="list">${items.join('')}</ul>` : `<div class="empty">${empty}</div>`);
const details = (rows) => '<dl>' + rows.filter((r) => r[1]).map((r) => `<dt>${r[0]}</dt><dd class="pre">${esc(r[1])}</dd>`).join('') + '</dl>';

function interventionItems(rows) {
  return rows.sort(byDateDesc).map((i) => {
    const eq = S.Equipements.find((e) => e.id === i.equipementId);
    return li('#/intervention/' + i.id, `${fmt(i.date)} · ${esc(i.type || '')}`,
      esc(equipLabel(eq)) + (i.description ? ' · ' + esc(i.description.slice(0, 60)) : ''));
  });
}
function pieceItems(rows) {
  return rows.map((p) => {
    const cls = p.statut === 'Changée' ? 'green' : p.statut === 'Reçue' ? '' : 'orange';
    return li('#/piece/' + p.id + '/edit', esc(p.designation) + (p.quantite > 1 ? ' ×' + p.quantite : ''),
      esc([p.reference, p.fournisseur].filter(Boolean).join(' · ')), `<span class="badge ${cls}">${esc(p.statut || '')}</span>`);
  });
}

const routes = [];
const route = (pattern, fn) => routes.push([new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), fn]);

route('/', () => {
  setTitle('Mes laveries', 'home');
  const due = live('Maintenances').filter((m) => m.prochaineDate && daysUntil(m.prochaineDate) <= 7).length;
  const items = live('Laveries').sort((a, b) => a.nom.localeCompare(b.nom)).map((l) => {
    const n = live('Equipements').filter((e) => e.laverieId === l.id).length;
    return li('#/laverie/' + l.id, esc(l.nom), esc(l.adresse || '') + (l.adresse ? ' · ' : '') + n + ' équipement' + (n > 1 ? 's' : ''));
  });
  view.innerHTML =
    (!cfg.url ? '<div class="card"><h2>Connexion au Google Sheet</h2><div class="sub">L\'app fonctionne déjà sur ce téléphone. Reliez-la à votre Google Sheet pour sauvegarder les données.</div><a class="btn light block" href="#/reglages">Ouvrir les réglages</a></div>' : '') +
    (due ? `<a class="card" href="#/echeances" style="display:block;text-decoration:none;color:inherit"><span class="badge orange">${due}</span> maintenance${due > 1 ? 's' : ''} à faire dans les 7 jours ›</a>` : '') +
    `<div class="card"><h2>Laveries</h2>${list(items, 'Aucune laverie pour l\'instant.')}
     <a class="btn block" href="#/laverie/new">+ Ajouter une laverie</a></div>`;
});

route('/laverie/new', () => laverieForm({}));
route('/laverie/:id/edit', (id) => laverieForm(get('Laveries', id)));
function laverieForm(row) {
  if (!row) return notFound();
  form(row.id ? 'Modifier la laverie' : 'Nouvelle laverie', [
    { k: 'nom', label: 'Nom de la laverie', required: true },
    { k: 'adresse', label: 'Adresse' },
    { k: 'proprietaire', label: 'Propriétaire' },
    { k: 'emailProprietaire', label: 'E-mail du propriétaire', type: 'email' },
    { k: 'telephone', label: 'Téléphone', type: 'tel' },
    { k: 'notes', label: 'Notes', type: 'textarea' }
  ], row, (v) => { const r = save('Laveries', Object.assign(row, v)); go('#/laverie/' + r.id); },
  row.id && (() => { remove('Laveries', row); go('#/'); }));
}

route('/laverie/:id', (id) => {
  const l = get('Laveries', id);
  if (!l) return notFound();
  setTitle(l.nom);
  const equips = live('Equipements').filter((e) => e.laverieId === id)
    .sort((a, b) => equipLabel(a).localeCompare(equipLabel(b), 'fr', { numeric: true }));
  const pending = live('Pieces').filter((p) => p.laverieId === id && p.statut !== 'Changée');
  view.innerHTML = `
    <div class="card"><h2>Informations <a class="btn small light" href="#/laverie/${id}/edit">Modifier</a></h2>
      ${details([['Adresse', l.adresse], ['Propriétaire', l.proprietaire], ['E-mail', l.emailProprietaire], ['Téléphone', l.telephone], ['Notes', l.notes]]) }
    </div>
    <a class="btn block" href="#/intervention/new/${id}" style="margin-bottom:12px">+ Nouvelle intervention</a>
    <div class="card"><h2>Équipements</h2>
      ${list(equips.map((e) => {
        const next = live('Maintenances').filter((m) => m.equipementId === e.id && m.prochaineDate).map((m) => m.prochaineDate).sort()[0];
        return li('#/equipement/' + e.id, esc(equipLabel(e)), esc(e.numeroSerie ? 'N° série ' + e.numeroSerie : ''), dueBadge(next));
      }), 'Aucun équipement dans cette laverie.')}
      <a class="btn light block" href="#/equipement/new/${id}">+ Ajouter un équipement</a></div>
    <div class="card"><h2>Pièces en attente</h2>${list(pieceItems(pending), 'Aucune pièce en attente.')}
      <a class="btn light block" href="#/piece/commande/${id}">+ Commander une pièce</a></div>
    <div class="card"><h2>Interventions</h2>
      ${list(interventionItems(live('Interventions').filter((i) => i.laverieId === id)), 'Aucune intervention enregistrée.')}</div>`;
});

route('/equipement/new/:laverieId', (laverieId) => equipForm({ laverieId }));
route('/equipement/:id/edit', (id) => equipForm(get('Equipements', id)));
function equipForm(row) {
  if (!row) return notFound();
  form(row.id ? 'Modifier l\'équipement' : 'Nouvel équipement', [
    { k: 'type', label: 'Type', required: true, datalist: TYPES_EQUIPEMENT },
    { k: 'numero', label: 'Numéro dans la laverie (ex. 3)' },
    { k: 'marque', label: 'Marque' },
    { k: 'modele', label: 'Modèle' },
    { k: 'numeroSerie', label: 'Numéro de série' },
    { k: 'dateMiseEnService', label: 'Date de mise en service', type: 'date' },
    { k: 'notes', label: 'Notes', type: 'textarea' }
  ], row, (v) => { const r = save('Equipements', Object.assign(row, v)); go('#/equipement/' + r.id); },
  row.id && (() => { remove('Equipements', row); go('#/laverie/' + row.laverieId); }));
}

route('/equipement/:id', (id) => {
  const e = get('Equipements', id);
  if (!e) return notFound();
  setTitle(equipLabel(e));
  const lav = get('Laveries', e.laverieId) || {};
  const plans = live('Maintenances').filter((m) => m.equipementId === id).sort((a, b) => (a.prochaineDate || '').localeCompare(b.prochaineDate || ''));
  view.innerHTML = `
    <div class="card"><h2>Fiche <a class="btn small light" href="#/equipement/${id}/edit">Modifier</a></h2>
      ${details([['Laverie', lav.nom], ['Type', e.type], ['Numéro', e.numero], ['Marque', e.marque], ['Modèle', e.modele],
        ['N° de série', e.numeroSerie], ['Mise en service', fmt(e.dateMiseEnService)], ['Notes', e.notes]])}
    </div>
    <a class="btn block" href="#/intervention/new/${e.laverieId}/${id}" style="margin-bottom:12px">+ Nouvelle intervention</a>
    <div class="card"><h2>Maintenances périodiques</h2>
      ${list(plans.map((m) => li('#/maintenance/' + m.id + '/edit', esc(m.titre),
        'Tous les ' + esc(m.periodiciteJours) + ' jours' + (m.derniereDate ? ' · dernière le ' + fmt(m.derniereDate) : ''), dueBadge(m.prochaineDate))),
        'Aucun rappel programmé pour cet équipement.')}
      <a class="btn light block" href="#/maintenance/new/${id}">+ Programmer une maintenance</a></div>
    <div class="card"><h2>Pièces</h2>
      ${list(pieceItems(live('Pieces').filter((p) => p.equipementId === id)), 'Aucune pièce enregistrée.')}
      <a class="btn light block" href="#/piece/commande/${e.laverieId}/${id}">+ Commander une pièce</a></div>
    <div class="card"><h2>Historique des interventions</h2>
      ${list(interventionItems(live('Interventions').filter((i) => i.equipementId === id)), 'Aucune intervention enregistrée.')}</div>`;
});

route('/maintenance/new/:equipId', (equipId) => {
  const e = get('Equipements', equipId);
  if (!e) return notFound();
  maintenanceForm({ equipementId: equipId, laverieId: e.laverieId, derniereDate: today(), periodiciteJours: 90 });
});
route('/maintenance/:id/edit', (id) => maintenanceForm(get('Maintenances', id)));
function maintenanceForm(row) {
  if (!row) return notFound();
  form(row.id ? 'Modifier la maintenance' : 'Programmer une maintenance', [
    { k: 'titre', label: 'Opération (ex. Nettoyage des filtres)', required: true },
    { k: 'periodiciteJours', label: 'Périodicité en jours (30 = mensuel, 90 = trimestriel, 365 = annuel)', type: 'number', required: true, min: 1 },
    { k: 'derniereDate', label: 'Dernière réalisation', type: 'date' },
    { k: 'prochaineDate', label: 'Prochaine échéance (calculée si vide)', type: 'date' },
    { k: 'notes', label: 'Notes', type: 'textarea' }
  ], row, (v) => {
    const changedBase = v.derniereDate !== row.derniereDate || Number(v.periodiciteJours) !== Number(row.periodiciteJours);
    if (!v.prochaineDate || (changedBase && v.prochaineDate === row.prochaineDate)) {
      v.prochaineDate = addDays(v.derniereDate || today(), v.periodiciteJours);
    }
    save('Maintenances', Object.assign(row, v));
    go('#/equipement/' + row.equipementId);
  }, row.id && (() => { remove('Maintenances', row); go('#/equipement/' + row.equipementId); }));
}

route('/intervention/new/:laverieId', (laverieId) => interventionForm({ laverieId, date: today(), type: 'Préventive' }));
route('/intervention/new/:laverieId/:equipId', (laverieId, equipId, q) =>
  interventionForm({ laverieId, equipementId: equipId, date: today(), type: q.plan ? 'Préventive' : 'Corrective' }, q.plan));
route('/intervention/:id/edit', (id) => interventionForm(get('Interventions', id)));
function interventionForm(row, planId) {
  if (!row || !get('Laveries', row.laverieId)) return notFound();
  const equips = live('Equipements').filter((e) => e.laverieId === row.laverieId);
  const plans = live('Maintenances').filter((m) => m.laverieId === row.laverieId);
  const extra = plans.length ? '<div id="plans"><label>Maintenances périodiques réalisées</label>' + plans.map((m) =>
    `<label class="check" data-equip="${m.equipementId}"><input type="checkbox" name="plan" value="${m.id}" ${m.id === planId ? 'checked' : ''}> ${esc(m.titre)}</label>`).join('') + '</div>' : '';
  form(row.id ? 'Modifier l\'intervention' : 'Nouvelle intervention', [
    { k: 'equipementId', label: 'Équipement', type: 'select', options: [['', 'Général (toute la laverie)']].concat(equips.map((e) => [e.id, equipLabel(e)])) },
    { k: 'date', label: 'Date', type: 'date', required: true },
    { k: 'type', label: 'Type d\'intervention', type: 'select', options: TYPES_INTERVENTION.map((t) => [t, t]) },
    { k: 'description', label: 'Travaux réalisés', type: 'textarea' },
    { k: 'dureeMinutes', label: 'Durée (minutes)', type: 'number', min: 0 }
  ], row, (v, formEl) => {
    const r = save('Interventions', Object.assign(row, v));
    formEl.querySelectorAll('input[name=plan]:checked').forEach((c) => {
      const m = get('Maintenances', c.value);
      if (!m) return;
      m.derniereDate = r.date;
      m.prochaineDate = addDays(r.date, m.periodiciteJours);
      save('Maintenances', m);
    });
    go('#/intervention/' + r.id);
  }, row.id && (() => { remove('Interventions', row); go('#/laverie/' + row.laverieId); }), extra);
  const sel = view.querySelector('[name=equipementId]');
  const filter = () => view.querySelectorAll('#plans .check').forEach((el) => {
    const show = el.dataset.equip === sel.value;
    el.style.display = show ? '' : 'none';
    if (!show) el.querySelector('input').checked = false;
  });
  if (view.querySelector('#plans')) { sel.addEventListener('change', filter); filter(); }
}

route('/intervention/:id', (id) => {
  const i = get('Interventions', id);
  if (!i) return notFound();
  setTitle('Intervention du ' + fmt(i.date));
  const lav = get('Laveries', i.laverieId) || {};
  const eq = get('Equipements', i.equipementId);
  view.innerHTML = `
    <div class="card"><h2>Détails <a class="btn small light" href="#/intervention/${id}/edit">Modifier</a></h2>
      ${details([['Laverie', lav.nom], ['Équipement', equipLabel(eq)], ['Date', fmt(i.date)], ['Type', i.type],
        ['Durée', i.dureeMinutes ? i.dureeMinutes + ' min' : ''], ['Travaux', i.description]])}
    </div>
    <div class="card"><h2>Pièces</h2>
      ${list(pieceItems(live('Pieces').filter((p) => p.interventionId === id)), 'Aucune pièce sur cette intervention.')}
      <a class="btn light block" href="#/piece/new/${id}">+ Ajouter une pièce</a></div>
    <div class="card"><h2>Rapport PDF</h2>
      <div class="sub">Le PDF est créé sur le téléphone, même hors ligne, puis archivé dans Google Drive à la synchronisation.</div>
      <button class="btn block" id="pdfBtn">Créer et partager le PDF</button>
      <button class="btn light block" id="mailBtn">Envoyer par e-mail au propriétaire</button>
      ${i.pdfUrl ? `<a class="btn light block" href="${esc(i.pdfUrl)}" target="_blank" rel="noopener">Ouvrir le PDF archivé</a>` : ''}
    </div>`;
  $('#pdfBtn').onclick = () => sharePdf(i).catch((e) => toast('PDF impossible : ' + e.message));
  $('#mailBtn').onclick = async () => {
    if (!lav.emailProprietaire) return toast('Ajoutez l\'e-mail du propriétaire dans la fiche de la laverie');
    if (!cfg.url) return toast('Reliez d\'abord l\'app au Google Sheet dans les réglages');
    if (!confirm('Envoyer le rapport à ' + lav.emailProprietaire + ' ?')) return;
    await queuePdf(i, lav.emailProprietaire);
    toast(navigator.onLine ? 'Envoi en cours…' : 'Le rapport partira au retour du réseau');
  };
});

route('/piece/new/:interventionId', (interventionId) => {
  const i = get('Interventions', interventionId);
  if (!i) return notFound();
  pieceForm({ interventionId, laverieId: i.laverieId, equipementId: i.equipementId || '', quantite: 1, statut: 'Changée', datePose: i.date }, '#/intervention/' + interventionId);
});
route('/piece/commande/:laverieId', (laverieId) => pieceForm({ laverieId, equipementId: '', quantite: 1, statut: 'Commandée', dateCommande: today() }, '#/laverie/' + laverieId));
route('/piece/commande/:laverieId/:equipId', (laverieId, equipId) =>
  pieceForm({ laverieId, equipementId: equipId, quantite: 1, statut: 'Commandée', dateCommande: today() }, '#/equipement/' + equipId));
route('/piece/:id/edit', (id) => pieceForm(get('Pieces', id)));
function pieceForm(row, back) {
  if (!row) return notFound();
  const equips = live('Equipements').filter((e) => e.laverieId === row.laverieId);
  form(row.id ? 'Modifier la pièce' : 'Nouvelle pièce', [
    { k: 'designation', label: 'Désignation', required: true },
    { k: 'reference', label: 'Référence' },
    { k: 'fournisseur', label: 'Fournisseur' },
    { k: 'quantite', label: 'Quantité', type: 'number', min: 1 },
    { k: 'prixUnitaire', label: 'Prix unitaire (€)', type: 'number', step: '0.01', min: 0 },
    { k: 'statut', label: 'Statut', type: 'select', options: STATUTS_PIECE.map((s) => [s, s]) },
    { k: 'equipementId', label: 'Équipement', type: 'select', options: [['', 'Général (toute la laverie)']].concat(equips.map((e) => [e.id, equipLabel(e)])) },
    { k: 'dateCommande', label: 'Date de commande', type: 'date' },
    { k: 'datePose', label: 'Date de pose', type: 'date' },
    { k: 'notes', label: 'Notes', type: 'textarea' }
  ], row, (v) => {
    if (v.statut === 'Changée' && !v.datePose) v.datePose = today();
    save('Pieces', Object.assign(row, v));
    back ? go(back) : history.back();
  }, row.id && (() => { remove('Pieces', row); history.back(); }));
}

route('/echeances', () => {
  setTitle('Échéances', 'echeances');
  const plans = live('Maintenances').filter((m) => m.prochaineDate).sort((a, b) => a.prochaineDate.localeCompare(b.prochaineDate));
  view.innerHTML = `<div class="card"><h2>Maintenances à venir</h2>${list(plans.map((m) => {
    const lav = get('Laveries', m.laverieId) || {};
    const eq = get('Equipements', m.equipementId);
    return li(`#/intervention/new/${m.laverieId}/${m.equipementId}?plan=${m.id}`, esc(m.titre),
      esc(lav.nom || '') + ' · ' + esc(equipLabel(eq)), dueBadge(m.prochaineDate));
  }), 'Aucune maintenance programmée. Ouvrez un équipement pour en programmer une.')}
  <p class="help">Touchez une ligne pour enregistrer l'intervention. L'échéance suivante est recalculée automatiquement.</p></div>`;
});

route('/pieces', () => {
  setTitle('Pièces', 'pieces');
  const rows = live('Pieces').filter((p) => p.statut !== 'Changée');
  const group = (statut) => {
    const items = rows.filter((p) => p.statut === statut).map((p) => {
      const lav = get('Laveries', p.laverieId) || {};
      const eq = get('Equipements', p.equipementId);
      return li('#/piece/' + p.id + '/edit', esc(p.designation) + (p.quantite > 1 ? ' ×' + p.quantite : ''),
        esc([lav.nom, eq ? equipLabel(eq) : '', p.reference, p.dateCommande ? 'commandée le ' + fmt(p.dateCommande) : ''].filter(Boolean).join(' · ')));
    });
    return `<div class="card"><h2>${statut} <span class="badge">${items.length}</span></h2>${list(items, 'Rien ici.')}</div>`;
  };
  view.innerHTML = STATUTS_PIECE.slice(0, 3).map(group).join('') +
    '<p class="help">Pour commander une pièce, ouvrez la laverie ou l\'équipement concerné.</p>';
});

route('/reglages', async () => {
  setTitle('Réglages', 'reglages');
  const n = await pendingCount();
  view.innerHTML = `
    <form class="card" id="cnx"><h2>Connexion au Google Sheet</h2>
      <label>Adresse de l'application Web (URL du déploiement Apps Script)</label>
      <input name="url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.url || '')}">
      <label>Jeton (onglet Config du Google Sheet)</label>
      <input name="token" value="${esc(cfg.token || '')}" autocomplete="off">
      <button class="btn block">Enregistrer et synchroniser</button>
      <p class="help">${n ? n + ' élément' + (n > 1 ? 's' : '') + ' en attente d\'envoi.' : 'Tout est synchronisé.'}
        ${lastError ? '<br>Dernière erreur : ' + esc(lastError) : ''}</p>
    </form>
    <div class="card"><h2>Notifications de maintenance</h2>
      ${cfg.sujetNtfy ? `<div class="sub">Installez l'app gratuite <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">ntfy</a> puis abonnez-vous à ce sujet :</div>
        <input readonly value="${esc(cfg.sujetNtfy)}" onclick="this.select()" style="margin-top:8px">
        <div class="btns"><a class="btn light" href="ntfy://ntfy.sh/${esc(cfg.sujetNtfy)}">Ouvrir dans ntfy</a>
        <button class="btn light" id="testNotif">Envoyer un test</button></div>
        <p class="help">Les rappels partent chaque matin vers 8 h : 7 jours, 3 jours et 1 jour avant l'échéance, le jour même, puis chaque semaine en cas de retard.</p>`
      : '<div class="sub">Le sujet de notification apparaîtra ici après la première synchronisation.</div>'}
    </div>
    <form class="card" id="soc"><h2>En-tête des rapports PDF</h2>
      <label>Nom de votre société</label><input name="societe" value="${esc(cfg.societe || '')}">
      <label>Adresse</label><input name="societeAdresse" value="${esc(cfg.societeAdresse || '')}">
      <label>Téléphone</label><input name="societeTel" type="tel" value="${esc(cfg.societeTel || '')}">
      <label>E-mail</label><input name="societeEmail" type="email" value="${esc(cfg.societeEmail || '')}">
      <label>SIRET</label><input name="siret" value="${esc(cfg.siret || '')}">
      <label>Logo</label><input type="file" id="logo" accept="image/*">
      ${cfg.logo ? `<img class="logo-preview" src="${cfg.logo}" alt="Logo"><button type="button" class="btn small danger" id="rmLogo" style="margin-top:8px">Retirer le logo</button>` : ''}
      <button class="btn block">Enregistrer</button>
    </form>`;
  $('#cnx').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const url = String(f.get('url')).trim(), token = String(f.get('token')).trim();
    if (url !== cfg.url || token !== cfg.token) cfg.since = 0;
    cfg.url = url; cfg.token = token;
    saveCfg();
    lastError = '';
    await sync(true);
    render();
  };
  $('#soc').onsubmit = (e) => {
    e.preventDefault();
    new FormData(e.target).forEach((v, k) => { if (typeof v === 'string') cfg[k] = v.trim(); });
    saveCfg();
    toast('En-tête enregistré');
  };
  $('#logo').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      cfg.logo = c.toDataURL('image/png'); cfg.logoW = c.width; cfg.logoH = c.height;
      // Garde aussi ce qui vient d'être saisi dans l'en-tête avant de réafficher l'écran.
      new FormData($('#soc')).forEach((v, k) => { if (typeof v === 'string') cfg[k] = v.trim(); });
      saveCfg();
      URL.revokeObjectURL(img.src);
      toast('Logo enregistré');
      render();
    };
    img.onerror = () => toast('Image illisible');
    img.src = URL.createObjectURL(file);
  };
  if ($('#rmLogo')) $('#rmLogo').onclick = () => { delete cfg.logo; saveCfg(); render(); };
  if ($('#testNotif')) $('#testNotif').onclick = () => api('testNotification', {}).then(() => toast('Notification envoyée'), (e) => toast('Échec : ' + e.message));
});

/* ============ Formulaire générique ============ */

function form(title, fields, row, onSave, onDelete, extraHtml) {
  setTitle(title);
  const input = (f) => {
    const v = row[f.k] == null ? '' : row[f.k];
    const req = f.required ? 'required' : '';
    if (f.type === 'textarea') return `<textarea name="${f.k}" ${req}>${esc(v)}</textarea>`;
    if (f.type === 'select') return `<select name="${f.k}">${f.options.map((o) => `<option value="${esc(o[0])}" ${o[0] === v ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
    const attrs = ['min', 'step'].filter((a) => f[a] != null).map((a) => `${a}="${f[a]}"`).join(' ');
    const dl = f.datalist ? `list="dl-${f.k}"` : '';
    return `<input name="${f.k}" type="${f.type || 'text'}" value="${esc(v)}" ${req} ${attrs} ${dl} ${f.type === 'number' ? 'inputmode="decimal"' : ''}>` +
      (f.datalist ? `<datalist id="dl-${f.k}">${f.datalist.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : '');
  };
  view.innerHTML = `<form class="card" id="f">${fields.map((f) => `<label>${esc(f.label)}${f.required ? ' *' : ''}</label>${input(f)}`).join('')}
    ${extraHtml || ''}
    <button class="btn block">Enregistrer</button>
    ${onDelete ? '<button type="button" class="btn danger block" id="del">Supprimer</button>' : ''}</form>`;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const values = {};
    fields.forEach((f) => {
      let v = e.target.elements[f.k].value.trim();
      if (f.type === 'number') v = v === '' ? '' : Number(v.replace(',', '.'));
      values[f.k] = v;
    });
    onSave(values, e.target);
    toast('Enregistré');
  };
  if (onDelete) $('#del').onclick = () => { if (confirm('Supprimer définitivement ?')) { onDelete(); toast('Supprimé'); } };
}

/* ============ Navigation ============ */

function notFound() {
  setTitle('Introuvable');
  view.innerHTML = '<div class="card">Cet élément n\'existe plus. <a href="#/">Retour à l\'accueil</a></div>';
}
// Après un enregistrement, remplace l'écran de saisie pour que « Retour » ne revienne pas dessus.
function go(hash) { location.replace(hash); }

function render() {
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  const q = Object.fromEntries(new URLSearchParams(query || ''));
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) { fn(...m.slice(1).map(decodeURIComponent), q); window.scrollTo(0, 0); return; }
  }
  notFound();
}

$('#back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));
$('#syncBtn').onclick = () => sync(true);
window.addEventListener('hashchange', render);
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden) sync(); }, 5 * 60 * 1000);

(async function start() {
  for (const t of TABLES) S[t] = await idbAll(t);
  render();
  updateSyncDot();
  sync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
