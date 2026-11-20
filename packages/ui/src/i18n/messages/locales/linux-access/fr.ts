import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (fr); merged into `../fr.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "Accès à l'écran et à la saisie",
  "settings.computerUse.linux.screen.allowed": "Autorisé jusqu'à ce que vous le révoquiez",
  "settings.computerUse.linux.screen.asks": "Demande la première fois que vous l'utilisez",
  "settings.computerUse.linux.screen.notNeeded": "Inutile sous X11",
  "settings.computerUse.linux.screen.unavailable": "Indisponible",
  "settings.computerUse.linux.screen.why":
    "{persona} voit votre écran et utilise la souris et le clavier via la boîte de dialogue d'autorisation de votre bureau. Vous l'approuvez une seule fois.",
  "settings.computerUse.linux.revoke": "Révoquer",
  "settings.computerUse.linux.revokeLabel": "Révoquer l'accès à l'écran et à la saisie",
  "settings.computerUse.linux.warning.x11":
    "Sous X11, n'importe quelle application peut lire votre écran et vos frappes au clavier, y compris votre mot de passe lorsque vous approuvez quelque chose.",
  "settings.computerUse.linux.warning.wlroots":
    "Sur ce bureau, n'importe quelle application peut lire votre écran et saisir du texte à votre place sans rien demander. Psyche ne peut pas ajouter d'étape de consentement.",
  "settings.computerUse.linux.accessibility":
    "Les applications ouvertes à partir de maintenant exposent leur structure à Psyche. Celles qui sont déjà ouvertes peuvent nécessiter un redémarrage.",
  "settings.computerUse.linux.headless":
    "Une session graphique est nécessaire sur cet ordinateur. Connectez-vous au bureau, puis réessayez.",
};
