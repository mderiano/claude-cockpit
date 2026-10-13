# Cockpit

**Français** · [English](README.en.md)

Un panneau en direct qui montre ce que fait Claude : les commandes et leur sortie, les fichiers modifiés avec leur diff, les sous-agents (y compris ceux des workflows ultracode) et l’écran d’un simulateur, d’un émulateur ou du navigateur.

Le cockpit se contente d’observer. Il ne bloque jamais un appel d’outil et ne le modifie pas. Si quelque chose casse de son côté, l’erreur est avalée et la session continue.

## Ouvrir

- **App de bureau (onglet Code)** : le panneau s’ouvre tout seul en barre latérale, une fois par session, dès que l’app se connecte. Pour couper ça, désactive l’option `autoOpen` dans la configuration du plugin.
- **Partout** : la commande `/cockpit [onglet]` ouvre le panneau, ou lui donne le focus s’il est déjà ouvert.
  - `/cockpit feed`, `files`, `agents` ou `screen` ouvre le panneau sur l’onglet choisi.
  - `/cockpit live` active ou coupe la capture en direct de l’écran.
  - `/cockpit close` ferme le panneau.

## En-tête

Une rangée de pastilles résume la session : appels d’outils, commandes, fichiers touchés, lignes `+`/`−`, agents actifs ou finis, erreurs, combo d’appels réussis et durée de la session. Une petite courbe montre l’activité des 6 dernières minutes. Quelques jalons déclenchent un toast : premier fichier modifié, tests au vert, 100 appels, 10 agents… Un résumé d’une ligne s’affiche aussi sous la saisie.

## Onglets (raccourcis 1 à 4)

| Touche | Onglet | Contenu |
|---|---|---|
| `1` | **Feed** | Tous les appels d’outils, du plus récent au plus ancien. Chacun a une pastille de couleur par catégorie (shell, édition, lecture, recherche, web, agent, écran, MCP), un statut (◐ en cours, ✓ ok, ✗ erreur, ⛔ refusé) et sa durée. Clique une ligne pour voir l’entrée complète, la sortie et le diff. Un filtre permet de choisir Tout, la session principale ou un agent précis. |
| `2` | **Fichiers** | Les fichiers modifiés, avec les compteurs `+`/`−` et l’historique de chaque fichier en diff unifié coloré. |
| `3` | **Agents** | La session principale, puis l’arbre des sous-agents et des coéquipiers. Les runs de workflow (ultracode) ont une barre de progression. Ce qui tourne est affiché en premier. Un run terminé tient sur une ligne qu’on déplie d’un clic. Clique un agent pour voir son mini-feed et sa réponse. |
| `4` | **Écran** | La dernière image d’un simulateur, d’un émulateur ou d’un outil. `l` active ou coupe le mode Live (une capture toutes les 2 s), `s` prend une capture. |

## Sources de l’onglet Écran

| Source | Ce qu’il faut |
|---|---|
| Simulateur iOS | Xcode avec ses outils en ligne de commande (`xcrun simctl`) et un simulateur démarré. Les images sont réduites avec `sips`, fourni avec macOS. |
| Émulateur Android | `adb` dans le `PATH`, dans `~/Library/Android/sdk/platform-tools` ou dans `$ANDROID_HOME/platform-tools`, et un appareil connecté (`adb devices`). |
| Captures d’outils | Rien à installer. Les captures prises par Claude avec les outils navigateur (Claude Browser, Claude in Chrome), simulateur iOS ou computer-use s’affichent automatiquement. |

La capture ne tourne que si l’onglet Écran est visible et que le mode Live est actif, ou quand tu appuies sur « Capturer ». Dans l’app de bureau, l’image passe par un SVG compressé en JPEG. Dans le terminal, elle passe par le protocole d’images kitty (kitty, Ghostty) ; ailleurs, un texte la remplace.

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
