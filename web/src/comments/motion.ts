// Motion tokens borrowed from komo (MIT): the drawer/card spring and smooth-out ease.
export const SPRING = { type: "spring", stiffness: 680, damping: 32, mass: 0.55 } as const;
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
