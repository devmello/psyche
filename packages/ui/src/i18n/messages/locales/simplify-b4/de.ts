import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (de); merged into `../de.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplify.b4.devices.title": "Geräte",
  "simplify.b4.devices.description": "Die Computer und iPhones, die Psyche nutzen können.",
  "simplify.b4.devices.details": "Details",
  "simplify.b4.devices.canDo": "Was es darf",
  "simplify.b4.devices.canDoOf": "Was {name} darf",
  "simplify.b4.devices.hostKey": "Schlüssel dieses Computers: {fingerprint}",
  "simplify.b4.devices.helpers": "Helfer",
  "simplify.b4.devices.helpersHint":
    "Die kleinen Apps, mit denen Psyche auf einem Computer arbeiten kann.",
  "simplify.b4.devices.noHelpers":
    "Noch keine Helfer. Ein Helfer erscheint hier, sobald Psyche auf einem Computer läuft.",
  "simplify.b4.server.title": "Netzwerk und Fernzugriff",
  "simplify.b4.server.description":
    "Wie andere Geräte diesen Computer erreichen und wie du Psyche unterwegs nutzt.",
  "simplify.b4.server.away": "Von unterwegs nutzen",
  "simplify.b4.pairIphone.title": "iPhone koppeln",
  "simplify.b4.pairIphone.description":
    "Scanne einen Code mit Psyche auf deinem iPhone. iPhone und Computer müssen im selben WLAN sein.",
  "simplify.b4.pairIphone.button": "iPhone koppeln",
  "simplify.b4.pairIphone.scan":
    "Öffne Psyche auf deinem iPhone und scanne diesen Code. Er funktioniert nur einmal.",
  "simplify.b4.pairIphone.lanOn":
    "Beim Koppeln wurde der Netzwerkzugriff eingeschaltet, damit dein iPhone diesen Computer findet.",
  "simplify.b4.pairIphone.lanOff": "Der Netzwerkzugriff ist wieder aus.",
  "simplify.b4.pairIphone.turnOff": "Netzwerkzugriff ausschalten",
  "simplify.b4.pairIphone.enableFailed":
    "Netzwerkzugriff konnte nicht eingeschaltet werden: {reason}",
  "simplify.b4.pairIphone.turnOffFailed":
    "Netzwerkzugriff konnte nicht ausgeschaltet werden: {reason}",
  "simplify.b4.pairIphone.noNetwork":
    "Dieser Computer ist im Moment nicht in deinem Netzwerk erreichbar. Prüfe, ob das WLAN an ist, und versuche es erneut.",
};
