# Mod Spicetify — le visualiseur dans Spotify

> 🇬🇧 This document is in French. The complete English overview is in the
> [README](README.md); this file is the architecture deep-dive.

Une **custom app Spicetify** qui rend les 24 modes de ce dépôt directement dans le
client Spotify, pilotés par le son **réellement joué**, en temps réel.

```
 Spotify (décodage natif)
        │  sortie système
        ▼
 PipeWire  ──pw-record──▶  bridge/viz-bridge.mjs
                            │  analyser.worklet.js (LE fichier du navigateur, joué dans Node)
                            │  → 51 floats : mel[32], rms, flux, onsets, kick/snare/hats…
                            ▼  ws://127.0.0.1:8787   ~94 trames/s (204 o/trame)
                     spicetify/  custom app "Vizualizer"
                            WsBus → mod matrix → mode → tonemap (WebGL2)
```

## Pourquoi un pont, et pas tout dans Spotify

Spotify décode l'audio en **natif** : aucun `<audio>`, aucun `MediaElement`, et
`getUserMedia` / `getDisplayMedia` ne sont pas exploitables depuis son moteur de
rendu. Aucune page ne peut donc lire le son du player. Deux conséquences, toutes
deux **vérifiées dans le client** (Spotify 1.2.95, Spicetify 2.44) :

- l'API interne d'analyse de Spotify, sur laquelle reposent les vieux visualiseurs
  Spicetify, **n'existe plus** : `wg://audio-attributes/v1/audio-analysis/<id>`
  répond `Resolver not found!`. Elle n'est pas utilisée ici ;
- la seule source de vrai temps réel est une **capture système**, d'où le pont.

Le pont calcule aussi les **features** (FFT, mel, onsets) : le client Spotify ne
fait que du WebGL. Pas d'AudioWorklet à charger dans xpui, pas de CSP à contourner,
et le DSP ne concurrence pas le décodage audio du player.

Ce qui a été vérifié dans le client avant d'écrire l'app :
`ws://127.0.0.1` ✅ · WebGL2 + `EXT_color_buffer_float` + FBO `RGBA32F` ✅
(rendu ANGLE/Mesa Intel HD 530) · `Spicetify.React/Player/Platform` ✅.

## Installation

```bash
npm run install:spicetify   # build + copie dans ~/.config/spicetify/CustomApps/viz + spicetify apply
npm run bridge              # le pont audio (à laisser tourner)
```

