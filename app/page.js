"use client";
import React, { useState, useEffect, useRef } from 'react';
import './globals.css';

var API = '/api';
function tk() { if (typeof window === 'undefined') return ''; return localStorage.getItem('prov_tk') || ''; }
function setTk(t) { if (typeof window === 'undefined') return; t ? localStorage.setItem('prov_tk', t) : localStorage.removeItem('prov_tk'); }
function toast(msg) { var el = document.getElementById('toast'); if (!el) return; el.textContent = msg; el.classList.add('show'); setTimeout(function() { el.classList.remove('show'); }, 2500); }

async function api(u, o) {
  var h = { 'Content-Type': 'application/json' }; var t = tk(); if (t) h['Authorization'] = 'Bearer ' + t;
  try { var r = await fetch(u, Object.assign({ headers: h }, o || {})); var j = await r.json();
    if (r.status === 401) { setTk(null); location.reload(); }
    if (!r.ok && r.status !== 401 && j.error) { toast('Error: ' + j.error); }
    return j; }
  catch (e) { toast('Network error'); return { error: 'Network error: ' + e.message }; }
}
var G = function(u) { return api(API + '/' + u); };
var P = function(u, b) { return api(API + '/' + u, { method: 'POST', body: JSON.stringify(b) }); };
var U = function(u, b) { return api(API + '/' + u, { method: 'PUT', body: JSON.stringify(b) }); };

var SNAMES = ['', 'Leadership & Oversight', 'Systems & Technology', 'Bookkeeping & Monthly Finances', 'Donations, Revenue & Restricted Funds', 'Spending & Approvals', 'Payroll & People', 'Financial Reporting', 'Audits & Compliance', 'Policies & Documentation', 'Data Quality & Records', 'Cash, Banking & Reserves', 'Risk, Insurance & Safety', 'Budgeting & Planning'];
var EWORDS = ['confident', 'concerned', 'overwhelmed', 'hopeful', 'uncertain', 'frustrated', 'encouraged', 'afraid', 'empowered', 'lost'];
var ELABELS = ['Confident', 'Concerned', 'Overwhelmed', 'Hopeful', 'Uncertain', 'Frustrated', 'Encouraged', 'Afraid', 'Empowered', 'Lost'];
function sc(s) { return s > 3.5 ? 'var(--gr)' : s > 2.5 ? 'var(--bl)' : s > 2.0 ? 'var(--am)' : 'var(--r)'; }

function getInviteToken() { if (typeof window === 'undefined') return null; var p = new URLSearchParams(window.location.search); return p.get('invite') || null; }
function getResetToken() { if (typeof window === 'undefined') return null; var p = new URLSearchParams(window.location.search); return p.get('reset') || null; }

