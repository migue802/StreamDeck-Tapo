import streamDeck from "@elgato/streamdeck";

import { loadConnection, watchConnection, watchConnectionTests } from "./context.js";
import { Brightness } from "./actions/brightness.js";
import { Color } from "./actions/color.js";
import { Scene } from "./actions/scene.js";
import { Temperature } from "./actions/temperature.js";
import { Toggle } from "./actions/toggle.js";

// Trace logging records every message exchanged with Stream Deck, which would include the
// account hash when the property inspector saves it (and, from settings saved by an older
// version, the password itself). Keep it at info.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new Toggle());
streamDeck.actions.registerAction(new Brightness());
streamDeck.actions.registerAction(new Color());
streamDeck.actions.registerAction(new Temperature());
streamDeck.actions.registerAction(new Scene());

watchConnection();
watchConnectionTests();

await streamDeck.connect();
await loadConnection();
