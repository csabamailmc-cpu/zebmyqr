/* ===================================================================
   DEKODOLO WEB WORKER -- KET MOTORRAL
   -------------------------------------------------------------------
   MIERT WORKER?
   A QR-dekodolas szinkron es lassu (58-1000 ms). Ha a fo szalon fut,
   a lap valaszkeptelenne valik: iOS-en a VoiceOver elnemul es a
   gombok sem nyomhatok meg. Ez a fajl KULON SZALON fut.

   MIERT KET MOTOR?
   1. ZXing (zxing-cpp, WebAssembly) -- HybridBinarizer
      HELYI, ADAPTIV kuszoboles: a kepet kis blokkokra osztja, es
      minden blokkhoz KULON szamol fekete-feher hatart. Ezert birja az
      egyenetlen megvilagitast: arnyekot, egyoldali fenyt, sotetet.
      A QRbot es a legtobb jo telefonos olvaso is ilyen elven mukodik.
   2. jsQR -- egyszeru, GLOBALIS kuszoboles
      Az egesz kepre EGY hatart szamol. Egyenletes fenyben gyors es jo,
      de sotetben vagy arnyekos kepen hamar elbukik.

   A worker eloszor a ZXinget probalja, es csak ha az nem talal,
   akkor a jsQR-t.
   =================================================================== */

var jsqrReady = false;
try { importScripts('jsQR.js'); jsqrReady = (typeof jsQR === 'function'); }
catch (e) { jsqrReady = false; }

var zxReady = false, ZX = null;
try {
  importScripts('zxing-wasm-reader.js');
  if (typeof ZXingWASM !== 'undefined') {
    ZX = ZXingWASM;
    /* A .wasm binarist a sajat mappankbol toltjuk, nem CDN-rol */
    ZX.prepareZXingModule({
      overrides: {
        locateFile: function (path, prefix) {
          return path.slice(-5) === '.wasm' ? 'zxing_reader.wasm' : prefix + path;
        }
      },
      fireImmediately: true
    });
    zxReady = true;
  }
} catch (e) { zxReady = false; ZX = null; }

function withJsQR(buf, w, h) {
  if (!jsqrReady) return null;
  try {
    var r = jsQR(new Uint8ClampedArray(buf), w, h,
                 { inversionAttempts: 'dontInvert' });
    return (r && r.data) ? r.data : null;
  } catch (e) { return null; }
}

self.onmessage = function (ev) {
  var m = ev.data;
  if (!m) return;

  if (m.cmd === 'ping') {
    self.postMessage({ type: 'ready', zxing: zxReady, jsqr: jsqrReady });
    return;
  }
  if (m.cmd !== 'scan') return;

  var img = { data: new Uint8ClampedArray(m.data), width: m.w, height: m.h };

  function finish(text, how) {
    self.postMessage({ type: 'result', id: m.id, text: text || null, how: how || '' });
  }

  if (zxReady && ZX) {
    /* tryHarder: tobb menetben probal -- lassabb, de rossz fenyben es
       ferden sokkal tobbet talal meg. Ez a fo elonye a jsQR-rel szemben. */
    ZX.readBarcodes(img, {
      formats: ['QRCode'],
      tryHarder: true,
      tryRotate: true,
      tryInvert: false,
      maxNumberOfSymbols: 1
    }).then(function (res) {
      if (res && res.length && res[0].text) { finish(res[0].text, 'ZXing'); return; }
      finish(withJsQR(m.data, m.w, m.h), 'jsQR');
    }).catch(function () {
      finish(withJsQR(m.data, m.w, m.h), 'jsQR');
    });
  } else {
    finish(withJsQR(m.data, m.w, m.h), 'jsQR');
  }
};
