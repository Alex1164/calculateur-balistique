/*
 * solveur.js — Solveur balistique WMLRF, version 1.1.0
 * Domaine : Application balistique (voir ../application_balistique.md).
 *
 * Modèle : point matériel à 3 degrés de liberté, traînée G7 ou table de traînée importée (facteur
 * CDF), atmosphère variable avec l'altitude le long de la trajectoire, vent horizontal par zones
 * (vent près de l'arme, vent à distance ; traînée calculée sur la vitesse relative à l'air),
 * Coriolis vectoriel intégré dans l'équation du mouvement, dérive gyroscopique de Litz ajoutée au
 * temps de vol, saut aérodynamique de Litz, facteur d'échelle de chute (DSF) fonction du Mach à la
 * cible, avance sur cible mobile, dévers (rotation des corrections autour de la ligne de visée),
 * zéro vertical et latéral, zéro décalé (Zero Height, Zero Offset), Sight Scale Factor des tourelles,
 * probabilité de toucher (WEZ).
 * Hors modèle : vent variant continûment le long de la trajectoire.
 *
 * Repère local : origine au centre de la lunette ; x horizontal dans l'azimut du tir ;
 * y vertical vers le haut ; z horizontal vers la droite. Unités SI en interne.
 *
 * Conventions de sortie :
 *   élévation : correction de hausse par rapport au zéro, mrad, positive vers le haut ;
 *   dérive    : correction latérale, mrad, positive vers la droite (R), négative à gauche (L).
 *   Angles vrais ; le réglage à afficher aux tourelles s'en déduit par reglageLunette (Sight Scale Factor).
 */
