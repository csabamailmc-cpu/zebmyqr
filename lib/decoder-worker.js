/* ===================================================================
   DEKODOLO WEB WORKER -- 2 MOTOR, 7 LEPCSO, A MERT TALALATI ARANY
   SORRENDJEBEN
   -------------------------------------------------------------------
   Miert worker: a dekodolas szinkron es lassu; a fo szalon a VoiceOver
   elnemulna es a gombok nem reagalnanak. Itt kulon szalon fut.

   MOTOROK
     ZXing (zxing-cpp 3.1.3, WebAssembly) -- HybridBinarizer, helyi
       (blokkonkenti) kuszoboles: az egyoldali fenyt, arnyekot magatol
       birja. tryHarder + tryRotate + tryDownscale.
     jsQR -- tiszta JavaScript, globalis kuszoboles. Gyengebb, de mas
       algoritmus, es WASM nelkul is fut.

   LEPCSOK (az elso talalatnal megallunk) es a MERES, amely a sorrendet
   adja. 7 jelenet x 20 cimke = 140 kep, a qrgrid.c 18 mm-es cimkei,
   Chromium 141, ebben a workerben:
     1. ZXing, nyers kep                         120/140 talalat (jo feny,
                                                 1/5 feny, egyoldali feny,
                                                 elmosott, forgatott,
                                                 tavoli: mind 20/20)
     2. ZXing, fenyero-nyujtott kep                0  (olcso, bent marad)
     3. ZXing, nyujtott + 3x3 atlagolt            4   (1/10 feny + zaj)
     4. ZXing, nyujtott + 2x atlagolt            13   (1/10 feny + zaj)
     5. ZXing, nyujtott + 3x atlagolt             0
     6. ZXing, ket egymas utani kepkocka atlaga   0   (eles videon nem
                                                 kell; remego kezben
                                                 segithet)
     7. jsQR, simitott kepen                      0
   Osszesen 137/140; a hianyzo 3 az 1/10 fenyu jelenetbol valo.
   Osszehasonlitasul a jsQR ONMAGABAN, ugyanezzel az elofeldolgozassal:
   jo feny 20, 1/5 feny 18, 1/10 feny 0, tobbi 20 -- tehat a ZXing
   mindenben legalabb olyan jo, ezert az fut eloszor. A jsQR azert
   marad bent, mert mas algoritmus (mas hibat vet), es ha a WASM
   valamiert nem toltodik be, akkor is olvas a lap.

   Fenyero-nyujtas: a kep 1..99 percentilis kozti szurketartomanyat
   0..255-re huzzuk. Sotetben a kamera kepe 10-30-as ertekek kozott
   mozog. Atlagolas: a szenzorzaj szorasat csokkenti; a 480 px-es kepen
   egy modul 8-10 px, ezert a 3 menetes (~7x7) simitast is kibirja.
   =================================================================== */

var jsqrReady = false;
try { importScripts('jsQR.js'); jsqrReady = (typeof jsQR === 'function'); }
catch (e) { jsqrReady = false; }

