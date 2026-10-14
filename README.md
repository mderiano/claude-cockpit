# Cockpit

**Français** · [English](README.en.md)

Un panneau en direct qui montre ce que fait Claude : les commandes et leur sortie, les fichiers modifiés avec leur diff, les sous-agents (y compris ceux des workflows ultracode) et l’écran d’un simulateur, d’un émulateur ou du navigateur.

L’interface du panneau est en anglais.

Le cockpit se contente d’observer. Il ne bloque jamais un appel d’outil et ne le modifie pas. Si quelque chose casse de son côté, l’erreur est avalée et la session continue.

## Ouvrir

- **Bouton au-dessus du champ de saisie** : quand le panneau est fermé, un bouton `◆ Open Cockpit · 198` le rouvre d’un clic.
- **Résumé en bas à droite** : `◆ 198 · 2 agents` (appels d’outils, agents actifs), sans le mot « cockpit ». Dans le terminal, c’est aussi un bouton qui ouvre ou ferme le panneau.
- **App de bureau** : le panneau s’ouvre tout seul en barre latérale, une fois par session. Pour couper ça, désactive l’option `autoOpen` du plugin.
- **Commande** : `/cockpit` ouvre le panneau, `/cockpit close` le ferme, `/cockpit live [on|off]` règle la capture d’écran en continu.

## Ce que tu vois (app de bureau)

Une seule vue, sans onglets, comme si tu regardais par-dessus l’épaule de Claude.

- **En-tête** : appels d’outils, commandes, fichiers modifiés (`+`/`−`), agents actifs, erreurs, durée de la session, et une courbe de l’activité des 6 dernières minutes.
- **NOW**, ce que Claude fait en ce moment, en grand :
  - une **commande** dans une fenêtre de terminal : la commande, un curseur pendant qu’elle tourne, puis la fin de sa sortie ;
  - un **fichier modifié** avec son diff coloré (y compris par un sous-agent) ;
  - un **agent** ou un **workflow** lancé : son état, ce qu’il fait à l’instant, une barre de progression par agent ;
  - l’**écran** du navigateur ou du simulateur, mis à jour après chaque action.
  
  Quand rien ne tourne, la dernière action reste affichée.
- **HISTORY**, en dessous : les fichiers et les agents gardent leur carte ; les commandes, lectures et recherches sont regroupées en blocs compacts. Survole une ligne pour voir sa sortie.

Dans le terminal, le panneau garde une vue à onglets (Feed, Files, Agents, Screen ; touches 1 à 4).

## Sources de l’écran

| Source | Ce qu’il faut |
|---|---|
| Navigateur intégré (Claude Browser) | Rien. Après chaque action, le cockpit prend une capture, si l’app l’autorise sans te demander. |
| Claude in Chrome | Rien. Capture après une action qui précise l’onglet. |
| Simulateur iOS | Xcode (`xcrun simctl`) et un simulateur démarré. Capture après chaque action sur le simulateur. Les images sont réduites avec `sips`, fourni avec macOS. |
| Émulateur Android | `adb` dans le `PATH`, dans `~/Library/Android/sdk/platform-tools` ou dans `$ANDROID_HOME/platform-tools`, et un appareil connecté. |

Le bouton « Live screen » capture l’écran du simulateur ou de l’émulateur toutes les 2 s ; « Capture screen » en prend une seule. Dans l’app de bureau, l’image passe par un SVG ; dans le terminal, par le protocole d’images kitty (kitty, Ghostty).

## Installation

Dans une session Claude Code lancée dans un terminal :

```
/plugin install cockpit --marketplace mderiano/claude-cockpit
```

Réponds `y` pour ajouter la marketplace, puis choisis la portée « user » pour l’avoir dans toutes tes sessions (terminal et app de bureau).

Ou en ligne de commande :

```sh
claude plugin marketplace add mderiano/claude-cockpit
claude plugin install cockpit@claude-cockpit --scope user
```

Il faut Claude Code 2.1.295 ou plus récent (`claude update`) : le plugin utilise `session.append` et `session.attach`.

### Développer

```sh
claude --plugin-dir /chemin/vers/claude-cockpit   # charger le dossier pour une session
claude plugin validate /chemin/vers/claude-cockpit
claude plugin test /chemin/vers/claude-cockpit
```

## Limites

Le cockpit garde 300 appels, 200 fichiers (12 changements par fichier), 150 agents et 20 runs de workflow. Les sorties sont coupées à environ 4 000 caractères et les diffs à 12 000. Une seule image d’écran est conservée : chaque nouvelle remplace la précédente. Un `/clear` remet tout à zéro, sauf l’onglet choisi.
