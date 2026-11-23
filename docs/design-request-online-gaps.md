# Design request: online multiplayer, remaining gaps

Context: the v1 online screens (boards 40-48) are built and running. These are the states the build needs that the boards do not cover. Same rules as before: desktop and phone landscape, existing palette and fonts, existing sounds, strings go into `data/online_ui.json`.

## 1. Player name entry (design item 5, not yet done)
Today names are generated (`RACER-482`). Needed:
- Where a player sets their name (first time they open ONLINE, and a way to change it later).
- Field rules to show: max 16 characters, letters, numbers, space, `.` `_` `-`; name tags show it uppercase and cut at 12.
- States: empty, valid, too long / invalid character, saved.
- Default suggestion shown in the field.

## 2. In the race, after you finish (waiting for the others)
The server keeps the race open until everyone finishes or 30 s after the first finisher. Needed: what the finisher sees meanwhile (position locked, "waiting for N racers", the 30 s countdown), without blocking the pause menu.

## 3. Loading the race with other players
After the host starts, every player builds the race and the countdown begins when all are ready (or after 20 s). Needed: the online variant of the loading screen: who is still loading, and the "starting anyway" case.

## 4. Connection lost while in a room
If the connection drops in the lobby, during a race or on the results screen, the hub currently shows "Can't reach the race server". Needed: wording and layout for "connection lost, you were in room XXX·XXX", with the actions (rejoin the hub, play offline). Reconnecting into a race is not v1.

## 5. Small missing strings and states
- Lobby, host alone: START is disabled and needs a line for "need at least 2 racers" (today it reuses "waiting on another racer").
- Join error "race already started" (today shown as "room full").
- Quick match searching: the board shows "N/6 in the best room", which the server cannot report. Either drop the counter (today: elapsed time only) or say what it should show.
- Room closed because everyone left, and "the host left, you are now the host" (a small notice in the lobby).

Not asked for now: per-player tints, ping in the HUD, the disconnected tag variant, teammate colours.
