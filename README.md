# Cockpit

**Français** · [English](README.en.md)

Un panneau en direct qui montre ce que fait Claude : les commandes et leur sortie, les fichiers modifiés avec leur diff, les sous-agents (y compris ceux des workflows ultracode) et l’écran de l’app que Claude pilote, quelle qu’elle soit : un navigateur, un simulateur, un émulateur, Blender, Godot, Unity, Unreal, FreeCAD, OpenSCAD, KiCad, ou toute app que tu nommes.

L’interface du panneau est en anglais.

Le cockpit se contente d’observer. Il ne bloque jamais un appel d’outil et ne le modifie pas. Si quelque chose casse de son côté, l’erreur est avalée et la session continue.

## Ouvrir

- **Bouton au-dessus du champ de saisie** : quand le panneau est fermé, un bouton `◆ Open Cockpit · 198` le rouvre d’un clic.
- **Bouton en bas à droite**, à côté des modes : `◆ 198 · 2 agents` (appels d’outils, agents actifs), sans le mot « cockpit ». Un clic ouvre ou ferme le panneau.
- **App de bureau** : le panneau s’ouvre tout seul en barre latérale, une fois par session. Pour couper ça, désactive l’option `autoOpen` du plugin.
- **Commande** : `/cockpit` ouvre le panneau, `/cockpit close` le ferme, `/cockpit live [on|off]` règle la capture d’écran en continu (elle reste active jusqu’à ce que tu l’arrêtes), `/cockpit watch <App>` suit la fenêtre d’une app (macOS), `/cockpit watch off` arrête.

## Ce que tu vois (app de bureau)

Une seule vue, sans onglets, comme si tu regardais par-dessus l’épaule de Claude.

- **En-tête** : appels d’outils, commandes, fichiers modifiés (`+`/`−`), agents actifs, erreurs, durée de la session, et une courbe de l’activité des 6 dernières minutes. Juste en dessous, toujours là, les boutons **Live screen** et **Capture screen**.
- **NOW**, seulement quand quelque chose se passe ; sinon la section n’est pas affichée du tout :
  - une **commande** en cours, dans une fenêtre de terminal : la commande et un curseur ;
  - tout autre **appel** en cours (une requête web, un outil MCP, un fichier en cours d’édition), en grand ;
  - un **sous-agent** au travail : sa carte, puis ses appels en lignes (celui en cours d’abord, puis ses cinq derniers), la commande qu’il lance dans un terminal et le fichier qu’il vient de modifier avec son diff ;
  - un **workflow** en cours : son état, une barre de progression avec un segment par agent, et ses deux agents les plus actifs, montrés comme des sous-agents ;
  - les **écrans** : chaque simulateur et émulateur tant que Live est actif, la fenêtre que tu suis, et une image qu’un appel vient de produire (une capture du navigateur, un `Read` d’un PNG, une image écrite par une commande) tant que le tour de Claude continue. Plusieurs écrans s’affichent ensemble, deux téléphones côte à côte quand le panneau est assez large. Chacun dit au-dessus d’où il vient (`iPhone 17 Pro · Live`, `OpenSCAD · out/preview.png · just now`, `Krita · untitled.kra · Watching`).

  Un appel qui travaille avec une app connue porte son badge (sa couleur et son nom), et la commande d’une app est titrée par ce qu’elle fait : `Blender · Render`, `Godot · Export`, `OpenSCAD · Render`. Un fichier binaire modifié par une commande ou un Write (`.blend`, `.FCStd`, `.uasset`, `.umap`, `.stl`, `.glb`…) a une carte « Asset changed » avec sa taille au lieu d’un diff.
- **HISTORY**, en dessous : ce qui vient de finir passe directement en haut. La dernière commande de la boucle principale garde son terminal avec la fin de sa sortie ; une modification de fichier garde son diff (20 lignes pour la plus récente, 10 pour les deux suivantes, puis l’en-tête du fichier seul) ; les agents et les workflows gardent leur carte ; les autres commandes, lectures et recherches sont regroupées en blocs compacts : une ligne de résumé, puis leurs trois appels les plus récents en lignes. Un écran qui n’est plus d’actualité s’affiche en carte plus petite, juste au-dessus de l’appel qui l’a produit.

