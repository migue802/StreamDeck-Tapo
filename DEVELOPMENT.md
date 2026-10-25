# Development

Notes for working on the plugin. For what it does and how to set it up, see the [README](README.md).

```bash
npm install
npm run watch       # rebuild + restart the plugin on every change
```

Other scripts:

```bash
npm run build       # bundle to com.migue802.tapo-lights.sdPlugin/bin/plugin.js
npm test            # unit tests + client tests against a mock KLAP device
npm run typecheck
npm run validate    # Elgato's own manifest/plugin validation
npm run icons       # regenerate the marketplace PNGs and default key images
streamdeck link com.migue802.tapo-lights.sdPlugin   # register the plugin with Stream Deck
streamdeck pack com.migue802.tapo-lights.sdPlugin   # build a .streamDeckPlugin for distribution
```

Requires Node 24+ and Stream Deck 7.1+.

## How it fits together

```
src/
  plugin.ts          registers the actions and connects to Stream Deck
  context.ts         global settings -> one shared client; connection test; withDevice()
  tapo/
    klap.ts          the KLAP cipher (handshake key derivation, AES-128-CBC, signatures)
    client.ts        handshake, session cookie, request serialization, re-login
    state.ts         one cached view of the strip, shared by every action; polls it
    coalesce.ts      LatestWriter: keeps dials responsive without flooding the strip
  render/
    keys.ts          key artwork as SVG, drawn live from the strip's state or a preset
    images.ts        KeyImages: skips resending a key the image or state it already shows
    redraw.ts        Redraws: holds each key to ten updates a second
  actions/           one file per action
```

A few things in here are less obvious than they look, and all of them are load-bearing:

**`fetch` cannot talk to this device — use `node:http`.** The strip's HTTP parser matches
`Content-Length` case-sensitively and answers `400 Bad Request` to the lowercase spelling.
The fetch specification *requires* header names to be lowercased, and undici obeys it, so no
combination of fetch options can work. This is invisible in testing, because ordinary mock
servers accept either spelling — `test/headers.test.ts` asserts the wire format directly so a
switch back to `fetch` fails loudly instead of only breaking against real hardware.

**The session cookie.** `handshake1` returns a `TP_SESSIONID` cookie that every later request
must carry. Python's `requests.Session` does this invisibly; there is no cookie jar here, so
`client.ts` captures and replays it by hand.

**The sequence number is a signed int32.** Roughly half of all handshakes derive a negative
starting value, so reading it unsigned works about half the time — the worst kind of bug.
It is also why requests are serialized: the sequence must reach the strip in order.

**Dials outrun the strip.** A rotation fires far more events than the strip can answer. Every
dial write goes through `LatestWriter`, which keeps only the newest value while a write is in
flight, so rotating fast costs about as many requests as rotating slowly and the light always
settles where the dial stopped. The touch strip is drawn immediately on every tick, ahead of
the device, so it tracks your hand.

**The strip cannot tell anyone it changed.** The Tapo app hears about a change made elsewhere
through TP-Link's cloud; a local KLAP client has no such channel. So while any key or dial is
showing the strip's state, `DeviceState` re-reads it every 5 seconds — one small local request.
Only a change to something actually drawn (on/off, brightness, colour) is broadcast, so an
idle strip sends nothing to Stream Deck. A poll that finds the cache freshly written skips
itself, so it never fights a dial mid-turn. A strip that stops answering is shown as unknown
and asked less often, doubling up to once a minute, with one log line rather than one per poll.

**Ten updates a second, per key.** Elgato's guidelines cap programmatic updates at ten per
second per key. Every redraw goes through `Redraws` (src/render/redraw.ts), which holds an
early request until the key's slot opens and lets newer requests replace it — so a fast dial
stays within the limit and still ends on exactly its final value.

## Tests

`test/mock_device.py` is a fake Tapo device speaking KLAP, transcribed from a known-good
Python client — an independent implementation to test the TypeScript port against. It can
inject faults (`--expire-after`, `--require-cookie`) so the recovery paths get exercised
rather than assumed: session expiry and re-login, wrong credentials, an unreachable strip,
and concurrent requests keeping their sequence in order.

```bash
pip install pycryptodome   # the mock device needs it
npm test
```

## How the password is handled

They are your Tapo account credentials, because that is what the strip itself checks. But
KLAP never needs the password itself, only `sha256(sha1(email) ‖ sha1(password))`, so that
is all the plugin keeps:

- The property inspector computes the hash as you type (`ui/tapo-hash.js`) and saves only
  the hash and your email. The password is not written to disk, and never even reaches the
  plugin process.
- Settings saved by an older version that still hold the password are converted to the hash
  the first time the plugin starts.
- The hash goes to the strip on your LAN and nowhere else. It cannot sign in to your TP-Link
  account. It is, though, enough to control this strip locally — treat it like a key to the
  light, not like nothing. (Like any unsalted fast hash, a weak password could be guessed
  from it, so a unique password for the Tapo account is still worth having.)
- Plugin logging is pinned to `info`, because trace logging would record the hash.