(function (racine, fabrique) {
  if (typeof module === 'object' && module.exports) module.exports = fabrique();
  else racine.Solveur = fabrique();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Version de la page et du solveur (SemVer 2.0.0, https://semver.org) : MAJEUR.MINEUR.CORRECTIF, changée à chaque
  // modification publiée ; nouvelle fonction : mineur ; correction ou texte : correctif ; profil enregistré ou données
  // échangées avec l'appareil devenus incompatibles : majeur. Ajouter la ligne correspondante à la liste des versions
  // de calculateur.html (avis de mise à jour).
  const VERSION = '1.4.0';

  // ---------------------------------------------------------------------------
  // Constantes et sources
  // ---------------------------------------------------------------------------

  // Rotation de la Terre et pesanteur normale : WGS 84, NGA.STND.0036 v1.0.0 (2014).
  const OMEGA_TERRE = 7.292115e-5;        // rad/s
  const GAMMA_EQUATEUR = 9.7803253359;    // m/s²
  const K_SOMIGLIANA = 1.93185265241e-3;
  const E2_WGS84 = 6.69437999014e-3;

  // Atmosphère le long de la trajectoire : U.S. Standard Atmosphere 1976, couche 0–11 km.
  const G0 = 9.80665;                     // m/s²
  const M_AIR_US76 = 0.0289644;           // kg/mol
  const R_US76 = 8.31432;                 // J/(mol·K)
  const GRADIENT_T = 0.0065;              // K/m (la température baisse quand on monte)
  const EXPOSANT_P = G0 * M_AIR_US76 / (R_US76 * GRADIENT_T);

  // Vitesse du son : a = 331,3 × √(1 + T/273,15), acquis (kestrel-5700-ble-decodage.md, § 7).
  const A0_SON = 331.3;

  // Conversions exactes (définitions) sauf le pouce de mercure (NIST SP 811, conventionnel).
  const POUCE = 0.0254;                   // m
  const PIED = 0.3048;                    // m
  const LB_PAR_IN2 = 0.45359237 / (POUCE * POUCE); // 1 lb/in² en kg/m² (≈ 703,07)
  const HPA_PAR_INHG = 33.86389;          // hPa
  const MOA_EN_MRAD = Math.PI / 10.8;     // 1 MOA = 1/60° = 0,2908882 mrad
  const MPH_EN_MS = 0.44704;              // 1 mph en m/s

  // Loi de traînée G7 (Mach, Cd) : JBM Ballistics, mcg7.txt, 84 points ;
  // identique point à point à la table G7 de py-ballisticcalc (vérifié le 2026-09-22).
  const G7_MACH = [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60,
    0.65, 0.70, 0.725, 0.75, 0.775, 0.80, 0.825, 0.85, 0.875, 0.90, 0.925, 0.95, 0.975, 1.0,
    1.025, 1.05, 1.075, 1.10, 1.125, 1.15, 1.20, 1.25, 1.30, 1.35, 1.40, 1.50, 1.55, 1.60, 1.65,
    1.70, 1.75, 1.80, 1.85, 1.90, 1.95, 2.00, 2.05, 2.10, 2.15, 2.20, 2.25, 2.30, 2.35, 2.40,
    2.45, 2.50, 2.55, 2.60, 2.65, 2.70, 2.75, 2.80, 2.85, 2.90, 2.95, 3.00, 3.10, 3.20, 3.30,
    3.40, 3.50, 3.60, 3.70, 3.80, 3.90, 4.00, 4.20, 4.40, 4.60, 4.80, 5.00];
  const G7_CD = [0.1198, 0.1197, 0.1196, 0.1194, 0.1193, 0.1194, 0.1194, 0.1194, 0.1193, 0.1193,
    0.1194, 0.1193, 0.1194, 0.1197, 0.1202, 0.1207, 0.1215, 0.1226, 0.1242, 0.1266, 0.1306,
    0.1368, 0.1464, 0.1660, 0.2054, 0.2993, 0.3803, 0.4015, 0.4043, 0.4034, 0.4014, 0.3987,
    0.3955, 0.3884, 0.3810, 0.3732, 0.3657, 0.3580, 0.3440, 0.3376, 0.3315, 0.3260, 0.3209,
    0.3160, 0.3117, 0.3078, 0.3042, 0.3010, 0.2980, 0.2951, 0.2922, 0.2892, 0.2864, 0.2835,
    0.2807, 0.2779, 0.2752, 0.2725, 0.2697, 0.2670, 0.2643, 0.2615, 0.2588, 0.2561, 0.2533,
    0.2506, 0.2479, 0.2451, 0.2424, 0.2368, 0.2313, 0.2258, 0.2205, 0.2154, 0.2106, 0.2060,
    0.2017, 0.1975, 0.1935, 0.1861, 0.1793, 0.1730, 0.1672, 0.1618];

  // ---------------------------------------------------------------------------
  // Interpolation PCHIP (Fritsch–Carlson, pentes aux nœuds par moyenne harmonique
  // pondérée, même algorithme que scipy.interpolate.PchipInterpolator).
  // ---------------------------------------------------------------------------

  function signe(a) { return a > 0 ? 1 : (a < 0 ? -1 : 0); }

  function pchipBord(h0, h1, m0, m1) {
    let d = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
    if (signe(d) !== signe(m0)) d = 0;
    else if (signe(m0) !== signe(m1) && Math.abs(d) > Math.abs(3 * m0)) d = 3 * m0;
    return d;
  }

  function pchipPreparer(x, y) {
    const n = x.length;
    const h = new Array(n - 1), d = new Array(n - 1), m = new Array(n);
    for (let i = 0; i < n - 1; i++) {
      h[i] = x[i + 1] - x[i];
      if (!(h[i] > 0)) throw new Error('PCHIP : abscisses non strictement croissantes');
      d[i] = (y[i + 1] - y[i]) / h[i];
    }
    for (let k = 1; k < n - 1; k++) {
      if (d[k - 1] === 0 || d[k] === 0 || signe(d[k - 1]) !== signe(d[k])) m[k] = 0;
      else {
        const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
        m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
      }
    }
    m[0] = pchipBord(h[0], h[1], d[0], d[1]);
    m[n - 1] = pchipBord(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    let dernier = 0; // intervalle du dernier appel : le Mach varie lentement
    return function (xv) {
      if (xv <= x[0]) return y[0];
      if (xv >= x[n - 1]) return y[n - 1];
      let i = dernier;
      if (!(x[i] <= xv && xv < x[i + 1])) {
        let bas = 0, haut = n - 1;
        while (haut - bas > 1) { const mil = (bas + haut) >> 1; if (x[mil] <= xv) bas = mil; else haut = mil; }
        i = bas; dernier = i;
      }
      const hh = h[i], t = (xv - x[i]) / hh, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * hh * m[i]
        + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * hh * m[i + 1];
    };
  }

  function cdG7Nouveau() { return pchipPreparer(G7_MACH, G7_CD); }
  const cdG7 = cdG7Nouveau();

  // ---------------------------------------------------------------------------
  // Atmosphère
  // ---------------------------------------------------------------------------

  // Densité de l'air humide : formule CIPM-2007, Picard et al., Metrologia 45 (2008) 149–155.
  // Domaine de validité de la formule : 600–1100 hPa, 15–27 °C ; au-delà, extrapolation.
  function densiteAir(tC, pHPa, hrPct) {
    const TK = tC + 273.15, p = pHPa * 100;
    const psv = Math.exp(1.2378847e-5 * TK * TK - 1.9121316e-2 * TK + 33.93711047 - 6.3431645e3 / TK);
    const f = 1.00062 + 3.14e-8 * p + 5.6e-7 * tC * tC;
    const xv = Math.min(Math.max(hrPct, 0), 100) / 100 * f * psv / p;
    const Z = 1 - (p / TK) * (1.58123e-6 - 2.9331e-8 * tC + 1.1043e-10 * tC * tC
      + (5.707e-6 - 2.051e-8 * tC) * xv + (1.9898e-4 - 2.376e-6 * tC) * xv * xv)
      + (p / TK) * (p / TK) * (1.83e-11 - 0.765e-8 * xv * xv);
    const Ma = 28.96546e-3, Mv = 18.01528e-3, R = 8.314472;
    return p * Ma / (Z * R * TK) * (1 - xv * (1 - Mv / Ma));
  }

  function vitesseSon(tC) { return A0_SON * Math.sqrt(1 + tC / 273.15); }

  function graviteNormale(latDeg) {
    const s2 = Math.pow(Math.sin(latDeg * Math.PI / 180), 2);
    return GAMMA_EQUATEUR * (1 + K_SOMIGLIANA * s2) / Math.sqrt(1 - E2_WGS84 * s2);
  }

  // ---------------------------------------------------------------------------
  // Munition
  // ---------------------------------------------------------------------------

  // Table vitesse initiale / température : 1 à 3 points ; interpolation linéaire par
  // morceaux, extrapolation linéaire sur le segment extrême hors plage.
  function vitesseInitiale(table, tC) {
    const pts = (table || []).filter(p => isFinite(p.tempC) && isFinite(p.v0) && p.v0 > 0)
      .map(p => ({ tempC: +p.tempC, v0: +p.v0 })).sort((a, b) => a.tempC - b.tempC);
    if (pts.length === 0) throw new Error('Table V0 : au moins un point (température, V0) est requis.');
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].tempC === pts[i - 1].tempC) throw new Error('Table V0 : deux points ont la même température.');
    }
    if (pts.length === 1) return { v0: pts[0].v0, extrapolee: false, points: 1 };
    let i = 0;
    if (tC >= pts[pts.length - 1].tempC) i = pts.length - 2;
    else if (tC > pts[0].tempC) { while (!(pts[i].tempC <= tC && tC <= pts[i + 1].tempC)) i++; }
    const a = pts[i], b = pts[i + 1];
    const v0 = a.v0 + (tC - a.tempC) * (b.v0 - a.v0) / (b.tempC - a.tempC);
    return { v0: v0, extrapolee: tC < pts[0].tempC || tC > pts[pts.length - 1].tempC, points: pts.length };
  }

  // Loi V0 du profil : pente (V0 de référence, température de référence, m/s par °C) si elle est
  // donnée, sinon table. La pente est une loi linéaire, sans extrapolation à signaler.
  function loiV0(profil, tC) {
    const p = profil.penteV0;
    if (p) {
      if (!(p.v0 > 0) || !isFinite(p.tempC) || !isFinite(p.penteMSparC)) {
        throw new Error('Pente V0 : V0, température et pente sont requises.');
      }
      return { v0: p.v0 + p.penteMSparC * (tC - p.tempC), extrapolee: false, points: 0 };
    }
    return vitesseInitiale(profil.tableV0, tC);
  }

  // Stabilité gyroscopique, règle de Miller avec corrections de vitesse et d'atmosphère :
  // Courtney & Miller, « A Stability Formula for Plastic-Tipped Bullets », arXiv:1410.5340.
  // SG = 30 m / (t² d³ l (1 + l²)) × (V/2800)^(1/3) × ((F + 460)/(59 + 460)) × (29,92/P)
  // m en grains, t en calibres par tour, d en pouces, l en calibres, V en ft/s, F en °F, P en inHg.
  function stabiliteMiller(masseGr, diametreM, longueurM, pasM, v0MS, tC, pHPa) {
    const d = diametreM / POUCE, t = (pasM / POUCE) / d, l = (longueurM / POUCE) / d;
    const sg0 = 30 * masseGr / (t * t * d * d * d * l * (1 + l * l));
    const fv = Math.pow(v0MS / PIED / 2800, 1 / 3);
    const F = tC * 9 / 5 + 32, P = pHPa / HPA_PAR_INHG;
    const fa = ((F + 460) / (59 + 460)) * (29.92 / P);
    return sg0 * fv * fa;
  }

  // Dérive gyroscopique de Litz (Applied Ballistics for Long Range Shooting) :
  // SD [in] = 1,25 × (SG + 1,2) × TOF^1,83. Retour en mètres, du côté du sens du pas.
  function deriveGyroscopique(sg, tofS) {
    return 1.25 * (sg + 1.2) * Math.pow(tofS, 1.83) * POUCE;
  }

  // Saut aérodynamique de Litz (Applied Ballistics for Long Range Shooting, chap. 5) :
  // sensibilité = 0,01 SG − 0,0024 l + 0,032 MOA par mph de vent traversier (l en calibres).
  // Retour en mrad par m/s. Pas à droite : vent venant de la gauche → impact bas.
  function sensibiliteSautAero(sg, longueurCalibres) {
    return (0.01 * sg - 0.0024 * longueurCalibres + 0.032) * MOA_EN_MRAD / MPH_EN_MS;
  }

  // Vent horizontal constant. directionHeures : d'où vient le vent, sur le cadran de la ligne de
  // tir (12 h = de face, 3 h = de la droite, 6 h = dans le dos, 9 h = de la gauche).
  // Retour : vitesse de l'air dans le repère local (x vers la cible, z vers la droite).
  function vecteurVent(vitesseMS, directionHeures) {
    const th = directionHeures * Math.PI / 6;
    return [-vitesseMS * Math.cos(th), 0, -vitesseMS * Math.sin(th)];
  }

  // Facteur d'échelle de chute (DSF) au Mach de la balle à la cible : table (Mach, DSF),
  // interpolation linéaire en Mach ; au-dessus du Mach le plus élevé et au-dessous du plus bas,
  // valeur du point extrême. Table vide : 1.
  function facteurDSF(table, mach) {
    const pts = (table || []).filter(p => isFinite(p.mach) && isFinite(p.dsf) && p.dsf > 0)
      .map(p => ({ mach: +p.mach, dsf: +p.dsf })).sort((a, b) => b.mach - a.mach);
    if (!pts.length) return 1;
    if (mach >= pts[0].mach) return pts[0].dsf;
    const n = pts.length;
    if (mach <= pts[n - 1].mach) return pts[n - 1].dsf;
    let i = 0;
    while (!(pts[i].mach >= mach && mach >= pts[i + 1].mach)) i++;
    const a = pts[i], b = pts[i + 1];
    if (a.mach === b.mach) return b.dsf;
    return a.dsf + (mach - a.mach) * (b.dsf - a.dsf) / (b.mach - a.mach);
  }

  // ---------------------------------------------------------------------------
  // Intégration de la trajectoire
  // ---------------------------------------------------------------------------

  // vent : vecteur du vent près de l'arme (ou null) ; zones : [{ x0, W }] triées par x0 croissant, vent W
  // à partir de l'abscisse horizontale x0 (m), jusqu'à la zone suivante.
  function contexte(v0, atmo, commun, coriolis, vent, zones) {
    const TK0 = atmo.tempC + 273.15;
    const ctx = {
      v0: v0,
      TK0: TK0,
      rho0: densiteAir(atmo.tempC, atmo.pressionHPa, atmo.humiditePct),
      kTrainee: Math.PI / 8 / (commun.bcG7 * LB_PAR_IN2) * (commun.cdf || 1),
      vent: vent || null,
      zones: zones && zones.length ? zones : null,
      g: commun.g,
      h: commun.hauteurViseurM,
      decalageVertical: commun.decalageVertical,
      dt: commun.dt,
      tMax: commun.tMax,
      cd: commun.cd,
      a0Son: commun.a0Son || A0_SON,
      seuilAtmo: commun.seuilAtmo || 0,
      omega: null
    };
    if (coriolis) {
      const phi = coriolis.latitudeDeg * Math.PI / 180, A = coriolis.azimutDeg * Math.PI / 180;
      ctx.omega = [OMEGA_TERRE * Math.cos(phi) * Math.cos(A), OMEGA_TERRE * Math.sin(phi),
        -OMEGA_TERRE * Math.cos(phi) * Math.sin(A)];
    }
    return ctx;
  }

  // Accélération (m/s²) ; parmi les positions, l'abscisse x (zones de vent) et l'altitude y interviennent.
  // La traînée porte sur la vitesse relative à l'air (vent), Coriolis sur la vitesse par rapport au sol.
  function acceleration(ctx, x, y, vx, vy, vz, sortie) {
    let W = ctx.vent;
    if (ctx.zones) { for (const zn of ctx.zones) { if (x >= zn.x0) W = zn.W; } }
    const rx = W ? vx - W[0] : vx, ry = vy, rz = W ? vz - W[2] : vz;
    const v = Math.sqrt(rx * rx + ry * ry + rz * rz);
    let TK = ctx.TK0, rho = ctx.rho0;
    if (Math.abs(y) >= ctx.seuilAtmo) { // seuil nul par défaut : atmosphère variable partout
      TK = ctx.TK0 - GRADIENT_T * y;
      rho = ctx.rho0 * Math.pow(TK / ctx.TK0, EXPOSANT_P) * ctx.TK0 / TK;
    }
    const son = ctx.a0Son * Math.sqrt(TK / 273.15);
    const k = ctx.kTrainee * rho * ctx.cd(v / son) * v;
    let ax = -k * rx, ay = -k * ry - ctx.g, az = -k * rz;
    const O = ctx.omega;
    if (O) { // Coriolis : a = -2 Ω × v
      ax -= 2 * (O[1] * vz - O[2] * vy);
      ay -= 2 * (O[2] * vx - O[0] * vz);
      az -= 2 * (O[0] * vy - O[1] * vx);
    }
    sortie[0] = ax; sortie[1] = ay; sortie[2] = az;
  }

  // Intègre depuis la bouche, canon incliné de beta (rad) sur l'horizontale, jusqu'à
  // l'abscisse horizontale xCible. Renvoie l'état interpolé en xCible, ou null si la balle
  // n'y parvient pas.
  function tracer(ctx, beta, xCible) {
    const h = ctx.h, dt = ctx.dt;
    let x = ctx.decalageVertical ? 0 : h * Math.sin(beta);
    let y = ctx.decalageVertical ? -h : -h * Math.cos(beta);
    let z = 0, t = 0;
    let vx = ctx.v0 * Math.cos(beta), vy = ctx.v0 * Math.sin(beta), vz = 0;
    if (xCible <= x) return { t: 0, x: x, y: y, z: z, vx: vx, vy: vy, vz: vz };
    const a1 = [0, 0, 0], a2 = [0, 0, 0], a3 = [0, 0, 0], a4 = [0, 0, 0];
    for (;;) {
      acceleration(ctx, x, y, vx, vy, vz, a1);
      const vx2 = vx + 0.5 * dt * a1[0], vy2 = vy + 0.5 * dt * a1[1], vz2 = vz + 0.5 * dt * a1[2];
      acceleration(ctx, x + 0.5 * dt * vx, y + 0.5 * dt * vy, vx2, vy2, vz2, a2);
      const vx3 = vx + 0.5 * dt * a2[0], vy3 = vy + 0.5 * dt * a2[1], vz3 = vz + 0.5 * dt * a2[2];
      acceleration(ctx, x + 0.5 * dt * vx2, y + 0.5 * dt * vy2, vx3, vy3, vz3, a3);
      const vx4 = vx + dt * a3[0], vy4 = vy + dt * a3[1], vz4 = vz + dt * a3[2];
      acceleration(ctx, x + dt * vx3, y + dt * vy3, vx4, vy4, vz4, a4);
      const xn = x + dt / 6 * (vx + 2 * vx2 + 2 * vx3 + vx4);
      const yn = y + dt / 6 * (vy + 2 * vy2 + 2 * vy3 + vy4);
      const zn = z + dt / 6 * (vz + 2 * vz2 + 2 * vz3 + vz4);
      const vxn = vx + dt / 6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
      const vyn = vy + dt / 6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
      const vzn = vz + dt / 6 * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
      if (xn >= xCible) {
        // Hermite cubique en temps entre les deux pas ; fraction s telle que x(s) = xCible.
        const H = (s, p0, p1, d0, d1) => {
          const s2 = s * s, s3 = s2 * s;
          return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * dt * d0
            + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * dt * d1;
        };
        const dH = (s, p0, p1, d0, d1) => {
          const s2 = s * s;
          return ((6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * dt * d0
            + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * dt * d1);
        };
        let s = (xCible - x) / (xn - x);
        for (let i = 0; i < 5; i++) {
          s -= (H(s, x, xn, vx, vxn) - xCible) / dH(s, x, xn, vx, vxn);
        }
        return {
          t: t + s * dt,
          x: xCible,
          y: H(s, y, yn, vy, vyn),
          z: H(s, z, zn, vz, vzn),
          vx: vx + s * (vxn - vx), vy: vy + s * (vyn - vy), vz: vz + s * (vzn - vz)
        };
      }
      x = xn; y = yn; z = zn; vx = vxn; vy = vyn; vz = vzn; t += dt;
      if (t > ctx.tMax || vx <= 0) return null;
    }
  }

  // Angle du canon (rad, sur l'horizontale) pour passer par le point situé à la distance
  // oblique R sous l'angle de site theta. Méthode de la sécante.
  function resoudreAngle(ctx, R, theta, betaDepart) {
    const xc = R * Math.cos(theta), yc = R * Math.sin(theta);
    const hors = () => new Error('Cible hors de portée pour ce profil et ces conditions (' + R + ' m).');
    let b0 = betaDepart, p0 = tracer(ctx, b0, xc);
    if (!p0) throw hors();
    let e0 = p0.y - yc;
    let b1 = b0 - e0 * Math.pow(Math.cos(b0), 2) / xc, p1 = tracer(ctx, b1, xc);
    if (!p1) throw hors();
    let e1 = p1.y - yc;
    for (let i = 0; i < 50; i++) {
      if (Math.abs(e1) < 1e-7 || Math.abs(b1 - b0) < 1e-13) return { beta: b1, point: p1 };
      const b2 = b1 - e1 * (b1 - b0) / (e1 - e0);
      if (!isFinite(b2) || b2 > theta + 0.8 || b2 < theta - 0.8) throw hors();
      const p2 = tracer(ctx, b2, xc);
      if (!p2) throw hors();
      b0 = b1; e0 = e1; b1 = b2; p1 = p2; e1 = p2.y - yc;
    }
    throw new Error('Le calcul de l\'angle ne converge pas (' + R + ' m).');
  }

  // ---------------------------------------------------------------------------
  // Interface
  // ---------------------------------------------------------------------------

  function verifier(cond, message) { if (!cond) throw new Error(message); }

  function verifierEntrees(profil, tir) {
    const tp = profil.traineePerso;
    if (tp) {
      verifier(Array.isArray(tp) && tp.length >= 2 && tp.every(p => isFinite(p.mach) && p.mach >= 0 && p.cd > 0),
        'Table de traînée : au moins deux points (Mach, Cd) positifs.');
    } else {
      verifier(profil.bcG7 > 0, 'Coefficient balistique G7 : valeur positive requise.');
    }
    verifier(profil.masseGrains > 0, 'Poids de balle : valeur positive requise.');
    verifier(profil.diametreM > 0, 'Diamètre de balle : valeur positive requise.');
    verifier(profil.longueurM > profil.diametreM, 'Longueur de balle : doit dépasser le diamètre.');
    verifier(profil.pasM > 0, 'Pas de rayure : valeur positive requise.');
    verifier(profil.hauteurViseurM >= 0, 'Entraxe : valeur positive ou nulle requise.');
    verifier(profil.distanceZeroM > 0, 'Distance de zéro : valeur positive requise.');
    verifier(profil.cdf === undefined || profil.cdf === null || (profil.cdf >= 0.3 && profil.cdf <= 3),
      'CDF : entre 0,3 et 3.');
    const facultatif = (v, ok) => v === undefined || v === null || ok(+v);
    verifier(facultatif(profil.zeroHauteurM, v => Math.abs(v) < 1), 'Zero Height : entre −100 et 100 cm.');
    verifier(facultatif(profil.zeroDecalageM, v => Math.abs(v) < 1), 'Zero Offset : entre −100 et 100 cm.');
    verifier(facultatif(profil.ssfElevation, v => v >= 0.5 && v <= 2), 'SSF Elevation : entre 0,5 et 2.');
    verifier(facultatif(profil.ssfDerive, v => v >= 0.5 && v <= 2), 'SSF Windage : entre 0,5 et 2.');
    verifier(tir.distanceM > 0, 'Distance : valeur positive requise.');
    verifier(tir.pressionHPa > 100 && tir.pressionHPa < 1200, 'Pression : entre 100 et 1200 hPa.');
    verifier(tir.humiditePct >= 0 && tir.humiditePct <= 100, 'Humidité : entre 0 et 100 %.');
    verifier(tir.tempC > -60 && tir.tempC < 60, 'Température : entre −60 et 60 °C.');
    verifier(Math.abs(tir.latitudeDeg) <= 90, 'Latitude : entre −90 et 90°.');
    verifier(Math.abs(tir.siteDeg) < 80, 'Angle de site : entre −80 et 80°.');
    verifier(isFinite(tir.azimutDeg), 'Azimut : valeur requise.');
    const z = profil.zero;
    if (z) { // sans conditions de zérotage, le zéro est calculé dans les conditions du tir
      verifier(z.pressionHPa > 100 && z.pressionHPa < 1200, 'Zéro : pression entre 100 et 1200 hPa.');
      verifier(z.humiditePct >= 0 && z.humiditePct <= 100, 'Zéro : humidité entre 0 et 100 %.');
      verifier(z.tempC > -60 && z.tempC < 60, 'Zéro : température entre −60 et 60 °C.');
    }
    verifier(tir.deversDeg === undefined || tir.deversDeg === null || Math.abs(tir.deversDeg) <= 90,
      'Dévers : entre −90 et 90°.');
    const v = tir.vent;
    if (v) {
      verifier(v.vitesse1MS >= 0 && v.vitesse1MS < 60, 'Vent 1 : entre 0 et 60 m/s.');
      verifier(v.vitesse2MS === null || v.vitesse2MS === undefined || (v.vitesse2MS >= 0 && v.vitesse2MS < 60),
        'Vent 2 : entre 0 et 60 m/s.');
      verifier(isFinite(v.directionHeures), 'Direction du vent : valeur requise.');
    }
    const vz = tir.ventZone;
    if (vz) {
      verifier(vz.distanceM >= 0, 'Vent à distance : distance positive ou nulle requise.');
      verifier(vz.vitesseMS >= 0 && vz.vitesseMS < 60, 'Vent à distance : entre 0 et 60 m/s.');
      verifier(isFinite(vz.directionHeures), 'Vent à distance : direction requise.');
    }
    const c = tir.cible;
    if (c) {
      verifier(c.vitesseMS >= 0 && c.vitesseMS < 100, 'Cible mobile : vitesse entre 0 et 100 m/s.');
      verifier(isFinite(c.angleDeg), 'Cible mobile : angle requis.');
    }
  }

  // Prépare le calcul : zéro de l'arme et contextes d'intégration pour les conditions du tir.
  // Zéro vertical : tir à plat sans vent ni Coriolis, dans les conditions du zérotage (profil.zero, V0 de sa
  // température) ; sans profil.zero, dans les conditions du tir (température, pression, humidité, V0 de la
  // poudre du jour) : l'élévation à la distance de zéro est alors toujours nulle.
  // Zéro latéral (option zeroLateral) : au zérotage, le tireur ramène aussi l'impact sur l'axe vertical du
  // réticule ; la dérive gyroscopique et le Coriolis horizontal à la distance de zéro sont absorbés par ce
  // réglage et retranchés, en angle, des corrections de dérive (dérive nulle à la distance de zéro).
  // Zéro décalé (Zero Height, Zero Offset d'Applied Ballistics : profil.zeroHauteurM, profil.zeroDecalageM, m) :
  // à la distance de zéro, le point d'impact est à zeroHauteurM au-dessus du point visé (+ en haut) et à
  // zeroDecalageM à droite (+ à droite, − à gauche) ; autre munition, silencieux, optique de nuit. Le zéro vertical
  // est résolu pour passer par ce point ; le décalage latéral est retranché du zéro latéral, en angle.
  // Options : dt (pas d'intégration, s) ; coriolis, deriveGyro, sautAero, dsfActif, decomposition
  // (parts de Coriolis et du vent), zeroLateral : booléens ; gravite (m/s², sinon pesanteur normale WGS 84
  // à la latitude) ; tMax (s). Réservées aux comparaisons : decalageVertical (entraxe compté à la
  // verticale), vitesseSonA0 (m/s à 0 °C), seuilAtmosphereM (atmosphère figée sous ce seuil de |y|).
  function preparer(profil, tir, options) {
    const opt = Object.assign({ dt: 0.001, coriolis: true, deriveGyro: true, sautAero: true, dsfActif: true,
      zeroLateral: true, gravite: null, decalageVertical: false, tMax: 30, decomposition: true,
      vitesseSonA0: null, seuilAtmosphereM: 0 }, options || {});
    verifierEntrees(profil, tir);
    const g = opt.gravite || graviteNormale(tir.latitudeDeg);
    const commun = { bcG7: profil.bcG7, cdf: profil.cdf || 1, g: g, hauteurViseurM: profil.hauteurViseurM,
      decalageVertical: opt.decalageVertical, dt: opt.dt, tMax: opt.tMax, cd: cdG7Nouveau(),
      a0Son: opt.vitesseSonA0, seuilAtmo: opt.seuilAtmosphereM };
    if (profil.traineePerso) {
      // Table de traînée propre à la balle (Cd absolu, Mach) : décélération = ρ v² Cd (π d²/4) / (2 m),
      // soit la forme G7 avec un « BC » égal à la densité de section m/d² (lb/in²) et la table à la place de G7.
      const pts = profil.traineePerso.map(p => ({ mach: +p.mach, cd: +p.cd })).sort((a, b) => a.mach - b.mach);
      commun.cd = pchipPreparer(pts.map(p => p.mach), pts.map(p => p.cd));
      commun.bcG7 = (profil.masseGrains / 7000) / Math.pow(profil.diametreM / POUCE, 2);
    }

    const tPoudre = (tir.tempPoudreC === null || tir.tempPoudreC === undefined || tir.tempPoudreC === '')
      ? tir.tempC : +tir.tempPoudreC;
    const atmo = { tempC: tir.tempC, pressionHPa: tir.pressionHPa, humiditePct: tir.humiditePct };
    const zeroActif = !!profil.zero;
    const atmoZero = zeroActif ? profil.zero : atmo;
    const v0Zero = loiV0(profil, zeroActif ? profil.zero.tempC : tPoudre);
    const main = profil.pasSens === -1 ? -1 : 1;
    // Option zeroFixe { betaZero, zeroGyro, zeroCor } (rad) : réglage de l'arme imposé (WEZ : une variation de V0, de
    // traînée ou de conditions d'un coup à l'autre ne change pas le zéro fait une fois pour toutes).
    const zf = opt.zeroFixe;
    const R0 = profil.distanceZeroM, zh = +profil.zeroHauteurM || 0, zo = +profil.zeroDecalageM || 0;
    const zeroSol = zf ? { beta: zf.betaZero }
      : resoudreAngle(contexte(v0Zero.v0, atmoZero, commun, null, null), Math.hypot(R0, zh), Math.atan2(zh, R0), 0);
    const zeroDecalage = Math.atan2(zo, R0); // rad, + = impact à droite du point visé à la distance de zéro

    let zeroGyro = zf ? (zf.zeroGyro || 0) : 0, zeroCor = zf ? (zf.zeroCor || 0) : 0; // rad, déviations latérales absorbées par le zéro (+ = balle à droite)
    if (opt.zeroLateral && !zf) {
      const corZ = opt.coriolis ? { latitudeDeg: tir.latitudeDeg, azimutDeg: tir.azimutDeg } : null;
      const pz = tracer(contexte(v0Zero.v0, atmoZero, commun, corZ, null), zeroSol.beta, profil.distanceZeroM);
      if (pz) {
        zeroCor = Math.atan2(pz.z, profil.distanceZeroM);
        if (opt.deriveGyro) {
          const sgZ = stabiliteMiller(profil.masseGrains, profil.diametreM, profil.longueurM, profil.pasM,
            v0Zero.v0, atmoZero.tempC, atmoZero.pressionHPa);
          zeroGyro = Math.atan2(main * deriveGyroscopique(sgZ, pz.t), profil.distanceZeroM);
        }
      }
    }

    const v0 = loiV0(profil, tPoudre);
    const cor = opt.coriolis ? { latitudeDeg: tir.latitudeDeg, azimutDeg: tir.azimutDeg } : null;
    const vent = tir.vent || null;
    const w1 = vent && vent.vitesse1MS > 0 ? vecteurVent(vent.vitesse1MS, vent.directionHeures) : null;
    const aVent2 = !!vent && vent.vitesse2MS !== null && vent.vitesse2MS !== undefined && vent.vitesse2MS !== '';
    const w2 = aVent2 && +vent.vitesse2MS > 0 ? vecteurVent(+vent.vitesse2MS, vent.directionHeures) : null;
    // Vent à distance : remplace le vent 1 (et le vent 2) à partir de la distance donnée, comptée sur la ligne
    // de tir ; l'abscisse horizontale de départ vaut distance × cos(site).
    const vz = tir.ventZone || null;
    const zones = vz ? [{ x0: vz.distanceM * Math.cos(tir.siteDeg * Math.PI / 180),
      W: vz.vitesseMS > 0 ? vecteurVent(vz.vitesseMS, vz.directionHeures) : null }] : null;
    const ctx = contexte(v0.v0, atmo, commun, cor, w1, zones);
    const ctxVent2 = aVent2 ? contexte(v0.v0, atmo, commun, cor, w2, zones) : null;
    const ctxSansCoriolis = opt.coriolis ? contexte(v0.v0, atmo, commun, null, w1, zones) : null;
    const avecVent = !!w1 || !!(zones && zones[0].W);
    const ctxSansVent = avecVent ? contexte(v0.v0, atmo, commun, cor, null) : null;
    const sg = stabiliteMiller(profil.masseGrains, profil.diametreM, profil.longueurM, profil.pasM,
      v0.v0, tir.tempC, tir.pressionHPa);
    const sensAJ = sensibiliteSautAero(sg, profil.longueurM / profil.diametreM);
    // Correction de hausse due au saut : main × sensibilité × vent traversier vers la droite (w[2]) à la
    // bouche (le saut naît au départ du coup : vent à distance seulement s'il commence à la bouche).
    const saut = w => (opt.sautAero && w) ? main * sensAJ * w[2] : 0;
    const aBouche = w => (zones && zones[0].x0 <= 0) ? zones[0].W : w;

    return { profil: profil, tir: tir, opt: opt, g: g, commun: commun, atmo: atmo, betaZero: zeroSol.beta,
      zeroActif: zeroActif, zeroGyro: zeroGyro, zeroCor: zeroCor, zeroDecalage: zeroDecalage,
      zeroLateral: zeroGyro + zeroCor - zeroDecalage,
      v0Zero: v0Zero, v0: v0, tempPoudreC: tPoudre, ctx: ctx, ctxVent2: ctxVent2,
      ctxSansCoriolis: ctxSansCoriolis, ctxSansVent: ctxSansVent, sg: sg, main: main, sensAJ: sensAJ,
      saut1: saut(aBouche(w1)), saut2: aVent2 ? saut(aBouche(w2)) : null, aVent2: aVent2, avecVent: avecVent,
      rho: ctx.rho0, son: ctx.a0Son * Math.sqrt(1 + tir.tempC / 273.15) };
  }

  // Une solution pour un contexte donné : angle du canon, élévation (DSF puis saut), dérive (zéro latéral
  // retranché).
  function uneSolution(prep, ctx, R, theta, saut, betaDepart) {
    const sol = resoudreAngle(ctx, R, theta, betaDepart);
    const p = sol.point;
    const sd = prep.opt.deriveGyro ? prep.main * deriveGyroscopique(prep.sg, p.t) : 0;
    const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    const TK = ctx.TK0 - GRADIENT_T * p.y;
    const mach = v / (ctx.a0Son * Math.sqrt(TK / 273.15));
    const brute = (sol.beta - theta - prep.betaZero) * 1000;
    const dsf = prep.opt.dsfActif ? facteurDSF(prep.profil.dsf, mach) : 1;
    return { beta: sol.beta, point: p, sd: sd, v: v, mach: mach, brute: brute, dsf: dsf,
      elevation: brute * dsf + saut, derive: -(Math.atan2(p.z + sd, R) - prep.zeroLateral) * 1000 };
  }

  function avance(prep, R, tof) {
    const c = prep.tir.cible;
    if (!c || !(c.vitesseMS > 0)) return null;
    const lateral = c.vitesseMS * Math.sin(c.angleDeg * Math.PI / 180) * tof;
    return (c.sens === -1 ? -1 : 1) * Math.atan2(lateral, R) * 1000;
  }

  // Dévers : arme tournée de φ autour de la ligne de visée (φ > 0 : sens horaire vu du tireur, haut de l'arme
  // vers la droite). Vu depuis la lunette, l'axe du canon vise à la distance R le point (a, b) :
  //   a = correction de dérive affichée − zéro latéral, b = angle du zéro + élévation affichée − entraxe / R (rad).
  // Tout ce qui est fixé à l'arme tourne avec elle : tourelles, réticule, angle du zéro, canon sous la lunette.
  // La rotation porte ce point en (a cos φ + b sin φ, −a sin φ + b cos φ), alors que la chute, le vent, la dérive
  // gyroscopique et Coriolis restent verticaux ou horizontaux : l'impact se déplace de la différence (vers le côté
  // du dévers et vers le bas), comptée à la verticale et à l'horizontale vraies (impactLateralMrad, impactVerticalMrad).
  // Correction : le réglage, dans le repère de la lunette tournée (ce qu'on affiche aux tourelles ou tient au
  // réticule), qui redonne à l'axe du canon sa visée d'arme d'aplomb, soit la rotation inverse
  // (a cos φ − b sin φ, a sin φ + b cos φ), moins les termes fixés à l'arme (zéro latéral ; angle du zéro − entraxe / R).
  // Une correction comptée à la verticale et à l'horizontale vraies ne s'ajoute pas aux tourelles : à 89°, la tourelle
  // d'élévation agit presque à l'horizontale.
  function effetDevers(prep, R, elevationMrad, deriveMrad, deversDeg) {
    const phi = deversDeg * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi);
    const zl = prep.zeroLateral || 0, fixe = prep.betaZero - prep.profil.hauteurViseurM / R;
    const a = deriveMrad / 1000 - zl, b = fixe + elevationMrad / 1000;
    const dx = a * (c - 1) + b * s, dy = -a * s + b * (c - 1);
    const derive = (a * c - b * s + zl) * 1000, elevation = (a * s + b * c - fixe) * 1000;
    return { deversDeg: deversDeg, impactLateralMrad: dx * 1000, impactVerticalMrad: dy * 1000,
      elevationMrad: elevation, deriveMrad: derive,
      correctionElevationMrad: elevation - elevationMrad, correctionDeriveMrad: derive - deriveMrad };
  }

  function solutionPreparee(prep, distanceM, decomposition) {
    const theta = prep.tir.siteDeg * Math.PI / 180;
    const R = distanceM;
    const s = uneSolution(prep, prep.ctx, R, theta, prep.saut1, theta + prep.betaZero);
    const p = s.point;
    const res = {
      distanceM: R,
      elevationMrad: s.elevation,
      deriveMrad: s.derive,
      tempsVolS: p.t,
      vitesseCibleMS: s.v,
      machCible: s.mach,
      dsf: s.dsf,
      elevationBruteMrad: s.brute,          // sans DSF ni saut aérodynamique
      sautAeroMrad: prep.saut1,
      deriveGyroMrad: -(Math.atan2(s.sd, R) - prep.zeroGyro) * 1000,
      deriveGyroM: s.sd,
      deviationLateraleM: p.z + s.sd,       // déviation de la balle à la cible, + vers la droite (sans zéro latéral)
      coriolisHorizMrad: null,
      coriolisVertMrad: null,
      ventMrad: null,
      avanceMrad: avance(prep, R, p.t),
      vent2: null,
      devers: null
    };
    res.deriveTotaleMrad = res.deriveMrad + (res.avanceMrad || 0);
    const cant = +prep.tir.deversDeg || 0;
    if (cant) res.devers = effetDevers(prep, R, res.elevationMrad, res.deriveMrad, cant);
    if (prep.aVent2) {
      const s2 = uneSolution(prep, prep.ctxVent2, R, theta, prep.saut2, s.beta);
      const av2 = avance(prep, R, s2.point.t);
      res.vent2 = { elevationMrad: s2.elevation, deriveMrad: s2.derive, tempsVolS: s2.point.t,
        sautAeroMrad: prep.saut2, avanceMrad: av2, deriveTotaleMrad: s2.derive + (av2 || 0),
        devers: cant ? effetDevers(prep, R, s2.elevation, s2.derive, cant) : null };
    }
    if (decomposition) {
      if (prep.opt.coriolis) {
        const sc = uneSolution(prep, prep.ctxSansCoriolis, R, theta, prep.saut1, s.beta);
        res.coriolisVertMrad = s.elevation - sc.elevation;
      }
      const zc = prep.avecVent ? uneSolution(prep, prep.ctxSansVent, R, theta, 0, s.beta).point.z : p.z;
      res.coriolisHorizMrad = prep.opt.coriolis ? -(Math.atan2(zc, R) - prep.zeroCor) * 1000 : 0;
      res.ventMrad = prep.avecVent ? -Math.atan2(p.z - zc, R) * 1000 : 0;
    }
    res.zeroOffsetMrad = -prep.zeroDecalage * 1000; // part de la dérive due au Zero Offset
    return res;
  }

  function resoudre(profil, tir, options) {
    const prep = preparer(profil, tir, options);
    const s = solutionPreparee(prep, tir.distanceM, prep.opt.decomposition);
    return Object.assign(s, {
      v0MS: prep.v0.v0,
      v0Extrapolee: prep.v0.extrapolee,
      v0ZeroMS: prep.v0Zero.v0,
      tempPoudreC: prep.tempPoudreC,
      sg: prep.sg,
      sensibiliteSautAero: prep.sensAJ,     // mrad par m/s de vent traversier
      cdf: prep.commun.cdf,
      densiteKgM3: prep.rho,
      vitesseSonMS: prep.son,
      graviteMS2: prep.g,
      angleZeroMrad: prep.betaZero * 1000,
      zeroConditionsTir: !prep.zeroActif,
      zeroLateralMrad: prep.zeroLateral * 1000   // déviation absorbée par le zéro, + = balle à droite
    });
  }

  // Sight Scale Factor (Applied Ballistics, profil.ssfElevation et profil.ssfDerive) : déplacement réel de
  // l'impact ÷ déplacement affiché à la tourelle, mesuré au tall target test (une tourelle qui affiche 10 mrad
  // pour 9 mrad de déplacement réel a un SSF de 0,9 ; un clic de 0,12 mrad au lieu de 0,1 donne 1,2). Le réglage
  // à afficher est la correction vraie divisée par le SSF de son axe. reglageLunette renvoie une copie de la
  // solution (resoudre, table) avec les corrections en réglage : solution, vent 2, dévers (correction et total),
  // cible mobile, parts de la dérive et de l'élévation. Restent en angle vrai : écarts d'impact du dévers, WEZ.
  const SSF_ELEVATION = ['elevationMrad', 'elevationBruteMrad', 'sautAeroMrad', 'coriolisVertMrad', 'correctionElevationMrad'];
  const SSF_DERIVE = ['deriveMrad', 'deriveTotaleMrad', 'avanceMrad', 'deriveGyroMrad', 'coriolisHorizMrad', 'ventMrad',
    'zeroOffsetMrad', 'correctionDeriveMrad'];
  function facteursSSF(profil) {
    const f = v => (v === undefined || v === null || !(+v > 0)) ? 1 : +v;
    return { elevation: f(profil && profil.ssfElevation), derive: f(profil && profil.ssfDerive) };
  }
  function reglageLunette(sol, profil) {
    const f = facteursSSF(profil);
    if (!sol || sol.erreur || (f.elevation === 1 && f.derive === 1)) return sol;
    const r = Object.assign({}, sol);
    for (const k of SSF_ELEVATION) if (typeof r[k] === 'number') r[k] /= f.elevation;
    for (const k of SSF_DERIVE) if (typeof r[k] === 'number') r[k] /= f.derive;
    if (sol.vent2) r.vent2 = reglageLunette(sol.vent2, profil);
    if (sol.devers) r.devers = reglageLunette(sol.devers, profil);
    return r;
  }

  function table(profil, tir, distances, options) {
    const prep = preparer(profil, tir, options);
    return distances.map(d => {
      try { return solutionPreparee(prep, d, false); }
      catch (e) { return { distanceM: d, erreur: e.message }; }
    });
  }

  // ---------------------------------------------------------------------------
  // Calibrations (conditions du tir = conditions du jour de la calibration)
  // ---------------------------------------------------------------------------

  // Méthode de la sécante sur un paramètre p : f(p) renvoie une solution, ecart(s) l'écart à annuler.
  // Renvoie { p, s } ; erreur si p sort de [pMin, pMax].
  function secante(f, ecart, p0, p1, pMin, pMax, tolerance, messageHors) {
    let s0 = f(p0), e0 = ecart(s0), s1 = f(p1), e1 = ecart(s1);
    for (let i = 0; i < 40; i++) {
      if (Math.abs(e1) < tolerance) return { p: p1, s: s1 };
      const p2 = p1 - e1 * (p1 - p0) / (e1 - e0);
      if (!isFinite(p2) || p2 < pMin || p2 > pMax) throw new Error(messageHors);
      p0 = p1; e0 = e1; p1 = p2; s1 = f(p1); e1 = ecart(s1);
    }
    throw new Error('Le calcul de calibration ne converge pas.');
  }

  // CDF : facteur unique appliqué à la traînée, de la bouche à la cible (zéro compris), tel que
  // l'élévation calculée (sans DSF) égale l'élévation observée (mode « chute »), ou que la vitesse
  // calculée à la cible égale la vitesse mesurée (mode « vitesse », radar Doppler par exemple).
  // Litz recommande un premier point transsonique (Mach ≈ 1,2). Retour : CDF, Mach à la distance.
  function calibrerCDFSelon(profil, tir, distanceM, observe, options, mode) {
    verifier(distanceM > profil.distanceZeroM, 'CDF : la distance doit dépasser la distance de zéro.');
    verifier(isFinite(observe), mode === 'vitesse' ? 'CDF : vitesse mesurée requise.' : 'CDF : élévation observée requise.');
    const opts = Object.assign({}, options, { dsfActif: false, decomposition: false });
    const t = Object.assign({}, tir, { distanceM: distanceM });
    const f = c => resoudre(Object.assign({}, profil, { cdf: c }), t, opts);
    const grandeur = s => mode === 'vitesse' ? s.vitesseCibleMS : s.elevationMrad;
    const c0 = profil.cdf || 1;
    const r = secante(f, s => grandeur(s) - observe, c0, c0 * 1.02, 0.3, 3, mode === 'vitesse' ? 1e-5 : 1e-6,
      mode === 'vitesse' ? 'CDF : aucune valeur entre 0,3 et 3 ne donne cette vitesse à cette distance.'
        : 'CDF : aucune valeur entre 0,3 et 3 ne reproduit cette élévation.');
    return { cdf: r.p, cdfActuel: c0, mach: r.s.machCible, elevationMrad: r.s.elevationMrad, vitesseMS: r.s.vitesseCibleMS };
  }
  function calibrerCDF(profil, tir, distanceM, elevationObserveeMrad, options) {
    return calibrerCDFSelon(profil, tir, distanceM, elevationObserveeMrad, options, 'chute');
  }
  function calibrerCDFVitesse(profil, tir, distanceM, vitesseMesureeMS, options) {
    verifier(vitesseMesureeMS > 0, 'CDF : vitesse mesurée positive requise.');
    return calibrerCDFSelon(profil, tir, distanceM, vitesseMesureeMS, options, 'vitesse');
  }

  // V0 : loi V0 décalée d'une même valeur à toutes les températures (table ou pente), de sorte que
  // l'élévation calculée (sans DSF) égale l'élévation observée ; le zéro est recalculé avec la nouvelle
  // V0 (même résultat qu'AB Quantum : 838,4 m/s pour 10,00 mrad à 1 000 m, carte du 2026-09-23).
  // Distance conseillée : balle entre Mach 1,3 et 1,2 à la cible (AB Quantum) ; le manuel RAPTAR-S
  // (§ 3.8.4) donne Mach 1,4 à 1,2.
  function decalerV0(profil, delta) {
    const p = Object.assign({}, profil);
    if (profil.penteV0) p.penteV0 = Object.assign({}, profil.penteV0, { v0: profil.penteV0.v0 + delta });
    else p.tableV0 = (profil.tableV0 || []).map(q => ({ tempC: q.tempC, v0: q.v0 + delta }));
    return p;
  }
  function calibrerV0(profil, tir, distanceM, elevationObserveeMrad, options) {
    verifier(distanceM > profil.distanceZeroM, 'V0 : la distance doit dépasser la distance de zéro.');
    verifier(isFinite(elevationObserveeMrad), 'V0 : élévation observée requise.');
    const opts = Object.assign({}, options, { dsfActif: false, decomposition: false });
    const t = Object.assign({}, tir, { distanceM: distanceM });
    const f = d => resoudre(decalerV0(profil, d), t, opts);
    const actuelle = f(0);
    const r = secante(f, s => s.elevationMrad - elevationObserveeMrad, 0, 5, -300, 300, 1e-6,
      'V0 : aucune vitesse initiale plausible ne reproduit cette élévation.');
    verifier(r.s.v0MS > 100, 'V0 : aucune vitesse initiale plausible ne reproduit cette élévation.');
    return { v0MS: r.s.v0MS, v0ActuelleMS: actuelle.v0MS, deltaMS: r.p, tempPoudreC: r.s.tempPoudreC,
      mach: r.s.machCible, elevationMrad: r.s.elevationMrad };
  }

  // Distances (tir à plat, conditions du tir, calibrations comprises) où la balle arrive à la cible aux
  // Mach demandés. Sert aux distances conseillées : V0 entre Mach 1,3 et 1,2, DSF sous Mach 0,9
  // (AB Quantum). Renvoie une distance (m) par Mach, ou null au-delà de distanceMaxM.
  function distancesMach(profil, tir, machs, options) {
    const opts = Object.assign({ dt: 0.002 }, options, { coriolis: false, decomposition: false });
    const dMax = opts.distanceMaxM || 3000;
    const prep = preparer(profil, Object.assign({}, tir, { siteDeg: 0, vent: null, ventZone: null, cible: null,
      deversDeg: null, distanceM: 100 }), opts);
    let beta = prep.betaZero;
    const machA = R => {
      const sol = resoudreAngle(prep.ctx, R, 0, beta);
      beta = sol.beta;
      const p = sol.point, v = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
      return v / (prep.ctx.a0Son * Math.sqrt((prep.ctx.TK0 - GRADIENT_T * p.y) / 273.15));
    };
    const cibles = machs.map((m, i) => ({ m: m, i: i })).sort((a, b) => b.m - a.m);
    const res = machs.map(() => null);
    let Ra = 50, ma = machA(Ra);
    for (const c of cibles) {
      if (ma < c.m) continue; // déjà plus lent à 50 m
      let Rb = Ra, mb = ma;
      while (mb >= c.m && Rb < dMax) { Ra = Rb; ma = mb; Rb = Math.min(Rb + 50, dMax); try { mb = machA(Rb); } catch (e) { mb = -1; break; } }
      if (mb >= c.m || mb < 0) break;
      let lo = Ra, mlo = ma, hi = Rb, mhi = mb; // interpolation linéaire en Mach, deux fois affinée
      for (let k = 0; k < 3; k++) {
        const Rm = lo + (c.m - mlo) * (hi - lo) / (mhi - mlo), mm = machA(Rm);
        if (mm >= c.m) { lo = Rm; mlo = mm; } else { hi = Rm; mhi = mm; }
      }
      res[c.i] = lo + (c.m - mlo) * (hi - lo) / (mhi - mlo);
    }
    return res;
  }

  // DSF : rapport entre l'élévation observée et l'élévation calculée sans DSF (saut aérodynamique
  // retiré des deux), stocké avec le Mach de la balle à cette distance.
  function calibrerDSF(profil, tir, distanceM, elevationObserveeMrad, options) {
    verifier(isFinite(elevationObserveeMrad), 'DSF : élévation observée requise.');
    const opts = Object.assign({}, options, { dsfActif: false, decomposition: false });
    const s = resoudre(profil, Object.assign({}, tir, { distanceM: distanceM }), opts);
    verifier(s.elevationBruteMrad > 0.5, 'DSF : distance trop courte (élévation calculée inférieure à 0,5 mrad).');
    return { mach: s.machCible, dsf: (elevationObserveeMrad - s.sautAeroMrad) / s.elevationBruteMrad,
      elevationCalculeeMrad: s.elevationMrad };
  }

  // ---------------------------------------------------------------------------
  // Aides de tir : speed drop, quick wind, wind dot (tir à plat, sans vent ni Coriolis,
  // atmosphère du tir, DSF appliqué). Courbe calculée tous les 10 m.
  // ---------------------------------------------------------------------------

  function aidesTir(profil, tir, options) {
    const opts = Object.assign({ dt: 0.002 }, options, { coriolis: false, decomposition: false });
    const toleranceSD = opts.toleranceSpeedDropMrad || 0.1;
    const dMax = opts.distanceMaxAidesM || 1500;
    const tirPlat = Object.assign({}, tir, { siteDeg: 0, vent: null, ventZone: null, cible: null, deversDeg: null, distanceM: 100 });
    const prep = preparer(profil, tirPlat, opts);
    const ctxVent1 = contexte(prep.v0.v0, prep.atmo, prep.commun, null, vecteurVent(1, 9));
    const pts = [];
    let beta = prep.betaZero;
    for (let R = 50; R <= dMax + 1e-9; R += 10) {
      let sol;
      try { sol = resoudreAngle(prep.ctx, R, 0, beta); } catch (e) { break; }
      beta = sol.beta;
      const p = sol.point;
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
      const mach = v / (prep.ctx.a0Son * Math.sqrt((prep.ctx.TK0 - GRADIENT_T * p.y) / 273.15));
      const E = (sol.beta - prep.betaZero) * 1000 * facteurDSF(profil.dsf, mach);
      const pv = tracer(ctxVent1, sol.beta, R);
      pts.push({ R: R, E: E, mach: mach, beta: sol.beta, d1: pv ? Math.atan2(pv.z, R) * 1000 : NaN });
      if (mach < 1.1 && E > 4) break; // au-delà, aucune des trois aides n'est utilisée
    }
    const res = { speedDrop: null, quickWind: null, windDot: null };
    if (pts.length < 3) return res;

    // Speed drop : correction ≈ distance/100 − SD (mrad, distance en m). SD = maximum de
    // (distance/100 − élévation) moins la tolérance, arrondi au 0,1 mrad le plus proche (x,x5 vers le bas) ;
    // plage contiguë où l'écart, arrondi au 0,1 mrad, reste dans la tolérance (|écart| ≤ tolérance + 0,05).
    // Règle qui reproduit les valeurs du Kestrel de l'auteur (2026-09-23) aux écarts de modèle près.
    // Élévation en réglage de tourelle (÷ SSF Elevation), comme la solution ; quick wind et wind dot restent en
    // angle vrai (réticule).
    const fSSF = facteursSSF(profil).elevation;
    const sdv = pts.map(q => q.R / 100 - q.E / fSSF);
    let iMax = 0;
    sdv.forEach((x, i) => { if (x > sdv[iMax]) iMax = i; });
    let prime = sdv[iMax];
    if (iMax > 0 && iMax < pts.length - 1) { // sommet de la parabole par les trois points voisins
      const a = sdv[iMax - 1], b = sdv[iMax], c = sdv[iMax + 1], den = a - 2 * b + c;
      if (den < 0) prime = b - (a - c) * (a - c) / (8 * den);
    }
    const sdBrut = prime - toleranceSD;
    const sd = Math.ceil(sdBrut * 10 - 0.5 - 1e-9) / 10;
    const seuil = sd - toleranceSD - 0.05;
    let i0 = iMax, i1 = iMax;
    while (i0 > 0 && sdv[i0 - 1] >= seuil) i0--;
    while (i1 < pts.length - 1 && sdv[i1 + 1] >= seuil) i1++;
    const croise = (a, b) => pts[a].R + (seuil - sdv[a]) * (pts[b].R - pts[a].R) / (sdv[b] - sdv[a]);
    res.speedDrop = {
      valeurMrad: sd,
      valeurBruteMrad: sdBrut,
      toleranceMrad: toleranceSD,
      distanceMinM: i0 > 0 ? croise(i0 - 1, i0) : pts[0].R,
      distanceMaxM: i1 < pts.length - 1 ? croise(i1, i1 + 1) : pts[pts.length - 1].R,
      borneAtteinte: i0 === 0 || i1 === pts.length - 1
    };

    // Quick wind (Accuracy 1st, « Short Wind Formula ») : vent traversier plein W qui donne 0,5 mrad de
    // dérive due au vent à 500 m, dérive gyroscopique et Coriolis exclus. Pour un vent égal à n × W, la
    // correction vaut n × distance/1000 ; « valeurs de distance » : correction exacte pour W tous les 100 m.
    const R500 = 500;
    const k500 = pts.findIndex(q => Math.abs(q.R - R500) < 1e-6);
    if (k500 >= 0 && pts[k500].d1 > 0) {
      const b500 = pts[k500].beta;
      const derive = (W, R, beta) => {
        const pv = tracer(contexte(prep.v0.v0, prep.atmo, prep.commun, null, vecteurVent(W, 9)), beta, R);
        return pv ? Math.atan2(pv.z, R) * 1000 : NaN;
      };
      let W = 0.5 / pts[k500].d1;
      for (let k = 0; k < 4; k++) W *= 0.5 / derive(W, R500, b500);
      const valeurs = [];
      for (const q of pts) {
        if (q.R % 100 === 0 && q.R <= 1000) valeurs.push({ distanceM: q.R, mrad: derive(W, q.R, q.beta), mach: q.mach });
      }
      res.quickWind = { vitesseMS: W, mph: W / MPH_EN_MS, mphEntier: Math.round(W / MPH_EN_MS), distanceRefM: R500,
        valeursDistance: valeurs };
    }

    // Wind dot (réticules Tremor, méthode Horus) : à la distance où l'élévation vaut 4 mrad, vent
    // traversier plein donnant 0,95 mrad de dérive due au vent (2e point de la ligne 4 mrad) ; la
    // valeur d'un point est la moitié de ce vent.
    const j = pts.findIndex((q, k) => k > 0 && pts[k - 1].E < 4 && q.E >= 4);
    if (j > 0) {
      const a = pts[j - 1], b = pts[j];
      const R4 = a.R + (4 - a.E) * (b.R - a.R) / (b.E - a.E);
      const sol4 = resoudreAngle(prep.ctx, R4, 0, a.beta);
      let W = 0.95 / (a.d1 + (R4 - a.R) * (b.d1 - a.d1) / (b.R - a.R));
      for (let k = 0; k < 3; k++) {
        const pv = tracer(contexte(prep.v0.v0, prep.atmo, prep.commun, null, vecteurVent(W, 9)), sol4.beta, R4);
        W *= 0.95 / (Math.atan2(pv.z, R4) * 1000);
      }
      res.windDot = { vitesseMS: W / 2, vent2ePointMS: W, distanceM: R4 };
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // WEZ (Weapon Employment Zone) : probabilité de toucher au premier coup
  // ---------------------------------------------------------------------------
  // Méthode : pour chaque source d'incertitude, le solveur calcule l'écart de correction (élévation, dérive)
  // produit par un écart d'une unité, à toutes les distances (différences finies). L'impact suit alors une loi
  // normale à deux dimensions, somme des contributions indépendantes et de la dispersion du fusil ; la
  // probabilité de toucher est estimée par nTirs tirs simulés (Monte Carlo, graine fixe) sur la cible, centrée
  // sur le point visé. Valable tant que les incertitudes restent petites devant les grandeurs (modèle linéaire).
  // incertitudes : écarts-types (1σ) : fusilMrad (dispersion par axe), v0MS, traineePct, distanceM (nombre, ou
  //   tranches de distance : voir sigmaSelonDistance), tempC (température de l'air seule, V0 inchangée),
  //   pressionHPa, humiditePct, siteDeg, latitudeDeg, azimutDeg, ventMS (vitesse du vent, dans la direction
  //   saisie : voir ajouterVentDirection).
  // Le zéro de l'arme reste celui du tir nominal pour toutes les variations (option zeroFixe de preparer).
  // Conventions vérifiées sur l'écran WEZ d'AB Quantum de l'auteur (2026-09-23, 1 000 m, vent 3 m/s de 3 h : 17 %) :
  // entrées en écart-type ; contributions par source retrouvées (vent, pression, humidité, V0, traînée, température).
  // cible : { forme: 'rectangle' | 'cercle', largeurM, hauteurM, diametreM }.
  // Retour : une entrée par distance { distanceM, pTouche, sigmaVMrad, sigmaHMrad, correlation,
  //   contributions: [{ source, vMrad, hMrad }] } ; option impactsDistanceM : renvoie aussi, pour cette
  //   distance, les impacts simulés (m, x vers la droite, y vers le haut ; les nImpacts premiers).
  const SOURCES_WEZ = ['v0', 'trainee', 'distance', 'temp', 'pression', 'humidite', 'site', 'latitude', 'azimut', 'vent'];
  function aleaNormal(graine) { // générateur déterministe (mulberry32) et Box-Muller
    let a = graine >>> 0;
    const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296; };
    return () => { const r = Math.sqrt(-2 * Math.log(u())), th = 2 * Math.PI * u(); return [r * Math.cos(th), r * Math.sin(th)]; };
  }
  // Incertitude de vent : elle porte sur la vitesse du vent, dans la direction saisie
  // (vent 1 et vent à distance, chacun dans sa direction). Sans vent saisi, vent traversier venant de 9 h.
  // Vérifié sur la colonne P(hit) des range cards d'AB Quantum de l'auteur (vent 0 m/s de 12 h : l'incertitude
  // de 2 m/s y agit comme un vent de face ou arrière et ne disperse presque pas latéralement).
  function ajouterVentDirection(tir, dW) {
    const t = Object.assign({}, tir);
    const v = tir.vent || { vitesse1MS: 0, vitesse2MS: null, directionHeures: 9 };
    t.vent = { vitesse1MS: (+v.vitesse1MS || 0) + dW, vitesse2MS: null, directionHeures: v.directionHeures };
    if (tir.ventZone) t.ventZone = Object.assign({}, tir.ventZone, { vitesseMS: (+tir.ventZone.vitesseMS || 0) + dW });
    return t;
  }
  // Écart-type d'une source à la distance R : nombre (même valeur à toutes les distances), ou tranches
  // [{ jusquaM, sigmaM }], comme la précision d'un télémètre donnée par plage de distance (± 2 m jusqu'à 1 000 m,
  // ± 3 m jusqu'à 2 000 m, ± 5 m au-delà par exemple). jusquaM : fin de la tranche, comprise dans la tranche ;
  // absente, nulle ou Infinity : pas de fin. Tranches rangées ici par fin croissante ; au-delà de la dernière
  // fin, la dernière tranche s'applique. sigmaM vide ou nul : source ignorée dans la tranche.
  function sigmaSelonDistance(sigma, R) {
    if (!Array.isArray(sigma)) return sigma > 0 ? sigma : 0;
    const t = sigma.filter(Boolean).map(x => ({ fin: x.jusquaM > 0 ? x.jusquaM : Infinity, s: x.sigmaM > 0 ? x.sigmaM : 0 }))
      .sort((a, b) => a.fin - b.fin);
    if (!t.length) return 0;
    for (const x of t) if (R <= x.fin + 1e-9) return x.s;
    return t[t.length - 1].s;
  }
  function wez(profil, tir, distances, incertitudes, cible, options) {
    // Pas de 4 ms : les sensibilités sont des différences, identiques à 0,001 près à celles du pas de 2 ms.
    const opts0 = Object.assign({ dt: 0.004 }, options, { decomposition: false });
    const nTirs = opts0.nTirs || 20000;
    const u = incertitudes || {};
    // Zéro de l'arme : celui du tir nominal, commun à toutes les variations.
    const p0 = preparer(profil, Object.assign({}, tir, { deversDeg: null, cible: null }), opts0);
    const opts = Object.assign({}, opts0, { zeroFixe: { betaZero: p0.betaZero, zeroGyro: p0.zeroGyro, zeroCor: p0.zeroCor } });
    // Dévers et cible mobile hors WEZ : seules comptent les corrections affichées.
    const tab = (p, t, d) => table(p, Object.assign({}, t || tir, { deversDeg: null, cible: null }), d || distances, opts);
    const base = tab(profil, tir);
    const plus = (champ, pas) => Object.assign({}, tir, { [champ]: tir[champ] + pas });
    const variantes = {
      v0: [u.v0MS, () => tab(decalerV0(profil, 1))],
      trainee: [u.traineePct, () => tab(Object.assign({}, profil, { cdf: (profil.cdf || 1) * 1.01 }))],
      distance: [u.distanceM, () => tab(profil, tir, distances.map(d => d + 1))],
      temp: [u.tempC, () => tab(profil, Object.assign(plus('tempC', 1), { tempPoudreC: p0.tempPoudreC }))],
      pression: [u.pressionHPa, () => tab(profil, plus('pressionHPa', 1))],
      humidite: [u.humiditePct, () => tab(profil, plus('humiditePct', tir.humiditePct >= 99 ? -1 : 1))],
      site: [u.siteDeg, () => { const a = tab(profil, plus('siteDeg', 0.5)), b = tab(profil, plus('siteDeg', -0.5));
        return a.map((s, i) => ({ elevationMrad: base[i].elevationMrad + (s.elevationMrad - b[i].elevationMrad),
          deriveMrad: base[i].deriveMrad + (s.deriveMrad - b[i].deriveMrad) })); }],
      latitude: [u.latitudeDeg, () => tab(profil, Object.assign({}, tir, { latitudeDeg: tir.latitudeDeg + (tir.latitudeDeg > 89 ? -1 : 1) }))],
      azimut: [u.azimutDeg, () => tab(profil, plus('azimutDeg', 1))],
      vent: [u.ventMS, () => tab(profil, ajouterVentDirection(tir, 1))]
    };
    const sens = {};
    for (const s of SOURCES_WEZ) {
      const [sigma, calc] = variantes[s];
      if (!distances.some(R => sigmaSelonDistance(sigma, R) > 0)) continue;
      const t = calc();
      sens[s] = { sigma: sigma, d: t.map((x, i) => (x.erreur || base[i].erreur) ? null
        : [x.elevationMrad - base[i].elevationMrad, x.deriveMrad - base[i].deriveMrad]) };
    }
    const alea = aleaNormal(opts.graine || 20260923);
    const normales = [];
    for (let k = 0; k < nTirs; k++) normales.push(alea());
    const sf = u.fusilMrad > 0 ? u.fusilMrad : 0;
    return distances.map((R, i) => {
      if (base[i].erreur) return { distanceM: R, erreur: base[i].erreur };
      let vv = sf * sf, hh = sf * sf, vh = 0;
      const contributions = [];
      for (const s of Object.keys(sens)) {
        const d = sens[s].d[i], sg = sigmaSelonDistance(sens[s].sigma, R);
        if (!d || !(sg > 0)) continue;
        const a = d[0] * sg, b = d[1] * sg;
        vv += a * a; hh += b * b; vh += a * b;
        contributions.push({ source: s, vMrad: Math.abs(a), hMrad: Math.abs(b) });
      }
      if (sf > 0) contributions.push({ source: 'fusil', vMrad: sf, hMrad: sf });
      // Cholesky de [[hh, vh], [vh, vv]] (x latéral, y vertical), impacts en mètres à la distance R.
      const l11 = Math.sqrt(hh), l21 = l11 > 0 ? vh / l11 : 0, l22 = Math.sqrt(Math.max(vv - l21 * l21, 0));
      const k = R / 1000;
      const dedans = cible && cible.forme === 'cercle'
        ? (x, y) => x * x + y * y <= Math.pow(cible.diametreM / 2, 2)
        : (x, y) => Math.abs(x) <= cible.largeurM / 2 && Math.abs(y) <= cible.hauteurM / 2;
      let touches = 0;
      const garder = opts.impactsDistanceM !== undefined && Math.abs(R - opts.impactsDistanceM) < 1e-6;
      const impacts = garder ? [] : null;
      for (let n = 0; n < nTirs; n++) {
        const z = normales[n], x = l11 * z[0] * k, y = (l21 * z[0] + l22 * z[1]) * k;
        if (dedans(x, y)) touches++;
        if (garder && n < (opts.nImpacts || 400)) impacts.push([x, y]);
      }
      const r = { distanceM: R, pTouche: touches / nTirs, sigmaVMrad: Math.sqrt(vv), sigmaHMrad: Math.sqrt(hh),
        correlation: (vv > 0 && hh > 0) ? vh / Math.sqrt(vv * hh) : 0, contributions: contributions };
      if (impacts) r.impacts = impacts;
      return r;
    });
  }

  // ---------------------------------------------------------------------------
  // Reconstruction d'une table de traînée à partir d'une range card
  // ---------------------------------------------------------------------------
  // La range card d'un autre logiciel calculée avec un modèle de traînée personnalisé (CDM d'Applied
  // Ballistics par exemple) contient, distance par distance, la vitesse et l'élévation que donne ce modèle.
  // On cherche Cd(M) = i·Cd_G7(M)·f(M), f linéaire par morceaux entre des nœuds en Mach, telle que le solveur
  // retrouve ces vitesses (poids 1/0,05 m/s) et ces élévations (poids 1/0,005 mrad) ; faible pénalité (lissage) sur la
  // courbure de f ; Gauss-Newton amorti (Levenberg-Marquardt), jacobien par différences finies.
  // profil : profil de l'arme qui a servi à la carte (V0, zéro, entraxe…) ; son BC G7 fixe i (densité de section
  // / BC), point de départ de f = 1. tir : conditions de la carte. carte : [{ distanceM, elevationMrad, vitesseMS }]
  // (au plus 40 points utilisés, répartis sur la carte). Retour : table [{ mach, cd }] (grille G7), nœuds,
  // facteurs, écarts maximaux à la carte (élévation, vitesse).
  const NOEUDS_TRAINEE = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3, 1.45, 1.6, 1.8, 2.0, 2.2, 2.5];
  function reconstruireTrainee(profil, tir, carte, options) {
    const opts = Object.assign({ dt: 0.001, iterations: 25, lissage: 100 }, options);
    const pts0 = (carte || []).filter(q => q.distanceM > 0 && q.vitesseMS > 0 && isFinite(q.elevationMrad));
    verifier(pts0.length >= 5, 'Range card : au moins cinq distances avec vitesse et élévation.');
    const pas = Math.max(1, Math.ceil(pts0.length / 40));
    const pts = pts0.filter((q, k) => k % pas === 0 || k === pts0.length - 1);
    const dist = pts.map(q => q.distanceM);
    const SD = (profil.masseGrains / 7000) / Math.pow(profil.diametreM / POUCE, 2);
    const i = SD / (profil.bcG7 > 0 ? profil.bcG7 : 0.3);
    const N = NOEUDS_TRAINEE;
    const f = (M, p) => {
      if (M <= N[0]) return p[0];
      for (let k = 1; k < N.length; k++) if (M <= N[k]) return p[k - 1] + (M - N[k - 1]) * (p[k] - p[k - 1]) / (N[k] - N[k - 1]);
      return p[p.length - 1];
    };
    const tableDe = p => G7_MACH.map((M, k) => ({ mach: M, cd: i * G7_CD[k] * f(M, p) }));
    const base = Object.assign({}, profil, { cdf: 1, dsf: [], bcG7: null });
    const profilDe = p => Object.assign({}, base, { traineePerso: tableDe(p) });
    const optT = { decomposition: false, deriveGyro: false, dsfActif: false, dt: opts.dt };
    const zeroEnDistance = pts[0].distanceM <= profil.distanceZeroM + 1e-9;
    const residus = p => {
      const t = table(profilDe(p), tir, dist, optT), r = [];
      for (let k = 0; k < t.length; k++) {
        if (t[k].erreur) { r.push(1e4); r.push(1e4); continue; }
        r.push((t[k].vitesseCibleMS - pts[k].vitesseMS) * 20);
        if (!(zeroEnDistance && k === 0)) r.push((t[k].elevationMrad - pts[k].elevationMrad) * 200);
      }
      for (let k = 1; k < p.length - 1; k++) r.push(opts.lissage * (p[k - 1] - 2 * p[k] + p[k + 1]));
      return r;
    };
    const somme = r => r.reduce((a, x) => a + x * x, 0);
    const lineaire = (A, b) => {
      const n = b.length, M = A.map((l, a) => l.concat([b[a]]));
      for (let c = 0; c < n; c++) {
        let pm = c; for (let l = c + 1; l < n; l++) if (Math.abs(M[l][c]) > Math.abs(M[pm][c])) pm = l;
        const tmp = M[c]; M[c] = M[pm]; M[pm] = tmp;
        for (let l = c + 1; l < n; l++) { const q = M[l][c] / M[c][c]; for (let k = c; k <= n; k++) M[l][k] -= q * M[c][k]; }
      }
      const x = new Array(n).fill(0);
      for (let l = n - 1; l >= 0; l--) { let s = M[l][n]; for (let k = l + 1; k < n; k++) s -= M[l][k] * x[k]; x[l] = s / M[l][l]; }
      return x;
    };
    let p = N.map(() => 1), r = residus(p), cout = somme(r), mu = 1e-2;
    for (let it = 0; it < opts.iterations; it++) {
      const J = p.map((_, j) => { const q = p.slice(); q[j] += 0.002; return residus(q).map((x, k) => (x - r[k]) / 0.002); });
      const n = p.length, A = [], g = [];
      for (let a = 0; a < n; a++) {
        A.push([]); g.push(-J[a].reduce((s, x, k) => s + x * r[k], 0));
        for (let b = 0; b < n; b++) A[a].push(J[a].reduce((s, x, k) => s + x * J[b][k], 0));
      }
      let progres = false, fin = false;
      for (let essai = 0; essai < 8 && !progres; essai++) {
        const dp = lineaire(A.map((l, a) => l.map((x, b) => a === b ? x * (1 + mu) : x)), g);
        const q = p.map((x, k) => Math.min(Math.max(x + dp[k], 0.3), 3));
        const rq = residus(q), cq = somme(rq);
        if (cq < cout) { fin = (cout - cq) < 1e-4 * cout; p = q; r = rq; cout = cq; mu = Math.max(mu / 3, 1e-6); progres = true; }
        else mu *= 5;
      }
      if (!progres || fin) break;
    }
    const verif = table(profilDe(p), tir, pts0.map(q => q.distanceM), optT);
    let eE = 0, eV = 0;
    verif.forEach((s, k) => { if (s.erreur) return; eE = Math.max(eE, Math.abs(s.elevationMrad - pts0[k].elevationMrad));
      eV = Math.max(eV, Math.abs(s.vitesseCibleMS - pts0[k].vitesseMS)); });
    return { table: tableDe(p), noeuds: N.slice(), facteurs: p, ecartElevationMaxMrad: eE, ecartVitesseMaxMS: eV,
      distanceMaxM: pts0[pts0.length - 1].distanceM, points: pts.length };
  }

  return {
    VERSION: VERSION,
    resoudre: resoudre,
    table: table,
    preparer: preparer,
    solutionPreparee: solutionPreparee,
    calibrerCDF: calibrerCDF,
    calibrerCDFVitesse: calibrerCDFVitesse,
    calibrerV0: calibrerV0,
    calibrerDSF: calibrerDSF,
    decalerV0: decalerV0,
    distancesMach: distancesMach,
    effetDevers: effetDevers,
    aidesTir: aidesTir,
    wez: wez,
    reglageLunette: reglageLunette,
    facteursSSF: facteursSSF,
    sigmaSelonDistance: sigmaSelonDistance,
    reconstruireTrainee: reconstruireTrainee,
    ajouterVentDirection: ajouterVentDirection,
    vitesseInitiale: vitesseInitiale,
    loiV0: loiV0,
    stabiliteMiller: stabiliteMiller,
    deriveGyroscopique: deriveGyroscopique,
    sensibiliteSautAero: sensibiliteSautAero,
    vecteurVent: vecteurVent,
    facteurDSF: facteurDSF,
    densiteAir: densiteAir,
    vitesseSon: vitesseSon,
    graviteNormale: graviteNormale,
    cdG7: cdG7,
    pchipPreparer: pchipPreparer,
    tracer: tracer,
    acceleration: acceleration,
    contexte: contexte,
    resoudreAngle: resoudreAngle,
    constantes: { OMEGA_TERRE: OMEGA_TERRE, EXPOSANT_P: EXPOSANT_P, GRADIENT_T: GRADIENT_T,
      LB_PAR_IN2: LB_PAR_IN2, G7_MACH: G7_MACH, G7_CD: G7_CD }
  };
});
