# VIZ — Music Visualizer

Visualiseur audio réactif dans le navigateur. Capte le **son du système** (PipeWire),
analyse le spectre en temps réel (Web Audio / FFT) et le rend sur `<canvas>`.

> Base v1 — pensée pour évoluer vers des shaders WebGL et plusieurs scènes.

## Lancer

`getUserMedia` exige un contexte sécurisé. `http://localhost` en est un → on sert le dossier :

```bash
cd ~/Bureau/claude/Vizualizer
python3 -m http.server 8080
```

Puis ouvre **http://localhost:8080** (Chromium/Firefox récent).

## Capter le son système (PipeWire)

1. Clique dans le sélecteur **Source audio** → le navigateur demande l'autorisation micro (nécessaire pour lister les périphériques).
2. Choisis une entrée **« Monitor of <ta sortie> »** — c'est le son qui sort de tes enceintes.
3. **▶ Démarrer**. Lance de la musique (Spotify, YouTube…).

Si aucun « Monitor » n'apparaît, active la source moniteur dans ton mixer
(`pavucontrol`, ou `wpctl`/`qpwgraph` côté PipeWire).

## Raccourcis

| Touche | Action |
|--------|--------|
| Espace | Pause / reprise |
| F | Plein écran |
| H | Masquer le HUD |

## Structure

```
index.html        UI + canvas
style.css         thème
app.js            orchestration (devices, boucle, raccourcis)
audio.js          AudioEngine : FFT, bandes, beat detection
visuals/radial.js scène "anneau spectral + noyau + particules"
```

Ajouter une scène = créer `visuals/<nom>.js` exposant `start()` et `render(frame)`,
où `frame = { freq, time, bass, mid, treble, level, beat }`.
