/**
 * SIBER-UJIAN — api.js
 * Satu pintu untuk semua komunikasi dengan server Google Apps Script.
 * Fungsi Api.call() TIDAK PERNAH melempar error: selalu mengembalikan
 * { success: true, data } atau { success: false, error: { code, message } }.
 */
const Api = (function () {
  'use strict';

  let lastExchange = null;

  function fail(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  function isConfigured() {
    const url = String(SIBER_CONFIG.API_URL || '').trim();
    return url.indexOf('https://script.google.com/') === 0 && /\/exec$/.test(url);
  }

  /** Salinan request untuk panel debug: password dan session disamarkan. */
  function maskRequest(body) {
    const copy = JSON.parse(JSON.stringify(body));
    if (copy.payload && copy.payload.password !== undefined) copy.payload.password = '***';
    if (copy.session) copy.session = copy.session.substring(0, 12) + '...';
    return copy;
  }

  function maskResponse(res) {
    const copy = JSON.parse(JSON.stringify(res));
    if (copy && copy.data && typeof copy.data.session === 'string') {
      copy.data.session = copy.data.session.substring(0, 12) + '...';
    }
    return copy;
  }

  /**
   * Memanggil API.
   * @param {string} action  nama action, misalnya 'login'
   * @param {object} payload data yang dikirim
   * @param {string} session session token (boleh kosong)
   */
  // Action yang hanya MEMBACA data: aman dicoba ulang otomatis bila gangguan sesaat.
  const RETRY_ACTIONS = ['ping', 'getAppConfig', 'getExamList', 'syncExam', 'getQuestionImage', 'heartbeat',
    'getDashboard', 'getLiveStatus', 'listMessages', 'getAttemptDetail', 'getAttemptDetailV2', 'getAnswerMatrix',
    'getResults', 'getDeviceOverview', 'getReportData', 'getAnswerSheets', 'listTokens'];
  const RETRY_CODES = ['TIMEOUT', 'NETWORK_ERROR', 'BAD_RESPONSE'];

  async function call(action, payload, session, timeoutMs) {
    let res = await callOnce(action, payload, session, timeoutMs);
    if (!res.success && RETRY_ACTIONS.indexOf(action) !== -1 && RETRY_CODES.indexOf(res.error.code) !== -1 && navigator.onLine) {
      await new Promise(function (r) { setTimeout(r, 2000); });
      res = await callOnce(action, payload, session, timeoutMs);
    }
    return res;
  }

  async function callOnce(action, payload, session, timeoutMs) {
    if (!isConfigured()) {
      return fail('API_NOT_CONFIGURED', 'URL API belum diisi dengan benar di js/api-url.js');
    }
    if (!navigator.onLine) {
      return fail('OFFLINE', 'Perangkat sedang offline. Sambungkan internet lalu coba lagi.');
    }

    const body = { action: action, payload: payload || {} };
    if (session) body.session = session;

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || SIBER_CONFIG.REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    let result;

    try {
      const res = await fetch(SIBER_CONFIG.API_URL.trim(), {
        method: 'POST',
        // text/plain dipakai agar browser tidak mengirim "preflight" CORS
        // yang tidak didukung Google Apps Script. Isinya tetap JSON.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal
      });
      const text = await res.text();
      try {
        result = JSON.parse(text);
      } catch (e) {
        const title = (text.match(/<title>([^<]{0,120})<\/title>/i) || [])[1] || '';
        result = fail('BAD_RESPONSE',
          'Server tidak mengirim JSON (HTTP ' + res.status + (title ? ', "' + title.trim() + '"' : '') + '). ' +
          (res.status === 404 ? 'Gangguan sesaat dari Google; coba lagi. Jika terus terjadi, periksa deployment Web App. '
            : 'Periksa: akses Web App = "Siapa saja" dan URL berakhiran /exec.'));
      }
      if (!result || typeof result.success !== 'boolean') {
        result = fail('BAD_RESPONSE', 'Format respons server tidak dikenal.');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        result = fail('TIMEOUT', 'Server terlalu lama merespons. Coba lagi beberapa saat.');
      } else {
        result = fail('NETWORK_ERROR', 'Gagal menghubungi server: ' + (err && err.message ? err.message : err));
      }
    } finally {
      clearTimeout(timer);
    }

    lastExchange = {
      waktu: new Date().toISOString(),
      action: action,
      durasi_ms: Date.now() - startedAt,
      request: maskRequest(body),
      response: maskResponse(result)
    };
    return result;
  }

  function getLastExchange() { return lastExchange; }

  return { call: call, isConfigured: isConfigured, getLastExchange: getLastExchange };
})();
