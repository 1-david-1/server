# Last Bell – Koop-Mehrspieler & Sprachchat

Dieses Paket erweitert dein Spiel um einen **Koop-Modus für 2–4 Spieler** mit **Sprachchat** und der **CrazyGames-Multiplayer-Anbindung** (Room Data, Instant Multiplayer, Einladungslink).
Der Einzelspieler ist ohne Käufe im Schulkiosk unverändert (die Lehrer-KI verhält sich im Einzelspieler Tick für Tick identisch zum Original – das ist automatisch gegengeprüft).

Es gibt zwei Teile:

| Datei | Was es ist |
|---|---|
| `last_bell_crazygames_multiplayer.zip` | Das Spiel (`index.html`, wie dein Original, nur mit Mehrspieler). Das lädst du bei CrazyGames hoch. |
| `last_bell_multiplayer_server.zip` | Der kleine **Relay-Server** (`server.js`, dazu `chatfilter.js` für die Chat-Moderation und `friends.js` für die Freunde). Den musst du selbst betreiben – CrazyGames stellt laut FAQ keinen Multiplayer-Server bereit. **Alle drei Dateien müssen zusammen hochgeladen werden.** |

---

## 1. Schnell testen (auf deinem Rechner, 5 Minuten)

Du brauchst [Node.js](https://nodejs.org) (ab Version 18).

```bash
# Terminal 1: Server starten (keine Installation nötig, keine Abhängigkeiten)
cd server
node server.js                # läuft auf Port 8080

# Terminal 2: Spiel ausliefern (Mikrofon geht nur über localhost oder https)
cd spielordner                # dort liegt index.html
python3 -m http.server 8000
```

Dann in **zwei Browserfenstern** öffnen:
`http://localhost:8000/?mpserver=ws://localhost:8080`
→ Fenster 1: **Mehrspieler (Koop)** → *Neuen Raum erstellen*. Fenster 2: **Mehrspieler** → Code eingeben → *Beitreten*.

Mit `?mpserver=…` kannst du den Server testweise überschreiben, `?room=ABCD` tritt direkt einem Raum bei.

---

## 2. Server veröffentlichen

CrazyGames-Seiten laufen über https, deshalb muss dein Server über **`wss://`** (TLS) erreichbar sein. Alle folgenden Anbieter liefern TLS automatisch:

**Render.com** (einfach, Gratis-Tarif schläft nach Inaktivität ein)
1. Die Dateien aus `last_bell_multiplayer_server.zip` (`server.js`, `package.json`, `Dockerfile`, …) direkt in ein neues GitHub-Repository legen (nicht in einen Unterordner).
2. Render → *New → Web Service* → *Build and deploy from a Git repository* → Repository wählen.
3. Weil ein `Dockerfile` im Repository liegt, wählt Render automatisch die **Docker**-Variante. Dort gibt es **kein** Feld „Start Command“, und das ist richtig so: Das Dockerfile startet den Server selbst und setzt `TRUST_PROXY=1` schon. Du musst nur den Instance Type (Free) wählen und *Create Web Service* klicken.
   *Alternative ohne Docker:* als Language **Node** wählen, Build Command `npm install`, Start Command `node server.js` und unter Environment Variables `TRUST_PROXY` = `1` eintragen.
4. Deine Adresse steht danach oben auf der Seite des Dienstes (`https://dein-name.onrender.com`). Im Spiel wird daraus `wss://dein-name.onrender.com`.
Das Spiel „weckt“ den Server automatisch, sobald die Lobby geöffnet wird. Für einen Dauerbetrieb ohne Wartezeit nimm einen bezahlten Tarif.

**Fly.io**: im Ordner `server`: `fly launch` (erkennt das Dockerfile, interner Port 8080), danach `fly deploy`. Adresse: `wss://dein-app-name.fly.dev`.

**Railway**: Repository verbinden, Start Command `node server.js`, `TRUST_PROXY=1` setzen.

**Eigener Server (VPS)**: `node server.js` im Hintergrund laufen lassen (z. B. mit `pm2` oder systemd) und davor einen TLS-Proxy, z. B. Caddy:
`caddy reverse-proxy --from mp.deine-domain.de --to localhost:8080` (Caddy holt das Zertifikat selbst und unterstützt WebSockets). Dann `TRUST_PROXY=1` setzen.

**Docker**: `docker build -t lastbell-mp .` und `docker run -p 8080:8080 lastbell-mp` (das Dockerfile setzt `TRUST_PROXY=1`).

Die Gesundheitsprüfung liegt unter `https://deine-adresse/health` (zeigt Räume und Spieler).

### Server-Einstellungen (Umgebungsvariablen, alle optional)
| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | 8080 | Port (Hosting-Anbieter setzen ihn meist selbst) |
| `TRUST_PROXY` | – | `1` = echte Spieler-IP aus `X-Forwarded-For` lesen. **Hinter Render/Fly/Caddy/nginx setzen**, sonst zählen alle Spieler als eine IP. |
| `MAX_PLAYERS` | 4 | Spieler pro Raum (2–8) |
| `ALLOWED_ORIGINS` | `*` | Wer sich verbinden darf, z. B. `https://*.crazygames.com,https://meine-seite.de`. Prüfe im Browser (Entwicklertools → Netzwerk → WebSocket → Header `Origin`), von welcher Adresse dein Spiel bei CrazyGames wirklich lädt, bevor du das einschränkst. |
| `MAX_CONN_PER_IP` | 30 | gleichzeitige Verbindungen pro IP (Schulen/WLANs teilen sich IPs) |
| `MAX_ROOMS` | 5000 | Obergrenze für Räume |
| `HOST_STALL_MS` | 6000 | so lange darf der Host während einer Runde schweigen, bevor ein anderer Spieler übernimmt |
| `CHAT` | an | `0` = Text-Chat komplett aus (der Server meldet ihn dann gar nicht an, die Chat-Karte verschwindet im Spiel) |
| `CHAT_DEFAULT` | `text` | Modus neuer Räume: `text` (gefilterte Freitext-Nachrichten), `quick` (nur Schnell-Nachrichten) oder `off`. Der Host kann ihn in der Lobby ändern. **Für ein junges Publikum ist `quick` die sicherste Wahl.** |
| `CHAT_MAX_LEN` | 120 | maximale Länge einer Nachricht |
| `CHAT_MIN_GAP_MS` / `CHAT_BURST` / `CHAT_WINDOW_MS` | 800 / 6 / 10000 | Mindestabstand zwischen zwei Nachrichten; höchstens `CHAT_BURST` Nachrichten pro `CHAT_WINDOW_MS` |
| `CHAT_STRIKES` | 4 | Verstoßpunkte bis zur Stummschaltung (milde Wörter 0, Schimpfwort 1, Hass/Mobbing 2, Link/Kontaktdaten 1, Spam 0,25; ein Punkt verfällt pro Minute, `CHAT_STRIKE_DECAY_MS`) |
| `CHAT_MUTE1_MS` / `CHAT_MUTE2_MS` | 60000 / 180000 | Dauer der 1. und 2. Stummschaltung; die 3. gilt für den Rest des Aufenthalts |
| `CHAT_IP_PENALTY_MS` | 900000 | Wer „für immer“ stummgeschaltet wurde, bleibt es so lange auch nach einem Neubeitritt (gleiche IP). `0` = aus. Vorsicht bei Schul-WLANs: dort teilen sich viele eine IP, deshalb gilt die Sperre nur nach der 3. Stummschaltung und nur 15 Minuten. |
| `CHAT_REPORTS_TO_MUTE` / `CHAT_REPORT_MUTE_MS` | 2 / 300000 | so viele *verschiedene* Spieler müssen jemanden melden, damit er automatisch für die angegebene Zeit stumm ist |
| `CHAT_EXTRA_WORDS` / `CHAT_ALLOW_WORDS` | – | eigene Wörter, durch Komma getrennt: zusätzlich sperren (wird durch *** ersetzt) bzw. nie sperren |
| `CHAT_BLOCK_CONTACTS` | an | `0` = Links, Telefonnummern, E-Mail-Adressen und Messenger-Namen im Chat erlauben (nicht empfohlen) |
| `FRIENDS` | an | `0` = Freunde komplett aus (der Server beantwortet jede Freunde-Nachricht mit „aus“, das Spiel zeigt „Auf diesem Server sind Freunde aus“) |
| `FRIENDS_MAX` / `FRIENDS_MAX_ONLINE` | 30 / 20000 | Freunde pro Spieler / wie viele Spieler gleichzeitig mit Freundes-ID online sein dürfen (Arbeitsspeicher-Schutz) |
| `FRIENDS_BURST` / `FRIENDS_RATE_PER_SEC` | 20 / 2 | Flutschutz für Freunde-Nachrichten pro Verbindung |
| `FRIEND_REQ_GAP_MS` / `FRIEND_INVITE_GAP_MS` | 60000 / 5000 | frühestens alle 60 s eine Anfrage von A an B; frühestens alle 5 s eine Einladung von A an B |

---

## 3. Spiel konfigurieren

Öffne `index.html` in einem Texteditor (z. B. VS Code) und suche nach **`window.LASTBELL_MP`**. Dort steht (neu: `chat: false` schaltet den Text-Chat in der Lobby komplett ab, so wie `voice: false` den Sprachchat):

```js
window.LASTBELL_MP = {
  server: '',        // ← hier DEINE Adresse eintragen, z. B. 'wss://dein-name.onrender.com'
  voice: true,       // false = Sprachchat komplett abschalten
  iceServers: null   // null = nur Google-STUN. Für strenge Firewalls: TURN-Server eintragen (siehe Abschnitt 6)
};
```

Solange `server` leer ist, zeigt die Lobby den Hinweis „Kein Multiplayer-Server eingestellt“, das Spiel selbst läuft normal.
(Du kannst mir die Adresse auch einfach schicken, dann trage ich sie ein.)

---

## 4. So spielt sich der Koop-Modus

* **Raum**: Ein Spieler erstellt einen Raum (4-stelliger Code und Einladungslink), die anderen treten bei. Der **Host (👑)** wählt Tag und Schwierigkeit und startet die Runde. Spieler können auch **mitten in einer laufenden Runde** beitreten.
* **Gleiche Schule, gleiche Lehrer**: Die Lehrer verfolgen den Spieler, den sie sehen (bei mehreren den deutlicheren, und sie bleiben bei ihrem Ziel). Wer gefangen wird, ist 2,6 s erstarrt und startet dann wieder im Nachsitzraum. Nur der fangende Lehrer geht zurück auf seine Runde.
* **Gemeinsame Verwarnungen**: Das Team hat so viele Verwarnungen wie im Einzelspieler **+2 pro zusätzlichem Spieler**. Sind sie aufgebraucht, ist die Runde für alle verloren.
* **Gemeinsame Gegenstände**: Wer einen Gegenstand aufsammelt, hat ihn für alle erledigt. Die Taschenlampe bekommen dann alle. Türen sind für alle gleich offen oder zu, Geräusche locken Lehrer zu dem, der sie macht.
* **Ausgang**: Die Runde ist gewonnen, wenn **jeder Spieler** im Raum draußen ist. Wer zuerst draußen ist, wartet (und ist für Lehrer unsichtbar).
* **Team-Pause**: Wer das Menü öffnet (Menü-Knopf, `P` oder `Esc`), pausiert das Spiel **für alle** (Lehrer, Uhr und Fang-Zeiten stehen still). Im Pause-Menü steht, wer pausiert hat. **Jeder** Spieler kann mit dem Knopf **„▶ Weiter“** (auf dem Handy per Tippen) für alle fortsetzen. Der Sprachchat läuft in der Pause weiter. Ein Wechsel auf einen anderen Tab oder ein anderes Fenster pausiert bewusst *nicht* automatisch, sonst würde ein versehentlicher Wechsel alle anhalten.
* **Gleiche Voraussetzungen**: Im Mehrspieler zählen für alle die Grundwerte (keine Belohnungs-Perks), und es gibt keine Sterne/Pfad-Fortschritte. Der Einzelspieler-Fortschritt bleibt unberührt.
* **Namen**: CrazyGames-Benutzername, sonst ein zufälliger harmloser Name (🎲 zum Neuwürfeln). Es gibt bewusst **keine freie Texteingabe**, damit keine Namensmoderation nötig ist.
* **Host verlässt das Spiel**: Verlässt der Ersteller/Host die Runde (Raum verlassen, „Zur Lobby“ oder Tab schließen), **kommen alle anderen zurück in die Lobby** (mit einem gelben Hinweis oben) und der dienstälteste Spieler wird neuer Host. Verlässt nur ein normaler Mitspieler die Runde, läuft sie für die anderen weiter.
* **Host hängt** (Tab eingefroren, ohne dass er das Spiel verlassen hat): Der Server ernennt automatisch einen neuen Host, dessen Browser übernimmt die Lehrer nahtlos.
* **Einladungslink**: In der Lobby gibt es den Raumcode, den Link in einem markierbaren Feld und Knöpfe zum Kopieren. Die Bestätigung („✓ kopiert“) erscheint direkt in der Lobby. Sperrt der Browser das automatische Kopieren, wird der Link markiert, dann Strg+C / Cmd+C. Ein Freund, der den Link öffnet, tritt dem Raum automatisch bei.

---

## 5. Sprachchat

* **Hören ist automatisch, Sprechen ist freiwillig**: Sobald ein Spieler einen Raum betritt, hört er seine Mitspieler (🔊), ohne etwas anklicken zu müssen und **ohne dass der Browser nach dem Mikrofon fragt**. Zum Sprechen schaltet jeder das **Mikrofon** (🎙) selbst ein, erst dann fragt der Browser. Man kann das Hören auch ausschalten (🔇).
* **Datenschutz**: Die Audioverbindung läuft **direkt zwischen den Mitspielern** (WebRTC), dabei sehen sie sich gegenseitig die IP-Adresse. Das steht in der Lobby. Es gibt keine Verbindung zu Leuten außerhalb des Raums.
* **Bedienung**: Standard ist **Mikro immer offen**, alternativ **Push-to-talk (Taste `V` halten, auf dem Handy der „Halten“-Knopf)**. Lautstärke-Regler, pro Spieler stummschalten (🔈/🔕 in der Spielerliste), optional **„Nur Spieler in der Nähe laut hören“** (Stimmen werden mit Entfernung leiser und kommen von links/rechts).
* **Stabilität**: Bricht eine Sprachverbindung ab, versucht das Spiel erst einen ICE-Neustart und baut sie sonst selbst neu auf (mehrere Versuche mit wachsenden Pausen). Der Audio-Kontext des Browsers wird bei jeder Eingabe wieder aufgeweckt.
* **„Ton aus“** im Spiel und die CrazyGames-Stummschaltung schalten auch den Sprachchat stumm.

---

## 5a. Text-Chat in der Lobby (moderiert)

In der Lobby gibt es eine Chat-Karte (unter Start-Knopf und Spielerliste). Während einer Runde gibt es bewusst keinen Chat. **Die gesamte Moderation entscheidet der Server** (`server.js` + `chatfilter.js`), nicht das Spiel im Browser. Ein veränderter Client kann sie deshalb nicht umgehen.

**Was Spieler sehen und können**
* **Nachrichten schreiben** (höchstens 120 Zeichen) oder **Schnell-Nachrichten** mit einem Klick (⚡, z. B. „Bereit? ✅“, „Gutes Spiel! 🎉“). Schnell-Nachrichten werden bei jedem Leser **in dessen Sprache** angezeigt und enthalten nur vorgegebene Texte.
* **„Chat ausschalten“**: Wer das wählt, sieht keine Nachrichten und kann keine schreiben (der Server liefert dann auch nichts mehr an ihn aus). Die Wahl wird gemerkt.
* **🙈 pro Nachricht / Spielerliste**: blendet einen Spieler nur für mich aus (vom Server durchgesetzt, in der Spielerliste mit 👀 wieder einblendbar; nicht zu verwechseln mit dem 🔕 des Sprachchats). **🚩 pro Nachricht**: meldet einen Spieler.
* Wird jemand stumm geschaltet, steht ein Hinweis im Chat (🤐 in der Spielerliste) und er sieht, warum und wie lange.

**Was der Host kann**
* **Chat-Modus für den Raum**: *Text* (gefiltert) · *Schnell-Nachrichten* (nur Vorgaben) · *Aus*. Alle im Raum sehen die Änderung.
* **„Chat stumm“ / „Chat an“** pro Spieler. Die Rolle Host selbst kann nicht stumm geschaltet werden (wer Host wird, wird automatisch entstummt). Automatische Stummschaltungen (siehe unten) kann der Host **nicht** aufheben, sonst ließe sich die Moderation mit einem befreundeten Host umgehen.

**Was der Server prüft (in dieser Reihenfolge)**
1. Chat im Raum an? Chat des Absenders an? Absender nicht stumm?
2. **Tempolimit**: mindestens 0,8 s Abstand, höchstens 6 Nachrichten pro 10 s; dieselbe Nachricht nicht zweimal hintereinander.
3. **Filter** (`chatfilter.js`), auf Deutsch und Englisch:
   * *Schimpfwörter und Ähnliches* werden durch `***` ersetzt, die Nachricht kommt trotzdem an.
   * *Hass, Beleidigungen von Gruppen, „kill yourself“ / „geh sterben“, sexuelle Anmache* → Nachricht wird **gar nicht gesendet**, der Absender bekommt eine Erklärung.
   * *Links, E-Mail-Adressen, @Namen, Telefonnummern, Messenger-Namen (Discord, Snapchat, WhatsApp …)* → **nicht gesendet** (Schutz davor, dass Kinder aus dem Spiel heraus gelockt werden).
   * Erkennt auch Tricks: Groß-/Kleinschreibung, Umlaute, `sch31sse`, `$hit`, `fuuuuck`, `f u c k`, `f.u.c.k`, kyrillische Ähnlich-Buchstaben, Vollbreite-Zeichen, unsichtbare Zeichen. Es werden **ganze Wörter** verglichen: „Marsch“, „Klassenzimmer“ oder „Scunthorpe“ bleiben unberührt.
   * GROSSSCHREIBUNG wird normalisiert, `aaaaaaaa` auf `aaa` gekürzt.
   * **Auch Spielernamen** laufen durch den Wortfilter (z. B. ein CrazyGames-Name, der nicht passt, wird zu „Spieler“).
4. **Verstoßpunkte** → **Stummschaltung**: 4 Punkte = 1 Minute stumm, dann 3 Minuten, beim dritten Mal für den Rest des Aufenthalts (und 15 Minuten auch nach Neubeitritt). Punkte verfallen mit der Zeit.
5. **Meldungen**: Melden zwei verschiedene Spieler denselben Spieler, ist er 5 Minuten stumm. **Jede Meldung steht im Server-Log** (siehe Datenschutz).

**Wie gut ist der Filter?** Er ist eine erste Schutzschicht und **nicht lückenlos**: Neue Umschreibungen, Fremdsprachen und Wortspiele rutschen durch. Deshalb gibt es zusätzlich Tempolimit, Stummschaltung, Melden, Ausblenden, Host-Kontrolle und den Modus *Schnell-Nachrichten*. Die Wortlisten stehen am Anfang von `chatfilter.js` und sind leicht zu ergänzen, ohne Code zu ändern über `CHAT_EXTRA_WORDS` / `CHAT_ALLOW_WORDS`. CrazyGames stellt eine Liste zu sperrender Wörter bereit: trage sie dort ein.

**Datenschutz (bitte in deine Hinweise aufnehmen)**: Chat-Nachrichten werden **nicht gespeichert**. Der Server hält pro Raum nur die letzten 40 Nachrichten im Arbeitsspeicher, damit er bei einer Meldung Belege hat, und wirft sie weg, sobald der Raum schließt. **Nur bei einer Meldung** schreibt er in sein Log (stdout): Raum, Name und Nummer von Melder und Gemeldetem und dessen letzte 5 Nachrichten. Bei jeder automatischen Stummschaltung steht ebenfalls eine Zeile im Log (ohne Nachrichtentext). IP-Adressen werden nur für die kurze Sperre nach einer dauerhaften Stummschaltung im Arbeitsspeicher gehalten.

**CrazyGames `disableChat`**: Ist die Einstellung an (live oder beim Start, zum Testen auch mit `?disableChat=true` in der Adresse), verschwindet die Chat-Karte komplett, es werden keine Nachrichten gezeigt, gespeichert oder gesendet, und der Server liefert nichts mehr an diesen Spieler aus.

---

## 5b. Freunde

**So funktioniert es für Spieler:** Mehrspieler-Bildschirm → Karte **„Freunde“** → *Freunde einschalten* (erst dann entsteht eine Freundes-ID und der Browser meldet sich am Server an). Die **Freundes-ID** (z. B. `K7Q2M-9XDRA`) gibt man Menschen, denen man vertraut (am besten außerhalb des Spiels). Der Freund trägt sie ein, **und ihr müsst euch beide hinzufügen**. Dann seht ihr gegenseitig *online / in einer Lobby / im Spiel* (mit Titel), könnt per **Beitreten** direkt in seinen offenen Raum und aus einem Raum heraus per **Einladen** Freunde einladen. Wer dich hinzufügt, während du online bist, löst bei dir die Anfrage „möchte dein Freund sein“ aus: *Annehmen* fügt ihn hinzu, *Ablehnen* blockiert den Absender. Freunde sind nur online, solange der Mehrspieler-Bildschirm offen ist oder man in einem Raum sitzt.

**Technik (kein Konto, keine Datenbank)**
* Die ID ist der Hash eines **öffentlichen Schlüssels (ECDSA P-256), den der Browser selbst erzeugt**. Zum Anmelden **signiert** der Browser eine Zufallsfrage des Servers mit dem geheimen Schlüssel (der den Browser nie verlässt). Niemand kann sich also als eine fremde ID ausgeben, auch nicht, wenn er sie kennt. Datei: `friends.js` (Server) und `friends.js`-Block im Spiel.
* Der Schlüssel und die Freundesliste liegen **nur in diesem Browser** (`localStorage`, Eintrag `lastbell.friends`), **nicht** im CrazyGames-Cloud-Spielstand. Folge: Freunde sind an Gerät und Browser gebunden. Wer Browserdaten löscht, hat eine neue ID und muss seine Freunde neu hinzufügen. Öffnet jemand das Spiel in einem zweiten Tab, übernimmt der neueste Tab (der alte zeigt „Läuft in einem anderen Tab“).
* Der Server hält **nur im Arbeitsspeicher**: wer online ist, die ID-Liste, die der Spieler schickt, seinen Namen und seinen Raum. **Nichts wird gespeichert oder geloggt.**

**Schutz vor Missbrauch**
* Den Status (online, Raum, Name, Titel) sieht nur, wer **gegenseitig** befreundet ist. IDs lassen sich weder suchen noch auflisten, und ein Server-Test prüft, dass ohne Gegenseitigkeit nichts durchsickert.
* Anfragen gehen nur an Spieler, die gerade online sind (oder kommen an, sobald beide online sind), höchstens 1 pro Minute und Paar; Namen laufen durch den Wortfilter. *Ablehnen* blockiert den Absender auch serverseitig. Einladungen nur unter Freunden, nur aus einem offenen Raum, höchstens alle 5 Sekunden.
* **Grenzen, ehrlich gesagt:** Wer deine ID kennt, kann dir Anfragen schicken (bis du blockierst oder Freunde ausschaltest). Die ID hat bewusst nur 10 Zeichen (50 Bit), damit man sie abtippen kann; eine fremde ID gezielt nachzubauen wäre extrem aufwendig, ist aber theoretisch kein Ding der Unmöglichkeit. Für ein Spiel ist das vertretbar; wer es strenger will, verlängert die ID (in beiden `friends.js` die `10` und `PID_RE` anpassen).
* Ein Server **ohne** `friends.js` (alte Version) wird erkannt: Das Spiel zeigt nach wenigen Sekunden „Auf diesem Server sind Freunde aus“ und versucht nichts weiter.

---

## 5c. Schulkiosk: Taschengeld & Shop

Im Startmenü gibt es **🛒 Schulkiosk** (mit dem Guthaben). **Taschengeld** gibt es nur durch Spielen, nach **jeder Runde** (Einzelspieler und Koop; das Tutorial zahlt nichts; höchstens einmal pro Runde). Es lässt sich nicht kaufen.

| Auszahlung | Betrag |
|---|---|
| Stufe geschafft | 25 (Stufe 1) bis 55 (Stufe 7) + 10 pro Stern (Koop: Stern für „geschafft“ und für „schnell genug“) |
| Zum ersten Mal geschafft (nur Einzelspieler) | + 40 |
| Verloren | 6 + 1 pro 20 Sekunden Überlebenszeit (höchstens + 14) |
| Schwierigkeit | × 0,8 (leicht) · × 1 · × 1,25 (schwer) |
| Koop | × 1,15 / × 1,3 / × 1,45 bei 2 / 3 / 4 Spielern |

Auf dem Sieg- bzw. Game-Over-Bildschirm steht „🪙 +57 Taschengeld“ mit kurzer Aufschlüsselung.

| Was | Wirkung | Preise |
|---|---|---|
| 🧽 Radiergummi-Päckchen | + 1 Radiergummi zu Beginn jeder Stufe (je Stufe) | 70 / 140 / 250 |
| 🔍 Lampen-Linse | Taschenlampe leuchtet 10 % weiter (je Stufe) | 120 / 220 |
| 🍫 Energie-Riegel | Ausdauer lädt 10 % schneller (je Stufe) | 100 / 200 |
| 👟 Gummisohlen | leisere Schritte (Untergrenze 1,0) | 110 / 220 |
| 🗺 Schulplan | Hinweis-Pfeil 10 s früher (je Stufe) | 90 / 180 |
| 8 Titel (📚 Streber, 🤡 Klassenclown, 🥷 Schulhof-Ninja, 🦉 Nachteule, 🥪 Pausenbrot-Profi, ✏️ Bleistift-Held, 🌟 Klassenbester, 👻 Schulgespenst) | steht in der Mehrspieler-Lobby neben dem Namen; der erste gekaufte wird gleich angelegt | 40 bis 200 |
| 🎉 Spaß-Paket | 6 zusätzliche Schnell-Nachrichten im Lobby-Chat | 80 |

* **Verbesserungen gelten nur im Einzelspieler.** Im Koop haben alle die Grundwerte wie vorher (so bleibt es fair). Ohne Käufe ist der Einzelspieler exakt wie zuvor.
* **Speicherung:** im normalen Spielstand (`lastbell.v1`), also auch im CrazyGames-Cloud-Spielstand. Das Guthaben wird aus „insgesamt verdient − Preis aller Käufe“ berechnet. Dadurch gibt es beim Abgleich zweier Geräte keine Konflikte (von jeder Zahl gewinnt die größere; nichts geht verloren). **„Fortschritt löschen“ löscht auch Taschengeld und Käufe.**
* **Kein Echtgeld:** Laut CrazyGames-Anforderungen sind Käufe mit echtem Geld nur über deren Partner (Xsolla, nur auf Einladung) möglich. Der Kiosk kommt deshalb komplett ohne aus.
* **Anpassen:** Preise und Wirkungen stehen oben im `shop.js`-Block in `index.html` (`ITEMS`), die Auszahlung in `payout()`. **Die Reihenfolge der Titel darf nie geändert werden** (der Index wird an andere Spieler gesendet; Server `TITLE_COUNT` = 8), ebenso die Nummern der Schnell-Nachrichten (0–17, Server `QUICK_COUNT`). Ändert man Preise, ändert sich das Guthaben bestehender Spieler rückwirkend, weil es berechnet wird.

---

## 5d. Rechtliches: Datenschutz & Nutzungsbedingungen im Spiel

**Anforderung:** Sammelt ein Spiel über die Ereignisse des CrazyGames-SDK hinaus personenbezogene Daten (hier: Mehrspieler, Chat, Freunde), soll es neuen Spielern einen Hinweis auf Terms & Conditions und/oder Privacy Policy zeigen. CrazyGames empfiehlt einen schlichten Hinweis statt eines blockierenden Pop-ups, und Links dorthin sind von der Regel „keine externen Links“ ausgenommen (Doku: *Requirements → Introduction / Technical, Abschnitt „User Consent“*).

**Umsetzung:**
* **Hinweis-Leiste** am unteren Rand des Startmenüs für neue Spieler (blockiert nichts, „OK“ wird gemerkt) mit Links zu beiden Texten.
* **Dauerhafte Links**: im Fuß des Startmenüs, in den **Einstellungen** (zwei Knöpfe) und in der **Mehrspieler-Lobby** (mit dem Satz, dass Name, Chat und IP-Adresse an den Spielserver gehen).
* Beide Texte (Deutsch und Englisch) stehen **im Spiel** und beschreiben, was das Spiel wirklich tut: lokaler Spielstand, CrazyGames-Cloud-Spielstand, Mehrspieler (IP, Name, Chat, Meldungen, Sprachchat direkt zwischen Spielern, Google-STUN), Freunde, Hosting, Rechte.

**Das musst du ausfüllen** (`window.LASTBELL_LEGAL` in `index.html`, direkt unter `LASTBELL_MP`): `operator` (wer das Spiel betreibt), `contact` (E-Mail für Datenschutzanfragen), `host` (wer den Server hostet, z. B. Render), optional `server`, `retentionDays` (wie lange du das Server-Log mit Meldungen aufbewahrst: **diese Frist musst du dann auch einhalten**, also das Log entsprechend löschen) und `updated`. Ohne Angaben steht dort „der Entwickler dieses Spiels, Kontakt über die Spielseite auf CrazyGames“. Hast du eigene Seiten, trage `privacyUrl` / `termsUrl` ein: Das Spiel öffnet dann diese in einem neuen Tab statt des eingebauten Textes.

**Wichtig:** Die Texte sind für dieses Spiel geschrieben, aber **keine Rechtsberatung**. Lass sie für deine Situation prüfen (Betreiber, Land, Zielgruppe, Impressumspflicht). Ändert sich der Datenumgang (z. B. neuer Hoster, Werbung, Analyse), musst du die Texte anpassen.

---

## 6. CrazyGames – Checkliste

Quellen: CrazyGames-Dokumentation *Multiplayer requirements*, *Technical requirements* (User Consent, Data-Modul, In-Game-Käufe), *Room data*, *FAQ* (Stand heute geprüft). Die Multiplayer-Seiten tragen dort selbst den Hinweis, dass Anforderungen und SDK sich noch ändern können. Schau vor dem Einreichen nochmal rein.

| Anforderung | Umsetzung |
|---|---|
| Eigener Server nötig | Relay-Server liegt bei (`server/`). Erwähne beim Einreichen, dass das Spiel sich mit deinem Server (Domain) verbindet. |
| **Room Data** (`updateRoom` / `leftRoom`) | Wird bei Raum-Betreten/-Verlassen und bei Änderungen gemeldet, `isJoinable` = Raum offen und nicht voll, `inviteParams = { room: CODE }`. |
| **Instant Multiplayer** (`isInstantMultiplayer`) | Das Spiel springt direkt in einen frischen privaten Raum (Lobby, Host wählt Tag/Schwierigkeit). |
| Beitreten über Einladung / `addJoinRoomListener` | Wird unterstützt, auch während das Spiel schon läuft (ohne Seite neu zu laden). |
| Einladungslink | „Einladungslink kopieren“ nutzt `inviteLink`, außerhalb von CrazyGames ein eigener `?room=`-Link. |
| CrazyGames-Benutzername anzeigen | Wird über `user.getUser()` geholt (nie ein erzwungener Login, Gastspiel geht immer). |
| Lobbygröße | Beim Einreichen **4** angeben. |
| Chat abschaltbar (`settings.disableChat`) | Wird gelesen und live beachtet: Dann sind **Text-Chat** (Karte weg, nichts gezeigt, gesendet oder empfangen) und Sprachchat samt Bedienung weg. Zum Testen: `?disableChat=true`. |
| Chat-Moderation | **Text-Chat**: Wortfilter auf dem Server, Tempolimit, automatische Stummschaltung, Melden, Ausblenden, Host-Kontrolle, Modus „nur Schnell-Nachrichten“ (Abschnitt 5a). **Sprachchat lässt sich technisch nicht filtern**, siehe unten. |
| Datenschutz / Terms & Conditions | Hinweis für neue Spieler, Links im Menü, in den Einstellungen und in der Lobby, Texte DE/EN im Spiel (Abschnitt 5d). **Du musst `LASTBELL_LEGAL` ausfüllen und die Texte prüfen lassen.** Auch die IP-Weitergabe beim Sprachchat steht dort. |
| Käufe im Spiel | Nur Spielgeld, das man durch Spielen verdient (Schulkiosk, Abschnitt 5c). Kein Echtgeld, keine Werbung gegen Geld. |
| Freunde | Eigene Freundes-ID ohne Konto, Anzeige nur bei gegenseitigem Hinzufügen, einschaltbar und ausschaltbar (Abschnitt 5b). |

**Wichtig zum Sprachchat auf CrazyGames – bitte vor dem Einreichen klären:**
1. Ich konnte in der CrazyGames-Doku **nichts finden, das bestätigt, dass die Einbettung (iframe) dem Spiel Mikrofon-Zugriff erlaubt**. Ohne das Attribut `allow="microphone"` am iframe blockiert der Browser das Mikrofon. Das Spiel erkennt das, zeigt eine verständliche Meldung und lässt die Spieler weiter **zuhören und spielen**. Frag am besten kurz beim CrazyGames-Support nach, bevor du Sprachchat als Feature bewirbst.
2. CrazyGames verlangt für Chat Moderation (mindestens einen Profanity-Filter) und kann Chat bei Beschwerden abschalten lassen. Beim Text-Chat gibt es den Filter (5a), beim Sprachchat nicht. Plane daher ein, dass CrazyGames Sprachchat ablehnen kann. **Dann reicht ein Wort in der Konfiguration: `voice: false`** und der Koop-Modus bleibt ohne Sprachchat komplett erhalten.
3. **TURN-Server**: Mit dem Standard (nur STUN) klappt die Sprachverbindung bei den meisten, aber nicht bei Spielern hinter sehr strengen Firewalls/Mobilfunk-NAT. Dafür trägst du bei `iceServers` einen TURN-Server ein, z. B. `[{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'turn:turn.meinserver.de:3478', username: '…', credential: '…' }]` (eigener coturn oder ein Anbieter). Der Rest des Spiels (Server-Verbindung per WebSocket) ist davon nicht betroffen.

---

## 7. Technik & Grenzen

* **Aufbau**: Jeder Spieler bewegt sich selbst. Der **Host-Browser** rechnet zusätzlich die Lehrer-KI für alle (mit allen Spielern als Zielen) und schickt Lehrer/Schüler 12× pro Sekunde an die anderen, die sie weich nachzeichnen. Weil die Schule pro Wochentag fest ist (gleicher Seed), müssen nur Aufnahmen, Türen, Geräusche, Verwarnungen und „wer ist draußen“ übertragen werden. Der Server rechnet nichts, er leitet nur weiter und beobachtet den Host.
* **Dateien im Spiel**: `net.js` (Verbindung, auch die Chat-Nachrichten), `voice.js` (Sprachchat), `multiplayer.js` (Lobby inkl. Chat- und Freunde-Karte, Synchronisation, CrazyGames), `friends.js` (Freundes-ID und Protokoll), `shop.js` / `shopui.js` (Taschengeld, Kiosk), `legal.js` (Datenschutz und Nutzungsbedingungen), dazu kleine, markierte Haken (`if (MP.on)`) in `main.js`, `stealth.js`, `crazygames.js`, `audio.js`, `figures.js`.
* **Grenzen**: Wer die Verbindung verliert, landet im Menü und muss neu beitreten (kein automatisches Wiederverbinden). Der Host ist vertrauenswürdig: Wer Host ist, könnte theoretisch schummeln (Koop-Spiel, kein Wettkampf). Nachrichten, die nur der Host senden darf (Lehrer, Fangen, Sieg), werden von anderen Spielern ignoriert.
* **Werbung**: Das Spiel fordert aktuell keine CrazyGames-Werbung an. Falls du später Midgame-Ads ergänzt, setze sie im Mehrspieler nur in Lobby und Endbildschirm ein, nie mitten in der Runde, sonst steht der Host (der die Lehrer rechnet) für alle still.
* **Last**: Pro Raum fließen nur wenige KB/s. Ein kleiner Server trägt viele hundert gleichzeitige Räume.

---

## 8. Fehlersuche

| Problem | Ursache / Lösung |
|---|---|
| „Server nicht erreichbar“ | Adresse falsch? Muss auf CrazyGames `wss://` sein (nicht `ws://`). `https://deine-adresse/health` im Browser öffnen: kommt `{"ok":true,…}`? Beim Gratis-Tarif beim ersten Mal 30–60 s warten und nochmal klicken. |
| Alle neuen Spieler werden abgewiesen | Hinter einem Proxy fehlt `TRUST_PROXY=1`. |
| Verbindung wird sofort abgelehnt | `ALLOWED_ORIGINS` zu streng gesetzt. |
| Kein Mikrofon-Zugriff | Seite nur über https/localhost; Berechtigung in der Adressleiste erlauben; in der CrazyGames-Einbettung siehe Abschnitt 6, Punkt 1. |
| Sprachverbindung kommt nicht zustande | Meist strenge Firewall/Mobilfunk: TURN-Server eintragen (Abschnitt 6, Punkt 3). |
| Voice ganz abschalten | `voice: false` in der Konfiguration. |
| Chat-Karte fehlt in der Lobby | (1) Läuft auf dem Server die neue Version **mit `chatfilter.js`**? Ein alter Server kennt keinen Chat, dann bleibt die Karte weg (kein Fehler). Bei einem Absturz mit „Cannot find module './chatfilter.js'“ fehlt die Datei (beim Docker-Build wird sie vom neuen `Dockerfile` mitkopiert). (2) `CHAT=0` am Server oder `chat: false` im Spiel? (3) CrazyGames `disableChat` aktiv (`?disableChat=true` in der Adresse)? |
| Freunde-Karte fehlt oder zeigt „Auf diesem Server sind Freunde aus“ | Läuft auf dem Server die neue Version **mit `friends.js`** (`/health` zeigt `"friends": true`)? Ein alter Server kennt keine Freunde. `FRIENDS=0` am Server oder `friends: false` im Spiel schalten sie ab. Ohne WebCrypto (sehr alter Browser, kein https) bleibt die Karte weg. |
| „Server nicht erreichbar“ bei Freunden | Der Server schläft (Gratis-Tarife brauchen bis zu einer Minute zum Aufwachen) oder ist nicht erreichbar: „Erneut versuchen“. |
| Freundes-ID weg / Freunde verschwunden | Die ID liegt nur im Browser. Browserdaten löschen, anderes Gerät oder ein privates Fenster bedeuten eine neue ID: Freunde neu hinzufügen. |
| Taschengeld oder Käufe sind weg | „Fortschritt löschen“ leert auch den Kiosk. Wechsel zwischen Geräten gleicht sich über den CrazyGames-Cloud-Spielstand an (nur bei angemeldeten Spielern). |
| Datenschutz-Text nennt „der Entwickler dieses Spiels“ | `window.LASTBELL_LEGAL` in `index.html` ausfüllen (Abschnitt 5d). |
| Ein harmloses Wort wird zu *** | In `CHAT_ALLOW_WORDS` eintragen (z. B. `CHAT_ALLOW_WORDS=wort1,wort2`), kein Neubau des Spiels nötig. |
| Jemand soll nach einem Fehlalarm wieder schreiben dürfen | Automatische Stummschaltungen laufen von allein ab (1 / 3 Minuten). Nur die dritte gilt bis zum Verlassen des Raums (und 15 Minuten für diese IP, `CHAT_IP_PENALTY_MS`). |

---

## 9. Was getestet wurde (und was nicht)

Automatisch getestet:
* **Server** (59 Tests): Räume, Weiterleitung, Host-Wechsel und Host-Überwachung, Limits, Missbrauchsschutz, Herkunftsprüfung, **Chat**: Filter (harmlose Wörter bleiben unberührt, Verschleierungen werden erkannt, alle generierten Spielernamen sind sauber), Nachrichten an alle, Maskieren / Verwerfen mit Begründung, Tempolimit, Doppelte, Schnell-Nachrichten, Modi (nur Host), Chat aus, Ausblenden, Host-Stumm (und Host-Wechsel), Verstoßpunkte mit 1./2./3. Stummschaltung samt Sperre nach Neubeitritt, Melden, Namensfilter, getrennte Räume, `CHAT=0`, `CHAT_DEFAULT=quick`. **Freunde**: Anmeldung nur mit gültiger Signatur (falscher Schlüssel, Wiederverwendung einer Signatur, ungültiger Punkt auf der Kurve), keine Sichtbarkeit ohne Gegenseitigkeit, Präsenz folgt Raum (Lobby, Spiel, geschlossener Raum, Verlassen, Offline), Einladungen (nur Freunde, nur offener Raum, Flutschutz), Anfragen (Blockieren, Pro-Paar-Limit, nachgeholte Anfrage bei späterem Login), zweiter Tab übernimmt, Namensfilter, Titelindex, Schnell-Nachrichten 12–17, `FRIENDS=0`.
* **Lobby-Chat in einem echten Chromium** (40 Checks, zwei bis drei Spieler gegen den echten Server): Chat-Karte, Schreiben und Filtern, Link-Block mit Erklärung, HTML wird nur als Text gezeigt (keine Code-Einschleusung), Tippen erreicht nie die Spiel-Tasten, Schnell-Nachrichten in der Sprache des Lesers, Sprachwechsel verändert Spielertexte nicht, Ausblenden/Einblenden, Melden, Host-Modi und Host-Stumm, eigener Chat-Schalter, CrazyGames `disableChat` (Karte weg, nichts empfangen), Verlassen, Handy-Ansicht, keine Konsolenfehler.
* **Schulkiosk, Rechtliches und Freunde in einem echten Chromium** (47 Checks, drei Spieler in getrennten Browsern gegen den echten Server): Hinweis-Leiste und Rechtstexte (DE/EN, Links aus Menü, Einstellungen und Lobby), Kiosk (Kaufen, Stufen, Titel anlegen/ablegen, Übersetzung, Speichern über ein Neuladen), Auszahlungszeile, Freundes-ID und Eintippen (Groß-/Kleinschreibung, ohne Bindestrich, falsche und eigene ID), Anfrage und Annehmen, Beitreten über die Freundesliste, Titel neben dem Namen, Einladung samt Beitritt, Spaß-Paket (18 statt 12 Schnell-Nachrichten, Nachricht kommt an), Verlassen und Wiederkommen, ID bleibt nach Neuladen, Freunde ausschalten ohne den Raum zu verlassen.
* **Clientcode gegen den echten Server in Node** (6 Tests): das echte `net.js` und `friends.js` (ID-Ableitung und Signatur passen zum Server, der Socket bleibt nach dem Verlassen offen, Wiederverbindung, zweiter Tab, `FRIENDS=0`, alter Server ohne Freunde). **Shop-Logik** (11 Tests: Auszahlung, Käufe, Grenzen der Verbesserungen, Titel, Reparatur kaputter Spielstände, Abgleich zweier Geräte) und **`payRound`** aus der echten `main.js` (8 Tests: nur einmal pro Runde, Tutorial, Koop, Fehlerfall).
* **Lehrer-KI mit mehreren Spielern** (12 Tests) auf dem echten Schulgebäude, inkl. Beweis, dass der Einzelspieler Tick für Tick identisch zum Original bleibt.
* **Sprachchat in einem echten Chromium** mit WebRTC und Fake-Mikrofon (11 Tests): Verbindungsaufbau, Push-to-talk, Zuhören ohne Mikrofon (und Mikrofon später dazuschalten, ohne die Verbindung neu aufzubauen), Nähe-Lautstärke, Stummschalten, Verlassen und Wiedereinstieg.
* **Lobby, Sprachchat und Einladung** (10 Tests, drei Spieler): automatisches Hören ohne Klick und ohne Mikrofon, Zuhören bei ausgeschaltetem eigenen Mikrofon, Einladungslink (Zwischenablage, sichtbare Bestätigung, Beitritt über `?room=`), Host verlässt Raum/Lobby/Tab, Gast verlässt die Runde.
* **Handy mit Touch-Emulation** (8 Tests): Menü öffnen und mit „▶ Weiter“ oder Tippen wieder schließen (Einzelspieler und Mehrspieler), Team-Pause zwischen Handy und Desktop, Größe der Karte.
* **Das ganze Spiel in einem echten Chromium** mit mehreren Spielern gleichzeitig (19 Tests): Lobby, CrazyGames-Room-Data (mit Test-SDK), Avatare, Lehrer-Sync, Türen, Gegenstände, Fangen und Respawn, Team-Sieg, Game-Over, Spätbeitritt, gefälschte Nachrichten, Sprachchat im Spiel, Pause-Verhalten, Host-Ausfall, Instant Multiplayer, Einladung, `disableChat`.

**Nicht getestet**: Chat, Freunde und Kiosk im *kompletten* Spiel mit echtem three.js (die Browser-Tests liefen mit der echten Lobby, `net.js`, `multiplayer.js`, Kiosk und Rechtstexten, aber ohne die 3D-Welt; die Stellen in `main.js`, an denen nach einer Runde Taschengeld ausgezahlt wird, habe ich per Quelltext geprüft und die Funktion einzeln getestet, aber nicht in einer echten Runde ausgelöst) und die bisherigen Spiel-Testläufe der obigen Liste nach dieser Änderung (sie liegen nicht in diesem Paket; die Änderung berührt nur die Lobby, die Spiellogik blieb unangetastet). Ebenso nicht: Die 3D-Darstellung mit echtem three.js auf einer Grafikkarte (in meiner Testumgebung war three.js nicht abrufbar, die Tests ersetzen die Darstellung durch eine Attrappe; Spiellogik, Netzwerk und Oberfläche laufen aber echt). Ebenso nicht die echte CrazyGames-Umgebung und der echte Sprachchat zwischen zwei verschiedenen Geräten/Netzwerken. **Bitte spiel vor dem Einreichen einmal kurz zu zweit** (zwei Fenster reichen), vor allem: Avatare sichtbar? Namensschilder lesbar? Sprachchat auf zwei echten Geräten?

**Beim Testen gefunden und behoben:** Der Knopf „Raum verlassen“ in der Lobby hatte in deiner Vorlage keine Beschriftung (er war leer). Er heißt jetzt „Raum verlassen“ / „Leave room“.