### Déplier d’un clic

Tout ce qui est coupé s’ouvre d’un clic, et se referme de même :

- **`+ N more`** sous un bloc affiche tous ses appels (**Show less** les replie) ;
- **la ligne d’un appel** affiche en dessous ce qu’il était (outil, état, durée, code de sortie, agent), sa commande entière (ou son entrée) et toute sa sortie ;
- **Show full command and output** sous un terminal (ou **Show input and output** sous la carte d’un autre appel, **Show prompt and answer** sous celle d’un agent) affiche la même chose sous la carte ;
- **Show N more lines** sous un diff l’affiche en entier (**Show less** le replie).

Ce que tu as déplié reste déplié pendant que la vue se met à jour (40 éléments au plus), jusqu’au prochain `/clear`.

La vue est faite d’images fixes et de lignes natives : rien ne se recharge si ce qui est affiché n’a pas changé, et les durées n’avancent chaque seconde que pendant qu’un appel tourne (les âges changent une fois par minute).

Dans le terminal, le panneau garde une vue à onglets (Feed, Files, Agents, Screen ; touches 1 à 4).

## Sources de l’écran

| Source | Ce qu’il faut |
|---|---|
| Navigateur intégré (Claude Browser) | Rien. Après chaque action, le cockpit prend une capture, si l’app l’autorise sans te demander. |
| Claude in Chrome | Rien. Capture après une action qui précise l’onglet. |
| Simulateur iOS | Xcode (`xcrun simctl`) et un simulateur démarré. Capture après chaque action sur le simulateur. Les images sont réduites avec `sips`, fourni avec macOS. |
| Émulateur Android | `adb` dans le `PATH`, dans `~/Library/Android/sdk/platform-tools` ou dans `$ANDROID_HOME/platform-tools`, et un appareil connecté. |
| Toute image dans le résultat d’un outil | Rien. Quel que soit l’outil (un `Read` d’un PNG, un outil MCP qui rend ou capture), l’image que voit Claude s’affiche à l’écran. |
| Une image écrite par une commande | Rien. Quand une commande se termine, les fichiers image qu’elle nomme (`openscad -o out/preview.png`, `--output=shot.jpg`, `> plot.png`) et qu’elle a écrits sont cherchés ; le plus récent s’affiche. Les motifs comme `render_####.png` de Blender sont ignorés. |
| L’outil de capture MCP d’une app | Rien. Après une action sur le serveur MCP d’une app (blender-mcp, un serveur Godot ou Unity…) dont le résultat n’a pas d’image, le cockpit appelle l’outil de capture de ce serveur (`get_viewport_screenshot`, ou un outil nommé comme `screenshot` / `capture_viewport`), seulement si l’app autorise cet appel sans te demander. |
| La fenêtre d’une app (macOS) | `/cockpit watch <App>`, ou `"window"` sur une app de ton `cockpit.json`, et l’autorisation **Enregistrement de l’écran** pour Claude (Réglages Système › Confidentialité et sécurité › Enregistrement de l’écran). Seule la fenêtre au premier plan de cette app est capturée (`screencapture -l <id de fenêtre>`), jamais l’écran entier. |

### Live screen

Le bouton **Live screen** (ou `/cockpit live on`) capture toutes les 2 s chaque simulateur démarré (iOS, watchOS, visionOS ; quatre au plus) et chaque appareil Android connecté (quatre au plus, six appareils en tout), chacun dans son propre cadre, côte à côte. Live reste actif jusqu’à ce que tu l’arrêtes (le bouton, `/cockpit live off`) :

- pas encore de simulateur ni d’émulateur : il continue de chercher (après 2 s, puis 5 s, puis toutes les 10 s) et NOW affiche « Live screen — waiting for a simulator or emulator… » ; le premier qui démarre s’affiche tout seul ;
- un appareil éteint ou débranché : son cadre disparaît, les autres restent ;
- une capture qui échoue : la raison s’affiche sous les boutons et Live réessaie plus tard.

**Capture screen** prend une image de chaque appareil (ou de la fenêtre suivie), affichée sous NOW pendant une minute. Après une action de Claude sur le simulateur, il est capturé aussi. Dans l’app de bureau, les images passent par des SVG ; dans le terminal, par le protocole d’images kitty (kitty, Ghostty), le premier appareil dans l’onglet Screen.

