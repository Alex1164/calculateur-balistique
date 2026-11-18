#!/usr/bin/env python3
"""Assemble le site GitHub Pages du calculateur dans le dossier site/.

Sources (inchangées) : calculateur.html, solveur.js et polices/, dans le dossier de ce script.
Produit dans site/ :
  index.html            page autonome : doctype, solveur et polices intégrés (aucune ressource extérieure :
                        la page est aussi servie par l'appareil, sans internet), message sans JavaScript,
                        manifeste, icône d'écran d'accueil, enregistrement du service worker
  polices/LICENSE.txt   licence des polices intégrées (SIL Open Font License 1.1)
  manifest.webmanifest  nom, icônes, affichage plein écran
  sw.js                 cache hors ligne ; version = empreinte des fichiers du site
  icone-180.png, icone-192.png, icone-512.png   créées une fois (Pillow), conservées ensuite

À relancer après chaque modification de calculateur.html, de solveur.js ou de polices/ :
  python3 assembler_site.py
puis déposer le contenu de site/ sur le dépôt GitHub.
Bibliothèque standard seulement, sauf Pillow pour créer les icônes si elles manquent.
"""

import base64
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ICI = Path(__file__).resolve().parent
SITE = ICI / "site"
POLICES = ICI / "polices"
MOTIF_POLICE = re.compile(r'url\("polices/([A-Za-z0-9-]+\.woff2)"\)')
# Ressource chargée depuis un autre site : feuille de style, script, image, cadre, url() ou @import.
# Les liens <a href> des sources restent permis : ils ne sont suivis qu'au clic.
MOTIF_EXTERNE = re.compile(r'<(?:link|script|img|iframe|source|video|audio)\b[^>]*\b(?:href|src)\s*=\s*["\']?(?:https?:)?//'
                           r'|url\(\s*["\']?(?:https?:)?//|@import', re.IGNORECASE)
ICONES = {"icone-180.png": 180, "icone-192.png": 192, "icone-512.png": 512}
TEINTE = (13, 107, 102)  # --accent de la page, #0D6B66
FOND = "#ECF0F1"         # --fond de la page

INTERDITS = ["Alexandre"]  # site public : aucun prénom dans la page ni dans le code publié

BALISE_SOLVEUR = '<script src="solveur.js"></script>'
BALISE_PAGE = '<div class="page">'
MOTIF_VIEWPORT = re.compile(r'<meta name="viewport"[^>]*>')

ENTETE = """
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0D6B66">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Balistique">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icone-180.png">
<link rel="icon" type="image/png" href="icone-192.png">"""

SANS_JS = """
<noscript>
  <p style="margin:12px 0;padding:12px 14px;border:1px solid #B3261E;border-radius:10px;background:#FDECEA;color:#B3261E;font-weight:600">
    Cette page a besoin de JavaScript. Sur iPhone, l'aperçu de l'app Fichiers ne l'exécute pas : ouvre l'adresse du site dans Safari.
  </p>
</noscript>"""

ENREGISTREMENT_SW = """
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* fichier local : pas de cache hors ligne */ });
    });
  }
</script>
"""

SW = r"""/* Service worker du calculateur balistique, généré par assembler_site.py. Ne pas modifier à la main. */
const VERSION = '__VERSION__';
const CACHE = 'calculateur-' + VERSION;
const FICHIERS = ['./', 'index.html', 'manifest.webmanifest', 'icone-180.png', 'icone-192.png', 'icone-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

// Anciens caches effacés, dont « calculateur-polices » des polices Google (page 1.1.1 et avant).
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles
        .filter(k => k.startsWith('calculateur-') && k !== CACHE)
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
"""


def echec(message):
    sys.exit("assembler_site.py : " + message)


def une_fois(texte, motif, nom):
    n = texte.count(motif) if isinstance(motif, str) else len(motif.findall(texte))
    if n != 1:
        echec(f"{nom} trouvé {n} fois dans calculateur.html (attendu : 1).")


def integrer_polices(page):
    """Remplace chaque url("polices/<fichier>.woff2") par le fichier en data: (base64)."""
    def donnees(m):
        f = POLICES / m.group(1)
        if not f.is_file():
            echec(f"police {m.group(1)} absente de polices/.")
        return "url(data:font/woff2;base64," + base64.b64encode(f.read_bytes()).decode("ascii") + ")"
    page, n = MOTIF_POLICE.subn(donnees, page)
    if n == 0:
        echec('aucune police url("polices/….woff2") dans calculateur.html.')
    if not (POLICES / "LICENSE.txt").is_file():
        echec("polices/LICENSE.txt absent : la licence accompagne les polices.")
    return page, n


