# Strap Timer

A countdown timer that buzzes a WHOOP 5.0 / MG strap when time runs out.

When you press Start, the page arms one of the strap's own alarm slots for the
end time. The strap then buzzes by itself, so it still goes off if your phone
locks or the page closes. If the strap won't take the alarm, the page falls
back to sending the buzz itself, which only works while the page stays open.

This uses an unofficial, reverse-engineered Bluetooth protocol (byte layouts
from [eugenehp/whoop-rs](https://github.com/eugenehp/whoop-rs)). WHOOP doesn't
support it, and a firmware update could break it.

## Using it on iPhone

Safari has no Web Bluetooth, so use **Bluefy** (a free Web Bluetooth browser
from the App Store).

1. Host `index.html` and `whoop5.js` together on any HTTPS site, such as
   GitHub Pages or Netlify. Web Bluetooth only works on HTTPS pages.
2. Open that URL in Bluefy, tap **Connect strap**, and pick your WHOOP.
3. Tap **Test buzz** to confirm it's the right strap.
4. Pick a time and tap **Start**.

## Safety

- The app only ever sends these commands: buzz, stop buzz, read, set and clear
  alarm, and hello. Nothing touches history, the clock, pairing or firmware.
- It uses alarm slots 6, 5, 4, 3, in that order, and skips any slot holding a
  future time, so the wake alarm you set in the WHOOP app is left alone.

## Tests

```bash
node --test test/whoop5.test.js
```

`test/fake-strap.js` is a stand-in strap that replies the way the real one is
reported to. You can use it to try the page in a desktop browser without a strap.
