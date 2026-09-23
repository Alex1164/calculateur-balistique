/* Service worker du calculateur balistique, généré par assembler_site.py. Ne pas modifier à la main. */
const VERSION = '687d3bd549d6';
const CACHE = 'calculateur-' + VERSION;
const POLICES = 'calculateur-polices';
const FICHIERS = ['./', 'index.html', 'manifest.webmanifest', 'icone-180.png', 'icone-192.png', 'icone-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles
        .filter(k => k.startsWith('calculateur-') && k !== CACHE && k !== POLICES)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Réseau avec délai : au-delà, on sert la copie en cache (réseau faible au pas de tir).
function reseau(requete, ms) {
  return new Promise((ok, echec) => {
    const minuterie = setTimeout(() => echec(new Error('délai dépassé')), ms);
    fetch(requete).then(
      r => { clearTimeout(minuterie); ok(r); },
      err => { clearTimeout(minuterie); echec(err); }
    );
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Polices Google : mises en cache à la première visite en ligne, servies depuis le cache ensuite.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(POLICES).then(async c => {
      const copie = await c.match(req);
      if (copie) return copie;
      const rep = await fetch(req);
      if (rep.ok || rep.type === 'opaque') c.put(req, rep.clone());
      return rep;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Page : réseau d'abord (dernière version si en ligne), cache sinon.
  if (req.mode === 'navigate') {
    e.respondWith(
      reseau(req, 4000)
        .then(rep => {
          if (!rep.ok) return caches.match('index.html').then(c => c || rep);
          const copie = rep.clone();
          caches.open(CACHE).then(c => c.put('index.html', copie));
          return rep;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Manifeste et icônes : cache d'abord.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});