def creer_icones():
    manquantes = [n for n in ICONES if not (SITE / n).exists()]
    if not manquantes:
        return []
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        echec("icônes absentes de site/ et Pillow non installé : " + ", ".join(manquantes))
    # Réticule blanc sur fond plein, dessiné à 2048 px puis réduit (anticrénelage).
    # Contenu dans les 80 % centraux : l'iPhone arrondit les coins, Android peut rogner.
    t = 2048
    img = Image.new("RGB", (t, t), TEINTE)
    d = ImageDraw.Draw(img)
    c = t / 2
    blanc = (255, 255, 255)
    r, e = 0.29 * t, 0.045 * t  # rayon et épaisseur de l'anneau
    d.ellipse([c - r, c - r, c + r, c + r], outline=blanc, width=round(e))
    trait, vide, bout = 0.026 * t, 0.07 * t, 0.39 * t  # épaisseur, jour central, extrémité
    h = trait / 2
    for a, b in ((vide, bout), (-bout, -vide)):
        d.rectangle([c + a, c - h, c + b, c + h], fill=blanc)  # branches horizontales
        d.rectangle([c - h, c + a, c + h, c + b], fill=blanc)  # branches verticales
    p = 0.022 * t
    d.ellipse([c - p, c - p, c + p, c + p], fill=blanc)
    for nom in manquantes:
        img.resize((ICONES[nom], ICONES[nom]), Image.LANCZOS).save(SITE / nom, optimize=True)
    return manquantes


def main():
    page = (ICI / "calculateur.html").read_text(encoding="utf-8")
    solveur = (ICI / "solveur.js").read_text(encoding="utf-8")

    if page.lstrip().lower().startswith("<!doctype"):
        echec("calculateur.html a déjà un doctype : le script attend la page sans squelette.")
    une_fois(page, BALISE_SOLVEUR, BALISE_SOLVEUR)
    une_fois(page, BALISE_PAGE, BALISE_PAGE)
    une_fois(page, MOTIF_VIEWPORT, 'la balise meta viewport')
    if re.search(r"</script|<!--", solveur, re.IGNORECASE):
        echec("solveur.js contient « </script » ou « <!-- » : intégration impossible telle quelle.")

    page = MOTIF_VIEWPORT.sub(lambda m: m.group(0) + ENTETE, page, count=1)
    page = page.replace(BALISE_PAGE, BALISE_PAGE + SANS_JS, 1)
    page = page.replace(BALISE_SOLVEUR,
                        "<script>\n/* solveur.js, intégré par assembler_site.py */\n" + solveur.rstrip() + "\n</script>", 1)
    page, n_polices = integrer_polices(page)
    page = '<!DOCTYPE html>\n<html lang="fr">\n' + page.rstrip() + "\n" + ENREGISTREMENT_SW
    for mot in INTERDITS:
        if mot in page:
            echec(f"« {mot} » figure dans la page assemblée ; le site est public : "
                  "le retirer de calculateur.html ou de solveur.js.")
    externe = MOTIF_EXTERNE.search(page)
    if externe:
        echec(f"ressource extérieure dans la page assemblée ({externe.group(0)[:60]}…) : la page servie par "
              "l'appareil n'a pas internet ; l'intégrer ou la retirer.")

    SITE.mkdir(exist_ok=True)
    nouvelles = creer_icones()
    (SITE / "index.html").write_text(page, encoding="utf-8")
    (SITE / "polices").mkdir(exist_ok=True)
    shutil.copyfile(POLICES / "LICENSE.txt", SITE / "polices" / "LICENSE.txt")

    manifeste = {
        "name": "Calculateur balistique",
        "short_name": "Balistique",
        "lang": "fr",
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "background_color": FOND,
        "theme_color": "#0D6B66",
        "icons": [
            {"src": "icone-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
            {"src": "icone-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
    }
    (SITE / "manifest.webmanifest").write_text(json.dumps(manifeste, ensure_ascii=False, indent=2) + "\n",
                                                encoding="utf-8")

    empreinte = hashlib.sha256()
    for nom in ["index.html", "manifest.webmanifest", *ICONES]:
        empreinte.update((SITE / nom).read_bytes())
    version = empreinte.hexdigest()[:12]
    (SITE / "sw.js").write_text(SW.replace("__VERSION__", version), encoding="utf-8")

    print(f"site/ assemblé, version {version}, {n_polices} polices intégrées")
    for nom in ["index.html", "polices/LICENSE.txt", "sw.js", "manifest.webmanifest", *ICONES]:
        taille = (SITE / nom).stat().st_size
        print(f"  {nom:22s} {taille:>8d} o" + ("  (créée)" if nom in nouvelles else ""))


if __name__ == "__main__":
    main()
