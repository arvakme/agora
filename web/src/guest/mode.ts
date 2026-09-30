// Share guests get the page from the share gateway (server/canvas/share_gateway.py), which marks
// it with <meta name="agora-guest">. Guests look and comment; everything else is the owner's.
export const GUEST = typeof document !== "undefined" && !!document.querySelector('meta[name="agora-guest"]');
