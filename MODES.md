# MODES

> 🇬🇧 This document is in French. The complete English overview is in the
> [README](README.md); this file is the full mode catalogue.

Banc d'essai de modes de simulation audio-réactifs — **24 modes** : 19 systèmes du
catalogue (FHN, Lenia, Gray-Scott…) et 5 **créations maison** (`hocket`, `comb`,
`stitch`, `anamnese`, `symbiose`) qui ne correspondent à aucun système publié. Tous les modes sont pilotés
par le **même bus de features** via la **modulation matrix** (le point d'injection).

## Rendu : la courbe de tonemap

La densité écrite par un mode passe par `src/post/tonemap.frag` : `t = d·e/(1+d·e)`
puis indexation d'une LUT. **Épaule longue voulue** : la version précédente
(`1 − exp(−d·e)`) saturait à `t = 0,96` dès une densité de 2, si bien que tout ce qui
dépassait tombait dans les 15 % supérieurs de la LUT — qui finissent en blanc. Mesuré
dans le client avant correction : **57 % de l'image écrêtée sur `hocket`**, et sur
`kuramoto` 98,8 % des pixels au-dessus de 0,75 pour seulement 13 niveaux distincts sur
64. Après : 0 à 6 % d'écrêtage, 26 à 52 niveaux.

L'exposition est **pilotée par le son** (`rms → global.exposure`, base 2,0) : un passage
fort éclaircit légitimement l'image. Si c'est trop, les deux leviers sont cette route et
`global.exposure`, tous deux éditables à chaud dans le panneau **M**.

Un mode dont l'information est portée par la TEINTE (comme `kuramoto`, où la phase θ
donne la couleur et la cohérence r la densité) restera peu contrasté : la LUT est
indexée sur la densité et la teinte du mode n'est mélangée qu'à 50 %. Faire porter la
phase par la luminosité a été essayé et **mesuré moins bon** (image pastel délavée) :
c'est l'intensité qui est le canal lisible, la teinte ne fait que confirmer.

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

**Plage de tempo : 70 à 240 BPM** (house, techno, trance, drum&bass, hardcore).
Mesuré sur kick 4/4 : 80→200 BPM suivis avec un verrou de 0,99-1,00. Sur un mix
très dense où une basse en doubles-croches occupe la même bande que le kick,
l'estimation reste peu fiable — le flux d'onsets y est dominé par la subdivision,
pas par le temps ; le remède serait une détection d'onsets limitée à la bande du
kick, non implémentée.

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

## Catalogue (Phase 2b) — 6 modes durs

### continuous
- **neuralca** — Neural CA à poids FIXES (perception sobel/laplacien + couche fixe) ; `bass`→gain, `onset`→germes. Auto-organisation.
- **grayscott** — réaction-diffusion (coraux/mitose) ; **F/k** pilotés par `bass`/`treble` (deltas fins — le couple F/k change tout), `onset`→taches.
- **ising** — verre de spin, Metropolis en damier ; **température** ← `energy`/`rms` (haute=désordre, basse=domaines), `onset`→coup thermique.

### density
- **buddhabrot** — nébuleuse des trajectoires d'échappement de Mandelbrot (reseed continu des orbites échappées). Spectre→région/teinte.
- **nbody** — particules sous gravité vers des masses **spawnées sur les onsets** ; traînées par accumulation. Softening anti-NaN.

### growth
- **dbm** — foudre de Lichtenberg : Laplace (Jacobi) + croissance stochastique ∝ φ^η ; `energy`→η, kick→éclair. Figure fine et brillante.

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

---

## Créations maison (Phase 3) — 3 mécaniques inédites

