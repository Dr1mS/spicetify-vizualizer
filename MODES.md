# MODES

Banc d'essai de modes de simulation audio-réactifs. Tous les modes sont pilotés
par le **même bus de features** via la **modulation matrix** (le point d'injection).

## Le point d'injection : la modulation matrix

`src/modmatrix/` — une liste de **routes** data-driven pousse une *feature* audio
vers un *paramètre* (uniform de mode ou param global). Éditable à chaud (touche **M**),
persistée (localStorage), défauts dans `routes.default.json`.

```json
{ "source": "onset", "dest": "fhn.params.injAmp", "amount": 1.4, "curve": "pow", "k": 1.5, "smoothing": 0 }
```

- **source** — nom de feature (voir liste ci-dessous).
- **dest** — `paramPath` : `<mode>.params.<x>` ou `global.<x>`.
- **amount** — gain (peut être négatif). La feature (0..1) × amount est **ajoutée** à la base du paramètre.
- **curve** — `lin` | `exp` (accentue le haut) | `log` (accentue le bas) | `pow` (× `k`).
- **smoothing** — 0 = instantané, 1 = très lissé (constante de temps, **dt-compensée** → identique à 30/60/144 fps).

Ordre par route : `curve → amount → smoothing`. Plusieurs routes vers la même cible
s'**accumulent**. La valeur finale = `base + Σ contributions`, clampée (ou wrap pour les teintes).
Une route vers une cible inexistante est **ignorée** (pas de crash) — mais `test/routes.test.mjs`
échoue si une route par défaut est pendante.

### Features disponibles (sources)

`rms`, `peak`, `flux`, `centroid`, `flatness`, `energy`, `keyHue`, `onset`,
`kick`, `snare`, `hats`, `beatPhase`, `beatPulse` (pic sur le beat, prédictif),
`lockConf`, `bass` `lowmid` `mid` `highmid` `treble` (bandes larges), `mel0`…`mel31`.
Impulsions 1-frame : `onsetFired`, `kickFired`, `snareFired`, `hatsFired`.

### Cibles globales

`global.brightness`, `global.exposure`, `global.baseHue` (teinte, wrap),
`global.hueShift`, `global.beatFlash` (gain de sortie pulsé sur le beat).

---

## Modes de référence

### FitzHugh-Nagumo — famille `continuous` (touche 1)
Média excitable (ping-pong `u,v`). Un onset injecte une stimulation locale → onde
propagée + queue réfractaire → spirales/ondes cibles. Laplacien 9-points, wrap toroïdal,
`Du·dt` clampé (CFL) après modulation.
| dest | source (route défaut) |
|---|---|
| `fhn.params.injAmp` | `onset` (déclenché par `onsetFired`) |
| `fhn.params.epsilon` | `flux` |
| `fhn.params.Du` | `bass` (clampé CFL) |
| `fhn.params.b` | `centroid` |
| `global.baseHue` | `keyHue` |
| `global.brightness` | `rms` |

### De Jong — famille `density` (touche 2)
Attracteur étrange. `a,b,c,d` morphés par le spectre. 65 536 orbites avancées 1 pas/frame
(ping-pong), accumulation additive des points sur un FBO float → tonemap log.
| dest | source |
|---|---|
| `dejong.params.a` | `bass` |
| `dejong.params.b` | `lowmid` |
| `dejong.params.c` | `mid` |
| `dejong.params.d` | `treble` |
| `dejong.params.warp` | `onset` |
| `global.exposure` | `rms` |
| `global.baseHue` | `centroid` |

### Space Colonization — famille `growth` (touche 3)
Dendrites (Runions) qui poussent vers des attracteurs **spawnés sur les onsets**.
Croissance CPU (plus-proche-voisin, kill radius) ; GPU = accumulation **avec décroissance**
(sinon saturation blanche en réactif continu).
| dest | source |
|---|---|
| (spawn) | `onsetFired` (direct) |
| `spacecol.params.spawnCount` | `energy` |
| `spacecol.params.stepLen` | `bass` |
| `spacecol.params.decay` | `rms` |
| `spacecol.params.bright` | `peak` |

---

## Catalogue (Phase 2) — 10 modes exotiques

Implémentés en parallèle (un shader/mode chacun, réutilisant les 3 scaffolds).
Touches **1-0** (modes 1-10) + **← →** pour cycler les 13.

### continuous (ping-pong)
- **kuramoto** — grille d'oscillateurs couplés ; `energy`/`bass`→couplage K, `onset`→perturbation. Vagues de synchro.
- **greenberg** — automate cyclique excitable (N états) ; `onset`→ensemencement, `flux`→N. Spirales discrètes.
- **smoothlife** — Life continu (disque/anneau) ; `onset`→taches, `bass`→influence spectrale. Blobs/gliders.
- **lenia** — CA à noyau annulaire ; `bass`→μ, `treble`→σ, `onset`→germes. Créatures émergentes.

### density (accumulation + tonemap log)
- **clifford** — attracteur `sin/cos` ; `bass/treble/lowmid/mid`→a,b,c,d, `onsetFired`→warp.
- **thomas** — attracteur 3D cyclique projeté ; `mid`→b, `beatPhase`→rotation.
- **aizawa** — attracteur 3D (spirale toroïdale) projeté ; `bass`→a, rotation temporelle.
- **chladni** — figures cymatiques (lignes nodales) pilotées **littéralement** par `mel[k]`. Rendu direct.
- **kifs** — raymarching fractal (KIFS "cathédrale") ; folds morphés par `bass`/`centroid`. Rendu direct.

### growth (accumulation + décroissance)
- **diffgrowth** — courbe qui s'auto-subdivise sous répulsion/attraction ; `onset`→croissance. Formes organiques.

## Ajouter un mode
Un mode implémente `src/modes/Mode.ts` : `init/resize/update/render/reset/dispose`.
`render(target)` écrit une **densité colorée** dans le buffer `scene` ; `main.ts` la tonemappe.
Enregistrer ses params via `registerParams`, l'ajouter à `registry.ts`, et ses routes par défaut
dans `routes.default.json`. Familles réutilisables : `continuous` (ping-pong),
`density` (accum+tonemap log), `growth` (accum+décroissance).

## Contraintes assumées
- **Réactif pur, pas de look-ahead offline.** Seule exception : l'extrapolation de phase du
  beat tracker (PLL) — on prédit le prochain beat, on ne lit pas le futur du signal.
- `beatPulse` avance la phase de `PHOTON_LEAD` (~45 ms, réglable dans `apply.ts`) pour que le
  photon tombe **sur** le beat malgré la latence de la chaîne.
