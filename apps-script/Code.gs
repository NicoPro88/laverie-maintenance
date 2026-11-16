/**
 * Laverie Maintenance : script de liaison entre l'app mobile et ce Google Sheet.
 *
 * Installation (une seule fois) :
 *   1. Coller ce fichier dans Extensions > Apps Script du Google Sheet.
 *   2. Lancer la fonction "installer" et accepter les autorisations.
 *   3. Déployer > Nouveau déploiement > Application Web
 *      (Exécuter en tant que : Moi, Accès : Tout le monde).
 *   4. Copier l'URL du déploiement et le jeton de l'onglet Config dans les réglages de l'app.
 */

var TABLES = {
  Laveries: ['id', 'nom', 'adresse', 'proprietaire', 'emailProprietaire', 'telephone', 'notes'],
  Equipements: ['id', 'laverieId', 'numero', 'type', 'marque', 'modele', 'numeroSerie', 'dateMiseEnService', 'notes'],
  Interventions: ['id', 'laverieId', 'equipementId', 'date', 'type', 'description', 'dureeMinutes', 'pdfUrl'],
  Pieces: ['id', 'laverieId', 'equipementId', 'interventionId', 'designation', 'reference', 'fournisseur',
    'quantite', 'prixUnitaire', 'statut', 'dateCommande', 'datePose', 'notes'],
  Maintenances: ['id', 'laverieId', 'equipementId', 'titre', 'periodiciteJours', 'derniereDate', 'prochaineDate', 'notes']
};
var COMMON = ['updatedAt', 'deleted', 'syncedAt'];
var NUMERIC = { updatedAt: 1, syncedAt: 1, quantite: 1, prixUnitaire: 1, periodiciteJours: 1, dureeMinutes: 1 };
var CONFIG_SHEET = 'Config';
var JOURS_RAPPEL = [7, 3, 1, 0];

/* ---------- Installation ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Laverie')
    .addItem('Installer / réparer', 'installer')
    .addItem('Tester la notification', 'testerNotification')
    .addItem('Envoyer les rappels maintenant', 'rappelsQuotidiens')
    .addToUi();
}

function installer() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABLES).forEach(function (name) {
    ensureSheet_(ss, name, TABLES[name].concat(COMMON));
  });
  var cfg = ensureSheet_(ss, CONFIG_SHEET, ['cle', 'valeur', 'explication']);
  var defaults = [
    ['jeton', Utilities.getUuid().replace(/-/g, ''), 'Mot de passe de l\'app. À coller dans les réglages de l\'app.'],
    ['sujetNtfy', 'laverie-' + Utilities.getUuid().replace(/-/g, '').substring(0, 16), 'Sujet à suivre dans l\'app ntfy pour recevoir les notifications.'],
    ['emailRappel', Session.getEffectiveUser().getEmail(), 'Adresse qui reçoit aussi les rappels par e-mail. Vider pour désactiver.'],
    ['joursAvantRappel', '7', 'Les maintenances prévues dans ce nombre de jours apparaissent dans les rappels.'],
    ['dossierPdfId', '', 'Rempli automatiquement : dossier Drive des rapports PDF.'],
    ['urlApp', '', 'Adresse de l\'app, ouverte quand on touche une notification.']
  ];
  var existing = readConfig_();
  defaults.forEach(function (d) {
    if (!(d[0] in existing)) cfg.appendRow(d);
  });
  installTrigger_();
  return 'ok';
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var current = sheet.getLastRow() > 0 ? sheet.getDataRange().getValues()[0].map(String) : [];
  var missing = headers.filter(function (h) { return current.indexOf(h) < 0; });
  if (missing.length) {
    var start = current.filter(function (h) { return h !== ''; }).length;
    sheet.getRange(1, start + 1, 1, missing.length).setValues([missing]);
  }
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setNumberFormat('@');
  sheet.getRange(1, 1, 1, sheet.getMaxColumns()).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'rappelsQuotidiens') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rappelsQuotidiens').timeBased().everyDays(1).atHour(8).inTimezone('Europe/Paris').create();
}

/* ---------- Config ---------- */

function readConfig_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  var out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] !== '') out[String(values[i][0])] = String(values[i][1]);
  }
  return out;
}

function writeConfig_(key, value) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === key) {
      sheet.getRange(i + 1, 2, 1, 1).setValues([[value]]);
      return;
    }
  }
  sheet.appendRow([key, value, '']);
}

