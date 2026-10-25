# Light Strip for Tapo L900

A [Stream Deck](https://www.elgato.com/stream-deck) plugin that controls a TP-Link Tapo L900
LED strip straight over your local network — no cloud, no bridge, no extra app running.

Turn the strip on and off, set its brightness, colour or white temperature, and save whole
scenes to a single key. The keys show the strip's real state: the power key glows in the
colour the strip is lit with, and follows changes made from the Tapo app too.

> Not affiliated with, or endorsed by, TP-Link. "Tapo" is a trademark of TP-Link.

## Actions

| Action | On a key | On a dial (Stream Deck +) |
| --- | --- | --- |
| **Power On/Off** | Turns the strip on or off; shows its current colour and brightness | Push to toggle, rotate for brightness |
| **Brightness** | Sets a level, or steps it up or down | Rotate to adjust |
| **Colour** | Applies a colour | Rotate through the colour wheel |
| **White Temperature** | Applies a warm-to-cool white | Rotate from 2500K to 9000K |
| **Scene** | Applies a colour or white plus a brightness, in one press | — |

## Requirements

- A TP-Link Tapo **L900** light strip, on the same local network as your computer.
- Stream Deck 7.1 or later, on Windows 10+ or macOS 12+.

## Setup

1. **Allow local control.** In the Tapo app go to **Me › Third-Party Services** and turn on
   **Third-Party Compatibility**. Without it, the strip refuses the connection.
2. **Find the strip's IP.** In the Tapo app, open the strip › **Settings › Device Info ›
   IP Address**. A DHCP reservation on your router stops it from changing later.
3. **Connect.** Drag any of the plugin's actions onto a key, open **Strip connection** below
   its settings, enter the IP, your Tapo email and password, and press **Test connection**.

The connection is shared by every action, so you only set it up once.

**About your password:** it is never stored. The plugin keeps only the one-way hash the strip
itself checks, and sends it only to the strip on your network. See
[how the password is handled](DEVELOPMENT.md#how-the-password-is-handled).

## Does it work with your light?

Only the L900 has been tested so far, but other Tapo lights may well work. If you try one,
please tell me — whether it works or not — with the **Works with your light, or not?** link
in the plugin's settings. It opens a [compatibility report](../../issues/new?template=compatibility.yml)
with your light's model and firmware already filled in, and nothing is sent until you submit it.

Something broken? [Open a bug report](../../issues/new?template=bug_report.yml).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for building, testing, and how the plugin works inside.
