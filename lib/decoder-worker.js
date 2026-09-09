/* ===================================================================
   DEKODOLO WEB WORKER
   -------------------------------------------------------------------
   MIERT KELL EZ?
   A QR-dekodolas szinkron es lassu (merve: 58 ms tiszta kepen, akar
   1000 ms mintas hatteren). Ha a fo szalon fut, a lap valaszkeptelenne
   valik: iOS-en a VoiceOver beszede elnemul, es a koppintasok sem
   jutnak el a gombokhoz.

   Az MDN igy fogalmaz: "a hosszan futo JavaScript-fuggvenyek blokkoljak
   a szalat, ami valaszkeptelen laphoz vezet... hacsak nem hasznalsz
   szandekosan web workert, a JavaScript a fo szalon fut".

   Ez a worker KULON SZALON fut. A fo szal csak annyit csinal, hogy
   atadja a kepkockat es fogadja az eredmenyt -- kozben vegig
   valaszkepes marad.
   =================================================================== */

var jsqrReady = false;
try { importScripts('jsQR.js'); jsqrReady = (typeof jsQR === 'function'); }
catch (e) { jsqrReady = false; }

self.onmessage = function (ev) {
  var m = ev.data;
  if (!m) return;

  if (m.cmd === 'ping') {
    self.postMessage({ type: 'ready', jsqr: jsqrReady });
    return;
  }

  if (m.cmd === 'scan') {
    var out = null;
    if (jsqrReady) {
      try {
        /* dontInvert: a kodjaink mindig sotet-vilagos allasuak;
           az attemptBoth zajos kepen megduplazza a koltseget */
        var r = jsQR(new Uint8ClampedArray(m.data), m.w, m.h,
                     { inversionAttempts: 'dontInvert' });
        if (r && r.data) out = r.data;
      } catch (e) { out = null; }
    }
    self.postMessage({ type: 'result', id: m.id, text: out });
  }
};