/* ---------- API de l'app ---------- */

function doGet() {
  return json_({ ok: true, service: 'laverie-maintenance' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var req = JSON.parse(e.postData.contents);
    var cfg = readConfig_();
    if (!cfg.jeton || req.token !== cfg.jeton) return json_({ ok: false, error: 'Jeton invalide' });
    lock.waitLock(25000);
    if (req.urlApp && req.urlApp !== cfg.urlApp) writeConfig_('urlApp', req.urlApp);
    var res;
    if (req.action === 'ping') res = {};
    else if (req.action === 'sync') res = sync_(req);
    else if (req.action === 'uploadPdf') res = uploadPdf_(req, cfg);
    else if (req.action === 'testNotification') res = { sent: notify_('Test', 'Les notifications de l\'app Laverie fonctionnent.', cfg) };
    else return json_({ ok: false, error: 'Action inconnue' });
    res.ok = true;
    res.sujetNtfy = cfg.sujetNtfy;
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) { }
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Lecture / écriture des onglets ---------- */

function readTable_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Onglet manquant : ' + name + '. Lancez "installer".');
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(String);
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (headers[c] === '') continue;
      obj[headers[c]] = cell_(headers[c], values[i][c], tz);
    }
    if (obj.id === '' || obj.id === undefined) continue;
    obj._row = i + 1;
    rows.push(obj);
  }
  return { sheet: sheet, headers: headers, rows: rows };
}

function cell_(key, v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  if (key === 'deleted') return v === true || v === 1 || v === '1' || v === 'true' || v === 'TRUE';
  if (NUMERIC[key]) return v === '' || v === null ? '' : Number(v);
  return v === null || v === undefined ? '' : String(v);
}