### Suivre la fenêtre d’une app

`/cockpit watch Blender` capture la plus grande fenêtre visible de Blender toutes les 2 s tant que le panneau est affiché, et espace les essais (jusqu’à 30 s) tant que la fenêtre est introuvable. Le nom est celui que macOS donne à l’app (Finder, Blender, Godot, Unity, krita). Les apps de ton `cockpit.json` qui ont un `"window"` sont capturées une fois après que Claude a travaillé avec elles, sans `watch`.

La capture de fenêtre demande l’autorisation d’enregistrement de l’écran. Sans elle, l’écran affiche « Window capture needs Screen Recording permission for Claude (System Settings › Privacy & Security › Screen Recording) » et le suivi s’arrête ; accorde-la, relance l’app, puis refais `/cockpit watch <App>`.

## Apps

Le cockpit connaît Unity, Unreal Engine, Godot, Blender, FreeCAD, OpenSCAD, KiCad, les navigateurs (Claude Browser, Claude in Chrome, Playwright), le simulateur iOS et Android. Un appel est reconnu à son serveur MCP (`mcp__blender__...`), à sa commande (`blender -b ...`, `godot --export-release`, `Unity -batchmode`, `UnrealEditor-Cmd`, `openscad`, `freecadcmd`, `kicad-cli`, `xcrun simctl`, `adb`) ou à l’extension de son fichier (`.blend`, `.tscn`, `.gd`, `.unity`, `.uasset`, `.FCStd`, `.scad`, `.kicad_pcb`…).

Ajoute tes apps, ou modifie une app intégrée (même `id`), dans `~/.claude/cockpit.json` (tous tes projets) ou `<projet>/.cockpit.json` (ce projet ; il l’emporte). Les deux sont lus au démarrage de la session.

```json
{
  "apps": [
    {
      "id": "krita",
      "name": "Krita",
      "color": "#3bacd4",
      "glyph": "K",
      "match": {
        "mcp": "krita",
        "command": "(^|[\\s/])krita(\\s|$)",
        "files": [".kra"]
      },
      "screenshot": { "tool": "get_canvas_image", "args": {} },
      "window": "krita"
    }
  ]
}
```

| Champ | Sens |
|---|---|
| `name` | Obligatoire. Affiché sur le badge et dans la légende de l’écran. |
| `id` | Facultatif ; par défaut le nom en minuscules. L’id d’une app intégrée (`blender`, `godot`, `unity`, `unreal`, `freecad`, `openscad`, `kicad`…) la remplace. |
| `color` | `#rgb` ou `#rrggbb`. |
| `glyph` | Jusqu’à 3 caractères, dessinés dans la vignette de l’app. |
| `match.mcp` | Expression régulière (insensible à la casse) sur la partie serveur de `mcp__<serveur>__<outil>`. |
| `match.command` | Expression régulière (insensible à la casse) sur une commande Bash. |
| `match.files` | Extensions de fichiers, avec leur point. |
| `screenshot` | L’outil MCP du même serveur qui renvoie une image : un nom d’outil, ou une expression régulière sur les noms d’outils ; `args` lui est passé. |
| `window` | Le nom de l’app macOS dont le cockpit peut capturer la fenêtre. |

Les expressions régulières sont des chaînes JSON : une barre oblique inverse s’écrit deux fois. Une entrée sans nom, avec un motif invalide ou sans rien à reconnaître est ignorée.

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

Le cockpit garde 300 appels, 200 fichiers (12 changements par fichier), 150 agents et 20 runs de workflow. Les sorties sont coupées à environ 4 000 caractères, les commandes à 4 000 et les diffs à 12 000 (un diff déplié affiche 600 lignes au plus). Il garde six images d’écran au plus, une par source (un simulateur, un émulateur, une fenêtre, un onglet de navigateur, un serveur MCP, un fichier image) : une nouvelle image remplace la précédente de la même source, et au-delà de six la plus ancienne part, jamais un appareil suivi par Live (un fichier image est lu tel quel jusqu’à environ 90 Ko, au-delà il est réduit avec `sips`). Un `/clear` remet tout à zéro, sauf l’onglet choisi, Live et le suivi de fenêtre.
