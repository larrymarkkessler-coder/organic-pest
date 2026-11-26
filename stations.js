/* stations.js - bait-station register, device scanning and Corrective Action
   Reports (CARs) for the service report (Larry, 25/11/2026).

   ONLY for customers on the Station Register (Apps Script "Station Register"
   tab). For every other customer this file does nothing at all: no panel, no
   change to section 4, nothing added to the report.

   For a register customer, section 4 shows a "Bait stations & devices" panel:
   - "On site" for the bait-station rows is filled from the register;
   - each device is scanned (QR label OPPS|<site code>|<device id>) and marked
     OK, or a fault raises a CAR: pest type -> observation -> correction
     actioned, party responsible, location, compulsory photo, and a WhatsApp
     to the site contact where the client is advised;
   - a device that cannot be found is marked missing (it needs a CAR);
   - open CARs from earlier visits are listed for their follow-up;
   - Submit is refused until every device is accounted for (hard block).
   The index.html hooks are all guarded: if this file fails to load, or throws,
   the normal report carries on exactly as before. */
(function () {
  "use strict";
  var LS_SITES = "org_st_sites", LS_REG = "org_st_reg_", LS_STATE = "org_st_state_";
  var SITES_MAX_AGE = 6 * 3600 * 1000;

  // ── CAR choices: the Corrective Action Report Template (Platform/), with
  //    Larry's answers of 25/11/2026 ("Other" and "Pest Management Devices"
  //    dropped; MR = Monitor Missing; OK results never raise a CAR). ──
  var FIXED = ["Reported - Fixed", "Reported - Not Fixed"];
  var QUOTE = ["Quote Sent - Replaced", "Quote Sent - Not Replaced"];
  var CAR_TREE = {
    "Rodents": {ok: "OK - Inspected / In Order", obs: {
      "RA - Rodent Activity": ["Interior - Replaced Non Toxic With Toxic Bait", "Placed Extra Temporary Rodent Catch Traps"],
      "BRI - Insect Feeding": ["Bait Replenished"],
      "BRW - Wet/Mouldy": ["Bait Replenished"],
      "BB - Bait Station Blocked": ["Client Advised"],
      "BMD - Bait Station Damaged": ["Customer Quoted - Replaced", "Customer Quoted - Not Replaced"],
      "BMM - Bait Station Missing": ["Customer Quoted - Replaced", "Customer Quoted - Not Replaced"]}},
    "Cockroaches": {ok: "OK - Inspected / In Order", obs: {
      "CA - Cockroach Activity": ["Additional Treatment - Gel/Flush/Residual Spray"],
      "MR - Monitor Missing": ["Monitor Replaced"]}},
    "Flies": {ok: "OK - Inspected and Maintained", obs: {
      "RT - Replaced Tubes & Starters": ["Tubes / Starters Replaced"],
      "UD - Unit Damaged and Removed": QUOTE,
      "UM - Unit Missing": QUOTE,
      "NP - Unit has No Power": ["Reported to Client - Fixed", "Reported to Client - Not Fixed"]}},
    "Moths": {ok: "OK - Inspected and Maintained", obs: {
      "UD - Unit Damaged and Removed": QUOTE,
      "UM - Unit Missing": QUOTE}},
    "Structural": {ok: "", obs: {
      "H - Holes in Building": FIXED, "G - Gaps": FIXED, "C - Cracks / Crevices": FIXED,
      "P - Pest Proofing Failure": FIXED}},
    "Storage": {ok: "", obs: {
      "O - Obstruction": FIXED, "S - Stacking Issue": FIXED, "NS - No Space to service": FIXED,
      "R - No Rotational Packaging": FIXED}},
    "Housekeeping": {ok: "", obs: {"H - Poor Hygiene": FIXED}}
  };
  var PESTS = Object.keys(CAR_TREE);
  var MISSING_OBS = {"Rodents": "BMM - Bait Station Missing", "Flies": "UM - Unit Missing",
                     "Moths": "UM - Unit Missing", "Cockroaches": "MR - Monitor Missing"};
  var PARTY = ["Client", "Organic Pest", "Both Client and OPPS"];
  // Follow-ups (Larry, 26/11/2026): Cockroaches every 2 working days and Rodents every 7, three
  // "Clear" in a row (Rodents then a 4th, final visit); any other CAR is checked at the next monthly
  // service. The office books the visits on the planner; the technician records each one here.
  var FU_STATUS = ["In progress", "Clear", "Concluded"];
  var FU_SCHEDULED = {"Cockroaches": 1, "Rodents": 1};
  function fuOptions(c) { return FU_SCHEDULED[c.pestType] ? ["In progress", "Clear"] : FU_STATUS; }
  function fuPlan(c) {                    // "1:2026-11-30;2:2026-12-02;F:2026-12-17" -> [{n, date}]
    return String(c.plan || "").split(";").map(function (x) { var m = /^(\w+):(\d{4}-\d\d-\d\d)$/.exec(x.trim()); return m ? {n: m[1], date: m[2]} : null; })
      .filter(function (x) { return x; });
  }
  function fuNext(c) {                    // the next planned visit not yet recorded
    var pl = fuPlan(c), done = +c.visits || 0;
    return pl.length > done ? pl[done] : null;
  }
  function fuDue(c, date) {
    if (!FU_SCHEDULED[c.pestType]) return !!date && date > String(c.raised || "");   // the next service after the CAR
    var nx = fuNext(c);
    return !!(nx && date && nx.date <= date);
  }
  function fuClosesCar(c, f) { return !!f && (f.status === "Concluded" || (!FU_SCHEDULED[c.pestType] && f.status === "Clear")); }
  var NO_SCAN = ["Label damaged / unreadable", "Label missing", "Camera not working", "Other"];

  var S = {sites: null, reg: null, key: "", rno: null, st: null, photos: {}, busy: false};

  function g(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function gas() { return window.GAS_URL || ""; }
  function nowTime() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function pestOf(type) {
    var t = String(type || "").toLowerCase();
    if (/cockroach|\bcr\b/.test(t)) return "Cockroaches";
    if (/light trap|\bilt\b|fly/.test(t)) return "Flies";
    if (/moth/.test(t)) return "Moths";
    return "Rodents";
  }
  function custName() {
    try {
      if (g("cs") && g("cs").value === "NEW") return "";
      return (window.selC && window.selC[0]) || "";
    } catch (e) { return ""; }
  }
  function siteName() { try { return g("site-sel") ? g("site-sel").value : ""; } catch (e) { return ""; } }
  function techName() { try { return (window.TD && window.TD[g("tsel").value]) || ""; } catch (e) { return ""; } }
  function devicesServiced() { var t = g("devices-serviced-toggle"); return t ? t.checked : true; }

  // ── which customers have a register ──
  function siteEntry(cust, site) {
    var list = (S.sites && S.sites.sites) || [];
    var c = norm(cust), s = norm(site);
    for (var i = 0; i < list.length; i++) {
      if (norm(list[i].customer) !== c) continue;
      if (!s || !list[i].site || norm(list[i].site) === s || norm(list[i].site) === c || s === c) return list[i];
    }
    return null;
  }
  // An empty list is never kept (a site loaded later must show up at once), and
  // picking a customer re-asks if the list is more than 2 minutes old.
  var _sitesAsking = false;
  function refreshSites(force, maxAge) {
    var cached = lsGet(LS_SITES);
    if (cached) S.sites = cached;
    var age = cached ? Date.now() - (cached.at || 0) : Infinity;
    var fresh = cached && cached.sites && cached.sites.length && age < (maxAge || SITES_MAX_AGE);
    if (!force && fresh) return;
    if (!gas() || _sitesAsking) return;
    _sitesAsking = true;
    fetch(gas() + "?action=getStationSites&t=" + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (res) {
        _sitesAsking = false;
        if (!res || res.status !== "ok" || !Array.isArray(res.sites)) return;
        S.sites = {at: res.sites.length ? Date.now() : 0, sites: res.sites};
        lsSet(LS_SITES, S.sites);
        check(true);
      })
      .catch(function () { _sitesAsking = false; });
  }

  // ── state for the report being filled in (kept on the phone per report number) ──
  function blankState() { return {customer: "", siteCode: "", devices: {}, cars: [], followUps: {}}; }
  function saveState() { if (S.st && S.rno) lsSet(LS_STATE + S.rno, S.st); try { if (window.draftSchedule) window.draftSchedule(); } catch (e) {} }
  function loadState() {
    var st = lsGet(LS_STATE + S.rno);
    if (!st || norm(st.customer) !== norm(custName())) st = blankState();
    st.customer = custName();
    S.st = st;
    // photos come back from the phone's photo store
    var want = st.cars.map(function (c) { return c.photoId; }).filter(function (x) { return x && !S.photos[x]; });
    if (want.length && window.photoAll) window.photoAll(function (all) {
      all.forEach(function (r) { if (want.indexOf(r.id) >= 0) S.photos[r.id] = r.data; });
      render();
    });
  }

  // ── activation: polled, so a draft restore, a new report or a customer change are all picked up ──
  function check(forceReload) {
    var rno = window.rNo || "";
    if (rno !== S.rno) { S.rno = rno; S.key = ""; }
    var cust = custName(), site = siteName();
    var ent = cust ? siteEntry(cust, site) : null;
    var key = ent ? rno + "|" + ent.siteCode : "";
    if (key === S.key && !forceReload) return;
    S.key = key;
    if (!ent) { deactivate(); return; }
    var cached = lsGet(LS_REG + ent.siteCode);
    S.reg = cached && cached.devices && cached.devices.length ? cached : null;
    loadState();
    S.st.siteCode = ent.siteCode;
    render();
    fetchRegister(ent);
  }
  function fetchRegister(ent) {
    if (!gas()) return;
    var url = gas() + "?action=getStations&customer=" + encodeURIComponent(ent.customer) +
              "&site=" + encodeURIComponent(ent.site || "") + "&t=" + Date.now();
    fetch(url).then(function (r) { return r.json(); }).then(function (res) {
      if (!res || res.status !== "ok" || !Array.isArray(res.devices) || !res.devices.length) return;
      res.at = Date.now();
      lsSet(LS_REG + ent.siteCode, res);
      if (S.key.split("|")[1] !== ent.siteCode) return;
      S.reg = res;
      render();
    }).catch(function () {});
    if (!window.BarcodeDetector) loadJsQR(function () {});   // so the iPhone scanner works offline later
  }
  function active() { return !!(S.reg && S.key && S.st); }

  function deactivate() {
    S.reg = null; S.st = null;
    var p = g("st-panel"); if (p && p.parentNode) p.parentNode.removeChild(p);
    unlockOnSite(); clearCarCells(); dropQuoteRows();
  }

  // ── section 4 "On site" from the register ──
  function onSiteRows() {
    var out = {};
    var rows = document.querySelectorAll("#dbody tr");
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].cells[0] ? rows[i].cells[0].textContent.trim() : "";
      if (name === "Tamper Proof Exterior Rodent Bait Stations") out.ext = rows[i].querySelector(".dons");
      if (name === "Tamper Proof Interior Rodent Bait Stations") out.int = rows[i].querySelector(".dons");
    }
    return out;
  }
  function counts() {
    var c = {ext: 0, int: 0, ilt: 0, cr: 0, other: 0};
    ((S.reg && S.reg.devices) || []).forEach(function (d) {
      var t = String(d.type).toLowerCase();
      if (/bait/.test(t) && /exterior/.test(t)) c.ext++;
      else if (/bait/.test(t)) c.int++;
      else if (pestOf(t) === "Flies") c.ilt++;
      else if (pestOf(t) === "Cockroaches") c.cr++;
      else c.other++;
    });
    return c;
  }
  function lockOnSite() {
    var r = onSiteRows(), c = counts();
    [["ext", c.ext], ["int", c.int]].forEach(function (p) {
      var el = r[p[0]]; if (!el) return;
      if (String(el.value) !== String(p[1] || "")) {
        el.value = p[1] || "";
        try { el.dispatchEvent(new Event("input", {bubbles: true})); el.dispatchEvent(new Event("change", {bubbles: true})); } catch (e) {}
      }
      el.readOnly = true; el.dataset.stLock = "1"; el.style.background = "#e8f3ec";
      el.title = "From the site's bait-station register";
    });
    var ilt = document.querySelector("#ilt-tbody tr.ilt-device-row .dons");
    if (ilt && !ilt.value && c.ilt) { ilt.value = c.ilt; try { ilt.dispatchEvent(new Event("input", {bubbles: true})); } catch (e) {} }
  }
  function unlockOnSite() {
    var els = document.querySelectorAll("#dbody .dons[data-st-lock]");
    for (var i = 0; i < els.length; i++) { els[i].readOnly = false; els[i].style.background = ""; els[i].title = ""; delete els[i].dataset.stLock; }
  }

  // ── the panel ──
  function panel() {
    var p = g("st-panel");
    if (!p) {
      var tbl = g("dbody") && g("dbody").closest ? g("dbody").closest("table") : null;
      if (!tbl || !tbl.parentNode) return null;
      p = document.createElement("div"); p.id = "st-panel";
      p.style.cssText = "border:2px solid #1a5c38;border-radius:8px;padding:8px;margin-bottom:10px;background:#f6fbf8;font-size:12px";
      tbl.parentNode.insertBefore(p, tbl);
    }
    return p;
  }
  function devState(id) { return (S.st && S.st.devices[id]) || null; }
  function carByLocal(lid) {
    for (var i = 0; S.st && i < S.st.cars.length; i++) if (S.st.cars[i].localId === lid) return S.st.cars[i];
    return null;
  }
  function done(d) { var s = devState(d.id); return !!(s && (s.status === "ok" || s.status === "car")); }
  function openCarsAfter() {
    var n = 0;
    ((S.reg && S.reg.openCars) || []).forEach(function (c) {
      if (!fuClosesCar(c, S.st.followUps[c.carNo])) n++;
    });
    S.st.cars.forEach(function (c) { if (!closedAtCreation(c.correction)) n++; });
    return n;
  }
  // Several corrections can be ticked (Larry, 26/11/2026), kept as "A; B". The CAR is
  // closed on the day only when every one of them fixed it.
  var COR_SEP = "; ";
  function corParts(c) { return String(c || "").split(/\s*;\s*/).filter(function (x) { return x; }); }
  function closedAtCreation(c) {
    var parts = corParts(c);
    return parts.length > 0 && parts.every(function (x) { return /(fixed|replaced|replenished)\s*$/i.test(x) && !/\bnot\b/i.test(x); });
  }

  function render() {
    if (!active()) {
      if (S.key && !S.reg) {        // a register customer, register not loaded yet (no signal, first time)
        var p0 = panel(); if (p0) p0.innerHTML = "<b>Bait stations &amp; devices</b><div style=\"margin-top:4px;color:#8a5a00\">Loading this site's device register... (needs a signal the first time)</div>";
      }
      return;
    }
    var p = panel(); if (!p) return;
    lockOnSite(); fillCarCells(); syncQuotes();
    var devs = S.reg.devices, n = devs.length, k = devs.filter(done).length;
    var all = k === n;
    var h = "<div style=\"display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px\">" +
      "<b style=\"font-size:13px;color:#1a5c38\">Bait stations &amp; devices</b>" +
      "<span id=\"st-count\" style=\"font-weight:bold;padding:2px 8px;border-radius:10px;background:" + (all ? "#cfe8d4;color:#1a5c38" : "#fff3cd;color:#7a5600") + "\">" + k + " of " + n + " done</span></div>" +
      "<div style=\"color:#555;margin:4px 0 6px\">Service each device, then scan its label and choose OK or Fault. Every device must be done before the report can be submitted.</div>" +
      "<div style=\"display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px\">" +
      "<button type=\"button\" id=\"st-scan\" style=\"background:#1a5c38;color:#fff;border:none;border-radius:5px;padding:9px 14px;font-weight:bold;font-size:13px\">📷 Scan device</button>" +
      "<button type=\"button\" id=\"st-site-car\" style=\"background:none;border:1px solid #1a5c38;color:#1a5c38;border-radius:5px;padding:7px 10px;font-weight:bold\">+ CAR not on a device</button></div>";
    h += "<table style=\"width:100%;border-collapse:collapse\" id=\"st-list\">";
    devs.forEach(function (d) {
      var s = devState(d.id), car = s && s.carLocalId ? carByLocal(s.carLocalId) : null, chip;
      if (s && s.status === "ok") chip = "<span style=\"color:#1a5c38;font-weight:bold\">✔ OK</span>" + (s.scanned ? "" : " <span style=\"color:#a06000\">(not scanned)</span>");
      else if (s && s.status === "car") chip = "<span style=\"color:#b00020;font-weight:bold\">⚠ " + esc(car && car.carNo ? car.carNo : "CAR") + "</span>" + (s.scanned ? "" : " <span style=\"color:#a06000\">(" + esc(s.reason || "not scanned") + ")</span>");
      else chip = "<span style=\"color:#7a5600\">Not done</span>";
      h += "<tr data-dev=\"" + esc(d.id) + "\" style=\"border-top:1px solid #dbe9e0\">" +
        "<td style=\"padding:5px 4px;font-weight:bold;width:42px\">" + esc(d.id) + "</td>" +
        "<td style=\"padding:5px 4px\">" + esc(d.type) + (d.location ? "<div style=\"color:#666;font-size:11px\">" + esc(d.location) + "</div>" : "") + "</td>" +
        "<td style=\"padding:5px 4px;text-align:right\">" + chip + "<div style=\"margin-top:3px\">" +
        (s ? "<button type=\"button\" class=\"st-redo\" style=\"font-size:11px;background:none;border:1px solid #999;border-radius:4px;padding:2px 6px\">Change</button>"
           : "<button type=\"button\" class=\"st-noscan\" style=\"font-size:11px;background:none;border:1px solid #999;border-radius:4px;padding:2px 6px\">Can't scan</button> " +
             "<button type=\"button\" class=\"st-missing\" style=\"font-size:11px;background:none;border:1px solid #b00020;color:#b00020;border-radius:4px;padding:2px 6px\">Missing</button>") +
        "</div></td></tr>";
    });
    h += "</table>";
    var siteCars = S.st.cars.filter(function (c) { return !c.deviceId; });
    if (siteCars.length) {
      h += "<div style=\"margin-top:8px;font-weight:bold\">CARs not on a device</div>";
      siteCars.forEach(function (c) {
        h += "<div style=\"display:flex;justify-content:space-between;border-top:1px solid #dbe9e0;padding:4px 0\"><span>" + esc((c.carNo || "CAR") + " - " + c.observation) +
          "</span><button type=\"button\" class=\"st-editcar\" data-lid=\"" + esc(c.localId) + "\" style=\"font-size:11px\">Open</button></div>";
      });
    }
    var oc = (S.reg.openCars || []);
    if (oc.length) {
      var today = g("svcd") ? g("svcd").value : "";
      h += "<div style=\"margin-top:10px;font-weight:bold;color:#b00020\">Open CARs - follow-ups</div>";
      oc.forEach(function (c) {
        var f = S.st.followUps[c.carNo] || {}, due = fuDue(c, today), nx = fuNext(c), vn = (+c.visits || 0) + 1;
        var pest = CAR_TREE[c.pestType], obsOpts = ["Select..."].concat(pest && pest.ok ? [pest.ok] : ["Clear - no fault found"], pest ? Object.keys(pest.obs) : []);
        h += "<div class=\"st-fu\" data-car=\"" + esc(c.carNo) + "\" style=\"border-top:1px solid #dbe9e0;padding:6px 0\">" +
          "<div><b>" + esc(c.carNo) + "</b> " + esc(String(c.raised || "").split("-").reverse().join("/")) + (c.deviceId ? " &middot; " + esc(c.deviceId) : "") + " &middot; " + esc(c.observation) +
          "<div style=\"color:#666;font-size:11px\">" + esc(c.correction) + (c.location ? " &middot; " + esc(c.location) : "") + "</div>" +
          "<div class=\"st-fu-when\" style=\"font-size:11px;color:" + (due ? "#b00020" : "#666") + "\">" +
          (FU_SCHEDULED[c.pestType] ? "Follow-up visit No. " + vn + (nx ? (nx.n === "F" ? " (final)" : "") + " planned " + esc(nx.date.split("-").reverse().join("/")) : "")
                                    : "Checked at the next monthly service - visit No. " + vn) +
          (+c.clears ? " &middot; " + (+c.clears) + " clear in a row" : "") + (due ? " &middot; <b>due - record it</b>" : " &middot; not due today (record it only if you checked it)") + "</div></div>" +
          "<div style=\"display:grid;grid-template-columns:1fr;gap:4px;margin-top:4px\">" +
          sel("st-fu-ob", obsOpts, f.observation) +
          "<input type=\"text\" class=\"st-fu-ac\" placeholder=\"Action taken at this follow-up\" value=\"" + esc(f.action || "") + "\" style=\"font-size:12px;box-sizing:border-box;width:100%\">" +
          sel("st-fu-st", ["Status..."].concat(fuOptions(c)), f.status) + "</div></div>";
      });
    }
    p.innerHTML = h;
    g("st-scan").onclick = function () { scanOpen(onCode); };
    g("st-site-car").onclick = function () { carForm(null, {}); };
    var rows = p.querySelectorAll("#st-list tr[data-dev]");
    for (var i = 0; i < rows.length; i++) (function (tr) {
      var id = tr.getAttribute("data-dev"), d = devById(id);
      var b1 = tr.querySelector(".st-noscan"), b2 = tr.querySelector(".st-missing"), b3 = tr.querySelector(".st-redo");
      if (b1) b1.onclick = function () { noScan(d); };
      if (b2) b2.onclick = function () { missing(d); };
      if (b3) b3.onclick = function () { redo(d); };
    })(rows[i]);
    var ec = p.querySelectorAll(".st-editcar");
    for (var j = 0; j < ec.length; j++) (function (b) { b.onclick = function () { var c = carByLocal(b.getAttribute("data-lid")); if (c) carForm(null, c); }; })(ec[j]);
    var fus = p.querySelectorAll(".st-fu");
    for (var q = 0; q < fus.length; q++) (function (div) {
      var no = div.getAttribute("data-car");
      function upd() {
        var st = div.querySelector(".st-fu-st").value, ob = div.querySelector(".st-fu-ob").value, ac = div.querySelector(".st-fu-ac").value.trim();
        var f = {status: FU_STATUS.indexOf(st) >= 0 ? st : "", observation: ob && ob !== "Select..." ? ob : "", action: ac};
        if (f.status || f.observation || f.action) S.st.followUps[no] = f; else delete S.st.followUps[no];
        saveState(); setArpt();
      }
      div.querySelector(".st-fu-st").onchange = upd; div.querySelector(".st-fu-ob").onchange = upd;
      div.querySelector(".st-fu-ac").oninput = upd;
    })(fus[q]);
    setArpt();
  }
  function sel(cls, opts, val) {
    return "<select class=\"" + cls + "\" style=\"font-size:12px;max-width:100%\">" + opts.map(function (o, i) {
      return "<option" + (i === 0 ? " value=\"\"" : "") + (o === val ? " selected" : "") + ">" + esc(o) + "</option>";
    }).join("") + "</select>";
  }
  function setArpt() {
    var a = g("arpt"); if (!a || !active()) return;
    a.value = String(openCarsAfter());
  }
  function devById(id) {
    var d = (S.reg && S.reg.devices) || [];
    for (var i = 0; i < d.length; i++) if (String(d[i].id).toLowerCase() === String(id).toLowerCase()) return d[i];
    return null;
  }

  // ── modal helper (the platform's own modal style) ──
  function modal(id, title) {
    var m = window.photoModal ? window.photoModal(id, title) : null;
    if (!m) return null;
    m.querySelector("h3").textContent = title;
    document.body.appendChild(m);          // last in the page = on top of any other open modal
    return m;
  }
  function toTop(id) { var m = g(id); if (m) document.body.appendChild(m); }
  function closeModal(m) { if (m) m.classList.remove("show"); }

  // ── scanning ──
  var _jsqr = null;
  function loadJsQR(cb) {
    if (window.jsQR) { cb(true); return; }
    if (_jsqr) { _jsqr.push(cb); return; }
    _jsqr = [cb];
    var s = document.createElement("script"); s.src = "jsQR.js";
    s.onload = function () { var l = _jsqr; _jsqr = null; l.forEach(function (f) { f(!!window.jsQR); }); };
    s.onerror = function () { var l = _jsqr; _jsqr = null; l.forEach(function (f) { f(false); }); };
    document.head.appendChild(s);
  }
  function scanOpen(onDecoded) {
    var m = modal("st-scan-modal", "Scan the device label"); if (!m) return;
    var body = m.querySelector(".pm-body"), stream = null, stopped = false, det = null;
    body.innerHTML = "<video playsinline muted autoplay style=\"width:100%;max-height:55vh;background:#000;border-radius:6px\"></video>" +
      "<div class=\"st-scan-st\" style=\"font-size:12px;color:#555;margin:6px 0\">Starting camera...</div>" +
      "<div class=\"modal-btns\"><button class=\"modal-btn cancel st-scan-x\">Cancel</button></div>";
    var v = body.querySelector("video"), st = body.querySelector(".st-scan-st");
    var cv = document.createElement("canvas"), cx = cv.getContext("2d", {willReadFrequently: true});
    function stop() { stopped = true; try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; }
    function finish(code) { stop(); closeModal(m); onDecoded(code); }
    body.querySelector(".st-scan-x").onclick = function () { stop(); closeModal(m); };
    m.classList.add("show");
    window.ST._scanFinish = finish;          // test hook: ST._scanFinish("OPPS|...")
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      st.textContent = "This phone's browser cannot open the camera here. Use \"Can't scan\" on the device instead.";
      return;
    }
    function loop() {
      if (stopped) return;
      if (!v.videoWidth) { setTimeout(loop, 200); return; }
      if (det) {
        det.detect(v).then(function (codes) {
          if (codes && codes.length && codes[0].rawValue) finish(codes[0].rawValue); else setTimeout(loop, 150);
        }).catch(function () { setTimeout(loop, 300); });
        return;
      }
      if (window.jsQR) {
        var w = Math.min(720, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
        cv.width = w; cv.height = h; cx.drawImage(v, 0, 0, w, h);
        var r = null;
        try { r = window.jsQR(cx.getImageData(0, 0, w, h).data, w, h, {inversionAttempts: "dontInvert"}); } catch (e) {}
        if (r && r.data) { finish(r.data); return; }
      }
      setTimeout(loop, 180);
    }
    function start() {
      navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: "environment"}, width: {ideal: 1280}, height: {ideal: 720}}})
        .then(function (s) {
          if (stopped) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
          stream = s; v.srcObject = s; try { v.play(); } catch (e) {}
          st.textContent = "Point the camera at the QR label inside the lid.";
          loop();
        })
        .catch(function (e) {
          st.textContent = "The camera could not open" + (e && e.name === "NotAllowedError" ? " (camera permission refused - allow it in the browser settings)" : "") +
            ". Use \"Can't scan\" on the device instead.";
        });
    }
    if (window.BarcodeDetector) {
      try {
        window.BarcodeDetector.getSupportedFormats().then(function (f) {
          if (f && f.indexOf("qr_code") >= 0) det = new window.BarcodeDetector({formats: ["qr_code"]});
          if (!det) loadJsQR(function () { start(); }); else start();
        }).catch(function () { loadJsQR(function () { start(); }); });
      } catch (e) { loadJsQR(function () { start(); }); }
    } else {
      loadJsQR(function (ok) {
        if (!ok) { st.textContent = "The scanner could not load (no signal). Use \"Can't scan\" on the device instead."; return; }
        start();
      });
    }
  }
  function onCode(raw) {
    var m = /^OPPS\|([^|]+)\|(.+)$/.exec(String(raw || "").trim());
    if (!m) { alert("That is not an Organic Pest device label.\n\nRead: " + raw); return; }
    if (m[1] !== S.reg.siteCode) { alert("This label belongs to another site (" + m[1] + "), not " + (S.reg.customer || "this customer") + "."); return; }
    var d = devById(m[2]);
    if (!d) { alert("Device " + m[2] + " is not on this site's register. Tell the office."); return; }
    result(d, {scanned: true, scannedAt: nowTime()});
  }
  function noScan(d) {
    var m = modal("st-ns", "Device " + d.id + " - why can't it be scanned?"); if (!m) return;
    var body = m.querySelector(".pm-body");
    body.innerHTML = "<div style=\"font-size:12px;margin-bottom:6px\">" + esc(d.type) + (d.location ? " &middot; " + esc(d.location) : "") + "</div>" +
      sel("st-ns-r", ["Reason..."].concat(NO_SCAN), "") +
      "<div style=\"font-size:11px;color:#777;margin-top:6px\">The report shows this device as not scanned, with the reason.</div>" +
      "<div class=\"modal-btns\"><button class=\"modal-btn cancel st-x\">Cancel</button><button class=\"modal-btn save st-ok\">Next</button></div>";
    body.querySelector(".st-x").onclick = function () { closeModal(m); };
    body.querySelector(".st-ok").onclick = function () {
      var r = body.querySelector(".st-ns-r").value;
      if (!r) { alert("Choose the reason."); return; }
      closeModal(m); result(d, {scanned: false, scannedAt: nowTime(), reason: r});
    };
    m.classList.add("show");
  }
  function missing(d) {
    var pest = pestOf(d.type);
    if (!confirm("Mark " + d.id + " (" + d.type + ") as MISSING?\n\nA CAR with a photo of where it should be is needed.")) return;
    carForm(d, {pestType: pest, observation: MISSING_OBS[pest] || "", location: d.location}, {scanned: false, scannedAt: nowTime(), reason: "Missing"});
  }
  function redo(d) {
    var s = devState(d.id);
    if (s && s.status === "car" && s.carLocalId) {
      var c = carByLocal(s.carLocalId);
      var m = modal("st-redo", "Device " + d.id); if (!m) return;
      var body = m.querySelector(".pm-body");
      body.innerHTML = "<div style=\"font-size:12px\">" + esc(c ? (c.carNo || "CAR") + " - " + c.observation : "") + "</div>" +
        "<div class=\"modal-btns\" style=\"flex-wrap:wrap\"><button class=\"modal-btn cancel st-x\">Close</button>" +
        "<button class=\"modal-btn save st-open\">Open the CAR</button><button class=\"modal-btn cancel st-del\" style=\"color:#b00020\">Delete the CAR and redo</button></div>";
      body.querySelector(".st-x").onclick = function () { closeModal(m); };
      body.querySelector(".st-open").onclick = function () { closeModal(m); if (c) carForm(d, c); };
      body.querySelector(".st-del").onclick = function () {
        if (!confirm("Delete this CAR? " + (c && c.carNo ? c.carNo + " stays reserved and is not reused." : ""))) return;
        S.st.cars = S.st.cars.filter(function (x) { return x !== c; });
        delete S.st.devices[d.id]; saveState(); closeModal(m); render();
      };
      m.classList.add("show");
      return;
    }
    if (!confirm("Redo device " + d.id + "?")) return;
    delete S.st.devices[d.id]; saveState(); render();
  }

  // ── result for one device: OK or Fault ──
  function result(d, scan) {
    var pest = pestOf(d.type), ok = CAR_TREE[pest].ok;
    var m = modal("st-res", "Device " + d.id); if (!m) return;
    var body = m.querySelector(".pm-body");
    body.innerHTML = "<div style=\"font-size:13px;margin-bottom:8px\"><b>" + esc(d.type) + "</b>" + (d.location ? "<br>" + esc(d.location) : "") +
      "<div style=\"color:" + (scan.scanned ? "#1a5c38" : "#a06000") + ";font-size:12px;margin-top:3px\">" + (scan.scanned ? "✔ Label scanned " + esc(scan.scannedAt) : "Not scanned: " + esc(scan.reason)) + "</div></div>" +
      "<button type=\"button\" class=\"st-r-ok\" style=\"display:block;width:100%;background:#1a5c38;color:#fff;border:none;border-radius:6px;padding:12px;font-weight:bold;font-size:14px;margin-bottom:8px\">✔ " + esc(ok) + "</button>" +
      "<button type=\"button\" class=\"st-r-car\" style=\"display:block;width:100%;background:#b00020;color:#fff;border:none;border-radius:6px;padding:12px;font-weight:bold;font-size:14px;margin-bottom:8px\">⚠ Fault found - raise a CAR</button>" +
      "<div class=\"modal-btns\"><button class=\"modal-btn cancel st-x\">Cancel</button></div>";
    body.querySelector(".st-x").onclick = function () { closeModal(m); };
    body.querySelector(".st-r-ok").onclick = function () {
      S.st.devices[d.id] = {status: "ok", result: ok, scanned: !!scan.scanned, scannedAt: scan.scannedAt || "", reason: scan.reason || ""};
      saveState(); closeModal(m); render();
    };
    body.querySelector(".st-r-car").onclick = function () {
      closeModal(m); carForm(d, {pestType: pest, location: d.location}, scan);
    };
    m.classList.add("show");
  }

  // ── the CAR form ──
  function carForm(d, c, scan) {
    var editing = !!c.localId;
    var car = {localId: c.localId || ("L" + Date.now() + Math.random().toString(36).slice(2, 6)), carNo: c.carNo || "",
               deviceId: d ? d.id : (c.deviceId || ""), pestType: c.pestType || (d ? pestOf(d.type) : ""),
               observation: c.observation || "", correction: c.correction || "", party: c.party || "",
               location: c.location || (d ? d.location : "") || "", details: c.details || "",
               photoId: c.photoId || "", whatsappAt: c.whatsappAt || ""};
    var m = modal("st-car", "Corrective Action Report"); if (!m) return;
    var body = m.querySelector(".pm-body");
    var date = g("svcd") ? g("svcd").value : "";
    var dd = date ? date.split("-").reverse().join("/") : "";
    body.innerHTML =
      "<div style=\"font-size:12px;background:#f0f4f1;border-radius:6px;padding:6px;margin-bottom:8px;line-height:1.5\">" +
      "<b>" + esc(car.carNo || "CAR number: given when saved") + "</b><br>Customer: " + esc(custName()) + "<br>Technician: " + esc(techName() || "(choose in section 8)") +
      "<br>Date: " + esc(dd) + " &middot; Service report: " + esc(window.rNo || "") + (car.deviceId ? "<br>Equipment number: <b>" + esc(car.deviceId) + "</b>" : "") + "</div>" +
      fld("Pest type", sel("st-c-pest", ["Select..."].concat(PESTS), car.pestType)) +
      fld("Observation", "<select class=\"st-c-obs\" style=\"width:100%\"></select>") +
      fld("Correction actioned <span style=\"font-weight:normal;color:#666\">(tick all that apply)</span>", "<div class=\"st-c-cor\" style=\"border:1px solid #ccc;border-radius:4px;padding:4px 6px;background:#fff\"></div>") +
      "<div class=\"st-c-wa\" style=\"display:none;margin:-2px 0 8px\"></div>" +
      fld("Party responsible", sel("st-c-party", ["Select..."].concat(PARTY), car.party)) +
      fld("Location", "<input type=\"text\" class=\"st-c-loc\" style=\"width:100%;box-sizing:border-box\" value=\"" + esc(car.location) + "\">") +
      fld("Details (optional)", "<input type=\"text\" class=\"st-c-det\" style=\"width:100%;box-sizing:border-box\" value=\"" + esc(car.details) + "\">") +
      fld("Photo <span style=\"color:#b00020\">(required)</span>", "<div style=\"display:flex;gap:6px;align-items:center;flex-wrap:wrap\">" +
        "<button type=\"button\" class=\"st-c-cam\" style=\"background:#1a5c38;color:#fff;border:none;border-radius:4px;padding:6px 10px;font-weight:bold\">📷 Take photo</button>" +
        "<button type=\"button\" class=\"st-c-pick\" style=\"background:none;border:1px solid #1a5c38;color:#1a5c38;border-radius:4px;padding:5px 9px;font-weight:bold\">🗂 Saved photos</button>" +
        "<input type=\"file\" accept=\"image/*\" capture=\"environment\" class=\"st-c-file\" style=\"display:none\"><span class=\"st-c-th\"></span></div>") +
      "<div class=\"st-c-err\" style=\"color:#b00020;font-size:12px;min-height:14px\"></div>" +
      "<div class=\"modal-btns\"><button class=\"modal-btn cancel st-x\">Cancel</button><button class=\"modal-btn save st-save\">Save CAR</button></div>";
    var q = function (c2) { return body.querySelector(c2); };
    function fillObs() {
      var p = q(".st-c-pest").value, o = q(".st-c-obs");
      var keys = p && CAR_TREE[p] ? Object.keys(CAR_TREE[p].obs) : [];
      o.innerHTML = "<option value=\"\">Select...</option>" + keys.map(function (k) { return "<option" + (k === car.observation ? " selected" : "") + ">" + esc(k) + "</option>"; }).join("");
      fillCor();
    }
    function fillCor() {
      var p = q(".st-c-pest").value, ob = q(".st-c-obs").value, c3 = q(".st-c-cor");
      var opts = p && ob && CAR_TREE[p] && CAR_TREE[p].obs[ob] ? CAR_TREE[p].obs[ob] : [];
      var have = corParts(car.correction);
      if (opts.length === 1 && !have.length) have = [opts[0]];
      c3.innerHTML = opts.length ? opts.map(function (k) {
        return "<label style=\"display:flex;gap:6px;align-items:flex-start;padding:4px 0;font-size:13px\"><input type=\"checkbox\" class=\"st-c-cor-o\" value=\"" + esc(k) + "\"" +
          (have.indexOf(k) >= 0 ? " checked" : "") + " style=\"margin-top:2px;width:18px;height:18px\"> <span>" + esc(k) + "</span></label>";
      }).join("") : "<span style=\"color:#999;font-size:12px\">Choose the observation first</span>";
      var bx = c3.querySelectorAll(".st-c-cor-o");
      for (var i = 0; i < bx.length; i++) bx[i].onchange = wa;
      wa();
    }
    function corNow() {
      return Array.prototype.slice.call(body.querySelectorAll(".st-c-cor-o")).filter(function (x) { return x.checked; })
        .map(function (x) { return x.value; }).join(COR_SEP);
    }
    function wa() {
      var cor = corNow(), box = q(".st-c-wa");
      if (!cor || !/client|reported|customer|quote/i.test(cor)) { box.style.display = "none"; return; }
      var ct = (S.reg && S.reg.contact) || {};
      box.style.display = "block";
      box.innerHTML = "<button type=\"button\" class=\"st-c-wab\" style=\"background:#25D366;color:#fff;border:none;border-radius:4px;padding:7px 10px;font-weight:bold\">WhatsApp site contact" +
        (ct.name ? " (" + esc(ct.name) + ")" : "") + "</button>" +
        (car.whatsappAt ? " <span style=\"font-size:11px;color:#1a5c38\">opened " + esc(car.whatsappAt) + "</span>" : "") +
        (ct.mobile ? "" : "<div style=\"font-size:11px;color:#a06000\">No site contact mobile on the register - WhatsApp will ask you to choose the chat.</div>");
      q(".st-c-wab").onclick = function () {
        var msg = "Organic Pest Prevention - Corrective Action Report" + (car.carNo ? " " + car.carNo : "") + "\n" +
          custName() + (car.deviceId ? ", device " + car.deviceId : "") + (q(".st-c-loc").value ? " (" + q(".st-c-loc").value + ")" : "") + "\n" +
          "Found: " + q(".st-c-obs").value + "\nAction: " + cor +
          (q(".st-c-party").value ? "\nResponsible: " + q(".st-c-party").value : "") +
          "\n" + (techName() ? techName() + ", " : "") + dd + " - service report " + (window.rNo || "");
        var num = String(ct.mobile || "").replace(/[^0-9]/g, "");
        if (/^0\d{9}$/.test(num)) num = "27" + num.slice(1);
        window.open("https://wa.me/" + (num.length >= 11 ? num : "") + "?text=" + encodeURIComponent(msg), "_blank");
        car.whatsappAt = nowTime(); wa();
      };
    }
    function thumb() {
      var t = q(".st-c-th"), data = car.photoId ? S.photos[car.photoId] : "";
      t.innerHTML = data ? "<img src=\"" + data + "\" style=\"height:52px;border:1px solid #b9d6c2;border-radius:3px;vertical-align:middle\"> <span style=\"font-size:11px;color:#1a5c38\">✔ photo</span>" : "";
    }
    function gotPhoto(rec) { if (!rec) return; S.photos[rec.id] = rec.data; car.photoId = rec.id; thumb(); }
    q(".st-c-pest").onchange = function () { car.observation = ""; car.correction = ""; fillObs(); };
    q(".st-c-obs").onchange = function () { car.correction = ""; fillCor(); };
    q(".st-c-cam").onclick = function () {
      if (window.camOpen) { window.camOpen(function (rec) { gotPhoto(rec); }, function () { if (window.photoFixRequest) window.photoFixRequest(); q(".st-c-file").click(); }); toTop("cam-modal"); }
      else q(".st-c-file").click();
    };
    q(".st-c-pick").onclick = function () { if (window.photoPicker) { window.photoPicker(function (rec) { gotPhoto(rec); var pm = g("photo-pick"); if (pm) pm.classList.remove("show"); }); toTop("photo-pick"); } };
    q(".st-c-file").onchange = function () {
      var f = this.files && this.files[0];
      if (f && window.shrinkImage) window.shrinkImage(f, function (rec) { gotPhoto(rec); });
      this.value = "";
    };
    q(".st-x").onclick = function () { closeModal(m); };
    q(".st-save").onclick = function () {
      car.pestType = q(".st-c-pest").value; car.observation = q(".st-c-obs").value; car.correction = corNow();
      car.party = q(".st-c-party").value; car.location = q(".st-c-loc").value.trim(); car.details = q(".st-c-det").value.trim();
      var miss = [];
      if (!car.pestType) miss.push("pest type"); if (!car.observation) miss.push("observation");
      if (!car.correction) miss.push("correction actioned"); if (!car.party) miss.push("party responsible");
      if (!car.location) miss.push("location"); if (!car.photoId || !S.photos[car.photoId]) miss.push("photo");
      if (miss.length) { q(".st-c-err").textContent = "Still needed: " + miss.join(", ") + "."; return; }
      var i = -1; S.st.cars.forEach(function (x, j) { if (x.localId === car.localId) i = j; });
      if (i >= 0) S.st.cars[i] = car; else S.st.cars.push(car);
      if (d) {
        var prev = S.st.devices[d.id] || {};
        S.st.devices[d.id] = {status: "car", result: car.observation, scanned: scan ? !!scan.scanned : !!prev.scanned,
                              scannedAt: scan ? scan.scannedAt || "" : prev.scannedAt || "", reason: scan ? scan.reason || "" : prev.reason || "",
                              carLocalId: car.localId};
      }
      saveState(); closeModal(m); render();
      if (!car.carNo) reserve(car);
    };
    fillObs(); thumb();
    m.classList.add("show");
  }
  function fld(label, html) {
    return "<div style=\"margin-bottom:8px\"><div style=\"font-size:11px;font-weight:bold;color:#1a5c38;margin-bottom:2px\">" + label + "</div>" + html + "</div>";
  }
  // CAR number from the sheet; with no signal it is given when the report syncs.
  // One request per CAR at a time: the 1.5 s retry used to ask again while the
  // save's own request was still out, so every CAR used two numbers (trial 26/11/2026).
  var _asking = {};
  function reserve(car) {
    if (!gas() || _asking[car.localId]) return;
    _asking[car.localId] = 1;
    var fd = new FormData(); fd.append("payload", JSON.stringify({action: "reserveCarNo"}));
    fetch(gas(), {method: "POST", body: fd}).then(function (r) { return r.json(); }).then(function (res) {
      delete _asking[car.localId];
      if (!res || res.status !== "ok" || !/^CAR-\d+$/.test(res.carNo || "")) return;
      var c = carByLocal(car.localId); if (!c || c.carNo) return;
      c.carNo = res.carNo; saveState(); render();
    }).catch(function () { setTimeout(function () { delete _asking[car.localId]; }, 20000); });
  }
  function retryNumbers() {
    if (!active()) return;
    S.st.cars.forEach(function (c) { if (!c.carNo) reserve(c); });
  }

  // ── section 4 "CAR" cells get the CAR numbers raised on those devices (Larry, 26/11/2026) ──
  function bucketOf(d) {
    var t = String(d.type || "").toLowerCase(), p = pestOf(t);
    if (/bait/.test(t)) return /exterior/.test(t) ? "ext" : "int";
    if (p === "Flies") return "ilt";
    if (p === "Moths") return "moth";
    return "";
  }
  function carCells() {
    var out = {}, rows = document.querySelectorAll("#dbody tr");
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].cells[0] ? rows[i].cells[0].textContent.trim() : "";
      if (name === "Tamper Proof Exterior Rodent Bait Stations") out.ext = rows[i].querySelector(".dcar");
      if (name === "Tamper Proof Interior Rodent Bait Stations") out.int = rows[i].querySelector(".dcar");
      if (name === "Moth Traps") out.moth = rows[i].querySelector(".dcar");
    }
    out.ilt = document.querySelector("#ilt-tbody tr.ilt-device-row .dcar");
    return out;
  }
  // The PDF's CAR column is narrow and its widths must not change (the bait station
  // check and the Site Report read that table), so the cell holds the short numbers:
  // CAR-00002 and CAR-00003 -> "2,3". The full numbers are on the CAR pages.
  function carText(list) {
    return list.map(function (n) { var m = /^CAR-0*(\d+)$/.exec(String(n)); return m ? m[1] : "?"; }).join(",");
  }
  function fillCarCells() {
    var cells = carCells(), by = {ext: [], int: [], ilt: [], moth: []};
    S.st.cars.forEach(function (c) {
      var d = c.deviceId ? devById(c.deviceId) : null, b = d ? bucketOf(d) : "";
      if (b) by[b].push(c.carNo || "pending");
    });
    Object.keys(by).forEach(function (b) {
      var el = cells[b]; if (!el) return;
      var v = carText(by[b]);
      if (!v && !el.dataset.stCar) return;            // never touch a cell the technician filled himself
      if (el.value !== v) {
        el.value = v;
        try { el.dispatchEvent(new Event("input", {bubbles: true})); } catch (e) {}
      }
      if (v) {
        el.dataset.stCar = "1"; el.readOnly = true; el.style.background = "#e8f3ec";
        el.style.width = Math.max(38, v.length * 7 + 6) + "px";
        el.title = "CARs raised on these devices: " + by[b].join(", ");
      } else { delete el.dataset.stCar; el.readOnly = false; el.style.background = ""; el.style.width = "38px"; }
    });
  }
  function clearCarCells() {
    var els = document.querySelectorAll(".dcar[data-st-car]");
    for (var i = 0; i < els.length; i++) {
      els[i].value = ""; els[i].readOnly = false; els[i].style.background = ""; els[i].style.width = "38px";
      delete els[i].dataset.stCar;
    }
  }

  // ── a "quoted" correction puts a line in section 7, so the quote request goes to the
  //    office with the report and can't be forgotten (Larry, 26/11/2026) ──
  function isQuoteCar(c) { return corParts(c.correction).some(function (x) { return /quot/i.test(x); }); }
  function quoteTail(c) { return [c.deviceId, c.location].filter(function (x) { return x; }).join(" "); }
  function quoteArea(c) { return (c.carNo || "CAR") + " " + quoteTail(c); }
  function quoteRowFor(c) {
    var rows = document.querySelectorAll("#quote-body tr"), tail = quoteTail(c);
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute("data-st-car") === c.localId) return rows[i];
    for (var j = 0; j < rows.length; j++) {          // a draft restore brings the row back without its tag
      var a = rows[j].querySelector(".quote-area"), v = a ? a.value : "";
      if (/^CAR/.test(v) && v.slice(-tail.length) === tail && !rows[j].getAttribute("data-st-car")) {
        rows[j].setAttribute("data-st-car", c.localId); return rows[j];
      }
    }
    return null;
  }
  function syncQuotes() {
    if (!g("quote-body") || !window.addQuoteRow) return;
    var want = {};
    S.st.cars.forEach(function (c) {
      if (!isQuoteCar(c)) return;
      want[c.localId] = 1;
      var r = quoteRowFor(c);
      if (!r) {
        window.addQuoteRow(); r = g("quote-body").lastElementChild; if (!r) return;
        r.setAttribute("data-st-car", c.localId);
        var cat = r.querySelector(".quote-cat");
        if (cat && (window.QUOTE_CATS || []).indexOf(c.pestType) >= 0) {
          cat.value = c.pestType;
          try { cat.dispatchEvent(new Event("change", {bubbles: true})); } catch (e) {}
        }
        var q = r.querySelector("input[type=number]"); if (q && !q.value) q.value = "1";
      }
      var a = r.querySelector(".quote-area");
      if (a && a.value !== quoteArea(c)) a.value = quoteArea(c);
      r.style.background = "#fff8e1";
    });
    var rows = document.querySelectorAll("#quote-body tr[data-st-car]");
    for (var i = 0; i < rows.length; i++) if (!want[rows[i].getAttribute("data-st-car")]) rows[i].parentNode.removeChild(rows[i]);
  }
  function dropQuoteRows() {
    var rows = document.querySelectorAll("#quote-body tr[data-st-car]");
    for (var i = 0; i < rows.length; i++) rows[i].parentNode.removeChild(rows[i]);
  }
  function quoteErrors() {
    var out = [];
    S.st.cars.forEach(function (c) {
      if (!isQuoteCar(c)) return;
      var r = quoteRowFor(c), it = r ? r.querySelector(".quote-item") : null;
      if (!it || !it.value || it.value === "Select item")
        out.push("Section 7: choose the item to quote for " + (c.carNo || "the CAR") + (c.deviceId ? " (device " + c.deviceId + ")" : "") + ".");
    });
    return out;
  }

  // ── what index.html asks for ──
  function errors() {
    if (!active() || !devicesServiced()) return [];
    var out = [], left = S.reg.devices.filter(function (d) { return !done(d); });
    if (left.length) out.push("Bait stations & devices: " + left.length + " of " + S.reg.devices.length +
      " not done yet - " + left.map(function (d) { return d.id; }).join(", ") + ". Scan each one (or mark it missing).");
    S.st.cars.forEach(function (c) { if (!c.photoId || !S.photos[c.photoId]) out.push((c.carNo || "A CAR") + " has no photo."); });
    var day = g("svcd") ? g("svcd").value : "";
    ((S.reg && S.reg.openCars) || []).forEach(function (c) {
      var f = S.st.followUps[c.carNo] || {};
      if (fuDue(c, day) && (!f.status || !f.observation))
        out.push("Follow-up of " + c.carNo + (c.deviceId ? " (device " + c.deviceId + ")" : "") + " is due: choose what you found and the status.");
      else if (f.status === "In progress" && !f.action)
        out.push("Follow-up of " + c.carNo + ": say what action you took.");
    });
    return out.concat(quoteErrors());
  }
  function payload() {
    if (!active()) return null;
    var devs = S.reg.devices.map(function (d) {
      var s = devState(d.id) || {}, c = s.carLocalId ? carByLocal(s.carLocalId) : null;
      return {id: d.id, type: d.type, location: d.location, status: s.status || "", result: s.result || "",
              scanned: !!s.scanned, scannedAt: s.scannedAt || "", reason: s.reason || "",
              carLocalId: s.carLocalId || "", carNo: c ? c.carNo || "" : ""};
    });
    var cars = S.st.cars.map(function (c) {
      return {localId: c.localId, carNo: c.carNo || "", deviceId: c.deviceId || "", pestType: c.pestType, observation: c.observation,
              correction: c.correction, party: c.party, location: c.location, details: c.details || "",
              photo: S.photos[c.photoId] || "", photoId: c.photoId || "", whatsappAt: c.whatsappAt || "",
              status: closedAtCreation(c.correction) ? "Closed" : "Open"};
    });
    var date = g("svcd") ? g("svcd").value : "";
    var fus = Object.keys(S.st.followUps).map(function (no) {
      var f = S.st.followUps[no], c0 = null;
      ((S.reg.openCars) || []).forEach(function (x) { if (x.carNo === no) c0 = x; });
      if (!c0) return null;
      return {carNo: no, date: date, visitNo: (+c0.visits || 0) + 1, status: f.status || "", observation: f.observation || "",
              action: f.action || "", pestType: c0.pestType || "", deviceId: c0.deviceId || "", carObservation: c0.observation || "",
              raised: c0.raised || ""};
    }).filter(function (x) { return x && (x.status || x.observation || x.action); });
    return {siteCode: S.reg.siteCode, onSite: S.reg.devices.length,
            done: S.reg.devices.filter(done).length, devices: devs, cars: cars, followUps: fus,
            openAfter: openCarsAfter(), contact: (S.reg.contact && S.reg.contact.name) || ""};
  }
  // CAR photos are not kept inside the saved report on the phone: six photos filled the phone's
  // storage in the trial (26/11/2026) and the office got a blank PDF. The photo store keeps them
  // (30 days after use); fill() puts them back before a PDF is made or a report is sent.
  function lean(d) {
    if (!d || !d.stationCheck || !Array.isArray(d.stationCheck.cars)) return d;
    var c = JSON.parse(JSON.stringify(d));
    c.stationCheck.cars.forEach(function (x) { if (x.photoId) x.photo = ""; });
    return c;
  }
  function fill(d, cb) {
    var cars = d && d.stationCheck && Array.isArray(d.stationCheck.cars) ? d.stationCheck.cars : [];
    var want = cars.filter(function (x) { return x.photoId && !x.photo; });
    if (!want.length || !window.photoAll) { cb(d); return; }
    var called = false, t = setTimeout(function () { if (!called) { called = true; cb(d); } }, 6000);
    window.photoAll(function (all) {
      if (called) return;
      var by = {}; (all || []).forEach(function (r) { by[r.id] = r.data; });
      want.forEach(function (x) { if (by[x.photoId]) x.photo = by[x.photoId]; });
      called = true; clearTimeout(t); cb(d);
    });
  }
  function onSaved(d) {
    try {
      var ids = S.st ? S.st.cars.map(function (c) { return c.photoId; }).filter(function (x) { return x; }) : [];
      if (ids.length && window.photoMarkUsed) window.photoMarkUsed(ids, d.reportNo);
    } catch (e) {}
    lsDel(LS_STATE + (d && d.reportNo));
  }

  // ── PDF pages (called at the end of buildPDF_) ──
  function pdfPages(doc, data, K) {
    var sc = data && data.stationCheck; if (!sc || !sc.devices) return;
    var M = K.M, CW = K.CW, H = K.H, G = K.G, y;
    function head(t) {
      doc.addPage(); y = 12;
      doc.setFillColor(G[0], G[1], G[2]); doc.rect(M, y, CW, 6, "F");
      doc.setTextColor(255, 255, 255); doc.setFontSize(8); doc.setFont("helvetica", "bold");
      doc.text(t, M + 2, y + 4.2); y += 9; doc.setTextColor(30, 30, 30);
    }
    function line(t, bold, size) {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size || 8);
      var ls = doc.splitTextToSize(String(t || ""), CW);
      doc.text(ls, M, y); y += ls.length * (size ? size * 0.42 : 3.6);
    }
    head("BAIT STATIONS & DEVICES - " + (data.customer || "") + " - " + (data.reportNo || ""));
    var scanned = sc.devices.filter(function (x) { return x.scanned; }).length;
    var newOpen = (sc.cars || []).filter(function (c) { return c.status === "Open"; }).length;
    line("On site: " + sc.onSite + "    Serviced: " + sc.done + " (" + scanned + " scanned, " + (sc.done - scanned) + " not scanned)    CARs raised: " +
      (sc.cars || []).length + " (" + newOpen + " open)    Open CARs after this visit: " + (sc.openAfter || 0), true, 8.5);
    y += 2;
    var cols = [["Device", 0.09], ["Type", 0.22], ["Location", 0.21], ["Result", 0.26], ["Scanned", 0.12], ["CAR", 0.10]];
    function row(vals, hdr) {
      var x = M, h = 5.2;
      if (hdr) { doc.setFillColor(240, 244, 241); doc.rect(M, y - 3.6, CW, h, "F"); }
      doc.setFont("helvetica", hdr ? "bold" : "normal"); doc.setFontSize(7);
      vals.forEach(function (v, i) {
        var w = CW * cols[i][1];
        doc.text(doc.splitTextToSize(String(v || ""), w - 1.5)[0] || "", x + 1, y);
        x += w;
      });
      doc.setDrawColor(221, 221, 216); doc.setLineWidth(0.2); doc.line(M, y + 1.6, M + CW, y + 1.6);
      y += h;
    }
    row(cols.map(function (c) { return c[0]; }), true);
    sc.devices.forEach(function (x) {
      if (y > H - 15) { head("BAIT STATIONS & DEVICES (continued) - " + (data.reportNo || "")); row(cols.map(function (c) { return c[0]; }), true); }
      row([x.id, x.type, x.location, x.status === "ok" ? x.result : x.status === "car" ? x.result : "NOT DONE",
           x.scanned ? (x.scannedAt || "Y").slice(-5) : "No" + (x.reason ? " - " + x.reason : ""), x.carNo || (x.status === "car" ? "pending" : "")]);
    });
    if ((sc.followUps || []).length) {
      y += 3; line("Follow-ups of open CARs", true, 8.5); y += 1;
      sc.followUps.forEach(function (f) {
        line(f.carNo + (f.deviceId ? " (" + f.deviceId + ")" : "") + " raised " + String(f.raised || "").split("-").reverse().join("/") + " - " +
             (f.carObservation || "") + ".  Follow-up visit No. " + (f.visitNo || "") + ": " + (f.observation || "-") +
             (f.action ? "; action taken: " + f.action : "") + ".  Status: " + (f.status || "-"));
      });
    }
    (sc.cars || []).forEach(function (c) {
      head("CORRECTIVE ACTION REPORT " + (c.carNo || "(number given on sync)") + " - " + (data.reportNo || ""));
      var dd = String(data.date || "").split("-").reverse().join("/");
      var flds = [["Customer", data.customer], ["Technician", data.techName], ["Date", dd], ["Service report number", data.reportNo],
                  ["Equipment number", c.deviceId || "-"], ["Location", c.location], ["Pest type", c.pestType], ["Observation", c.observation],
                  ["Correction actioned", c.correction], ["Party responsible", c.party], ["Details", c.details || "-"],
                  ["Status", c.status === "Closed" ? "Closed - corrected on the day" : "Open - follow-up required"]];
      if (c.whatsappAt) flds.push(["Site contact advised", "WhatsApp " + c.whatsappAt + (sc.contact ? " (" + sc.contact + ")" : "")]);
      flds.forEach(function (f) {
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.text(f[0] + ":", M, y);
        doc.setFont("helvetica", "normal");
        var ls = doc.splitTextToSize(String(f[1] || ""), CW - 45); doc.text(ls, M + 45, y); y += Math.max(1, ls.length) * 4.2;
      });
      if (c.photo) {
        y += 2;
        // keep the photo's own shape (a portrait phone photo was squashed into 4:3 - trial 26/11/2026)
        var maxW = CW * 0.7, maxH = Math.max(40, H - y - 30), ratio = 0.75;
        try { var ip = doc.getImageProperties(c.photo); if (ip && ip.width && ip.height) ratio = ip.height / ip.width; } catch (e) {}
        var pw = maxW, ph = pw * ratio;
        if (ph > maxH) { ph = maxH; pw = ph / ratio; }
        try { doc.addImage(c.photo, "JPEG", M, y, pw, ph, undefined, "FAST"); } catch (e) {}
        doc.setDrawColor(221, 221, 216); doc.rect(M, y, pw, ph); y += ph + 4;
      }
      y = Math.max(y, H - 24);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8);
      doc.text("Customer - checked by: " + (data.custConfirm || "") + "        Signature: " + (data.signatureData && data.signatureData !== "UNSIGNED" ? "signed on the service report" : "") + "        Date: " + dd, M, y);
    });
  }

  window.ST = {active: active, errors: errors, payload: payload, onSaved: onSaved, pdfPages: pdfPages, lean: lean, fill: fill,
               _state: function () { return S; }, _check: check, _refreshSites: refreshSites, _onCode: onCode, CAR_TREE: CAR_TREE};

  // keep only the 15 newest report states on the phone
  function housekeep() {
    try {
      var ks = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(LS_STATE) === 0) ks.push(k); }
      ks.sort(); ks.slice(0, Math.max(0, ks.length - 15)).forEach(lsDel);
    } catch (e) {}
  }
  function start() {
    try {
      housekeep();
      refreshSites(false);
      var cs = g("cs"); if (cs) cs.addEventListener("change", function () { refreshSites(false, 120000); setTimeout(check, 50); });
      var ss = g("site-sel"); if (ss) ss.addEventListener("change", function () { setTimeout(check, 50); });
      setInterval(function () { try { check(); retryNumbers(); } catch (e) {} }, 1500);
      check();
    } catch (e) { console.log("stations.js start:", e && e.message); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
