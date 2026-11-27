import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (de); merged into `../de.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplifyB4.devices.title": "Geräte",
  "simplifyB4.devices.description": "Die Computer und iPhones, die Psyche nutzen können.",
  "simplifyB4.devices.details": "Details",
  "simplifyB4.devices.canDo": "Was es darf",
  "simplifyB4.devices.canDoOf": "Was {name} darf",
  "simplifyB4.devices.hostKey": "Schlüssel dieses Computers: {fingerprint}",
  "simplifyB4.devices.helpers": "Helfer",
  "simplifyB4.devices.helpersHint": "Die kleinen Apps, mit denen Psyche auf einem Computer arbeiten kann.",
  "simplifyB4.devices.noHelpers": "Noch keine Helfer. Ein Helfer erscheint hier, sobald Psyche auf einem Computer läuft.",
  "simplifyB4.server.title": "Netzwerk und Fernzugriff",
  "simplifyB4.server.description": "Wie andere Geräte diesen Computer erreichen und wie du Psyche unterwegs nutzt.",
  "simplifyB4.server.away": "Von unterwegs nutzen",
  "simplifyB4.pairIphone.title": "iPhone koppeln",
  "simplifyB4.pairIphone.description": "Scanne einen Code mit Psyche auf deinem iPhone. iPhone und Computer müssen im selben WLAN sein.",
  "simplifyB4.pairIphone.button": "iPhone koppeln",
  "simplifyB4.pairIphone.scan": "Öffne Psyche auf deinem iPhone und scanne diesen Code. Er funktioniert nur einmal.",
  "simplifyB4.pairIphone.lanOn": "Beim Koppeln wurde der Netzwerkzugriff eingeschaltet, damit dein iPhone diesen Computer findet.",
  "simplifyB4.pairIphone.lanOff": "Der Netzwerkzugriff ist wieder aus.",
  "simplifyB4.pairIphone.turnOff": "Netzwerkzugriff ausschalten",
  "simplifyB4.pairIphone.enableFailed": "Netzwerkzugriff konnte nicht eingeschaltet werden: {reason}",
  "simplifyB4.pairIphone.turnOffFailed": "Netzwerkzugriff konnte nicht ausgeschaltet werden: {reason}",
  "simplifyB4.pairIphone.noNetwork": "Dieser Computer ist im Moment nicht in deinem Netzwerk erreichbar. Prüfe, ob das WLAN an ist, und versuche es erneut.",
};