var zxReady = false, ZX = null;
try {
  importScripts('zxing-wasm-reader.js');
  if (typeof ZXingWASM !== 'undefined') {
    ZX = ZXingWASM;
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

var ZX_OPTS = { formats: ['QRCode'], tryHarder: true, tryRotate: true,
                tryInvert: false, tryDownscale: true, maxNumberOfSymbols: 1 };

/* RGBA -> szurke (Uint8). A kamera kepe ugyis szurkenek tekintheto. */
function toGray(rgba, n) {
  var g = new Uint8Array(n);
  for (var i = 0, j = 0; i < n; i++, j += 4)
    g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}

/* Fenyero-nyujtas: az 1. es 99. percentilis kozti savot huzzuk szet. */
function stretch(g) {
  var hist = new Int32Array(256), n = g.length, i;
  for (i = 0; i < n; i++) hist[g[i]]++;
  var lo = 0, hi = 255, acc = 0, cut = n / 100;
  for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > cut) { lo = i; break; } }
  acc = 0;
  for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > cut) { hi = i; break; } }
  if (hi - lo < 8) return null;                 /* egyenletes szurke: nincs mit nyujtani */
  var out = new Uint8Array(n), k = 255 / (hi - lo);
  for (i = 0; i < n; i++) {
    var v = (g[i] - lo) * k;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/* 3x3 atlagolas (doboz-szuro), a szelek kihagyva. */
function box3(g, w, h) {
  var out = new Uint8Array(g.length), x, y, i;
  for (y = 1; y < h - 1; y++)
    for (x = 1; x < w - 1; x++) {
      i = y * w + x;
      out[i] = (g[i - w - 1] + g[i - w] + g[i - w + 1] +
                g[i - 1]     + g[i]     + g[i + 1] +
                g[i + w - 1] + g[i + w] + g[i + w + 1]) / 9;
    }
  return out;
}

function avg2(a, b) {
  var out = new Uint8Array(a.length);
  for (var i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) >> 1;
  return out;
}

/* Szurke tomb -> RGBA ImageData-szeru objektum a dekodoloknak. */
function grayToRGBA(g, w, h) {
  var d = new Uint8ClampedArray(g.length * 4);
  for (var i = 0, j = 0; i < g.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = g[i]; d[j + 3] = 255; }
  return { data: d, width: w, height: h };
}

function withZX(img) {
  if (!zxReady || !ZX) return Promise.resolve(null);
  return ZX.readBarcodes(img, ZX_OPTS).then(function (res) {
    return (res && res.length && res[0].text) ? res[0].text : null;
  }).catch(function () { return null; });
}

function withJsQR(img) {
  if (!jsqrReady) return null;
  try {
    var r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return (r && r.data) ? r.data : null;
  } catch (e) { return null; }
}

var prevGray = null, prevW = 0, prevH = 0;

self.onmessage = function (ev) {
  var m = ev.data;
  if (!m) return;
  if (m.cmd === 'ping') {
    self.postMessage({ type: 'ready', zxing: zxReady, jsqr: jsqrReady });
    return;
  }
  if (m.cmd !== 'scan') return;

  var w = m.w, h = m.h, n = w * h;
  var rgba = new Uint8ClampedArray(m.data);
  var raw = { data: rgba, width: w, height: h };
  var gray = toGray(rgba, n);
  var prev = (prevGray && prevW === w && prevH === h) ? prevGray : null;
  prevGray = gray; prevW = w; prevH = h;

  function finish(text, how) {
    self.postMessage({ type: 'result', id: m.id, text: text || null, how: how || '' });
  }

  /* 1. nyers */
  withZX(raw).then(function (t) {
    if (t) { finish(t, 'ZXing'); return; }
    var st = stretch(gray);
    if (!st) { finish(withJsQR(raw), 'jsQR'); return; }
    var stImg = grayToRGBA(st, w, h);
    /* 2. nyujtott */
    return withZX(stImg).then(function (t) {
      if (t) { finish(t, 'ZXing+nyújtás'); return; }
      var sm = box3(st, w, h);
      var smImg = grayToRGBA(sm, w, h);
      /* 3. nyujtott + simitott */
      return withZX(smImg).then(function (t) {
        if (t) { finish(t, 'ZXing+nyújtás+simítás'); return; }
        /* 3b. erosebb simitas (ket menet = ~5x5 haromszog-szuro):
           nagyon sotet, zajos kepen ez a dontő lepes */
        var sm2 = box3(sm, w, h);
        var sm2Img = grayToRGBA(sm2, w, h);
        return withZX(sm2Img).then(function (t) {
          if (t) { finish(t, 'ZXing+nyújtás+erős simítás'); return; }
          /* 4. ket kepkocka atlaga (idobeli zajszures) */
          var p = Promise.resolve(null);
          if (prev) {
            var av = stretch(avg2(gray, prev));
            if (av) p = withZX(grayToRGBA(box3(box3(av, w, h), w, h), w, h));
          }
          return p.then(function (t) {
            if (t) { finish(t, 'ZXing+két kép átlaga'); return; }
            /* 4b. meg erosebb simitas (harom menet ~ 7x7): a modul a
               480 px-es kepen legalabb 8-10 px, ezt meg kibirja */
            var sm3Img = grayToRGBA(box3(sm2, w, h), w, h);
            return withZX(sm3Img).then(function (t) {
              if (t) { finish(t, 'ZXing+nyújtás+erős simítás'); return; }
              /* 5. jsQR -- mas algoritmus, vegso tartalek */
              finish(withJsQR(sm2Img) || withJsQR(smImg), 'jsQR');
            });
          });
        });
      });
    });
  });
};