function toRow_(headers, obj) {
  return headers.map(function (h) {
    if (h === 'deleted') return obj.deleted ? '1' : '';
    var v = obj[h];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Synchronisation : l'app envoie ses lignes modifiées, le serveur garde la plus récente
 * (updatedAt), puis renvoie tout ce qui a changé depuis la dernière synchronisation.
 */
function sync_(req) {
  var now = Date.now();
  var since = Number(req.since) || 0;
  var changes = req.changes || {};
  var out = {};
  Object.keys(TABLES).forEach(function (name) {
    var table = readTable_(name);
    var byId = {};
    table.rows.forEach(function (r) { byId[r.id] = r; });
    var appended = [];
    (changes[name] || []).forEach(function (incoming) {
      if (!incoming || !incoming.id) return;
      var current = byId[incoming.id];
      if (current && Number(current.updatedAt) > Number(incoming.updatedAt)) return;
      var merged = {};
      var k;
      if (current) for (k in current) merged[k] = current[k];
      for (k in incoming) if (k !== 'pdfUrl' || incoming[k]) merged[k] = incoming[k];
      merged.syncedAt = now;
      if (current) {
        table.sheet.getRange(current._row, 1, 1, table.headers.length).setValues([toRow_(table.headers, merged)]);
        merged._row = current._row;
      } else {
        appended.push(merged);
      }
      byId[merged.id] = merged;
    });
    if (appended.length) {
      var start = table.sheet.getLastRow() + 1;
      table.sheet.getRange(start, 1, appended.length, table.headers.length)
        .setValues(appended.map(function (r) { return toRow_(table.headers, r); }));
    }
    out[name] = Object.keys(byId).map(function (id) { return byId[id]; })
      .filter(function (r) { return Number(r.syncedAt) > since || !r.syncedAt; })
      .map(function (r) {
        var copy = {};
        for (var k in r) if (k !== '_row' && k !== 'syncedAt') copy[k] = r[k];
        return copy;
      });
  });
  return { now: now, rows: out };
}

/* ---------- PDF ---------- */

function uploadPdf_(req, cfg) {
  var folder = pdfFolder_(cfg);
  var blob = Utilities.newBlob(Utilities.base64Decode(req.base64), 'application/pdf', req.filename || 'intervention.pdf');
  var existing = folder.getFilesByName(blob.getName());
  while (existing.hasNext()) existing.next().setTrashed(true);
  var file = folder.createFile(blob);
  var url = file.getUrl();
  if (req.interventionId) {
    var table = readTable_('Interventions');
    for (var i = 0; i < table.rows.length; i++) {
      if (table.rows[i].id === req.interventionId) {
        var r = table.rows[i];
        r.pdfUrl = url;
        r.syncedAt = Date.now();
        table.sheet.getRange(r._row, 1, 1, table.headers.length).setValues([toRow_(table.headers, r)]);
        break;
      }
    }
  }
  var emailed = false;
  if (req.sendTo) {
    MailApp.sendEmail({
      to: req.sendTo,
      subject: req.subject || 'Rapport d\'intervention',
      body: req.body || 'Veuillez trouver ci-joint le rapport d\'intervention.',
      attachments: [blob]
    });
    emailed = true;
  }
  return { url: url, emailed: emailed };
}

function pdfFolder_(cfg) {
  if (cfg.dossierPdfId) {
    try { return DriveApp.getFolderById(cfg.dossierPdfId); } catch (ignore) { }
  }
  var folder = DriveApp.createFolder('Laverie - Rapports d\'intervention');
  writeConfig_('dossierPdfId', folder.getId());
  return folder;
}

/* ---------- Rappels de maintenance ---------- */

function rappelsQuotidiens() {
  var cfg = readConfig_();
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var horizon = Number(cfg.joursAvantRappel) || 7;
  var laveries = index_(readTable_('Laveries').rows);
  var equipements = index_(readTable_('Equipements').rows);
  var lines = [];
  var mustSend = false;
  readTable_('Maintenances').rows.forEach(function (m) {
    if (m.deleted || !m.prochaineDate) return;
    var lav = laveries[m.laverieId];
    var eq = equipements[m.equipementId];
    if ((lav && lav.deleted) || (eq && eq.deleted)) return;
    var days = daysBetween_(today, m.prochaineDate);
    if (days > horizon) return;
    if (JOURS_RAPPEL.indexOf(days) >= 0 || (days < 0 && (-days) % 7 === 0)) mustSend = true;
    var when = days < 0 ? 'en retard de ' + (-days) + ' j' : days === 0 ? 'aujourd\'hui' : 'dans ' + days + ' j';
    lines.push({
      days: days,
      text: (lav ? lav.nom : 'Laverie ?') + ' / ' + (eq ? label_(eq) : 'Général') + ' : ' + m.titre + ' (' + when + ')'
    });
  });
  if (!lines.length || !mustSend) return 0;
  lines.sort(function (a, b) { return a.days - b.days; });
  var body = lines.map(function (l) { return l.text; }).join('\n');
  var title = lines.length + ' maintenance' + (lines.length > 1 ? 's' : '') + ' à prévoir';
  notify_(title, body, cfg);
  if (cfg.emailRappel) MailApp.sendEmail(cfg.emailRappel, 'Laverie : ' + title, body);
  return lines.length;
}

function testerNotification() {
  notify_('Test', 'Les notifications de l\'app Laverie fonctionnent.', readConfig_());
}

function notify_(title, message, cfg) {
  if (!cfg.sujetNtfy) return false;
  var payload = { topic: cfg.sujetNtfy, title: title, message: message, tags: ['wrench'] };
  if (cfg.urlApp) payload.click = cfg.urlApp;
  UrlFetchApp.fetch('https://ntfy.sh', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return true;
}

function index_(rows) {
  var out = {};
  rows.forEach(function (r) { out[r.id] = r; });
  return out;
}

function label_(eq) {
  return [eq.type, eq.numero ? 'n°' + eq.numero : '', eq.marque, eq.modele].filter(function (x) { return x; }).join(' ');
}

function daysBetween_(a, b) {
  var da = a.split('-'), db = b.split('-');
  var ta = Date.UTC(+da[0], +da[1] - 1, +da[2]);
  var tb = Date.UTC(+db[0], +db[1] - 1, +db[2]);
  return Math.round((tb - ta) / 86400000);
}

/* ---------- Modification manuelle dans le Sheet ---------- */

/** Une ligne corrigée à la main dans le Sheet est renvoyée à l'app à la synchronisation suivante. */
function onEdit(e) {
  var sheet = e.range.getSheet();
  if (!TABLES[sheet.getName()]) return;
  var headers = sheet.getDataRange().getValues()[0].map(String);
  var now = String(Date.now());
  var first = e.range.getRow();
  var last = first + e.range.getNumRows() - 1;
  for (var row = Math.max(first, 2); row <= last; row++) {
    ['updatedAt', 'syncedAt'].forEach(function (h) {
      var col = headers.indexOf(h);
      if (col >= 0) sheet.getRange(row, col + 1, 1, 1).setValues([[now]]);
    });
  }
}