Les 19 modes précédents implémentent des systèmes connus. Ces trois-là n'ont pas de
référence : ce sont des mécaniques inventées pour ce visualiseur, chacune tirant sur
une dimension différente du son (le rythme dans le TEMPS, dans l'ESPACE, dans la MATIÈRE).
Aucun modèle à comparer, donc voici ce que chacune est *censée* faire.

### hocket — cartographie rythmique · famille `continuous` (mode 20)
Chaque voix percussive est un **peuple qui conquiert le plan**. Un kick, une caisse
claire, un charley plantent un germe ; le territoire se propage de proche en proche,
la force transmise étant amputée à chaque case (`yield`) — le front s'arrête donc à
une distance proportionnelle à l'énergie du coup. L'image est la **carte du groove**.

*Ce qu'on doit voir* : des régions aux frontières nettes qui se disputent la surface,
chaque voix à son niveau d'intensité (donc sa couleur après LUT), les conquêtes
fraîches plus vives, et une carte qui **persiste** entre les frappes. Si tout devient
noir entre deux coups, `floorLum` est trop bas ; si ça grouille pixel par pixel,
`margin` (l'hystérésis) est trop faible.

| dest | source |
|---|---|
| `hocket.params.kickAmp` | `onset` |
| `hocket.params.seedR` | `bass` |
| `hocket.params.hatsAmp` | `treble` |
| `hocket.params.seam` | `flux` |
| `hocket.params.floorLum` | `rms` |

### comb — peigne temporel · famille `continuous` (mode 21)
Un **filtre en peigne, mais dans l'image**. Le son entre par des germes de transitoires
et un anneau spectral ; l'image se relit telle qu'elle était il y a *exactement une
pulsation*, tournée et redimensionnée d'un cran. Les échos retombent donc pile sur le
temps et s'enroulent en spirale : on **voit** le tempo. Le retard est choisi par
horodatage des couches (jamais en comptant des frames), donc identique à 30, 60 ou
144 fps ; un comptage de frames désaccorderait le peigne au premier à-coup.

*Ce qu'on doit voir* : une rosace d'échos concentriques qui pulse sur la mesure, et
qui se **réaccorde** quand le tempo change. `tapGain` est routé sur `lockConf` : plus
le verrou de tempo est sûr, plus les échos ressortent.

| dest | source |
|---|---|
| `comb.params.hitAmp` | `onset` |
| `comb.params.tapGain` | `lockConf` |
| `comb.params.zoom` | `bass` |
| `comb.params.swirl` | `treble` |
| `comb.params.specGain` | `centroid` |

### stitch — tissage sous tension · famille `density` (mode 22)
Une **étoffe** au lieu d'un champ. Des fils (chaînes de noeuds) tendus entre deux
ancres se tendent (ressort le long du fil), s'évitent (répulsion par le gradient d'un
champ de densité — c'est ce qui produit l'entrelacs plutôt qu'un paquet) et respirent
avec le spectre. Chaque frappe **décroche un fil** et le rejette ailleurs : la trame
se recoud en rythme.

*Ce qu'on doit voir* : des fils distincts qui se croisent en tissu, tendus entre des
ancres qui sautent sur les frappes. Trois garde-fous tiennent la stabilité (`dt` borné
par la raideur, vitesse clampée, position clampée) : sans eux une route qui monte
`stiff` enverrait les positions à NaN — et un NaN dans une texture de position ne se
voit pas, ça rend juste **noir**.

| dest | source |
|---|---|
| `stitch.params.stiff` | `energy` |
| `stitch.params.swirl` | `bass` |
| `stitch.params.spread` | `treble` |
| `stitch.params.gain` | `onset` |
| `stitch.params.tense` | `flux` |

Coût mesuré dans Spotify (panneau 791×608, Intel HD 530, `gl.finish()`, 100 frames) :
**comb 3,4 ms · hocket 5,0 ms · stitch 5,1 ms** — soit très en dessous des 16,7 ms.

---

## anamnese — mémoire de forme · famille `continuous` (mode 23)

> ἀνάμνησις : se ressouvenir. Chez Platon, connaître, c'est se rappeler.

Les 22 autres modes réagissent à l'**instant** : ce qui sonne maintenant déforme
l'image maintenant. Celui-ci écoute la **forme du morceau**. Il garde une mémoire de
ce qu'il a entendu et de ce qu'il a montré ; quand la musique revient sur elle-même
— un refrain, une reprise — il ne fait pas un écho, il **reconvoque**.

> **L'invariant du mode : la mémoire fixe les RÈGLES ; l'image stockée est une
> PREUVE, jamais une entrée.**

C'est toute la ligne de partage. La mémoire n'entre dans la simulation que par huit
scalaires — la géométrie de l'écoulement au moment rejoué. Le champ **reconstruit**
donc le passé sous ses propres règles au lieu de le rejouer. L'image d'alors n'est
lue qu'à la composition : le présent s'efface un peu, elle apparaît en retrait, et
là où les deux ne coïncident pas, une interférence blanche scintille. On voit deux
choses à la fois : **que** ça revient, et **où** ce retour ne colle pas.

Réinjecter l'image stockée dans le champ, au contraire, ferait de ce mode un `comb`
avec un index adressé par contenu — et c'est exactement ce qui a été observé quand
la première version le faisait : le souvenir reconvoqué se retrouvait photographié
une seconde plus tard (souvenir d'un souvenir), et l'image blanchissait.

La différence avec `comb` est le point entier du mode : comb est une ligne à retard
accordée sur le **tempo** — il rejoue ce qu'il y avait il y a une pulsation, que la
musique l'ait mérité ou non. Ici le retard n'est pas choisi par l'horloge mais par le
**contenu** : la mémoire est adressée par ressemblance musicale.

### Ce qui a été mesuré avant d'écrire une ligne

La détection vit dans `src/audio/recurrence.js`, testée en Node (`npm test`). Trois
mesures, toutes contre-intuitives, ont façonné l'algorithme — chacune a invalidé une
première version qui semblait pourtant raisonnable :

1. **L'AGC par bande du worklet rend tout semblable.** Cosinus 0,77 à 0,98 entre des
   passages pourtant différents : une composante commune écrase la comparaison. On
   retire donc la moyenne courante des empreintes. Sur un test A-B-A, la marge passe
   de **0,156 à 1,46**.
2. **La phase de beat ne peut pas servir d'horloge de découpage.** Le verrou de tempo
   est souvent à 0,1-0,4 et la phase se recale sur chaque onset : le découpage par
   passage de beat produisait 4,9 fenêtres/s au lieu de 2. Pas fixe de 0,5 s.
3. **Un passage qui revient fait un plateau, pas une pointe.** À un instant donné, le
   score est 0,95 sur *tous* les décalages de 36 à 50 s (la section entière) contre
   −0,42 ailleurs. Un blanchiment local rabotait ce plateau et n'en gardait que les
   bords ; une statistique robuste (médiane) et une sélection au **centre du plateau**
   règlent le problème. La confiance est la **proéminence** pic − médiane, dont les
   seuils sont choisis dans les données :

   | | p10 | médiane | p90 |
   |---|---|---|---|
   | vrais retours | 0,31 | 0,52 | 0,76 |
   | reste du morceau | 0,09 | 0,14 | 0,20 |
   | flux sans structure | — | 0,02 | — |

   Seuil à **0,25** : les trois cas sont séparés, avec un facteur 10 de marge contre
   le bruit. Sur le test synthétique A-B-A-B (sections de 20 s à progression interne),
   la mémoire retrouve la période à **40,0 s** — exactement — et ne se déclenche jamais
   sur un flux sans structure.

4. **Vérifié ensuite sur la vraie musique**, dans Spotify : en phase d'écoute la
   proéminence tient 0,11-0,16 ; quand un passage revient elle monte à 0,43, 0,50,
   0,71. Et le mode s'est engagé tout seul sur un morceau réel — *« passage d'il y a
   35,8 s, souvenir disponible, enveloppe 1,0 »*. Le seuil tiré du synthétique tient
   donc sur le terrain.

### La limite, mesurée plutôt que passée sous silence

Une relecture adverse a soulevé l'objection la plus sérieuse qu'on puisse faire à ce
mode : la géométrie et l'empreinte dérivent des mêmes features, donc au moment où un
rappel se déclenche la géométrie du présent ressemble **déjà** à celle du passage
rejoué — et le morphing ne déplacerait rien. C'est mesurable, donc c'est mesuré
(`geom_ratio` dans `__viz.modeDebug()`) : le rapport entre le déplacement imposé par
la mémoire et la dérive naturelle de la géométrie sur 30 s vaut, sur cinq rappels
réels, **1,08 · 1,54 · 1,03 · 1,01 · 0,82**.

L'objection est donc à moitié fondée : le morphing n'est **pas** un non-événement (la
mémoire pèse autant que trente secondes d'évolution musicale, parfois 1,5×), mais ce
n'est pas non plus une refonte spectaculaire du champ. Ce qui rend une reconvocation
*visible*, c'est surtout la composition — le présent qui s'atténue, la preuve en
retrait, l'interférence. Il fallait le dire ainsi plutôt que promettre plus.

Et un contrôle qui pouvait tout invalider en silence : le tableau d'uniformes `uG[]`
atteint-il vraiment le shader ? (twgl ignore sans erreur une clé `"uG[0]"`, et
l'écran resterait plausible avec une géométrie figée à zéro.) Forcé à `vortex 0`
puis `vortex 3`, le rendu passe de moyenne 500 / σ 170 à 676 / σ 76 : il l'atteint.

### La réponse apportée à cette limite

La géométrie a reçu une **9e dimension que l'apparieur ne voit pas** : une phase de
rotation *accumulée* le long du morceau (~0,02-0,04 rad/s). Les huit autres dérivent
des mêmes features que l'empreinte — d'où le quasi-non-événement mesuré — mais deux
passages musicalement identiques à 40 s d'intervalle ont forcément des phases
différentes. Reconvoquer le passé, c'est donc **rembobiner** cette rotation : une
discontinuité que la ressemblance musicale ne peut pas produire d'elle-même. Pour un
rappel à 40 s, le rembobinage vaut 0,6 à 1,6 rad.

Relevé sur un rappel réel après la modification (décalage 22 s) : écart imposé par la
mémoire **0,602** contre une dérive naturelle de **0,195**, soit un **ratio 3,09** —
là où les cinq mesures d'avant donnaient 0,82 à 1,54. La mémoire déplace donc la
géométrie environ trois fois plus que la musique ne la fait dériver d'elle-même.

*Deux réserves, parce qu'une mesure n'est pas une preuve* : c'est **un seul**
échantillon, et son dénominateur (la dérive, moyenne glissante) n'avait convergé que
sur 75 fenêtres, ce qui le sous-estime et gonfle le ratio. L'écart absolu (0,602)
reste du même ordre que ceux d'avant (0,5-1,05) : le gain est net sur le rapport,
plus modeste sur le déplacement brut. À reprendre sur plusieurs rappels, écran
déverrouillé.

### Deux pannes silencieuses trouvées et corrigées après coup

Le diagnostic ajouté pour instruire l'objection ci-dessus a révélé deux vraies pannes,
toutes deux **sans la moindre erreur à l'écran** :

- **Origine d'horloge empoisonnée.** Quand le pont est hors ligne, le moteur passe une
  trame de repos horodatée 0. La mémoire prenait ce 0 comme origine ; les vraies trames
  arrivant ensuite à t = 6417 s (le pont tourne depuis des heures), la condition
  d'émission devenait toujours vraie, chaque frame fermait une fenêtre d'un seul
  échantillon, et la mémoire restait morte **pour toute la session**. Ouvrir le
  visualiseur avant de lancer le pont suffisait. Corrigé des deux côtés : le mode ne
  nourrit plus la mémoire sans audio, et la mémoire se rebase sur toute discontinuité
  d'horloge (test E).
- **Dépendance au taux de rafraîchissement.** Le mode n'échantillonne le bus qu'une
  fois par frame rendue. Quand Chromium bride le rAF (fenêtre occultée, écran
  verrouillé : mesuré à 1,3 Hz), chaque fenêtre se fermait avec un échantillon et se
  faisait jeter par un garde `accN < 4` — plus aucune fenêtre, jamais. Garde ramené à
  1 : mieux vaut une empreinte bruitée qu'une mémoire morte (test F). Vérifié en
  clientèle sous rAF bridé : 16 → 25 → 35 fenêtres en 36 s.

### Ce qu'on doit voir

Un champ de filaments advectés, façonné par trois tourbillons dont la position vient
du spectre. Pendant les 30 premières secondes, **rien de spécial** — c'est voulu : la
mémoire écoute (il lui faut au moins 60 fenêtres, et la proéminence doit franchir le
seuil). Puis, quand un passage revient, le champ **retrouve sa forme d'alors** — la
géométrie est tirée vers celle du passage rejoué —, le présent s'atténue, l'image
d'alors apparaît en retrait et l'interférence dessine ce qui ne coïncide pas. L'entrée
est marquée d'une brève secousse sur l'interférence : un souvenir qui revient, ça se
remarque d'un coup, puis ça s'installe. En bas, une bande fine — le **spectre de
mémoire** — montre, pour chaque décalage possible, la force avec laquelle le présent
lui ressemble : c'est l'écoute rendue visible. Le repère lumineux indique le décalage
retenu.

Si rien ne revient jamais (ambient, impro), le mode reste un champ de filaments qui
respire — et la bande du bas reste plate. C'est la dégradation voulue : il ne ment pas.

`__viz.modeDebug()` dans la console de Spotify affiche l'état de la mémoire
(proéminence, décalage, enveloppe, souvenir disponible).

| dest | source |
|---|---|
| `anamnese.params.inject` | `energy` |
| `anamnese.params.vortex` | `bass` |
| `anamnese.params.filament` | `treble` |
| `anamnese.params.swirl` | `centroid` |
| `anamnese.params.advect` | `flux` |

Les paramètres de mémoire (`ghost`, `diff`, `morph`) ne sont **volontairement routés
sur aucune feature** : ce n'est pas le niveau sonore qui décide d'un souvenir, c'est
la structure du morceau.

---

## symbiose — écosystème · famille `continuous` (mode 24)

Six modes demandés ensemble : `greenberg`, `thomas`, `nbody`, `spacecol`, `comb`,
`anamnese`. Les juxtaposer aurait donné un collage — un collage, ça se voit. Ils sont
donc **couplés** en un seul monde, chacun gardant sa règle mais nourrissant les autres.

- **Le milieu** (greenberg) — un automate cyclique excitable propage des ondes en
  spirales. C'est le terrain : tout le reste y vit.
- **Les nageurs** (thomas + nbody) — ils suivent le flot cyclique de Thomas, mais
  *dévié vers les fronts d'onde* du milieu ; les onsets y jettent les masses
  transitoires de nbody.
- **Les dendrites** (spacecol) — elles poussent vers les zones excitées et
  **rallument** le champ sur leur passage.
- **La mémoire** (comb + anamnese) — l'écho calé sur la pulsation (anneau court,
  cadence pulsation/4) et la reconnaissance de passage (anneau long, 1 instantané/s,
  64 s de portée) qui montre l'écart entre le présent et le passage semblable.

### Les cinq couplages, et pourquoi ils ne sont pas décoratifs

1. les nageurs sont déviés par les fronts du milieu ;
2. les onsets y jettent des masses gravitationnelles transitoires ;
3. les attracteurs de dendrites sont posés là où l'onde va passer ;
4. les pointes de dendrites rallument le champ (`blendEquation(MAX)` : une case au
   repos passe à 1, une case réfractaire reste intacte — la règle du CA est préservée) ;
5. **les nageurs broutent le milieu** (`blendEquation(MIN)`) : là où ils passent, la
   cellule retombe au repos. C'est ce couplage qui empêche l'automate d'occuper toute
   la surface — sans lui, le labyrinthe mangeait l'image et rien ne venait le casser.

Mesuré en désactivant chaque couplage (signature de luminance au centre de l'image) :

| couplage | désactivé | activé |
|---|---|---|
| nageurs déviés par les fronts | σ 0,3 (image plate) | σ 2,6 |
| dendrites rallumant le champ | moyenne 16, σ 0 (le milieu s'éteint) | moyenne 94, σ 66 |

Le milieu nourrit les agents, les agents entretiennent **et** dévorent le milieu.

**Coût mesuré** : 1,9 à 4,3 ms/frame selon l'activité (panneau 791×608, Intel HD 530).
Attention au préchauffage si vous mesurez : les deux baies de textures et la
compilation des shaders font lire 36 à 58 ms sur les premières frames.

**Non vérifié** : le rappel long (anamnese) est implémenté et tourne, mais je ne l'ai
pas observé se déclencher à l'écran — il lui faut plus de 90 s sur un même morceau.
L'écho court, lui, est actif (il coûte 0,3 ms sur les 2,3).