`install:spicetify` **ajoute** `viz` à `custom_apps` sans toucher aux apps déjà
installées (il le vérifie et râle si l'une disparaît), puis lance `spicetify apply`,
qui redémarre Spotify. L'entrée **Vizualizer** apparaît alors dans la barre latérale.

## Utilisation

Barre d'outils (elle s'éclaire au survol) : point d'état du pont, mode précédent /
suivant, palette (LUT), remise à zéro, **Matrix** (l'éditeur de mod matrix), reset
à chaque piste, **fond animé**, plein écran.

### Le débordement (bouton ▣, touche `B`)

Le visualiseur **garde son panneau plein** et **déborde** autour, par-dessus le
reste de Spotify. Le bouton cycle : éteint → 30 % → 60 % → éteint, l'étiquette
affiche le palier courant (`▣ 30 %`) et le choix est mémorisé.

L'opacité est décidée **par pixel, dans le tonemap** (`src/post/tonemap.frag`),
pas par un mode de fusion CSS :

```glsl
float a = u_outAlpha >= 1.0 ? 1.0 : mix(u_outAlpha * clamp(t, 0.0, 1.0), 1.0, dans);
```

`u_outAlpha = 1` court-circuite tout : hors du mode débordement le rectangle envoyé
est le tampon entier, **non gonflé** du feather, et le dégradé mordrait sinon 18 px
à l'intérieur de l'image.

- `dans` vaut 1 dans le rectangle du panneau (`u_pane`, gonflé du feather pour que
  le dégradé se joue entièrement dehors) : **image pleine et opaque au centre** ;
- au-delà, l'alpha est **proportionnel à la luminance** `t`, pas constant. C'est le
  point qui a demandé deux essais : avec un alpha constant, la LUT valant
  (0,01 0,01 0,03) à `t = 0`, chaque pixel noir — la majorité de l'image sur les
  modes épars — se composait comme un voile gris. À 30 %, **toute** l'interface
  Spotify s'assombrissait de 30 % pendant que les traînées qu'on voulait voir
  n'apparaissaient qu'à 30 %. Les deux moitiés ratées d'un coup. Avec `a ~ t`, le
  noir est strictement transparent et seules les traînées débordent ;
- `pointer-events: none` — Spotify reste entièrement cliquable au travers ;
- quand on quitte la page, il n'y a plus de panneau : le rectangle opaque est
  explicitement retiré (`setFond(op, null)`) et l'image devient uniformément
  translucide, sinon elle cacherait la bibliothèque qu'on vient d'ouvrir.

**La couche.** Le canvas ET toute l'UI du visualiseur (barre, HUD, titre, mod
matrix, carton d'erreur) vivent dans un même conteneur `.viz-couche`, qui passe
dans `<body>` en `position: fixed; z-index: 9998` quand le débordement est actif.
C'est nécessaire, pas cosmétique : `#main` est `position: relative; z-index: 0`,
donc un contexte d'empilement dont les `z-index` 8..14 de l'UI **ne peuvent pas
sortir**. Dans la première version le canvas seul passait dans `<body>` et
recouvrait sa propre interface — bouton ▣ compris, le seul moyen d'en ressortir
(d'où la touche `B`, ajoutée comme échappatoire). L'UI est rendue dans la couche
par un portail React (`Spicetify.ReactDOM.createPortal`).

Le moteur **survit à la navigation** : on peut parcourir sa bibliothèque pendant
que le visualiseur tourne. Le moteur, la couche et le canvas sont conservés hors
du composant React ; au remontage, `rebind()` ré-attache les callbacks **et le
nœud du HUD** (sans ça le HUD restait figé sur « … » pour le reste de la session).

Le rectangle du panneau est mesuré **une fois par changement de mise en page**
(ResizeObserver + `resize`), jamais dans la boucle de rendu : un
`getBoundingClientRect()` par image force un recalcul de mise en page de tout xpui
60 fois par seconde. La même mesure sert au shader (zone opaque) et au
positionnement de la barre et du HUD — une seule source, pas de dérive possible.

`RenderLoop.resize()` sort maintenant tôt si les dimensions n'ont pas changé : le
callback détruit et réalloue le tampon d'accumulation puis appelle `Mode.resize()`,
qui remet la simulation à zéro. Sans cette garde, replier la sidebar ou ouvrir le
panneau « en cours de lecture » effaçait l'image — et en mode débordement, où le
canvas fait 100vw × 100vh, il ne change jamais de taille.

Raccourcis (clic dans la vue d'abord — les touches sont interceptées pour ne pas
piloter la lecture en même temps) :

| touche | effet |
|---|---|
| `1`–`9`, `0` | mode direct |
| `←` `→` (ou `[` `]`) | mode précédent / suivant |
| `M` | mod matrix (routes feature → paramètre, éditables à chaud) |
| `L` | palette suivante |
| `R` | repartir de zéro |
| `F` | plein écran (en mode débordement, c'est la couche qui est promue) |
| `B` | débordement sur Spotify : éteint → 30 % → 60 % |

Le HUD du bas indique : mode, palette, fps, bpm, confiance du verrou de tempo et
**débit du pont** (`pont 94/s` = tout va bien ; `0/s` = plus rien n'arrive).

## Le pont

```bash
node bridge/viz-bridge.mjs                 # SEULEMENT la sortie de Spotify (défaut)
node bridge/viz-bridge.mjs --list          # applis qui jouent + périphériques
node bridge/viz-bridge.mjs --app firefox   # taper une autre application
node bridge/viz-bridge.mjs --source sink   # tout le son système (monitor du sink)
node bridge/viz-bridge.mjs --source mic    # le micro (test/parité navigateur)
node bridge/viz-bridge.mjs --port 9000 -v
```

**Ce qui est capturé, exactement.** En mode `app` (défaut), le pont ouvre une
capture **non liée** (`pw-record --target 0`) puis câble lui-même, avec `pw-link`,
les ports de sortie de Spotify vers ses entrées. Résultat : ni micro, ni son des
autres applications. Le routage de Spotify n'est pas touché — un port PipeWire
accepte plusieurs liens, la musique continue de sortir sur les enceintes.

> **Le piège** (vérifié ici) : `pw-record --target <sink>` ne capture **pas** le
> monitor du sink. WirePlumber ignore la cible et retombe sur la **source par
> défaut** — le micro. Il faut `-P stream.capture.sink=true` pour un monitor,
> et cibler un *flux applicatif* ne marche pas du tout (retour au micro).
> `pw-link -l | grep -A2 viz-bridge` montre à tout moment la vérité du câblage.

Mesure de contrôle sur ce poste, micro actif dans la pièce :

| état de Spotify | rms moyen | peak | mel max | onsets / 5 s |
|---|---|---|---|---|
| en pause | 0.0000 | 0.0000 | 0.000 | 0 |
| en lecture | 0.2763 | 0.5828 | 1.000 | 36 |

Autres propriétés :

- **Suivi automatique** : Spotify détruit et recrée son flux (pause longue, pub,
  redémarrage). Le pont rescanne toutes les 2 s et recâble tout seul.
- **Pas de trou** : quand l'app ne joue pas, le pont pousse du silence au rythme
  réel — les trames continuent d'arriver, le client reste connecté (sinon il
  afficherait à tort « pont hors ligne » à chaque pause).
- Zéro dépendance : serveur WebSocket maison (RFC 6455) dans `bridge/ws-server.mjs`.
- `-v` affiche un battement de coeur `trames/s · rms · clients`.
- Il relance `pw-record` tout seul s'il meurt (backoff exponentiel).

Le client se reconnecte seul : tu peux démarrer, arrêter, redémarrer le pont sans
toucher à Spotify. Sans pont, l'app affiche la commande à lancer.

## Performance

Coût moteur mesuré **dans Spotify** (panneau 791×608, DPR 1, Intel HD 530 / Mesa,
moyenne sur 120 frames avec `gl.finish()`) :

| mode | ms/frame | | mode | ms/frame |
|---|---|---|---|---|
| anamnese | 1.5 | | fhn | 4.1 |
| nbody | 3.1 | | lenia | 4.2 |
| comb | 3.4 | | neuralca | 5.0 |
| hocket | 5.0 | | grayscott | 5.8 |
| stitch | 5.1 | | dbm | 11.4 |

Soit 60 fps confortables à cette taille. En plein écran (`F`) la surface quadruple :
si un mode traîne, baisse `simScale` — le `new RenderLoop(canvas, 0.7)` de
`spicetify/src/engine.ts` (0.5 divise le coût de sim par deux).

## Dépannage

| symptôme | cause probable |
|---|---|
| overlay « pont hors ligne » | le pont n'est pas lancé, ou un autre port (`--port`) |
| `pont 0/s` alors que ça joue | `pw-link -l \| grep -A2 viz-bridge` : sur quoi es-tu câblé ? |
| `rms 0.000` en lecture | flux Spotify pas encore recréé — attends 2 s (rescan) |
| le visualiseur réagit au micro | tu es sur un vieux pont : `--source app` est le défaut ; vérifie les liens |
| fps très bas | écran verrouillé/fenêtre occultée : Chromium tombe à ~1 Hz de rAF. Sous 5 fps le rendu se **fige** volontairement (voir ci-dessous) |
| l'entrée n'apparaît pas | `spicetify apply` puis redémarrer Spotify |

## Désinstallation

```bash
~/.spicetify/spicetify config custom_apps viz-   # retire viz, garde les autres
~/.spicetify/spicetify apply
```

## Développement

```bash
npm run build:spicetify                 # bundle IIFE -> spicetify/dist/index.js
node spicetify/install.mjs --no-apply   # copie sans redémarrer Spotify
npm test                                # dont test/bridge-layout.test.mjs
```

`spicetify/dist/index.js` se termine par le `const render = ...` global attendu par
le routeur de custom app (même contrat que Marketplace) ; il est ajouté après
minification par un petit plugin Vite. Dans la console de Spotify, `__viz` expose
le moteur (`__viz.switchMode(7)`, `__viz.bus.status`, `__viz.names`).

`bridge/layout.mjs` duplique le layout de `src/audio/constants.ts` (Node ne lit pas
le `.ts`) ; `test/bridge-layout.test.mjs` échoue si les deux divergent — sans ce
garde-fou, une divergence donnerait des features silencieusement décalées.

## Fréquence d'images et fenêtre masquée

Chromium bride le rAF à ~1,2 Hz quand la fenêtre est occultée (mesuré deux fois).
Trois conséquences, toutes corrigées :

1. **Les décroissances étaient écrites PAR FRAME.** À 1 fps, une traînée de 0,2 s
   durait 14 s et les accumulations saturaient. `decayDt()` (dans `src/core/loop.ts`)
   compense par le temps réellement écoulé — avec un plancher, sans lequel l'écran
   deviendrait noir entre deux images. `gainDt()` fait de même pour les dépôts, pour
   que l'énergie **par seconde** reste constante. Test : `test/decay.test.mjs`.
2. **Le `dt` fourni aux modes est borné à 1/20 s** par `RenderLoop` (protection des
   simulations). La compensation utilise donc `time`, non borné.
3. **Sous ~5 fps, le rendu se fige.** À ce rythme les simulations de particules sont
   sous-échantillonnées et ne produisent plus que du bruit (constaté : nbody devient
   un semis de points brillants). Personne ne regarde une fenêtre cachée : l'image
   est gelée et repart intacte au retour, ce qui économise aussi le GPU.

Mesuré après correction, sur 15 s à ~34 fps : la luminance moyenne de nbody passe de
0,796 à 0,807 (stable) et son écrêtage de 22 % à 0,1 %.

> **Piège de mesure**, noté ici parce qu'il m'a fait conclure trois fois de travers :
> le canvas est créé avec `preserveDrawingBuffer: false`. Lire les pixels **après une
> pause** renvoie des zéros — le tampon a été présenté et invalidé. Il faut dessiner
> et lire dans la même tâche.