var TextInput = React.memo(function TextInput(props) {
  var _s = useState(props.value || '');
  var local = _s[0]; var setLocal = _s[1];
  var timerRef = useRef(null);
  var onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(function() { setLocal(props.value || ''); }, [props.value]);

  function handleChange(e) {
    var v = e.target.value;
    setLocal(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(function() { onChangeRef.current(v); }, 800);
  }

  function handleBlur() {
    if (timerRef.current) clearTimeout(timerRef.current);
    onChangeRef.current(local);
  }

  if (props.rows) {
    return React.createElement('textarea', { className: 'inp', rows: props.rows, value: local, onChange: handleChange, onBlur: handleBlur, placeholder: props.placeholder || '' });
  }
  return React.createElement('input', { className: 'inp', type: props.type || 'text', style: props.style, value: local, onChange: handleChange, onBlur: handleBlur, placeholder: props.placeholder || '' });
});

export default function App() {
  var [ready, setReady] = useState(false);
  var [loading, setLoading] = useState(null);
  var [user, setUser] = useState(null);
  var [page, setPage] = useState('home');
  var [mode, setMode] = useState('login');
  var [fN, setFN] = useState(''); var [fE, setFE] = useState(''); var [fP, setFP] = useState(''); var [authErr, setAE] = useState('');
  var [orgs, setOrgs] = useState([]); var [activeOrg, setAO] = useState(null); var [orgForm, setOF] = useState(null);
  var [questions, setQs] = useState([]);
  var [answers, setAnswers] = useState({}); var [pulses, setPulses] = useState({});
  var [respondent, setResp] = useState(null); var [curSec, setCurSec] = useState(0);
  var [profileDone, setPD] = useState(false);
  var [report, setReport] = useState(null); var [generating, setGen] = useState(false);
  var [invites, setInvites] = useState([]); var [invEmail, setIE] = useState('');
  var [dashPage, setDP] = useState('dashboard');
  var [pendingInvite, setPI] = useState(null);
  var [resetToken, setRT] = useState(null);
  var [resetPass, setRP] = useState('');
  var [resetPass2, setRP2] = useState('');
  var [resetMsg, setRM] = useState('');

  var saveTimer = useRef(null);
  var [saveStatus, setSaveStatus] = useState('');

  useEffect(function() {
    setPI(getInviteToken());
    var rt = getResetToken();
    if (rt) { setRT(rt); setMode('reset'); }
  }, []);

  useEffect(function() {
    if (pendingInvite === null && typeof window !== 'undefined' && getInviteToken()) return;
    (async function() {
      if (pendingInvite && !tk()) {
        setMode('signup');
        setReady(true);
        return;
      }
      if (pendingInvite && tk()) {
        var ir = await P('assess?action=accept_invite', { token: pendingInvite });
        if (ir.ok) {
          setPI(null);
          window.history.replaceState({}, '', window.location.pathname);
        }
      }
      if (!tk()) { setReady(true); return; }
      var r = await G('auth?action=check');
      if (r.authenticated) {
        setUser(r.user);
        var o = await G('orgs');
        setOrgs(o.orgs || []);
        if (o.orgs && o.orgs.length > 0) { setAO(o.orgs[0].id); await loadOrg(o.orgs[0].id); }
      }
      setReady(true);
    })();
  }, [pendingInvite]);

  async function loadOrg(oid) {
    var q = await G('assess?action=questions&org_id=' + oid); setQs(q.questions || []);
    var a = await G('assess?org_id=' + oid);
    var parsedAnswers = a.answers || {};
    var qMap = {}; (q.questions || []).forEach(function(qi) { qMap[qi.code] = qi; });
    Object.keys(parsedAnswers).forEach(function(code) {
      if (qMap[code] && qMap[code].question_type === 'select_multi' && typeof parsedAnswers[code] === 'string') {
        try { parsedAnswers[code] = JSON.parse(parsedAnswers[code]); } catch (e) { parsedAnswers[code] = parsedAnswers[code].split(',').map(function(s) { return s.trim(); }); }
      }
    });
    setAnswers(parsedAnswers);
    setPulses(a.pulses || {}); setResp(a.respondent || null);
    if (a.respondent && a.respondent.status !== 'invited') setPD(true);
    var rp = await G('report?org_id=' + oid); setReport(rp.report ? rp.report.report_json : null);
    var inv = await G('assess?action=invites&org_id=' + oid); setInvites(inv.invites || []);
  }

  async function doAuth() {
    setAE(''); var em = fE.toLowerCase().trim();
    if (!em || !fP) { setAE('Fill all fields'); return; }
    var r;
    if (mode === 'signup') { if (!fN) { setAE('Enter name'); return; } r = await P('auth?action=register', { name: fN, email: em, password: fP }); }
    else r = await P('auth?action=login', { email: em, password: fP });
    if (r.error) { setAE(r.error); return; }
    setTk(r.token); setUser(r.user);
    if (pendingInvite) {
      var ir = await P('assess?action=accept_invite', { token: pendingInvite });
      setPI(null); window.history.replaceState({}, '', window.location.pathname);
      if (ir.ok && ir.org_id) {
        setAO(ir.org_id); await loadOrg(ir.org_id);
        var o = await G('orgs'); setOrgs(o.orgs || []);
        setPage('assess'); setReady(true); return;
      }
    }
    var o = await G('orgs'); setOrgs(o.orgs || []);
    if (o.orgs && o.orgs.length > 0) { setAO(o.orgs[0].id); await loadOrg(o.orgs[0].id); }
    setPage('home');
  }

  async function logout() { await P('auth?action=logout', {}); setTk(null); setUser(null); setOrgs([]); setAO(null); setReport(null); setAnswers({}); setPulses({}); }

  async function doForgotPassword() {
    setAE(''); setRM('');
    var em = fE.toLowerCase().trim();
    if (!em) { setAE('Enter your email address'); return; }
    setLoading('Sending reset link...');
    var r = await P('auth?action=forgot_password', { email: em });
    setLoading(null);
    if (r.error) { setAE(r.error); return; }
    setRM(r.message || 'Check your email for a reset link.');
    // In dev/test mode, show the reset URL if returned
    if (r._dev_reset_url) {
      setRM('Reset link generated. Open this URL to reset your password:\n' + r._dev_reset_url);
    }
  }

  async function doResetPassword() {
    setAE(''); setRM('');
    if (!resetPass || resetPass.length < 8) { setAE('Password must be at least 8 characters'); return; }
    if (resetPass !== resetPass2) { setAE('Passwords do not match'); return; }
    setLoading('Resetting password...');
    var r = await P('auth?action=reset_password', { token: resetToken, password: resetPass });
    setLoading(null);
    if (r.error) { setAE(r.error); return; }
    setRM(r.message || 'Password updated!');
    setRT(null); setRP(''); setRP2('');
    window.history.replaceState({}, '', window.location.pathname);
    setTimeout(function() { setMode('login'); setRM(''); }, 2000);
  }

  async function saveOrg() {
    if (!orgForm || !orgForm.name) return;
    setLoading('Saving organization...');
    var r = orgForm.id ? await U('orgs?id=' + orgForm.id, orgForm) : await P('orgs', orgForm);
    setLoading(null);
    if (r.error) { alert(r.error); return; }
    var o = await G('orgs'); setOrgs(o.orgs || []);
    if (r.org) { setAO(r.org.id); await loadOrg(r.org.id); }
    setOF(null); setPage('home'); toast('Organization saved');
  }

  function setA(code, val) {
    setAnswers(function(prev) { var n = Object.assign({}, prev); n[code] = val; return n; });
    setSaveStatus('unsaved');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(function() {
      if (activeOrg && curSec >= 1 && curSec <= 13) saveAnswerBatch(curSec);
    }, 3000);
  }

  async function saveAnswerBatch(secNum) {
    if (!activeOrg) return;
    var secQ = questions.filter(function(q) { return q.section_number === secNum && q.part === 'S'; });
    var batch = secQ.map(function(q) { return { code: q.code, value: answers[q.code] || '', section: secNum }; }).filter(function(a) { return a.value !== ''; });
    if (batch.length > 0) { var r = await P('assess?action=save_answers&org_id=' + activeOrg, { answers: batch }); if (r.ok) { setSaveStatus('saved'); setTimeout(function() { setSaveStatus(''); }, 2000); } else { setSaveStatus('error'); } }
  }

  async function savePulse(point, secNum, words, why) {
    if (!activeOrg) return;
    await P('assess?action=save_pulse&org_id=' + activeOrg, { pulse_point: point, section_number: secNum, words: words, why: why || '' });
  }

  async function saveProfile(data) {
    if (!activeOrg) return;
    setLoading('Saving profile...');
    await P('assess?action=profile&org_id=' + activeOrg, data);
    setLoading(null); setPD(true); toast('Profile saved');
  }

  async function completeAssessment(rating) {
    if (!activeOrg) return;
    setLoading('Submitting assessment...');
    await P('assess?action=complete&org_id=' + activeOrg, { experience_rating: rating });
    setLoading(null); toast('Assessment submitted!'); setPage('home');
  }

  async function genReport() {
    if (!activeOrg) return;
    setGen(true); setLoading('Generating your report... This takes 15-30 seconds.');
    var r = await P('report?org_id=' + activeOrg, {});
    setLoading(null); setGen(false);
    if (r.error) { alert('Report generation failed: ' + r.error + (r.parseError ? '\n\nParse error: ' + r.parseError : '') + (r.raw ? '\n\nRaw start: ' + r.raw : '')); return; }
    setReport(r.report.report_json); setPage('report'); setDP('dashboard'); toast('Report generated!');
  }

  async function sendInvite() {
    if (!activeOrg || !invEmail.trim()) return;
    var r = await P('assess?action=invite&org_id=' + activeOrg, { email: invEmail.trim() });
    if (r.error) { alert(r.error); return; }
    if (r.invite_url) {
      try { navigator.clipboard.writeText(r.invite_url); toast('Invite link copied to clipboard!'); }
      catch (e) { prompt('Share this invite link:', r.invite_url); }
    }
    setIE('');
    var inv = await G('assess?action=invites&org_id=' + activeOrg); setInvites(inv.invites || []);
  }

  async function revokeInvite(invUuid) {
    if (!confirm('Revoke this invitation? The invite link will no longer work.')) return;
    var r = await P('assess?action=revoke_invite&org_id=' + activeOrg, { invite_uuid: invUuid });
    if (r.error) { alert(r.error); return; }
    toast('Invite revoked');
    var inv = await G('assess?action=invites&org_id=' + activeOrg); setInvites(inv.invites || []);
  }

  function secQs(sec) { return questions.filter(function(q) { return Number(q.section_number) === sec && q.part === 'S' && !q.version_retired; }); }
  function setPulseW(point, word) {
    setPulses(function(prev) { var n = Object.assign({}, prev); var cur = n[point] || { words: [], why: '' }; var ws = cur.words.slice();
      var idx = ws.indexOf(word); if (idx >= 0) ws.splice(idx, 1); else if (ws.length < 3) ws.push(word);
      n[point] = { words: ws, why: cur.why }; return n; });
  }

  var co = orgs.find(function(o) { return o.id == activeOrg; });
  var answeredSec = 0; for (var i = 1; i <= 13; i++) { if (secQs(i).some(function(q) { return answers[q.code]; })) answeredSec++; }
  var progressPct = Math.round(answeredSec / 13 * 100);

  if (!ready) return React.createElement('div', { style: { minHeight: '100vh', background: 'var(--bg)' } });

  var loadingEl = loading ? React.createElement('div', { className: 'loading-overlay' },
    React.createElement('div', { className: 'spinner' }),
    React.createElement('div', { className: 'loading-text' }, loading)
  ) : null;

  // AUTH SCREEN
  if (!user) return (
    React.createElement('div', { style: { minHeight: '100vh', background: 'var(--bg)' } },
      loadingEl,
      React.createElement('div', { id: 'toast', className: 'toast' }),
      React.createElement('div', { style: { background: 'var(--n)', padding: '48px 20px 36px', textAlign: 'center' } },
        React.createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 14 } },
          React.createElement('img', { src: '/logo-icon.svg', alt: 'Provident', style: { width: 40, height: 40, borderRadius: '50%' } }),
          React.createElement('div', { style: { textAlign: 'left' } },
            React.createElement('span', { style: { fontFamily: "'Goudy Bookletter 1911','Georgia',serif", fontWeight: 700, fontSize: 22, color: '#fff', display: 'block' } }, 'Provident'),
            React.createElement('span', { style: { fontFamily: "'Montserrat',sans-serif", fontWeight: 500, fontSize: 10, color: 'var(--g)', letterSpacing: 2, textTransform: 'uppercase' } }, 'Accountability')
          )
        ),
        React.createElement('h1', { style: { fontFamily: "'Goudy Bookletter 1911','Georgia',serif", fontSize: 26, color: '#fff', margin: '12px 0 6px' } }, 'Financial Stewardship Assessment'),
        React.createElement('p', { style: { fontFamily: "'Montserrat',sans-serif", fontSize: 14, color: 'rgba(255,255,255,.5)', maxWidth: 400, margin: '0 auto' } }, "Know where you stand. See where you're going."),
        pendingInvite ? React.createElement('div', { style: { marginTop: 16, padding: '8px 16px', borderRadius: 8, background: 'rgba(206,157,49,.15)', display: 'inline-block' } }, React.createElement('span', { style: { color: 'var(--g)', fontSize: 13, fontWeight: 600 } }, "You've been invited to take an assessment. " + (mode === 'login' ? 'Sign in or create an account to begin.' : 'Create an account to begin.'))) : null
      ),
      React.createElement('div', { style: { display: 'flex', justifyContent: 'center', padding: '36px 20px 60px' } },
        React.createElement('div', { style: { width: '100%', maxWidth: 400 } },

          // Reset password form (from ?reset=TOKEN link)
          mode === 'reset' ? React.createElement('div', null,
            React.createElement('div', { className: 'card' },
              React.createElement('h3', { style: { fontSize: 16, marginBottom: 12 } }, 'Set New Password'),
              React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'New Password'), React.createElement('input', { className: 'inp', type: 'password', value: resetPass, onChange: function(e) { setRP(e.target.value); }, placeholder: 'At least 8 characters' })),
              React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Confirm Password'), React.createElement('input', { className: 'inp', type: 'password', value: resetPass2, onChange: function(e) { setRP2(e.target.value); }, onKeyDown: function(e) { if (e.key === 'Enter') doResetPassword(); } })),
              authErr ? React.createElement('p', { style: { fontSize: 13, color: 'var(--r)', margin: '0 0 10px' } }, authErr) : null,
              resetMsg ? React.createElement('p', { style: { fontSize: 13, color: 'var(--gr)', margin: '0 0 10px' } }, resetMsg) : null,
              React.createElement('button', { className: 'btn btn-p btn-full', onClick: doResetPassword }, 'Reset Password'),
              React.createElement('div', { style: { textAlign: 'center', marginTop: 12 } },
                React.createElement('button', { style: { background: 'none', border: 'none', color: 'var(--mt)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }, onClick: function() { setMode('login'); setAE(''); setRM(''); setRT(null); window.history.replaceState({}, '', window.location.pathname); } }, 'Back to Sign In')
              )
            )
          ) :

          // Forgot password form
          mode === 'forgot' ? React.createElement('div', null,
            React.createElement('div', { className: 'card' },
              React.createElement('h3', { style: { fontSize: 16, marginBottom: 4 } }, 'Forgot Password'),
              React.createElement('p', { className: 'mt', style: { marginBottom: 16 } }, 'Enter your email and we\'ll generate a reset link.'),
              React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Email'), React.createElement('input', { className: 'inp', type: 'email', value: fE, onChange: function(e) { setFE(e.target.value); }, onKeyDown: function(e) { if (e.key === 'Enter') doForgotPassword(); } })),
              authErr ? React.createElement('p', { style: { fontSize: 13, color: 'var(--r)', margin: '0 0 10px' } }, authErr) : null,
              resetMsg ? React.createElement('p', { style: { fontSize: 13, color: 'var(--gr)', margin: '0 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, resetMsg) : null,
              React.createElement('button', { className: 'btn btn-p btn-full', onClick: doForgotPassword }, 'Send Reset Link'),
              React.createElement('div', { style: { textAlign: 'center', marginTop: 12 } },
                React.createElement('button', { style: { background: 'none', border: 'none', color: 'var(--mt)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }, onClick: function() { setMode('login'); setAE(''); setRM(''); } }, 'Back to Sign In')
              )
            )
          ) :

          // Login / Signup forms
          React.createElement('div', null,
            React.createElement('div', { style: { display: 'flex', background: 'var(--stone)', borderRadius: 8, padding: 3, marginBottom: 24 } },
              React.createElement('button', { onClick: function() { setMode('login'); setAE(''); }, style: { flex: 1, padding: '9px 0', borderRadius: 6, background: mode === 'login' ? 'var(--w)' : 'transparent', color: mode === 'login' ? 'var(--n)' : 'var(--mt)', fontWeight: 600, fontSize: 13, border: 'none', cursor: 'pointer' } }, 'Sign In'),
              React.createElement('button', { onClick: function() { setMode('signup'); setAE(''); }, style: { flex: 1, padding: '9px 0', borderRadius: 6, background: mode === 'signup' ? 'var(--w)' : 'transparent', color: mode === 'signup' ? 'var(--n)' : 'var(--mt)', fontWeight: 600, fontSize: 13, border: 'none', cursor: 'pointer' } }, 'Create Account')
            ),
            React.createElement('div', { className: 'card' },
              mode === 'signup' ? React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Full Name'), React.createElement('input', { className: 'inp', value: fN, onChange: function(e) { setFN(e.target.value); } })) : null,
              React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Email'), React.createElement('input', { className: 'inp', type: 'email', value: fE, onChange: function(e) { setFE(e.target.value); } })),
              React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Password'), React.createElement('input', { className: 'inp', type: 'password', value: fP, onChange: function(e) { setFP(e.target.value); }, onKeyDown: function(e) { if (e.key === 'Enter') doAuth(); } })),
              authErr ? React.createElement('p', { style: { fontSize: 13, color: 'var(--r)', margin: '0 0 10px' } }, authErr) : null,
              React.createElement('button', { className: 'btn btn-p btn-full', onClick: doAuth }, mode === 'login' ? 'Sign In' : 'Create Account'),
              mode === 'login' ? React.createElement('div', { style: { textAlign: 'center', marginTop: 12 } },
                React.createElement('button', { style: { background: 'none', border: 'none', color: 'var(--mt)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }, onClick: function() { setMode('forgot'); setAE(''); setRM(''); } }, 'Forgot password?')
              ) : null
            )
          )
        )
      )
    )
  );

  // ORG SETUP
  if (page === 'org_edit' && orgForm) {
    var fields = [
      { k: 'name', l: 'Organization Name *', t: 'text' },
      { k: 'org_type', l: 'Type (A1)', t: 'select', o: ['Church or religious congregation', 'Denomination or association', 'Foundation', 'Human services', 'Education', 'Healthcare', 'Arts & culture', 'Environmental', 'International', 'Community development', 'Other'] },
      { k: 'irs_classification', l: 'IRS Classification (A2)', t: 'select', o: ['501(c)(3)', '501(c)(4)', '501(c)(6)', 'Other', 'State-exempt only', 'Not sure'] },
      { k: 'denomination', l: 'Denomination (A3)', t: 'text', ph: 'Free text' },
      { k: 'annual_budget', l: 'Annual Budget (A4)', t: 'select', o: ['Under $100K', '$100K–$250K', '$250K–$500K', '$500K–$1M', '$1M–$5M', '$5M–$10M', 'Over $10M', 'Not sure'] },
      { k: 'year_founded', l: 'Year Founded (A11)', t: 'number', ph: 'e.g. 1985' },
      { k: 'employees_ft', l: 'Full-Time Employees (A5)', t: 'number' },
      { k: 'employees_pt', l: 'Part-Time Employees (A6)', t: 'number' },
      { k: 'contractors', l: 'Contractors (A7)', t: 'number' },
      { k: 'volunteers', l: 'Volunteers (A8)', t: 'select', o: ['None', '1–10', '11–25', '26–50', '51–100', 'Over 100'] },
      { k: 'locations', l: 'Locations (A9)', t: 'select', o: ['1', '2–3', '4–10', 'Over 10'] },
      { k: 'address_street', l: 'Street Address (A10)', t: 'text', ph: '123 Main St' },
      { k: 'address_city', l: 'City', t: 'text', ph: 'Springfield' },
      { k: 'address_state', l: 'State', t: 'text', ph: 'IL' },
      { k: 'address_zip', l: 'ZIP Code', t: 'text', ph: '62701' },
      { k: 'payroll_method', l: 'Payroll (A12)', t: 'select', o: ['Outsourced (ADP, Gusto, Paychex, etc.)', 'In-house with software', 'Manual', 'Accountant handles it', 'No paid employees'] },
      { k: 'last_audit', l: 'Last Audit (A13)', t: 'select', o: ['Within 2 years', '3–5 years ago', '6+ years ago', 'Review only', 'Never', 'Not sure'] },
      { k: 'federal_funding', l: 'Federal Funding (A14)', t: 'select', o: ['Yes, over $750K/yr', 'Yes, under $750K', 'Occasionally', 'No', 'Not sure'] },
      { k: 'endowment', l: 'Endowment (A15)', t: 'select', o: ['Yes, over $1M', 'Yes, under $1M', 'No', 'Not sure'] },
      { k: 'governing_body_type', l: 'Governing Body (A16)', t: 'select', o: ['Board of Directors', 'Board of Trustees', 'Church council', 'Elder board', 'Vestry', 'Advisory board', 'Other'] },
      { k: 'board_members_current', l: 'Board Current (A17)', t: 'number' },
      { k: 'board_members_min', l: 'Board Min (A18)', t: 'number' },
      { k: 'board_members_max', l: 'Board Max (A19)', t: 'number' },
      { k: 'finance_committee', l: 'Finance Committee (A20)', t: 'select', o: ['Finance committee', 'Audit committee', 'Both', 'Full board handles finances', 'No committee'] },
      { k: 'finance_person_type', l: 'Finance Person (A21)', t: 'select', o: ['Full-time CFO, Controller, or Finance Director', 'Full-time bookkeeper or accountant', 'Part-time bookkeeper', 'Outsourced to CPA firm', 'Volunteer', 'No one dedicated', 'Other'] },
    ];
    return React.createElement('div', { style: { minHeight: '100vh', background: 'var(--bg)' } },
      loadingEl,
      React.createElement('div', { id: 'toast', className: 'toast' }),
      React.createElement('div', { className: 'nav-top' },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, React.createElement('img', { src: '/logo-icon.svg', alt: 'Provident', style: { width: 28, height: 28, borderRadius: '50%' } }), React.createElement('span', { style: { fontFamily: "'Goudy Bookletter 1911','Georgia',serif", fontWeight: 700, fontSize: 15, color: '#fff' } }, 'Provident')),
        React.createElement('button', { className: 'btn btn-o', style: { fontSize: 12, padding: '5px 12px' }, onClick: function() { setOF(null); setPage('home'); } }, 'Cancel')
      ),
      React.createElement('div', { className: 'main-c' },
        React.createElement('h1', { className: 'pg-t' }, orgForm.id ? 'Edit' : 'New', ' Organization'),
        React.createElement('p', { className: 'pg-s' }, 'Part A: Organization Profile'),
        React.createElement('div', { className: 'card' },
          fields.map(function(f) {
            var val = orgForm[f.k] || '';
            var onChange = function(e) { var nf = Object.assign({}, orgForm); nf[f.k] = e.target.value; setOF(nf); };
            if (f.t === 'select') return React.createElement('div', { key: f.k, style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, f.l), React.createElement('select', { className: 'inp', value: val, onChange: onChange }, React.createElement('option', { value: '' }, 'Select...'), f.o.map(function(o) { return React.createElement('option', { key: o, value: o }, o); })));
            return React.createElement('div', { key: f.k, style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, f.l), React.createElement('input', { className: 'inp', type: f.t === 'number' ? 'number' : 'text', value: val, onChange: onChange, placeholder: f.ph || '' }));
          }),
          React.createElement('button', { className: 'btn btn-g', disabled: !orgForm.name, onClick: saveOrg }, 'Save Organization')
        )
      )
    );
  }

  // ASSESSMENT ENGINE
  function AssessPage() {
    if (!co) return React.createElement('div', { className: 'card', style: { textAlign: 'center', padding: 40 } }, React.createElement('p', { className: 'mt' }, 'Create an organization first.'));
    if (!profileDone) {
      var [pf, setPf] = useState({ respondent_name: user.name, role: '', years_involved: '', paid_volunteer: '', finance_involvement: '', mission_description: '', recent_highlight: '', mission_alignment: '', financial_health_rating: '', concerns_text: '' });
      var [ipWords, setIPW] = useState([]); var [ipWhy, setIPWhy] = useState('');
      var roles = ['Senior Leader (Pastor, ED, CEO)', 'Board Chair', 'Board Member', 'Board Treasurer', 'Board Finance Committee Member', 'Finance Committee Member', 'Finance Staff', 'Bookkeeper', 'Admin Staff', 'Program or Ministry Staff', 'Ops or Facilities', 'Volunteer (leadership)', 'Volunteer (general)', 'Other'];
      var finOpts = ['I manage finances day-to-day', 'I approve or review financial info', "I receive reports but don't manage", 'No direct involvement', 'I handle a department or program budget only'];
      var healthOpts = ['Strong', 'Good enough', 'Not sure', 'A little worried', 'Very concerned'];
      return React.createElement('div', null,
        React.createElement('h1', { className: 'pg-t' }, 'About You (Part B)'), React.createElement('p', { className: 'pg-s' }, 'Help us understand your perspective.'),
        React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Your Name (B1)'), React.createElement('input', { className: 'inp', value: pf.respondent_name, onChange: function(e) { setPf(Object.assign({}, pf, { respondent_name: e.target.value })); } }), React.createElement('span', { className: 'mt' }, 'Tracking only — never in report')),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Your Role (B2)'), React.createElement('select', { className: 'inp', value: pf.role, onChange: function(e) { setPf(Object.assign({}, pf, { role: e.target.value })); } }, React.createElement('option', { value: '' }, 'Select...'), roles.map(function(o) { return React.createElement('option', { key: o, value: o }, o); }))),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Years Involved (B3)'), React.createElement('input', { className: 'inp', type: 'number', value: pf.years_involved, onChange: function(e) { setPf(Object.assign({}, pf, { years_involved: e.target.value })); } })),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Paid or Volunteer (B4)'), React.createElement('select', { className: 'inp', value: pf.paid_volunteer, onChange: function(e) { setPf(Object.assign({}, pf, { paid_volunteer: e.target.value })); } }, React.createElement('option', { value: '' }, 'Select...'), ['Full-time paid', 'Part-time paid', 'Volunteer', 'Contract', 'Stipend'].map(function(o) { return React.createElement('option', { key: o, value: o }, o); }))),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Finance Involvement (B5)'), React.createElement('select', { className: 'inp', value: pf.finance_involvement, onChange: function(e) { setPf(Object.assign({}, pf, { finance_involvement: e.target.value })); } }, React.createElement('option', { value: '' }, 'Select...'), finOpts.map(function(o) { return React.createElement('option', { key: o, value: o }, o); }))),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Mission in your own words (B6)'), React.createElement('textarea', { className: 'inp', rows: 4, value: pf.mission_description, onChange: function(e) { setPf(Object.assign({}, pf, { mission_description: e.target.value })); } })),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Recent highlight (B7)'), React.createElement('textarea', { className: 'inp', rows: 4, value: pf.recent_highlight, onChange: function(e) { setPf(Object.assign({}, pf, { recent_highlight: e.target.value })); } })),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Mission alignment 1-5 (B8)'), React.createElement('div', { className: 'q-opts' }, [1, 2, 3, 4, 5].map(function(v) { return React.createElement('span', { key: v, className: 'q-opt' + (pf.mission_alignment == v ? ' sel' : ''), onClick: function() { setPf(Object.assign({}, pf, { mission_alignment: v })); } }, v, v === 1 ? ' Not at all' : v === 5 ? ' Fully aligned' : ''); }))),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Financial health (B9)'), React.createElement('div', { className: 'q-opts' }, healthOpts.map(function(v) { return React.createElement('span', { key: v, className: 'q-opt' + (pf.financial_health_rating === v ? ' sel' : ''), onClick: function() { setPf(Object.assign({}, pf, { financial_health_rating: v })); } }, v); }))),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'Anything weighing on you? (B10)'), React.createElement('textarea', { className: 'inp', rows: 3, value: pf.concerns_text, onChange: function(e) { setPf(Object.assign({}, pf, { concerns_text: e.target.value })); }, placeholder: 'Optional' })),
          React.createElement('div', { style: { marginBottom: 14, padding: 16, background: 'var(--bg)', borderRadius: 8 } },
            React.createElement('label', { className: 'lbl', style: { color: 'var(--g)' } }, 'Initial Emotional Pulse'),
            React.createElement('p', { className: 'mt', style: { marginBottom: 8 } }, 'Pick up to 3 words:'),
            React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, ELABELS.map(function(w, i) { return React.createElement('span', { key: w, className: 'emo-w' + (ipWords.includes(EWORDS[i]) ? ' sel' : ''), onClick: function() { var ws = ipWords.slice(); var idx = ws.indexOf(EWORDS[i]); if (idx >= 0) ws.splice(idx, 1); else if (ws.length < 3) ws.push(EWORDS[i]); setIPW(ws); } }, w); })),
            React.createElement('textarea', { className: 'inp', rows: 2, style: { marginTop: 8 }, placeholder: 'Why those words? (optional)', value: ipWhy, onChange: function(e) { setIPWhy(e.target.value); } })
          ),
          React.createElement('button', { className: 'btn btn-g', disabled: !pf.role, onClick: async function() { await saveProfile(pf); await savePulse('initial', 0, ipWords, ipWhy); setCurSec(1); } }, 'Continue to Assessment')
        )
      );
    }

    if (curSec === 0) return React.createElement('div', null,
      React.createElement('h1', { className: 'pg-t' }, 'Assessment Sections'), React.createElement('p', { className: 'pg-s' }, 'Select a section or start from the beginning.'),
      React.createElement('div', { className: 'card' },
        Array.from({ length: 13 }, function(_, i) { return i + 1; }).map(function(s) {
          var started = secQs(s).some(function(q) { return answers[q.code]; });
          return React.createElement('div', { key: s, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: s < 13 ? '1px solid var(--bg)' : 'none', cursor: 'pointer' }, onClick: function() { setCurSec(s); } },
            React.createElement('span', { style: { fontWeight: 700, color: 'var(--g)', width: 24 } }, s),
            React.createElement('span', { style: { flex: 1, fontWeight: 500 } }, SNAMES[s]),
            (function() { var answered = secQs(s).filter(function(q) { return answers[q.code]; }).length; var total = secQs(s).length; return answered > 0 ? React.createElement('span', { style: { fontSize: 11, color: answered === total ? 'var(--gr)' : 'var(--am)' } }, answered, '/', total, answered === total ? ' ✓' : '') : React.createElement('span', { className: 'mt' }, '0/', total); })()
          );
        }),
        React.createElement('div', { style: { marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--br)' } },
          React.createElement('button', { className: 'btn btn-g', onClick: function() { setCurSec(1); } }, 'Start from Section 1')
        )
      )
    );

    if (curSec === 14) {
      var [fr, setFR] = useState({ F1: answers['F1'] || '', F2: answers['F2'] || '', F3: answers['F3'] || '', F4: answers['F4'] || '' });
      var [fpW, setFPW] = useState((pulses['final'] || { words: [] }).words || []); var [fpWhy, setFPWhy] = useState((pulses['final'] || {}).why || '');
      return React.createElement('div', null,
        React.createElement('h1', { className: 'pg-t' }, 'Final Reflections'), React.createElement('p', { className: 'pg-s' }, 'Last few questions.'),
        React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'What is the single most important thing this organization should do to strengthen how it manages money?'), React.createElement('textarea', { className: 'inp', rows: 3, value: fr.F1, onChange: function(e) { setFR(Object.assign({}, fr, { F1: e.target.value })); } })),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'If you could fix one process or problem overnight?'), React.createElement('textarea', { className: 'inp', rows: 3, value: fr.F2, onChange: function(e) { setFR(Object.assign({}, fr, { F2: e.target.value })); } })),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, "Anything we didn't ask about? (Optional)"), React.createElement('textarea', { className: 'inp', rows: 2, value: fr.F3, onChange: function(e) { setFR(Object.assign({}, fr, { F3: e.target.value })); } })),
          React.createElement('div', { style: { marginBottom: 14 } }, React.createElement('label', { className: 'lbl' }, 'How was this experience?'), React.createElement('div', { className: 'q-opts' }, ['Excellent', 'Good', 'Fair', 'Could be better'].map(function(v) { return React.createElement('span', { key: v, className: 'q-opt' + (fr.F4 === v ? ' sel' : ''), onClick: function() { setFR(Object.assign({}, fr, { F4: v })); } }, v); }))),
          React.createElement('div', { style: { padding: 16, background: 'var(--bg)', borderRadius: 8, marginBottom: 14 } },
            React.createElement('label', { className: 'lbl', style: { color: 'var(--g)' } }, 'Final Emotional Pulse'),
            React.createElement('p', { className: 'mt', style: { marginBottom: 8 } }, 'Pick up to 3:'),
            React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, ELABELS.map(function(w, i) { return React.createElement('span', { key: w, className: 'emo-w' + (fpW.includes(EWORDS[i]) ? ' sel' : ''), onClick: function() { var ws = fpW.slice(); var idx = ws.indexOf(EWORDS[i]); if (idx >= 0) ws.splice(idx, 1); else if (ws.length < 3) ws.push(EWORDS[i]); setFPW(ws); } }, w); })),
            React.createElement('textarea', { className: 'inp', rows: 2, style: { marginTop: 8 }, placeholder: 'Why? (optional)', value: fpWhy, onChange: function(e) { setFPWhy(e.target.value); } })
          ),
          React.createElement('button', { className: 'btn btn-g', onClick: async function() {
            if (!confirm('Are you sure you want to submit your assessment? This action cannot be undone.')) return;
            await P('assess?action=save_answers&org_id=' + activeOrg, { answers: [{ code: 'F1', value: fr.F1, section: 14 }, { code: 'F2', value: fr.F2, section: 14 }, { code: 'F3', value: fr.F3, section: 14 }, { code: 'F4', value: fr.F4, section: 14 }].filter(function(a) { return a.value; }) });
            await savePulse('final', 14, fpW, fpWhy);
            await completeAssessment(fr.F4);
          } }, 'Submit Assessment')
        )
      );
    }

    // Section assessment (curSec 1-13)
    var qs = secQs(curSec);
    var factQs = qs.filter(function(q) { return q.question_type !== 'open_ended'; });
    var oeQs = qs.filter(function(q) { return q.question_type === 'open_ended'; });
    var pKey = 'section_' + curSec;
    var curPulse = pulses[pKey] || { words: [], why: '' };
    var pWords = curPulse.words || [];
    var pWhy = curPulse.why || '';

    return React.createElement('div', null,
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 } },
        React.createElement('button', { className: 'btn btn-o', style: { fontSize: 12, padding: '5px 12px' }, onClick: function() { setCurSec(0); } }, '← Sections'),
        React.createElement('div', { style: { flex: 1 } }, React.createElement('h2', { style: { fontSize: 18, margin: 0 } }, 'Section ', curSec, ': ', SNAMES[curSec])),
        React.createElement('span', { className: 'mt' }, curSec, '/13')
      ),
      React.createElement('div', { className: 'prg' }, React.createElement('div', { className: 'prg-f', style: { width: (curSec / 13 * 100) + '%' } })),
      saveStatus ? React.createElement('div', { style: { fontSize: 11, textAlign: 'right', marginBottom: 8, color: saveStatus === 'saved' ? 'var(--gr)' : saveStatus === 'error' ? 'var(--r)' : 'var(--am)' } }, saveStatus === 'saved' ? '✓ Saved' : saveStatus === 'error' ? 'Save failed' : 'Unsaved changes...') : null,
      React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
        React.createElement('h3', { style: { fontSize: 14, fontWeight: 700, color: 'var(--g)', marginBottom: 12, letterSpacing: 1, textTransform: 'uppercase' } }, 'Questions'),
        factQs.map(function(q) {
          var opts = []; try { opts = q.response_options ? (typeof q.response_options === 'string' ? JSON.parse(q.response_options) : q.response_options) : []; } catch (e) { opts = []; }
          return React.createElement('div', { key: q.code, className: 'q-block' },
            React.createElement('div', { className: 'q-text' }, q.code, '  ', q.question_text),
            (q.question_type === 'yn' || q.question_type === 'select') ? React.createElement('div', { className: 'q-opts' }, opts.map(function(o) { return React.createElement('span', { key: o, className: 'q-opt' + (answers[q.code] === o ? ' sel' : ''), onClick: function() { setA(q.code, o); } }, o); })) : null,
            q.question_type === 'select_multi' ? React.createElement('div', { className: 'q-opts' }, opts.map(function(o) { var cur = answers[q.code]; var arr = Array.isArray(cur) ? cur : []; return React.createElement('span', { key: o, className: 'q-opt' + (arr.includes(o) ? ' sel' : ''), onClick: function() { var a = arr.slice(); var idx = a.indexOf(o); if (idx >= 0) a.splice(idx, 1); else a.push(o); setA(q.code, a); } }, o); })) : null,
            q.question_type === 'free_text' ? React.createElement(TextInput, { key: 'ti_' + q.code, code: q.code, rows: 3, value: answers[q.code] || '', onChange: function(v) { setA(q.code, v); }, placeholder: 'Enter your answer...' }) : null,
            q.question_type === 'likert' ? React.createElement('div', { className: 'q-opts' }, [1, 2, 3, 4, 5].map(function(v) { return React.createElement('span', { key: v, className: 'q-opt' + (String(answers[q.code]) === String(v) ? ' sel' : ''), onClick: function() { setA(q.code, String(v)); } }, v); })) : null,
            q.question_type === 'number' ? React.createElement(TextInput, { key: 'ti_' + q.code, code: q.code, type: 'number', style: { maxWidth: 150 }, value: answers[q.code] || '', onChange: function(v) { setA(q.code, v); } }) : null
          );
        })
      ),
      oeQs.length > 0 ? React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
        React.createElement('h3', { style: { fontSize: 14, fontWeight: 700, color: 'var(--g)', marginBottom: 12, letterSpacing: 1, textTransform: 'uppercase' } }, 'In Your Own Words'),
        oeQs.map(function(q) { return React.createElement('div', { key: q.code, className: 'q-block' },
          React.createElement('div', { className: 'q-text' }, q.code, '  ', q.question_text),
          React.createElement(TextInput, { key: 'ti_' + q.code, code: q.code, rows: 3, value: answers[q.code] || '', onChange: function(v) { setA(q.code, v); }, placeholder: "Write as much or as little as you'd like." })
        ); })
      ) : null,
      React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
        React.createElement('h3', { style: { fontSize: 14, fontWeight: 700, color: 'var(--g)', marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' } }, 'Emotional Pulse: ', SNAMES[curSec]),
        React.createElement('p', { className: 'mt', style: { marginBottom: 8 } }, 'Pick up to 3 words that come to mind:'),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, ELABELS.map(function(w, i) { return React.createElement('span', { key: w, className: 'emo-w' + (pWords.includes(EWORDS[i]) ? ' sel' : ''), onClick: function() { setPulseW(pKey, EWORDS[i]); } }, w); })),
        React.createElement(TextInput, { key: 'pulse_' + pKey, rows: 2, style: { marginTop: 8 }, placeholder: 'Why those words? (optional)', value: pWhy, onChange: function(v) { setPulses(function(prev) { var n = Object.assign({}, prev); n[pKey] = { words: pWords, why: v }; return n; }); } })
      ),
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
        React.createElement('button', { className: 'btn btn-o', disabled: curSec <= 1, onClick: async function() { await saveAnswerBatch(curSec); await savePulse(pKey, curSec, pWords, pWhy); setCurSec(curSec - 1); } }, '← Previous'),
        curSec < 13 ? React.createElement('button', { className: 'btn btn-p', onClick: async function() { await saveAnswerBatch(curSec); await savePulse(pKey, curSec, pWords, pWhy); setCurSec(curSec + 1); } }, 'Next →')
          : React.createElement('button', { className: 'btn btn-g', onClick: async function() { await saveAnswerBatch(curSec); await savePulse(pKey, curSec, pWords, pWhy); setCurSec(14); } }, 'Final Reflections →')
      )
    );
  }

  // REPORT DASHBOARD
  function ReportDash() {
    if (!report) return React.createElement('div', { className: 'card', style: { textAlign: 'center', padding: 40 } },
      React.createElement('p', { style: { marginBottom: 16 } }, 'No report yet.'),
      React.createElement('button', { className: 'btn btn-g', disabled: generating, onClick: genReport }, generating ? 'Generating...' : 'Generate Report'));
    var R = report; var SCORES = R.scores || []; var PRIS = R.priorities_list || []; var SECS = SNAMES.slice(1);

    var radarPts = SCORES.map(function(s, i) { var a = Math.PI / 2 - 2 * Math.PI * i / 13, r = 130 * s / 5; return [190 + r * Math.cos(a), 190 - r * Math.sin(a)]; });
    var poly = radarPts.map(function(p) { return p.join(','); }).join(' ');
    var grid = [1, 2, 3, 4, 5].map(function(v) { var pts = Array.from({ length: 13 }, function(_, i) { var a = Math.PI / 2 - 2 * Math.PI * i / 13, r = 130 * v / 5; return (190 + r * Math.cos(a)) + ',' + (190 - r * Math.sin(a)); }).join(' '); return React.createElement('polygon', { key: v, points: pts, fill: 'none', stroke: '#d9d2c6', strokeWidth: '0.5' }); });
    var dots = radarPts.map(function(p, i) { return React.createElement('circle', { key: i, cx: p[0], cy: p[1], r: 4, fill: sc(SCORES[i]), stroke: 'white', strokeWidth: 2 }); });
    var labels = SECS.map(function(s, i) { var a = Math.PI / 2 - 2 * Math.PI * i / 13, x = 190 + 158 * Math.cos(a), y = 190 - 158 * Math.sin(a), anc = Math.cos(a) < -.3 ? 'end' : Math.cos(a) > .3 ? 'start' : 'middle'; return React.createElement('text', { key: i, x: x, y: y, textAnchor: anc, fontSize: '8', fill: 'var(--bd)', fontFamily: 'Montserrat' }, s.split(' & ')[0].split(',')[0]); });

    var sideSecs = [{ id: 'dashboard', label: 'Dashboard' }, { id: 'summary', label: 'Executive Summary' }, { id: 'team_rpt', label: 'Your Team' }, { id: 'emotions', label: 'Emotional Landscape' }];
    for (var i = 0; i < 13; i++) sideSecs.push({ id: 'sec_' + (i + 1), label: (i + 1) + '. ' + SECS[i].split(' & ')[0].split(',')[0], score: SCORES[i], pri: PRIS[i] });
    sideSecs.push({ id: 'priorities', label: 'Top 5 Priorities' }, { id: 'keyrisk', label: 'Key Person Risk' }, { id: 'mission', label: 'Mission & Alignment' });

    var content = null;

    if (dashPage === 'dashboard') {
      content = React.createElement('div', null,
        React.createElement('h1', { className: 'pg-t' }, 'Dashboard'),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
          React.createElement('p', { className: 'pg-s' }, co ? co.name : '', '  ·  Financial Stewardship Assessment'),
          React.createElement('button', { className: 'btn btn-o', style: { fontSize: 12, padding: '5px 14px' }, onClick: function() { window.print(); } }, 'Print Report')
        ),
        React.createElement('div', { className: 'mc-row' },
          React.createElement('div', { className: 'mc' }, React.createElement('div', { className: 'l' }, 'Overall Score'), React.createElement('div', { className: 'v', style: { color: sc(R.overall_score) } }, R.overall_score), React.createElement('div', { className: 's' }, 'out of 5.0')),
          React.createElement('div', { className: 'mc' }, React.createElement('div', { className: 'l' }, 'Risk Level'), React.createElement('div', { className: 'v', style: { color: R.risk_level === 'Elevated' || R.risk_level === 'Critical' ? 'var(--am)' : 'var(--bl)' } }, R.risk_level), React.createElement('div', { className: 's' }, PRIS.filter(function(p) { return p === 'HIGH'; }).length, ' of 13 HIGH')),
          React.createElement('div', { className: 'mc' }, React.createElement('div', { className: 'l' }, 'Needs Attention'), React.createElement('div', { className: 'v', style: { color: R.needs_attention > 6 ? 'var(--r)' : 'var(--am)' } }, R.needs_attention), React.createElement('div', { className: 's' }, 'of 13 sections')),
          React.createElement('div', { className: 'mc' }, React.createElement('div', { className: 'l' }, 'Respondents'), React.createElement('div', { className: 'v', style: { color: 'var(--bl)' } }, R.respondent_count), React.createElement('div', { className: 's' }, 'completed'))
        ),
        React.createElement('div', { className: 'card', style: { marginBottom: 20 } }, React.createElement('h3', { style: { fontSize: 14, fontWeight: 700, marginBottom: 12 } }, 'Organizational Health'),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'center' } },
            React.createElement('svg', { viewBox: '0 0 380 380', width: 400 }, grid, React.createElement('polygon', { points: poly, fill: 'rgba(206,157,49,.15)', stroke: 'var(--g)', strokeWidth: 2 }), dots, React.createElement('circle', { cx: 190, cy: 190, r: 22, fill: 'var(--n)' }), React.createElement('text', { x: 190, y: 194, textAnchor: 'middle', fill: 'var(--g)', fontFamily: "'Goudy Bookletter 1911','Georgia',serif", fontWeight: 700, fontSize: 16 }, R.overall_score), labels)
          )
        ),
        React.createElement('div', { className: 'card' }, SECS.map(function(s, i) { return React.createElement('div', { key: i, className: 'bar-r' }, React.createElement('div', { className: 'bar-l', style: { cursor: 'pointer' }, onClick: function() { setDP('sec_' + (i + 1)); } }, s.split(' & ')[0].split(',')[0]), React.createElement('div', { className: 'bar-t' }, React.createElement('div', { className: 'bar-f', style: { width: (SCORES[i] / 5 * 100) + '%', background: sc(SCORES[i]) } })), React.createElement('div', { className: 'bar-sc', style: { color: sc(SCORES[i]) } }, SCORES[i] != null ? SCORES[i].toFixed(1) : '—'), React.createElement('span', { className: 'pri ' + (PRIS[i] === 'HIGH' ? 'pri-h' : PRIS[i] === 'MEDIUM' ? 'pri-m' : 'pri-l') }, PRIS[i])); }))
      );
    }

    if (dashPage === 'summary') content = React.createElement('div', null, React.createElement('h1', { className: 'pg-t' }, 'Executive Summary'), React.createElement('div', { className: 'card' }, (R.executive_summary || '').split('\n').filter(Boolean).map(function(p, i) { return React.createElement('p', { key: i, style: { fontSize: 14, lineHeight: 1.8, marginBottom: 12 } }, p); })));

    if (dashPage === 'team_rpt' && R.team) content = React.createElement('div', null, React.createElement('h1', { className: 'pg-t' }, 'Your Team'), React.createElement('div', { className: 'card' }, (R.team.perception_gap || '').split('\n').filter(Boolean).map(function(p, i) { return React.createElement('p', { key: i, style: { fontSize: 13, lineHeight: 1.7, marginBottom: 8 } }, p); })));

    if (dashPage === 'emotions' && R.emotional_landscape) content = React.createElement('div', null, React.createElement('h1', { className: 'pg-t' }, 'Emotional Landscape'),
      React.createElement('div', { className: 'card', style: { marginBottom: 16 } }, R.emotion_totals ? Object.entries(R.emotion_totals).sort(function(a, b) { return b[1] - a[1]; }).map(function(e) { return React.createElement('div', { key: e[0], className: 'bar-r' }, React.createElement('div', { className: 'bar-l', style: { width: 100, textTransform: 'capitalize' } }, e[0]), React.createElement('div', { className: 'bar-t' }, React.createElement('div', { className: 'bar-f', style: { width: (e[1] / Math.max.apply(null, Object.values(R.emotion_totals)) * 100) + '%', background: ['confident', 'hopeful', 'encouraged', 'empowered'].includes(e[0]) ? 'var(--gr)' : 'var(--r)' } })), React.createElement('div', { className: 'bar-sc' }, e[1])); }) : null,
        React.createElement('p', { style: { fontSize: 13, lineHeight: 1.7, marginTop: 12 } }, R.emotional_landscape.aggregate_narrative)),
      React.createElement('div', { className: 'card' }, React.createElement('p', { style: { fontSize: 13, lineHeight: 1.7 } }, R.emotional_landscape.heatmap_narrative)));

    if (dashPage && dashPage.startsWith('sec_')) {
      var si = parseInt(dashPage.split('_')[1]);
      var sec = (R.sections || []).find(function(s) { return s.number === si; });
      if (sec) content = React.createElement('div', null,
        React.createElement('h1', { className: 'pg-t' }, 'Section ', si, ': ', SNAMES[si]),
        React.createElement('div', { className: 'sec-hb' }, React.createElement('div', { className: 'sec-sc', style: { color: sc(SCORES[si - 1]) } }, SCORES[si - 1] != null ? SCORES[si - 1].toFixed(1) : '—'), React.createElement('span', { className: 'pri ' + (PRIS[si - 1] === 'HIGH' ? 'pri-h' : PRIS[si - 1] === 'MEDIUM' ? 'pri-m' : 'pri-l') }, PRIS[si - 1], ' PRIORITY')),
        React.createElement('p', { style: { fontSize: 13, lineHeight: 1.7, marginBottom: 16 } }, sec.score_explanation),
        sec.strengths && sec.strengths.length > 0 ? React.createElement('div', { className: 'fb fb-s' }, React.createElement('h4', null, "✓ What's Working"), React.createElement('ul', null, sec.strengths.map(function(s, i) { return React.createElement('li', { key: i }, s); }))) : null,
        sec.concerns && sec.concerns.length > 0 ? React.createElement('div', { className: 'fb fb-c' }, React.createElement('h4', null, '⚠ Areas for Growth'), React.createElement('ul', null, sec.concerns.map(function(c, i) { return React.createElement('li', { key: i }, c); }))) : null,
        sec.team_said ? React.createElement('div', { className: 'fb fb-n' }, React.createElement('h4', null, '💬 What Your Team Said'), sec.team_said.split('\n').filter(Boolean).map(function(p, i) { return React.createElement('p', { key: i }, p); })) : null,
        sec.recommendations && sec.recommendations.length > 0 ? React.createElement('div', { className: 'fb fb-r' }, React.createElement('h4', null, '→ Recommended Actions'), React.createElement('ol', null, sec.recommendations.map(function(r, i) { return React.createElement('li', { key: i }, r); }))) : null,
        sec.vision ? React.createElement('div', { className: 'fb fb-v' }, React.createElement('h4', null, '✦ Your Vision'), React.createElement('p', null, sec.vision)) : null,
        sec.pulse_narrative ? React.createElement('p', { className: 'mt', style: { marginTop: 12 } }, sec.pulse_narrative) : null,
        React.createElement('div', { className: 'cta-card' }, React.createElement('h3', null, 'Want help implementing these recommendations?'), React.createElement('p', null, 'Provident Strategic Advisers specializes in nonprofit financial stewardship.'), React.createElement('a', { href: 'https://providentstrat.com', target: '_blank' }, 'Learn More'))
      );
    }

    if (dashPage === 'priorities' && R.priorities) content = React.createElement('div', null, React.createElement('h1', { className: 'pg-t' }, 'Top 5 Priorities'),
      R.priorities.map(function(p, i) { return React.createElement('div', { key: i, style: { display: 'flex', gap: 16, background: 'var(--w)', borderRadius: 10, padding: '18px 20px', marginBottom: 12, border: '1px solid var(--br)' } },
        React.createElement('div', { style: { width: 40, height: 40, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Goudy Bookletter 1911','Georgia',serif", fontSize: 20, fontWeight: 700, color: '#fff', background: p.urgency === 'red' ? 'var(--r)' : p.urgency === 'amber' ? 'var(--am)' : 'var(--bl)', flexShrink: 0 } }, p.rank),
        React.createElement('div', { style: { flex: 1 } }, React.createElement('div', { style: { fontWeight: 700, fontSize: 14, color: 'var(--n)' } }, p.title), React.createElement('div', { className: 'mt', style: { margin: '2px 0 6px' } }, p.timeline), React.createElement('p', { style: { fontSize: 13, lineHeight: 1.6 } }, p.description), React.createElement('div', { className: 'mt', style: { marginTop: 6 } }, 'Owner: ', p.owner))
      ); }));

    if (dashPage === 'keyrisk' && R.key_person_risk) content = React.createElement('div', null, React.createElement('h1', { className: 'pg-t' }, 'Key Person Risk'),
      React.createElement('div', { className: 'card' },
        React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: 'var(--n)', color: '#fff' } }, ['Function', 'Owner', 'Documented?', 'Backup', 'Risk'].map(function(h) { return React.createElement('th', { key: h, style: { padding: '6px 10px', textAlign: 'left' } }, h); }))),
          React.createElement('tbody', null, (R.key_person_risk.functions || []).map(function(f, i) { return React.createElement('tr', { key: i, style: { borderBottom: '1px solid var(--br)' } },
            React.createElement('td', { style: { padding: '6px 10px' } }, f.function), React.createElement('td', { style: { padding: '6px 10px' } }, f.owner), React.createElement('td', { style: { padding: '6px 10px', textAlign: 'center' } }, f.documented ? 'Yes' : 'No'), React.createElement('td', { style: { padding: '6px 10px' } }, f.backup), React.createElement('td', { style: { padding: '6px 10px', textAlign: 'center' } }, React.createElement('span', { className: 'pri ' + (f.risk === 'CRITICAL' ? 'pri-h' : f.risk === 'HIGH' ? 'pri-m' : 'pri-l') }, f.risk))); }))
        ),
        React.createElement('p', { style: { fontSize: 14, lineHeight: 1.7, marginTop: 16 } }, R.key_person_risk.narrative)
      ));

    if (dashPage === 'mission' && R.mission) content = React.createElement('div', null, React.createElement('h1', { className: 'pg-t' }, 'Mission & Alignment'),
      React.createElement('div', { className: 'card' },
        React.createElement('div', { style: { fontSize: 22, fontWeight: 700, color: 'var(--g)', marginBottom: 8, fontFamily: "'Goudy Bookletter 1911','Georgia',serif" } }, R.mission.score, '/5.0'),
        React.createElement('p', { style: { fontSize: 13, lineHeight: 1.7, marginBottom: 12 } }, R.mission.narrative),
        React.createElement('p', { style: { fontSize: 13, lineHeight: 1.7 } }, R.mission.highlights)
      ));

    return React.createElement('div', { style: { display: 'flex', minHeight: '100vh' } },
      loadingEl,
      React.createElement('div', { id: 'toast', className: 'toast' }),
      React.createElement('nav', { className: 'sb' },
        React.createElement('div', { className: 'sb-hd' }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, React.createElement('img', { src: '/logo-icon.svg', alt: 'Provident', style: { width: 24, height: 24, borderRadius: '50%' } }), React.createElement('div', null, React.createElement('span', { style: { color: '#fff', fontSize: 11, fontWeight: 600, letterSpacing: .5, display: 'block' } }, 'PROVIDENT'), React.createElement('span', { style: { color: 'var(--g)', fontSize: 8, fontWeight: 500, letterSpacing: 1.5, textTransform: 'uppercase' } }, 'Accountability'))), React.createElement('div', { className: 'sb-org' }, co ? co.name : ''), React.createElement('div', { className: 'mt' }, R.respondent_count, ' Respondents')),
        React.createElement('div', { className: 'sb-nav' }, sideSecs.map(function(it) { return React.createElement('div', { key: it.id, className: 'sb-it' + (dashPage === it.id ? ' act' : ''), onClick: function() { setDP(it.id); } }, it.score !== undefined ? React.createElement('span', { className: 'sb-dot', style: { background: sc(it.score) } }) : null, it.label, it.pri === 'HIGH' ? React.createElement('span', { style: { marginLeft: 'auto', fontSize: 10 } }, '⚠') : null); })),
        React.createElement('div', { className: 'sb-ft' }, React.createElement('button', { style: { background: 'none', border: 'none', color: 'var(--mt)', fontSize: 11, padding: '4px 0', cursor: 'pointer', fontFamily: "'Montserrat',sans-serif" }, onMouseEnter: function(e) { e.target.style.color = 'var(--g)'; }, onMouseLeave: function(e) { e.target.style.color = 'var(--mt)'; }, onClick: function() { setPage('home'); } }, '← Back to Home'))
      ),
      React.createElement('div', { className: 'main-r' }, content || React.createElement('div', { className: 'card' }, 'Select a page from the sidebar.'))
    );
  }

  // MAIN LAYOUT — Report gets its own layout with sidebar
  if (page === 'report') return React.createElement(ReportDash);

  var navItems = [{ id: 'home', label: 'Home' }, { id: 'assess', label: 'Assessment' }, { id: 'team', label: 'Team' }];
  if (report) navItems.push({ id: 'report', label: 'Report' });

  return React.createElement('div', { style: { minHeight: '100vh', background: 'var(--bg)' } },
    loadingEl,
    React.createElement('div', { id: 'toast', className: 'toast' }),
    React.createElement('div', { className: 'nav-top' },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }, onClick: function() { setPage('home'); } },
        React.createElement('img', { src: '/logo-icon.svg', alt: 'Provident', style: { width: 28, height: 28, borderRadius: '50%' } }),
        React.createElement('span', { style: { fontFamily: "'Goudy Bookletter 1911','Georgia',serif", fontWeight: 700, fontSize: 15, color: '#fff' } }, 'Provident')
      ),
      React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
        navItems.map(function(n) { return React.createElement('button', { key: n.id, onClick: function() { setPage(n.id); if (n.id === 'report') setDP('dashboard'); }, style: { padding: '5px 10px', borderRadius: 5, background: page === n.id ? 'rgba(206,157,49,.18)' : 'transparent', color: page === n.id ? 'var(--g)' : 'rgba(255,255,255,.55)', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 } }, n.label); }),
        React.createElement('div', { style: { width: 1, height: 18, background: 'rgba(255,255,255,.1)', margin: '0 6px' } }),
        React.createElement('span', { style: { fontSize: 12, color: 'rgba(255,255,255,.5)' } }, user.name.split(' ')[0]),
        React.createElement('button', { className: 'btn', style: { fontSize: 11, padding: '4px 10px', background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.6)' }, onClick: logout }, 'Out')
      )
    ),
    React.createElement('div', { className: 'main-c' },
      page === 'home' ? React.createElement('div', null,
        React.createElement('div', { style: { marginBottom: 20 } }, React.createElement('h1', { style: { fontSize: 22 } }, 'Welcome, ', user.name.split(' ')[0]), React.createElement('div', { style: { height: 2, width: 50, background: 'var(--g)', marginTop: 8 } })),
        orgs.length === 0 ? React.createElement('div', { className: 'card', style: { textAlign: 'center', padding: 48 } },
          React.createElement('h2', { style: { fontSize: 20, marginBottom: 8 } }, 'Add Your Organization'),
          React.createElement('p', { className: 'mt', style: { marginBottom: 16 } }, 'Create an organization profile to begin the assessment.'),
          React.createElement('button', { className: 'btn btn-g', onClick: function() { setOF({ name: '' }); setPage('org_edit'); } }, 'Add Organization')
        )
        : co ? React.createElement('div', null,
          React.createElement('div', { className: 'card', style: { padding: 16, marginBottom: 16 } }, React.createElement('div', { style: { fontSize: 11, color: 'var(--mt)', fontWeight: 600 } }, 'ACTIVE ORGANIZATION'), React.createElement('div', { style: { fontSize: 18, fontWeight: 700, fontFamily: "'Goudy Bookletter 1911','Georgia',serif" } }, co.name),
            orgs.length > 1 ? React.createElement('select', { className: 'inp', style: { marginTop: 8, maxWidth: 300 }, value: activeOrg || '', onChange: async function(e) { setAO(e.target.value); await loadOrg(e.target.value); } }, orgs.map(function(o) { return React.createElement('option', { key: o.id, value: o.id }, o.name); })) : null
          ),
          React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 20 } },
            React.createElement('div', { className: 'card', style: { padding: 16, borderTop: '3px solid ' + (progressPct > 50 ? 'var(--gr)' : 'var(--am)') } }, React.createElement('div', { className: 'mt', style: { fontWeight: 600 } }, 'Progress'), React.createElement('div', { style: { fontSize: 22, fontWeight: 700, fontFamily: "'Goudy Bookletter 1911','Georgia',serif" } }, progressPct, '%')),
            React.createElement('div', { className: 'card', style: { padding: 16, borderTop: '3px solid var(--bl)' } }, React.createElement('div', { className: 'mt', style: { fontWeight: 600 } }, 'Team'), React.createElement('div', { style: { fontSize: 22, fontWeight: 700, fontFamily: "'Goudy Bookletter 1911','Georgia',serif" } }, invites.length, ' invited')),
            React.createElement('div', { className: 'card', style: { padding: 16, borderTop: '3px solid ' + (report ? 'var(--gr)' : 'var(--mt)') } }, React.createElement('div', { className: 'mt', style: { fontWeight: 600 } }, 'Report'), React.createElement('div', { style: { fontSize: 22, fontWeight: 700, fontFamily: "'Goudy Bookletter 1911','Georgia',serif" } }, report ? 'Ready' : 'Pending'))
          ),
          React.createElement('div', { className: 'card' }, React.createElement('h3', { style: { fontSize: 16, marginBottom: 12 } }, 'Quick Actions'),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', { className: 'btn btn-p', onClick: function() { setPage('assess'); if (!profileDone) setCurSec(0); } }, progressPct > 0 ? 'Continue' : 'Start', ' Assessment'),
              React.createElement('button', { className: 'btn btn-o', onClick: function() { setPage('team'); } }, 'Invite Team'),
              report ? React.createElement('button', { className: 'btn btn-g', onClick: function() { setPage('report'); setDP('dashboard'); } }, 'View Report')
                : React.createElement('button', { className: 'btn btn-g', disabled: generating, onClick: genReport }, generating ? 'Generating...' : 'Generate Report')
            )
          ),
          React.createElement('div', { style: { marginTop: 16, display: 'flex', gap: 8 } }, React.createElement('button', { className: 'btn btn-o', style: { fontSize: 12 }, onClick: function() { setOF(Object.assign({ id: co.id }, co)); setPage('org_edit'); } }, 'Edit Organization'), React.createElement('button', { className: 'btn btn-o', style: { fontSize: 12 }, onClick: function() { setOF({ name: '' }); setPage('org_edit'); } }, '+ Add Organization'))
        ) : null
      ) : null,

      page === 'assess' ? React.createElement(AssessPage) : null,

      page === 'team' ? React.createElement('div', null,
        React.createElement('h1', { className: 'pg-t' }, 'Team & Invitations'), React.createElement('p', { className: 'pg-s' }, 'Invite others to take the assessment independently.'),
        React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            React.createElement('input', { className: 'inp', style: { flex: 1 }, type: 'email', placeholder: 'Email address', value: invEmail, onChange: function(e) { setIE(e.target.value); }, onKeyDown: function(e) { if (e.key === 'Enter') sendInvite(); } }),
            React.createElement('button', { className: 'btn btn-p', disabled: !invEmail.trim(), onClick: sendInvite }, 'Invite')
          ),
          React.createElement('p', { className: 'mt', style: { marginTop: 8 } }, "They'll receive a link to take the assessment. Their responses are confidential.")
        ),
        invites.length > 0 ? React.createElement('div', { className: 'card' },
          React.createElement('h3', { style: { fontSize: 16, marginBottom: 12 } }, 'Invited (', invites.length, ')'),
          invites.map(function(inv, i) { return React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: i < invites.length - 1 ? '1px solid var(--bg)' : 'none' } },
            React.createElement('div', { style: { width: 32, height: 32, borderRadius: '50%', background: 'var(--sl)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 700 } }, (inv.email || '?')[0].toUpperCase()),
            React.createElement('div', { style: { flex: 1 } }, React.createElement('div', { style: { fontSize: 14, fontWeight: 600 } }, inv.email)),
            React.createElement('span', { style: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: inv.status === 'completed' ? 'rgba(39,137,107,.12)' : inv.status === 'revoked' ? 'rgba(200,50,50,.12)' : 'rgba(212,136,15,.12)', color: inv.status === 'completed' ? 'var(--gr)' : inv.status === 'revoked' ? '#c83232' : 'var(--am)' } }, inv.status),
            inv.status === 'pending' ? React.createElement('button', { style: { fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(200,50,50,.3)', background: 'transparent', color: '#c83232', cursor: 'pointer', fontWeight: 600 }, onClick: function() { revokeInvite(inv.uuid); } }, 'Revoke') : null
          ); })
        ) : null
      ) : null
    ),
    React.createElement('div', { style: { background: 'var(--n)', padding: '24px 20px', textAlign: 'center', marginTop: 40 } },
      React.createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
        React.createElement('img', { src: '/logo-icon.svg', alt: 'Provident', style: { width: 20, height: 20, borderRadius: '50%' } }),
        React.createElement('span', { style: { fontFamily: "'Goudy Bookletter 1911','Georgia',serif", fontWeight: 700, fontSize: 14, color: '#fff' } }, 'Provident Accountability')
      ),
      React.createElement('div', { style: { fontSize: 11, color: 'rgba(255,255,255,.3)', marginTop: 4, fontFamily: "'Montserrat',sans-serif" } }, 'providentstrat.com')
    )
  );
}
